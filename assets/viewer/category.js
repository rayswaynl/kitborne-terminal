// Review by category (2026-11-06): every waiting version of one category side by side, one decision per item or one for the whole category.
// Verdicts use the existing /api/review route (review.json, notes, locks, autopilot). This module owns no other write.
export const categoryOf = (cat, id) => { const a = (cat.assets || {})[id] || {}; return a.category || ((cat.routes || {})[a.route || 'full'] || {}).label || 'Other'; };
export function categoryGroups(cat, items) {
  const g = new Map(); for (const it of items) { const k = categoryOf(cat, it.id); if (!g.has(k)) g.set(k, []); g.get(k).push(it); }
  return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0], 'nl')); // stable places: a chip never jumps when its count changes
}
const WORD = { approved: 'Approved', changes: 'Change', rejected: 'Rejected' };
const isFinal = rv => !!(rv && !rv.draft && rv.verdict && rv.verdict !== 'pending');
// One decision as the review screen would save it. Approval confirms the previous version's open notes. Change adds whole-version notes
// (one per file in a set, as peach-apply does), so TASK.md and the autopilot see them. Reject writes the reason line of the review footer.
export function decisionReview(cur, prev, { asset, stage, v, files, verdict, note, reviewer, now = new Date().toISOString() }) {
  const rv = cur ? JSON.parse(JSON.stringify(cur)) : { notes: [], checklist: {}, followups: [], summary: '' };
  rv.notes = rv.notes || []; rv.followups = rv.followups || []; rv.checklist = rv.checklist || {};
  const text = String(note || '').trim(), old = String(rv.summary || '').trim();
  if (verdict === 'approved') {
    delete rv.auto;
    for (const n of (prev && prev.notes) || []) if (n.verdict !== 'approve' && !rv.followups.some(f => f.id === 'v' + (v - 1) + ':' + n.id)) rv.followups.push({ id: 'v' + (v - 1) + ':' + n.id, status: 'confirmed', text: n.text, target: n.target });
    if (text) rv.summary = [old, text].filter(Boolean).join('\n');
  } else if (verdict === 'changes') {
    let m = Math.max(0, ...rv.notes.map(n => n.mark || 0));
    const many = files.length > 1;
    for (const f of many ? files : files.slice(0, 1)) { m += 1;
      rv.notes.push({ id: 'N' + m, mark: m, verdict: 'change', priority: 'med', status: 'open', text, created: now,
        target: { file: f, selector: many ? { type: 'whole', label: 'Whole file · ' + f, per_file: true } : { type: 'whole', label: 'Whole version' } } }); }
    rv.summary = [old, text].filter(Boolean).join('\n');
  } else {
    const rest = old.startsWith('Rejected: ') || old.startsWith('Afgekeurd: ') ? old.split('\n\n').slice(1).join('\n\n') : old;
    rv.summary = ['Rejected: ' + text, rest].filter(Boolean).join('\n\n');
  }
  return Object.assign(rv, { asset, stage, version: v, reviewer, draft: false, verdict, via: 'category' });
}

export function makeCategory(X) {
  const { S, el, icon, api, toast, postReview, baseRev, thumbOf, tallThumb, SHORT, nice, ago, mediaCounts, dataUrl } = X;
  let C = null, box = null;
  const key = it => it.id + '|' + it.s.id + '|' + it.ver.v;
  const label = it => nice(it.a.name || it.id);
  const stageWord = it => (SHORT[it.s.id] || it.s.label) + ' · v' + it.ver.v;
  const items = () => X.queue().filter(it => categoryOf(S.cat, it.id) === C.name);
  const draft = it => { const k = key(it); if (!C.drafts.has(k)) C.drafts.set(k, ''); return C.drafts.get(k); };
  const H = {};
  // Entry on Today: one button per category that has waiting versions.
  H.strip = q => {
    if (!X.canDecide() || !q.length) return null;
    const groups = categoryGroups(S.cat, q);
    return el('section', { class: 'catstrip', 'aria-label': 'Review by category' }, el('h2', {}, 'Review by category'),
      el('p', { class: 'muted sm' }, 'All open items of one kind side by side. Per item or in one go for the whole category.'),
      el('div', { class: 'catchips' }, groups.map(([name, its]) => el('button', { class: 'qchip', 'data-cat': name, onclick: () => X.show(name) }, name, el('span', { class: 'n' }, its.length)))));
  };
  H.open = name => { if (!C || C.name !== name) C = { name, drafts: new Map(), done: new Map(), shared: '', busy: false }; return paint(); };
  H.active = () => C && C.name;
  // A catalog poll repaints, unless you are typing a note here.
  H.repaint = () => { if (!box || !box.isConnected) return; if (box.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { C.stale = true; return; } paint(); };
  async function decide(list, verdict, note) {
    const done = [], skipped = [];
    for (const { it, text } of list) {
      const v = it.ver.v; const get = k => api('/api/review?asset=' + encodeURIComponent(it.id) + '&stage=' + encodeURIComponent(it.s.id) + '&v=' + k);
      let cur; try { cur = await get(v); } catch (e) { skipped.push(label(it) + ' (' + e.message + ')'); continue; }
      if (isFinal(cur)) { skipped.push(label(it) + ' (already reviewed)'); continue; }
      if (verdict === 'approved' && cur && (cur.notes || []).some(n => n.verdict !== 'approve' && n.status === 'open')) { skipped.push(label(it) + ' (open notes: open the item)'); continue; }
      const prev = verdict === 'approved' && v > 1 ? await get(v - 1).catch(() => null) : null;
      const rv = decisionReview(cur, prev, { asset: it.id, stage: it.s.id, v, files: it.ver.files.map(f => f.name), verdict, note: text ?? note, reviewer: X.reviewer() });
      let out; try { out = await postReview(rv, {}, baseRev(cur)); } catch (e) { skipped.push(label(it) + (e.status === 409 ? ' (just changed)' : ' (' + e.message + ')')); continue; }
      const d = { it, verdict, text: String(text ?? note ?? '').trim(), before: cur ? JSON.parse(JSON.stringify(cur)) : null, after: out.rev }; C.done.set(key(it), d); C.drafts.delete(key(it)); done.push(d);
    }
    return { done, skipped };
  }
  async function undo(ds) {
    for (const d of ds) {
      const rv = Object.assign(d.before || { notes: [], checklist: {}, followups: [], summary: '' }, { asset: d.it.id, stage: d.it.s.id, version: d.it.ver.v, reviewer: X.reviewer(), draft: true, verdict: 'pending' });
      try { await postReview(rv, {}, d.after); C.done.delete(key(d.it)); } catch (e) { toast(e.status === 409 ? 'This was just changed on another screen. Not everything was restored.' : 'Could not restore: ' + e.message, 7000); break; }
    }
    await X.reload(); paint(); toast('Restored. This is waiting for you again.', 4000);
  }
  async function run(list, verdict, note) {
    if (C.busy) return toast('One moment: your previous decision is still being sent.', 3000);
    C.busy = true; paint();
    let res; try { res = await decide(list, verdict, note); } finally { C.busy = false; }
    await X.reload(); paint();
    const n = res.done.length, what = WORD[verdict].toLowerCase();
    toast((n === 1 ? WORD[verdict] + ': ' + label(res.done[0].it) : n + ' items ' + what) + (res.skipped.length ? '. Overgeslagen: ' + res.skipped.join(', ') : '.'), 9000, n ? ['Undo', () => undo(res.done)] : null);
    return res;
  }
  const needText = (t, input) => { if (String(t || '').trim()) return false; if (input) { input.focus(); input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); } return true; };
  function one(it, verdict, input) {
    const t = draft(it);
    if (verdict !== 'approved' && needText(t, input)) return toast(verdict === 'changes' ? 'First write what should change.' : 'First write why you reject this.', 4000);
    return run([{ it, text: t }], verdict);
  }
  function all(verdict, input) {
    const open = items(); if (!open.length) return toast('Nothing left open in this category.', 4000);
    if (verdict !== 'approved' && needText(C.shared, input)) return toast('First write one note for the whole category.', 4000);
    // An item note you typed wins over the shared note for that item.
    return run(open.map(it => ({ it, text: draft(it).trim() || C.shared })), verdict, C.shared).then(r => { if (r && r.done.length) { C.shared = ''; paint(); } });
  }
  function media(it) {
    const f = it.ver.files[0]; if (!f) return null;
    if (f.media === 'audio') return el('audio', { src: dataUrl(it.id, it.s.id, it.ver.v, f.name), controls: '', preload: 'none', 'aria-label': f.name });
    return null;
  }
  function card(it, done, single = false) {
    const th = thumbOf(it.id, it.s.id, it.ver, true), k = key(it), n = it.ver.files.length;
    const input = el('textarea', { class: 'catnote', rows: '2', maxlength: '2000', placeholder: 'Note (required for Change and Reject)', 'aria-label': 'Note on ' + label(it), value: draft(it), disabled: !!done || C.busy,
      oninput: e => { C.drafts.set(k, e.target.value); } });
    const act = (verdict, text, cls) => el('button', { class: cls, disabled: C.busy, 'data-verdict': verdict, onclick: () => one(it, verdict, input) }, text);
    return el('article', { class: 'catcard' + (done ? ' decided ' + done.verdict : ''), 'data-key': k, 'data-asset': it.id },
      el('button', { class: 'catthumb' + (tallThumb(it.ver) ? ' page-thumb' : ''), title: 'Open ' + label(it) + ' large', style: th ? { backgroundImage: 'url("' + th + '")' } : {}, onclick: () => X.pick(it.id, it.s.id) },
        th ? null : el('span', {}, ({ model: '3D-model', video: 'Video', audio: 'Sound', text: 'Text', image: 'Image', pdf: 'PDF' })[it.ver.files[0]?.media] || 'File'),
        el('span', { class: 'cbadge' }, stageWord(it)), n > 1 ? el('span', { class: 'cbadge count' }, n + ' files') : null),
      el('div', { class: 'catbody' }, el('b', { class: 'catname' }, label(it)),
        el('span', { class: 'muted sm' }, [stageWord(it), mediaCounts(it.ver.files), it.ver.at ? ago(it.ver.at) : null].filter(Boolean).join(' · ')),
        it.ver.note ? el('p', { class: 'catvnote' }, it.ver.note.length > 160 ? it.ver.note.slice(0, 160) + '…' : it.ver.note) : null, media(it)),
      done ? [el('div', { class: 'catdone', role: 'status' }, icon(done.verdict === 'approved' ? 'check' : done.verdict === 'rejected' ? 'x' : 'send', 15), WORD[done.verdict],
          el('button', { class: 'link', disabled: C.busy, onclick: () => undo([done]) }, 'Undo')), done.text ? el('p', { class: 'catvnote' }, '\u201c' + done.text + '\u201d') : null]
        : [input, el('div', { class: 'catact', role: 'group', 'aria-label': 'Decision for ' + label(it) }, act('approved', 'Approve', single ? 'primary' : 'ghost'), act('changes', 'Change', 'ghost amber'), act('rejected', 'Reject', 'ghost red'))]);
  }
  function paint() {
    C.stale = false;
    const open = items(), keys = new Set(open.map(key));
    const decided = [...C.done.values()].filter(d => !keys.has(key(d.it)));
    const groups = categoryGroups(S.cat, X.queue()); if (!groups.some(g => g[0] === C.name)) groups.push([C.name, []]); // the open category keeps its chip at 0
    groups.sort((a, b) => a[0].localeCompare(b[0], 'nl'));
    const shared = el('textarea', { class: 'sum catshared', rows: '2', maxlength: '2000', 'aria-label': 'Note for the whole category', placeholder: 'One note for all open items (required for Change all and Reject all)', value: C.shared, disabled: C.busy, oninput: e => { C.shared = e.target.value; } });
    const allBtn = (verdict, text, cls) => el('button', { class: cls, disabled: C.busy || !open.length, 'data-all': verdict, onclick: () => all(verdict, shared) }, text + ' (' + open.length + ')');
    const next = el('div', { class: 'wrap catwrap' },
      el('div', { class: 'hero' }, el('div', {}, el('h1', {}, C.name), el('p', { class: 'sub' }, open.length ? open.length + (open.length === 1 ? ' item is waiting' : ' items are waiting') + ' for you. Decisions are sent immediately.' : 'Everything in this category is reviewed.')),
        el('div', { class: 'heroact' }, el('button', { class: 'ghost', onclick: () => X.home() }, icon('back', 15), 'Today'))),
      groups.length > 1 ? el('div', { class: 'catchips', role: 'group', 'aria-label': 'Other category' }, groups.map(([name, its]) => el('button', { class: 'qchip' + (name === C.name ? ' on' : ''), 'aria-pressed': String(name === C.name), onclick: () => X.show(name) }, name, el('span', { class: 'n' }, its.length)))) : null,
      el('div', { class: 'catgrid' }, open.map(it => card(it, null, open.length === 1)), decided.map(d => card(d.it, d))),
      !open.length && !decided.length ? el('p', { class: 'muted' }, 'No open items in ' + C.name + '.') : null,
      open.length > 1 ? el('footer', { class: 'catall', 'aria-label': 'Whole category' }, el('b', {}, 'Whole category'), shared,
        el('div', { class: 'catact' }, allBtn('approved', 'Approve all', 'primary green'), allBtn('changes', 'Change all', 'ghost amber'), allBtn('rejected', 'Reject all', 'ghost red'))) : null);
    if (box && box.isConnected) box.replaceWith(next); else X.mount(next);
    box = next;
  }
  return H;
}
