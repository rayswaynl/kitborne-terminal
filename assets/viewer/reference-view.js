// Reference-only state. The pinned GLTFLoader owns parsing and material adaptation.
const limits = Object.freeze({ nodes: 10000, mappings: 20000, materials: 512, bindMatrices: 20000 });
const report = (status, diagnostics = [], metrics = {}) => ({
  schema: 'r3i-019/reference-1', status, metrics, units: { nodes: 'nodes', mappings: 'mappings', restDelta: 'matrix component', tolerance: 'matrix component' },
  assumptions: ['Loaded scene coordinates; inverseBindMatrices define joint bind worlds.', 'Only already loaded texture resources; no additional resource fetches.'], diagnostics
});
const unavailable = message => report('unsupported', [message]);
const delta = (a, b) => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])));

export async function attachReferenceView(view, gltf, { THREE, el }) {
  // Retry loads reuse an instance; wrappers are installed only once.
  if (!view.referenceInstalled) install(view, el);
  view.referenceDisposed = false;
  const state = view.referenceState = { defaults: new Map(), current: new Map(), nodes: [], skins: [], owned: new Set(view.referenceState?.owned || []), variants: [], bindings: new Map(), pose: 'animation', disposed: false };
  const parser = gltf.parser, json = parser?.json;
  let count = 0, bindMatrices = 0;
  let oversizedSkin = false;
  gltf.scene.traverse(node => { count++; if (node.isSkinnedMesh) { bindMatrices += node.skeleton.boneInverses.length; if (bindMatrices > limits.bindMatrices) oversizedSkin = true; } });
  if (count > limits.nodes || oversizedSkin) {
    state.variantResult = state.bindResult = report('budget_exceeded', ['Node/skin matrix budget exceeded'], { nodes: count });
    return;
  }
  // Preserve supplied bind inverses before three.js updates attached/detached
  // skins; its world update can otherwise silently replace inconsistent data.
  const suppliedInverses = new Map();
  gltf.scene.traverse(node => { if (node.isSkinnedMesh) suppliedInverses.set(node, node.bindMatrixInverse.clone()); });
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(node => {
    state.nodes.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(), matrix: node.matrix.clone(), world: node.matrixWorld.clone(), auto: node.matrixAutoUpdate, morph: node.morphTargetInfluences?.slice() });
    if (node.isMesh) state.defaults.set(node, node.userData.orig || node.material);
    if (node.isSkinnedMesh) {
      let linked = node, declared;
      while (linked) {
        const association = parser?.associations?.get(linked);
        const definition = json?.nodes?.[association?.nodes];
        if (definition?.skin != null) { declared = json.skins?.[definition.skin]; break; }
        linked = linked.parent;
      }
      const accessor = json?.accessors?.[declared?.inverseBindMatrices];
      state.skins.push({ mesh: node, declared, accessor, bind: node.bindMatrix.clone(), inverse: suppliedInverses.get(node), mode: node.bindMode, inverses: node.skeleton.boneInverses.map(m => m.clone()) });
    }
  });
  state.bindResult = prepareBind(state, THREE);
  state.variantResult = unavailable('Material variants unavailable: extension or mappings missing.');
  if (!json || !parser.associations || !parser.getDependency || !parser.assignFinalMaterial) return;
  const ext = json.extensions?.KHR_materials_variants;
  if (!ext) return;
  try {
    if (Array.isArray(ext.variants) && ext.variants.length > limits.materials) { state.variantResult = report('budget_exceeded', ['Variant declaration budget exceeded']); return; }
    if (!Array.isArray(ext.variants) || !ext.variants.length || ext.variants.some(v => !v || typeof v.name !== 'string')) throw new Error('Malformed variant declarations.');
    const plans = [], indices = new Set(); let mappings = 0;
    for (const mesh of state.defaults.keys()) {
      const a = parser.associations.get(mesh);
      const primitive = json.meshes?.[a?.meshes]?.primitives?.[a?.primitives];
      const mapping = primitive?.extensions?.KHR_materials_variants;
      if (!mapping) continue;
      if (!Array.isArray(mapping.mappings) || !mapping.mappings.length) throw new Error('Malformed primitive mappings.');
      const seen = new Set();
      for (const m of mapping.mappings) {
        if (++mappings > limits.mappings) { state.variantResult = report('budget_exceeded', ['Mapping budget exceeded']); return; }
        if (!Number.isInteger(m?.material) || !json.materials?.[m.material] || !Array.isArray(m.variants) || !m.variants.length) throw new Error('Malformed material mapping.');
        for (const v of m.variants) {
          if (!Number.isInteger(v) || !ext.variants[v] || seen.has(v)) throw new Error('Invalid or duplicate variant mapping.');
          seen.add(v); plans.push({ mesh, variant: v, material: m.material });
          if (plans.length > limits.mappings) { state.variantResult = report('budget_exceeded', ['Variant binding budget exceeded']); return; }
        }
        indices.add(m.material);
      }
    }
    if (!plans.length) throw new Error('Material variants unavailable: no loaded primitive mappings.');
    if (indices.size > limits.materials) { state.variantResult = report('budget_exceeded', ['Material budget exceeded']); return; }
    // getDependency(material) may load textures. Refuse any texture not already in
    // the loaded parser associations, including compressed or remote resources.
    const loadedTextures = new Set();
    for (const [object, association] of parser.associations) if (object.isTexture) loadedTextures.add(association.textures);
    let resourceOperations = 0;
    const checkTextures = (object, depth = 0) => {
      if (!object || typeof object !== 'object') return;
      if (++resourceOperations > limits.mappings || depth > 32) throw Object.assign(new Error('Material resource budget exceeded.'), { budget: true });
      for (const [key, value] of Object.entries(object)) {
        if (/Texture$/.test(key) && value && (!Number.isInteger(value.index) || !loadedTextures.has(value.index))) throw new Error('Variant texture resource is not already loaded; unavailable.');
        if (key !== 'extras') checkTextures(value, depth + 1);
      }
    };
    for (const i of indices) checkTextures(json.materials[i]);
    const materials = new Map();
    for (const i of indices) {
      const material = await parser.getDependency('material', i);
      if (state.disposed) {
        if (!state.disposedMaterials.has(material.uuid)) material.dispose();
        return;
      }
      state.owned.add(material); materials.set(i, material);
    }
    for (const p of plans) {
      // A proxy preserves the primitive geometry flags without changing its binding.
      const proxy = { geometry: p.mesh.geometry, material: materials.get(p.material), isPoints: p.mesh.isPoints, isLine: p.mesh.isLine };
      parser.assignFinalMaterial(proxy); state.owned.add(proxy.material);
      if (!state.bindings.has(p.variant)) state.bindings.set(p.variant, new Map());
      state.bindings.get(p.variant).set(p.mesh, proxy.material);
    }
    state.variants = ext.variants.map(v => v.name);
    state.variantResult = report('ok', [], { mappings });
  } catch (error) { state.variantResult = error.budget ? report('budget_exceeded', [error.message]) : unavailable('Material variants unavailable: ' + error.message); }
}

function prepareBind(state, THREE) {
  if (!state.skins.length) return unavailable('Bind pose unavailable: no loaded skin. Use loaded rest pose.');
  const worlds = new Map(), locals = new Map(), tolerance = 1e-6;
  const invertible = matrix => matrix.elements.every(Number.isFinite) && Number.isFinite(matrix.determinant()) && Math.abs(matrix.determinant()) > 1e-12;
  try {
    for (const skin of state.skins) {
      const skeleton = skin.mesh.skeleton;
      if (!skin.declared || !Array.isArray(skin.declared.joints) || !skeleton.bones.length || skin.declared.joints.length !== skeleton.bones.length || skeleton.bones.length !== skin.inverses.length) throw new Error('Incomplete loaded skin/joint evidence.');
      if (skin.declared.inverseBindMatrices != null && (!skin.accessor || skin.accessor.type !== 'MAT4' || skin.accessor.componentType !== 5126 || skin.accessor.count !== skeleton.bones.length)) throw new Error('Incomplete inverseBindMatrices accessor.');
      if (!['attached', 'detached'].includes(skin.mode) || !invertible(skin.bind) || !invertible(skin.inverse)) throw new Error('Invalid skin bind matrices.');
      // Attached mode derives the inverse from the mesh world; detached uses bindMatrix.
      const source = skin.mode === 'attached' ? skin.mesh.matrixWorld : skin.bind;
      if (!invertible(source) || delta(source.clone().invert(), skin.inverse) > tolerance) throw new Error('Inconsistent skin bind inverse.');
      skeleton.bones.forEach((bone, i) => {
        if (!bone || !invertible(skin.inverses[i])) throw new Error('Noninvertible or incomplete inverseBindMatrices.');
        const world = skin.inverses[i].clone().invert();
        if (worlds.has(bone) && delta(worlds.get(bone), world) > tolerance) throw new Error('Inconsistent shared joint inverseBindMatrices.');
        worlds.set(bone, world);
      });
    }
    // Compute parent worlds in scene traversal order, including non-joint children.
    const resolved = new Map(); let restDelta = 0;
    for (const saved of state.nodes) {
      const node = saved.node, parentWorld = resolved.get(node.parent) || node.parent?.matrixWorld || new THREE.Matrix4();
      const world = worlds.get(node) || parentWorld.clone().multiply(saved.matrix);
      if (worlds.has(node)) {
        if (!invertible(parentWorld)) throw new Error('Noninvertible joint parent.');
        const local = parentWorld.clone().invert().multiply(world);
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); local.decompose(p, q, s);
        if (!invertible(local) || delta(new THREE.Matrix4().compose(p, q, s), local) > tolerance) throw new Error('Bind transform cannot be represented by node TRS.');
        locals.set(node, { matrix: local, position: p, quaternion: q, scale: s });
        restDelta = Math.max(restDelta, delta(world, saved.world));
      }
      resolved.set(node, world);
    }
    if ([...worlds.keys()].some(bone => !locals.has(bone))) throw new Error('Joint outside loaded scene.');
    state.bindLocals = locals;
    return report('ok', [], { nodes: locals.size, restDelta, tolerance });
  } catch (error) { return unavailable('Bind pose unsupported: ' + error.message); }
}

function restore(state) {
  for (const s of state.nodes) {
    s.node.position.copy(s.position); s.node.quaternion.copy(s.quaternion); s.node.scale.copy(s.scale); s.node.matrix.copy(s.matrix); s.node.matrixAutoUpdate = s.auto;
    if (s.morph) s.node.morphTargetInfluences.splice(0, s.morph.length, ...s.morph);
  }
  for (const s of state.skins) {
    s.mesh.bindMatrix.copy(s.bind); s.mesh.bindMatrixInverse.copy(s.inverse); s.mesh.bindMode = s.mode;
    s.inverses.forEach((matrix, i) => s.mesh.skeleton.boneInverses[i].copy(matrix));
  }
}

function install(view, el) {
  view.referenceInstalled = true;
  view.setVariant = function (variant = null) {
    const s = this.referenceState;
    if (!s || s.disposed || (variant !== null && (s.variantResult.status !== 'ok' || !Number.isInteger(variant) || !s.variants[variant]))) return unavailable('Material variant unavailable.');
    s.current = new Map(s.bindings.get(variant) || []); s.variant = variant;
    this.applyMats(); return report('ok');
  };
  view.setPose = function (pose) {
    const s = this.referenceState;
    if (!s || s.disposed || !['animation', 'rest', 'bind'].includes(pose)) return unavailable('Pose unavailable.');
    if (pose === 'bind' && s.bindResult.status !== 'ok') return s.bindResult;
    if (pose === 'animation') {
      restore(s); this.root.updateMatrixWorld(true); s.pose = pose;
      for (const clip of this.clips || []) this.mixer.clipAction(clip).play();
      this.setClip(this.activeClip ?? 'all');
      this.mixer?.setTime(this.time || 0); this.playing = s.wasPlaying ?? true;
    } else {
      if (s.pose === 'animation') s.wasPlaying = this.playing;
      this.mixer?.stopAllAction();
      for (const clip of this.clips || []) this.mixer.clipAction(clip).enabled = false;
      this.playing = false; restore(s);
      if (pose === 'bind') for (const [node, local] of s.bindLocals) {
        node.position.copy(local.position); node.quaternion.copy(local.quaternion); node.scale.copy(local.scale); node.matrix.copy(local.matrix);
      }
      this.root.updateMatrixWorld(true); s.pose = pose;
    }
    this.poseControl && (this.poseControl.value = pose);
    return pose === 'bind' ? s.bindResult : report('ok');
  };
  const setClip = view.setClip;
  view.setClip = function (clip) {
    if (this.referenceState?.pose !== 'animation') this.setPose('animation');
    return setClip.call(this, clip);
  };
  const apply = view.applyMats;
  view.applyMats = function (...args) {
    const s = this.referenceState;
    if (!s || s.disposed) return apply.apply(this, args);
    try {
      for (const [mesh, material] of s.current) mesh.userData.orig = material;
      return apply.apply(this, args);
    } finally { for (const [mesh, material] of s.defaults) mesh.userData.orig = material; }
  };
  const frame = view.frame;
  view.frame = function (...args) {
    if (!this.referenceState || this.referenceState.pose === 'animation') return frame.apply(this, args);
    const mixer = this.mixer, spin = this.flags.spin;
    try { this.mixer = null; this.flags.spin = false; return frame.apply(this, args); }
    finally { this.mixer = mixer; this.flags.spin = spin; }
  };
  const extras = view.extras;
  view.extras = function (...args) {
    const nodes = extras.apply(this, args), s = this.referenceState;
    if (!s || s.disposed) return nodes;
    nodes.push(el('select', { 'aria-label': 'Material variant', disabled: s.variantResult.status !== 'ok', onchange: e => this.setVariant(e.target.value === 'default' ? null : +e.target.value) },
      el('option', { value: 'default', selected: s.variant == null }, 'Default materials'), s.variants.map((name, i) => el('option', { value: i, selected: s.variant === i }, name))),
    el('span', { role: 'status' }, s.variantResult.diagnostics.join(' ')),
    this.poseControl = el('select', { 'aria-label': 'Reference pose', onchange: e => this.setPose(e.target.value) },
      el('option', { value: 'animation', selected: s.pose === 'animation' }, 'Resume selected clip'),
      el('option', { value: 'rest', selected: s.pose === 'rest' }, 'Loaded rest pose'),
      el('option', { value: 'bind', selected: s.pose === 'bind', disabled: s.bindResult.status !== 'ok' }, 'Bind pose')),
    el('span', { role: 'status' }, s.bindResult.status === 'ok' ? (s.bindResult.metrics.restDelta > 1e-6 ? 'Loaded rest pose differs from bind pose.' : '') : s.bindResult.diagnostics.join(' ')));
    return nodes;
  };
  const dispose = view.disposeScene;
  view.disposeScene = function (...args) {
    const s = this.referenceState;
    if (s?.disposed || this.referenceDisposed) return;
    this.referenceDisposed = true;
    if (s) {
      // Existing disposer deduplicates geometry, materials and textures. Include
      // unused variant dependencies in that same set, never a second disposer.
      this.hiMaterials ||= new Set(); for (const material of s.owned) this.hiMaterials.add(material);
      for (const [mesh, material] of s.defaults) { mesh.userData.orig = material; mesh.material = material; }
      s.disposedMaterials = new Set([...this.hiMaterials].map(m => m.uuid));
      this.scene?.traverse(o => { for (const m of [].concat(o.material || [], o.userData.orig || [])) s.disposedMaterials.add(m.uuid); });
      s.disposed = true;
    }
    try { return dispose.apply(this, args); }
    finally {
      if (s) { s.defaults.clear(); s.current.clear(); s.bindings.clear(); s.owned.clear(); s.bindLocals?.clear(); s.nodes = []; s.skins = []; s.variants = []; }
      this.referenceState = null; this.poseControl = null;
    }
  };
}
