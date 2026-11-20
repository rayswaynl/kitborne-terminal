// A projection of one saved version. No editor state, adoption or review writes.
const VERDICTS = { approved: 'Approved', changes: 'Changes requested', rejected: 'Rejected' };
const EVIDENCE = { measured: 'Measured', approximate: 'Approximate', unavailable: 'Not available', incomplete: 'Incomplete' };
const list = value => Array.isArray(value) ? value : [];
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const safePath = value => typeof value === 'string' && value.length > 0 && !/[\\\u0000-\u001f:#?]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');

export function sheetLinks(location, asset, stage, version) {
  const base = new URL(location);
  // Preserve the server's project/identity selectors; data never supplies a URL.
  const query = new URLSearchParams();
  for (const key of ['p', 'by']) if (base.searchParams.has(key)) query.set(key, base.searchParams.get(key));
  const versionLink = (sheet = false, note = null, person = null) => {
    const q = new URLSearchParams(query); if (sheet) q.set('sheet', '1');
    const hash = new URLSearchParams({ a: asset, s: stage, v: String(version) });
    if (note != null) hash.set('n', String(note));
    if (person != null) hash.set('c', String(person));
    return base.pathname + (q.size ? '?' + q : '') + '#' + hash;
  };
  return { version: versionLink(), sheet: versionLink(true), note: (id, person) => versionLink(false, id, person),
    file: name => safePath(name) ? '/data/' + [asset, stage, 'v' + String(version).padStart(3, '0'), ...name.split('/')].map(encodeURIComponent).join('/') + (query.size ? '?' + query : '') : null };
}

export function buildDecisionSheet({ catalog, review, comments, asset, stage, version, failures = [] }) {
  if (!safeId(asset) || !safeId(stage) || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid version');
  const item = catalog?.assets?.[asset];
  const ver = list(item?.stages?.[stage]?.versions).find(v => v.v === version);
  if (!ver) throw new Error('This version does not exist in this project');
  const missing = [...failures];
  if (review && (review.asset !== asset || review.stage !== stage || review.version !== version)) {
    missing.push('Review belongs to another version'); review = null;
  }
  const final = !!(review && !review.draft && Object.hasOwn(VERDICTS, review.verdict));
  const notes = list(review?.notes);
  const adopted = notes.filter(n => n.from?.person && n.from?.id);
  // The owner's actual note establishes adoption, even if the comment status write failed.
  const advice = Object.values(comments?.people || {}).flatMap(p => list(p.comments)
    .filter(c => !adopted.some(n => n.from.person === p.person && n.from.id === c.id))
    .map(c => ({ ...c, person: p.person, name: p.name })));
  if (advice.some(c => c.status === 'adopted')) missing.push('Adoption without a matching owner note');
  const files = list(ver.files);
  const locks = final ? notes.filter(n => n.verdict === 'approve' && n.status !== 'wontfix' &&
    n.target?.selector?.type === 'whole' && !n.target.page && files.some(f => f.name === n.target.file) && safePath(n.target.file)) : [];
  const thumbnails = new Set();
  const addThumb = name => { if (safePath(name)) thumbnails.add(name); };
  if (ver.thumb) addThumb(ver.thumb);
  const render = ver.meta?.render;
  if (render?.status === 'done' && safePath(render.hash)) for (const preview of list(render.previews)) {
    for (const name of [preview.sheet, ...list(preview.stills)]) if (safePath(name)) addThumb('renders/' + render.hash + '/' + name);
  }
  const evidence = files.map(f => ({ label: f.name + ' · file analysis', status: !f.preflight ? 'unavailable' :
    f.preflight.ok === false || f.preflight.error || list(f.preflight.block).length ? 'incomplete' : f.preflight.stats?.header_only ? 'approximate' :
    Object.values(f.preflight.stats || {}).some(value => typeof value === 'number' && Number.isFinite(value)) ? 'measured' : 'unavailable' }));
  // Optional evidence from other cards is descriptive only, never a verdict.
  for (const e of list(ver.meta?.evidence)) evidence.push({ label: e.label || 'Evidence', status: Object.hasOwn(EVIDENCE, e.status) ? e.status : 'unavailable' });
  if (ver.meta?.unverified) missing.push('This delivery is unverified');
  if (render && render.status !== 'done') evidence.push({ label: 'Turntable views', status: 'incomplete' });
  if (!evidence.length) evidence.push({ label: 'File analysis', status: 'unavailable' });
  for (const label of missing) evidence.push({ label, status: 'incomplete' });
  return { asset, stage, version, name: item.name || asset, final, review,
    verdict: final ? VERDICTS[review.verdict] : review?.draft ? 'Draft · no final decision yet' : 'Not reviewed · no final decision yet',
    open: notes.filter(n => ['change', 'reject'].includes(n.verdict) && n.status === 'open'), adopted, advice, locks,
    thumbnails: [...thumbnails], files, evidence };
}

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  for (const child of children.flat()) if (child != null) element.append(child.nodeType ? child : document.createTextNode(String(child)));
  return element;
}
function stylesheet() {
  if (document.querySelector('link[data-r3i-sheet]')) return;
  document.head.append(node('link', { rel: 'stylesheet', href: new URL('./sheet.css', import.meta.url).href, 'data-r3i-sheet': '1' }));
}

export function renderDecisionSheet(model, links) {
  const section = (key, title, rows, empty) => node('section', { 'data-sheet-section': key },
    node('h2', {}, title + ' (' + rows.length + ')'), rows.length ? node('ul', {}, ...rows) : node('p', {}, empty));
  const noteRow = (n, kind) => {
    const file = n.target?.file;
    const url = file && model.files.some(f => f.name === file) && links.file(file);
    return node('li', { 'data-sheet-row': kind, 'data-note-id': n.id }, node('p', {}, n.text || ''),
      node('a', { href: links.note(n.id) }, 'Source note ' + n.id), url ? node('a', { href: url }, file) : null);
  };
  return node('main', { class: 'decision-sheet', 'aria-label': 'Decision sheet' },
    node('header', {}, node('img', { class: 'sheet-wordmark', src: '/terminal-wordmark.svg', alt: 'Kitborne Terminal', width: '156', height: '22' }),
      node('h1', {}, model.name),
      node('p', { class: 'sheet-context' }, 'Decision sheet · ' + model.stage + ' · v' + model.version),
      node('p', {}, 'Read only · saved data for this version'), node('a', { href: links.version }, 'Back to review')),
    node('section', { 'data-sheet-section': 'verdict' }, node('h2', {}, 'Final decision'),
      node('p', { 'data-final': String(model.final) }, model.verdict),
      model.review?.summary ? node('p', {}, model.review.summary) : null,
      node('p', {}, 'Owner: ' + (model.review?.reviewer || 'Not available'))),
    section('open', 'Open change notes', model.open.map(n => noteRow(n, 'open')), 'No open change notes in the available review.'),
    section('adopted', 'Adopted advice', model.adopted.map(n => {
      const row = noteRow(n, 'adopted');
      row.append(node('p', {}, (n.from.name || n.from.person) + (model.final ? ' · adopted by owner' : ' · adopted in draft')),
        node('a', { href: links.note(n.from.id, n.from.person) }, 'Source advice ' + n.from.id));
      return row;
    }), 'No advice adopted in the available review.'),
    section('advice', 'Advice · not an owner decision', model.advice.map(c => node('li', { 'data-sheet-row': 'advice' },
      node('p', {}, (c.name || c.person) + ' · ' + (c.status === 'dismissed' ? 'Not adopted' : 'Advice')), node('p', {}, c.text || ''),
      node('a', { href: links.note(c.id, c.person) }, 'Source advice ' + c.id))), 'No separate advice available.'),
    section('locks', 'Approved whole files', model.locks.map(n => noteRow(n, 'lock')), model.final ? 'No whole files locked.' : 'Draft or not reviewed: no final file locks.'),
    section('thumbnails', 'Existing thumbnails', model.thumbnails.map(name => {
      const image = node('img', { src: links.file(name), alt: 'Thumbnail · ' + name, loading: 'lazy' });
      const row = node('li', {}, node('a', { href: links.file(name) }, image));
      image.addEventListener('error', () => row.replaceChildren(node('p', {}, 'Not available · ' + name)));
      return row;
    }), 'Not available · no existing thumbnails registered.'),
    node('section', { 'data-sheet-section': 'evidence' }, node('h2', {}, 'Evidence'),
      node('p', {}, 'Availability and measurements are not approval.'), node('ul', {}, ...model.evidence.map(e =>
        node('li', { 'data-evidence': e.status }, EVIDENCE[e.status] + ' · ' + e.label)))));
}

export async function startDecisionSheet({ api, S }) {
  if (new URLSearchParams(location.search).get('sheet') !== '1') return false;
  stylesheet(); document.body.classList.add('r3i-sheet'); S.mode = 'sheet';
  const root = node('div', { class: 'decision-sheet-root' }, node('p', { role: 'status' }, 'Loading decision sheet…'));
  document.body.append(root);
  document.querySelector('#bar').replaceChildren(node('span', {}, 'Decision sheet'));
  const load = async () => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const asset = hash.get('a'), stage = hash.get('s'), version = Number(hash.get('v'));
    const token = S.sheetNav = (S.sheetNav || 0) + 1;
    root.replaceChildren(node('p', { role: 'status' }, 'Loading decision sheet…'));
    try {
      if (!safeId(asset) || !safeId(stage) || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid version');
      const catalog = await api('/api/catalog');
      // Validate membership before reading any version sidecars.
      buildDecisionSheet({ catalog, asset, stage, version });
      const q = new URLSearchParams({ asset, stage, v: String(version) });
      const reads = await Promise.allSettled([api('/api/review?' + q), api('/api/comments?' + q)]);
      if (token !== S.sheetNav) return;
      const failures = reads.flatMap((r, i) => r.status === 'rejected' ? [(i ? 'Advice' : 'Review') + ' not available: ' + r.reason.message] : []);
      const model = buildDecisionSheet({ catalog, asset, stage, version, failures,
        review: reads[0].status === 'fulfilled' ? reads[0].value : null, comments: reads[1].status === 'fulfilled' ? reads[1].value : null });
      root.replaceChildren(renderDecisionSheet(model, sheetLinks(location.href, asset, stage, version)));
    } catch (e) { if (token === S.sheetNav) root.replaceChildren(node('main', { class: 'decision-sheet' }, node('h1', {}, 'Decision sheet not available'), node('p', { role: 'status' }, 'Incomplete · ' + e.message))); }
  };
  addEventListener('hashchange', load); await load(); return true;
}

export function installDecisionSheetEntry({ S, focusNote, sourceHash = location.hash }) {
  stylesheet();
  const bar = document.querySelector('#bar');
  const update = () => {
    const existing = bar.querySelector('[data-decision-sheet]');
    if (S.mode !== 'review' || !S.v) { existing?.remove(); return; }
    const href = sheetLinks(location.href, S.asset, S.stage, S.v).sheet;
    if (existing) { if (existing.getAttribute('href') !== href) existing.setAttribute('href', href); }
    else bar.append(node('a', { class: 'r3i-sheet-entry', 'data-decision-sheet': '1', href }, 'Decision sheet'));
  };
  new MutationObserver(update).observe(bar, { childList: true }); update();
  const hash = new URLSearchParams(sourceHash.slice(1)), id = hash.get('n'), person = hash.get('c');
  if (hash.get('a') !== S.asset || hash.get('s') !== S.stage || Number(hash.get('v')) !== S.v) return;
  const comment = person && list(S.cdocs?.[person]?.comments).find(c => c.id === id);
  const note = person ? comment && { ...comment, id: 'g:' + person + ':' + id, guest: true, verdict: 'guest', mark: (S.cdocs[person].name || '?')[0] } : list(S.review?.notes).find(n => n.id === id);
  // A source link stays on the exact version even when a note retains an older camera origin.
  if (note && S.view) focusNote({ ...note, view: note.view ? { ...note.view, asset: undefined } : undefined });
}
