// Small transport adapter for AudioView's existing media, waveform and capture paths.
// Absolute time is shared between versions; it is never evidence of equal content.
export function installAudioReview(AudioView, { context, el, comparing, frame = requestAnimationFrame, cancel = cancelAnimationFrame,
  activated = () => navigator.userActivation?.isActive || (context.state === 'running' && navigator.userActivation?.hasBeenActive) }) {
  const P = AudioView.prototype, original = { extras: P.extras, draw: P.draw, destroy: P.destroy };
  P.audioState = function () {
    return { position: this.now(), playing: !!this.playing, rate: this.rate, region: this.sel && { ...this.sel }, repeat: !!this.repeat, useB: !!this.useB };
  };
  P.bounds = function (position = this.pos) {
    const target = this.useB ? this.peer : this;
    const duration = target?.buf?.duration, sampleRate = target?.buf?.sampleRate;
    const valid = !target?.dead && Number.isFinite(duration) && duration > 0 && Number.isFinite(sampleRate) && sampleRate > 0;
    const start = valid ? Math.max(0, this.sel?.start ?? 0) : 0;
    const end = valid ? Math.min(duration, this.sel?.end ?? duration) : 0;
    const available = valid && Number.isFinite(start) && Number.isFinite(end) && start < end;
    const requested = Number.isFinite(position) ? position : start;
    const time = available ? Math.max(start, Math.min(requested, Math.max(start, end - 1 / sampleRate))) : valid ? Math.max(0, Math.min(requested, duration)) : Math.max(0, requested);
    const clamped = available && (time !== requested || (this.sel && (start !== this.sel.start || end !== this.sel.end)));
    this.reviewState = { version: 1, status: available ? 'ok' : 'unsupported', regionState: available ? clamped ? 'clamped' : 'available' : 'unavailable',
      metrics: { requested, position: time, start, end }, units: { requested: 'seconds', position: 'seconds', start: 'seconds', end: 'seconds' },
      assumptions: ['Absolute time alignment; content equivalence not checked.'], diagnostics: available ? clamped ? ['Range / playback position limited to this version.'] : [] : ['Range not available in this version.'] };
    return { target, start, end, time, available };
  };
  P.restoreAudio = function (state) {
    this.halt(); this.rate = state.rate; this.sel = state.region && { ...state.region }; this.repeat = state.repeat;
    this.useB = state.useB && !!comparing(); this.pos = state.position;
    const bounds = this.bounds();
    if (state.playing && bounds.available) this.playSel(); else { this.pos = bounds.time; if (bounds.available) this.cueVersion(bounds); this.syncBtn(); this.draw(); }
  };
  P.switchVersion = function (useB = !this.useB) {
    if (this.dead) return;
    const position = this.now(), playing = this.playing;
    this.halt(); this.useB = useB; this.pos = position;
    const bounds = this.bounds();
    if (playing && bounds.available) this.playSel(); else { this.pos = bounds.time; if (bounds.available) this.cueVersion(bounds); this.syncBtn(); this.draw(); }
  };
  // Same media-element/Web Audio gain route as AudioView; retain the owned node for disposal.
  P.media = function (view) {
    if (!view.au) {
      view.au = new Audio(view.url); view.au.preload = 'auto'; view.gainN = context.createGain();
      view.sourceN = context.createMediaElementSource(view.au); view.sourceN.connect(view.gainN).connect(context.destination);
    }
    return view.au;
  };
  P.halt = function () {
    this.transportEpoch = (this.transportEpoch || 0) + 1;
    if (this.live) { this.live.onended = null; this.live.pause(); }
    if (this.bed) this.bed.pause();
    this.playing = false;
    if (this.raf != null) cancel(this.raf);
    this.raf = null;
  };
  P.cueVersion = function ({ target, time }) {
    for (const view of [this, this.peer]) view?.au?.pause();
    const audio = this.media(target);
    const db = target !== this && this.lufsAll != null && target.lufsAll != null ? this.lufsAll - target.lufsAll : 0;
    target.gainN.gain.value = Math.pow(10, Math.max(-24, Math.min(24, db)) / 20);
    audio.currentTime = time; audio.playbackRate = this.rate; audio.preservesPitch = true;
    this.live = audio; return audio;
  };
  P.playSel = function () {
    if (this.dead) return;
    this.halt();
    const bounds = this.bounds(); this.pos = bounds.time;
    if (!bounds.available || !activated()) {
      if (bounds.available) { this.reviewState.status = 'not_checked'; this.reviewState.diagnostics = ['Click Play to turn on sound.']; }
      this.syncBtn(); this.draw(); return;
    }
    const { start, end } = bounds, epoch = this.transportEpoch;
    // A comparison pane may own a previously played source. Only the chosen version plays.
    const audio = this.cueVersion(bounds);
    const failed = () => { if (!this.dead && this.transportEpoch === epoch) this.finish(); };
    if (context.state !== 'running') context.resume().catch(failed);
    this.live = audio; this.playing = true;
    audio.onended = () => { if (this.repeat && this.sel) { audio.currentTime = start; audio.play().catch(failed); } else this.finish(); };
    audio.play().catch(failed); this.startBed();
    const tick = () => {
      if (!this.playing || this.dead || this.transportEpoch !== epoch) return;
      this.raf = null;
      if (audio.currentTime >= end) {
        if (this.repeat && this.sel) audio.currentTime = start;
        else return this.finish();
      }
      this.draw(); this.raf = frame(tick);
    };
    tick(); this.syncBtn();
  };
  P.seek = function (time) {
    const playing = this.playing; this.halt(); this.pos = time;
    if (playing) this.playSel(); else { this.pos = this.bounds().time; this.syncBtn(); this.draw(); }
  };
  P.extras = function () {
    const controls = original.extras.call(this).filter(node => !node.textContent.startsWith('A/B'));
    if (this.peer || comparing()) controls.push(el('button', { class: 'tool', 'aria-pressed': String(this.useB),
      title: 'Swap version at absolute time, equal loudness (LUFS). Content not checked.', onclick: event => {
        this.switchVersion(); event.currentTarget.setAttribute('aria-pressed', String(this.useB));
      } }, 'A/B', el('span', { class: 'lbl' }, 'version, equal loudness')));
    controls.push(el('button', { class: 'tool', 'aria-pressed': String(!!this.repeat), disabled: !this.sel,
      title: 'Repeat the selected range', onclick: event => { this.repeat = !this.repeat; event.currentTarget.setAttribute('aria-pressed', String(this.repeat)); } }, 'Repeat range'));
    return controls;
  };
  P.draw = function () {
    if (this.dead) return;
    original.draw.call(this);
    if (this.reviewState?.diagnostics.length) this.infoEl.textContent += ' · ' + this.reviewState.diagnostics.join(' ');
  };
  P.destroy = function () {
    this.dead = true; original.destroy.call(this);
    this.sourceN?.disconnect(); this.gainN?.disconnect(); this.sourceN = this.gainN = null;
    if (this.cv) this.cv.onpointerdown = this.cv.onpointermove = this.cv.onpointerup = this.cv.onpointercancel = null;
    if (this.bed) { this.bed.pause(); this.bed.removeAttribute('src'); this.bed.load(); this.bed = null; }
    this.live = null; this.peer = null;
  };
}
