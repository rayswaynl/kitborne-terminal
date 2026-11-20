// Asset Review v2: the home screen "Today" - what needs you across projects, then this project's work by discipline.
// app.js keeps the data (catalog, queue cards); this module only builds the new pieces and never talks to a review file.
export const GROUPS = [['game', 'Game'], ['web', 'Website'], ['social', 'Social'], ['sound', 'Sound'], ['video', 'Video'], ['story', 'Story & print'], ['asset', 'Assets']];
export const CHIPS = [['all', 'All'], ['wait', 'Waiting'], ['agent', 'With agent'], ['stuck', 'Stuck'], ['done', 'Done'], ['rest', 'Old']];
const KIND_RANK = { stuck: 0, wait: 1, agent: 2, done: 3, rest: 4 };
// Oud: stuck on an archived chat and rejected, or a week old (server sets st.stuck.rest). Only under its own filter; nothing is deleted.
const isRest = it => !!(it.rest || (it.stuck && it.stuck.rest));
const STUCK_WORD = { 'niet opgepakt': 'not picked up', mislukt: 'failed', 'geen agent': 'no agent linked', 'chat gearchiveerd': 'chat archived', 'agent gestopt': 'agent stopped', 'rondelimiet: jij beslist': 'round limit: you decide' };

// "style_b_brick" -> "Style b brick". A name somebody typed with spaces or capitals stays as it is.
export function nice(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s || /\s/.test(s) || (/[A-Z]/.test(s) && !/[_-]/.test(s))) return s;
  const t = s.replace(/[_-]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1);
}

export function makeHome(X) {
  const { S, el, icon, api, toast, ago, pick, stageInfo, routeStages, thumbOf, tallThumb, SHORT, withP, hasPro, can, guest, reviewerQuery } = X;
  const H = {};
  const stageLabel = id => SHORT[id] || ((S.cat.stages.find(s => s.id === id) || {}).label) || id;
  const curId = () => X.project() || (S.proj || {}).home;
  const groupOf = id => (((S.cat.routes || {})[(S.cat.assets[id] || {}).route || 'full']) || {}).group || 'asset';
  const waitingWord = () => guest() ? 'waiting for the owner' : S.me && S.me.owned_by ? 'waiting for ' + S.me.owned_by : 'waiting for you';
  H.waitingWord = waitingWord;

  // ---- one asset in one line of text ----
  // The stage that matters most: stuck first, then what waits for the reviewer, then what the agent has, then the newest.
  H.summarize = id => {
    const a = S.cat.assets[id]; const stages = routeStages(id); const total = stages.length || 1;
    const ent = S.cat.stages.map(s => ({ s, st: stageInfo(id, s.id) })).filter(e => e.st);
    const rank = e => hasPro() && e.st.stuck && !isRest(e.st) && !guest() ? 0 : e.st.status === 'in_review' ? 1 : ['changes', 'gate', 'rejected'].includes(e.st.status) ? 2 : 3;
    const at = e => (e.st.versions[e.st.versions.length - 1].at || '');
    ent.sort((x, y) => rank(x) - rank(y) || at(y).localeCompare(at(x)));
    const approved = stages.filter(s => { const st = stageInfo(id, s.id); return st && st.status === 'approved' && !st.stale; }).length;
    const sm = { id, a, name: nice(a.name), group: groupOf(id), total, approved, pct: Math.round(100 * approved / total), kind: 'agent', stage: null, v: 1, text: 'Nothing submitted yet', since: '', ent };
    const top = ent[0]; if (!top) return sm;
    const ver = top.st.versions[top.st.versions.length - 1]; const i = stages.findIndex(s => s.id === top.s.id);
    const last = stages.length && top.s.id === stages[stages.length - 1].id;
    let state, since = ver.at;
    if (hasPro() && top.st.stuck && isRest(top.st) && !guest()) { sm.kind = 'rest'; state = (top.st.stuck.rest === 'afgewezen' ? 'rejected' : 'old') + ', chat archived'; since = top.st.stuck.since || since; }
    else if (hasPro() && top.st.stuck && !guest()) { sm.kind = 'stuck'; sm.reason = top.st.stuck.reason; state = 'stuck (' + (STUCK_WORD[top.st.stuck.reason] || top.st.stuck.reason || 'no response') + ')'; since = top.st.stuck.since || since; }
    else if (top.st.status === 'in_review') { sm.kind = 'wait'; state = waitingWord(); }
    else if (top.st.status === 'approved' && (last || approved >= total)) { sm.kind = 'done'; state = 'done'; sm.pct = 100; }
    else { state = guest() ? 'in progress' : !hasPro() ? ({ approved: 'approved', rejected: 'rejected', changes: 'changes requested', gate: 'held back' }[top.st.status] || 'in progress')
      : top.st.status === 'approved' ? 'approved, the agent is up' : top.st.status === 'rejected' ? 'rejected, the agent is up' : top.st.status === 'gate' ? 'held back' : 'with agent'; }
    Object.assign(sm, { stage: top.s.id, v: ver.v, since, ver, text: [i >= 0 ? 'Stage ' + (i + 1) + ' of ' + total : null, stageLabel(top.s.id), state + (since ? ' since ' + ago(since, true) : '')].filter(Boolean).join(' · ') });
    return sm;
  };
  H.all = () => Object.keys(S.cat.assets).map(H.summarize);

  // ---- helpers ----
  const post = async (p, path, body) => {
    const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'p=' + encodeURIComponent(p), { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok || !json || json.ok === false) throw new Error((json && (json.error || (json.result && 'the agent was not reached, ' + (json.result.error || json.result.result)))) || 'error ' + r.status);
    return json;
  };
  H.post = post;
  const wake = async (btn, p, asset, stage, label) => {
    btn.disabled = true;
    try { await post(p, '/api/wake', { asset, stage }); toast('The agent was woken again for ' + label + '.', 5000); X.refresh(); }
    catch (e) { toast('Could not wake: ' + e.message.replace(/^Ongeldige aanvraag: /, ''), 7000); }
    finally { btn.disabled = false; }
  };
  // A chat that is gone cannot be woken: the row then opens the project's New agent dialog instead of a button that can only fail.
  const GONE = ['chat gearchiveerd', 'geen agent', 'agent gestopt'];
  const wakeButton = (p, asset, stage, label, reason) => {
    if (!hasPro() || !can('execute')) return null;
    const proj = !guest() && GONE.includes(reason) && ((S.proj || {}).projects || []).find(x => x.id === p), a = proj && proj.agent;
    if (a && a.state !== 'busy' && !a.studio_running) return el('button', { class: 'ghost wake', title: 'The chat for this agent is gone. Start a new agent to take over this work.', onclick: e => { e.stopPropagation(); X.lb().restart(proj, 'new'); } }, icon('spark', 15), 'New agent');
    return el('button', { class: 'ghost wake', title: 'Send the last task to the agent again', onclick: e => { e.stopPropagation(); wake(e.currentTarget, p, asset, stage, label); } }, icon('refresh', 15), 'Wake again');
  };
  // Discard from any list, also for another project: the asset goes to that project's archive and no agent makes it again.
  const bin = async (btn, p, asset, label) => {
    if (p === curId() && X.bin) return X.bin([asset]);
    const reason = await X.askReason(label); if (!reason) return;
    btn.disabled = true;
    try {
      const out = await post(p, '/api/bin', { asset, reason }); X.refresh();
      toast('Discarded: ' + label, 10000, ['Undo', async () => {
        try { await post(p, '/api/unbin', { archive: out.archive }); toast('Restored: ' + label, 4000); } catch (e) { toast('Could not restore: ' + e.message, 7000); }
        X.refresh(); }]);
    } catch (e) { toast('Could not discard: ' + e.message.replace(/^Ongeldige aanvraag: /, ''), 7000); btn.disabled = false; }
  };
  const binButton = (p, asset, label) => guest() ? null : el('button', { class: 'ghost sq arow-bin', title: 'Move this asset to the archive', 'aria-label': 'Discard: ' + label, onclick: e => { e.stopPropagation(); bin(e.currentTarget, p, asset, label); } }, icon('trash', 16));
  const open = (p, asset, stage, v) => {
    if (p === curId() && S.cat.assets[asset]) return pick(asset, stage, v);
    location.href = '?p=' + encodeURIComponent(p) + reviewerQuery() + '#a=' + encodeURIComponent(asset) + '&s=' + encodeURIComponent(stage) + (v ? '&v=' + v : '');
  };
  // far: a version of another project ({ p, v }); its catalog is not loaded, so the server picks the image.
  const thumbSpan = (id, stage, ver, far) => { const th = ver && S.cat.assets[id] ? thumbOf(id, stage, ver) : null;
    return el('span', { class: 'rowthumb' + (ver && tallThumb(ver) ? ' page-thumb' : ''), style: th ? { backgroundImage: 'url("' + th + '")' } : {} }, th ? null : !far ? icon('eye', 20)
      : el('img', { src: '/api/thumb?p=' + encodeURIComponent(far.p) + '&asset=' + encodeURIComponent(id) + '&stage=' + encodeURIComponent(stage) + '&v=' + far.v, alt: '', loading: 'lazy', onerror: e => e.target.replaceWith(icon('eye', 20)) })); };
  const rowThumb = it => { const st = it.p === curId() && stageInfo(it.asset, it.stage); return thumbSpan(it.asset, it.stage, st ? st.versions[it.v - 1] : null, st ? null : it); };
  H.queueHref = it => '?p=' + encodeURIComponent(it.p) + reviewerQuery() + '#a=' + encodeURIComponent(it.asset) + '&s=' + encodeURIComponent(it.stage) + '&v=' + it.v;


  const SOCIAL_LABELS = ['Too many posts', 'Too few posts', 'Too much content', 'Too little content', 'Too long', 'Too short', 'Different tone', 'Better image', 'Too technical', 'Missing source'];
  const socialDrafts = new Map();
  const socialKey = it => [it.p, it.asset, it.stage, it.v].join('/');
  let socialBox = null, socialItems = null, socialLoading = false;
  const socialUrl = (it, f) => '/data/' + enc(it.asset) + '/' + enc(it.stage) + '/v' + String(it.v).padStart(3, '0') + '/' + enc(f.name) + '?p=' + enc(it.p);
  const enc = encodeURIComponent;
  H.refreshSocial = async () => {
    if (socialLoading) return;
    socialLoading = true;
    try {
      const d = await api('/api/social'); const changed = JSON.stringify(socialItems) !== JSON.stringify(d.items);
      socialItems = d.items; S.socialN = d.items.filter(it => it.status === 'in_review' && it.can_decide).length;
      const tab = document.querySelector('[data-tab=social]');
      if (tab) { const old = tab.querySelector('.n'); if (old) old.remove(); if (S.socialN) tab.append(el('span', { class: 'n' }, S.socialN)); }
      if (changed && socialBox && socialBox.isConnected) paintSocial();
    } catch (e) { if (socialBox && socialBox.isConnected) toast('Could not load social: ' + e.message, 7000); }
    finally { socialLoading = false; }
  };
  H.socialView = () => { socialBox = el('section', { class: 'social-view' }); paintSocial(); H.refreshSocial(); return socialBox; };
  function paintSocial() {
    const all = socialItems || []; S.socialPlatform = S.socialPlatform || 'all'; S.socialStatus = S.socialStatus || 'all';
    const filter = (key, defs) => el('div', { class: 'seg social-filter', role: 'group', 'aria-label': key === 'socialPlatform' ? 'Platform' : 'Status' }, defs.map(([v, label]) =>
      el('button', { class: 'tool sm', 'aria-pressed': String(S[key] === v), onclick: () => { S[key] = v; paintSocial(); } }, label)));
    const rows = all.filter(it => (S.socialPlatform === 'all' || S.socialPlatform === it.platform) && (S.socialStatus === 'all' || S.socialStatus === it.status));
    if (!rows.some(it => socialKey(it) === S.socialActive)) S.socialActive = rows[0] && socialKey(rows[0]);
    socialBox.replaceChildren(el('div', { class: 'hero' }, el('div', {}, el('h1', {}, 'Social'), el('p', { class: 'sub' }, S.socialN + ' waiting for me · You post them yourself.')),
      el('button', { class: 'ghost', onclick: () => H.refreshSocial() }, 'Refresh')),
      filter('socialPlatform', [['all', 'All'], ['x', 'X'], ['vcnl', 'VCNL']]),
      filter('socialStatus', [['in_review', 'Waiting for me'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']]),
      el('div', { class: 'social-grid' }, rows.map(socialCard)),
      !rows.length ? el('p', { class: 'muted' }, socialItems ? 'No posts for these filters.' : 'Loading posts…') : null);
  }
  function socialCard(it) {
    const key = socialKey(it); if (!socialDrafts.has(key)) socialDrafts.set(key, { labels: new Set(), text: '' });
    const draft = socialDrafts.get(key), activate = () => { S.socialActive = key; for (const c of socialBox.querySelectorAll('.social-card')) c.classList.toggle('active', c.dataset.key === key); };
    const word = { in_review: 'Waiting for me', approved: 'Approved', rejected: 'Rejected', changes: hasPro() ? 'Back to agent' : 'Changes requested', gate: 'Held back' }[it.status] || it.status;
    const card = el('article', { class: 'social-card' + (key === S.socialActive ? ' active' : ''), 'data-key': key, 'data-asset': it.asset, onfocusin: activate },
      el('div', { class: 'social-card-head' }, el('span', { class: 'social-platform' }, it.platform === 'unknown' ? 'Platform missing' : it.platform.toUpperCase()), el('span', { class: 'muted' }, it.project), el('span', { class: 'social-status ' + it.status }, word)),
      el('button', { class: 'social-title', onclick: () => open(it.p, it.asset, it.stage, it.v) }, nice(it.name)),
      el('div', { class: 'social-blocks' }, it.blocks.length ? it.blocks.map((text, i) => {
        const chars = [...text].length, words = text.trim().split(/\s+/u).filter(Boolean).length, ok = it.platform === 'x' ? chars <= 270 : it.platform === 'vcnl' ? words >= 150 && words <= 250 : false;
        return el('div', { class: 'social-block' }, el('b', {}, it.blocks.length > 1 ? 'Post ' + (i + 1) + '/' + it.blocks.length : 'Post text'), el('p', { class: 'social-copy' }, text),
          el('span', { class: 'social-count' + (ok ? '' : ' over') }, chars + ' characters · ' + words + ' words · ' + (it.platform === 'x' ? 'limit 270 characters' : it.platform === 'vcnl' ? 'target 150–250 words' : 'choose platform') + (ok ? ' ✓' : ' · check')));
      }) : el('p', { class: 'muted' }, 'No ```text``` block. Open the item to view the source.')),
      el('div', { class: 'social-media' }, it.files.filter(f => ['image', 'video'].includes(f.media)).map(f => f.media === 'video'
        ? el('video', { src: socialUrl(it, f), controls: '', playsinline: '', preload: 'none', 'aria-label': f.name })
        : el('button', { class: 'social-thumb', title: f.name, onclick: () => open(it.p, it.asset, it.stage, it.v) }, el('img', { src: socialUrl(it, f), alt: f.name, loading: 'lazy' })) )));
    if (it.can_decide) {
      const labels = el('div', { class: 'social-labels', role: 'group', 'aria-label': 'Quick labels' }, SOCIAL_LABELS.map(label => el('button', { class: 'tool sm', 'aria-pressed': String(draft.labels.has(label)), onclick: e => {
        activate(); draft.labels.has(label) ? draft.labels.delete(label) : draft.labels.add(label); e.currentTarget.setAttribute('aria-pressed', String(draft.labels.has(label)));
      } }, label)));
      const free = el('input', { class: 'social-free', type: 'text', placeholder: 'Your own label or note', 'aria-label': 'Your own label or note', value: draft.text, oninput: e => { draft.text = e.target.value; } });
      const act = (label, verdict, cls) => el('button', { class: cls, onclick: () => decideSocial(it, draft, verdict, card) }, label);
      card.append(labels, free, el('button', { class: 'ghost social-select', onclick: activate }, 'Review'), el('footer', { class: 'social-actions' },
        el('span', { class: 'social-footer-name' }, nice(it.name)), act('Approve', 'approved', 'primary green'), act('Reject', 'rejected', 'ghost red'), act('Apply labels', 'changes', 'ghost'),
        el('button', { class: 'ghost', onclick: e => bin(e.currentTarget, it.p, it.asset, nice(it.name)) }, 'Dismiss')));
    }
    return card;
  }
  async function decideSocial(it, draft, verdict, card) {
    const labels = [...draft.labels]; if (draft.text.trim()) labels.push(draft.text.trim());
    if (verdict === 'changes' && !labels.length) return toast('Pick a label or write a note.', 5000);
    const controls = [...card.querySelectorAll('button,input')]; controls.forEach(b => b.disabled = true);
    try {
      const q = 'asset=' + enc(it.asset) + '&stage=' + enc(it.stage) + '&v=' + it.v + '&p=' + enc(it.p);
      const r = await fetch('/api/review?' + q, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('Loading review: ' + r.status);
      const old = await r.json(), review = { ...(old || {}), asset: it.asset, stage: it.stage, version: it.v, verdict, draft: false, reviewer: X.reviewer(), checklist: (old || {}).checklist || {}, notes: (old || {}).notes || [], followups: (old || {}).followups || [] };
      review.summary = [review.summary, labels.length ? 'Labels: ' + labels.join(', ') : ''].filter(Boolean).join('\n');
      delete review.auto;
      await post(it.p, '/api/review', { review, files: {}, base_rev: (old || {}).rev || 0 });
      socialDrafts.delete(socialKey(it)); toast(verdict === 'changes' ? 'Labels sent to the agent.' : verdict === 'approved' ? 'Approved.' : 'Rejected.', 5000);
      await H.refreshSocial(); X.refresh();
    } catch (e) { toast('Not saved: ' + e.message + '. Your labels stay.', 8000); }
    finally { controls.forEach(b => b.disabled = false); }
  }

  // ---- project switcher (replaces the tabs): dropdown on desktop, sheet on a phone ----
  // Owner toggle: a project belongs to its non-admin owner in people.json; every other project belongs to the admin.
  // The admin reads those owners from /api/me?p=<id> (owned_by), once per project per page load; a commenter knows them from her own role.
  const ADMIN = 'Admin';
  const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); // "ideeen" finds Video-ideeën
  const ownerOf = p => {
    if (!S.me) return 'Owner unknown';
    if (!S.me.admin) return p.role === 'owner' ? S.me.name || 'Me' : ADMIN;
    const own = S.owners || {};
    return p.id in own && own[p.id] !== undefined ? own[p.id] || ADMIN : 'Owner unknown';
  };
  async function loadOwners(ps) {
    const own = S.owners || (S.owners = {}), todo = ps.filter(p => !(p.id in own)); if (!(S.me && S.me.admin) || !todo.length) return;
    for (const p of todo) own[p.id] = undefined; // pending is unknown; a successful null response retains the default owner
    await Promise.all(todo.map(p => fetch('/api/me?p=' + encodeURIComponent(p.id), { signal: AbortSignal.timeout(15000) })
      .then(r => r.ok ? r.json() : Promise.reject(r.status)).then(m => own[p.id] = (m && m.owned_by) || null)
      .catch(() => { delete own[p.id]; return null; }))); // a failed answer is asked again when the menu opens
    if (H.sw && H.sw.isConnected && H.sw.isOpen()) H.sw.repaint(); // repaint also when all successful answers use the default owner
  }
  H.switcher = () => {
    const ps = (S.proj || {}).projects || [];
    const cur = ps.find(p => p.id === curId());
    if (!cur) return can('execute') && !guest() ? el('button', {
      class: 'link', type: 'button', title: 'The current project is not in the active list',
      'aria-label': 'Open projects; the current project is not in the active list',
      onclick: () => X.openProjects()
    }, 'Open projects') : null;
    const asOwner = p => (p.role || (guest() ? 'commenter' : 'owner')) === 'owner'; // the role is per project: someone can own one project and comment on the rest
    const cnt = p => asOwner(p) ? p.waiting || 0 : (S.newBy || {})[p.id] || 0; // a commenter counts new assets, an owner counts waiting versions
    const others = ps.filter(p => p.id !== cur.id).reduce((n, p) => n + cnt(p), 0);
    const box = el('div', { class: 'pswitch' });
    const mgr = can('execute') && !guest(); // the owner manages projects from here
    const archLink = el('button', { class: 'link', onclick: () => { close(); S.toArch = true; X.openProjects(); } }, 'Archived' + (S.archN ? ' (' + S.archN + ')' : ''));
    // Archive any project from the list (the one on screen moves to the next); the open list refreshes in place.
    const archiveFrom = async p => { if (await X.lb().archiveProjects([p]) && H.sw && H.sw.isConnected) H.sw.open(); };
    const row = p => el('div', { class: 'prow' },
      el('a', { class: 'pitem', role: 'menuitem', href: '?p=' + encodeURIComponent(p.id) + reviewerQuery(), 'aria-current': p.id === cur.id ? 'true' : null },
        el('span', { class: 'pname', title: p.project }, p.project), X.lb().agentChip(p.agent), el('span', { class: 'pcnt' + (cnt(p) ? ' on' : '') }, !cnt(p) ? (asOwner(p) ? 'no waiting reviews' : 'no new items') : !asOwner(p) ? cnt(p) + ' new' : X.queueCount?.(p, cnt(p)) || cnt(p) + (cnt(p) === 1 ? ' waiting' : ' waiting'))),
      mgr ? el('button', { class: 'ghost sq parch', title: 'Archive ' + p.project, 'aria-label': 'Archive ' + p.project, onclick: () => archiveFrom(p) }, icon('archive', 18)) : null);
    const me = S.me && !S.me.admin ? S.me.name || 'Me' : ADMIN;
    const groups = () => [...new Set(ps.map(ownerOf))].sort((a, b) => (b === me) - (a === me) || a.localeCompare(b, 'nl')); // your own projects first
    const who = el('div', { class: 'seg pwho', role: 'group', 'aria-label': 'Projects of', hidden: true });
    const search = el('input', { type: 'search', placeholder: 'Search project', 'aria-label': 'Search for a project', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go', value: S.pq || '', oninput: () => { S.pq = search.value; paint(); } });
    const list = el('div', { class: 'plist', role: 'menu', 'aria-label': 'Projects' });
    // The toggle shows the owner of this project until you pick one; the search matches every word anywhere in the name, accents ignored.
    function paint(all) {
      const gs = groups(), split = gs.length > 1, g = gs.includes(S.pwho) ? S.pwho : ownerOf(cur), refocus = who.contains(document.activeElement);
      const was = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') || '' : null; // focus in the list survives a repaint
      const words = fold(S.pq).split(/\s+/).filter(Boolean), hit = p => words.every(w => fold(p.project).includes(w));
      who.hidden = !split;
      who.replaceChildren(...gs.map(o => el('button', { class: 'tool sm', type: 'button', 'aria-pressed': String(o === g), onclick: () => { S.pwho = o; paint(); } },
        o, el('span', { class: 'pwho-n' }, ps.filter(p => ownerOf(p) === o).length))));
      if (refocus) who.querySelector('[aria-pressed=true]').focus();
      const shown = all ? ps : ps.filter(p => (!split || ownerOf(p) === g) && hit(p));
      const elsewhere = split && words.length ? gs.filter(o => o !== g).map(o => [o, ps.filter(p => ownerOf(p) === o && hit(p)).length]).filter(x => x[1]) : [];
      list.replaceChildren(...shown.map(row), ...(shown.length ? [] : [el('p', { class: 'pempty' }, words.length ? 'No project with \u201c' + S.pq.trim() + '\u201d' + (split ? ' at ' + g : '') + '.' : 'No projects of ' + g + '.')]),
        ...elsewhere.map(([o, n]) => el('button', { class: 'link pelse', type: 'button', onclick: () => { S.pwho = o; paint(); } }, 'Also at ' + o + ': ' + n + (n === 1 ? ' project' : ' projecten'))));
      if (was !== null) { const f = [...list.querySelectorAll('a.pitem')].find(a => a.getAttribute('href') === was) || list.querySelector('a.pitem') || (search.isConnected && search); if (f) f.focus({ preventScroll: true }); }
    }
    const menu = el('div', { class: 'pmenu', role: 'dialog', 'aria-label': 'Choose a project', hidden: true },
      el('div', { class: 'pmenu-head' }, el('b', {}, 'Choose a project'), el('button', { class: 'ghost sq', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
      el('div', { class: 'ptools' }, who, ps.length > 6 ? el('label', { class: 'psearch' }, icon('search', 18), search) : null),
      list,
      mgr ? el('div', { class: 'pfoot' }, el('button', { class: 'link', onclick: () => { close(); X.openProjects(); } }, 'Manage all projects'), archLink) : null);
    const btn = el('button', { class: 'pbtn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Switch project', onclick: () => menu.hidden ? show() : close() },
      el('b', {}, cur.project), others ? el('i', { title: others + (ps.some(p => p.id !== cur.id && asOwner(p)) ? ' waiting for you' : ' new') + ' in other projects' }, '+' + others) : null);  // '+': these wait elsewhere, not in the project named here
    const scrim = el('div', { class: 'pscrim', hidden: true, onclick: () => close() });
    // Desktop: the dropdown keeps the width of the longest name of all groups while you filter, ends 12 px above the window edge, and only the list scrolls.
    // A phone keeps its full-width bottom sheet (CSS).
    const desk = () => !matchMedia('(max-width:820px)').matches;
    function fit() { menu.style.removeProperty('--pmax'); if (desk()) menu.style.setProperty('--pmax', Math.max(240, innerHeight - menu.getBoundingClientRect().top - 12) + 'px'); else menu.style.width = ''; }
    function show() {
      menu.hidden = false; scrim.hidden = false; btn.setAttribute('aria-expanded', 'true');
      menu.style.width = ''; if (desk()) { paint(true); menu.style.width = Math.ceil(menu.getBoundingClientRect().width) + 'px'; }
      paint(); fit(); loadOwners(ps);
      if (mgr) X.lb().countArchived().then(n => { archLink.textContent = 'Archived' + (n ? ' (' + n + ')' : ''); });
      const c = list.querySelector('[aria-current]'); // this project in the middle of the list
      if (c) { const cr = c.getBoundingClientRect(), lr = list.getBoundingClientRect(); list.scrollTop += cr.top - lr.top - (lr.height - cr.height) / 2; }
      const keys = matchMedia('(hover: hover) and (pointer: fine) and (min-width:821px)').matches; // a keyboard: type right away; a phone keeps its keyboard closed
      const f = keys && search.isConnected ? search : c || list.querySelector('a'); if (f) f.focus({ preventScroll: true });
    }
    function close() { menu.hidden = true; scrim.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (S.pq) { S.pq = ''; search.value = ''; } }
    // Escape clears the search first, then closes. Arrows walk search and list, Enter opens the first hit, typing elsewhere in the menu goes to the search.
    box.addEventListener('keydown', e => {
      if (menu.hidden || e.isComposing) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (search.value) { search.value = S.pq = ''; paint(); search.focus(); } else { close(); btn.focus(); } return; }
      const items = [...list.querySelectorAll('a.pitem')], i = items.indexOf(document.activeElement), down = e.key === 'ArrowDown', inSearch = e.target === search;
      if (e.key === 'Enter' && inSearch) { e.preventDefault(); if (!items.length) list.querySelector('.pelse')?.click(); list.querySelector('a.pitem')?.click(); } // no hit here: the first hit in the other group
      else if ((down || e.key === 'ArrowUp') && (inSearch || i >= 0)) { e.preventDefault(); const n = inSearch ? (down ? items[0] : null) : items[i + (down ? 1 : -1)] || (!down && search.isConnected ? search : null); if (n) n.focus(); }
      else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && !inSearch && menu.contains(e.target) && search.isConnected) { e.stopPropagation(); search.focus(); } // the letter goes to the search, not to a page shortcut
    });
    box.close = close; box.open = show; box.fit = fit; box.repaint = paint; box.isOpen = () => !menu.hidden; H.sw = box;
    loadOwners(ps);
    box.append(btn, scrim, menu); return box;
  };
  document.addEventListener('pointerdown', e => { if (H.sw && H.sw.isConnected && !e.target.closest('.pswitch')) H.sw.close(); });
  addEventListener('resize', () => { if (H.sw && H.sw.isConnected && H.sw.isOpen()) H.sw.fit(); });

  // One line under the project title: who works on it (chip, newest chat, Open chat) and a restart button when nobody is busy.
  H.paintAgent = () => {
    const box = H.agentBox; if (!box) return; const lb = X.lb(), p = ((S.proj || {}).projects || []).find(x => x.id === curId());
    box.replaceChildren(...(p ? [lb.projectMode(p), ...(p.agent ? [lb.agentLine(p), ...lb.restartButtons(p)] : [])] : []));
  };

  // ---- the inbox: what needs you, across projects ----
  H.fetchInbox = async () => { try { const d = await api('/api/inbox'); return d && Array.isArray(d.items) ? H.tidy(d.items) : null; } catch (e) { return null; } };
  // A commenter gets one row per asset: its newest version over all stages, only when that version is from the last 7 days and she has not commented on it yet.
  // Newest first. S.newBy keeps the count per project for the project switcher.
  H.tidy = items => {
    const isNew = i => i.kind === 'new' || i.kind === 'waiting';
    if (!guest()) { // an owner here can still comment elsewhere: count those new assets for the switcher
      S.newBy = {}; for (const k of new Set(items.filter(i => i.kind === 'new').map(i => i.p + '/' + i.asset))) { const p = k.split('/')[0]; S.newBy[p] = (S.newBy[p] || 0) + 1; }
      return items;
    }
    const best = new Map();
    for (const it of items) if (isNew(it)) { const k = it.p + '/' + it.asset; const o = best.get(k); if (!o || String(it.since) > String(o.since)) best.set(k, it); }
    const here = curId(), me = (S.me || {}).name, week = Date.now() - 7 * 864e5;
    const keep = [...best.values()].filter(it => {
      if (new Date(it.since).getTime() < week) return false;
      if (it.p !== here || !S.cat.assets[it.asset]) return true;
      let top = null; // the asset's newest version over all stages, from the catalog of this project
      for (const s of S.cat.stages) { const st = stageInfo(it.asset, s.id); const v = st && st.versions[st.versions.length - 1]; if (v && v.at && (!top || v.at > top.ver.at)) top = { stage: s.id, ver: v }; }
      if (top && (top.stage !== it.stage || top.ver.v !== it.v)) return false;
      const ver = top ? top.ver : null;
      return !(ver && ver.comments && (ver.comments.by || []).includes(me));
    });
    keep.sort((a, b) => String(b.since).localeCompare(String(a.since)));
    S.newBy = {}; for (const it of keep) if (!it.seen) S.newBy[it.p] = (S.newBy[it.p] || 0) + 1;
    return items.filter(i => !isNew(i)).concat(keep);
  };
  // The commenter's rows grouped per project: this project first, then the busiest. Newest first inside a group (tidy sorted them).
  const byProject = list => { const groups = new Map(); for (const it of list) { if (!groups.has(it.p)) groups.set(it.p, []); groups.get(it.p).push(it); }
    return [...groups.entries()].sort((a, b) => (b[0] === curId()) - (a[0] === curId()) || b[1].length - a[1].length); };
  const newOnes = items => ['new', 'waiting'].flatMap(k => items.filter(i => i.kind === k));
  H.newQueue = items => byProject(newOnes(items)).flatMap(g => g[1]); // the order of "New to view": what Next steps through
  const KIND_TITLE = { request: 'Requests', comments: null, stuck: 'Stuck', waiting: 'Waiting for you', new: 'New to view' };
  H.inbox = (items, part) => {
    S.more = S.more || {};
    if (!items) return null;
    const here = curId(); const cards = !guest(); // the queue cards below already show this project's waiting versions
    const by = k => items.filter(i => i.kind === k && !(k === 'waiting' && cards && i.p === here) && !(k === 'stuck' && isRest(i) && !S.showRest));
    const rest = items.filter(i => i.kind === 'stuck' && isRest(i));
    const sections = [];
    const comments = by('comments'); const who = [...new Set(comments.map(i => i.by).filter(Boolean))];
    const fresh = by('new').concat(by('waiting')), unseen = fresh.filter(i => !i.seen); // a commenter starts with what she has not opened yet; "All" stays one tap away
    const defs = (guest() ? perProject(S.showAll ? fresh : unseen) : [
      ['waiting', 'Waiting for you', items.filter(i => i.kind === 'waiting').sort((a, b) => a.rank - b.rank)],
      ['request', 'Requests', hasPro() && can('execute') ? by('request') : []], ['feedback', 'Feedback requested', can('execute') ? by('feedback') : []],
      ['comments', 'Notes from ' + (who.length === 1 ? who[0] : 'others'), comments],
      ['stuck', 'Stuck', hasPro() ? by('stuck') : []]]).filter(d => (d[0] === 'stuck') === (part === 'stuck'));
    for (const [k, title, list] of defs) {
      if (!list.length) continue;
      const lim = S.more[k] ? list.length : k === 'stuck' ? 3 : k === 'waiting' ? 8 : 4;
      sections.push(el('section', { class: 'insec ' + k.split(':')[0] }, el('h2', {}, title, el('span', { class: 'ncnt' }, list.length)),
        k === 'waiting' ? qpicker(list) : null,
        el('div', { class: 'inrows' }, list.slice(0, lim).map(it => k === 'waiting' ? qrow(it) : row(it))),
        list.length > lim ? el('button', { class: 'link more', onclick: () => { S.more[k] = true; X.renderInbox(); } }, 'Show ' + (list.length - lim)) : null));
    }
    if (part === 'stuck' && rest.length && !guest()) sections.push(el('p', { class: 'muted sm restnote' }, el('button', { class: 'link more', 'data-rest': '1', onclick: () => { S.showRest = !S.showRest; X.renderInbox(); } },
      S.showRest ? 'Hide old and rejected' : 'Show old and rejected (' + rest.length + ')'), S.showRest ? null : ' · no chat, nobody will pick these up'));
    if (guest() && part !== 'stuck' && unseen.length < fresh.length) {
      const tab = (label, n, on) => el('button', { class: 'tool sm', 'aria-pressed': String(on), onclick: () => { S.showAll = label === 'All'; X.renderInbox(); } }, label + ' ' + n);
      sections.unshift(el('div', { class: 'seg seenfilter', role: 'group', 'aria-label': 'New to view' }, tab('Unviewed', unseen.length, !S.showAll), tab('All', fresh.length, !!S.showAll)));
      if (!S.showAll && !unseen.length) sections.push(el('p', { class: 'muted' }, 'All viewed. Choose All to find something again.'));
    }
    if (!sections.length) return null;
    return el('div', { class: 'inbox' }, sections);
    // A commenter: one section per project (this project first, then the busiest), so a busy week stays readable.
    function perProject(list) { return byProject(list).map(([p, rows]) => ['new:' + p, 'New in ' + rows[0].project, rows]); }
    // Tick rows to approve several at once; the bar under the list says how many and holds the one button.
    function qkey(it) { return it.p + '|' + it.asset + '|' + it.stage + '|' + it.v; }
    function canPick() { return !guest() && can('decide') && !!X.approveMany; }
    function qpicker(list) {
      if (!canPick()) return null; S.qsel = S.qsel || new Map(); const keys = new Set(list.map(qkey)); for (const k of [...S.qsel.keys()]) if (!keys.has(k)) S.qsel.delete(k);
      const n = S.qsel.size, all = n === list.length;
      return el('div', { class: 'qbatch' + (n ? ' on' : '') }, el('button', { class: 'ghost sm', 'data-qall': '1', onclick: () => { if (all) S.qsel.clear(); else for (const it of list) S.qsel.set(qkey(it), it); X.renderInbox(); } }, all ? 'Select none' : 'Select all (' + list.length + ')'),
        n ? el('span', { class: 'qbn' }, n + ' selected') : el('span', { class: 'muted sm' }, 'Tick rows to approve them in one go'),
        n ? el('button', { class: 'primary green sm', 'data-qapprove': '1', onclick: async e => { e.currentTarget.disabled = true; await X.approveMany([...S.qsel.values()]); } }, icon('check', 16), 'Approve ' + n) : null);
    }
    function qrow(it) {
      const href = H.queueHref(it);
      const st = it.p === here && stageInfo(it.asset, it.stage), ver = st ? st.versions[it.v - 1] : null; // details only for the loaded project
      const files = ver ? ver.files : [], au = files.find(f => f.media === 'audio');
      const sub = [it.project, stageLabel(it.stage) + ' · v' + it.v, files.length > 1 ? files.length + ' files' : null, it.since ? 'waiting ' + ago(it.since, true) : null];
      const flag = (c, n, one, many) => n ? el('span', { class: 'flag', style: { '--c': 'var(--' + c + ')' } }, n + ' ' + (n === 1 ? one : many)) : null;
      const flags = !ver ? [] : [flag('blue', (ver.resolves || []).length, 'point fixed?', 'points fixed?'), flag('red', (ver.lock_check || []).filter(c => c.result !== 'unchanged').length, 'locked spot changed', 'locked spots changed'),
        flag('amber', files.flatMap(f => ((f.preflight || {}).warn) || []).length, 'warning', 'warnings')].filter(Boolean);
      const key = qkey(it), picked = canPick() && S.qsel && S.qsel.has(key);
      const tick = canPick() ? el('label', { class: 'qpick', title: 'Select to approve in one go' }, el('input', { type: 'checkbox', checked: !!picked, 'aria-label': 'Select ' + nice(it.name || it.asset) + ' ' + stageLabel(it.stage) + ' v' + it.v, onchange: e => { S.qsel = S.qsel || new Map(); if (e.target.checked) S.qsel.set(key, it); else S.qsel.delete(key); X.renderInbox(); } })) : null;
      return el('div', { class: 'inrow qrow' + (picked ? ' picked' : '') }, tick, el('a', { class: 'inlink', href, onclick: e => { if (it.p === here && S.cat.assets[it.asset] && !(e.metaKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); open(it.p, it.asset, it.stage, it.v); } } },
        rowThumb(it), el('span', { class: 'intxt' }, el('b', {}, nice(it.name || it.asset)), el('span', { class: 'insub' }, sub.filter(Boolean).join(' · ')), flags.length ? el('span', { class: 'flags' }, flags) : null)),
        au ? el('button', { class: 'ghost sq qplay', title: 'Quick listen: ' + au.name, 'aria-label': 'Play ' + au.name, onclick: e => X.quickPlay(e.currentTarget, X.dataUrl(it.asset, it.stage, it.v, au.name)) }, '▶') : null,
        canPick() ? el('button', { class: 'ghost sm qok', title: 'Approve this version. You can undo right after.', 'aria-label': 'Approve ' + nice(it.name || it.asset), onclick: async e => { e.currentTarget.disabled = true; await X.approveMany([it]); } }, icon('check', 16), 'Approve') : null);
    }
    function row(it) {
      const multi = !guest() && ((S.proj || {}).projects || []).length > 1; // a commenter's rows sit under their project
      const sub = [multi ? it.project : null, stageLabel(it.stage) + ' · v' + it.v];
      if (it.kind === 'comments') sub.unshift(it.count + (it.count === 1 ? ' note' : ' notes'));
      if (it.kind === 'stuck' && it.text) sub.unshift((isRest(it) ? (it.rest === 'afgewezen' ? 'rejected' : 'old') + ', ' : '') + (STUCK_WORD[it.text] || it.text));
      if (it.kind === 'request') sub.unshift('requested by ' + (it.by || 'someone'));
      if (it.kind === 'feedback') sub.unshift((it.by || 'Someone') + ' vraagt' + (it.text ? ': ' + (it.text.length > 70 ? it.text.slice(0, 70) + '…' : it.text) : ' for feedback'));
      if (it.since) sub.push(ago(it.since));
      const go = () => { if (it.kind !== 'request') return open(it.p, it.asset, it.stage, it.v); if (it.p === curId()) return X.openRequest(it.asset); location.href = '?p=' + encodeURIComponent(it.p) + reviewerQuery() + '#request=' + encodeURIComponent(it.asset); };
      return el('div', { class: 'inrow' }, el('button', { class: 'inlink', onclick: go },
        it.kind === 'comments' ? el('b', { class: 'avatar' }, ((it.by || '?')[0] || '?').toUpperCase()) : it.kind === 'request' ? thumbSpan(it.asset, it.stage, null) : rowThumb(it),
        el('span', { class: 'intxt' }, el('b', {}, nice(it.name || it.asset)), el('span', { class: 'insub' }, sub.filter(Boolean).join(' · ')))),
        it.kind === 'stuck' ? wakeButton(it.p, it.asset, it.stage, nice(it.name || it.asset), it.text) : null,
        ['comments', 'request'].includes(it.kind) ? null : binButton(it.p, it.asset, nice(it.name || it.asset)));
    }
  };

  // A commenter's own comments, found in the catalog (versions where her name is among the commenters).
  H.mine = () => {
    const me = (S.me || {}).name; if (!me) return [];
    const out = [];
    for (const [id, a] of Object.entries(S.cat.assets)) for (const s of S.cat.stages) { const st = stageInfo(id, s.id); if (!st) continue;
      for (const ver of st.versions) if (ver.comments && (ver.comments.by || []).includes(me)) out.push({ id, a, s, ver, n: ver.comments.total }); }
    return out.sort((x, y) => (y.ver.at || '').localeCompare(x.ver.at || ''));
  };
  H.mineView = () => { const list = H.mine(); if (!list.length) return null;
    return el('section', { class: 'insec mine' }, el('h2', {}, 'Your notes', el('span', { class: 'ncnt' }, list.length)),
      el('div', { class: 'inrows' }, list.slice(0, 6).map(m => el('div', { class: 'inrow' }, el('button', { class: 'inlink', onclick: () => pick(m.id, m.s.id, m.ver.v) },
        thumbSpan(m.id, m.s.id, m.ver), el('span', { class: 'intxt' }, el('b', {}, nice(m.a.name)), el('span', { class: 'insub' }, stageLabel(m.s.id) + ' · v' + m.ver.v + ' · ' + m.n + (m.n === 1 ? ' note' : ' notes'))))))));
  };

  // ---- hero line ----
  H.counts = (queueLen, items) => {
    const sums = H.all(); const n = k => sums.filter(s => s.kind === k).length;
    const inb = k => items ? items.filter(i => i.kind === k && !(k === 'stuck' && isRest(i))).length : 0, unseen = k => items ? items.filter(i => i.kind === k && !i.seen).length : 0;
    return { wait: guest() ? (items ? unseen('new') + unseen('waiting') : queueLen) : queueLen + (items ? items.filter(i => i.kind === 'waiting' && i.p !== curId()).length : 0),
      stuck: hasPro() ? (items ? inb('stuck') : n('stuck')) : 0, comments: items ? items.filter(i => i.kind === 'comments').reduce((t, i) => t + i.count, 0) : 0, request: hasPro() && can('execute') ? inb('request') : 0, feedback: can('execute') ? inb('feedback') : 0 };
  };
  H.line = c => {
    if (!c.wait && !c.stuck && !c.request && !c.feedback) return guest() ? 'Nothing new to view.' : 'You are all caught up. New submissions appear here.' + (c.comments ? ' ' + c.comments + (c.comments === 1 ? ' note is waiting' : ' notes are waiting') + ' for a decision.' : '');
    const p = [];
    if (c.wait) p.push(guest() ? c.wait + ' new this week' : c.wait + (c.wait === 1 ? ' version is waiting' : ' versions are waiting') + ' for you');
    if (c.stuck) p.push(c.stuck + ' vastgelopen');
    if (c.comments) p.push(c.comments + (c.comments === 1 ? ' note' : ' notes') + ' from others');
    if (c.request) p.push(c.request + (c.request === 1 ? ' aanvraag' : ' aanvragen'));
    if (c.feedback) p.push(c.feedback + ' feedback requested');
    return p.join(' · ');
  };

  // ---- this project: search, filter chips, groups by discipline ----
  // R3C-033 begin
  let catalogReturn = null;
  // Reuse the overview action so leaving a review still goes through its save guard.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey ||
        S.mode !== 'review' || !catalogReturn || catalogReturn.project !== curId() ||
        S.asset !== catalogReturn.id || S.sel || S.compare ||
        e.target?.closest?.('input,textarea,select,[contenteditable]') ||
        document.querySelector('dialog[open],#pop:not([hidden]),#viewmenu:not([hidden])')) return;
    const back = document.querySelector('.back-home');
    if (!back || !back.getClientRects().length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    catalogReturn.restore = true; back.click();
  });
  H.projectView = () => {
    S.hf = S.hf || { q: '', chip: 'all' };
    const pageSize = 100;
    let sums = []; const box = el('section', { class: 'hproject' });
    const list = el('div', { class: 'hlist' }); const chips = el('div', { class: 'qchips hchips', role: 'group', 'aria-label': 'Filter' });
    const search = el('input', { id: 'hsearch', type: 'search', class: 'hsearch', placeholder: 'Search in ' + S.cat.project, 'aria-label': 'Search in this project', value: S.hf.q, oninput: e => { S.hf.q = e.target.value; S.hf.page = 0; paint(); } });
    search.addEventListener('focus', () => { search.style.outline = '2px solid var(--blue)'; });
    search.addEventListener('blur', () => { search.style.removeProperty('outline'); });
    const previous = el('button', { class: 'ghost', onclick: () => { S.hf.page--; paint(); } }, 'Previous page');
    const next = el('button', { class: 'ghost', onclick: () => { S.hf.page++; paint(); } }, 'Next page');
    const position = el('span', { class: 'muted', role: 'status' });
    const pages = el('nav', { class: 'hpages', 'aria-label': 'Browse assets' }, previous, position, next);
    // R3C-015 begin
    // Fold comparison strings only; keep catalog IDs, displayed names and filters intact.
    const searchText = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const match = s => !S.hf.q.trim() || searchText(s.name + ' ' + s.id + ' ' + s.text + ' ' + (GROUPS.find(g => g[0] === s.group) || [])[1]).includes(searchText(S.hf.q.trim()));
    // R3C-015 end
    function paint() {
      const focused = box.contains(document.activeElement) ? document.activeElement : null;
      sums = H.all();
      const inChip = (s, k) => k === 'all' ? s.kind !== 'rest' : s.kind === k;
      const count = k => sums.filter(s => match(s) && inChip(s, k)).length;
      const filters = CHIPS.filter(([k]) => (hasPro() || !['agent', 'stuck', 'rest'].includes(k)) &&
        !(guest() && k === 'stuck') && !(k === 'rest' && !count('rest')));
      if (!filters.some(([k]) => k === S.hf.chip)) { S.hf.chip = 'all'; S.hf.page = 0; }
      chips.replaceChildren(filters.map(([k, label]) => el('button', { class: 'qchip' + (S.hf.chip === k ? ' on' : ''), 'data-chip': k, 'aria-pressed': String(S.hf.chip === k), onclick: () => { S.hf.chip = k; S.hf.page = 0; paint(); } }, guest() ? ({ wait: 'New', agent: 'In progress' }[k] || label) : label, el('span', { class: 'n' }, count(k)))));
      const shown = sums.filter(s => match(s) && inChip(s, S.hf.chip));
      const order = GROUPS.map(g => g[0]).concat([...new Set(sums.map(s => s.group))].filter(g => !GROUPS.some(x => x[0] === g)));
      // Break display-name ties by exact ID before slicing the complete catalog.
      const groups = order.map(g => ({ g, rows: shown.filter(s => s.group === g).sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.name.localeCompare(y.name, 'nl') || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)) }));
      const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
      S.hf.page = Math.max(0, Math.min(S.hf.page || 0, pageCount - 1));
      // Slice the ordered catalog across disciplines, so the limit applies to the entire project.
      let offset = 0; const start = S.hf.page * pageSize;
      const parts = groups.map(({ g, rows }) => { const from = Math.max(0, start - offset), first = offset + from;
        const visible = rows.slice(from, Math.max(0, start + pageSize - offset)); offset += rows.length; if (!visible.length) return null;
        const label = (GROUPS.find(x => x[0] === g) || [])[1] || nice(g);
        return el('section', { class: 'hgroup' }, el('h3', {}, label, el('span', { class: 'ncnt' }, rows.length)), el('div', { class: 'arows' }, visible.map((s, i) => arow(s, first + i + 1, shown.length)))); });
      // R3C-051 begin
      list.replaceChildren(parts.some(Boolean) ? parts : el('div', { class: 'hempty' },
        el('p', { class: 'muted' }, sums.length ? 'No assets found with this search or filters.' : 'No work in this project yet.'),
        sums.length ? el('button', { class: 'ghost', onclick: () => {
          S.hf.q = ''; S.hf.chip = 'all'; S.hf.page = 0;
          search.value = ''; paint(); search.focus();
        } }, 'Show all assets') : null));
      // R3C-051 end
      previous.disabled = S.hf.page === 0; next.disabled = S.hf.page === pageCount - 1;
      position.textContent = (shown.length ? start + 1 : 0) + '–' + Math.min(start + pageSize, shown.length) + ' of ' + shown.length + ' · Page ' + (S.hf.page + 1) + ' of ' + pageCount;
      pages.hidden = shown.length <= pageSize;
      // Repaint replaces rows/chips, and a page boundary can disable the pressed control.
      if (focused && (!focused.isConnected || focused.disabled || focused.closest('[hidden]'))) {
        const target = focused.dataset.asset ? assetButton(focused.dataset.asset) :
          focused.dataset.chip ? [...chips.children].find(b => b.dataset.chip === focused.dataset.chip) :
          focused === previous || focused === next ? (!pages.hidden && (!next.disabled ? next : !previous.disabled ? previous : null)) : null;
        (target || search).focus();
      }
    }
    const assetButton = id => [...list.querySelectorAll('.arow-main')].find(b => b.dataset.asset === id);
    function arow(s, position, total) {
      const sel = s.ver ? s.ent[0] : null;
      return el('div', { class: 'arow ' + s.kind },
        el('button', { class: 'arow-main', title: s.name, 'data-asset': s.id,
          'aria-label': s.name + ' · Asset ' + position + ' of ' + total + ' · ' + s.text + ' · ' + s.approved + ' of ' + s.total + ' stages approved',
          onclick: e => {
            const keyboard = e.detail === 0;
            catalogReturn = keyboard ? { id: s.id, project: curId() } : null;
            Promise.resolve(pick(s.id, s.stage || undefined)).then(() => {
              if (keyboard && S.mode === 'review' && S.asset === s.id) document.querySelector('.back-home')?.focus();
            });
          } },
          thumbSpan(s.id, sel ? sel.s.id : null, s.ver),
          el('span', { class: 'arow-txt' }, el('span', { class: 'rowname' }, s.name), el('span', { class: 'arow-st' }, s.text),
            el('span', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(s.pct), 'aria-label': s.approved + ' of ' + s.total + ' stages approved' }, el('i', { style: { width: s.pct + '%' } })))),
        s.kind === 'stuck' ? wakeButton(curId(), s.id, s.stage, s.name, s.reason) : null,
        binButton(curId(), s.id, s.name));
    }
    box.addEventListener('keydown', e => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !e.target.closest('.arow-main')) return;
      const rows = [...list.querySelectorAll('.arow-main')], i = rows.indexOf(e.target.closest('.arow-main'));
      const at = { ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: rows.length - 1 }[e.key];
      if (at == null) return;
      e.preventDefault(); e.stopPropagation(); rows[Math.max(0, Math.min(at, rows.length - 1))].focus();
    });
    box.repaint = paint; S.hproj = box;
    box.append(el('div', { class: 'hhead' }, el('h2', {}, S.cat.project), X.archive ? X.archive() : null, el('div', { class: 'hfind' }, search)), (H.agentBox = hasPro() ? el('div', { class: 'hagent' }) : null), chips, list, pages); paint(); H.paintAgent();
    if (catalogReturn?.restore && catalogReturn.project === curId()) {
      const id = catalogReturn.id; catalogReturn = null;
      // showHome inserts this newly built section after projectView returns.
      queueMicrotask(() => { if (box.isConnected && S.mode === 'home') (assetButton(id) || search).focus(); });
    }
    return box;
  };
  // R3C-033 end
  return H;
}

// R3I-013 begin
export function quickReviewEntry({ el, count, open }) {
  return count ? el('button', { class: 'ghost quick-entry', onclick: open }, 'Quick review · ' + count) : null;
}
// R3I-013 end
