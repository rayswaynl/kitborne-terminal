// Display only: A is the comparison source, B remains the reviewed version.
export function makeAbFlip({ get, bar, container, el, storage, blocked = () => false }) {
  const initial = get(), primary = initial.primary, peer = initial.peer;
  const scope = initial.scope;
  const key = scope.every(value => typeof value === 'string' && value.length) ?
    'ar.ab-flip.v1.' + JSON.stringify(scope) : null;
  let display = 'side', dead = false, saved = null, button, labels;
  const tags = [primary?.pane, peer?.pane].map(pane => pane?.querySelector('.tag')).filter(Boolean)
    .map(tag => ({ tag, text: tag.textContent }));
  try {
    const pref = key && JSON.parse(storage().getItem(key));
    if (pref?.version === 1 && ['side', 'A', 'B'].includes(pref.display)) display = pref.display;
  } catch { /* A corrupt or denied preference never touches the review draft. */ }
  const available = () => {
    const s = get(), media = primary?.file?.media;
    return !dead && s.compare && !bar.hidden && s.mode === 'side' && s.primary === primary && s.peer === peer &&
      !!s.source && !!primary?.pane && !!peer?.pane && !primary.dead && !peer.dead && !primary.broken && !peer.broken &&
      ['image', 'pdf', 'video', 'model', 'audio'].includes(media) && peer.file?.media === media &&
      (media !== 'model' || (!!primary.root && !!peer.root && !!primary.camera && !!peer.camera)) &&
      (media !== 'audio' || (primary.peer === peer && typeof primary.switchVersion === 'function'));
  };
  const persist = () => {
    try { if (key) storage().setItem(key, JSON.stringify({ version: 1, display })); }
    catch { /* Keep the in-memory choice and every review edit on quota denial. */ }
  };
  function remember() {
    if (saved) return;
    saved = { split: container.classList.contains('split'), moved: primary.userMoved,
      panes: [primary.pane, peer.pane].map(pane => ({ pane, style: pane.style.cssText,
        inert: pane.inert, aria: pane.getAttribute('aria-hidden') })) };
    // ModelView.resize normally fits an untouched camera. This layout change must not refit it.
    if (primary.camera) primary.userMoved = true;
    container.classList.remove('split');
    for (const { pane } of saved.panes) { pane.style.inset = '0'; pane.style.border = '0'; }
    // Both panes keep identical dimensions while flipping; hiding never resizes a camera.
    primary.resize?.();
  }
  function restore() {
    if (!saved) return;
    container.classList.toggle('split', saved.split);
    for (const { pane, style, inert, aria } of saved.panes) {
      pane.style.cssText = style; pane.inert = inert;
      if (aria == null) pane.removeAttribute('aria-hidden'); else pane.setAttribute('aria-hidden', aria);
    }
    primary.resize?.(); peer.resize?.();
    if (primary.camera) primary.userMoved = saved.moved;
    saved = null;
  }
  function show() {
    if (!available() || display === 'side') { restore(); return; }
    remember();
    for (const [view, visible] of [[primary, display === 'B'], [peer, display === 'A']]) {
      view.pane.style.visibility = visible ? 'visible' : 'hidden';
      view.pane.inert = !visible || view === peer; // comparison content cannot create a review on B
      view.pane.setAttribute('aria-hidden', String(!visible));
    }
  }
  function sync() {
    primary.syncPeer?.(); // Reuse the existing model camera/projection/animation contract.
    if (Number.isFinite(primary.z)) {
      for (const name of ['z', 'ox', 'oy', 'whole']) peer[name] = primary[name];
      peer.resize?.();
    }
    // Existing video transport remains on B. Only seek the comparison's display clock.
    if (primary.v && peer.v && Number.isFinite(primary.v.currentTime)) {
      const time = primary.v.currentTime, duration = peer.v.duration;
      const valid = Number.isFinite(duration) && duration > time;
      if (valid) { peer.v.currentTime = time; peer.v.playbackRate = primary.v.playbackRate; }
      if (labels) labels.title = valid ? 'Absolute time; content not checked.' : 'A: playback position not available; content not checked.';
    }
  }
  function updateButton() {
    if (!button) return;
    button.disabled = !available();
    button.textContent = 'A/B · Show ' + (display === 'A' ? 'B' : 'A') + ' (F)';
    button.setAttribute('aria-pressed', String(display !== 'side'));
    button.title = available() ? 'Swap one panel (F). The review stays on B.' : 'A/B not available; choose Side by side with a supported counterpart version.';
  }
  function flip() {
    if (!available()) return false;
    display = display === 'A' ? 'B' : 'A';
    if (primary.file.media === 'audio') primary.switchVersion(display === 'A');
    show(); sync(); updateButton(); persist(); return true;
  }
  function side() {
    if (dead) return;
    display = 'side'; restore(); updateButton(); persist();
  }
  const modeClick = event => { if (event.target.closest?.('.seg button')) side(); };
  bar.addEventListener('click', modeClick, true);
  // Audio's chosen source is already owned by R3I-004. Follow its draw clock without another scheduler.
  const originalDraw = primary?.draw, peerPosition = peer?.pos;
  let audioDraw;
  if (peer && primary?.file?.media === 'audio' && typeof primary.switchVersion === 'function') {
    audioDraw = function (...args) {
      originalDraw.apply(this, args);
      if (dead || display === 'side' || !available()) return;
      const choice = this.useB ? 'A' : 'B';
      if (display !== choice) { display = choice; persist(); }
      peer.pos = this.now(); peer.draw?.(); show(); updateButton();
    };
    primary.draw = audioDraw;
  }
  return {
    render() {
      if (dead) return;
      button?.remove(); labels?.remove();
      const s = get();
      labels = el('span', { class: 'lbl', 'data-ab-labels': '', title: 'Display only, not a review.' },
        'A · ' + (s.source?.label || 'not available') + ' | B · version ' + s.version);
      // One line on desktop (style.css); on phones the pane tags carry the same A/B text, so the legend is screen-reader only there.
      button = el('button', { class: 'tool sm', 'data-ab-flip': '', 'aria-keyshortcuts': 'F',
        style: { flex: '0 0 auto' }, onclick: flip });
      bar.append(labels, button);
      const bTag = primary?.pane?.querySelector('.tag'), aTag = peer?.pane?.querySelector('.tag');
      if (bTag) bTag.textContent = 'B · version ' + s.version;
      if (aTag) aTag.textContent = 'A · ' + s.source?.label;
      if (available() && display !== 'side') {
        if (primary.file.media === 'audio' && primary.useB !== (display === 'A')) primary.switchVersion(display === 'A');
        show(); sync();
      }
      updateButton();
    },
    key(event) {
      if (event.key?.toLowerCase() !== 'f' || event.defaultPrevented || event.repeat || event.isComposing ||
          event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || blocked() ||
          event.target?.isContentEditable || event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return false;
      if (!flip()) return false;
      event.preventDefault(); return true;
    },
    destroy() {
      if (dead) return;
      dead = true; restore(); bar.removeEventListener('click', modeClick, true);
      if (audioDraw && primary.draw === audioDraw) { primary.draw = originalDraw; peer.pos = peerPosition; }
      for (const { tag, text } of tags) tag.textContent = text;
      button?.remove(); labels?.remove(); button = labels = null;
    }
  };
}
