// Viewer approximation only. Reuse ModelView's lights; own no scene resources.
export const LOOK_LABEL = 'Approximate · not engine lighting';
const copy = value => JSON.parse(JSON.stringify(value));
const freeze = value => { Object.values(value).forEach(v => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(value); };
const settings = (skyColor, groundColor, color) => ({
  hemisphere: { skyColor, groundColor, intensity: 1.7 },
  directional: { color, intensity: 2.4 },
  exposure: 1, toneMapping: 0, outputColorSpace: 'srgb'
});
export const LOOK_PRESETS = freeze([
  { id: 'neutral', version: 1, settings: settings(0xe6eeff, 0x6b5f4a, 0xffffff) },
  { id: 'warm', version: 1, settings: settings(0xffead5, 0x745940, 0xffe0b8) },
  { id: 'cool', version: 1, settings: settings(0xd5e7ff, 0x4a596b, 0xc8deff) }
]);

// Sorted, type-preserving serialization also rejects non-finite saved values.
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new TypeError('Non-canonical preset or capture value');
}
// Read only fixed own data fields: never enumerate, stringify or retain extras.
// Strings have at most 8 UTF-16 units; even JSON escapes fit in 512 bytes.
// Invalid scalars collapse to null; supported settings remain exact on reload.
const field = (value, key) => value && typeof value === 'object' && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const shortString = value => typeof value === 'string' && value.length <= 8;
const finite = value => typeof value === 'number' && Number.isFinite(value);
function boundedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const id = field(request, 'id'), version = field(request, 'version'), s = field(request, 'settings');
  const h = field(s, 'hemisphere'), d = field(s, 'directional');
  const projected = { hemisphere: { skyColor: field(h, 'skyColor'), groundColor: field(h, 'groundColor'), intensity: field(h, 'intensity') },
    directional: { color: field(d, 'color'), intensity: field(d, 'intensity') },
    exposure: field(s, 'exposure'), toneMapping: field(s, 'toneMapping'), outputColorSpace: field(s, 'outputColorSpace') };
  const colors = [projected.hemisphere.skyColor, projected.hemisphere.groundColor, projected.directional.color];
  const valid = colors.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffff) &&
    [projected.hemisphere.intensity, projected.directional.intensity, projected.exposure, projected.toneMapping].every(finite) && shortString(projected.outputColorSpace);
  return { id: shortString(id) ? id : null,
    ...(version !== undefined ? { version: Number.isSafeInteger(version) || shortString(version) ? version : null } : {}),
    settings: valid ? projected : null };
}
const resolvedStates = new WeakSet();
export function resolveLook(request) {
  const bounded = boundedRequest(request);
  const preset = LOOK_PRESETS.find(p => p.id === bounded?.id && p.version === bounded?.version && canonical(p.settings) === canonical(bounded.settings));
  const state = freeze({ status: preset ? 'available' : 'unavailable', requested: preset || bounded, applied: preset || LOOK_PRESETS[0] });
  resolvedStates.add(state);
  return state;
}
async function digest(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export const presetDigest = preset => digest({ id: preset.id, version: preset.version, settings: preset.settings });

// Local adapter when R3I-020 is absent; retain an existing recipe when supplied.
export async function captureRecipe(view, base = {}) {
  const normalized = normalizeView(view);
  return makeCaptureRecipe(normalized.view, base, normalized.look);
}
function normalizeView(view) {
  const look = resolveLook(Object.hasOwn(view, 'lookPreset') ? view.lookPreset : LOOK_PRESETS[0]);
  return { view: { ...view, lookPreset: look.requested }, look };
}
async function makeCaptureRecipe(view, base, look) {
  const recipe = { ...base, schema: base.schema || 'viewer-capture/1', view: copy(view),
    look: { label: LOOK_LABEL, ...look, digest: await presetDigest(look.applied) } };
  // A stale/missing version remains part of identity, even with neutral fallback.
  const { identity: priorIdentity, ...content } = recipe;
  recipe.identity = await digest({ ...content, ...(priorIdentity ? { priorIdentity } : {}) });
  return recipe;
}

async function labelImage(url, text) {
  if (!url) return url;
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Capture label image unavailable')); img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(img.width, 640); canvas.height = img.height + 28;
  const g = canvas.getContext('2d');
  g.fillStyle = '#16191e'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 28); g.fillStyle = '#ffffff'; g.font = '14px sans-serif';
  g.fillText(text, 8, 19);
  return canvas.toDataURL('image/png');
}

export function installLookPresets(ModelView, { el, refresh = () => {} }) {
  const P = ModelView.prototype;
  const old = Object.fromEntries(['loadModel', 'viewState', 'focus', 'syncPeer', 'extras', 'capture', 'captureRecipe', 'teardownLoad'].map(k => [k, P[k]]));
  P.lookState = function () { return this.look || (this.look = resolveLook(LOOK_PRESETS[0])); };
  P.applyLook = function () {
    const s = this.lookState().applied.settings;
    const hemi = this.scene?.children.find(light => light.isHemisphereLight);
    const sun = this.sun;
    if (!hemi || !sun || !this.renderer) return;
    // Remember borrowed properties for teardown; never dispose borrowed lights.
    if (!this.lookOriginal) this.lookOriginal = { hemi, sun, renderer: this.renderer,
      sky: hemi.color.clone(), ground: hemi.groundColor.clone(), hi: hemi.intensity,
      color: sun.color.clone(), si: sun.intensity, exposure: this.renderer.toneMappingExposure,
      tone: this.renderer.toneMapping, space: this.renderer.outputColorSpace };
    hemi.color.set(s.hemisphere.skyColor); hemi.groundColor.set(s.hemisphere.groundColor); hemi.intensity = s.hemisphere.intensity;
    sun.color.set(s.directional.color); sun.intensity = s.directional.intensity;
    this.renderer.toneMappingExposure = s.exposure; this.renderer.toneMapping = s.toneMapping;
    this.renderer.outputColorSpace = s.outputColorSpace;
  };
  P.setLookState = function (state, sync = true) {
    if (this.dead) return;
    if (!resolvedStates.has(state)) throw new TypeError('Unresolved look state');
    if (this.look !== state) {
      this.look = state; this.applyLook();
      if (this.lookSelect) this.lookSelect.value = state.status === 'available' ? state.applied.id : '';
      if (this.lookLabel) this.lookLabel.textContent = LOOK_LABEL + (state.status === 'unavailable' ? ' · preset unavailable (neutral fallback)' : '');
    }
    if (sync && this.peer?.setLookState && this.peer.look !== state) this.peer.setLookState(state, false);
  };
  P.setLookPreset = function (request, sync = true) { if (!this.dead) this.setLookState(resolveLook(request), sync); };
  P.loadModel = async function (...args) {
    const result = await old.loadModel.apply(this, args);
    if (!this.dead) this.applyLook();
    return result;
  };
  P.viewState = function () {
    return { ...old.viewState.call(this), lookPreset: copy(this.lookState().requested), lookStatus: this.lookState().status, lookLabel: LOOK_LABEL };
  };
  P.focus = async function (note) {
    const hash = note.target?.hash || note.view?.asset?.hash;
    if (hash && hash !== this.assetHash) return old.focus.call(this, note);
    this.setLookPreset(note.view && Object.hasOwn(note.view, 'lookPreset') ? note.view.lookPreset : LOOK_PRESETS[0]);
    return old.focus.call(this, note);
  };
  P.syncPeer = function (...args) {
    const state = this.lookState();
    if (!this.syncing && !this.peer?.syncing && this.peer?.setLookState && this.peer.look !== state) this.peer.setLookState(state, false);
    return old.syncPeer.apply(this, args);
  };
  P.extras = function () {
    const state = this.lookState();
    this.lookLabel = el('span', { class: 'mlabel' }, LOOK_LABEL + (state.status === 'unavailable' ? ' · preset unavailable (neutral fallback)' : ''));
    this.lookSelect = el('select', { 'aria-label': 'Viewer look · ' + LOOK_LABEL, onchange: e => { this.setLookPreset(LOOK_PRESETS.find(p => p.id === e.target.value)); refresh(); } },
      LOOK_PRESETS.map(p => el('option', { value: p.id }, p.id)));
    this.lookSelect.value = state.status === 'available' ? state.applied.id : '';
    return [this.lookLabel, this.lookSelect, ...old.extras.call(this)];
  };
  P.captureRecipe = async function (view = this.viewState()) {
    const normalized = normalizeView(view);
    const base = old.captureRecipe ? await old.captureRecipe.call(this, normalized.view) : {};
    return makeCaptureRecipe(normalized.view, base, normalized.look);
  };
  P.capture = async function (note, all) {
    const keepLook = this.lookState(), keep = this.viewState();
    try {
      const result = await old.capture.call(this, note, all);
      // Preserve upstream empty/rejected captures, including stale hash guards.
      if (!result || result.rejected || result.ok === false || result.status === 'rejected' || !['context', 'crop', 'strip'].some(key => result[key])) return result;
      const view = { ...keep, ...note.view, asset: keep.asset,
        rotation: note.view?.rotation ?? 0, flags: { ...(note.view?.flags || keep.flags), spin: false } };
      // A legacy note must not inherit the currently selected warm/cool look.
      view.lookPreset = note.view && Object.hasOwn(note.view, 'lookPreset') ? note.view.lookPreset : LOOK_PRESETS[0];
      const recipe = await this.captureRecipe(view);
      const text = LOOK_LABEL + ' · ' + recipe.look.applied.id + (recipe.look.status === 'unavailable' ? ' · preset unavailable (neutral fallback)' : '');
      for (const key of ['context', 'crop', 'strip']) if (result[key]) result[key] = await labelImage(result[key], text);
      result.recipe = recipe;
      // makeCrops retains images only, so retain recipe identity on the note too.
      note.captureIdentity = copy(recipe);
      return result;
    } finally { this.setLookState(keepLook); }
  };
  P.teardownLoad = function (...args) {
    const o = this.lookOriginal;
    if (o) {
      o.hemi.color.copy(o.sky); o.hemi.groundColor.copy(o.ground); o.hemi.intensity = o.hi;
      o.sun.color.copy(o.color); o.sun.intensity = o.si;
      Object.assign(o.renderer, { toneMappingExposure: o.exposure, toneMapping: o.tone, outputColorSpace: o.space });
    }
    this.lookOriginal = this.lookLabel = this.lookSelect = null;
    return old.teardownLoad.apply(this, args);
  };
}
