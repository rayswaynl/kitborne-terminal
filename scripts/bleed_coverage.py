"""Bounded painted-alpha estimate, never a PDF/X or print certification.

Only the disposable worker changes its in-memory CropBox to expose MediaBox.
The source PDF and existing preflight checks are untouched. Coordinates in gaps
are normalized to the original rotated CropBox (the existing page preview).
POSIX workers use resource limits; Windows workers use a verified Job Object
(memory, CPU, one process) plus a wall-time watchdog. If native containment is
unavailable or rejected by the host, no PDF is opened and evidence is not_checked.
"""
import itertools
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import zlib

SCHEMA = 'asset-review/bleed-coverage-1'
DEFAULT_LIMITS = dict(input_bytes=32 * 1024 * 1024, pages=64, pixels=3_000_000,
                      total_pixels=8_000_000, decoded_samples=16_000_000,
                      operations=64_000_000, decoded_content_bytes=8_000_000,
                      rectangles=4096, total_rectangles=16384, seconds=15,
                      memory_bytes=512 * 1024 * 1024, output_bytes=8 * 1024 * 1024)
DPI = 144
ASSUMPTIONS = [
    'Approximate painted alpha at pixel centers; implicit paper has zero alpha; explicit white paint counts.',
    'Declared BleedBox minus TrimBox, clipped to MediaBox; annotations excluded.',
    'Any nonzero alpha counts, including translucent artwork and antialiasing; tolerance is one raster pixel.',
    'Overlay coordinates refer to the original rotated CropBox; gaps outside the preview remain in PDF coordinates.',
    'Scan work units are 8 per pixel plus decoded content bytes; native parsing/rasterization is bounded by worker memory, CPU and wall time.',
    'No PDF/X or print certification; ok means the estimate completed, not that bleed is sufficient.'
]


def result(status, code=None):
    return dict(schema=SCHEMA, status=status, approximate=True, metrics={},
                units={'ring_pixels': 'pixels', 'painted_pixels': 'pixels', 'uncovered_pixels': 'pixels',
                       'ring_area_mm2': 'mm^2', 'uncovered_area_mm2': 'mm^2', 'coverage_fraction': 'fraction',
                       'pdf_coordinates': 'pt', 'overlay_coordinates': 'normalized'},
                assumptions=list(ASSUMPTIONS),
                diagnostics=[] if code is None else [{'code': code}])


def analyze_pdf(path, pages, limits=None, backend='fitz'):
    """Return one result per requested one-based page; enforce budgets before spawn.

    Limits may only tighten the hard ceilings. No unbounded stdout/stderr capture.
    An unavailable raster backend is not_checked, never positive evidence.
    """
    pages = list(itertools.islice(pages, 301))
    if len(pages) > 300:
        raise ValueError('at most 300 manifest pages')
    if any(not isinstance(n, int) or isinstance(n, bool) or n < 1 for n in pages) or len(set(pages)) != len(pages):
        return [result('not_checked', 'invalid_page_requests') for _ in pages]
    budget = dict(DEFAULT_LIMITS)
    if limits:
        for k, v in limits.items():
            if k not in budget or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
                return [result('not_checked', 'invalid_limits') for _ in pages]
            budget[k] = min(v, budget[k])
    def failed(status, code):
        return [result(status, code) for _ in pages]
    if budget['output_bytes'] < len(pages) * 4096:
        return failed('budget_exceeded', 'output_bytes')
    budget['total_rectangles'] = min(budget['total_rectangles'],
                                     int((budget['output_bytes'] - len(pages)*4096) // 512))
    if backend != 'fitz':
        return failed('not_checked', 'alpha_raster_backend_unavailable')
    try:
        if os.stat(path).st_size > budget['input_bytes']:
            return failed('budget_exceeded', 'input_bytes')
        with tempfile.TemporaryDirectory(prefix='bleed-coverage-') as tmp:
            dest = os.path.join(tmp, 'result.json')
            cmd = [sys.executable, os.path.abspath(__file__), '--worker', os.path.abspath(path), dest,
                   json.dumps(pages), json.dumps(budget)]
            proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  timeout=budget['seconds'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if proc.returncode == 124:
                return failed('budget_exceeded', 'worker_time_or_output_bytes')
            if proc.returncode:
                return failed('budget_exceeded' if proc.returncode < 0 else 'not_checked', 'worker_stopped')
            if os.stat(dest).st_size > budget['output_bytes']:
                return failed('budget_exceeded', 'output_bytes')
            with open(dest, encoding='utf-8') as f:
                data = json.load(f)
            if len(data) != len(pages) or any(x.get('schema') != SCHEMA for x in data):
                return failed('not_checked', 'invalid_worker_result')
            return data
    except subprocess.TimeoutExpired:
        return failed('budget_exceeded', 'subprocess_time')
    except (OSError, ValueError):
        return failed('not_checked', 'analyzer_unavailable')


class EvidenceError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def _box(doc, xref, key, inherited=False):
    """Read declared coordinates, without MuPDF's defaulted/normalized boxes."""
    seen = set()
    while xref and xref not in seen:
        seen.add(xref)
        kind, raw = doc.xref_get_key(xref, key)
        if kind == 'xref':
            raw = doc.xref_object(int(raw.split()[0]), compressed=True)
            kind = 'array' if raw.startswith('[') else kind
        if kind == 'array':
            nums = raw[1:-1].split()
            try:
                box = [float(v) for v in nums]
            except ValueError:
                box = []
            if len(box) != 4 or not all(math.isfinite(v) for v in box) or box[0] >= box[2] or box[1] >= box[3]:
                raise EvidenceError('not_checked', 'invalid_' + key)
            return box
        if kind != 'null':
            raise EvidenceError('unsupported', 'unsupported_' + key)
        if not inherited:
            break
        kind, parent = doc.xref_get_key(xref, 'Parent')
        xref = int(parent.split()[0]) if kind == 'xref' else 0
    return None


def _inside(a, b):
    return b[0] <= a[0] and b[1] <= a[1] and a[2] <= b[2] and a[3] <= b[3]


def _intersection(a, b):
    return [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]


def _matrix(box, rotation):
    # PDF bottom-left -> preview top-left -> clockwise page rotation.
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    if rotation == 0:
        return [1, 0, 0, -1, -x0, y1], w, h
    if rotation == 90:
        return [0, 1, 1, 0, -y0, -x0], h, w
    if rotation == 180:
        return [-1, 0, 0, 1, x1, -y0], w, h
    return [0, -1, -1, 0, y1, x1], h, w


def _point(m, x, y):
    a, b, c, d, e, f = m
    return a*x+c*y+e, b*x+d*y+f


def _bounds(m, box):
    pts = [_point(m, x, y) for x in (box[0], box[2]) for y in (box[1], box[3])]
    return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]


def _page(doc, number, budget, used, started, fitz):
    if number < 1 or number > len(doc):
        raise EvidenceError('not_checked', 'page_unavailable')
    p = doc[number - 1]
    media = _box(doc, p.xref, 'MediaBox', True)
    bleed = _box(doc, p.xref, 'BleedBox')
    trim = _box(doc, p.xref, 'TrimBox')
    crop = _box(doc, p.xref, 'CropBox', True) or media
    if not media or not bleed or not trim:
        raise EvidenceError('not_checked', 'missing_declared_boxes')
    if not _inside(trim, bleed) or not _inside(trim, media):
        raise EvidenceError('not_checked', 'inconsistent_boxes')
    bleed_clipped = _intersection(bleed, media)
    crop = _intersection(crop, media)
    if crop[0] >= crop[2] or crop[1] >= crop[3] or bleed_clipped == trim:
        raise EvidenceError('not_checked', 'empty_ring_or_preview')
    unit_kind, unit = doc.xref_get_key(p.xref, 'UserUnit')
    if unit_kind != 'null' and unit != '1':
        raise EvidenceError('unsupported', 'UserUnit')
    rotation = p.rotation
    if rotation not in (0, 90, 180, 270):
        raise EvidenceError('unsupported', 'rotation')
    preview_m, pw, ph = _matrix(crop, rotation)
    # Raster unrotated to avoid backend-specific origin behavior; explicitly
    # transform gaps to the rotated original preview using the matrix above.
    m, w, h = _matrix(media, 0)
    scale = DPI / 72
    if not math.isfinite(w*scale) or not math.isfinite(h*scale):
        raise EvidenceError('budget_exceeded', 'pixels')
    width, height = math.ceil(w*scale), math.ceil(h*scale)
    pixels = width * height
    if pixels > budget['pixels'] or used['pixels'] + pixels > budget['total_pixels']:
        raise EvidenceError('budget_exceeded', 'pixels')
    if used['operations'] + pixels * 8 > budget['operations']:
        raise EvidenceError('budget_exceeded', 'operations')
    if pixels * 4 > budget['memory_bytes'] / 8:
        raise EvidenceError('budget_exceeded', 'raster_bytes')
    used['pixels'] += pixels
    used['operations'] += pixels * 8
    doc.xref_set_key(p.xref, 'CropBox', '[' + ' '.join(map(str, media)) + ']')
    p = doc.reload_page(p)
    p.set_rotation(0)
    fitz.TOOLS.reset_mupdf_warnings()
    pix = p.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=True, annots=False)
    if fitz.TOOLS.mupdf_warnings():
        raise EvidenceError('not_checked', 'raster_warnings')
    if not pix.alpha or pix.n != 4 or pix.width != width or pix.height != height:
        raise EvidenceError('not_checked', 'unsupported_alpha_raster')
    samples = pix.samples_mv  # zero-copy view; no Pillow conversion or white background
    edges = {k: dict(ring_pixels=0, painted_pixels=0) for k in ('left', 'right', 'top', 'bottom')}
    total = painted = 0
    rects, active = [], {}
    bx0, by0, bx1, by1 = bleed_clipped
    tx0, ty0, tx1, ty1 = trim
    for iy in range(height):
        if time.monotonic() - started > budget['seconds']:
            raise EvidenceError('budget_exceeded', 'analysis_time')
        y = media[3] - (iy + .5)/scale
        runs, start = [], None
        for ix in range(width):
            x = media[0] + (ix + .5)/scale
            ring = bx0 <= x < bx1 and by0 <= y < by1 and not (tx0 <= x < tx1 and ty0 <= y < ty1)
            gap = False
            if ring:
                total += 1
                art = samples[iy*pix.stride + ix*4 + 3] > 0
                painted += art
                gap = not art
                # Disjoint edge strips: top/bottom include the corners.
                edge = 'top' if y >= ty1 else 'bottom' if y < ty0 else 'left' if x < tx0 else 'right'
                edges[edge]['ring_pixels'] += 1
                edges[edge]['painted_pixels'] += art
            if gap and start is None:
                start = ix
            if start is not None and (not gap or ix == width-1):
                runs.append((start, ix if not gap else ix+1))
                start = None
        following = {}
        for run in runs:
            if run in active:
                rect = active.pop(run)
                rect[3] = iy+1
            else:
                rect = [run[0], iy, run[1], iy+1]
            following[run] = rect
        rects.extend(active.values())
        active = following
        if len(rects) + len(active) > budget['rectangles']:
            raise EvidenceError('budget_exceeded', 'gap_rectangles')
    rects.extend(active.values())
    if used['rectangles'] + len(rects) > budget['total_rectangles']:
        raise EvidenceError('budget_exceeded', 'total_gap_rectangles')
    used['rectangles'] += len(rects)
    if not total:
        raise EvidenceError('not_checked', 'ring_below_raster_resolution')
    gaps = []
    for x0, y0, x1, y1 in rects:
        pdf = _intersection([media[0]+x0/scale, media[3]-y1/scale,
                             media[0]+x1/scale, media[3]-y0/scale], bleed_clipped)
        visible = _intersection(pdf, crop)
        overlay = None
        if visible[0] < visible[2] and visible[1] < visible[3]:
            a, b, c, d = _bounds(preview_m, visible)
            overlay = [a/pw, b/ph, (c-a)/pw, (d-b)/ph]
        gaps.append(dict(pdf_rect=pdf, rect=overlay))
    for edge in edges.values():
        edge['uncovered_pixels'] = edge['ring_pixels'] - edge['painted_pixels']
        edge['coverage_fraction'] = edge['painted_pixels']/edge['ring_pixels'] if edge['ring_pixels'] else None
    r = result('ok')
    r.update(raster=dict(dpi=DPI, width=width, height=height, alpha_threshold=1,
                         tolerance_px=1, tolerance_mm=25.4/DPI),
             geometry=dict(media_box=media, bleed_box=bleed, clipped_bleed_box=bleed_clipped,
                           trim_box=trim, preview_box=crop, rotation=rotation,
                           pdf_to_preview=preview_m, preview_size_pt=[pw, ph], pdf_to_raster=[v*scale for v in m]),
             gaps=gaps)
    r['metrics'] = dict(ring_pixels=total, painted_pixels=painted, uncovered_pixels=total-painted,
                        coverage_fraction=painted/total, ring_area_mm2=total*(25.4/DPI)**2,
                        uncovered_area_mm2=(total-painted)*(25.4/DPI)**2, edges=edges)
    if bleed != bleed_clipped:
        r['diagnostics'].append({'code': 'bleed_clipped_to_media'})
    return r


# The successful Windows Job handle must remain open until worker process exit.
# KILL_ON_JOB_CLOSE would terminate this worker if we closed it before writing
# its result. A worker owns at most one Job and one daemon watchdog thread.
_WINDOWS_JOBS = []


def _windows_worker_limits(budget, kernel=None):
    """Contain the disposable worker before backend import or PDF open.

    Job Objects supply native process-memory/CPU limits and prohibit child
    processes. A single bounded watchdog terminates the Job at wall-time expiry;
    analyze_pdf's parent timeout remains the outer lifetime bound. No Windows
    dependency is needed beyond ctypes. Assignment failures (including a host's
    incompatible parent Job) fail closed; never run an uncontained rasterizer.
    """
    import ctypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64),
                    ('PerJobUserTimeLimit', ctypes.c_int64), ('LimitFlags', ctypes.c_uint32),
                    ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t),
                    ('ActiveProcessLimit', ctypes.c_uint32), ('Affinity', ctypes.c_size_t),
                    ('PriorityClass', ctypes.c_uint32), ('SchedulingClass', ctypes.c_uint32)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                     'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', BasicLimits), ('IoInfo', IoCounters),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    job, assigned = None, False
    try:
        if _WINDOWS_JOBS:
            return False
        if kernel is None:
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        # Fixed-width DWORD/BOOL fields, pointer-sized handles/SIZE_T. In
        # particular, do not truncate a 64-bit Job handle to ctypes' default int.
        signatures = {
            'CreateJobObjectW': ([ctypes.c_void_p, ctypes.c_wchar_p], ctypes.c_void_p),
            'SetInformationJobObject': ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32], ctypes.c_int),
            'QueryInformationJobObject': ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p], ctypes.c_int),
            'AssignProcessToJobObject': ([ctypes.c_void_p, ctypes.c_void_p], ctypes.c_int),
            'GetCurrentProcess': ([], ctypes.c_void_p),
            'TerminateJobObject': ([ctypes.c_void_p, ctypes.c_uint32], ctypes.c_int),
            'CloseHandle': ([ctypes.c_void_p], ctypes.c_int)
        }
        for name, (args, ret) in signatures.items():
            function = getattr(kernel, name)
            function.argtypes, function.restype = args, ret
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            return False
        info = ExtendedLimits()
        # PROCESS_TIME | ACTIVE_PROCESS | PROCESS_MEMORY | KILL_ON_JOB_CLOSE.
        info.BasicLimitInformation.LimitFlags = 0x0002 | 0x0008 | 0x0100 | 0x2000
        info.BasicLimitInformation.PerProcessUserTimeLimit = math.ceil(budget['seconds'] * 10_000_000)
        info.BasicLimitInformation.ActiveProcessLimit = 1
        info.ProcessMemoryLimit = int(budget['memory_bytes'])
        size = ctypes.sizeof(info)
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), size):
            return False
        installed = ExtendedLimits()
        if not kernel.QueryInformationJobObject(job, 9, ctypes.byref(installed), size, None):
            return False
        if (installed.BasicLimitInformation.LimitFlags != info.BasicLimitInformation.LimitFlags
                or installed.BasicLimitInformation.PerProcessUserTimeLimit != info.BasicLimitInformation.PerProcessUserTimeLimit
                or installed.BasicLimitInformation.ActiveProcessLimit != 1
                or installed.ProcessMemoryLimit != info.ProcessMemoryLimit):
            return False
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            return False
        assigned = True
        timer = threading.Timer(budget['seconds'], lambda: kernel.TerminateJobObject(job, 124))
        timer.daemon = True
        _WINDOWS_JOBS.append((kernel, job, timer))
        timer.start()
        return True
    except (AttributeError, ImportError, OSError, ValueError, RuntimeError):
        return False
    finally:
        if job and not assigned:
            kernel.CloseHandle(job)


def _set_worker_limits(budget):
    if sys.platform == 'win32':
        return _windows_worker_limits(budget)
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (int(budget['memory_bytes']), int(budget['memory_bytes'])))
        cpu = max(1, math.ceil(budget['seconds']))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_FSIZE, (int(budget['output_bytes']), int(budget['output_bytes'])))
        return True
    except (ImportError, AttributeError, ValueError, OSError):
        return False


def _write_worker_result(path, data, byte_limit):
    """Bound output on both platforms, including Windows without RLIMIT_FSIZE.

    Result construction already bounds pages and gap rectangles. Stream encoding
    avoids a second full JSON allocation and checks bytes before each file write.
    The parent discards any partial output after the budget exit code.
    """
    remaining = int(byte_limit)
    with open(path, 'wb') as f:
        for chunk in json.JSONEncoder(allow_nan=False).iterencode(data):
            raw = chunk.encode('utf-8')
            if len(raw) > remaining:
                return False
            f.write(raw)
            remaining -= len(raw)
    return True


def _worker(path, pages, budget):
    # Native parser/decoder allocations also have a ceiling, set before import/open.
    if not _set_worker_limits(budget):
        return [result('not_checked', 'native_resource_limits_unavailable') for _ in pages]
    try:
        import fitz
    except ImportError:
        return [result('not_checked', 'alpha_raster_backend_unavailable') for _ in pages]
    started = time.monotonic()
    try:
        if os.stat(path).st_size > budget['input_bytes']:
            raise EvidenceError('budget_exceeded', 'input_bytes')
        with fitz.open(path) as doc:
            if doc.is_repaired:
                raise EvidenceError('not_checked', 'repaired_pdf')
            if not doc.is_pdf:
                raise EvidenceError('not_checked', 'not_pdf')
            if doc.is_encrypted:
                raise EvidenceError('not_checked', 'encrypted_pdf')
            # Bound object traversal and declared image decode samples before rendering.
            if doc.xref_length() > min(100_000, budget['operations']):
                raise EvidenceError('budget_exceeded', 'object_operations')
            samples = content_bytes = 0
            for xref in range(1, doc.xref_length()):
                if time.monotonic() - started > budget['seconds']:
                    raise EvidenceError('budget_exceeded', 'analysis_time')
                if doc.xref_get_key(xref, 'Subtype')[1] != '/Image':
                    if doc.xref_is_stream(xref):
                        # Bound decompression before rasterization. Images are
                        # handled separately by their declared sample dimensions.
                        raw = doc.xref_stream_raw(xref)
                        remaining = int(budget['decoded_content_bytes'] - content_bytes)
                        filter_value = doc.xref_get_key(xref, 'Filter')[1]
                        if filter_value in ('/FlateDecode', '[/FlateDecode]'):
                            decoder = zlib.decompressobj()
                            decoded = decoder.decompress(raw, remaining + 1)
                            if len(decoded) > remaining or decoder.unconsumed_tail:
                                raise EvidenceError('budget_exceeded', 'decoded_content_bytes')
                            if not decoder.eof:
                                raise EvidenceError('not_checked', 'incomplete_content_stream')
                        elif filter_value == 'null':
                            if len(raw) > remaining:
                                raise EvidenceError('budget_exceeded', 'decoded_content_bytes')
                            decoded = raw
                        else:
                            raise EvidenceError('not_checked', 'unsupported_content_filter')
                        content_bytes += len(decoded)
                        if re.search(rb'(?<!\w)BI(?=\s)', decoded):
                            # Inline image headers are not safely available as
                            # xref dimensions; never infer a decode budget.
                            raise EvidenceError('not_checked', 'inline_image_decode_size_unverified')
                    continue
                try:
                    w = int(doc.xref_get_key(xref, 'Width')[1])
                    h = int(doc.xref_get_key(xref, 'Height')[1])
                    bits_kind, bits_value = doc.xref_get_key(xref, 'BitsPerComponent')
                    bits = int(bits_value) if bits_kind != 'null' else 1
                    if '/DeviceN' in doc.xref_get_key(xref, 'ColorSpace')[1]:
                        raise EvidenceError('not_checked', 'image_channels_unverified')
                    if w <= 0 or h <= 0 or bits not in (1, 2, 4, 8, 16):
                        raise ValueError()
                except ValueError:
                    raise EvidenceError('not_checked', 'unknown_image_decode_size')
                samples += w*h*8  # conservative ceiling: up to 8 color/mask channels
                if samples > budget['decoded_samples']:
                    raise EvidenceError('budget_exceeded', 'decoded_samples')
            if content_bytes + doc.xref_length() > budget['operations']:
                raise EvidenceError('budget_exceeded', 'content_operations')
            used = dict(pixels=0, operations=doc.xref_length()+content_bytes, rectangles=0)
            output = []
            for i, n in enumerate(pages):
                try:
                    if i >= budget['pages'] or n > budget['pages']:
                        raise EvidenceError('budget_exceeded', 'pages')
                    output.append(_page(doc, n, budget, used, started, fitz))
                except EvidenceError as e:
                    output.append(result(e.status, e.code))
                except MemoryError:
                    output.append(result('budget_exceeded', 'memory_bytes'))
                except Exception:
                    output.append(result('not_checked', 'rasterization_failed'))
            return output
    except EvidenceError as e:
        return [result(e.status, e.code) for _ in pages]
    except MemoryError:
        return [result('budget_exceeded', 'memory_bytes') for _ in pages]
    except Exception:
        return [result('not_checked', 'pdf_unreadable') for _ in pages]


if __name__ == '__main__' and len(sys.argv) == 6 and sys.argv[1] == '--worker':
    budget = json.loads(sys.argv[5])
    data = _worker(sys.argv[2], json.loads(sys.argv[4]), budget)
    if not _write_worker_result(sys.argv[3], data, budget['output_bytes']):
        sys.exit(124)
