// Spatial summaries of thresholded evidence, never an artistic-quality verdict.
export const REGION_LIMITS = Object.freeze({ pixels: 2_000_000, inputBytes: 16_000_000, decodedSamples: 16_000_000,
  workingBytes: 96_000_000, operations: 40_000_000, components: 256, timeMs: 2000 });
const statuses = new Set(['ok', 'unsupported', 'not_checked', 'budget_exceeded']);
const byteArray = a => a instanceof Uint8Array || a instanceof Uint8ClampedArray;
const dimensions = a => Number.isSafeInteger(a?.width) && a.width > 0 &&
  Number.isSafeInteger(a?.height) && a.height > 0 && Number.isSafeInteger(a.width * a.height);
function settings(options = {}) {
  const limits = { ...REGION_LIMITS };
  for (const [key, value] of Object.entries(options.limits || {})) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 0) return null;
    limits[key] = Math.min(value, limits[key]); // Callers may tighten, never remove the caps.
  }
  const connectivity = options.connectivity ?? 4, threshold = options.threshold ?? 12;
  if (![4, 8].includes(connectivity) || !Number.isInteger(threshold) || threshold < 0 || threshold > 255) return null;
  return { limits, connectivity, threshold, policy: options.policy || 'canvas-rgb-max' };
}
function result(s, status = 'not_checked', code = null) {
  return { schema: 'asset-review/image-regions-1', status, dimensions: null, regions: [],
    metrics: { changedPixels: null, componentCount: null, changedFraction: null,
      concentration: null, largestComponentShare: null, operations: 0 },
    units: { dimensions: 'pixels', box: 'original image pixels, half-open bounds',
      changedPixels: 'pixels', componentCount: 'components', changedFraction: 'ratio',
      concentration: 'ratio', largestComponentShare: 'ratio', density: 'ratio', operations: 'operations' },
    assumptions: { threshold: s?.threshold ?? 12, thresholdRule: 'strictly greater than threshold',
      connectivity: s?.connectivity ?? 4, morphology: 'none', policy: s?.policy ?? 'canvas-rgb-max',
      alpha: 'ignored; canvas adapters use browser-decoded RGB',
      input: 'one byte per already thresholded mask pixel, or decoded RGBA; existing viewer owns primary image decode',
      operations: 'bounded scan/neighbour, channel-delta and output-sample visits; secondary encoded bytes also capped',
      concentration: 'changedPixels / area of bounding box enclosing ALL changed pixels; empty mask = 0',
      density: 'region changedPixels / region bounding-box area',
      largestComponentShare: 'largest region changedPixels / all changedPixels; empty mask = 0',
      interpretation: 'spatial distribution only; no artistic quality or pass/fail judgement' },
    limits: s?.limits || { ...REGION_LIMITS },
    truncation: { complete: false, reason: code, processedPixels: 0, changedPixelsLowerBound: 0,
      componentsLowerBound: 0 }, diagnostics: code ? [{ code }] : [] };
}
const fail = (s, code, status = 'unsupported') => result(s, status, code);
function delta(a, b, i, policy) {
  const r = Math.abs(a[i] - b[i]), g = Math.abs(a[i + 1] - b[i + 1]), bl = Math.abs(a[i + 2] - b[i + 2]);
  return policy === 'pillow-rgb-luma' ? Math.round(.299 * r + .587 * g + .114 * bl) : Math.max(r, g, bl);
}
function preflight(input, s, bytesPerPixel, workPerPixel) {
  if (!s || !dimensions(input)) return fail(s, 'invalid_dimensions_or_options');
  const n = input.width * input.height;
  if (n > s.limits.pixels || n * bytesPerPixel > s.limits.inputBytes || n * bytesPerPixel > s.limits.decodedSamples || n * workPerPixel > s.limits.workingBytes)
    return fail(s, 'pixel_or_byte_budget', 'budget_exceeded');
  return null;
}

// data: one byte per ORIGINAL pixel, nonzero = already thresholded change.
// Optional R3I-009 diff PNG must be decoded as a thresholded mask by its producer;
// a decorative diff PNG is not assumed to be analytic evidence.
export function groupMask(input, options = {}) {
  const s = settings(options);
  if (input?.status && input.status !== 'ok') return fail(s, 'upstream_evidence_incomplete',
    statuses.has(input.status) ? input.status : 'unsupported');
  const invalid = preflight(input, s, 1, 5);
  if (invalid) return invalid;
  if (!byteArray(input.data) || input.data.length !== input.width * input.height)
    return fail(s, 'invalid_mask');
  if (input.baseline && (!dimensions(input.baseline) || input.baseline.width !== input.width || input.baseline.height !== input.height))
    return fail(s, 'dimension_mismatch_incomparable');
  const { width: W, height: H } = input, N = W * H;
  const out = result(s); out.dimensions = { width: W, height: H };
  // Check before allocating or reading pixels. One scan + bounded neighbour visits.
  if (N > s.limits.operations || !s.limits.timeMs) return fail(s, 'operation_or_time_budget', 'budget_exceeded');
  const visited = new Uint8Array(N), queue = new Uint32Array(N);
  const start = Date.now(), neighbours = s.connectivity === 4 ? [[-1, 0], [1, 0], [0, -1], [0, 1]] :
    [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  let total = 0, largest = 0, gx = W, gy = H, gr = 0, gb = 0;
  const stop = (reason, processed, observed = total, components = out.regions.length) => {
    out.status = 'budget_exceeded'; out.diagnostics.push({ code: reason });
    out.truncation = { complete: false, reason, processedPixels: processed,
      changedPixelsLowerBound: observed, componentsLowerBound: components };
    return out; // No total/concentration on incomplete evidence, only finished regions.
  };
  const tick = () => {
    if (out.metrics.operations >= s.limits.operations) return false;
    out.metrics.operations++;
    return out.metrics.operations % 1024 !== 0 || Date.now() - start <= s.limits.timeMs;
  };
  for (let i = 0; i < N; i++) {
    if (!tick()) return stop('operation_or_time_budget', i);
    if (!input.data[i] || visited[i]) continue;
    if (out.regions.length >= s.limits.components) return stop('component_budget', i, total + 1, out.regions.length + 1);
    let head = 0, tail = 1, count = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    queue[0] = i; visited[i] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % W, y = Math.floor(p / W); count++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
      for (const [dx, dy] of neighbours) {
        if (!tick()) return stop('operation_or_time_budget', i, total + count, out.regions.length + 1);
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const q = ny * W + nx;
        if (input.data[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; }
      }
    }
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    out.regions.push({ id: out.regions.length + 1, box, changedPixels: count, density: count / (box.w * box.h) });
    total += count; largest = Math.max(largest, count);
    gx = Math.min(gx, x0); gy = Math.min(gy, y0); gr = Math.max(gr, x1); gb = Math.max(gb, y1);
  }
  out.status = 'ok'; Object.assign(out.metrics, { changedPixels: total, componentCount: out.regions.length,
    changedFraction: total / N, concentration: total ? total / ((gr - gx) * (gb - gy)) : 0,
    largestComponentShare: total ? largest / total : 0 });
  out.truncation = { complete: true, reason: null, processedPixels: N,
    changedPixelsLowerBound: total, componentsLowerBound: out.regions.length };
  return out;
}

// Match the viewer max-RGB policy, or explicitly request Pillow's RGB->L policy.
// Neither changes approval/baseline state or interprets alpha as a colour delta.
export function comparePixels(current, baseline, options = {}) {
  const s = settings(options);
  for (const input of [current, baseline]) if (input?.status && input.status !== 'ok')
    return fail(s, 'upstream_evidence_incomplete', statuses.has(input.status) ? input.status : 'unsupported');
  if (!dimensions(current) || !dimensions(baseline) || !s) return fail(s, 'invalid_dimensions_or_options');
  if (current.width !== baseline.width || current.height !== baseline.height) return fail(s, 'dimension_mismatch_incomparable');
  const bad = preflight(current, s, 8, 40); if (bad) return bad;
  if (!['canvas-rgb-max', 'pillow-rgb-luma'].includes(s.policy)) return fail(s, 'unsupported_diff_policy');
  const N = current.width * current.height;
  if (!byteArray(current.data) || !byteArray(baseline.data) || current.data.length !== N * 4 || baseline.data.length !== N * 4)
    return fail(s, 'invalid_rgba');
  if (N * 4 > s.limits.operations || !s.limits.timeMs) return fail(s, 'operation_or_time_budget', 'budget_exceeded');
  const mask = new Uint8Array(N), start = Date.now();
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    if (p % 1024 === 0 && Date.now() - start > s.limits.timeMs) return fail(s, 'time_budget', 'budget_exceeded');
    const d = delta(current.data, baseline.data, i, s.policy);
    mask[p] = d > s.threshold ? 1 : 0;
  }
  const out = groupMask({ ...current, data: mask }, { ...options,
    limits: { ...s.limits, operations: s.limits.operations - N * 4, timeMs: Math.max(0, s.limits.timeMs - (Date.now() - start)) } });
  out.metrics.operations += N * 4; out.limits = s.limits;
  return out;
}

// Static PNG/JPEG dimensions before browser decoding. Unsupported formats are
// explicit unknown evidence; animated PNG is excluded from this static policy.
function encodedDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) {
    if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR' || bytes[24] !== 8) return null;
    for (let i = 8; i + 12 <= bytes.length;) {
      const length = view.getUint32(i);
      if (length > bytes.length - i - 12) return null;
      if (String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === 'acTL') return null;
      i += length + 12;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 4 < bytes.length;) {
      if (bytes[i++] !== 255) return null;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (i + 2 > bytes.length) return null;
      if (marker === 217 || marker === 218) return null;
      const length = view.getUint16(i);
      if (length < 2 || i + length > bytes.length) return null;
      if ([192,193,194].includes(marker) && length >= 8 && bytes[i + 2] === 8)
        return { width: view.getUint16(i + 5), height: view.getUint16(i + 3) };
      i += length;
    }
  }
  return null;
}
async function boundedImage(url, s, controller, current) {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin) throw Object.assign(new Error('same_origin_image_required'), { status: 'unsupported' });
  const signal = controller.signal;
  const check = () => {
    signal.throwIfAborted();
    if (!current()) throw new DOMException('region_work_cancelled', 'AbortError');
  };
  check();
  let objectUrl, image, reader, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const timer = setTimeout(() => controller.abort(), s.limits.timeMs);
  const revoke = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } };
  const onAbort = () => {
    clearTimeout(timer);
    if (image) image.src = ''; // Stop a pending decode as well as the fetch.
    try { if (reader) void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    revoke();
    rejectAbort(signal.reason || new DOMException('region_work_cancelled', 'AbortError'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const wait = promise => Promise.race([promise, aborted]);
  try {
    const response = await wait(fetch(target, { signal, redirect: 'error' })); check();
    const refuse = error => {
      // Release unread transport work before dropping its deadline/owner.
      controller.abort();
      try { void Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
      throw error; // Preserve the refusal diagnostic for a live view.
    };
    if (!response.ok || !response.body) refuse(new Error('image_fetch_failed'));
    if (Number(response.headers.get('content-length')) > s.limits.inputBytes) refuse(Object.assign(new Error('encoded_byte_budget'), { status: 'budget_exceeded' }));
    reader = response.body.getReader(); const chunks = []; let total = 0;
    while (true) {
      const { done, value } = await wait(reader.read()); check(); if (done) break;
      total += value.byteLength;
      if (total > s.limits.inputBytes || total * 2 > s.limits.workingBytes) {
        await wait(reader.cancel()); check(); throw Object.assign(new Error('encoded_byte_budget'), { status: 'budget_exceeded' });
      }
      if (chunks.length >= 1024 || total > s.limits.operations) {
        await wait(reader.cancel()); check(); throw Object.assign(new Error('encoded_operation_budget'), { status: 'budget_exceeded' });
      }
      chunks.push(value);
    }
    check();
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const dims = encodedDimensions(bytes);
    if (!dims) throw Object.assign(new Error('unsupported_static_image_encoding'), { status: 'unsupported' });
    if (total * 3 + dims.width * dims.height * 40 > s.limits.workingBytes)
      throw Object.assign(new Error('working_byte_budget'), { status: 'budget_exceeded' });
    const bad = preflight(dims, s, 4, 40);
    if (bad) throw Object.assign(new Error(bad.diagnostics[0].code), { status: bad.status });
    check(); objectUrl = URL.createObjectURL(new Blob([bytes]));
    image = new Image(); image.src = objectUrl;
    await wait(image.decode()); check();
    return image;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort); revoke();
    try { reader?.releaseLock(); } catch {} // A non-cooperative test/decoder may still hold a read.
  }
}

function cancelRegionWork(view, disposed = false) {
  view.regionGeneration = (view.regionGeneration || 0) + 1;
  if (disposed) view.regionDisposed = true;
  view.regionController?.abort(); view.regionController = null;
  view.regionPanel?.remove();
  view.regionPanel = view.regionAnalysis = view.regionFocus = view.diffCv = view.ov = null;
}

export function focusRegion(view, analysis, region) {
  if (view.regionDisposed || (view.regionGeneration != null && view.regionAnalysis !== analysis) || !analysis?.truncation?.complete || analysis.status !== 'ok' || !analysis.regions.includes(region)) return null;
  const { width, height } = analysis.dimensions, b = region.box;
  const rect = { type: 'rect', x: b.x / width, y: b.y / height, w: b.w / width, h: b.h / height };
  // zoomTo takes asset-normalized coordinates, independent of pane letterboxing.
  // Avoid select/onDone/focusNote: those compose or persist a reviewer note.
  view.zoomTo([rect.x, rect.y, rect.w, rect.h]); return rect;
}
function regionPanel(view, out, current) {
  if (!current()) return;
  view.regionPanel?.remove();
  const panel = document.createElement('div'); panel.className = 'image-regions';
  panel.setAttribute('aria-label', 'Changed image regions');
  Object.assign(panel.style, { position: 'absolute', top: '32px', right: '8px', maxHeight: '35%',
    maxWidth: '260px', overflow: 'auto', zIndex: '5', background: 'var(--bg, #181b20)', padding: '6px' });
  const label = document.createElement('div'); label.setAttribute('role', 'status');
  label.textContent = out.status === 'ok' ? `${out.metrics.changedPixels} changed pixels · ${out.regions.length} regions · concentration ${out.metrics.concentration.toFixed(3)}` :
    `Regions: ${out.status} (${out.diagnostics[0]?.code || 'incomplete'})`;
  label.title = `Threshold > ${out.assumptions.threshold}; ${out.assumptions.connectivity}-connected; morphology: none. Concentration = changed pixels / enclosing rectangle area.`;
  panel.append(label);
  if (out.status === 'ok') for (const region of out.regions) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tool sm';
    button.textContent = `Region ${region.id} · ${region.changedPixels} px · density ${region.density.toFixed(3)}`;
    button.onclick = () => { if (current() && view.regionAnalysis === out) view.regionFocus = focusRegion(view, out, region); }; panel.append(button);
  }
  if (current()) { view.pane.append(panel); view.regionPanel = panel; }
}

export function installImageRegions(ImageView) {
  const original = ImageView.prototype.loadOverlay, destroy = ImageView.prototype.destroy;
  ImageView.prototype.loadOverlay = async function (ov) {
    if (this.regionDisposed) return;
    cancelRegionWork(this); // Replacing an overlay cancels its previous job, including wipe/PDF delegation.
    // PDF and wipe behavior stays with the existing viewer.
    if (ov.mode !== 'diff' || this.file.media !== 'image') return original.call(this, ov);
    const options = ov.regionOptions || {}, s = settings(options), started = Date.now();
    const generation = this.regionGeneration, controller = this.regionController = new AbortController();
    const current = () => !this.regionDisposed && this.regionGeneration === generation;
    let out = preflight(this.img, s, 8, 40);
    if (!out && (this.img.width * this.img.height * 20 > s.limits.operations || !s.limits.timeMs))
      out = fail(s, 'operation_or_time_budget', 'budget_exceeded');
    try {
      if (!out && ov.regionMask) {
        // Explicit fixture/cross-card evidence; never rescale coordinates.
        if (ov.regionMask.width !== this.img.width || ov.regionMask.height !== this.img.height)
          out = fail(s, 'dimension_mismatch_incomparable');
        else out = groupMask(ov.regionMask, options);
      } else if (!out) {
        const baseline = await boundedImage(ov.url, s, controller, current);
        if (!current()) return;
        this.ov = baseline; this.wipe = .5;
        if (this.img.width !== this.ov.width || this.img.height !== this.ov.height) out = fail(s, 'dimension_mismatch_incomparable');
        else {
          if (!current()) return;
          const W = this.img.width, H = this.img.height;
          const canvas = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
          const a = canvas(), b = canvas(), ga = a.getContext('2d', { willReadFrequently: true }), gb = b.getContext('2d', { willReadFrequently: true });
          ga.drawImage(this.img, 0, 0); gb.drawImage(this.ov, 0, 0);
          const A = ga.getImageData(0, 0, W, H), B = gb.getImageData(0, 0, W, H);
          if (!current()) return;
          out = comparePixels({ width: W, height: H, data: A.data }, { width: W, height: H, data: B.data },
            { ...options, limits: { ...s.limits, operations: s.limits.operations - W * H * 8,
              timeMs: Math.max(0, s.limits.timeMs - (Date.now() - started)) } });
          out.limits = s.limits;
          if (out.status === 'ok') {
            const O = ga.createImageData(W, H);
            for (let i = 0; i < A.data.length; i += 4) {
              if (i % 4096 === 0 && Date.now() - started > s.limits.timeMs)
                throw Object.assign(new Error('display_time_budget'), { status: 'budget_exceeded' });
              const d = delta(A.data, B.data, i, s.policy);
              const l = (A.data[i] * .3 + A.data[i + 1] * .59 + A.data[i + 2] * .11) * .35, k = d > s.threshold ? Math.min(1, d / 80) : 0;
              O.data[i] = l + (217 - l) * k; O.data[i + 1] = l + (174 - l) * k; O.data[i + 2] = l + (82 - l) * k; O.data[i + 3] = 255;
            }
            out.metrics.operations += W * H * 8;
            ga.putImageData(O, 0, 0); this.diffCv = a; this.diffPct = 100 * out.metrics.changedFraction;
          }
        }
      }
    } catch (error) {
      if (!current()) return;
      out = fail(s, error.message, error.status || (error.name === 'AbortError' ? 'budget_exceeded' : 'not_checked'));
    } finally { if (this.regionController === controller) this.regionController = null; }
    if (!current()) return;
    this.regionAnalysis = out; regionPanel(this, out, current);
  };
  ImageView.prototype.destroy = function () {
    if (this.regionDisposed) return;
    cancelRegionWork(this, true); return destroy.call(this);
  };
}
