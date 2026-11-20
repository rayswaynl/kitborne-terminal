// Submitted snapshots only: page identities are opaque; no site requests or inferred viewports.
export const VIEWPORTS = [375, 820, 1440];
// These limits also apply to already-stored catalogs; submit validation is not a trust boundary.
export const WEB_REVIEW_LIMITS = Object.freeze({ entries: 256, filename: 255, page: 1024, rows: 256, renderRows: 8, images: 16, versions: 128 });
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const confined = name => typeof name === 'string' && name.length <= WEB_REVIEW_LIMITS.filename && /^[A-Za-z0-9_.-]+$/.test(name) && !['.', '..'].includes(name);
const result = (items, incomplete) => Object.defineProperty(items, 'incomplete', { value: incomplete });
export function screenshots(version) {
  if (!version) return result([], false);
  if (!Array.isArray(version.files) || !Number.isSafeInteger(version.v) || version.v < 1) return result([], true);
  const shots = [], files = version.files, meta = version.meta || {};
  let incomplete = files.length > WEB_REVIEW_LIMITS.entries;
  for (let i = 0; i < Math.min(files.length, WEB_REVIEW_LIMITS.entries); i++) {
    const file = files[i];
    if (file?.media !== 'image') continue;
    if (!confined(file.name)) { incomplete = true; continue; }
    const entry = meta.screenshots?.[file.name] || Object.fromEntries(['width', 'height', 'dpr', 'page'].map(k => [k, meta[k + '.' + file.name]]));
    if (typeof entry.page === 'string' && entry.page.length > WEB_REVIEW_LIMITS.page) { incomplete = true; continue; }
    // Copy only bounded fields, never spread an arbitrary stored metadata object.
    const page = typeof entry.page === 'string' ? entry.page : undefined;
    const width = positive(entry.width) ? entry.width : undefined, height = positive(entry.height) ? entry.height : undefined, dpr = positive(entry.dpr) ? entry.dpr : undefined;
    const valid = width != null && height != null && dpr != null && page != null && !!page.trim() && !/[\x00-\x1f]/.test(page) && (entry.preset == null || VIEWPORTS.includes(entry.preset) && entry.preset === width);
    const known = valid && VIEWPORTS.includes(width), stats = file.preflight?.stats || {};
    const evidence = !valid ? 'unavailable' : stats.width === width * dpr && stats.height === height * dpr ? 'measured' : 'approximate';
    shots.push({ file: { name: file.name, media: 'image' }, version: version.v, width, height, dpr, page, known, evidence, key: known ? JSON.stringify([page, width, height]) : null });
  }
  return result(shots, incomplete);
}
export function pairScreenshots(before, after) {
  const left = screenshots(before), right = screenshots(after), pages = new Map(), unknown = [], rows = [];
  let incomplete = left.incomplete || right.incomplete;
  // One bounded pass indexes page / CSS width / CSS height, retaining all duplicates.
  for (const [side, shots] of [['before', left], ['after', right]]) for (const shot of shots) {
    if (!shot.known) { unknown.push({ page: shot.page || null, width: null, before: side === 'before' ? [shot] : [], after: side === 'after' ? [shot] : [], state: 'unknown', evidence: 'unavailable' }); continue; }
    if (!pages.has(shot.page)) pages.set(shot.page, new Map());
    const widths = pages.get(shot.page);
    if (!widths.has(shot.width)) widths.set(shot.width, new Map());
    const heights = widths.get(shot.width);
    if (!heights.has(shot.height)) heights.set(shot.height, { before: [], after: [] });
    heights.get(shot.height)[side].push(shot);
  }
  if (!pages.size) pages.set(null, new Map());
  const push = row => { if (rows.length >= WEB_REVIEW_LIMITS.rows) { incomplete = true; return false; } rows.push(row); return true; };
  emit: for (const [page, widths] of pages) for (const width of VIEWPORTS) {
    const heights = widths.get(width);
    if (!heights) { if (!push({ page, width, height: null, before: [], after: [], state: 'missing', evidence: 'unavailable' })) break emit; continue; }
    for (const [height, { before: a, after: b }] of heights) {
      const state = a.length > 1 || b.length > 1 ? 'duplicate' : a.length && b.length ? 'pair' : 'single';
      if (!push({ page, width, height, before: a, after: b, state, evidence: state === 'pair' ? a[0].evidence === 'measured' && b[0].evidence === 'measured' ? 'measured' : 'approximate' : 'incomplete' })) break emit;
    }
  }
  for (const row of unknown) if (!push(row)) break;
  // Omitted entries might contain duplicates: retained matches cannot claim a complete check.
  if (incomplete) for (const row of rows) { row.evidence = 'incomplete'; if (row.state === 'pair') row.state = 'incomplete'; }
  return result(rows, incomplete);
}

export function mountWebReview({ container, versions, current, url }) {
  const source = Array.isArray(versions) ? versions : [];
  let versionIncomplete = !Array.isArray(versions) || source.length > WEB_REVIEW_LIMITS.versions;
  versions = source.slice(0, WEB_REVIEW_LIMITS.versions).filter(v => {
    if (Number.isSafeInteger(v?.v) && v.v > 0) return true;
    versionIncomplete = true; return false;
  });
  if (!document.querySelector('link[data-web-review]')) {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = new URL('./web-review.css', import.meta.url).href; css.dataset.webReview = ''; document.head.append(css);
  }
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const root = el('section', '', 'web-review'); root.setAttribute('aria-label', 'Comparison of submitted screenshots');
  // Without a screenshot at a known width the comparison holds only empty slots: it starts folded, so the page itself gets the room.
  const known = versions.some(v => screenshots(v).some(s => s.known));
  const fold = el('details', '', 'web-review-fold'); fold.open = known;
  fold.append(el('summary', known ? 'Screenshots per screen width' : 'Compare with the previous version · no screenshots per screen width submitted'),
    el('p', 'Widths 375, 820 and 1440 px. These are submitted screenshots, not a live capture. The evidence shows what was submitted, not that it is approved.'));
  const EVIDENCE = { measured: 'Measured', approximate: 'Approximate', unavailable: 'No evidence', incomplete: 'Incomplete' };
  const controls = el('div', '', 'web-review-controls');
  const select = (label, selected) => {
    const wrap = el('label', label), input = el('select'); input.setAttribute('aria-label', label);
    const empty = el('option', 'No version'); empty.value = ''; input.append(empty);
    for (const v of versions) { const option = el('option', 'Version ' + v.v); option.value = v.v; input.append(option); }
    input.value = selected ?? ''; wrap.append(input); controls.append(wrap); return input;
  };
  const idx = versions.findIndex(v => v.v === current);
  const before = select('Previous version', versions[idx - 1]?.v), after = select('New version', versions[idx]?.v);
  const tabs = el('div', '', 'web-review-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Screen width');
  const content = el('div'); content.id = 'web-review-snapshots'; content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-live', 'polite');
  const notice = el('p'); notice.setAttribute('role', 'status'); notice.dataset.webReviewIncomplete = '';
  const pager = el('div', '', 'web-review-controls'); pager.setAttribute('aria-label', 'Rows');
  const previous = el('button', 'Previous rows'), next = el('button', 'Next rows'), range = el('span');
  previous.type = next.type = 'button'; pager.append(previous, range, next);
  let width = 375, pageIndex = 0, cachedRows, cachedA, cachedB;
  const draw = () => {
    const a = versions.find(v => String(v.v) === before.value), b = versions.find(v => String(v.v) === after.value);
    if (!cachedRows || cachedA !== a || cachedB !== b) { cachedRows = pairScreenshots(a, b); cachedA = a; cachedB = b; }
    const rows = cachedRows, matching = rows.filter(r => r.width === width || r.width == null);
    pageIndex = Math.max(0, Math.min(pageIndex, Math.max(0, Math.ceil(matching.length / WEB_REVIEW_LIMITS.renderRows) - 1)));
    const start = pageIndex * WEB_REVIEW_LIMITS.renderRows, visible = matching.slice(start, start + WEB_REVIEW_LIMITS.renderRows);
    let remainingImages = WEB_REVIEW_LIMITS.images, imageIncomplete = false;
    content.replaceChildren();
    for (const row of visible) {
      const article = el('article', '', 'web-review-row'); article.dataset.state = row.state; article.dataset.evidence = row.evidence;
      article.append(el('h4', (row.width ? row.width + ' px wide' + (row.height ? ' · height ' + row.height : '') : 'Screen width unknown · not paired') + (row.page ? ' · ' + row.page : '')));
      const status = el('p', EVIDENCE[row.evidence] + ' · ' + ({ pair: 'Same page and width in both versions', single: 'One of the two versions is missing this screenshot', missing: 'No screenshot submitted for this width', duplicate: 'Duplicate page/width · not paired', unknown: 'Width data missing or not supported · not paired', incomplete: 'Limit reached · pairing and duplicate check incomplete' }[row.state]));
      status.title = 'Measured: the image size matches the submitted CSS size and DPR. Approximate: submitted data without matching image sizes.';
      article.append(status);
      const grid = el('div', '', 'web-review-grid');
      for (const [index, [items, version]] of [[row.before, a], [row.after, b]].entries()) {
        const side = el('div', '', 'web-review-side'); side.append(el('b', version ? 'Version ' + version.v : 'No version chosen'));
        if (!items.length) side.append(el('p', 'No screenshot of ' + (row.width ? row.width + ' px' : 'a known width'), 'web-review-empty'));
        const shown = items.slice(0, Math.ceil(remainingImages / (2 - index)));
        remainingImages -= shown.length;
        if (shown.length < items.length) {
          imageIncomplete = true; article.dataset.evidence = 'incomplete'; status.textContent = 'Incomplete · ' + (row.state === 'duplicate' ? 'Duplicate page/width · not paired · ' : '') + 'Preview limit reached';
          side.append(el('p', (items.length - shown.length) + ' submitted images not shown · incomplete'));
        }
        for (const shot of shown) {
          const figure = el('figure', '', 'web-review-device device-' + (shot.known ? shot.width : 'unknown'));
          const img = el('img'); img.alt = 'Version ' + shot.version + ' · ' + shot.file.name; img.src = url(shot.version, shot.file.name); img.decoding = 'async';
          img.addEventListener('error', () => { img.remove(); figure.prepend(el('p', 'Not available: the submitted image could not be loaded')); article.dataset.evidence = 'unavailable'; status.textContent = 'No evidence · The submitted image could not be loaded'; figure.querySelector('figcaption').textContent = shot.file.name + ' · no evidence'; });
          figure.append(img, el('figcaption', shot.file.name + ' · ' + (shot.known ? shot.width + ' px · DPR ' + shot.dpr : 'width unknown') + ' · ' + EVIDENCE[shot.evidence].toLowerCase())); side.append(figure);
        }
        grid.append(side);
      }
      article.append(grid); content.append(article);
    }
    notice.hidden = !rows.incomplete && !versionIncomplete && !imageIncomplete && visible.length === matching.length;
    notice.textContent = rows.incomplete || versionIncomplete ? 'Incomplete evidence: limit reached or invalid submitted data. Some files, rows or versions are missing; pairing and duplicate check may be incomplete.' : 'Incomplete preview: part of the submitted evidence is shown here. Page with Previous rows / Next rows. Each page shows at most ' + WEB_REVIEW_LIMITS.images + ' images.';
    pager.hidden = matching.length <= WEB_REVIEW_LIMITS.renderRows;
    previous.disabled = pageIndex === 0; next.disabled = start + visible.length >= matching.length;
    range.textContent = 'Rows ' + (start + 1) + '–' + (start + visible.length) + ' of ' + matching.length;
    for (const button of tabs.children) { const active = Number(button.dataset.width) === width; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }
  };
  VIEWPORTS.forEach((w, index) => {
    const button = el('button', w + ' px'); button.type = 'button'; button.dataset.width = w; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', content.id);
    button.addEventListener('click', () => { width = w; pageIndex = 0; draw(); });
    button.addEventListener('keydown', e => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation(); const i = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
      width = VIEWPORTS[i]; pageIndex = 0; draw(); tabs.children[i].focus();
    }); tabs.append(button);
  });
  const change = () => { pageIndex = 0; draw(); };
  before.addEventListener('change', change); after.addEventListener('change', change);
  previous.addEventListener('click', () => { pageIndex--; draw(); }); next.addEventListener('click', () => { pageIndex++; draw(); });
  fold.append(controls, tabs, notice, content, pager); root.append(fold); container.replaceChildren(root); draw();
  return { destroy: () => root.remove() };
}
