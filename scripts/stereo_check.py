"""Bounded PCM diagnostics and stereo analysis; no compressed decoding or asset writes."""

import math
import os
import stat
import struct
import wave

import numpy as np


LIMITS = {
    'max_decoded_samples': 20_000_000,
    'max_windows': 10_000,
    'max_operations': 640_000_000,
    'max_window_frames': 65_536,
    'max_window_bytes': 8 * 1024 ** 2,
}
THRESHOLDS = {'correlation_below': -0.5, 'mono_loss_below_db': -6.0,
              'silence_rms': 1e-6, 'loss_floor_db': -120.0}
UNITS = {'time': 's', 'correlation': 'dimensionless', 'rms': 'full_scale',
         'mono_loss': 'dB', 'sample_rate': 'Hz'}
ASSUMPTIONS = [
    'RIFF/WAVE integer PCM only: interleaved L,R; unsigned 8-bit or signed '
    'little-endian 16/24/32-bit. No resampling, weighting or decoder subprocess.',
    'M=(L+R)/2; stereo RMS=sqrt((mean(L^2)+mean(R^2))/2); '
    'mono loss=20*log10(mono RMS/stereo RMS).',
    'Correlation is mean-centered Pearson correlation; zero channel variance '
    'has undefined correlation (null). Silence is not cancellation.',
    'Flag only audible windows meeting both negative-correlation and loss '
    'thresholds. Complete cancellation uses the declared finite dB floor.',
    'Rectangular overlapping windows include the final partial window. '
    'Adjacent flagged windows merge; retain at most ten regions, worst loss first. '
    'Region metrics describe the worst-loss constituent window.',
]


class _Incomplete(ValueError):
    pass


class _Budget(ValueError):
    pass


def _layout(source, size, operations):
    """Validate bounded headers before wave/numpy read any sample payload."""
    head = source.read(12)
    if len(head) != 12 or head[:4] != b'RIFF' or head[8:] != b'WAVE':
        raise _Incomplete('not a supported RIFF/WAVE file')
    end = struct.unpack_from('<I', head, 4)[0] + 8
    if end > size or end < 12:
        raise _Incomplete('truncated RIFF payload')
    fmt = None
    for index in range(1024):
        if (index + 1) * 64 > operations:
            raise _Budget('header operation budget exceeded')
        if source.tell() + 8 > end:
            raise _Incomplete('missing or truncated PCM chunks')
        kind, length = struct.unpack('<4sI', source.read(8))
        offset = source.tell()
        if offset + length > end:
            raise _Incomplete('truncated WAV chunk')
        if kind == b'fmt ':
            if fmt is not None or length < 16:
                raise _Incomplete('invalid PCM format chunk')
            fmt = struct.unpack('<HHIIHH', source.read(16))
        elif kind == b'data':
            if fmt is None:
                raise _Incomplete('missing PCM format')
            tag, channels, rate, byte_rate, align, bits = fmt
            if tag != 1 or bits not in (8, 16, 24, 32):
                raise _Incomplete('encoding/sample width not checked: integer PCM 8/16/24/32 only')
            width = bits // 8
            if not channels or not rate or align != channels * width or byte_rate != rate * align:
                raise _Incomplete('inconsistent PCM layout')
            if length % align:
                raise _Incomplete('unequal channels: payload is not whole interleaved frames')
            return channels, width, rate, length // align, (index + 1) * 64
        source.seek(offset + length + (length & 1))
    raise _Budget('WAV chunk budget exceeded')


def _pcm(raw, width, channels=2):
    if width == 1:
        values = np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128
    elif width == 3:
        octets = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        values = octets[:, 0] | (octets[:, 1] << 8) | (octets[:, 2] << 16)
        values = ((values ^ 0x800000) - 0x800000).astype(np.float64)
    else:
        values = np.frombuffer(raw, dtype='<i%d' % width).astype(np.float64)
    return (values / (2 ** (8 * width - 1))).reshape(-1, channels)


def _pcm_result():
    return {'schema': 'pcm-diagnostics/1', 'status': 'not_checked', 'metrics': {},
            'units': {'peak': 'full_scale', 'rms': 'full_scale', 'dc_offset': 'full_scale',
                      'clipped_samples': 'samples', 'clipped_sample_ratio': 'dimensionless',
                      'samples': 'samples', 'frames': 'frames', 'channels': 'count',
                      'stereo_correlation': 'dimensionless'},
            'assumptions': [
                'Integer PCM mono or interleaved L,R; unsigned 8-bit and signed '
                'little-endian 16/24/32-bit, normalized by 2^(bits-1).',
                'Clipped samples means values at either integer encoding endpoint; '
                'this does not establish analog clipping. Ratio uses scalar sample count.',
                'Whole-file and per-channel peak, RMS (including DC) and mean DC offset '
                'count every sample once, excluding overlapping-window rereads.',
                'Global RMS and DC pool all scalar samples; global peak is maximum '
                'absolute amplitude. Per-channel values preserve channel differences.',
                'Stereo correlation uses streaming centered covariance; mono or zero '
                'channel variance has undefined correlation (null). No LUFS or true peak.',
            ], 'diagnostics': []}


class _PCMAccumulator:
    """Constant-sized state; merge centered moments to preserve DC-biased correlation."""

    def __init__(self, channels, width):
        self.frames = 0
        self.upper = 1 - 1 / (2 ** (8 * width - 1))
        self.mean = np.zeros(channels)
        self.centered_squares = np.zeros(channels)
        self.squares = np.zeros(channels)
        self.peak = np.zeros(channels)
        self.clipped = np.zeros(channels, dtype=np.int64)
        self.cross = 0.0

    def update(self, samples):
        count = len(samples)
        if not count:
            return
        mean = np.mean(samples, axis=0)
        centered = samples - mean
        delta = mean - self.mean
        total = self.frames + count
        factor = self.frames * count / total
        self.centered_squares += np.sum(centered * centered, axis=0) + delta * delta * factor
        if samples.shape[1] == 2:
            self.cross += float(np.dot(centered[:, 0], centered[:, 1])) + delta[0] * delta[1] * factor
        self.mean += delta * (count / total)
        self.squares += np.sum(samples * samples, axis=0)
        self.peak = np.maximum(self.peak, np.max(np.abs(samples), axis=0))
        self.clipped += np.count_nonzero((samples <= -1) | (samples >= self.upper), axis=0)
        self.frames = total

    def metrics(self):
        channels = len(self.mean)
        correlation = None
        if channels == 2 and all(v > 0 for v in self.centered_squares):
            correlation = max(-1.0, min(1.0, float(self.cross) / math.sqrt(
                float(self.centered_squares[0] * self.centered_squares[1]))))
        per_channel = [
            {'channel': name, 'samples': self.frames, 'peak': float(self.peak[i]),
             'rms': math.sqrt(float(self.squares[i]) / self.frames),
             'dc_offset': float(self.mean[i]), 'clipped_samples': int(self.clipped[i]),
             'clipped_sample_ratio': int(self.clipped[i]) / self.frames}
            for i, name in enumerate(('M',) if channels == 1 else ('L', 'R'))]
        samples = self.frames * channels
        clipped = int(np.sum(self.clipped))
        return {'frames': self.frames, 'samples': samples, 'channels': channels,
                'peak': float(np.max(self.peak)), 'rms': math.sqrt(float(np.sum(self.squares)) / samples),
                'dc_offset': float(np.mean(self.mean)), 'clipped_samples': clipped,
                'clipped_sample_ratio': clipped / samples,
                'stereo_correlation': correlation, 'per_channel': per_channel}


def _metrics(samples):
    left, right = samples[:, 0], samples[:, 1]
    stereo = math.sqrt(float((np.mean(left * left) + np.mean(right * right)) / 2))
    mono = math.sqrt(float(np.mean(((left + right) / 2) ** 2)))
    a, b = left - np.mean(left), right - np.mean(right)
    aa, bb = float(np.dot(a, a)), float(np.dot(b, b))
    correlation = (max(-1.0, min(1.0, float(np.dot(a, b)) / math.sqrt(aa * bb)))
                   if aa > 0 and bb > 0 else None)
    loss = max(THRESHOLDS['loss_floor_db'], 20 * math.log10(mono / stereo)) if mono and stereo else (
        THRESHOLDS['loss_floor_db'] if stereo else None)
    floor = bool(stereo and (not mono or loss == THRESHOLDS['loss_floor_db']))
    silent = stereo <= THRESHOLDS['silence_rms']
    return {'correlation': correlation, 'stereo_rms': stereo, 'mono_rms': mono,
            'mono_loss_db': loss, 'loss_at_floor': floor, 'silent': silent}


def analyze_stereo(path, *, window_s=0.1, hop_s=0.025, **budgets):
    """Return stereo-cancellation/1 and nested pcm-diagnostics/1 with explicit states.

    Budgets may only lower the hard ceilings. File bytes, cumulative PCM reads,
    decoded samples (including overlap), conservative operations, window count
    and estimated working bytes are reserved before reading/allocating samples.
    """
    from preflight import FULL_STATS_LIMIT

    limits = dict(LIMITS, max_bytes=FULL_STATS_LIMIT)
    pcm_result = _pcm_result()
    result = {'schema': 'stereo-cancellation/1', 'status': 'not_checked',
              'metrics': {}, 'units': dict(UNITS), 'thresholds': dict(THRESHOLDS),
              'assumptions': list(ASSUMPTIONS), 'diagnostics': [], 'regions': [],
              'budgets': limits, 'pcm_diagnostics': pcm_result}

    def stop(status, message):
        result['status'] = status
        result['diagnostics'].append(message)
        pcm_result['status'] = status
        pcm_result['diagnostics'].append(message)
        return result

    if set(budgets) - set(limits):
        return stop('not_checked', 'unknown budget option')
    for name, value in budgets.items():
        if type(value) is not int or value < 0:
            return stop('not_checked', 'budgets must be nonnegative integers')
        limits[name] = min(value, limits[name])
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0
               for v in (window_s, hop_s)) or hop_s > window_s:
        return stop('not_checked', 'window/hop must be finite, positive and hop <= window')
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode):
            return stop('not_checked', 'input must be a regular file')
        if info.st_size > limits['max_bytes']:
            return stop('budget_exceeded', 'file byte budget exceeded')
        with open(path, 'rb') as source:
            if os.fstat(source.fileno()).st_size != info.st_size:
                return stop('not_checked', 'file changed before analysis')
            channels, width, rate, frames, header_ops = _layout(
                source, info.st_size, limits['max_operations'])
            result['metrics'].update(channels=channels, sample_width_bytes=width,
                                     sample_rate_hz=rate, duration_s=frames / rate)
            if channels not in (1, 2):
                return stop('unsupported', 'PCM diagnostics require mono or two L/R channels')
            if not frames:
                return stop('not_checked', 'empty sample payload')
            # Compare before multiplying user timing by a potentially hostile rate.
            if window_s > limits['max_window_frames'] / rate:
                return stop('budget_exceeded', 'window frame budget exceeded')
            window, hop = max(1, round(window_s * rate)), max(1, round(hop_s * rate))
            count = 1 + (max(0, frames - window) + hop - 1) // hop
            decoded_frames = (count - 1) * window + min(window, frames - (count - 1) * hop)
            required = {'max_windows': count, 'max_decoded_samples': decoded_frames * channels,
                        'max_bytes': decoded_frames * channels * width,
                        'max_operations': decoded_frames * 64 + frames * 128 + header_ops,
                        'max_window_bytes': min(window, frames) * 128}
            for name, value in required.items():
                if value > limits[name]:
                    return stop('budget_exceeded', '%s budget exceeded' % name)
            result['analysis'] = {'window_s': window / rate, 'hop_s': hop / rate,
                                  'coverage': 'pending', 'reserved': required}
            source.seek(0)
            regions = []
            active = None
            flagged = undefined = silent = 0
            min_correlation = min_loss = None
            pcm = _PCMAccumulator(channels, width)

            def retain(region):
                if region is not None:
                    regions.append(region)
                    regions.sort(key=lambda r: (r['metrics']['mono_loss_db'], r['start_s']))
                    del regions[10:]

            with wave.open(source, 'rb') as audio:
                for index in range(count):
                    start = index * hop
                    length = min(window, frames - start)
                    audio.setpos(start)
                    raw = audio.readframes(length)
                    if len(raw) != length * channels * width:
                        return stop('not_checked', 'truncated or changed PCM payload')
                    samples = _pcm(raw, width) if channels == 2 else _pcm(raw, width, channels)
                    # Reuse only newly covered frames for whole-file diagnostics.
                    pcm.update(samples[max(0, pcm.frames - start):])
                    if channels == 1:
                        undefined += 1
                        silent += bool(np.mean(samples * samples) <= THRESHOLDS['silence_rms'] ** 2)
                        continue
                    metrics = _metrics(samples)
                    corr, loss = metrics['correlation'], metrics['mono_loss_db']
                    undefined += corr is None
                    silent += metrics['silent']
                    if corr is not None:
                        min_correlation = corr if min_correlation is None else min(min_correlation, corr)
                    if loss is not None:
                        min_loss = loss if min_loss is None else min(min_loss, loss)
                    affected = (not metrics['silent'] and corr is not None
                                and corr < THRESHOLDS['correlation_below']
                                and loss < THRESHOLDS['mono_loss_below_db'])
                    if affected:
                        flagged += 1
                        if active is None:
                            active = {'start_s': start / rate, 'end_s': (start + length) / rate,
                                      'windows': 0, 'metrics': metrics}
                        active['end_s'] = (start + length) / rate
                        active['windows'] += 1
                        if loss < active['metrics']['mono_loss_db']:
                            active['metrics'] = metrics
                    else:
                        retain(active)
                        active = None
            retain(active)
            if os.fstat(source.fileno()).st_size != info.st_size:
                return stop('not_checked', 'file size changed during analysis')
            result['regions'] = regions
            result['metrics'].update(windows=count, flagged_windows=flagged,
                                     silent_windows=silent, undefined_correlation_windows=undefined,
                                     min_correlation=min_correlation, worst_mono_loss_db=min_loss)
            result['status'] = 'ok'
            result['analysis']['coverage'] = 'complete'
            pcm_result['status'] = 'ok'
            pcm_result['metrics'] = pcm.metrics()
            pcm_result['thresholds'] = {'clip_lower': -1.0, 'clip_upper': pcm.upper}
            if channels == 1:
                result['status'] = 'unsupported'
                result['diagnostics'].append('stereo analysis requires exactly two L/R channels; '
                                             'mono PCM diagnostics are available separately')
            return result
    except _Budget as error:
        return stop('budget_exceeded', str(error))
    except (OSError, ValueError, EOFError, wave.Error, struct.error) as error:
        return stop('not_checked', str(error))


def compact_advisory(result):
    """Small preflight evidence; no gate decision or implicit pass for unknowns."""
    return {key: result[key] for key in ('schema', 'status', 'metrics', 'units',
                                        'thresholds', 'assumptions', 'diagnostics', 'regions')}
