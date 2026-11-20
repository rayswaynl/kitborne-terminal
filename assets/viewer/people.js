// Asset Review v2: who is looking (person chip, roles) and guest comments.
// A commenter's pointing tools create comments (a sidecar file per person, autosaved); the owner sees them next to his own notes
// and adopts (Neem over) or dismisses (Negeer) them. Only adopted notes reach the agent, through the owner's review.
import { makeSync } from './merge.js';
const CS = makeSync(['status', 'adopted_as', 'by_status', 'reason']); // what the admin does with a comment is not an edit by the commenter
export const initialOf = name => (String(name || '?').trim()[0] || '?').toUpperCase();
export const ROLE_WORD = { commenter: 'reviewer', owner: 'owner' };
export const GUEST_COLORS = { guest: ['Note from someone else', '#b78cff'], guestoff: ['Adopted or ignored', '#6c7080'] };

// "Name · reviewer". The local admin gets no chip: that is the normal situation.
export function personChip(el, me) {
  if (!me || me.admin) return null;
  return el('span', { class: 'person-chip', title: me.name + ' is viewing on ' + (me.device || 'this device') },
    el('b', { class: 'avatar' }, initialOf(me.name)), me.name, el('span', { class: 'prole' }, el('span', { class: 'sep' }, '·'), ' ' + (ROLE_WORD[me.role] || me.role)));
}

const c2n = c => ({ ...c, verdict: 'change', priority: 'med', created: c.at });
const n2c = n => ({ id: n.id, cid: n.cid, mark: n.mark, text: n.text, target: n.target, view: n.view || null, crop: n.crop || null, ref: n.ref || null, voice: n.voice || null, at: n.created || n.at, status: n.status || 'open' });

export function makeComments(X) {
  const { S, el, icon, api, toast, describe, withP } = X;
  const M = { busy: false };
  M.guest = () => !!S.me && !S.me.can.decide;
  M.can = what => !S.me || !!S.me.can[what]; // old servers send no identity: everything stays as it was
  const raw = async (path, body, keepalive) => {
    const r = await fetch(withP(path), { method: 'POST', keepalive: !!keepalive, signal: keepalive ? undefined : AbortSignal.timeout(60000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch (e) { /* no body */ }
    return { status: r.status, json };
  };
  M.raw = raw;

  // ---- load ----
  // Everybody's comments for this version. A commenter keeps only her own file (and its rev); the owner keeps the others.
  M.load = async () => {
    S.cdocs = {}; S.crev = 0; S.cfiles = {};
    let d; try { d = await api('/api/comments?asset=' + S.asset + '&stage=' + S.stage + '&v=' + S.v); } catch (e) { d = { people: {} }; }
    S.cdocs = d.people || {};
    const mine = S.me && S.cdocs[S.me.person]; S.crev = mine ? mine.rev || 0 : 0;
    return mine || null;
  };
  M.guestReview = mine => { const rv = { asset: S.asset, stage: S.stage, version: S.v, verdict: 'pending', summary: '', notes: ((mine || {}).comments || []).map(c2n), checklist: {}, followups: [], reviewer: S.me.name, guest: true }; S.cbase = CS.snap(rv.notes); return rv; };
  // the others' comments of this version (never my own)
  M.others = () => Object.values(S.cdocs || {}).filter(p => !S.me || p.person !== S.me.person).filter(p => (p.comments || []).length);
  M.openCount = () => M.others().reduce((n, p) => n + p.comments.filter(c => c.status === 'open').length, 0);
  // note-shaped copies for the canvas: purple with the initial while open, grey once adopted or dismissed
  M.markers = fileName => M.others().flatMap(p => p.comments.filter(c => (c.target || {}).file === fileName || (!(c.target || {}).file && S.file === 0))
    .map(c => ({ ...c, id: 'g:' + p.person + ':' + c.id, mark: initialOf(p.name), verdict: c.status === 'open' ? 'guest' : 'guestoff', guest: true, person: p.person })));

  // A commenter's open screen: take over what the owner did with my comments (Neem over, Negeer) and never touch the text I am typing.
  M.refresh = async () => {
    if (!S.review || !S.review.guest || !S.me) return;
    const at = [S.asset, S.stage, S.v].join('/');
    let d; try { d = await api('/api/comments?asset=' + S.asset + '&stage=' + S.stage + '&v=' + S.v); } catch (e) { return; }
    if (!S.review || !S.review.guest || [S.asset, S.stage, S.v].join('/') !== at) return; // the reviewer moved on meanwhile
    S.cdocs = d.people || {};
    const mine = S.cdocs[S.me.person]; if (!mine) return;
    const settled = [], lost = [];
    for (const c of mine.comments || []) {
      const n = S.review.notes.find(x => x.id === c.id && !x._new); if (!n || n.status === c.status) continue;
      if (c.status !== 'open' && n.text !== c.text) { n.text = c.text; lost.push(n.mark); } // an edit not saved yet cannot be kept on a settled comment
      Object.assign(n, { status: c.status, adopted_as: c.adopted_as, by_status: c.by_status, reason: c.reason });
      if (c.status !== 'open') settled.push(n.mark);
      M.stale = true;
    }
    const now = CS.snap((mine.comments || []).map(c2n)), base = S.cbase; // only statuses changed on the server: its revision is still mine to save on
    if (base && now.size === base.size && [...now].every(([k, v]) => base.get(k) === v)) S.crev = mine.rev || 0;
    if (settled.length) toast(S.review.notes.find(n => n.mark === settled[0]).by_status + ' has viewed note ' + settled.join(', ') + ' bekeken.' + (lost.length ? ' Your last change was not included.' : ''), 6000);
    if (M.stale && !document.querySelector('#pop:not([hidden]), #sidescroll textarea:focus')) { M.stale = false; X.refreshMarks(); X.renderSide(); }
  };

  // ---- save (commenter) ----
  M.save = async leaving => {
    if (M.saving && !leaving) { await M.saving; if (!S.pendingSave) return; }
    if (!S.review || !S.review.guest) return;
    const rv = S.review, g = S.gen;
    X.keepDraft(); S.pendingSave = false; clearTimeout(S.saveT); M.busy = true;
    const files = { ...S.cfiles }; const sent = rv.notes.map(n => ({ ...n })); const sentSnap = CS.snap(sent);
    const body = { asset: rv.asset, stage: rv.stage, version: rv.version, base_rev: S.crev, comments: sent.map(n2c), files };
    M.saving = raw('/api/comment', body, leaving);
    try {
      const r = await M.saving;
      if (S.review !== rv) return;
      if (r.status === 409 && r.json && r.json.conflict) { M.conflict(r.json.current || {}); return; }
      if (!r.json || !r.json.ok) throw new Error((r.json && r.json.error) || 'error ' + r.status);
      S.crev = r.json.rev; S.cbase = sentSnap; rv.updated = r.json.updated || new Date().toISOString();
      for (const k of Object.keys(files)) if (S.cfiles[k] === files[k]) delete S.cfiles[k];
      for (const n of rv.notes) delete n._new;
      const server = (r.json.comments || []).map(c2n);
      const merged = CS.merge(server, rv.notes, sentSnap, { edit: (srv, mine) => ({ ...mine, status: srv.status, adopted_as: srv.adopted_as, by_status: srv.by_status, reason: srv.reason }) });
      rv.notes = merged.map(n => { const local = rv.notes.find(c => c.id === n.id); return local ? Object.assign(local, n) : n; });
      S.cbase = CS.snap(server);
      X.confirmed(g);
    } catch (e) {
      if (S.review === rv) { S.pendingSave = true; const kept = X.keepDraft(); toast('Could not save (' + e.message + '). ' + (kept ? 'Your draft is saved on this device.' : 'Not saved. Keep this screen open until saving works.'), 5000); S.saveT = setTimeout(() => { if (S.review === rv) M.save().catch(() => {}); }, 4000); }
      throw e;
    } finally { M.busy = false; M.saving = null; }
    if (S.review !== rv) return;
    if (!S.pendingSave) { X.refreshMarks(); X.renderSide(); }
    X.afterSave();
    if (S.pendingSave) { clearTimeout(S.saveT); S.saveT = setTimeout(() => { if (S.review === rv) M.save().catch(() => {}); }, 300); }
  };
  // Another screen of mine saved first: take that version and put back only the comments I added, edited or deleted here since my last save.
  M.conflict = (cur, retainedFiles) => {
    toast('This was just changed on another screen', 6000);
    const server = (cur.comments || []).map(c2n); const pid = S.me.person;
    const before = { ...S.cfiles }, moved = new Map(); // read every attachment from before the renumbering: C1->C2 must not overwrite C2's own file
    const renumber = (n, mark) => {
      n.mark = mark; n.id = 'C' + mark;
      for (const k of ['crop', 'ref', 'voice']) if (n[k]) { const to = (k === 'voice' ? 'voice/' : 'crops/') + pid + '/' + n.id + (k === 'voice' ? '.' + n[k].split('.').pop() : k === 'ref' ? '_ref.jpg' : '.png'); if (before[n[k]]) { S.cfiles[to] = before[n[k]]; moved.set(n[k], to); } n[k] = to; }
    };
    const base = S.cbase || new Map(), known = new Map(); // the server took this comment but its answer got lost: it keeps the server's number, my fields win
    for (const n of S.review.notes) { const same = n.cid && !base.has(n.id) && server.find(c => c.cid === n.cid); if (same) { if (same.id !== n.id) renumber(n, same.mark); known.set(n.id, n); } }
    const rest = S.review.notes.filter(n => known.get(n.id) !== n);
    if (retainedFiles) { // restore each draft with its own attachments before combining files
      let mark = Math.max(0, ...server.map(n => n.mark || 0), ...S.review.notes.map(n => n.mark || 0));
      for (const n of rest) if (!base.has(n.id) && server.some(c => c.id === n.id)) renumber(n, ++mark);
    }
    const edit = (srv, mine) => ({ ...mine, status: srv.status, adopted_as: srv.adopted_as, by_status: srv.by_status, reason: srv.reason }); // the admin's choice about it stays
    S.review.notes = CS.merge(server, rest, base, { renumber, edit }).map(c => known.has(c.id) ? edit(c, known.get(c.id)) : c);
    const targets = new Set(moved.values()); for (const from of moved.keys()) if (!targets.has(from)) delete S.cfiles[from]; // the server keeps its own file under the old name
    S.cfiles = { ...retainedFiles, ...S.cfiles };
    S.cbase = CS.snap(server); S.crev = cur.rev || 0; S.gen = (S.gen || 0) + 1; S.pendingSave = S.unconfirmed = true; S.saveT = null;
    X.keepDraft(); X.refreshMarks(); X.renderSide(); const rv = S.review; clearTimeout(S.saveT); S.saveT = setTimeout(() => { if (S.review === rv) M.save().catch(() => {}); }, 150);
  };
  // the cut-out and the example image of a new comment go along with it, under crops/<person>/
  M.added = async (n, refData) => {
    const pid = S.me.person;
    try {
      const cap = S.view && S.view.capture ? await S.view.capture(n, X.fileNotes()) : {};
      if (cap && cap.crop) { n.crop = 'crops/' + pid + '/' + n.id + '.png'; S.cfiles[n.crop] = cap.crop; }
    } catch (e) { /* the comment text is already safe */ }
    if (refData) { n.ref = 'crops/' + pid + '/' + n.id + '_ref.jpg'; S.cfiles[n.ref] = refData; }
    X.changed();
  };
  M.savedLine = () => S.pendingSave || M.busy ? 'Saving…' : S.review.notes.length ? 'Your notes are saved · the owner sees them' : 'Point at something and write what you think. Your notes are saved automatically.';
  M.voice = (n, data) => { const ext = data.startsWith('data:audio/ogg') ? 'ogg' : 'webm'; n.voice = 'voice/' + S.me.person + '/' + n.id + '.' + ext; S.cfiles[n.voice] = data; };

  // ---- owner: the others' comments ----
  M.status = async (p, c, status, adoptedAs, reason) => {
    const r = await raw('/api/comment/status', { asset: S.asset, stage: S.stage, version: S.v, person: p.person, id: c.id, status, adopted_as: adoptedAs || null, reason: reason || null });
    if (!r.json || !r.json.ok) throw new Error((r.json && r.json.error) || 'error ' + r.status);
    Object.assign(c, { status, adopted_as: status === 'adopted' ? adoptedAs : null, by_status: S.me ? S.me.name : 'The owner', reason: status === 'dismissed' ? (r.json.comments.find(x => x.id === c.id) || {}).reason : undefined });
  };
  M.adopt = async (p, c) => {
    if (X.locked()) S.editing = true; // a sent version reopens, like after Edit
    const mark = X.nextMark();
    const n = { id: 'N' + mark, mark, verdict: 'change', priority: 'med', status: 'open', text: p.name + ': ' + c.text, target: JSON.parse(JSON.stringify(c.target)), view: c.view || undefined,
      created: new Date().toISOString(), from: { person: p.person, name: p.name, id: c.id } };
    if (c.ref) n.ref = c.ref;
    if (c.voice) n.voice = c.voice;
    S.review.notes.push(n); S.active = n.id; S.openNote = n.id;
    X.changed(); X.refreshMarks(); X.renderSide(); X.focusEditor();
    try { await X.flushSave(); await M.status(p, c, 'adopted', n.id); } catch (e) { toast('The label on ' + p.name + ' could not be set: ' + e.message, 6000); }
    X.refreshMarks(); X.renderSide();
  };
  M.dismiss = async (p, c, back, reason) => {
    try { await M.status(p, c, back ? 'open' : 'dismissed', null, reason); } catch (e) { toast('That did not work: ' + e.message, 6000); }
    X.refreshMarks(); X.renderSide();
  };
  // Phone: the decision footer covers the section, so a line in the footer says that others commented and jumps to it.
  M.jump = () => {
    const n = M.openCount(), people = M.others(); if (!n) return null;
    const who = people.length === 1 ? people[0].name + ' says' : 'Others say';
    return el('button', { class: 'guestjump', onclick: () => { const t = document.querySelector('.guestwrap'); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); } } },
      el('b', { class: 'avatar' }, initialOf(people[0].name)), who + ' (' + n + ')', icon('next', 15));
  };
  // A long comment list: Open / All chips (once something is settled) and a search field (from 6 comments). The state is shared by the commenter's and the owner's list.
  M.filtered = (list, isOpen, cls, row) => {
    const f = S.cf = S.cf || { q: '', all: true }, ol = el('ol', { class: cls }), searchable = list.length >= 6, nOpen = list.filter(isOpen).length;
    const chips = [[false, 'Open', nOpen], [true, 'All', list.length]].map(([all, label, n]) => el('button', { class: 'tool sm', 'aria-pressed': String(f.all === all), onclick: () => { f.all = all; chips.forEach((b, i) => b.setAttribute('aria-pressed', String(f.all === !!i))); show(); } }, label + ' ' + n));
    const show = () => { const q = searchable ? f.q.trim().toLowerCase() : '', vis = list.filter(c => (f.all || isOpen(c)) && (!q || String(c.text).toLowerCase().includes(q)));
      ol.replaceChildren(...(vis.length ? vis.map(c => row(c)) : [el('li', { class: 'muted sm' }, 'Nothing found.')])); };
    show();
    return [nOpen < list.length || searchable ? el('div', { class: 'cfilter' }, el('div', { class: 'seg', role: 'group', 'aria-label': 'Show notes' }, chips),
      searchable ? el('input', { type: 'search', value: f.q, placeholder: 'Search notes', 'aria-label': 'Search notes', oninput: e => { f.q = e.target.value; show(); } }) : null) : null, ol];
  };
  const dismissRow = (p, c) => { // Negeer asks for an optional one-line reason that the commenter sees
    const go = () => { S.dismissing = null; M.dismiss(p, c, false, inp.value); }, cancel = () => { S.dismissing = null; X.renderSide(); };
    const inp = el('input', { class: 'greason-in', maxlength: '200', placeholder: 'Reason (optional, ' + p.name + ' sees it)', 'aria-label': 'Reason to ignore', onclick: e => e.stopPropagation(),
      onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') go(); else if (e.key === 'Escape') cancel(); } });
    requestAnimationFrame(() => inp.focus());
    return el('div', { class: 'gact greasonrow' }, inp, el('button', { class: 'ghost sm', onclick: e => { e.stopPropagation(); go(); } }, 'Ignore'), el('button', { class: 'link', onclick: e => { e.stopPropagation(); cancel(); } }, 'Cancel'));
  };
  // inspector section: "<Name> says (n)" per person
  M.section = () => {
    const people = M.others(); if (!people.length) return null;
    return el('div', { class: 'guestwrap' }, people.map(p => {
      const open = p.comments.filter(c => c.status === 'open').length;
      return el('section', { class: 'guestsec' }, el('h3', {}, el('b', { class: 'avatar' }, initialOf(p.name)), p.name + ' says', el('span', { class: 'cnt' }, open + (open === p.comments.length ? '' : ' / ' + p.comments.length))),
        M.filtered(p.comments, c => c.status === 'open', 'gnotes', c => {
          const off = c.status !== 'open'; const key = 'g:' + p.person + ':' + c.id;
          const where = describe(c.target);
          return el('li', { class: 'gnote' + (off ? ' off' : '') + (S.active === key ? ' act' : ''), onclick: () => X.focusNote({ ...c, id: key, mark: initialOf(p.name), verdict: 'guest', guest: true }) },
            el('span', { class: 'num guest' }, initialOf(p.name)),
            el('div', { class: 'nb' }, el('div', { class: 'tg' }, where, off ? el('b', { class: 'gstate' }, c.status === 'adopted' ? 'Adopted' + (c.adopted_as ? ' as ' + c.adopted_as : '') : 'Ignored') : null),
              el('p', {}, c.text), off && c.reason ? el('p', { class: 'greason' }, 'Reason: ' + c.reason) : null,
              c.voice ? el('audio', { class: 'note-voice', controls: '', preload: 'metadata', src: X.dataUrl(c.voice), 'aria-label': 'Voice note from ' + p.name, onclick: e => e.stopPropagation() }) : null,
              c.crop ? el('img', { class: 'gcrop', src: X.dataUrl(c.crop), alt: 'Crop', loading: 'lazy', onerror: e => e.target.remove() }) : null,
              c.ref ? el('a', { class: 'nref', href: X.dataUrl(c.ref), target: '_blank', onclick: e => e.stopPropagation() }, el('img', { src: X.dataUrl(c.ref), alt: 'Example' }), 'Like this') : null,
              !off ? (S.dismissing === key ? dismissRow(p, c) : el('div', { class: 'gact' },
                el('button', { class: 'ghost sm green', title: 'Turn it into a note in your list (you can still edit it)', onclick: e => { e.stopPropagation(); M.adopt(p, c); } }, icon('check', 15), 'Adopt'),
                el('button', { class: 'ghost sm', title: 'Do nothing with it', onclick: e => { e.stopPropagation(); S.dismissing = key; X.renderSide(); } }, 'Ignore'))) :
                c.status === 'dismissed' ? el('div', { class: 'gact' }, el('button', { class: 'link', onclick: e => { e.stopPropagation(); M.dismiss(p, c, true); } }, 'Restore')) : null));
        }));
    }));
  };
  return M;
}
