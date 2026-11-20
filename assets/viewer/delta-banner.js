// Read-only comparison. Submitted claims and missing evidence never decide a review.
import { sheetLinks } from './sheet.js';

export const DELTA_LIMITS = Object.freeze({ versions: 128, rows: 256, diffBytes: 65536 });
const list = value => Array.isArray(value) ? value : [];
const id = value => typeof value === 'string' && /^[\w-]+$/.test(value);
const path = value => typeof value === 'string' && value.length <= 512 && value.length > 0 &&
  !/[\\\u0000-\u001f:#?]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const statuses = ['measured', 'approximate', 'unavailable', 'incomplete'];
const final = r => r && !r.draft && !r.guest && (!r.role || r.role === 'owner') && r.scope !== 'comment' &&
  ['approved', 'changes', 'rejected'].includes(r.verdict);
const matches = (r, c, v) => r && r.asset === c.asset && r.stage === c.stage && r.version === v &&
  (r.project == null || r.project === c.project) && r.reviewer === c.owner;
const digest = (v, f) => {
  const computed = f?.sha256 || f?.source_hash || f?.hash;
  if (hash(computed)) return { value: computed.toLowerCase(), status: 'measured' };
  const declared = v?.meta?.provenance?.files?.[f?.name];
  return hash(declared) ? { value: declared.toLowerCase(), status: 'approximate' } : null;
};
const boundedText = value => typeof value === 'string' ? value.slice(0, 512) : '';

// R3C-100 begin
const DISPLAY_LABELS = Object.freeze({
  measured: 'measured', approximate: 'approximate', unavailable: 'not available', incomplete: 'incomplete',
  confirmed: 'confirmed', dismissed: 'not adopted', wontfix: 'will not be fixed', reopened: 'reopened',
  source: 'source', author: 'author', licence: 'licence',
});
const displayLabel = value => Object.hasOwn(DISPLAY_LABELS, value) ? DISPLAY_LABELS[value] : value;
// R3C-100 end

// Compatible optional contract is documented by the synthetic fixture README.
// It binds both versions and their file hashes; never fetch URLs supplied by JSON.
// No server-owned analyzer-result boundary is wired here. Input identity is not
// authentication: submitted metrics, including a "measured" claim, stay unverified.
export function geometryEvidence(raw, c, before, after) {
  const unknown = label => ({ status: 'unavailable', label, rows: [] });
  if (raw == null) return unknown('Geometry comparison not available · geometry unknown; no suitable submitted file');
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (new TextEncoder().encode(text).length > DELTA_LIMITS.diffBytes) return unknown('Geometry comparison not available · submitted file exceeds the size limit');
    const diff = JSON.parse(text);
    const endpoint = (e, version) => e && e.project === c.project && e.asset === c.asset && e.stage === c.stage && e.version === version;
    if (diff.schema !== 'asset-review.glb-diff/v1' || !endpoint(diff.from, before?.v) || !endpoint(diff.to, after?.v) ||
      !Array.isArray(diff.files) || !diff.files.length || diff.files.length > DELTA_LIMITS.rows) return unknown('Geometry comparison not available · submitted file is not suitable');
    const rows = [], names = new Set();
    for (const f of diff.files) {
      const old = list(before.files).find(x => x.name === f.name && x.media === 'model');
      const current = list(after.files).find(x => x.name === f.name && x.media === 'model');
      if (!path(f.name) || names.has(f.name) || !old || !current || !hash(f.before_sha256) || !hash(f.after_sha256) ||
        digest(before, old)?.value !== f.before_sha256.toLowerCase() || digest(after, current)?.value !== f.after_sha256.toLowerCase() || !statuses.includes(f.status)) {
        return unknown('Geometry comparison not available · file or hash does not match');
      }
      names.add(f.name);
      const metrics = ['changed_nodes', 'changed_primitives', 'max_distance'].filter(k => typeof f[k] === 'number' && Number.isFinite(f[k]) && f[k] >= 0);
      if (['measured', 'approximate'].includes(f.status) && !metrics.length) return unknown('Geometry comparison not available · measurements missing');
      rows.push({ name: f.name, status: f.status === 'measured' ? 'approximate' : f.status,
        label: 'stated/unverified · ' + (metrics.map(k => k + ': ' + f[k]).join(', ') || 'Geometry unknown') });
    }
    const complete = list(after.files).filter(f => f.media === 'model').every(f => names.has(f.name));
    const status = !complete || rows.some(r => r.status === 'incomplete' || r.status === 'unavailable') ? 'incomplete' : 'approximate';
    return { status, verification: 'unverified', label: 'Submitted geometry comparison · stated/unverified · ' + displayLabel(status) + (complete ? '' : ' · not all files compared'), rows };
  } catch { return unknown('Geometry comparison not available · submitted file is invalid'); }
}

export function buildDeltaBanner({ catalog, reviews = [], asset, stage, version, project, owner, diff, failures = [] }) {
  const c = { asset, stage, project, owner };
  if (!id(asset) || !id(stage) || !Number.isSafeInteger(version) || version < 1 || !owner) throw new Error('Invalid comparison context');
  const versions = list(catalog?.assets?.[asset]?.stages?.[stage]?.versions);
  const current = versions.find(v => v.v === version);
  if (!current) throw new Error('Version unavailable in this project');
  const candidates = list(reviews).filter(r => Number.isSafeInteger(r?.version) && r.version > 0 && r.version < version && matches(r, c, r.version) && final(r));
  // updated is the existing saved-verdict timestamp. Legacy reviews fall back to version order.
  candidates.sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0) || b.version - a.version);
  const baseline = candidates[0] || null, before = versions.find(v => v.v === baseline?.version);
  const model = { ...c, version, baseline, files: [], notes: { resolved: [], dismissed: [], open: [] }, evidence: [], failures: [...new Set(failures)] };
  if (!baseline) model.failures.push('No earlier final review by this owner');
  else if (!before) model.failures.push('Metadata of the old version not available');
  if (baseline && before) {
    const oldFiles = list(before.files), newFiles = list(current.files);
    const names = [...new Set([...oldFiles, ...newFiles].map(f => f.name))];
    if (names.length > DELTA_LIMITS.rows) model.failures.push('File comparison shortened');
    for (const name of names.slice(0, DELTA_LIMITS.rows)) {
      const a = oldFiles.filter(f => f.name === name), b = newFiles.filter(f => f.name === name);
      const old = a[0], now = b[0], x = digest(before, old), y = digest(current, now);
      let kind = 'unknown', status = 'incomplete', label = 'File identity or hash unknown';
      if (!old || !now) label = 'Path added/removed · identity after rename unknown';
      else if (a.length === 1 && b.length === 1 && x && y) {
        kind = x.value === y.value ? 'unchanged' : 'changed';
        status = x.status === 'measured' && y.status === 'measured' ? 'measured' : 'approximate';
        label = kind === 'changed' ? 'File hash changed' : 'File hash unchanged';
      }
      const metrics = [];
      for (const key of ['tris', 'vertices', 'draw_calls', 'materials', 'textures', 'est_texture_mb', 'bytes', 'seconds']) {
        const x = old?.preflight?.stats?.[key], y = now?.preflight?.stats?.[key];
        if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) && x !== y) metrics.push(key + ': ' + x + ' → ' + y);
      }
      // A saved preflight delta can be for a different version or stage.
      const delta = now?.preflight?.stats?.delta;
      if (delta?.from === before.v && delta.to === version && delta.stage === stage && typeof delta.line === 'string') metrics.push(boundedText(delta.line));
      if (old?.preflight?.stats?.header_only || now?.preflight?.stats?.header_only || metrics.some(m => m.startsWith('est_'))) {
        model.evidence.push({ label: name + ' · estimated precheck: ' + metrics.join('; '), status: 'approximate' });
      }
      if (old?.preflight?.error || now?.preflight?.error || old?.preflight?.ok === false || now?.preflight?.ok === false ||
        list(old?.preflight?.block).length || list(now?.preflight?.block).length) status = 'incomplete';
      model.files.push({ name, kind, status, label, metrics, old: !!old, current: !!now });
    }
    for (const key of ['source', 'author', 'licence']) {
      const a = before.meta?.provenance?.[key], b = current.meta?.provenance?.[key];
      if (a !== b && (a != null || b != null)) model.evidence.push({ label: 'Stated provenance ' + displayLabel(key) + ': ' + boundedText(a) + ' → ' + boundedText(b), status: 'approximate' });
    }
  }
  if (baseline && !before) {
    model.files = list(current.files).slice(0, DELTA_LIMITS.rows).map(f => ({ name: f.name, kind: 'unknown', status: 'incomplete',
      label: 'Old version not available · change unknown', metrics: [], old: false, current: true }));
  }
  if (current.meta?.scope != null) model.evidence.push({ label: 'Stated scope: ' + boundedText(typeof current.meta.scope === 'string' ? current.meta.scope : JSON.stringify(current.meta.scope)), status: 'approximate' });
  if (current.scope_check && Object.keys(current.scope_check).length) {
    const sc = current.scope_check;
    model.evidence.push({ label: 'Scope check: ' + boundedText(JSON.stringify(sc)),
      status: sc.from === baseline?.version && sc.to === version && sc.stage === stage ? 'measured' : 'incomplete' });
  }
  if (baseline) {
    const seen = new Set(), notes = list(baseline.notes);
    if (notes.length > DELTA_LIMITS.rows) model.failures.push('Note comparison shortened');
    const saved = list(reviews).find(r => matches(r, c, version) && final(r));
    for (const n of notes.slice(0, DELTA_LIMITS.rows)) {
      if (!id(n.id) || seen.has(n.id) || !['change', 'reject'].includes(n.verdict) || ['resolved', 'dismissed', 'wontfix'].includes(n.status)) continue;
      seen.add(n.id);
      const ref = 'v' + baseline.version + ':' + n.id;
      const followups = list(saved?.followups).filter(f => f.id === ref);
      let category = 'open', status = 'incomplete', label = 'Open · no confirmed fix';
      if (followups.length === 1 && ['confirmed', 'dismissed', 'wontfix', 'reopened'].includes(followups[0].status)) {
        const state = followups[0].status;
        category = state === 'confirmed' ? 'resolved' : state === 'reopened' ? 'open' : 'dismissed';
        status = 'measured'; label = state === 'reopened' ? 'Reopened by the owner' : 'Explicit status from the owner: ' + displayLabel(state);
      } else {
        const claims = versions.filter(v => v.v > baseline.version && v.v <= version && list(v.resolves).some(x => x === ref || (v.v === baseline.version + 1 && x === n.id)));
        if (claims.length && !followups.length) { category = 'resolved'; status = 'approximate'; label = 'Agent reports fixed · not confirmed by the owner'; }
      }
      const response = current.responses?.[ref] ?? (version === baseline.version + 1 ? current.responses?.[n.id] : null);
      model.notes[category].push({ ...n, status, label, response: boundedText(response) });
    }
  }
  model.geometry = geometryEvidence(diff, c, before, current);
  model.hasModel = (current.files || []).some(f => /\.gl(b|tf)$/i.test(f.name || '')); // a version without a model has no geometry to compare
  model.counts = { changed: model.files.filter(f => f.kind === 'changed').length, unknown: model.files.filter(f => f.kind === 'unknown').length,
    resolved: model.notes.resolved.length, dismissed: model.notes.dismissed.length, open: model.notes.open.length };
  const completeHashes = v => Array.isArray(v?.files) && v.files.length > 0 && v.files.length <= DELTA_LIMITS.rows &&
    v.files.every(f => hash(f.sha256 || f.source_hash || f.hash || ''));
  model.unchanged = !model.failures.length && !model.counts.changed && !model.counts.unknown &&
    completeHashes(before) && completeHashes(current);
  const submitted = typeof current.note === 'string' && current.note.trim() ? current.note : '';
  model.submitted = submitted.slice(0, 2048);
  model.submittedShortened = submitted.length > model.submitted.length;
  return model;
}

function node(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
  for (const child of children.flat()) if (child != null) e.append(child.nodeType ? child : document.createTextNode(String(child)));
  return e;
}
export function renderDeltaBanner(model, location, open = false) {
  const links = v => sheetLinks(location, model.asset, model.stage, v);
  const rows = [];
  for (const f of model.files.filter(f => f.kind !== 'unchanged' || f.metrics.length)) {
    rows.push(node('li', { 'data-delta-file': f.kind, 'data-evidence': f.status }, f.name + ' · ' + f.label + ' · ' + displayLabel(f.status),
      f.metrics.length ? node('small', {}, ' · ' + f.metrics.join('; ')) : null,
      f.old && links(model.baseline.version).file(f.name) ? node('a', { href: links(model.baseline.version).file(f.name) }, ' Before') : null,
      f.current && links(model.version).file(f.name) ? node('a', { href: links(model.version).file(f.name) }, ' Now') : null));
  }
  for (const [category, notes] of Object.entries(model.notes)) for (const n of notes) {
    const source = node('a', { href: links(model.baseline.version).note(n.id) }, n.id + ' · ' + boundedText(n.text));
    // The existing editor reads note/version fragments on boot, not hashchange.
    source.addEventListener('click', e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const destination = new URL(source.href);
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) {
        e.preventDefault(); window.location.assign(destination.href); window.location.reload();
      }
    });
    rows.push(node('li', { 'data-delta-note': category, 'data-evidence': n.status },
      source, ' · ' + n.label,
      n.response ? node('small', {}, ' · Response: ' + n.response) : null));
  }
  const summary = !model.baseline ? (model.version === 1 ? 'First review' : 'No earlier review') :
    model.failures.length ? 'Comparison incomplete' : 'v' + model.baseline.version + ' → v' + model.version;
  return node('details', { class: 'delta-banner', 'data-delta-banner': '1', ...(open ? { open: '' } : {}) },
    node('summary', {}, node('span', {}, 'Version evidence'), node('span', { class: 'delta-summary' }, summary)),
    node('div', { class: 'delta-body' },
    node('strong', {}, 'Changes since your last final review'),
    model.baseline ? node('p', {}, node('a', { href: links(model.baseline.version).sheet }, 'v' + model.baseline.version + ' · ' + model.owner), ' → v' + model.version) : null,
    node('p', { 'data-counts': model.counts.changed + '/' + model.counts.unknown }, [[model.counts.changed, model.counts.changed === 1 ? 'changed file' : 'changed files'], [model.counts.resolved, 'fixed'], [model.counts.dismissed, 'not adopted'], [model.counts.open, 'open'],
      [model.counts.unknown, (model.counts.unknown === 1 ? 'file' : 'files') + ' without comparison']].filter(x => x[0]).map(x => x[0] + ' ' + x[1]).join(' · ') || 'No measured differences'),
    node('p', { class: 'delta-submitted', 'data-agent-claim': model.submitted ? 'submitted' : 'unavailable' },
      node('strong', {}, 'Submitted note (unverified): '), model.submitted || 'No explanation provided.',
      model.submittedShortened ? node('small', {}, ' · shortened to 2048 characters') : null,
      model.unchanged ? node('small', { 'data-no-file-change': '1' }, ' · All file hashes match; this does not confirm any fixes.') : null),
    model.geometry.status === 'unavailable' && !model.hasModel ? null : node('p', { 'data-geometry': model.geometry.status }, model.geometry.label),
    model.failures.length ? node('p', { 'data-evidence': 'incomplete' }, 'Comparison incomplete · ' + model.failures.join('; ')) : null,
    node('div', { class: 'delta-sources' }, node('strong', {}, 'Evidence and source notes'), node('ul', {}, rows,
      model.geometry.rows.map(r => node('li', { 'data-geometry-row': '1', 'data-evidence': r.status }, r.name + ' · ' + r.label)),
      model.evidence.map(r => node('li', { 'data-evidence': r.status }, displayLabel(r.status) + ' · ' + r.label)))),
    node('small', {}, 'Evidence and reported fixes do not mean this version is approved.')));
}

// Fetch at most 128 saved reviews, four at a time. No editor/draft or permission writes.
export function makeDeltaBanner({ S, api, owner, guest, fetchArtifact = readArtifact }) {
  let cache = null;
  return function update() {
    const box = document.querySelector('#sidescroll'), who = owner();
    if (!box || S.mode !== 'review' || !S.v || guest() || !who) { cache = null; box?.querySelector('[data-delta-banner]')?.remove(); return; }
    const context = { asset: S.asset, stage: S.stage, version: S.v, project: new URL(location.href).searchParams.get('p') || S.proj?.home, owner: who };
    const nav = S.nav, key = JSON.stringify([nav, context]);
    const active = () => cache?.key === key && S.mode === 'review' && S.nav === nav && S.asset === context.asset &&
      S.stage === context.stage && S.v === context.version && owner() === context.owner && !guest();
    const mount = data => {
      if (!active()) return;
      const target = document.querySelector('#sidescroll'); if (!target) return;
      target.querySelector('[data-delta-banner]')?.remove();
      const banner = renderDeltaBanner(buildDeltaBanner({ catalog: S.cat, ...context, ...data }), location.href, cache.open);
      banner.addEventListener('toggle', () => { if (active() && banner.isConnected) cache.open = banner.open; });
      target.prepend(banner);
    };
    if (cache?.key === key) { if (cache.data) mount(cache.data); return; }
    cache = { key };
    const versions = list(S.cat?.assets?.[S.asset]?.stages?.[S.stage]?.versions).filter(v => v.v <= S.v);
    if (!versions.some(v => v.v === S.v)) return;
    const catalog = S.cat;
    return (async () => {
      const reviews = [], failures = [];
      if (versions.length > DELTA_LIMITS.versions) failures.push('Review history shortened · last base version may be unknown');
      const bounded = versions.slice(-DELTA_LIMITS.versions);
      for (let i = 0; i < bounded.length; i += 4) {
        const results = await Promise.allSettled(bounded.slice(i, i + 4).map(v => api('/api/review?' + new URLSearchParams({ asset: context.asset, stage: context.stage, v: String(v.v) }))));
        if (!active()) return;
        for (const [j, r] of results.entries()) {
          if (r.status === 'rejected') failures.push('Saved review not available · comparison history incomplete');
          else if (r.value) {
            if (r.value.version === bounded[i + j].v && r.value.asset === context.asset && r.value.stage === context.stage &&
              (r.value.project == null || r.value.project === context.project)) reviews.push(r.value);
            else failures.push('Saved review identity does not match · comparison history incomplete');
          }
        }
      }
      const current = versions.find(v => v.v === context.version), artifact = current?.meta?.glb_diff;
      let diff;
      if (artifact != null) {
        if (typeof artifact === 'object') diff = artifact;
        else if (path(artifact) && list(current.files).some(f => f.name === artifact && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && f.bytes <= DELTA_LIMITS.diffBytes)) {
          try { diff = await fetchArtifact(sheetLinks(location.href, context.asset, context.stage, context.version).file(artifact)); }
          catch { diff = ''; }
        } else diff = '';
      }
      if (!active()) return;
      if (S.cat !== catalog) { cache = null; update(); return; }
      cache.data = { reviews, failures, diff }; mount(cache.data);
    })().catch(() => { if (cache?.key === key) { cache.data = { failures: ['Comparison not available · evidence incomplete'] }; mount(cache.data); } });
  };
}

async function readArtifact(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!r.ok || Number(r.headers.get('content-length')) > DELTA_LIMITS.diffBytes) throw new Error('Artifact unavailable');
  const reader = r.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > DELTA_LIMITS.diffBytes) throw new Error('Artifact too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(result);
}
