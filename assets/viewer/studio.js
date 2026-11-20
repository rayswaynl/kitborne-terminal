// New work: pick a discipline (tile), then the route within it. An owner (also one who is not admin) starts the agent herself; credits stay admin-only.
// The studio list shows jobs; older requests wait there for Start / Weiger.
const TILES = [
  ['game', 'Game', 'Game, feature or level', ['game', 'feature', 'level'], 'Describe the game, feature or level: what does the player do?'],
  ['web', 'Website', 'Page or site', ['web'], 'Describe the page or site: who is it for and what should the visitor do?'],
  ['sound', 'Sound', 'Effects, music or voice', ['sfx', 'music', 'voice', 'audio'], 'Describe the sound: where do you hear it and how should it feel?'],
  ['video', 'Video', 'Video or short clip', ['video', 'clip'], 'Describe the video: goal, length and audience.'],
  ['story', 'Story & print', 'Game, book or PDF', ['story'], 'Describe the story or print: number of players, play time and mood.'],
  ['asset', 'Asset', 'Prop, character, 2D or VFX', ['prop', 'character', 'sprite', 'vfx', 'full'], 'Describe what you want: shape, style and purpose.'],
];
const ROUTE_LABEL = { sfx: 'SFX set', music: 'Music', voice: 'Voice-over', audio: 'Single sound', video: 'Video', clip: 'Short clip', game: 'Whole game', feature: 'Feature', level: 'Level', web: 'Website', story: 'Story & print', prop: 'Prop', character: 'Character', sprite: 'Sprite / 2D', vfx: 'VFX', full: 'Full asset' };
export const STUDIO_ROUTES = ROUTE_LABEL;
const STATUS = { request: 'Request · waiting for approval', waiting: 'Waiting for a free slot', running: 'Agent working…', turn_done: 'Turn done', failed: 'Failed', stopped: 'Stopped' };
const STYLE_TILES = ['game', 'asset'];

export function makeStudio(X) {
  const { S, el, api, toast, $, withP, hasPro, refPicker, micButton, reviewer, can, guest } = X;
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let fetching = null, styles = null;
  const styleName = id => ((styles || []).find(s => s.id === id) || {}).name || id;

  async function refreshStudio() {
    if (fetching) return fetching;
    if (!hasPro() || S.mode !== 'home' || document.hidden) return;
    fetching = (async () => { try {
      const data = await api('/api/studio'); const section = $('#studio');
      styles = data.prototype_styles || [];
      if (S.mode !== 'home' || !section) return;
      const jobs = guest() ? [] : data.jobs; section.hidden = !jobs.length;
      section.replaceChildren(el('h2', { class: 'queuehead' }, 'In the studio'), el('div', { class: 'studio-cards' }, jobs.map(j => card(j))));
    } catch (e) { /* the next visible overview poll retries */ }
    })();
    try { await fetching; } finally { fetching = null; }
  }
  function card(j) {
    const isReq = j.status === 'request';
    const message = typeof j.last_message === 'string' ? j.last_message.slice(0, 280) : '';
    const currentMessage = j.last_message_is_current === true;
    const status = isReq ? (can('execute') ? 'Request from ' + (j.by || 'someone') + ' · waiting for you' : 'Requested · waiting for the owner') : j.status === 'turn_done' && j.waiting_review ? 'Turn done · waiting for you' : STATUS[j.status] || j.status;
    const act = async (path, ok, bad) => { try { const r = await post(path, { asset: j.aid }); if (!r.ok) throw new Error(r.error); toast(ok, 5000); refreshStudio(); } catch (e) { toast(bad + ': ' + e.message, 7000); } };
    const decide = done => can('execute') ? [el('button', { class: 'primary sm', onclick: () => { done(); act('/api/studio/approve', 'Agent started for ' + (j.name || j.aid) + '.', 'Could not start'); } }, 'Start'),
      el('button', { class: 'ghost', onclick: () => confirm('Request ' + (j.name || j.aid) + ' weigeren?') && (done(), act('/api/studio/reject', 'Request declined.', 'Could not decline')) }, 'Decline')] : [];
    const buttons = isReq ? [el('button', { class: 'ghost', onclick: () => viewRequest(j, decide) }, 'View request'), ...decide(() => {})]
      : j.status === 'stopped' ? [] : [el('button', { class: 'ghost', onclick: () => confirm('Agent for ' + (j.name || j.aid) + ' stoppen?') && act('/api/studio/stop', 'Agent stopped.', 'Could not stop') }, 'Stop')];
    return el('article', { class: 'studio-card' + (isReq ? ' request' : ''), 'data-request': j.aid, tabindex: '-1' }, el('h3', {}, j.name || j.aid), el('p', { class: 'muted sm' }, j.kind === 'project' ? 'Takes over the open work of this project' : j.aid + ' · ' + (ROUTE_LABEL[j.route] || j.route) + (j.prototype_style ? ' · ' + styleName(j.prototype_style) : '')),
      el('p', { class: 'studio-status', role: 'status' }, status), el('time', { class: 'muted sm', datetime: j.created }, (isReq ? 'Requested: ' : 'Started: ') + new Date(j.created).toLocaleString('en-GB')),
      isReq && j.text ? el('p', { class: 'studio-message' }, String(j.text).slice(0, 280)) : Object.hasOwn(j, 'last_message') ? [
        el('p', { class: 'studio-message' }, currentMessage ? message : j.current_run ? 'No answer in this run yet.' : ''),
        !isReq && !currentMessage && message ? el('p', { class: 'studio-message muted sm' }, (j.last_message_is_current === false && j.last_message_run ? 'Previous run (' + j.last_message_run + '): ' : 'Answer · run unknown: ') + message) : null] : null,
      buttons.length ? el('div', { class: 'drow' }, buttons) : null);
  }

  // The whole request in one place: full description, style, example images and credits, with Start / Weiger next to it.
  function viewRequest(j, decide) {
    const sec = (title, ...body) => [el('h3', {}, title), ...body];
    const img = n => withP('/api/studio/ref?asset=' + encodeURIComponent(j.aid) + '&name=' + encodeURIComponent(n));
    const credits = (j.credits || {}).allowed ? 'May use credits, maximum ' + j.credits.max : 'No credits allowed';
    const d = el('dialog', { class: 'rounddlg studiodlg reqdlg', 'aria-labelledby': 'req-heading' }, el('h2', { id: 'req-heading' }, j.name || j.aid),
      el('p', { class: 'muted sm' }, 'Request from ' + (j.by || 'someone') + ' · ' + (ROUTE_LABEL[j.route] || j.route) + ' · ' + new Date(j.created).toLocaleString('en-GB')),
      ...sec('Description', el('p', { class: 'studio-message' }, j.text || '')),
      ...(j.style ? sec('Style or notes', el('p', { class: 'studio-message' }, j.style)) : []),
      ...(j.prototype_style ? sec('Prototype style', el('p', {}, styleName(j.prototype_style) + (j.prototype_loop ? ' · with core loop proposal' : ''))) : []),
      ...((j.refs || []).length ? sec('Examples', el('div', { class: 'reqrefs' }, j.refs.map(n => el('a', { href: img(n), target: '_blank', rel: 'noopener', title: 'Open large' }, el('img', { src: img(n), alt: 'Example ' + n }))))) : []),
      ...sec('Credits', el('p', {}, credits)),
      el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Close'), el('span', { class: 'grow' }), ...decide(() => d.close())));
    d.onclick = e => { if (e.target === d) d.close(); };
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  }

  async function newStudio() {
    if (!hasPro()) return;
    let studio = null;
    try { studio = await api('/api/studio'); } catch (e) { toast('Could not load styles: ' + e.message, 7000); } // open anyway: a saved choice stays until a retry or explicit change
    if (styles === null && studio) styles = studio.prototype_styles || [];
    const admin = can('execute'), direct = can('decide'), routes = (S.cat && S.cat.routes) || {};
    const text = el('textarea', { class: 'sum', rows: '4', maxlength: '4000', required: true, id: 'studio-text' });
    const name = el('input', { id: 'studio-name', maxlength: '200' });
    const style = el('textarea', { class: 'sum', rows: '2', maxlength: '4000', id: 'studio-style' });
    const error = el('p', { class: 'studio-error', role: 'alert' });
    const refs = refPicker(text, 6, e => { error.textContent = e; });
    const max = el('input', { id: 'studio-credits', type: 'number', min: '1', step: '1', value: '10' });
    const creditBox = el('label', { class: 'studio-field', hidden: true }, 'Max credits', max);
    const allowed = el('input', { type: 'checkbox', onchange: () => { creditBox.hidden = !allowed.checked; } });
    const mic = micButton(text);
    let tile = null, route = null;
    let pstyle = '', ploop = false;
    // The draft lives on this device per person and project until the request is sent or "Concept verwijderen": Escape, a tap outside or a phone call lose nothing.
    const key = 'ar-draft:' + ((S.me && S.me.person) || 'local') + ':' + (new URLSearchParams(location.search).get('p') || (S.proj || {}).home || S.cat.project);
    let draft = null; try { draft = JSON.parse(localStorage.getItem(key)); } catch (e) { /* no usable draft */ }
    const draftNote = el('div', { class: 'studio-draft', role: 'status', hidden: true }, el('span'), el('button', { class: 'link', onclick: () => { localStorage.removeItem(key); [text, name, style].forEach(f => { f.value = ''; }); refs.set([]); pstyle = ''; ploop = false; draftNote.hidden = true; step1(); } }, 'Delete draft'));
    const save = () => {
      const data = { tile: tile && tile[0], route, text: text.value, name: name.value, style: style.value, prototype_style: pstyle, prototype_loop: ploop, refs: refs.data || [], at: new Date().toISOString() };
      const filled = data.text || data.name || data.style || data.refs.length || pstyle; let kept = true;
      if (!filled) localStorage.removeItem(key);
      else try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { // examples can be too big for the browser store: keep the words
        kept = !data.refs.length; try { localStorage.setItem(key, JSON.stringify({ ...data, refs: [] })); } catch (e2) { kept = false; } }
      draftNote.hidden = !filled; draftNote.firstChild.textContent = kept ? 'Draft saved on this device.' : 'Draft saved, but the examples did not fit.';
    };
    for (const f of [text, name, style]) f.addEventListener('input', save);
    const body = el('div', { class: 'studio-body' });
    const field = (label, control) => el('label', { class: 'studio-field' }, label, control);
    const loopBox = el('input', { type: 'checkbox', onchange: () => { ploop = loopBox.checked; save(); } });
    const loopRow = el('label', { class: 'studio-allow' }, loopBox, 'Add a core loop proposal (proposal only)');
    const blockedStyle = () => pstyle && STYLE_TILES.includes(tile[0]) && !(styles || []).some(s => s.id === pstyle);
    const setStyle = id => { pstyle = id; if (!id) ploop = false; step2(); save(); };
    const choice = (id, title, summary, extra) => {
      const radio = el('input', { type: 'radio', name: 'pstyle', value: id, onchange: () => setStyle(id) }); radio.checked = id === pstyle;
      return el('div', { class: 'pcard' }, el('label', {}, radio, el('span', { class: 'pbody' }, el('b', {}, title), el('span', { class: 'muted sm' }, summary))), ...extra);
    };
    const picker = () => {
      if (!STYLE_TILES.includes(tile[0]) || (styles !== null && !styles.length && !pstyle)) return null;
      loopRow.hidden = !pstyle; loopBox.checked = ploop;
      return el('fieldset', { class: 'pstyle' }, el('legend', {}, 'Prototype style (optional)'), choice('', 'No fixed style', 'The agent picks a style.', []),
        ...((styles || []).map(s => choice(s.id, s.name, s.summary, [s.thumb ? el('img', { class: 'psthumb', src: s.thumb, alt: '', loading: 'lazy', width: '160', height: '90' }) : null, el('span', { class: 'pswatches' }, s.palette.map(c => el('i', { style: { background: c.hex }, title: c.name + ' ' + c.hex }))),
          el('p', { class: 'psrc muted sm' }, 'Sources: ', ...s.sources.flatMap((x, i) => [i ? ' · ' : '', el('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.label)]))]))),
        blockedStyle() ? choice(pstyle, 'Saved style: ' + pstyle, 'Your choice stays saved. Sending waits until it is restored or you deliberately choose another.', []) : null,
        styles === null || blockedStyle() ? el('div', { role: 'alert' }, el('p', {}, 'Style data not available. Your draft stays saved.'),
          el('button', { class: 'ghost', onclick: async e => {
            const button = e.currentTarget; button.disabled = true;
            try { styles = (await api('/api/studio')).prototype_styles || []; step2(); }
            catch (err) { button.disabled = false; }
          } }, 'Reload styles')) : null, loopRow);
    };
    const send = el('button', { class: 'primary', onclick: async () => {
      if (blockedStyle()) { error.textContent = 'Reload the styles or deliberately choose another style.'; return; }
      if (!text.reportValidity() || (admin && allowed.checked && !max.reportValidity())) return;
      if (refs.loading) { error.textContent = 'Wait until the examples have loaded.'; return; }
      send.disabled = true; error.textContent = '';
      try {
        const r = await post('/api/studio', { text: text.value, name: name.value, route, style: style.value, ...(pstyle && STYLE_TILES.includes(tile[0]) ? { prototype_style: pstyle, prototype_loop: ploop } : {}), refs: refs.data || [], credits: { allowed: admin && allowed.checked, max: admin && allowed.checked ? Number(max.value) : null }, by: reviewer() });
        if (!r.ok) throw new Error(r.error);
        localStorage.removeItem(key); d.close(); refreshStudio();
        toast(r.status === 'request' ? 'Request sent. The owner sees it under Requests.' : 'Agent started for ' + r.asset + '. You can follow progress in the studio.', 7000);
      } catch (e) { error.textContent = (direct ? 'Start' : 'Request') + ' failed: ' + e.message; send.disabled = false; }
    } }, direct ? 'Start agent' : 'Ask the owner');
    const tiles = () => el('div', { class: 'tiles', role: 'group', 'aria-label': 'Kind of work' }, TILES.map(t => el('button', { class: 'wtile', onclick: () => pick(t) }, el('b', {}, t[1]), el('span', { class: 'muted sm' }, t[2]))));
    const form = () => [el('button', { class: 'link back', onclick: () => step1() }, '\u2039 Other kind'), draftNote,
      TILES.indexOf(tile) >= 0 && tile[3].filter(r => routes[r]).length > 1 ? el('div', { class: 'seg routes', role: 'group', 'aria-label': 'Kind' }, tile[3].filter(r => routes[r]).map(r => el('button', { class: 'tool sm', 'aria-pressed': String(r === route), onclick: () => { route = r; step2(); save(); } }, ROUTE_LABEL[r] || routes[r].label))) : null,
      field('Description', text), mic, field('Name (optional)', name), field('Style or notes (optional)', style), picker(),
      el('p', { class: 'muted sm' }, 'Examples · paste (Ctrl+V), pick or take a photo · maximum 6'), refs.button, refs.thumb,
      admin ? [el('label', { class: 'studio-allow' }, allowed, 'May use credits (Tripo/Meshy/Higgsfield)'), creditBox] : el('p', { class: 'muted sm' }, 'The agent starts right away. Paid tools (credits) are off.'), error,
      el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Cancel'), el('span', { class: 'grow' }), send)];
    const step1 = () => { tile = null; body.replaceChildren(tiles()); h.textContent = direct ? 'What do you want to make?' : 'What do you want to request?'; };
    const step2 = () => { text.placeholder = tile[4]; send.disabled = !!blockedStyle(); body.replaceChildren(...form().flat().filter(Boolean)); h.textContent = tile[1]; };
    const pick = t => { tile = t; route = t[3].find(r => routes[r]) || t[3][0]; step2(); text.focus(); save(); };
    const h = el('h2', { id: 'studio-heading' });
    const d = el('dialog', { class: 'rounddlg studiodlg', 'aria-labelledby': 'studio-heading' }, h, body);
    const was = draft && TILES.find(t => t[0] === draft.tile);
    if (was) {
      tile = was; route = was[3].includes(draft.route) ? draft.route : was[3].find(r => routes[r]) || was[3][0];
      text.value = String(draft.text || ''); name.value = String(draft.name || ''); style.value = String(draft.style || ''); refs.set(Array.isArray(draft.refs) ? draft.refs.slice(0, 6) : []);
      pstyle = typeof draft.prototype_style === 'string' ? draft.prototype_style : ''; ploop = !!pstyle && draft.prototype_loop === true;
      step2(); draftNote.hidden = false; draftNote.firstChild.textContent = 'Draft from ' + new Date(draft.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' restored.';
    } else step1();
    new MutationObserver(save).observe(refs.thumb, { childList: true });
    d.onclick = e => { const b = d.getBoundingClientRect(); if (e.target === d && (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)) d.close(); };
    d.addEventListener('close', () => { if (mic && mic.rec) mic.rec.stop(); d.remove(); }); document.body.append(d); d.showModal();
  }
  return { newStudio, refreshStudio };
}
