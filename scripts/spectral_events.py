"""Bounded advisory signal candidates, never a quality verdict.

Hann-window FFTs are centred on hop timestamps. Hum searches 50/60 Hz
fundamentals and the next three harmonics; whistles search 1–12 kHz. Candidate
spans have hop/window uncertainty and may also be intentional tones/music.
"""
import contextlib
import math
import ntpath
import os
import re
import stat
import wave

DEFAULTS = dict(max_bytes=32 * 1024**2, max_samples=48000 * 30,
                max_channels=8, fft_size=16384, hop_samples=1024,
                max_operations=100_000_000, max_events=256, timeout_s=10)
THRESHOLDS = dict(click_min_amplitude=0.15, click_rms_ratio=12.0,
                  tone_min_amplitude=0.01, hum_power_fraction=0.15,
                  whistle_power_fraction=0.65, relative_track_power=0.5,
                  sustained_s=0.25, whistle_min_hz=1000, whistle_max_hz=12000)


def _result(settings):
    return dict(schema_version=1, status='not_checked', events=[], metrics={},
                units=dict(time='s', frequency='Hz', amplitude='normalized full scale',
                           power_fraction='ratio', operations='estimated FFT work units',
                           samples='interleaved scalar samples', bytes='bytes'),
                settings=dict(settings, thresholds=dict(THRESHOLDS),
                              threshold_units={k: ('s' if k.endswith('_s') else 'Hz' if k.endswith('_hz') else
                                                   'normalized full scale' if k.endswith('_amplitude') else 'ratio')
                                               for k in THRESHOLDS}),
                assumptions=['Advisory signal candidates; intentional sounds can match.',
                             'Independent channels; no artistic defect or verdict inferred.',
                             'Centred Hann FFT; spans quantized to hops, frequency to FFT bins.',
                             'Only the bounded decoded prefix is inspected.'], diagnostics=[])


def _settings(budgets):
    cfg = dict(DEFAULTS)
    if budgets:
        if set(budgets) - set(cfg):
            raise ValueError('unknown budget setting')
        cfg.update(budgets)
    for key, value in cfg.items():
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('budgets must be positive finite numbers')
        if key != 'timeout_s' and (int(value) != value or value > DEFAULTS[key]):
            raise ValueError('integer budgets may only lower hard caps')
    n = cfg['fft_size']
    if n < 256 or int(n) & (int(n) - 1):
        raise ValueError('fft_size must be a power of two >= 256')
    cfg = {k: int(v) if k != 'timeout_s' else min(v, DEFAULTS[k]) for k, v in cfg.items()}
    return cfg


def analyze_pcm(pcm, rate, *, budgets=None):
    """Inspect a normalized float numpy array (frames or frames × channels).

    Size/work budgets are checked before copies, padding or FFT allocation.
    Budget-limited results can contain candidates, but are never labelled ok.
    """
    cfg = _settings(budgets)
    out = _result(cfg)
    try:
        import numpy as np
    except ImportError:
        out.update(status='unsupported', diagnostics=['numpy unavailable'])
        return out
    if (not isinstance(pcm, np.ndarray) or pcm.ndim not in (1, 2)
            or pcm.dtype.kind != 'f' or not isinstance(rate, (int, float))
            or not math.isfinite(rate) or not 1000 <= rate <= 192000):
        out.update(status='unsupported', diagnostics=['expected normalized float PCM and valid sample rate'])
        return out
    channels = 1 if pcm.ndim == 1 else pcm.shape[1]
    frames = pcm.shape[0]
    out['metrics'].update(sample_rate_hz=rate, channels=channels, input_frames=frames,
                          fft_bin_hz=rate / cfg['fft_size'], hop_s=cfg['hop_samples'] / rate)
    if not channels or channels > cfg['max_channels']:
        out.update(status='budget_exceeded', diagnostics=['channel budget exceeded'])
        return out
    nfft, hop = cfg['fft_size'], cfg['hop_samples']
    cost = nfft * int(math.log2(nfft)) * channels
    window_budget = cfg['max_operations'] // cost
    count = min(frames, cfg['max_samples'] // channels, cfg['max_bytes'] // (8 * channels), window_budget * hop)
    limited = count < frames
    if not count:
        out.update(status='budget_exceeded' if frames else 'not_checked', diagnostics=['no decoded analysis window'])
        return out
    data = pcm[:count].reshape(count, channels)
    if not np.isfinite(data).all() or np.any(np.abs(data) > 1):
        out.update(status='unsupported', diagnostics=['nonfinite or unnormalized PCM'])
        return out
    out['metrics'].update(analyzed_frames=count, decoded_samples=count * channels,
                          analyzed_end_s=count / rate, estimated_operations=math.ceil(count / hop) * cost)
    out['status'] = 'budget_exceeded' if limited else 'ok'
    if limited:
        out['diagnostics'].append('decoded sample, byte or FFT operation budget truncated analysis')
    if count < nfft:
        if not limited:
            out['status'] = 'not_checked'
        out['diagnostics'].append('clip shorter than one FFT window; sustained tones not checked')
    window = np.hanning(nfft)
    freqs = np.fft.rfftfreq(nfft, 1 / rate)
    events = []
    event_limited = False

    def add(event):
        nonlocal event_limited
        if len(events) < cfg['max_events']:
            events.append(event)
        else:
            event_limited = True

    for channel in range(channels):
        x = data[:, channel]
        tracks = {}
        for center in range(0, count, hop):
            # Click windows are nonoverlapping; neighbour samples cross hop edges.
            lo, hi = max(1, center), min(count - 1, center + hop)
            if hi > lo:
                residual = x[lo:hi] - (x[lo-1:hi-1] + x[lo+1:hi+1]) / 2
                rms = float(np.sqrt(np.mean(np.diff(x[max(0, lo-1):hi+1]) ** 2)))
                hits = np.flatnonzero(np.abs(residual) >= max(THRESHOLDS['click_min_amplitude'], THRESHOLDS['click_rms_ratio'] * rms))
                for offset in hits:
                    i = lo + int(offset)
                    if (x[i] - x[i-1]) * (x[i+1] - x[i]) >= 0:
                        continue
                    add(dict(kind='click', channel=channel, start_s=i / rate,
                             end_s=(i + 1) / rate, frequency_hz=None,
                             frequency_span_hz=[0, rate / 2]))
            if count < nfft:
                continue
            a, b = max(0, center - nfft // 2), min(count, center + nfft // 2)
            frame = np.zeros(nfft)
            offset = a - (center - nfft // 2)
            frame[offset:offset + b-a] = x[a:b]
            power = np.abs(np.fft.rfft(frame * window)) ** 2
            total = float(power.sum())
            if total <= 1e-20:
                continue
            for fundamental in (50, 60):
                k = int(round(fundamental * nfft / rate))
                bins = sorted({j for h in range(1, 5) for j in range(int(round(h * fundamental * nfft / rate))-1, int(round(h * fundamental * nfft / rate))+2) if 0 < j < len(power)})
                p = float(power[bins].sum())
                peak = k - 1 + int(np.argmax(power[max(1, k-1):k+2]))
                # Require the fundamental as well as harmonic energy.
                if p / total >= THRESHOLDS['hum_power_fraction'] and power[peak] >= (THRESHOLDS['tone_min_amplitude'] * window.sum() / 2) ** 2:
                    harmonics = []
                    for h in range(2, 5):
                        hk = int(round(h * fundamental * nfft / rate))
                        if 1 <= hk < len(power)-1:
                            hp = hk-1 + int(np.argmax(power[hk-1:hk+2]))
                            if power[hp] >= (THRESHOLDS['tone_min_amplitude'] * window.sum() / 2) ** 2:
                                harmonics.append(float(freqs[hp]))
                    tracks.setdefault(('hum', fundamental), []).append((center, p, float(freqs[peak]), harmonics))
            low = int(np.searchsorted(freqs, THRESHOLDS['whistle_min_hz']))
            high = int(np.searchsorted(freqs, min(rate / 2, THRESHOLDS['whistle_max_hz'])))
            if high > low:
                peak = low + int(np.argmax(power[low:high]))
                p = float(power[peak-1:peak+2].sum())
                if p / total >= THRESHOLDS['whistle_power_fraction'] and power[peak] >= (THRESHOLDS['tone_min_amplitude'] * window.sum() / 2) ** 2:
                    tracks.setdefault(('whistle', peak), []).append((center, p, float(freqs[peak])))
        for (kind, _), points in sorted(tracks.items()):
            threshold = max(p[1] for p in points) * THRESHOLDS['relative_track_power']
            points = [p for p in points if p[1] >= threshold]
            runs = []
            for point in points:
                if not runs or point[0] - runs[-1][-1][0] > hop:
                    runs.append([])
                runs[-1].append(point)
            for run in runs:
                start, end = max(0, run[0][0] - hop / 2) / rate, min(count, run[-1][0] + hop / 2) / rate
                if end - start < THRESHOLDS['sustained_s']:
                    continue
                hz = float(np.median([p[2] for p in run]))
                event = dict(kind=kind, channel=channel, start_s=start, end_s=end,
                             frequency_hz=hz, frequency_span_hz=[max(0, hz-rate/nfft), min(rate/2, hz+rate/nfft)])
                if kind == 'hum':
                    event['harmonic_spans_hz'] = [[max(0, f-rate/nfft), min(rate/2, f+rate/nfft)]
                                                 for f in sorted({f for point in run for f in point[3]})]
                add(event)
    if event_limited:
        out['status'] = 'budget_exceeded'
        out['diagnostics'].append('event budget exceeded')
    out['events'] = sorted(events, key=lambda e: (e['start_s'], e['end_s'], e['kind'], e['channel'], e['frequency_hz'] or 0))
    out['metrics']['event_count'] = len(events)
    return out


class _InputBudgetExceeded(ValueError):
    pass


def _local_path(path):
    """Reject native network/device syntax before touching the selected path."""
    path = os.fspath(path)
    if not isinstance(path, str) or not path or '\x00' in path or path.startswith(('\\', '//')):
        raise ValueError('network/device input paths are unsupported')
    if os.name == 'nt':
        drive, tail = ntpath.splitdrive(path)
        if not re.fullmatch('[A-Za-z]:', drive) or not tail.startswith(('\\', '/')) or ':' in tail:
            raise ValueError('an absolute local drive path is required')
        parts = re.split(r'[/\\]', tail.lstrip('/\\'))
        for part in parts:
            if (not part or part in ('.', '..') or part.endswith((' ', '.'))
                    or re.search(r'[<>:"|?*\x00-\x1f]', part)
                    or re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])', part.split('.')[0])):
                raise ValueError('unsafe Windows path component')
        return drive + '\\' + '\\'.join(parts)
    if '\\' in path or ':' in path or '..' in path.split('/'):
        raise ValueError('network/device or traversal input paths are unsupported')
    return os.path.abspath(path)


@contextlib.contextmanager
def _local_stream(path):
    """Open a stable regular file, refusing links in every path component.

    POSIX walks held directory descriptors with O_NOFOLLOW. Windows holds each
    parent open without write/delete sharing, checks its handle for reparse
    attributes, and opens the next component only after that check. No pathname
    is reopened by the WAV reader, and no native decoder is launched.
    """
    if os.name == 'nt':
        with _windows_stream(path) as stream:
            yield stream
        return
    if not hasattr(os, 'O_NOFOLLOW') or os.open not in os.supports_dir_fd:
        raise ValueError('secure local file opening unavailable')
    with contextlib.ExitStack() as stack:
        parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, parent)
        parts = path.lstrip('/').split('/')
        for i, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if i < len(parts)-1:
                flags |= os.O_DIRECTORY
            fd = os.open(part, flags, dir_fd=parent)
            stack.callback(os.close, fd)
            parent = fd
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('only a regular staged PCM file is supported')
        # dup gives the stream ownership; the directory/file guards stay held.
        with os.fdopen(os.dup(fd), 'rb') as stream:
            yield stream


@contextlib.contextmanager
def _windows_stream(path):
    import ctypes
    import msvcrt
    from ctypes import wintypes as w

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetDriveTypeW.argtypes = [w.LPCWSTR]
    kernel.GetDriveTypeW.restype = w.UINT
    drive, tail = ntpath.splitdrive(path)
    # DRIVE_FIXED only: network, unknown, removable and substituted unsafe roots
    # are not accepted as verified staging storage.
    if kernel.GetDriveTypeW(drive + '\\') != 3:
        raise ValueError('verified fixed local staging drive required')
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p,
                                  w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.CloseHandle.restype = w.BOOL

    class FileInfo(ctypes.Structure):
        _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME),
                    ('accessed', w.FILETIME), ('written', w.FILETIME),
                    ('volume', w.DWORD), ('size_high', w.DWORD),
                    ('size_low', w.DWORD), ('links', w.DWORD),
                    ('index_high', w.DWORD), ('index_low', w.DWORD)]

    kernel.GetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.POINTER(FileInfo)]
    kernel.GetFileInformationByHandle.restype = w.BOOL
    paths = [drive + '\\']
    for part in tail.lstrip('\\').split('\\'):
        paths.append(ntpath.join(paths[-1], part))
    handles = []
    try:
        for i, component in enumerate(paths):
            final = i == len(paths)-1
            # FILE_SHARE_READ (no WRITE/DELETE) locks both content and ancestors.
            # OPEN_REPARSE_POINT + BACKUP_SEMANTICS checks the link itself.
            handle = kernel.CreateFileW(component, 0x80000000 if final else 0x80,
                                        1, None, 3, 0x00200000 | 0x02000000, None)
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            handles.append(handle)
            info = FileInfo()
            if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            if info.attributes & 0x400:
                raise ValueError('reparse inputs and ancestors are unsupported')
            if bool(info.attributes & 0x10) == final:
                raise ValueError('expected staged regular file and directory ancestors')
        handle = handles.pop()
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except Exception:
            kernel.CloseHandle(handle)
            raise
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('only a regular staged PCM file is supported')
            yield stream
    finally:
        for handle in reversed(handles):
            kernel.CloseHandle(handle)


def analyze_file(path, *, budgets=None):
    """Only self-contained PCM WAV is currently available at this boundary.

    Native compressed decoding is unavailable: the old ffmpeg invocation lacked
    filesystem/network isolation and a native memory limit. Until an isolated
    worker exists, non-WAV input is unsupported without any file access/process.
    The older preflight.audio_stats decoder is a separate unchanged boundary.
    """
    cfg = _settings(budgets)
    out = _result(cfg)
    out['assumptions'].append('Self-contained PCM WAV only; isolated compressed decoder unavailable.')
    try:
        path = _local_path(path)
        if not path.lower().endswith('.wav'):
            out.update(status='unsupported', diagnostics=[
                'isolated decoder unavailable: filesystem/network denial and native memory limit required'])
            return out
        import numpy as np
        with _local_stream(path) as stream:
            # Check the held file descriptor, never stat/reopen an attacker path.
            if os.fstat(stream.fileno()).st_size > cfg['max_bytes']:
                raise _InputBudgetExceeded('input byte budget exceeded')
            with wave.open(stream, 'rb') as wav:
                ch, width, rate, frames = wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
                if width not in (1, 2, 3, 4) or wav.getcomptype() != 'NONE':
                    raise ValueError('unsupported PCM format')
                if not ch or ch > cfg['max_channels']:
                    out.update(status='budget_exceeded', diagnostics=['channel budget exceeded'])
                    return out
                cost = cfg['fft_size'] * int(math.log2(cfg['fft_size'])) * ch
                limit = min(cfg['max_samples'] // ch, cfg['max_bytes'] // (8 * ch), cfg['max_operations'] // cost * cfg['hop_samples'])
                n = min(frames, limit)
                raw = wav.readframes(n)
                if len(raw) != n * ch * width:
                    raise ValueError('truncated PCM payload')
        if width == 1:
            pcm = (np.frombuffer(raw, dtype=np.uint8).astype(float) - 128) / 128
        elif width == 3:
            v = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
            v = v[:, 0] | v[:, 1] << 8 | v[:, 2] << 16
            pcm = ((v ^ 0x800000) - 0x800000).astype(float) / 8388608
        else:
            pcm = np.frombuffer(raw, dtype='<i%d' % width).astype(float) / 2**(8*width-1)
        result = analyze_pcm(pcm.reshape(n, ch), rate, budgets=cfg)
        result['assumptions'].extend(out['assumptions'][-1:])
        result['metrics']['input_frames'] = frames
        if frames > n:
            result['status'] = 'budget_exceeded'
            result['diagnostics'].append('decoded prefix truncated by budget')
        return result
    except _InputBudgetExceeded as exc:
        out.update(status='budget_exceeded', diagnostics=[str(exc)])
    except (OSError, ValueError, TypeError, EOFError, wave.Error, ImportError) as exc:
        out.update(status='unsupported', diagnostics=[type(exc).__name__ + ': ' + str(exc)[:200]])
    return out
