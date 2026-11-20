const declaredUnit = value => ['m', 'cm', 'mm', 'ft', 'in', 'stud', 'studs'].includes(value) ? (value === 'stud' ? 'studs' : value) : null;
const finiteDimensions = value => Array.isArray(value) && value.length === 3 && value.every(v => Number.isFinite(v) && v >= 0);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Capture once after model load, before inspection helpers can affect bounds.
// Counts use the viewer's existing triangle total and loaded mesh primitives,
// never renderer.info (which includes lights, grids and inspection helpers).
export function modelMetrics(view, identity) {
  const dimensions = view.size0?.toArray();
  return Object.freeze({ identity: Object.freeze({ ...identity, file: view.file.name, hash: view.assetHash || null }),
    declaredUnits: identity.units ?? null, unit: declaredUnit(identity.units),
    dimensions: finiteDimensions(dimensions) ? dimensions : null,
    triangles: count(view.tris), primitives: count(view.meshes?.length), space: 'loaded world' });
}

export function metricDelta(before, after) {
  const sameModel = before?.identity.asset === after?.identity.asset && before?.identity.stage === after?.identity.stage;
  const attributed = [before, after].every(m => m?.identity.hash && Number.isSafeInteger(m.identity.version));
  const comparable = sameModel && attributed;
  const dimensions = comparable && before.unit && before.unit === after.unit && before.dimensions && after.dimensions
    ? after.dimensions.map((v, i) => v - before.dimensions[i]) : null;
  const delta = key => comparable && before[key] !== null && after[key] !== null ? after[key] - before[key] : null;
  return { before, after, dimensions, unit: dimensions ? after.unit : null, triangles: delta('triangles'), primitives: delta('primitives') };
}

export function metricStrip(before, after, el) {
  const values = metricDelta(before, after), format = value => value === null || value === undefined ? 'unsupported' :
    Array.isArray(value) ? value.map(v => Number(v.toPrecision(7))).join(' × ') : String(value);
  const side = m => m ? `v${m.identity.version} · ${m.identity.asset}/${m.identity.stage}/${m.identity.file} · SHA-256 ${m.identity.hash || 'unsupported'} · units ${m.unit || 'unsupported'}` : 'unsupported';
  const dimensions = m => m?.unit && m.dimensions ? format(m.dimensions) + ' ' + m.unit : 'unsupported';
  const row = (key, title, a, b, delta, unit) => el('tr', { 'data-compare-metric': key }, el('th', {}, title),
    el('td', {}, a), el('td', {}, b), el('td', {}, format(delta) + (delta === null ? '' : ' ' + unit)));
  const table = el('table', { class: 'model-compare-table', style: { tableLayout: 'fixed' }, 'data-compare-metrics': '', 'aria-label': 'Inspect A/B model metrics' },
    el('caption', { style: { overflowWrap: 'anywhere' } }, `A: ${side(before)} → B: ${side(after)} · B − A; numeric differences do not rate design quality.`),
    el('thead', {}, el('tr', {}, ['Metric', 'A', 'B', 'B − A'].map(t => el('th', {}, t)))),
    el('tbody', {}, row('dimensions', 'Loaded world dimensions (X × Y × Z)', dimensions(before), dimensions(after), values.dimensions, values.unit),
      row('triangles', 'Model triangles (unitless count)', format(before?.triangles), format(after?.triangles), values.triangles, 'triangles'),
      row('primitives', 'Mesh primitives (unitless count)', format(before?.primitives), format(after?.primitives), values.primitives, 'primitives')));
  table.metricValues = values; return table;
}

const installed = new WeakSet();
export function installCompareMetrics(ModelView, { identity, changed }) {
  if (installed.has(ModelView)) return; installed.add(ModelView);
  const p = ModelView.prototype, { loadModel, teardownLoad } = p;
  p.loadModel = async function (...args) {
    const captured = identity(this); this.modelMetrics = null;
    await loadModel.apply(this, args);
    if (!this.dead && this.root) this.modelMetrics = modelMetrics(this, captured);
    changed();
  };
  p.teardownLoad = function (...args) { this.modelMetrics = null; return teardownLoad.apply(this, args); };
}
