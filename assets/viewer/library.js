// Kitborne Terminal home extras: the tabs (Today | Library | Projects), the asset library browser and project management (agent status, restart, archive).
// Owner only. The library is read-only: /api/library searches the LIBRARY.json index and /api/library/file serves media from the configured folders.
const KIND = { prop: 'Props', sky: 'Sky', texture: 'Textures', vfx: 'VFX', ui: 'UI', sound: 'Sound', physics: 'Physics', terrain: 'Terrain', shader: 'Shaders', lighting: 'Lighting', tool: 'Tools' };
const PAGE = 60;
const FIELD = { model: 'Model', seed: 'Seed', run: 'Run', qa_score: 'QA score', ledger: 'Status', prompt: 'Prompt', source_sha256: 'Source hash' };
const ARCH_WHY = ['Done / finished', 'No longer active', 'Paused', 'Test project', 'Duplicate'];
const READY = { 'source-ready': 'Source ready', 'integration-needed': 'Integration needed', 'review-only': 'View only', held: 'On hold', unavailable: 'Not available' };
const enc = encodeURIComponent;

export function makeLibrary(X) {
  const { S, el, icon, api, toast, ago, withP, hasPro, can, guest, post, curId } = X;
  const L = {};
  const admin = () => can('execute') && !guest();
  const fileUrl = (it, rel) => withP('/api/library/file?src=' + enc(it.previewSrc || it.src) + '&rel=' + enc(rel));
  const copy = async (text, message = 'Path copied') => {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const t = el('textarea', { style: { position: 'fixed', opacity: '0' } }); t.value = text; document.body.append(t); t.select(); try { document.execCommand('copy'); } finally { t.remove(); } }
    toast(message, 2500);
  };

  // ---- tabs ----
  L.tabs = () => {
    if (!admin()) return null;
    const cur = S.homeTab || 'today';
    const tabs = [['today', 'Today'], ['library', 'Library'], ['projects', 'Projects']];
    if (S.tuner && S.tuner.enabled) tabs.splice(1, 0, ['tuner', 'Tuner']);
    return el('div', { class: 'htabs', role: 'tablist', 'aria-label': 'Sections' }, tabs.map(([k, label]) =>
      el('button', { class: 'htab', role: 'tab', 'data-tab': k, 'aria-selected': String(cur === k), onclick: () => { S.homeTab = k; X.show(); } }, label)));
  };
  L.countArchived = async () => { if (admin()) try { S.archN = (await api('/api/projects/archived')).projects.length; } catch (e) { /* the list still works */ } return S.archN || 0; };


  // ---- library ----
  let audio = null;
  const stopAudio = () => { if (audio) { audio.pause(); audio.btn && audio.btn.classList.remove('on'); audio = null; } };
  const playAudio = (btn, url) => {
    if (audio && audio.btn === btn) return stopAudio();
    stopAudio(); audio = new Audio(url); audio.btn = btn; btn.classList.add('on'); audio.onended = stopAudio; audio.play().catch(() => stopAudio());
  };
  const lazy = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { const v = e.target; lazy.unobserve(v); if (v.dataset.src) v.src = v.dataset.src; } }, { rootMargin: '300px' });

  function card(it, open) {
    const url = it.preview ? fileUrl(it, it.preview) : null; const th = el('div', { class: 'libth' });
    let play = null;
    if (it.media === 'video' && url) {
      const v = el('video', { muted: '', loop: '', playsinline: '', preload: 'metadata', 'aria-hidden': 'true', 'data-src': url + '#t=0.1' }); v.muted = true;
      if (it.poster) v.poster = fileUrl(it, it.poster);
      lazy.observe(v); th.append(v);
      th.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') v.play().catch(() => {}); });
      th.addEventListener('pointerleave', () => { v.pause(); v.currentTime = 0.1; });
      play = el('button', { class: 'libplay', 'aria-label': 'Play ' + it.title, title: 'Play', onclick: e => { e.stopPropagation(); v.paused ? v.play().catch(() => {}) : v.pause(); } }, icon('play', 18));
    } else if (it.media === 'audio' && url) {
      th.append(el('span', { class: 'libph' }, icon('note', 34)));
      play = el('button', { class: 'libplay', 'aria-label': 'Play ' + it.title, title: 'Listen', onclick: e => { e.stopPropagation(); playAudio(e.currentTarget, url); } }, icon('play', 18));
    } else if (url) th.append(el('img', { src: url, alt: it.alt || it.title, loading: 'lazy', decoding: 'async', onerror: e => { e.target.replaceWith(el('span', { class: 'libph' }, icon('cube', 34))); } }));
    else th.append(el('span', { class: 'libph' }, icon('cube', 34)));
    const badges = [it.readiness ? el('span', { class: 'libbadge' }, READY[it.readiness] || it.readiness) : null, it.model ? el('span', { class: 'libbadge' }, '3D') : null, it.status !== 'active' ? el('span', { class: 'libbadge warn' }, 'uitgesloten') : null];
    return el('div', { class: 'libcard' + (it.status !== 'active' ? ' off' : ''), role: 'button', tabindex: '0', 'aria-label': it.title + ', ' + (KIND[it.kind] || it.kind), onclick: () => open(it), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(it); } } },
      el('div', { class: 'libwrap' }, th, el('div', { class: 'libbadges' }, badges), play),
      el('div', { class: 'libbody' }, el('div', { class: 'libt' }, it.title), el('div', { class: 'libm' }, (KIND[it.kind] || it.kind) + (it.group ? ' · ' + it.group : ''))));
  }

  async function viewGlb(box, url) {
    box.replaceChildren(el('p', { class: 'muted libload' }, 'Loading 3D…'));
    try {
      const THREE = await import('three');
      const [{ GLTFLoader }, { OrbitControls }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/controls/OrbitControls.js')]);
      const r = new THREE.WebGLRenderer({ antialias: true }); r.setPixelRatio(Math.min(devicePixelRatio, 2)); r.outputColorSpace = THREE.SRGBColorSpace;
      const gltf = await new GLTFLoader().loadAsync(url);
      box.replaceChildren(r.domElement); r.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0c0c0c); scene.add(new THREE.HemisphereLight(0xe6eeff, 0x6b5f4a, 1.7));
      const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(5, 9, 6); scene.add(sun, gltf.scene);
      const bb = new THREE.Box3().setFromObject(gltf.scene), c = bb.getCenter(new THREE.Vector3()), rad = bb.getSize(new THREE.Vector3()).length() / 2 || 1;
      const cam = new THREE.PerspectiveCamera(38, 1, rad / 100, rad * 100); cam.position.copy(c).add(new THREE.Vector3(1, 0.7, 1.4).normalize().multiplyScalar(rad * 2.6));
      const ctl = new OrbitControls(cam, r.domElement); ctl.target.copy(c); ctl.enableDamping = true;
      const fit = () => { const w = box.clientWidth, h = box.clientHeight; if (w && h) { r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); } };
      const ro = new ResizeObserver(fit); ro.observe(box); fit();
      (function loop() { if (!box.isConnected) { ro.disconnect(); r.dispose(); return; } ctl.update(); r.render(scene, cam); requestAnimationFrame(loop); })();
    } catch (e) { box.replaceChildren(el('p', { class: 'muted libload' }, 'Could not load 3D: ' + e.message)); }
  }

  function drawer(it, source) {
    stopAudio();
    const url = it.preview ? fileUrl(it, it.preview) : null; const prev = el('div', { class: 'libprev' });
    if (it.media === 'video' && url) prev.append(el('video', { src: url, controls: '', autoplay: '', loop: '', muted: '', playsinline: '' }));
    else if (it.media === 'audio' && url) prev.append(el('audio', { src: url, controls: '', autoplay: '' }));
    else if (url) prev.append(el('img', { src: url, alt: it.alt || it.title }));
    else prev.append(el('span', { class: 'libph' }, icon('cube', 48)));
    const pv = it.provenance || {};
    const rows = [['Kind', KIND[it.kind] || it.kind], ['Source', it.src + (it.group ? ' / ' + it.group : '')], ['Licence', it.licence]].concat(Object.keys(pv).map(k => [FIELD[k] || k, pv[k]])).filter(r => r[1] !== '' && r[1] != null);
    if (it.type === 'package') rows.push(['Readiness', READY[it.readiness] || it.readiness], ['Approval (manifest)', (it.review || {}).status || 'unknown']);
    const packageBox = it.type === 'package' ? el('section', { class: 'libprov libpackage', 'aria-label': 'Import instructions' }, el('p', { role: 'status' }, 'Checking source files…')) : null;
    const mediaBrief = it.type !== 'package' ? ['Media selection receipt: ' + it.id, 'Source path: ' + it.path,
      ...[...new Set([it.preview, it.model, it.poster].filter(Boolean))].map(rel => 'Selected file (dated index): ' + (source && source.root ? source.root.replace(/[\\/]$/, '') + '/' : it.src + ':') + rel),
      'Provenance: ' + JSON.stringify(pv), 'Licence: ' + (it.licence || 'unknown'),
      'Dependencies/approval: unknown; check original manifest, ledger and review manually.',
      'Role: media preview/candidate; this is not runtime asset approval.'].join('\n') : null;
    const long = rows.filter(r => String(r[1]).length > 70), short = rows.filter(r => String(r[1]).length <= 70);
    const d = el('dialog', { class: 'rounddlg libdlg', 'aria-labelledby': 'lib-heading' },
      el('div', { class: 'libdhead' }, el('h2', { id: 'lib-heading' }, it.title), el('button', { class: 'ghost sq', 'aria-label': 'Close', onclick: () => d.close() }, icon('x'))),
      prev,
      it.model ? el('button', { class: 'ghost libmodel', onclick: e => { e.currentTarget.remove(); prev.classList.add('is3d'); viewGlb(prev, fileUrl(it, it.model)); } }, icon('cube', 16), 'View in 3D') : null,
      it.status !== 'active' ? el('p', { class: 'libwarn' }, 'Excluded' + (it.reasons && it.reasons.length ? ': ' + it.reasons.join(', ') : '') + '. Do not use without a new review.') : null,
      it.tags && it.tags.length ? el('div', { class: 'libtags' }, it.tags.map(t => el('span', { class: 'libtag' }, t))) : null,
      el('div', { class: 'libpath' }, el('code', {}, it.path), el('button', { class: 'ghost', title: 'Copy the full path', onclick: () => copy(it.path) }, icon('copy', 15), 'Copy path')),
      el('dl', { class: 'libdl' }, short.map(r => [el('dt', {}, r[0]), el('dd', {}, String(r[1]))])),
      long.map(r => el('div', { class: 'libprov' }, el('b', {}, r[0]), el('p', {}, String(r[1])))), packageBox,
      mediaBrief ? el('section', { class: 'libprov' }, el('p', { class: 'muted sm' }, 'Media candidate. Check the source manifest, licence and review before reuse.'),
        el('button', { class: 'ghost', onclick: () => copy(mediaBrief, 'Media selection copied') }, icon('copy', 15), 'Copy media selection')) : null);
    if (packageBox) {
      // Keep the existing dialog header and controls in view while long metadata/briefs scroll.
      const details = el('div', { style: { maxHeight: '24dvh', minHeight: '0', overflow: 'auto', flexShrink: '1' } }, [...d.children].slice(1, -1));
      d.replaceChildren(d.firstElementChild, details, packageBox);
      Object.assign(d.style, { display: 'flex', flexDirection: 'column', overflow: 'hidden' });
      d.firstElementChild.style.flexShrink = '0';
      Object.assign(packageBox.style, { display: 'flex', flexDirection: 'column', minHeight: '0' });
    }
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    d.addEventListener('close', () => { d.remove(); });
    document.body.append(d); d.showModal();
    if (packageBox) api('/api/library/describe?id=' + enc(it.id)).then(receipt => {
      packageBox.replaceChildren(el('h3', {}, 'Import instructions'),
        el('p', { class: 'muted sm' }, (READY[receipt.readiness] || receipt.readiness) + ' · Approval (manifest): ' + ((receipt.review || {}).status || 'unknown')),
        el('p', { class: receipt.verified ? 'muted sm' : 'libwarn' }, receipt.verified ? 'Source checked. Integration and owner review remain separate checks.' : 'Import blocked: ' + receipt.blockers.join('; ')),
        el('button', { class: 'ghost', style: { flexShrink: '0', alignSelf: 'flex-start' }, onclick: () => copy(receipt.brief, 'Import brief copied') }, icon('copy', 15), 'Copy import brief'),
        el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '28dvh', minHeight: '0', overflow: 'auto' } }, receipt.brief));
    }).catch(e => packageBox.replaceChildren(el('p', { class: 'libwarn' }, 'Check failed: ' + e.message)));
  }

  L.libraryView = () => {
    const st = S.lib = S.lib || { q: '', kind: '', excl: false };
    let items = [], total = 0, seq = 0, timer = 0, counts = {}, doc = null;
    const grid = el('div', { class: 'libgrid' }), info = el('p', { class: 'muted sm libinfo', role: 'status' });
    const chips = el('div', { class: 'qchips hchips libchips', role: 'group', 'aria-label': 'Kind' });
    const more = el('button', { class: 'ghost libmore', hidden: true, onclick: () => load(true) }, 'Load more');
    const search = el('input', { type: 'search', class: 'hsearch libsearch', placeholder: 'Search: lantern, sky sunset…', 'aria-label': 'Search the library', value: st.q,
      oninput: e => { st.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => load(false), 250); } });
    const excl = el('button', { class: 'qchip', 'aria-pressed': String(st.excl), title: 'Also show items that are excluded or no longer in the catalogue', onclick: e => { st.excl = !st.excl; e.currentTarget.setAttribute('aria-pressed', String(st.excl)); load(false); } }, 'Show excluded');
    function paintChips() {
      const sum = Object.values(counts).reduce((a, b) => a + b, 0); const kinds = (doc && doc.kinds) || Object.keys(KIND);
      chips.replaceChildren(el('button', { class: 'qchip' + (!st.kind ? ' on' : ''), 'aria-pressed': String(!st.kind), onclick: () => { st.kind = ''; load(false); } }, 'All', el('span', { class: 'n' }, sum)),
        kinds.filter(k => counts[k] || st.kind === k).map(k => el('button', { class: 'qchip' + (st.kind === k ? ' on' : ''), 'aria-pressed': String(st.kind === k), onclick: () => { st.kind = k; load(false); } }, KIND[k] || k, el('span', { class: 'n' }, counts[k] || 0))));
    }
    async function load(append) {
      const my = ++seq; const off = append ? items.length : 0;
      try {
        const r = await api('/api/library?' + new URLSearchParams(Object.assign({ q: st.q, kind: st.kind, limit: PAGE, offset: off }, st.excl ? { excluded: '1' } : {})));
        if (my !== seq) return;
        doc = r; counts = r.counts || {}; total = r.total; items = append ? items.concat(r.items) : r.items;
        const frag = r.items.map(it => card(it, item => drawer(item, r.sources.find(source => source.id === item.src)))); append ? grid.append(frag) : grid.replaceChildren(frag);
        paintChips(); more.hidden = items.length >= total;
        info.textContent = total ? total + (total === 1 ? ' item' : ' items') + (r.partial ? ' (only some of the words match)' : '') + (r.built ? ' · index from ' + ago(r.built) : '') : (st.q || st.kind ? 'Nothing found. Try another word or choose All.' : 'The library is empty.');
      } catch (e) {
        if (my !== seq) return;
        info.textContent = e.status === 503 ? 'Library manager needed: ' + e.message : 'Loading failed: ' + e.message;
      }
    }
    const box = el('section', { class: 'hproject libview' }, el('div', { class: 'hhead' }, el('h2', {}, 'Library'), el('div', { class: 'hfind' }, search)), el('div', { class: 'libbar' }, chips, excl), info, grid, el('div', { class: 'libfoot' }, more));
    paintChips(); load(false); return box;
  };

  // ---- projects: agent status, restart, archive ----
  const rq = () => X.reviewer() !== 'Owner' ? '&by=' + enc(X.reviewer()) : '';
  const fail = (what, e) => toast(what + ' failed: ' + e.message.replace(/^Ongeldige aanvraag: /, ''), 7000);
  const short = iso => { const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000 | 0); return m < 60 ? m + ' min' : m < 1440 ? (m / 60 | 0) + 'u' : (m / 1440 | 0) + 'd'; };
  const AGENT_LABEL = { busy: 'busy', aborted: 'aborted', failed: 'failed', stopped: 'stopped', unknown: 'status unknown', archived: 'chat archived', none: 'no agent' }; // server labels are Dutch; map by state
  const word = a => a.state === 'idle' && a.since ? (Date.now() - Date.parse(a.since) < 60000 ? 'just went idle' : 'idle since ' + short(a.since)) : AGENT_LABEL[a.state] || a.label; // from since, so a poll only repaints on a real change
  L.agentChip = a => hasPro() && a ? el('span', { class: 'achip ' + a.state, title: 'Agent: ' + word(a) }, el('i'), word(a)) : null;
  L.agentLine = p => {
    const a = p.agent; if (!hasPro() || !a) return null; const t = a.threads?.[0];
    return el('span', { class: 'aline' }, L.agentChip(a), t ? el('span', { class: 'atitle', title: t.title }, t.title) : null,
      t?.url ? el('a', { class: 'link achat', href: t.url }, 'Open chat') : null);
  };
  // What the restart will do, in words: wake the live chats that own open items, or start one headless project agent.
  L.restart = (p, mode) => {
    if (!hasPro() || !p.agent) return;
    const a = p.agent, d = el('dialog', { class: 'rounddlg', 'aria-labelledby': 'rs-h' });
    const note = el('textarea', { class: 'sum', rows: '3', maxlength: '2000', placeholder: 'What should the agent pay attention to? (optional)' }); // outside paint: New agent instead keeps it
    const paint = () => {
      const wake = mode === 'wake', old = a.threads.filter(t => t.state === 'archived' || t.state === 'unknown').slice(0, 2);
      const names = a.live.map(t => '"' + t.title + '"'), items = n => n === 1 ? 'the open item' : 'the ' + n + ' open items';
      const go = el('button', { class: 'primary', onclick: async () => {
        go.disabled = true;
        try {
          const r = await post(p.id, '/api/project/agent', { action: mode, note: note.value, by: X.reviewer() });
          toast(wake ? 'Woken: ' + r.threads + (r.threads === 1 ? ' chat' : ' chats') + ' received the open items.' : 'Project agent started (' + r.status + '). You see it under In the studio.', 8000); d.close(); X.refresh();
        } catch (e) { fail('Starten', e); go.disabled = false; }
      } }, icon('send', 15), wake ? 'Wake the chat' : 'Start new agent');
      d.replaceChildren(el('h2', { id: 'rs-h' }, (wake ? 'Wake: ' : 'New agent: ') + p.project),
        el('p', {}, wake ? 'Sends ' + items(a.open) + ' again to ' + names.join(', ') + '. The chat picks it up; approved parts stay locked.'
          : 'Start one new agent for this project. It reads CHECKPOINT, JOURNAL and HANDOFF in the project folder, picks up ' + items(a.todo) + ' and takes over the work of the archived or missing chat.'),
        el('p', { class: 'muted sm' }, wake ? 'No credits, purchases or publishing. The message is the same as the improvement round, for this project only.'
          : 'You can stop the new agent from In the studio.' + (old.length ? ' The old chat (' + old.map(t => '"' + t.title + '"').join(', ') + ') stays available.' : '')),
        note, el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Cancel'), el('span', { class: 'grow' }),
          wake ? el('button', { class: 'ghost', title: 'Start a fresh agent instead if the chat does not respond', onclick: () => { mode = 'new'; paint(); } }, 'New agent instead') : null, go));
    };
    paint(); d.addEventListener('click', e => { if (e.target === d) d.close(); }); d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  };
  // Wake when a live chat owns open work, otherwise New agent; nothing while the agent is busy; a short reason when only the owner has to decide.
  L.restartButtons = p => {
    const a = p.agent; if (!hasPro() || !admin() || !a || a.state === 'busy') return [];
    if (!a.todo) return a.open ? [el('span', { class: 'muted sm', title: 'The agent is waiting for your review' }, 'Waiting for you, nothing for the agent')] : [];
    const mode = a.live.length ? 'wake' : 'new';
    return [el('button', { class: 'ghost restart', title: mode === 'wake' ? 'Send the open items to the live chat again' : 'Start a new headless agent for this project', onclick: () => L.restart(p, mode) }, icon(mode === 'wake' ? 'refresh' : 'spark', 15), mode === 'wake' ? 'Wake' : 'New agent')];
  };

  function askArchive(what) {
    return new Promise(done => {
      let result = null;
      const text = el('textarea', { class: 'sum', rows: '6', maxlength: '4000', 'aria-label': 'Why archive?', placeholder: 'Why are you archiving this? (required)' });
      const go = el('button', { class: 'primary', 'data-archive-ok': '1', onclick: () => {
        const t = text.value.trim(); if (!t) { text.focus(); text.classList.remove('shake'); void text.offsetWidth; text.classList.add('shake'); return; }
        result = t; d.close(); } }, icon('archive', 15), 'Archive');
      const upd = () => { const empty = !text.value.trim(); go.setAttribute('aria-disabled', String(empty)); go.title = empty ? 'First write why' : 'Ctrl+Enter'; };
      text.addEventListener('input', upd); text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); } }); upd();
      const chips = el('div', { class: 'autorow' }, ARCH_WHY.map(w => el('button', { class: 'chipbtn', onclick: () => { text.value = text.value.trim() ? text.value.trim() + '; ' + w : w; upd(); text.focus(); } }, w)));
      const d = el('dialog', { class: 'rounddlg', 'aria-labelledby': 'arch-heading' }, el('h2', { id: 'arch-heading' }, 'Archive project: ' + what),
        el('p', { class: 'muted sm' }, 'The project disappears from the tabs, the inbox and the counters. Nothing is deleted; you can restore it under Projects.'), chips, text,
        el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Cancel'), el('span', { class: 'grow' }), go));
      d.addEventListener('close', () => { d.remove(); done(result); }); document.body.append(d); d.showModal(); text.focus();
    });
  }
  const undoToast = done => {
    const what = done.length === 1 ? done[0].project : done.length + ' projects';
    toast('Archived: ' + what, 10000, ['Undo', async () => {
      try { for (const r of done) await post(r.id, '/api/project/restore', { id: r.id, by: X.reviewer() }); toast('Restored: ' + what, 4000); } catch (e) { fail('Restore', e); }
      await X.refresh(); if (L.repaint) L.repaint(); }]);
  };
  // Archiving the project on screen moves to the next one; that page shows the undo toast.
  try { const u = JSON.parse(sessionStorage.arUndo || 'null'); sessionStorage.removeItem('arUndo'); if (u) setTimeout(() => undoToast(u), 500); } catch (e) { /* no storage */ }
  // Any projects ([{id, project}]) with one reason; the toast undoes all of them. Resolves true when at least one was archived.
  L.archiveProjects = async list => {
    const reason = await askArchive(list.length === 1 ? list[0].project : list.length + ' projects'); if (!reason) return false;
    const done = [];
    try { for (const p of list) done.push((await post(p.id, '/api/project/archive', { reason, by: X.reviewer() })).project); } catch (e) { fail('Archive', e); }
    if (done.length) {
      S.archN = null; const next = ((S.proj || {}).projects || []).find(p => !done.some(r => r.id === p.id));
      if (next && done.some(r => r.id === curId())) { sessionStorage.arUndo = JSON.stringify(done.map(r => ({ id: r.id, project: r.project }))); location.href = '?p=' + enc(next.id) + rq(); return true; }
      undoToast(done);
    }
    await X.refresh(); return done.length > 0;
  };
  L.archiveButton = () => !admin() ? null : el('button', { class: 'ghost archbtn', title: 'Hide this project from the tabs and the inbox. Nothing is deleted.', onclick: async () => {
    const p = ((S.proj || {}).projects || []).find(x => x.id === curId()) || { id: curId(), project: S.cat.project };
    if (await L.archiveProjects([p])) { S.homeTab = 'projects'; X.show(); } } }, icon('archive', 15), 'Archive project');

  // The Projects tab: every active project with its agent, bulk archive, and below the archived ones with Restore.
  L.projectsView = () => {
    const box = el('section', { class: 'hproject projview' }), sel = new Set();
    const bulk = el('button', { class: 'primary sm', style: 'display:none', onclick: async () => { if (await L.archiveProjects(((S.proj || {}).projects || []).filter(p => sel.has(p.id)))) { sel.clear(); paint(); } } }, icon('archive', 15), 'Archive 0');
    const upd = () => { bulk.lastChild.textContent = 'Archive ' + sel.size; bulk.style.display = sel.size ? '' : 'none'; };
    async function paint() {
      let rows; try { rows = (await api('/api/projects/archived')).projects; } catch (e) { box.replaceChildren(el('p', { class: 'muted hempty' }, 'Loading failed: ' + e.message)); return; }
      S.archN = rows.length; const ps = (S.proj || {}).projects || []; for (const id of [...sel]) if (!ps.some(p => p.id === id)) sel.delete(id); upd();
      const active = p => { const a = p.agent;
        return el('div', { class: 'arow projrow' },
          el('input', { type: 'checkbox', class: 'pcheck', 'aria-label': 'Select ' + p.project, checked: sel.has(p.id), onchange: e => { e.target.checked ? sel.add(p.id) : sel.delete(p.id); upd(); } }),
          el('div', { class: 'arow-txt' }, el('span', { class: 'rowname' }, p.project), L.agentLine(p),
            el('span', { class: 'arow-st' }, [a ? a.open + ' open' : null, p.waiting ? p.waiting + ' waiting for you' : 'nothing waiting', a && a.since ? 'last active ' + ago(a.since) : null].filter(Boolean).join(' · '))),
          el('div', { class: 'pbtns' }, el('a', { class: 'btnlink', href: '?p=' + enc(p.id) + rq() }, 'Open'), L.restartButtons(p),
            el('button', { class: 'ghost', onclick: async () => { if (await L.archiveProjects([p])) paint(); } }, icon('archive', 15), 'Archive'))); };
      const arch = el('section', { class: 'archv' }, el('h3', {}, 'Archived', el('span', { class: 'ncnt' }, rows.length)),
        rows.length ? el('div', { class: 'arows' }, rows.slice().reverse().map(r => el('div', { class: 'arow archrow' },
          el('div', { class: 'arow-txt' }, el('span', { class: 'rowname' }, r.project), el('span', { class: 'arow-st' }, 'Archived ' + ago(r.at) + ' by ' + r.by), el('span', { class: 'arow-st archwhy' }, 'Reason: ' + r.reason), el('span', { class: 'arow-st archpath' }, r.root)),
          el('button', { class: 'ghost restore', onclick: e => restore(e.currentTarget, r) }, icon('refresh', 15), 'Restore')))) : el('p', { class: 'muted hempty' }, 'No archived projects.'));
      box.replaceChildren(el('div', { class: 'hhead' }, el('h2', {}, 'Projects'), bulk), el('p', { class: 'muted sm' }, 'Your agents per project. Archiving hides a project from the tabs, the inbox and the counters; nothing is deleted.'),
        el('div', { class: 'arows' }, ps.map(active)), arch);
      if (S.toArch) { S.toArch = false; arch.scrollIntoView({ block: 'start' }); }
    }
    async function restore(btn, r) {
      btn.disabled = true;
      try { await post(r.id, '/api/project/restore', { id: r.id, by: X.reviewer() }); toast('Restored: ' + r.project, 5000); await X.refresh(); await paint(); }
      catch (e) { fail('Restore', e); btn.disabled = false; }
    }
    L.repaint = () => box.isConnected && paint();
    paint(); return box;
  };
  return L;
}
