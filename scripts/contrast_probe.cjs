'use strict';
// Advisory computed-style probe for local static fixtures, not certification.
// CLI: node scripts/contrast_probe.cjs --root DIR --file index.html [--max-nodes N]
// CONTRAST_PROBE_CHROMIUM may select a provisioned executable; versions are reported.
// Scripts/workers are disabled; guarded reads create bounded in-memory snapshots.
// Windows uses a Python stdlib/Win32 reader with effective directory guards.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const ORIGIN = 'https://contrast-fixture.invalid';
const DEFAULTS = Object.freeze({ maxNodes: 2000, maxResults: 300, maxDepth: 64,
  maxRects: 32, maxRequests: 64, maxFileBytes: 1048576, maxTotalBytes: 4194304,
  maxOperations: 200000, timeoutMs: 10000, normalThreshold: 4.5, largeThreshold: 3 });
const MAX_OUTPUT_BYTES = 2097152;
const CAPS = { maxNodes: 10000, maxResults: 1000, maxDepth: 128, maxRects: 128,
  maxRequests: 128, maxFileBytes: 2097152, maxTotalBytes: 8388608,
  maxOperations: 1000000, timeoutMs: 30000 };
function options(input) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (input[key] !== undefined) {
    const value = input[key];
    if (!Number.isFinite(value) || value <= 0 ||
        (key.endsWith('Threshold') ? value > 21 : !Number.isInteger(value) || value > CAPS[key]))
      throw new Error(`Invalid ${key}`);
    out[key] = value;
  }
  return out;
}
function linearize(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(rgb) { return rgb.slice(0, 3).reduce((sum, c, i) => sum + linearize(c) * [0.2126, 0.7152, 0.0722][i], 0); }
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

// Validate syntax BEFORE any filesystem call, including realpath. Normalizing
// first would hide UNC prefixes. Windows accepts only explicit local DOS roots;
// its native guard also checks the drive type before opening any component.
function localRoot(value, platform = process.platform, cwd) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) ||
      value.startsWith('\\') || value.startsWith('//')) throw new Error('Nonlocal fixture root');
  if (platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value)) {
      if (value.includes(':')) throw new Error('Absolute local drive root required');
      const base = cwd || process.cwd();
      if (value.startsWith('/') || !/^[a-z]:[\\/]/i.test(base)) throw new Error('Absolute local drive root required');
      return localRoot(path.win32.resolve(localRoot(base, 'win32'), value), 'win32');
    }
    const parts = value.slice(3).split(/[\\/]/);
    if (parts.some(p => p === '.' || p === '..' || /[<>:"|?*]/.test(p) || /[ .]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw new Error('Unsafe Windows root');
    const normalized = path.win32.normalize(value);
    return normalized.length > 3 ? normalized.replace(/[\\/]+$/, '') : normalized;
  }
  if (value.includes('\\') || value.includes(':')) throw new Error('Nonlocal fixture root');
  return path.resolve(value);
}
function localName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || /[\\:\x00-\x1f<>"|?*]/.test(name) ||
      name.split('/').some(p => !p || p === '.' || p === '..' || /[ .]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw new Error('Unconfined fixture name');
  return name;
}

// Hold every Windows ancestor with GENERIC_READ and FILE_SHARE_READ only.
// GENERIC_READ includes FILE_LIST_DIRECTORY: metadata-only FILE_READ_ATTRIBUTES
// handles do not enforce the write/delete exclusion needed for this walk.
// Check each held handle for reparses before opening its child; retain all
// guards through the bounded read. No Node pathname open/realpath on Windows.
const WINDOWS_READ = String.raw`
import contextlib, json, ntpath, os, stat, sys
sys.path.insert(0, sys.argv[1])
import spectral_events as guard

@contextlib.contextmanager
def _windows_stream(source):
    import ctypes
    import msvcrt
    from ctypes import wintypes as w

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetDriveTypeW.argtypes = [w.LPCWSTR]
    kernel.GetDriveTypeW.restype = w.UINT
    drive, tail = ntpath.splitdrive(source)
    if kernel.GetDriveTypeW(drive + '\\') != 3:
        raise ValueError('verified fixed local fixture drive required')
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
            final = i == len(paths) - 1
            # READ_DATA / LIST_DIRECTORY access makes sharing exclusion effective.
            # OPEN_REPARSE_POINT | BACKUP_SEMANTICS inspects the node itself.
            handle = kernel.CreateFileW(component, 0x80000000, 1, None, 3,
                                        0x00200000 | 0x02000000, None)
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            handles.append(handle)
            info = FileInfo()
            if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            if info.attributes & 0x400:
                raise ValueError('reparse fixtures and ancestors are unsupported')
            if bool(info.attributes & 0x10) == final:
                raise ValueError('expected regular fixture and directory ancestors')
        handle = handles.pop()
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | getattr(os, 'O_BINARY', 0))
        except Exception:
            kernel.CloseHandle(handle)
            raise
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('regular fixture file required')
            yield stream
    finally:
        for handle in reversed(handles):
            kernel.CloseHandle(handle)


def read_fixture(request):
    root = ntpath.normpath(request['root'])
    guard._local_path(ntpath.join(root, '__contrast_root_check__'))
    source = guard._local_path(ntpath.join(root, *request['name'].split('/')))
    with _windows_stream(source) as stream:
        # The guard still owns locks on root and every intermediate directory.
        info = os.stat(root)
        if not info.st_ino:
            raise ValueError('fixture root identity unavailable')
        identity = [str(info.st_dev), str(info.st_ino)]
        if request.get('identity') is not None and request['identity'] != identity:
            raise ValueError('fixture root identity changed')
        info = os.fstat(stream.fileno())
        if info.st_size > request['maximum']:
            return dict(error='byte-limit')
        data = stream.read(request['maximum'] + 1)
        if len(data) > request['maximum']:
            return dict(error='byte-limit')
        import base64
        return dict(identity=identity, body=base64.b64encode(data).decode('ascii'))

if __name__ == '__main__':
    try:
        print(json.dumps(read_fixture(json.load(sys.stdin))))
    except Exception:
        print(json.dumps(dict(error='resource-unavailable-or-unconfined')))
`;
function windowsRead(request, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').execFile(process.env.CONTRAST_PROBE_PYTHON || 'python',
      ['-I', '-B', '-c', WINDOWS_READ, __dirname], { signal, timeout: timeoutMs, windowsHide: true,
        maxBuffer: Math.ceil(request.maximum * 4 / 3) + 4096 }, (error, stdout) => {
        if (error) return reject(new Error(signal.aborted || error.killed ? 'timeout' : 'secure Windows reader unavailable'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('secure Windows reader unavailable')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
async function fixtureReader(root, maximum, signal, remaining) {
  root = localRoot(root);
  let heldRoot, identity, spent = 0, closed = false, pending = Promise.resolve();
  const check = () => { if (closed || signal.aborted) throw new Error('timeout'); };
  const open = async (name, directory) => {
    check();
    return fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
      (directory ? constants.O_DIRECTORY : 0));
  };
  if (process.platform === 'linux') {
    let parent = await open('/', true);
    try {
      for (const part of root.split('/').filter(Boolean)) {
        const next = await open(`/proc/self/fd/${parent.fd}/${part}`, true);
        await parent.close(); parent = next;
      }
      check(); heldRoot = parent;
    } catch (error) { await parent.close(); throw error; }
  } else if (process.platform !== 'win32') throw new Error('secure local reader unavailable');
  const read = async name => {
    check(); localName(name);
    const ceiling = Math.min(maximum.maxFileBytes, maximum.maxTotalBytes - spent);
    if (process.platform === 'win32') {
      const result = await windowsRead({ root, name, identity, maximum: ceiling }, signal, remaining());
      if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
      identity = result.identity;
      const data = Buffer.from(result.body, 'base64');
      if (data.length > ceiling) throw Object.assign(new Error('byte-limit'), { code: 'byte-limit' });
      spent += data.length; return data;
    }
    const guards = [];
    let parent = heldRoot;
    try {
      const parts = name.split('/');
      for (let i = 0; i < parts.length; i++) {
        const next = await open(`/proc/self/fd/${parent.fd}/${parts[i]}`, i < parts.length - 1);
        guards.push(next); parent = next;
      }
      const stat = await parent.stat();
      if (!stat.isFile()) throw new Error('regular fixture file required');
      if (stat.size > ceiling) throw Object.assign(new Error('byte-limit'), { code: 'byte-limit' });
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        check();
        const { bytesRead } = await parent.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw new Error('fixture changed during read');
        offset += bytesRead;
      }
      const after = await parent.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        throw new Error('fixture changed during read');
      spent += data.length; return data;
    } finally { for (const handle of guards.reverse()) await handle.close(); }
  };
  return {
    // Serial reads keep the total byte budget atomic and root handles alive.
    read(name) { const task = pending.then(() => read(name)); pending = task.catch(() => {}); return task; },
    async close() { closed = true; await pending; if (heldRoot) { await heldRoot.close(); heldRoot = null; } },
  };
}

// Self-contained browser function. Group opacity is applied AFTER compositing
// its descendants, rather than multiplying all background alphas together.
function inspect(limits) {
  const rows = [], issues = [], nodes = [], paints = [], textParents = new Set();
  let visited = 0, operations = 0, hidden = 0, nontext = 0;
  const deadline = performance.now() + limits.remainingMs;
  const stop = reason => { if (!issues.includes(reason)) issues.push(reason); };
  const budget = () => {
    if (++operations > limits.maxOperations) { stop('operation-limit'); return false; }
    if (performance.now() >= deadline) { stop('timeout'); return false; }
    return true;
  };
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
  let node;
  while ((node = walker.nextNode())) {
    if (!budget()) break;
    if (++visited > limits.maxNodes) { stop('node-limit'); break; }
    nodes.push(node);
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) textParents.add(node.parentElement);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const style = getComputedStyle(node);
      if (style.display !== 'none' && style.visibility === 'visible' && +style.opacity > 0)
        paints.push({ element: node, style, rect: node.getBoundingClientRect() });
    }
  }
  const rect = r => Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, Math.round(r[k] * 1000) / 1000]));
  const selector = el => {
    const parts = [];
    for (let depth = 0; el && depth < limits.maxDepth; depth++, el = el.parentElement) {
      let i = 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) { if (!budget()) return null; i++; }
      if (el.localName.length > 64) return null;
      parts.unshift(`${el.localName}:nth-child(${i})`);
      if (parts.join(' > ').length > 512) return null;
    }
    if (el) return null;
    return parts.join(' > ');
  };
  const color = value => {
    const m = /^rgba?\(([^)]+)\)$/.exec(value);
    if (!m) return null;
    const c = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (c.length === 3) c.push(1);
    return c.length === 4 && c.every(Number.isFinite) && c.slice(0, 3).every(v => v >= 0 && v <= 255) && c[3] >= 0 && c[3] <= 1 ? c : null;
  };
  const over = (a, b) => {
    const alpha = a[3] + b[3] * (1 - a[3]);
    return alpha ? [...a.slice(0, 3).map((v, i) => (v * a[3] + b[i] * b[3] * (1 - a[3])) / alpha), alpha] : [0, 0, 0, 0];
  };
  const intersect = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  for (const n of nodes) {
    if (!budget()) break;
    const el = n.nodeType === Node.TEXT_NODE ? n.parentElement : n;
    const frame = el?.matches?.('iframe,frame');
    const shadow = n.nodeType === Node.ELEMENT_NODE && !!el.shadowRoot;
    if (!frame && !shadow && (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim())) { nontext++; continue; }
    if (!el || el.closest('script,style,template,head')) { nontext++; continue; }
    const s = getComputedStyle(el), chain = [], reasons = [];
    let invisible = false, ancestor = el;
    for (; ancestor && chain.length < limits.maxDepth; ancestor = ancestor.parentElement) {
      if (!budget()) break;
      const c = getComputedStyle(ancestor);
      if (c.display === 'none' || c.visibility !== 'visible' || +c.opacity === 0 || c.contentVisibility === 'hidden') invisible = true;
      chain.push({ element: ancestor, style: c, background: color(c.backgroundColor), opacity: +c.opacity });
    }
    if (ancestor) reasons.push('ancestor-depth-limit');
    if (invisible) { hidden++; continue; }
    if (el.closest('svg,math')) reasons.push('non-css-text');
    const range = document.createRange();
    if (n.nodeType === Node.TEXT_NODE) range.selectNodeContents(n); else range.selectNode(el);
    const rs = range.getClientRects();
    const samples = Array.from({ length: Math.min(rs.length, limits.maxRects) }, (_, i) => rs[i]);
    if (!samples.some(r => r.width > 0 && r.height > 0)) { hidden++; continue; }
    if (rows.length >= limits.maxResults) { stop('result-limit'); break; }
    if (rs.length > limits.maxRects) reasons.push('rectangle-limit');
    const location = selector(el);
    if (!location) reasons.push('selector-limit');
    const base = { selector: location, textNodeIndex: n.nodeType === Node.TEXT_NODE ? Array.prototype.indexOf.call(el.childNodes, n) : null,
      rectangles: samples.map(rect), text: frame || shadow ? null : n.textContent.trim().slice(0, 200),
      fontSizePx: parseFloat(s.fontSize), fontWeight: s.fontWeight.slice(0, 40), cssColor: s.color.slice(0, 240),
      textFillColor: s.webkitTextFillColor.slice(0, 240), foreground: null, background: null,
      ratio: null, threshold: null, meetsThreshold: null, evidence: 'unavailable', unresolvedReasons: reasons };
    rows.push(base);
    if (frame || shadow) { reasons.push(frame ? 'frame-not-probed' : 'shadow-root-not-probed'); stop('uninspected-subtree'); continue; }
    base.threshold = base.fontSizePx >= 24 || (+s.fontWeight >= 700 && base.fontSizePx >= 56 / 3) ? limits.largeThreshold : limits.normalThreshold;
    const fg = color(s.webkitTextFillColor || s.color);
    if (!fg) reasons.push('unsupported-foreground-color');
    base.layers = chain.map((c, ancestorDepth) => ({ ancestorDepth, cssBackground: c.style.backgroundColor.slice(0, 240), colorTruncated: c.style.backgroundColor.length > 240, opacity: c.opacity }));
    for (const c of chain) {
      if (!budget()) break;
      const st = c.style;
      if (!c.background) reasons.push('unsupported-background-color');
      if (st.backgroundImage !== 'none') reasons.push('background-image-or-gradient');
      if (st.mixBlendMode !== 'normal' || st.backgroundBlendMode.split(',').some(v => v.trim() !== 'normal')) reasons.push('blend');
      if (st.filter !== 'none' || (st.backdropFilter && st.backdropFilter !== 'none')) reasons.push('filter-or-backdrop');
      if (['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(k => parseFloat(st[k]) > 0)) reasons.push('border-paint');
      if (st.textShadow !== 'none' || st.boxShadow !== 'none') reasons.push('shadow');
      if (st.transform !== 'none' || st.perspective !== 'none' || st.clipPath !== 'none' || st.maskImage !== 'none') reasons.push('transform-clip-or-mask');
      if (st.animationName !== 'none' || st.transitionDuration.split(',').some(v => parseFloat(v) > 0)) reasons.push('dynamic-style');
      if (st.backgroundClip !== 'border-box' || st.backgroundOrigin !== 'padding-box' || st.borderRadius.split(' ').some(v => parseFloat(v) > 0)) reasons.push('background-geometry');
      if (st.display === 'list-item' || parseFloat(st.webkitTextStrokeWidth) > 0) reasons.push('marker-or-text-stroke');
      for (const pseudo of ['::before', '::after']) {
        const p = getComputedStyle(c.element, pseudo);
        if (p.content !== 'none' && p.content !== 'normal' && p.display !== 'none') reasons.push('pseudo-element');
      }
      for (const pseudo of ['::first-letter', '::first-line']) {
        const p = getComputedStyle(c.element, pseudo);
        if (p.color !== st.color || p.fontSize !== st.fontSize || p.fontWeight !== st.fontWeight || p.backgroundColor !== 'rgba(0, 0, 0, 0)') reasons.push('pseudo-text-style');
      }
      // Nontransparent ancestor paint must cover the text rectangles.
      if (c.background?.[3] > 0) {
        const allBounds = c.element.getClientRects();
        if (allBounds.length > limits.maxRects) reasons.push('background-rectangle-limit');
        const bounds = Array.from({ length: Math.min(allBounds.length, limits.maxRects) }, (_, i) => allBounds[i]);
        if (!samples.every(r => bounds.some(b => b.left <= r.left && b.right >= r.right && b.top <= r.top && b.bottom >= r.bottom))) reasons.push('background-does-not-cover-text');
      }
      if (['hidden', 'clip', 'scroll', 'auto'].includes(st.overflowX) || ['hidden', 'clip', 'scroll', 'auto'].includes(st.overflowY)) reasons.push('overflow-clipping');
    }
    // Ancestor colors alone do not prove the absence of sibling paint.
    for (const p of paints) {
      if (!budget()) break;
      if (chain.some(c => c.element === p.element)) continue;
      if (['absolute', 'fixed', 'sticky'].includes(p.style.position)) reasons.push('independent-positioned-paint');
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(p.element, pseudo);
        if (ps.content !== 'none' && ps.content !== 'normal' && ps.display !== 'none') reasons.push('independent-pseudo-paint');
      }
      if (!samples.some(r => intersect(r, p.rect))) continue;
      if (p.style.backgroundColor !== 'rgba(0, 0, 0, 0)' || p.style.backgroundImage !== 'none' || p.element.matches('img,svg,canvas,video,iframe') || textParents.has(p.element)) reasons.push('overlapping-content');
    }
    if (issues.includes('timeout') || issues.includes('operation-limit')) reasons.push('evaluation-incomplete');
    base.unresolvedReasons = [...new Set(reasons)].sort();
    if (base.unresolvedReasons.length) continue;
    let background = [0, 0, 0, 0], foreground = fg;
    for (const c of chain) {
      background = over(background, c.background);
      foreground = over(foreground, c.background);
      background[3] *= c.opacity; foreground[3] *= c.opacity;
    }
    if (Math.abs(background[3] - 1) > 1e-12 || Math.abs(foreground[3] - 1) > 1e-12) {
      base.unresolvedReasons.push('unknown-canvas-background'); continue;
    }
    base.background = background; base.foreground = foreground;
    base.evidence = 'measured';
  }
  return { elements: rows, issues, visitedNodes: Math.min(visited, limits.maxNodes), hiddenNodes: hidden, nontextNodes: nontext };
}

async function probe(input = {}) {
  const limits = options(input);
  const report = { advisory: 'Text contrast from static computed styles and solid sRGB compositing; not an accessibility certification or a glyph-pixel measurement.',
    evidence: 'unavailable', complete: false, policy: { normalThreshold: limits.normalThreshold, largeThreshold: limits.largeThreshold,
      largeText: '24 CSS px, or at least 18.666666666666668 CSS px with weight >= 700' },
    limits, elements: [], issues: [], resources: [], counts: { measured: 0, approximate: 0, unavailable: 0, incomplete: 0 } };
  const start = performance.now();
  let browser, reader, timer, cancelled = false;
  const abort = new AbortController();
  const remaining = () => Math.max(1, Math.floor(limits.timeoutMs - (performance.now() - start)));
  const issue = reason => { if (!report.issues.includes(reason)) report.issues.push(reason); };
  const work = async () => {
    const root = localRoot(input.root);
    localName(input.file);
    if (!/\.html?$/i.test(input.file)) throw new Error('HTML fixture entry required');
    reader = await fixtureReader(root, limits, abort.signal, remaining);
    const mainBody = await reader.read(input.file);
    const pinned = require('../package.json').dependencies.playwright;
    if (require('playwright/package.json').version !== pinned) throw new Error('Pinned Playwright unavailable');
    const { chromium } = require('playwright');
    if (cancelled) throw new Error('timeout');
    browser = await chromium.launch({ executablePath: process.env.CONTRAST_PROBE_CHROMIUM || undefined, headless: true, chromiumSandbox: true, timeout: remaining(), args: ['--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND'] });
    if (cancelled) { await browser.close(); throw new Error('timeout'); }
    report.playwrightVersion = pinned; report.browserVersion = browser.version();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
    let requests = 0, servedBytes = 0;
    // No image, media or font decoding: paint involving them remains unresolved.
    const types = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css' };
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      let reason;
      if (++requests > limits.maxRequests) reason = 'request-limit';
      else if (url.origin !== ORIGIN || request.method() !== 'GET') reason = 'external-request-blocked';
      else if (request.isNavigationRequest() && request.frame().parentFrame()) reason = 'frame-request-blocked';
      let body, type;
      if (!reason) try {
        const name = localName(decodeURIComponent(url.pathname).slice(1));
        type = types[path.extname(name).toLowerCase()];
        if (!type) throw new Error('Unsupported resource');
        body = name === input.file ? mainBody : await reader.read(name);
        if (servedBytes + body.length > limits.maxTotalBytes) reason = 'byte-limit';
        else servedBytes += body.length;
      } catch (error) { reason = error.code === 'byte-limit' ? 'byte-limit' : 'resource-unavailable-or-unconfined'; }
      if (report.resources.length < limits.maxRequests) report.resources.push({ url: url.origin === ORIGIN ? url.pathname.slice(0, 200) : '[external]', status: reason || 'local', bytes: reason ? 0 : body?.length || 0 });
      if (reason) {
        issue(reason); await route.abort().catch(() => {});
        if (reason === 'request-limit' && requests === limits.maxRequests + 1) await context.close().catch(() => {});
      }
      else await route.fulfill({ status: 200, body, contentType: type, headers: {
        'Content-Security-Policy': "script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; base-uri 'none'" } }).catch(() => {});
    });
    const page = await context.newPage();
    page.on('requestfailed', () => issue('resource-request-failed'));
    await page.goto(`${ORIGIN}/${input.file.split('/').map(encodeURIComponent).join('/')}`, { waitUntil: 'load', timeout: remaining() });
    const result = await page.evaluate(inspect, { ...limits, remainingMs: remaining() });
    let outputBytes = 0;
    report.elements = [];
    for (const row of result.elements) {
      outputBytes += Buffer.byteLength(JSON.stringify(row));
      if (outputBytes > MAX_OUTPUT_BYTES - 65536) { issue('output-limit'); break; }
      report.elements.push(row);
    }
    result.issues.forEach(issue);
    report.visitedNodes = result.visitedNodes; report.hiddenNodes = result.hiddenNodes; report.nontextNodes = result.nontextNodes;
    // Missing resources change the interpretation of all computed styles.
    for (const row of report.elements) {
      if (row.evidence === 'measured' && report.issues.length) {
        row.evidence = 'approximate'; row.unresolvedReasons.push('incomplete-document');
      }
      if (row.foreground && row.background) {
        row.ratio = contrast(row.foreground, row.background);
        row.meetsThreshold = row.evidence === 'measured' ? row.ratio >= row.threshold : null;
      }
    }
    report.complete = !report.issues.length;
    report.evidence = report.complete ? (report.elements.some(r => r.evidence === 'measured') ? 'measured' : 'unavailable') : 'incomplete';
  };
  try {
    await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { cancelled = true; abort.abort(); reject(new Error('timeout')); }, limits.timeoutMs); })]);
  } catch (error) {
    if (error.code === 'byte-limit') issue('byte-limit');
    const timeout = /timeout|timed out/i.test(error.message);
    issue(timeout ? 'timeout' : 'probe-unavailable');
    report.error = error.message.slice(0, 240);
    report.evidence = timeout || report.issues.length > 1 ? 'incomplete' : 'unavailable';
    report.complete = false;
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
    if (reader) await reader.close();
  }
  report.issues.sort(); report.resources.sort((a, b) => a.url.localeCompare(b.url) || a.status.localeCompare(b.status));
  for (const row of report.elements) report.counts[row.evidence]++;
  report.counts.incomplete = report.complete ? 0 : 1;
  return report;
}
async function main() {
  const input = {}, keys = { '--root': 'root', '--file': 'file', ...Object.fromEntries(Object.keys(DEFAULTS).map(k => ['--' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), k])) };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]];
    if (!key || args[i + 1] === undefined) throw new Error('Usage: --root DIR --file index.html [bounded options]');
    input[key] = key === 'root' || key === 'file' ? args[i + 1] : Number(args[i + 1]);
  }
  console.log(JSON.stringify(await probe(input)));
}
module.exports = { probe, linearize, luminance, contrast, DEFAULTS, localRoot, localName, WINDOWS_READ };
if (require.main === module) main().catch(() => { console.log(JSON.stringify({ evidence: 'unavailable', complete: false, elements: [], issues: ['invalid-options'] })); process.exitCode = 2; });
