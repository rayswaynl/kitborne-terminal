// Existing ink replay only. Creation, selector formats and crops remain owned by the viewer.
import { createPresentationClock } from './video-timestamps.js';

const finite = Number.isFinite;
const vector = (a, n) => Array.isArray(a) && a.length === n && a.every(finite);
const near = (a, b, tolerance = 1e-3) => finite(a) && finite(b) && Math.abs(a - b) <= tolerance;
const hash = h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
const answer = (visible, status, reason) => ({ visible, status, reason,
  label: reason === 'legacy-anchor' ? 'Compatibility: saved ink anchor incomplete; ink hidden' :
    `Ink ${status}: ${reason}${visible ? '' : '; hidden'}` });

export function hasInk(note) {
  const s = note?.target?.selector;
  return !!s && (s.type === 'stroke' || s.type === 'sketch' || (s.type === 'time' && Object.hasOwn(s, 'stroke')));
}

export function validInkPoints(points) {
  return Array.isArray(points) && points.length >= 2 && points.length <= 400 &&
    points.every(p => vector(p, 2) && p.every(x => x >= 0 && x <= 1));
}

// Hashing needs contiguous bytes; bound both retained data and per-chunk overhead.
export const INK_MEDIA_LIMITS = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxChunks: 4096, timeoutMs: 15000 });
const sourceError = message => new Error('Ink source ' + message);
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
const cancelBody = (body, reason) => { try { void Promise.resolve(body?.cancel(reason)).catch(() => {}); } catch { /* already closed */ } };
async function boundedSource(url, signal, limits) {
  const response = await abortable(fetch(url, { cache: 'no-store', signal }).then(response => {
    if (signal.aborted) { cancelBody(response.body, signal.reason); signal.throwIfAborted(); }
    return response;
  }), signal);
  signal.throwIfAborted();
  const length = response.headers.get('content-length');
  if (!response.ok || (length != null && (!/^\d+$/.test(length) || !Number.isSafeInteger(+length) || +length > limits.maxBytes))) {
    cancelBody(response.body, 'unsupported response');
    throw sourceError(response.ok ? 'byte budget exceeded' : `HTTP ${response.status}`);
  }
  if (!response.body?.getReader) { cancelBody(response.body, 'stream unavailable'); throw sourceError('bounded stream unavailable'); }
  const reader = response.body.getReader(), chunks = []; let size = 0, count = 0, cancelled = false;
  const cancel = () => { if (!cancelled) { cancelled = true; cancelBody(reader, signal.reason); } };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array) || ++count > limits.maxChunks || value.byteLength > limits.maxBytes - size)
        throw sourceError('byte or chunk budget exceeded');
      size += value.byteLength; chunks.push(value.slice());
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, type: response.headers.get('content-type') || '' };
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); try { reader.releaseLock(); } catch { /* cancelled pending read */ } }
}

function revokeSource(view) {
  const url = view.inkBlobUrl; view.inkBlobUrl = null;
  if (url) URL.revokeObjectURL(url);
}

// Inputs are snapshots, never note mutations. Unknown evidence cannot authorize replay.
// restore checks the destination's identity and anchor completeness before changing its view.
export function inkEvidence(note, current, restore = false) {
  if (!hasInk(note)) return answer(true, 'measured', 'no-ink');
  const s = note.target.selector, v = note.view, a = v?.asset, c = current || {};
  if (!validInkPoints(s.type === 'time' ? s.stroke : s.points)) return answer(false, 'incomplete', 'malformed-points');
  if (!a || !hash(a.hash) || typeof a.id !== 'string' || !a.id || typeof a.stage !== 'string' || !a.stage ||
      !Number.isSafeInteger(a.version) || a.version < 1 || !note.target.file ||
      (c.project != null && !Object.hasOwn(a, 'project')))
    return answer(false, 'incomplete', 'legacy-anchor');
  if (!hash(c.hash)) return answer(false, 'unavailable', 'file-bytes');
  if (c.id == null || c.stage == null || c.version == null || !c.file) return answer(false, 'unavailable', 'view-context');
  if (a.hash !== c.hash) return answer(false, 'measured', 'changed-file-hash');
  if (a.id !== c.id || a.stage !== c.stage || a.version !== c.version || note.target.file !== c.file ||
      (a.project ?? null) !== (c.project ?? null)) return answer(false, 'measured', 'wrong-context');
  const page = note.target.page ?? v.pdfPage;
  if (page != null && (!Number.isSafeInteger(page) || page < 1)) return answer(false, 'incomplete', 'page-anchor');
  if (page != null && !(c.pages || [c.page]).includes(page)) return answer(false, 'measured', 'wrong-page');
  if (c.pending && !restore) return answer(false, 'unavailable', 'view-pending');

  if (s.type === 'sketch') {
    const saved = v.camera, camera = c.camera;
    const cameraValid = x => x && vector(x.position, 3) && vector(x.target, 3) &&
      ['perspective', 'orthographic'].includes(x.projection) && finite(x.fov) && x.fov > 0 &&
      finite(x.zoom) && x.zoom > 0 && (x.projection !== 'orthographic' || (finite(x.orthoHeight) && x.orthoHeight > 0));
    if (!cameraValid(saved) || !finite(v.rotation)) return answer(false, 'incomplete', 'legacy-anchor');
    if (!cameraValid(camera)) return answer(false, 'unavailable', 'camera');
    const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
    const tolerance = finite(c.radius) && c.radius > 0 ? c.radius * 0.03 : 0;
    if (!restore && (saved.projection !== camera.projection ||
        distance(saved.position, camera.position) > tolerance || distance(saved.target, camera.target) > tolerance ||
        !near(saved.fov, camera.fov) || !near(saved.zoom, camera.zoom) ||
        (saved.projection === 'orthographic' && !near(saved.orthoHeight, camera.orthoHeight)) || !near(v.rotation, c.rotation)))
      return answer(false, 'measured', 'camera-or-projection');
    if (c.animated || v.time != null || s.frame != null) {
      if (!finite(v.time) || v.time < 0 || v.clip == null) return answer(false, 'incomplete', 'legacy-anchor');
      if (!restore && (!near(v.time, c.time) || v.clip !== c.clip ||
          (s.frame != null && s.frame !== c.frame))) return answer(false, 'measured', 'animation-frame');
    }
    return answer(true, 'approximate', 'camera-within-existing-tolerance');
  }

  if (s.type === 'time') {
    const clock = c.clock;
    if (!restore && finite(c.presentedTime)) {
      const shown = clock?.resolve?.(c.presentedTime), requested = clock?.resolve?.(c.time);
      if (clock ? !shown || !requested || shown.decoded_index !== requested.decoded_index : !near(c.presentedTime, c.time))
        return answer(false, 'unavailable', 'presentation-pending');
    }
    if (s.video_anchor || clock) {
      if (clock?.status !== 'ok') return answer(false, 'unavailable', 'presentation-identity');
      // A supplied table takes precedence over average FPS, even for old at-only notes.
      if (!s.video_anchor && (!finite(s.at) || s.at < 0)) return answer(false, 'incomplete', 'legacy-anchor');
      const saved = clock.seek(s), now = clock.resolve(c.presentedTime ?? c.time);
      if (!saved) return answer(false, 'incomplete', 'presentation-anchor');
      if (saved.source_hash !== c.hash) return answer(false, 'unavailable', 'presentation-source-bytes');
      return answer(restore || !!now && now.decoded_index === saved.decoded_index && now.pts === saved.pts,
        'measured', 'decoded-presentation-frame');
    }
    if (finite(s.at) && s.at >= 0) return answer(restore || near(s.at, c.time), 'approximate', 'saved-media-time');
    if (Number.isSafeInteger(s.frame) && s.frame >= 0 && finite(s.fps) && s.fps > 0 && s.fps <= 1000)
      return answer(restore || near(s.frame / s.fps, c.time), 'approximate', 'saved-frame-rate');
    return answer(false, 'incomplete', 'legacy-anchor');
  }
  return answer(true, 'measured', 'normalized-source-points');
}

export function installInkAnchors({ ImageView, VideoView, ModelView, Layer2D }, { project = null, el, toast, mediaLimits = INK_MEDIA_LIMITS } = {}) {
  if (!['maxBytes', 'maxChunks', 'timeoutMs'].every(k => Number.isSafeInteger(mediaLimits[k]) && mediaLimits[k] > 0 && mediaLimits[k] <= INK_MEDIA_LIMITS[k]))
    throw sourceError('invalid limits');
  mediaLimits = Object.freeze({ maxBytes: mediaLimits.maxBytes, maxChunks: mediaLimits.maxChunks, timeoutMs: mediaLimits.timeoutMs });
  const owners = new WeakMap();
  const contextOf = view => {
    if (!view.inkContext) {
      const url = new URL(view.inkSourceUrl || view.url, globalThis.location?.href || 'http://localhost/');
      const m = url.pathname.match(/^\/data\/([^/]+)\/([^/]+)\/v(\d+)\//);
      view.inkContext = m ? { id: decodeURIComponent(m[1]), stage: decodeURIComponent(m[2]), version: +m[3], project } : {};
    }
    return view.inkContext;
  };
  const snapshot = view => ({ ...contextOf(view), file: view.file.name, hash: view.assetHash || view.inkHash,
    ...(view instanceof ModelView ? { ...view.viewState(),
      rotation: view.root.rotation.y, animated: !!view.mixer, radius: view.radius } : {}),
    time: view.v?.currentTime ?? view.time, frame: view instanceof ModelView && view.mixer ? Math.round(view.time * view.fps) : undefined,
    clock: Object.hasOwn(view.file, 'presentation_timing') ? (view.presentationClock || createPresentationClock(view.file)) : null,
    presentedTime: view.inkPresentedTime, pending: view.inkRestoring || view.v?.seeking || view.dead || view.inkDisposed,
    page: view.pdfPage, pages: view.frames?.map(p => p.n) });
  function state(view, note, restore = false) { return inkEvidence(note, snapshot(view), restore); }
  function attach(view) {
    const layer = view.sketch || view.layer;
    if (layer) owners.set(layer, view);
  }
  function label(view, states) {
    view.inkReplay = states;
    if (!el || !view.pane || !states.length) { if (view.inkLabel) view.inkLabel.hidden = true; return; }
    view.inkLabel ||= view.pane.appendChild(el('span', { class: 'tag', role: 'status', 'aria-live': 'polite' }));
    view.inkLabel.hidden = false;
    const text = [...new Set(states.map(x => x.label))].join(' · ');
    if (view.inkLabel.textContent !== text) view.inkLabel.textContent = text;
  }
  const draw = Layer2D.prototype.draw;
  Layer2D.prototype.draw = function (...args) {
    const view = owners.get(this);
    if (!view) return draw.apply(this, args);
    const notes = this.notes, visible = this.visible, ghost = this.ghostSel, states = [];
    // Filter before shapeOf: malformed ink must never reach canvas code.
    this.notes = notes.filter(n => { if (!hasInk(n)) return true; const result = state(view, n); states.push(result); return result.visible; });
    this.visible = n => hasInk(n) || visible.call(this, n);
    if (view.inkGhost && !state(view, view.inkGhost).visible) this.ghostSel = null;
    try { label(view, states); return draw.apply(this, args); }
    finally { this.notes = notes; this.visible = visible; this.ghostSel = ghost; }
  };
  for (const Cls of [ImageView, VideoView, ModelView]) {
    const p = Cls.prototype;
    const original = Object.fromEntries(['load', 'viewState', 'marks', 'focus', 'capture', 'ghost', 'destroy'].map(k => [k, p[k]]));
    p.load = async function (...args) {
      if (this.inkDisposed) return;
      contextOf(this);
      // Decode and hash the SAME fetched bytes. Catalog hashes alone cannot detect replaced files.
      // PDF's generated pages and LiveView have their own loading contracts; missing byte anchors stay labelled.
      if (this.constructor === ImageView || this.constructor === VideoView) {
        this.inkLoadAbort?.abort(sourceError('load replaced'));
        const controller = this.inkLoadAbort = new AbortController(), signal = controller.signal;
        const deadline = setTimeout(() => controller.abort(sourceError('load deadline exceeded')), mediaLimits.timeoutMs);
        this.inkSourceUrl ||= this.url; this.inkHash = undefined; this.inkVerificationError = null;
        try {
          const { bytes, type } = await boundedSource(this.inkSourceUrl, signal, mediaLimits);
          signal.throwIfAborted();
          const digest = await abortable(crypto.subtle.digest('SHA-256', bytes), signal);
          signal.throwIfAborted();
          // The browser decodes only these checked bytes, never a second fetch of the URL.
          const url = URL.createObjectURL(new Blob([bytes], { type }));
          if (this.inkDisposed || signal.aborted) { URL.revokeObjectURL(url); signal.throwIfAborted(); throw sourceError('view disposed'); }
          revokeSource(this); this.url = this.inkBlobUrl = url;
          this.inkHash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
        } catch (error) {
          if (this.inkDisposed || this.inkLoadAbort !== controller) throw error;
          // Optional replay identity must not block ordinary media viewing.
          revokeSource(this); this.url = this.inkSourceUrl; this.inkHash = undefined;
          this.inkVerificationError = error.message;
        } finally { clearTimeout(deadline); if (this.inkLoadAbort === controller) this.inkLoadAbort = null; }
      }
      try { await original.load.apply(this, args); }
      catch (error) { revokeSource(this); this.inkHash = undefined; throw error; }
      if (this.inkDisposed) { original.destroy.call(this); return; }
      attach(this);
      if (this.v) {
        const clear = () => { this.inkPresentedTime = undefined; this.layer?.draw(); };
        this.v.addEventListener('seeking', clear); this.v.addEventListener('seeked', clear);
        this.inkVideoClear = clear;
        if (this.v.requestVideoFrameCallback) {
          const presented = (_, metadata) => {
            if (this.dead || this.inkDisposed) return;
            this.inkPresentedTime = metadata.mediaTime; this.layer?.draw();
            this.inkVideoCallback = this.v.requestVideoFrameCallback(presented);
          };
          this.inkVideoCallback = this.v.requestVideoFrameCallback(presented);
        }
      }
    };
    p.viewState = function () {
      const v = original.viewState?.call(this) || {}, b = this instanceof ImageView && this.img ? this.box() : null;
      return { ...v, asset: { ...v.asset, ...contextOf(this), hash: this.assetHash || this.inkHash },
        ...(b ? { image: { z: this.z, whole: !!this.whole, offset: [this.ox / b.w, this.oy / b.h] } } : {}) };
    };
    p.marks = function (...args) { attach(this); return original.marks.apply(this, args); };
    p.focus = async function (note, ...args) {
      if (!hasInk(note)) return await original.focus.call(this, note, ...args) !== false;
      const result = state(this, note, true);
      if (!result.visible) {
        (this.sketch || this.layer)?.draw();
        label(this, [result]); toast?.(result.reason === 'changed-file-hash' ? 'The file hash differs from this note. Restore the original file.' : result.label);
        return false;
      }
      this.inkRestoring = true; this.clearSelection?.(); attach(this); (this.sketch || this.layer)?.draw();
      try {
        const image = note.view?.image;
        if (this instanceof ImageView && image && finite(image.z) && image.z > 0 && vector(image.offset, 2)) {
          this.z = image.z; this.whole = !!image.whole; this.ox = this.oy = 0;
          const b = this.box(); this.ox = image.offset[0] * b.w; this.oy = image.offset[1] * b.h; this.changed();
        } else {
          if (this instanceof VideoView && !finite(note.target.selector.at) && !note.target.selector.video_anchor) {
            const s = note.target.selector;
            note = { ...note, target: { ...note.target, selector: { ...s, at: s.frame / s.fps } } };
          }
          if (await original.focus.call(this, note, ...args) === false) return false;
        }
        return true;
      } finally { this.inkRestoring = false; (this.sketch || this.layer)?.draw(); }
    };
    p.capture = async function (note, all = [], ...args) {
      if (hasInk(note)) { if (!await this.focus(note) || !state(this, note).visible) return {}; }
      return original.capture.call(this, note, all.filter(n => !hasInk(n) || state(this, n).visible), ...args);
    };
    if (original.ghost) p.ghost = function (note, ...args) {
      this.inkGhost = hasInk(note) ? note : null;
      if (hasInk(note) && !state(this, note).visible) { if (this.layer) this.layer.ghostSel = null; this.layer?.draw(); return; }
      return original.ghost.call(this, note, ...args);
    };
    p.destroy = function (...args) {
      this.inkDisposed = true; this.inkLoadAbort?.abort(sourceError('view disposed'));
      if (this.inkVideoCallback != null) this.v?.cancelVideoFrameCallback?.(this.inkVideoCallback);
      if (this.inkVideoClear) for (const event of ['seeking', 'seeked']) this.v?.removeEventListener(event, this.inkVideoClear);
      try { return original.destroy.apply(this, args); }
      finally { revokeSource(this); this.inkHash = undefined; this.inkLabel?.remove(); }
    };
  }
  // Orbit events cover camera edits; frame covers animation, spin and projection changes before paint.
  const frame = ModelView.prototype.frame;
  ModelView.prototype.frame = function (...args) { const result = frame.apply(this, args); attach(this); this.sketch?.draw(); return result; };
}
