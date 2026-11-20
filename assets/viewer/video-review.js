// Video transport extension. Saved selector restoration remains owned by VideoView.focus.
export function videoRate(value, source) {
  if (source === 'variable') return null;
  const parts = typeof value === 'string' ? value.split('/') : [];
  const rate = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(value);
  return Number.isFinite(rate) && rate > 0 && rate <= 1000 ? rate : null;
}

export function timecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const ms = Math.round(seconds * 1000), whole = Math.floor(ms / 1000);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}.${pad(ms % 1000, 3)}`;
}

function rateLabel(fps) {
  return Math.abs(fps - 30000 / 1001) < 1e-8 ? '30000/1001 fps · non-drop-frame' : `${fps} fps`;
}

export function lastFrame(duration, fps) {
  return Math.max(0, Math.ceil(duration * fps - 1e-8) - 1);
}

export function installVideoReview(VideoView, { el, $, active, schedule = globalThis }) {
  const p = VideoView.prototype;
  const original = Object.fromEntries(['load', 'timeline', 'syncTl', 'focus', 'capture', 'destroy'].map(k => [k, p[k]]));
  function timing(view) {
    view.fps = videoRate(Object.hasOwn(view.file, 'fps') ? view.file.fps : view.fps, view.file.fps_source);
  }
  function limit(view) {
    const duration = Number.isFinite(view.v.duration) ? Math.max(0, view.v.duration) : 0;
    return view.fps ? lastFrame(duration, view.fps) / view.fps : duration;
  }
  function setTime(view, time) {
    view.v.currentTime = Math.max(0, Math.min(limit(view), time));
    if (view.peer?.v) view.peer.v.currentTime = view.v.currentTime;
    view.layer?.draw(); view.syncTl();
  }
  function pause(view) {
    view.stopShuttle(); view.v.pause(); view.peer?.v?.pause(); view.syncTl();
  }
  function validRange(view, s) {
    return s?.type === 'time' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.end <= view.v.duration;
  }
  function label(view, time) {
    return `${timecode(time)} · ${time.toFixed(2)} s` + (view.fps ? ` · frame ${Math.min(lastFrame(view.v.duration, view.fps), Math.round(time * view.fps))}` : '');
  }
  p.stopShuttle = function () {
    if (this.shuttle != null) schedule.clearInterval(this.shuttle);
    this.shuttle = null; this.transport = 'pause';
    this.transportEpoch = (this.transportEpoch || 0) + 1;
  };
  p.shuttleTransport = function (direction) {
    if (this.dead) return;
    pause(this);
    if (!direction) return;
    this.transport = direction < 0 ? 'reverse' : 'forward';
    if (direction > 0) {
      if (this.v.currentTime >= limit(this)) { pause(this); return; }
      // HTMLMediaElement negative playbackRate is deliberately never used.
      const epoch = this.transportEpoch;
      this.v.play().catch(() => { if (!this.dead && this.transportEpoch === epoch) pause(this); });
      this.peer?.v?.play().catch(() => {});
    } else {
      const dt = this.fps ? 1 / this.fps : 0.1;
      if (this.v.currentTime <= 0) { pause(this); return; }
      const epoch = this.transportEpoch;
      this.shuttle = schedule.setInterval(() => {
        if (this.dead || this.transportEpoch !== epoch) return;
        const next = this.fps ? (Math.round(this.v.currentTime * this.fps) - 1) / this.fps : this.v.currentTime - dt;
        setTime(this, next);
        if (this.v.currentTime <= 0) pause(this);
      }, Math.max(16, dt * 1000));
    }
    this.syncTl();
  };
  p.step = function (direction) {
    if (this.dead) return;
    pause(this);
    const next = this.fps ? (Math.round(this.v.currentTime * this.fps) + direction) / this.fps : this.v.currentTime + direction * 0.1;
    setTime(this, next);
  };
  p.activateNoteRange = async function () {
    if (this.dead || !validRange(this, this.noteRange)) return false;
    // Use the existing restoration contract, including any R3C-041 extension.
    await this.focus(this.rangeNote);
    if (this.dead) return false;
    this.loop = true; setTime(this, this.inp);
    this.shuttleTransport(1); this.syncTl(); return true;
  };
  p.checkTransportBoundary = function () {
    if (this.dead || this.v.paused) return;
    const r = this.range();
    if (this.loop && r.end > r.start && (this.v.currentTime >= r.end || this.v.currentTime < r.start - 0.05)) setTime(this, r.start);
    else if (this.v.currentTime >= limit(this)) { setTime(this, limit(this)); pause(this); }
  };
  p.load = async function () {
    timing(this); await original.load.call(this);
    if (this.dead) return;
    const update = this.v.ontimeupdate;
    this.v.ontimeupdate = e => { this.checkTransportBoundary(); update?.(e); };
  };
  p.timeline = function () {
    timing(this); original.timeline.call(this);
    this.play.replaceWith(this.play = el('button', { title: 'Play / pause (K/L)', onclick: () => this.v.paused && this.transport !== 'reverse' ? this.shuttleTransport(1) : pause(this) }, '▶'));
    this.noteLoop = el('button', { disabled: !validRange(this, this.noteRange), title: 'Activate the range of the selected note and repeat', onclick: () => this.activateNoteRange() }, 'Repeat note');
    const tl = $('#timeline');
    this.loopButton = tl.querySelector('button.tgl');
    tl.append(el('button', { title: 'Rewind (J)', onclick: () => this.shuttleTransport(-1) }, 'J ◀'), el('button', { title: 'Pause (K)', onclick: () => pause(this) }, 'K ❚❚'), el('button', { title: 'Forward (L)', onclick: () => this.shuttleTransport(1) }, 'L ▶'), this.noteLoop);
    // Existing drawing / note buttons pause media directly; cancel reverse there too.
    this.pauseOnClick = e => { if (e.target.closest('button.addnote')) pause(this); };
    tl.addEventListener('click', this.pauseOnClick);
    this.pauseOnDraw = () => pause(this);
    this.layer.cv.addEventListener('pointerdown', this.pauseOnDraw);
    this.pauseOnScrub = () => pause(this);
    this.sl.addEventListener('input', this.pauseOnScrub);
    this.syncTl();
  };
  p.syncTl = function () {
    original.syncTl.call(this);
    if (!this.lab) return;
    const r = this.range();
    this.lab.textContent = `${label(this, this.v.currentTime)} / ${timecode(this.v.duration)}` + (this.fps ? ` · ${rateLabel(this.fps)}` : '') + (this.inp != null || this.out != null ? ` · In ${label(this, r.start)} → Out ${label(this, r.end)}` : '');
    this.play.textContent = this.transport === 'reverse' ? '◀' : this.v.paused ? '▶' : '❚❚';
    if (this.noteLoop) this.noteLoop.disabled = !validRange(this, this.noteRange);
    if (this.loopButton) { this.loopButton.classList.toggle('on', !!this.loop); this.loopButton.setAttribute('aria-pressed', String(!!this.loop)); }
  };
  p.focus = async function (note) {
    if (this.dead) return;
    pause(this); this.loop = false; this.noteRange = null; this.rangeNote = null;
    await original.focus.call(this, note);
    if (this.dead) return;
    const s = note.target.selector;
    if (validRange(this, s)) { this.noteRange = { type: 'time', start: s.start, end: s.end }; this.rangeNote = note; }
    this.syncTl();
  };
  p.capture = async function (...args) { pause(this); return original.capture.apply(this, args); };
  p.destroy = function () {
    this.stopShuttle();
    if (this.raf != null) {
      if (this.v?.cancelVideoFrameCallback) this.v.cancelVideoFrameCallback(this.raf);
      else schedule.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.pauseOnClick) $('#timeline').removeEventListener('click', this.pauseOnClick);
    this.layer?.cv?.removeEventListener('pointerdown', this.pauseOnDraw);
    this.sl?.removeEventListener('input', this.pauseOnScrub);
    if (this.v) this.v.ontimeupdate = null;
    this.ghosts?.forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
    original.destroy.call(this);
  };
  // Delegated through the existing app listener: no view-specific global listener survives teardown.
  return function videoKey(e) {
    const view = active(), key = e.key.toLowerCase();
    if (!(view instanceof VideoView) || view.dead || !['j', 'k', 'l', ',', '.'].includes(key)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || e.target?.isContentEditable || document.querySelector('dialog[open]')) return true;
    e.preventDefault();
    if (key === ',' || key === '.') view.stepFrame(key === '.' ? 1 : -1);
    else view.shuttleTransport(key === 'j' ? -1 : key === 'l' ? 1 : 0);
    return true;
  };
}
