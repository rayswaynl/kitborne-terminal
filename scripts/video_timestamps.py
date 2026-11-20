"""Bounded decoded PTS tables; independent of other review cards (stdlib only).

Indexes are zero-based decoder output indexes. Packet timing and average FPS are
never clocks. A table is usable only when the bounded probe reached EOF.
"""
import hashlib
import ctypes
import errno
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path, PureWindowsPath
from fractions import Fraction

if os.name == 'nt':
    try:
        import video_windows
    except (OSError, AttributeError) as error:
        video_windows = None
        _windows_api_error = 'Windows decoder APIs unavailable: %s' % error

SCHEMA = 'asset-review/video-timestamps-1'
MAX_BYTES = 1024 * 1024
MAX_FRAMES = 4096
MAX_PIXELS = 128 * 1024 * 1024
MAX_SOURCE_BYTES = 256 * 1024 * 1024
TIMEOUT = 8
SAFE_INTEGER = 2**53 - 1


def result(status, diagnostic=None, **fields):
    return dict(schema=SCHEMA, status=status, metrics={},
                units={'presentation_time': 's', 'media_time': 's', 'pts': 'time_base ticks',
                       'decoded_index': 'zero-based frame', 'decoded_pixels': 'pixels'},
                assumptions=['Decoder output must have strictly increasing PTS.',
                             'Only self-contained MOV/MP4 and Matroska/WebM containers are supported.',
                             'Decode uses a sealed snapshot, fd-only I/O and Linux socket denial or Windows AppContainer/job isolation; other platforms fail closed.',
                             'The installed native decoder remains trusted code; this is not a general native-code sandbox.',
                             'Browser media time zero maps to stream start_pts; no FPS interpolation.'],
                diagnostics=[diagnostic] if diagnostic else [], **fields)


def integer(value):
    if isinstance(value, bool) or len(str(value)) > 32:
        raise ValueError('invalid integer')
    n = int(str(value))
    if abs(n) > SAFE_INTEGER:
        raise ValueError('integer exceeds browser precision')
    return n


def clock(stream):
    value = stream.get('time_base')
    if not isinstance(value, str) or len(value) > 64 or '/' not in value:
        raise ValueError('missing rational time_base')
    numerator, denominator = (integer(v) for v in value.split('/'))
    if numerator <= 0 or denominator <= 0:
        raise ValueError('invalid time_base')
    tb = Fraction(numerator, denominator)
    origin = integer(stream['start_pts'])
    return tb, origin


def parse_ffprobe(payload, source_hash, *, max_bytes=MAX_BYTES, max_frames=MAX_FRAMES,
                  max_pixels=MAX_PIXELS):
    """Parse injected ffprobe JSON, retaining rational ticks and explicit origin."""
    if any(type(v) is not int or v <= 0 for v in (max_bytes, max_frames, max_pixels)):
        return result('budget_exceeded', 'invalid parser budget')
    max_bytes, max_frames, max_pixels = min(max_bytes, MAX_BYTES), min(max_frames, MAX_FRAMES), min(max_pixels, MAX_PIXELS)
    if not isinstance(payload, (bytes, str)):
        return result('unsupported', 'expected JSON bytes')
    # A unicode input can use up to four bytes per character; check before encoding.
    if len(payload) > max_bytes:
        return result('budget_exceeded', 'JSON byte budget')
    if isinstance(payload, str):
        encoded_size = sum(1 if ord(c) < 128 else 2 if ord(c) < 2048 else 3 if ord(c) < 65536 else 4 for c in payload)
        if encoded_size > max_bytes:
            return result('budget_exceeded', 'JSON byte budget')
    try:
        raw = payload.encode('utf-8') if isinstance(payload, str) else payload
    except UnicodeError:
        return result('unsupported', 'invalid JSON encoding')
    if len(raw) > max_bytes:
        return result('budget_exceeded', 'JSON byte budget')
    try:
        doc = json.loads(raw)
        stream, = doc['streams']
        tb, origin = clock(stream)
        width, height = integer(stream['width']), integer(stream['height'])
        if width <= 0 or height <= 0:
            raise ValueError('invalid dimensions')
        frames = doc.get('frames')
        mixed = doc.get('packets_and_frames')
        if frames is None and isinstance(mixed, list):
            if len(mixed) > 2 * max_frames + 2:
                return result('budget_exceeded', 'decoded sample budget')
            frames = [f for f in mixed if f.get('type') == 'frame']
        if not isinstance(frames, list) or not frames:
            raise ValueError('missing decoded frames')
        if len(frames) > max_frames or width * height * len(frames) > max_pixels:
            return result('budget_exceeded', 'decoded frame/pixel budget')
        if not isinstance(source_hash, str) or len(source_hash) != 64 or any(c not in '0123456789abcdef' for c in source_hash):
            raise ValueError('missing SHA-256 source identity')
        entries = []
        previous = None
        for i, frame in enumerate(frames):
            pts = integer(frame['pts'])  # best_effort_timestamp and packet DTS cannot substitute
            if previous is not None and pts <= previous:
                raise ValueError('duplicate or nonmonotonic decoded PTS')
            if pts < origin:
                raise ValueError('PTS precedes stream origin')
            if 'width' in frame and (integer(frame['width']) != width or integer(frame['height']) != height):
                raise ValueError('changing decoded dimensions')
            presentation, media = float(pts * tb), float((pts - origin) * tb)
            if not math.isfinite(presentation) or (entries and media <= entries[-1]['media_time']):
                raise ValueError('timestamp exceeds browser precision')
            entries.append(dict(decoded_index=i, pts=pts, presentation_time=presentation, media_time=media))
            previous = pts
        start_time = doc.get('format', {}).get('start_time')
        if start_time is not None:
            text = str(start_time)
            if len(text) > 32 or not re.fullmatch(r'-?\d{1,16}(?:\.\d{1,12})?', text):
                raise ValueError('invalid format origin')
            if abs(Fraction(text) - origin * tb) > Fraction(1, 1000000):
                raise ValueError('format/stream origins disagree; browser mapping unavailable')
        out = result('ok', source_hash=source_hash,
                     time_base={'numerator': tb.numerator, 'denominator': tb.denominator},
                     origin={'pts': origin, 'presentation_time': float(origin * tb), 'media_time': 0},
                     mapping='media_time = (pts - origin.pts) * time_base', entries=entries)
        out['metrics'] = dict(json_bytes=len(raw), decoded_frames=len(entries), decoded_pixels=width * height * len(entries))
        return out
    except (ValueError, TypeError, KeyError, OverflowError, AttributeError, RecursionError):
        return result('unsupported', 'malformed timing, missing PTS/origin, or ambiguous decoded timestamps')


def local_source_path(path, *, windows=None, lstat=None):
    """Reject URL/device/UNC inputs and symlink/junction traversal before reading.

    Windows path logic is independently testable on Linux.
    """
    path = os.fspath(path)
    windows = os.name == 'nt' if windows is None else windows
    if not isinstance(path, str) or not path or len(path) > 4096 or '\0' in path:
        raise ValueError('invalid local source path')
    if path.startswith(('\\', '//')):
        raise ValueError('UNC/device sources unsupported')
    if windows:
        parsed = PureWindowsPath(path)
        if not parsed.is_absolute() or not re.fullmatch(r'[A-Za-z]:', parsed.drive) or ':' in path[2:]:
            raise ValueError('not a local absolute Windows path')
    else:
        if ':' in path:
            raise ValueError('source URLs unsupported')
        parsed = Path(os.path.abspath(path))
    if len(parsed.parts) > 128:
        raise ValueError('source path operation budget')
    inspect = lstat or os.lstat
    for component in [*reversed(parsed.parents), parsed]:
        info = inspect(str(component))
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('symlink/reparse-point sources unsupported')
    return str(parsed)


def _open_source(path):
    """Walk anchored descriptors so a post-lstat link swap cannot redirect reads."""
    if os.name == 'nt':
        return video_windows.Source(path)
    parts = Path(path).parts
    directory = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory); directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError('source is not a regular file')
    return os.fdopen(fd, 'rb')


def _copy_and_hash(source, max_bytes, deadline, destination=None):
    digest, size = hashlib.sha256(), 0
    while True:
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired('source snapshot/hash', TIMEOUT)
        chunk = source.read(min(65536, max_bytes + 1 - size))
        if not chunk:
            return digest.hexdigest(), size
        size += len(chunk)
        if size > max_bytes:
            raise subprocess.TimeoutExpired('source byte budget', TIMEOUT)
        digest.update(chunk)
        if destination is not None:
            destination.write(chunk)


def _seal_snapshot(source, max_bytes, deadline):
    if os.name == 'nt':
        return video_windows.snapshot(source, max_bytes, deadline, _copy_and_hash)
    import fcntl
    snapshot = os.fdopen(os.memfd_create('video-pts', os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC), 'w+b')
    try:
        digest, size = _copy_and_hash(source, max_bytes, deadline, snapshot) if source is not None else (hashlib.sha256(b'').hexdigest(), 0)
        snapshot.flush()
        # Linux UAPI constants also work with Python built against older headers.
        fcntl.fcntl(snapshot, getattr(fcntl, 'F_ADD_SEALS', 1033), 0x000f)
        snapshot.seek(0)
        return snapshot, digest, size
    except BaseException:
        snapshot.close()
        raise


def _input_options(path):
    demuxer = {'.mp4': 'mov', '.mov': 'mov', '.webm': 'matroska', '.mkv': 'matroska'}.get(os.path.splitext(path)[1].lower())
    if demuxer is None:
        raise ValueError('only self-contained MP4/MOV and Matroska/WebM supported')
    return ['-protocol_whitelist', 'fd', '-format_whitelist', 'mov,matroska,webm', '-f', demuxer, '-fd', '0'] + (['-enable_drefs', '0', '-use_absolute_path', '0'] if demuxer == 'mov' else [])


def _isolated_command(command):
    return [sys.executable, os.path.abspath(__file__), '--isolated-decoder', *command]


def _native_input_supported():
    """Linux boundary, including the unchanged legacy metadata semantics.

    Offline tests replace this together with source opening and snapshot creation,
    so injected decoder data exercises orchestration without native Linux APIs.
    """
    return sys.platform == 'linux' and hasattr(os, 'memfd_create')


def _windows_input_supported():
    return os.name == 'nt' and sys.platform == 'win32' and video_windows is not None


def _start_decoder(command, source, timeout):
    if _windows_input_supported():
        return video_windows.launch(command, source, timeout)
    return subprocess.Popen(_isolated_command(command),
                            stdin=source if source is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def legacy_metadata(path, executable):
    """Keep the historical run-based metadata API, with the same input isolation.

    Empty/missing input reaches the native tool as an empty sealed descriptor,
    never a URL. A real decoder rejects it; legacy injected-output tests can
    still exercise rate parsing independently of installed tools and files.
    """
    if not _native_input_supported():
        return []
    source = snapshot = None
    deadline = time.monotonic() + TIMEOUT
    try:
        try:
            path = local_source_path(path)
            source = _open_source(path)
        except FileNotFoundError:
            pass
        options = _input_options(os.fspath(path))
        if source is not None and os.fstat(source.fileno()).st_size > MAX_SOURCE_BYTES:
            return []
        snapshot, _, _ = _seal_snapshot(source, MAX_SOURCE_BYTES, deadline)
        # The helper applies RLIMIT_FSIZE. Regular-file stdout prevents run()
        # from allocating an unbounded capture; read only MAX_BYTES+1 afterward.
        with tempfile.TemporaryFile() as output:
            completed = subprocess.run(_isolated_command([executable, '-v', 'error', *options, '-select_streams', 'v:0',
                                       '-show_entries', 'stream=r_frame_rate,avg_frame_rate', '-of', 'json', 'fd:']),
                                       stdin=snapshot, stdout=output, stderr=subprocess.DEVNULL, close_fds=True,
                                       timeout=max(.001, deadline - time.monotonic()), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if completed.returncode:
                return []
            output.seek(0)
            raw = completed.stdout if completed.stdout is not None else output.read(MAX_BYTES + 1)
        if not isinstance(raw, (bytes, str)) or len(raw) > MAX_BYTES:
            return []
        streams = json.loads(raw).get('streams', [])
        return streams if isinstance(streams, list) and len(streams) == 1 else []
    except (OSError, ValueError, TypeError, AttributeError, RecursionError, subprocess.TimeoutExpired):
        return []
    finally:
        if snapshot is not None:
            snapshot.close()
        if source is not None:
            source.close()


def _deny_decoder_network():
    """Install inherited seccomp socket/io_uring denial before exec, fail closed.

    Use kernel APIs through libc, without a package or libseccomp dependency.
    This runs in a fresh helper process, never preexec_fn in the threaded server.
    """
    if sys.platform != 'linux':
        return False
    architectures = {
        'x86_64': (0xc000003e, [41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 54, 55, 288, 299, 307]),
        'aarch64': (0xc00000b7, list(range(198, 213)) + [242, 243, 269]),
    }
    selected = architectures.get(os.uname().machine)
    if selected is None:
        return False
    arch, denied = selected
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    reject = 0x00050000 | errno.EPERM
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, reject)]
    for syscall in denied + [425, 426, 427]:  # io_uring must not bypass socket syscalls
        instructions.extend([(0x15, 0, 1, syscall), (0x06, 0, 0, reject)])
    instructions.append((0x06, 0, 0, 0x7fff0000))
    filters = (Filter * len(instructions))(*(Filter(*instruction) for instruction in instructions))
    program = Program(len(filters), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    return libc.prctl(38, 1, 0, 0, 0) == 0 and libc.prctl(22, 2, ctypes.cast(ctypes.pointer(program), ctypes.c_void_p).value, 0, 0) == 0


def _read(command, max_bytes, timeout, *, source=None):
    """Drain at most max_bytes+1, kill on overflow, and always reap the child."""
    if timeout <= 0:
        raise subprocess.TimeoutExpired(command, timeout)
    deadline = time.monotonic() + timeout
    if source is not None:
        source.seek(0)
    try:
        proc = _start_decoder(command, source, timeout)
    except OSError as error:
        if os.name == 'nt' and isinstance(error, video_windows.IsolationError):
            return result('unsupported', str(error)), None
        raise
    data = bytearray()
    def drain():
        while len(data) <= max_bytes:
            chunk = proc.stdout.read(min(8192, max_bytes + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > max_bytes:
            try:
                proc.kill()
            except OSError:
                pass
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        proc.wait(timeout=max(.001, deadline - time.monotonic()))
        reader.join(timeout=max(.001, deadline - time.monotonic()))
        if reader.is_alive():
            raise subprocess.TimeoutExpired(command, timeout)
        if len(data) > max_bytes:
            return result('budget_exceeded', 'ffprobe stdout byte budget'), None
        if proc.returncode:
            return result('unsupported', 'decoder isolation unavailable' if proc.returncode == 125 else 'ffprobe decoder failed'), None
        return None, bytes(data)
    finally:
        try:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=1)
        finally:
            proc.stdout.close()
            reader.join(timeout=1)
            if os.name == 'nt' and isinstance(proc, video_windows.Child):
                proc.close()


def probe(path, *, max_bytes=MAX_BYTES, max_frames=MAX_FRAMES, max_pixels=MAX_PIXELS,
          max_source_bytes=MAX_SOURCE_BYTES, timeout=TIMEOUT):
    """Decode a sealed, hashed snapshot with no decoder URL/file/network access."""
    if any(type(v) is not int or v <= 0 for v in (max_bytes, max_frames, max_pixels, max_source_bytes)) or not 0 < timeout <= TIMEOUT:
        return result('budget_exceeded', 'invalid budget')
    # Callers may reduce budgets, never raise the catalog's hard ceilings.
    max_bytes, max_frames = min(max_bytes, MAX_BYTES), min(max_frames, MAX_FRAMES)
    max_pixels, max_source_bytes = min(max_pixels, MAX_PIXELS), min(max_source_bytes, MAX_SOURCE_BYTES)
    executable = shutil.which('ffprobe')
    if not executable:
        return result('not_checked', 'ffprobe unavailable')
    if not _native_input_supported() and not _windows_input_supported():
        if os.name == 'nt' and video_windows is None:
            return result('unsupported', _windows_api_error)
        return result('unsupported', 'sealed snapshot/kernel decoder isolation unavailable')
    deadline = time.monotonic() + timeout
    source = snapshot = None
    try:
        path = local_source_path(path)
        options = _input_options(path)
        source = _open_source(path)
        initial = os.fstat(source.fileno())
        if initial.st_size > max_source_bytes:
            return result('budget_exceeded', 'source byte budget')
        snapshot, digest, size = _seal_snapshot(source, max_source_bytes, deadline)
        prefix = [executable, '-v', 'error', '-threads', '1', '-max_alloc', str(32 * 1024 * 1024),
                  *options, '-select_streams', 'v:0']
        error, raw = _read(prefix + ['-show_entries', 'stream=time_base,start_pts,width,height,r_frame_rate,avg_frame_rate:format=start_time', '-of', 'json', 'fd:'], max_bytes, deadline - time.monotonic(), source=snapshot)
        if error:
            return error
        metadata = json.loads(raw)
        stream, = metadata['streams']
        clock(stream)
        width, height = integer(stream['width']), integer(stream['height'])
        pixels = width * height
        if width <= 0 or height <= 0:
            raise ValueError('invalid dimensions')
        # One extra packet detects a truncated probe. Include it in the pixel budget.
        packet_limit = min(max_frames + 1, max_pixels // pixels)
        if packet_limit < 2:
            return result('budget_exceeded', 'decoded pixel budget before decode')
        error, raw = _read(prefix + ['-read_intervals', '%%+#%d' % packet_limit,
                            '-show_frames', '-show_packets', '-show_entries',
                            'frame=pts,width,height:packet=stream_index', '-of', 'json', 'fd:'],
                           max_bytes, deadline - time.monotonic(), source=snapshot)
        if error:
            return error
        decoded = json.loads(raw)
        mixed = decoded.get('packets_and_frames', [])
        if not isinstance(mixed, list):
            raise ValueError('missing packet accounting')
        if len(mixed) > 2 * packet_limit:
            return result('budget_exceeded', 'decoded operation budget')
        if sum(f.get('type') == 'packet' for f in mixed) >= packet_limit:
            return result('budget_exceeded', 'packet/sample limit reached; incomplete table')
        final = os.stat(path, follow_symlinks=False)
        if (initial.st_dev, initial.st_ino, initial.st_size, initial.st_mtime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
            return result('unsupported', 'source changed during decode')
        source.seek(0)
        final_digest, final_size = _copy_and_hash(source, max_source_bytes, deadline)
        if final_digest != digest or final_size != size:
            return result('unsupported', 'source content changed during decode')
        decoded.update(streams=metadata['streams'], format=metadata.get('format', {}))
        out = parse_ffprobe(json.dumps(decoded), digest, max_bytes=max_bytes,
                            max_frames=max_frames, max_pixels=max_pixels)
        out['metrics']['source_bytes'] = size
        out['metrics']['subprocess_seconds'] = round(timeout - (deadline - time.monotonic()), 3)
        # Metadata is descriptive only, never used to resolve decoded indexes.
        out['rates'] = {k: stream.get(k) for k in ('r_frame_rate', 'avg_frame_rate')}
        return out
    except subprocess.TimeoutExpired:
        return result('budget_exceeded', 'ffprobe time budget')
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
        if os.name == 'nt' and isinstance(error, video_windows.IsolationError):
            return result('unsupported', str(error))
        return result('unsupported', 'source or ffprobe output unavailable/malformed')
    finally:
        if snapshot is not None:
            snapshot.close()
        if source is not None:
            source.close()


def resolve(table, media_time, delta=0):
    """Resolve the displayed frame (last PTS <= media time) and adjacent index."""
    if table.get('schema') != SCHEMA or table.get('status') != 'ok' or not math.isfinite(media_time):
        return None
    entries = table['entries']
    lo, hi = 0, len(entries)
    while lo < hi:
        middle = (lo + hi) // 2
        if entries[middle]['media_time'] <= media_time:
            lo = middle + 1
        else:
            hi = middle
    return entries[max(0, min(len(entries) - 1, max(0, lo - 1) + delta))]


def anchor(table, media_time):
    entry = resolve(table, media_time)
    return dict(entry, source_hash=table['source_hash']) if entry else None


if __name__ == '__main__':
    # No in-process preexec hook: the multithreaded review server starts a fresh
    # worker, which installs kernel isolation before executing the native tool.
    if len(sys.argv) < 3 or sys.argv[1] != '--isolated-decoder':
        raise SystemExit(125)
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES + 1, MAX_BYTES + 1))
    if not _deny_decoder_network():
        raise SystemExit(125)
    os.execv(sys.argv[2], sys.argv[2:])
