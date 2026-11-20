// Independent decoded presentation clock. No dependency on R3I-002 or a DOM.
const SCHEMA = 'asset-review/video-timestamps-1';
const MAX_FRAMES = 4096;
const SHA256 = /^[0-9a-f]{64}$/;

export function createPresentationClock(file) {
  const table = file?.presentation_timing;
  const outcome = (status, diagnostic) => ({ schema: 'asset-review/video-clock-1', status,
    metrics: {}, units: { media_time: 's', presentation_time: 's', decoded_index: 'zero-based frame' },
    assumptions: ['media_time = (pts - origin.pts) * time_base; last PTS at or before media time'],
    diagnostics: diagnostic ? [diagnostic] : [] });
  if (!table) return outcome('not_checked', 'presentation table unavailable');
  if (table.status !== 'ok') return outcome(['unsupported', 'not_checked', 'budget_exceeded'].includes(table.status) ? table.status : 'unsupported', 'presentation table unavailable');
  const entries = table.entries;
  if (Array.isArray(entries) && entries.length > MAX_FRAMES) return outcome('budget_exceeded', 'frame budget');
  const tb = table.time_base, origin = table.origin;
  if (table.schema !== SCHEMA || !SHA256.test(table.source_hash) || table.source_hash !== file.source_hash ||
      !Array.isArray(entries) || !entries.length || !tb || !origin ||
      !Number.isSafeInteger(tb.numerator) || !Number.isSafeInteger(tb.denominator) || tb.numerator <= 0 || tb.denominator <= 0 ||
      !Number.isSafeInteger(origin.pts) || origin.media_time !== 0 || !Number.isFinite(origin.presentation_time))
    return outcome('unsupported', 'malformed table or mismatched source identity');
  const unit = tb.numerator / tb.denominator;
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
  if (!close(origin.presentation_time, origin.pts * unit)) return outcome('unsupported', 'invalid origin');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], previous = entries[i - 1];
    if (!e || e.decoded_index !== i || !Number.isSafeInteger(e.pts) || e.pts < origin.pts ||
        !close(e.presentation_time, e.pts * unit) || !close(e.media_time, (e.pts - origin.pts) * unit) ||
        (previous && (e.pts <= previous.pts || e.media_time <= previous.media_time)))
      return outcome('unsupported', 'ambiguous or malformed presentation timestamps');
  }
  // Copy only bounded scalar evidence, so callers cannot invalidate a checked clock.
  const checked = entries.map(e => Object.freeze({ decoded_index: e.decoded_index, pts: e.pts,
    presentation_time: e.presentation_time, media_time: e.media_time, source_hash: table.source_hash }));
  const resolve = t => {
    if (!Number.isFinite(t)) return null;
    let lo = 0, hi = checked.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (checked[mid].media_time <= t) lo = mid + 1; else hi = mid; }
    return checked[Math.max(0, lo - 1)];
  };
  const seek = selector => {
    const anchor = selector.video_anchor;
    if (!anchor) return resolve(selector.at ?? selector.start ?? (selector.frame != null && selector.fps > 0 ? selector.frame / selector.fps : NaN));
    const e = checked[anchor.decoded_index];
    return e && anchor.source_hash === e.source_hash && anchor.pts === e.pts &&
      anchor.presentation_time === e.presentation_time && anchor.media_time === e.media_time ? e : null;
  };
  return { ...outcome('ok'), metrics: { decoded_frames: checked.length }, resolve, seek,
    adjacent(t, delta) { const e = resolve(t); return e && Number.isInteger(delta) ? checked[Math.max(0, Math.min(checked.length - 1, e.decoded_index + delta))] : null; } };
}

// Small VideoView adapter kept here so the shared app has one integration block.
export function installVideoTimestamps(VideoView, { el } = {}) {
  const p = VideoView.prototype;
  const original = Object.fromEntries(['load', 'frame', 'range', 'step', 'timeline', 'syncTl', 'focus', 'seek', 'drawOnion', 'capture', 'info'].map(k => [k, p[k]]));
  function clock(view) {
    if (!Object.hasOwn(view.file, 'presentation_timing')) return null; // untouched legacy catalog
    if (!view.presentationClock) {
      view.presentationClock = createPresentationClock(view.file);
      view.timestampFps = view.fps;
      view.fps = null; // an unavailable table must not invent frame precision from average FPS
    }
    return view.presentationClock;
  }
  p.load = function (...args) { clock(this); return original.load.apply(this, args); };
  p.frame = function () { const c = clock(this); return c ? c.resolve?.(this.v.currentTime)?.decoded_index : original.frame.call(this); };
  p.range = function () {
    const c = clock(this), range = original.range.call(this);
    if (c?.status !== 'ok') return range;
    const a = c.resolve(Math.min(this.inp ?? this.v.currentTime, this.out ?? this.inp ?? this.v.currentTime));
    const b = c.resolve(Math.max(this.inp ?? this.v.currentTime, this.out ?? this.inp ?? this.v.currentTime));
    return { ...range, frame_start: a.decoded_index, frame_end: b.decoded_index,
      ...(this.timestampFps ? { fps: this.timestampFps } : {}),
      video_anchor: { ...c.resolve(this.v.currentTime) }, video_start: { ...a }, video_end: { ...b } };
  };
  p.step = function (delta) {
    if (this.dead) return;
    this.stopShuttle?.(); // optional R3I-002 transport; frame-step takes ownership from reverse
    const c = clock(this);
    if (c?.status !== 'ok') return original.step.call(this, delta);
    this.v.pause();
    this.peer?.v?.pause();
    const e = c.adjacent?.(this.v.currentTime, delta);
    if (e) this.v.currentTime = e.media_time;
    this.layer?.draw(); this.syncTl();
  };
  p.seek = function (t) {
    const c = clock(this);
    if (c?.status === 'ok') t = c.resolve(t)?.media_time;
    if (!Number.isFinite(t)) return Promise.resolve();
    if (c?.status === 'ok') {
      if (this.v.currentTime === t) return Promise.resolve();
      return new Promise(resolve => { this.v.onseeked = resolve; this.v.currentTime = t; });
    }
    return original.seek.call(this, t);
  };
  p.focus = async function (note) {
    const c = clock(this), s = note.target.selector;
    if (!c || !s.video_anchor) return original.focus.call(this, note);
    const entry = c.seek?.(s);
    if (!entry) return; // source changes invalidate precision; never silently rebind an anchor
    this.v.pause(); await this.seek(entry.media_time);
    this.inp = s.start; this.out = s.end; this.syncTl();
  };
  p.capture = function (note, ...args) {
    const c = clock(this), s = note.target.selector;
    if (!c || !s.video_anchor) return original.capture.call(this, note, ...args);
    const entry = c.seek?.(s);
    if (!entry) return Promise.resolve({});
    return original.capture.call(this, { ...note, target: { ...note.target, selector: { ...s, at: entry.media_time } } }, ...args);
  };
  p.timeline = function () {
    const c = clock(this); original.timeline.call(this);
    if (!c || !this.sl) return;
    this.sl.step = 'any';
    this.sl.addEventListener('input', () => {
      const e = c.resolve?.(+this.sl.value);
      if (e) { this.v.currentTime = e.media_time; this.sl.value = e.media_time; }
    });
    if (c.status === 'ok' && el) this.tlw.parentNode.append(el('button', { class: 'tgl', title: 'Show 2 decoded frames before and after',
      onclick: e => { this.onion = !this.onion; e.currentTarget.classList.toggle('on', this.onion); this.drawOnion(); } }, 'Onion skin'));
    this.syncTl();
  };
  p.syncTl = function () {
    const c = clock(this); original.syncTl.call(this);
    if (c?.status === 'ok' && this.lab) {
      const r = this.range();
      this.lab.textContent = 'frame ' + this.frame() + ' / ' + (c.metrics.decoded_frames - 1) +
        (this.inp != null || this.out != null ? '  [' + r.frame_start + '-' + r.frame_end + ']' : '');
    }
  };
  p.info = function () {
    if (!clock(this)) return original.info.call(this);
    return this.file.name + ' · ' + this.v.videoWidth + 'x' + this.v.videoHeight + ' · ' + this.v.duration.toFixed(2) + ' s' +
      (this.timestampFps ? ' @' + this.timestampFps + ' fps' : this.file.fps_source === 'variable' ? ' · variable frame rate' : ' · frame rate unknown');
  };
  p.drawOnion = async function () {
    const c = clock(this);
    if (!c) return original.drawOnion.call(this);
    if (c.status !== 'ok' || !el) return;
    if (!this.oc) { this.oc = el('canvas', { class: 'onion', style: { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' } }); this.pane.insertBefore(this.oc, this.layer.cv); }
    const r = this.pane.getBoundingClientRect(); this.oc.width = r.width; this.oc.height = r.height;
    const g = this.oc.getContext('2d'); g.clearRect(0, 0, r.width, r.height);
    if (!this.onion || !this.v.paused) return;
    if (!this.ghosts) this.ghosts = [0, 1].map(() => { const v = el('video', { src: this.url, muted: '', preload: 'auto' }); v.muted = true; return v; });
    const t = this.v.currentTime, b = this.box();
    for (const [v, delta, tint] of [[this.ghosts[0], -2, '#d4573f'], [this.ghosts[1], 2, '#6f9dcb']]) {
      const tt = c.adjacent(t, delta).media_time;
      if (v.readyState < 2) await new Promise(resolve => { v.onloadeddata = resolve; });
      if (Math.abs(v.currentTime - tt) > 1e-9) await new Promise(resolve => { v.onseeked = resolve; v.currentTime = tt; });
      if (this.dead || Math.abs(this.v.currentTime - t) > 1e-9) return;
      g.globalAlpha = .38; g.drawImage(v, b.x, b.y, b.w, b.h); g.globalAlpha = .16; g.fillStyle = tint; g.fillRect(b.x, b.y, b.w, b.h); g.globalAlpha = 1;
    }
  };
}
