import { THREE } from './three-lazy.js';

// Keep the internal diagnostic contract; present the normals live region in Dutch.
function normalStatusText(status) {
  if (!status) return '';
  const counts = /^Vertex normals: (sampled )?(\d+) of (\d+)(?:; (\d+) meshes omitted \(inspection limits\))?$/.exec(status);
  if (counts) return `Vertexnormals: ${counts[1] ? 'sample ' : ''}${counts[2]} of ${counts[3]}` +
    (counts[4] ? `; ${counts[4]} meshes weggelaten (inspectielimieten)` : '');
  const reasons = {
    'No normals available within inspection limits': 'No normals available within the inspection limits.',
    'Unsafe expanded normal count': 'Unsafe normal count after expansion.',
    'Unsafe scene normal count': 'Unsafe normal count in the scene.',
    'Incomplete normal attributes': 'Normal attributes are incomplete.',
    'Incomplete instance matrices': 'Instance matrices are incomplete.',
    'Source changed; re-enable normals to inspect it': 'Source changed; turn normals on again.',
    'Source changed; re-enable generated normals': 'Source changed; turn generated normals on again.'
  };
  const reason = status.replace(/^Vertex normals incomplete: /, '');
  return 'Vertex normals incomplete: ' + (reasons[reason] || 'The geometry could not be checked safely.');
}

// glTF coordinates are metres. Measurements retain world-space points at pick time.
export function measureDistance(a, b) {
  const metres = a.distanceTo(b);
  return { metres, millimetres: metres * 1000 };
}
export function formatDistance(metres) {
  return `${Number(metres.toFixed(3))} m / ${Number((metres * 1000).toFixed(1))} mm`;  // float32 noise showed as 13.700002 m
}
export function modelBounds(meshes) {
  const box = new THREE.Box3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    // Use only source meshes: grids, pivots and inspection helpers are excluded.
    if (mesh.isSkinnedMesh || mesh.isInstancedMesh) mesh.computeBoundingBox();
    else if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.boundingBox || mesh.geometry.boundingBox;
    if (local) box.union(local.clone().applyMatrix4(mesh.matrixWorld));
  }
  return { box, dimensions: box.getSize(new THREE.Vector3()) };
}
export function comparisonVersions(versions, current) {
  return versions.filter(v => v.v !== current && v.files.some(f => f.media === 'model'));
}

// Weighted operation units include attribute reads, transforms and skinning.
export const NORMAL_LIMITS = Object.freeze({ samples: 2048, bytes: 256 * 1024, operations: 65536, meshes: 128, morphTargets: 16, bones: 64, depth: 32 });
const EMPTY_NORMAL_ATTRIBUTES = Object.freeze([]);
const safeCount = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} count`);
  return value;
};
function normalSpec(mesh) {
  const geometry = mesh.geometry, position = geometry.attributes.position;
  const vertices = safeCount(position?.count, 'vertex'), instances = safeCount(mesh.isInstancedMesh ? mesh.count : 1, 'instance');
  if (vertices && instances > Number.MAX_SAFE_INTEGER / vertices) throw new Error('Unsafe expanded normal count');
  const expanded = vertices * instances;
  if (geometry.attributes.normal && safeCount(geometry.attributes.normal.count, 'normal') !== vertices) throw new Error('Incomplete normal attributes');
  const spec = { mesh, geometry, position, vertices, instances, expanded, normal: geometry.attributes.normal, copyBytes: 0, copyOperations: 0 };
  const positions = geometry.morphAttributes.position || EMPTY_NORMAL_ATTRIBUTES, normals = geometry.morphAttributes.normal || EMPTY_NORMAL_ATTRIBUTES, bones = mesh.isSkinnedMesh ? mesh.skeleton.bones : EMPTY_NORMAL_ATTRIBUTES;
  if (positions.length > NORMAL_LIMITS.morphTargets || normals.length > NORMAL_LIMITS.morphTargets || bones.length > NORMAL_LIMITS.bones || mesh.morphTexture) return { ...spec, omitted: true };
  if (mesh.isInstancedMesh && safeCount(mesh.instanceMatrix.count, 'instance matrix') < instances) throw new Error('Incomplete instance matrices');
  spec.positions = positions; spec.normals = normals; spec.bones = bones;
  let depth = 0;
  for (const object of [mesh, ...bones]) {
    let n = 0;
    for (let parent = object; parent; parent = parent.parent) if (++n > NORMAL_LIMITS.depth) return { ...spec, omitted: true };
    depth += n;
  }
  spec.prepOperations = 64 + depth * 16 + bones.length * 32;
  spec.sampleOperations = 16 + (positions.length + normals.length) * 4 + (mesh.isSkinnedMesh ? 80 : 0);
  spec.dynamic = mesh.isSkinnedMesh || positions.length > 0 || normals.length > 0;
  if (!spec.normal) {
    // Generating missing normals must also fit the byte/work budget. Never clone
    // an entire large source just to display a small sample of its normals.
    for (const attribute of [position, geometry.index].filter(Boolean)) {
      spec.copyBytes += safeCount((attribute.array || attribute.data?.array)?.byteLength, 'attribute byte');
    }
    spec.copyBytes += vertices * 12;
    spec.copyOperations = safeCount(geometry.index ? geometry.index.count : vertices, 'index') * 16 + vertices * 8 + Math.ceil(spec.copyBytes / 4);
    if (spec.copyBytes > NORMAL_LIMITS.bytes || spec.copyOperations > NORMAL_LIMITS.operations) return { ...spec, omitted: true };
  }
  return spec;
}
export function planNormals(meshes) {
  const specs = [], entries = [];
  let total = 0, omitted = Math.max(0, meshes.length - NORMAL_LIMITS.meshes);
  for (let i = 0; i < Math.min(meshes.length, NORMAL_LIMITS.meshes); i++) {
    const spec = normalSpec(meshes[i]);
    if (!Number.isSafeInteger(total + spec.expanded)) throw new Error('Unsafe scene normal count');
    total += spec.expanded;
    if (spec.omitted) omitted++; else if (spec.expanded) specs.push(spec);
  }
  let samples = 0, bytes = 0, operations = 0;
  for (const [index, spec] of specs.entries()) {
    const remaining = specs.length - index;
    const allowance = Math.floor((NORMAL_LIMITS.operations - operations) / remaining) - spec.prepOperations - spec.copyOperations;
    const count = Math.min(spec.expanded, Math.floor((NORMAL_LIMITS.samples - samples) / remaining), Math.floor((NORMAL_LIMITS.bytes - bytes - spec.copyBytes) / 24), Math.floor(allowance / spec.sampleOperations));
    if (count < 1) { omitted++; continue; }
    samples += count; bytes += count * 24 + spec.copyBytes;
    operations += spec.prepOperations + spec.copyOperations + count * spec.sampleOperations;
    entries.push({ ...spec, count });
  }
  return { entries, samples, bytes, operations, total, omitted };
}

// Own all temporary resources explicitly; never dispose source model resources.
export class InspectTools {
  constructor(view, { refreshMaterials = () => {}, activateMeasure = () => {} } = {}) {
    this.view = view;
    this.refreshMaterials = refreshMaterials;
    this.activateMeasure = activateMeasure;
    this.layers = new Map();
    this.originals = new Map(view.meshes.map(mesh => [mesh, mesh.material]));
    this.points = [];
    this.measuring = false;
    this.disposed = false;
  }
  layer(name) {
    const layer = { objects: [], resources: new Set() };
    this.layers.set(name, layer);
    return layer;
  }
  own(layer, resource) { layer.resources.add(resource); return resource; }
  add(layer, object, parent = this.view.scene) { parent.add(object); layer.objects.push(object); return object; }
  remove(name) {
    const layer = this.layers.get(name);
    if (!layer) return;
    for (const object of layer.objects) object.removeFromParent();
    for (const resource of layer.resources) resource.dispose();
    this.layers.delete(name);
  }
  toggle(name, on = !this.layers.has(name)) {
    if (this.disposed) return;
    if (name === 'normals') {
      this.remove(name); this.normalStatus = '';
      if (on) {
        try { this.createNormals(); this.updateNormals(); }
        catch (error) { this.failNormals(error); }
      }
      this.renderState(); return;
    }
    this.remove(name);
    if (name === 'uv') this.uvMaterial = null;
    if (on) {
      const layer = this.layer(name), own = resource => this.own(layer, resource);
      if (name === 'wire') {
        const material = own(new THREE.MeshBasicMaterial({ color: 0x111111, wireframe: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        for (const mesh of this.view.meshes) {
          const overlay = mesh.clone(false);
          overlay.geometry = own(mesh.geometry.clone()); overlay.material = material;
          overlay.position.set(0, 0, 0); overlay.quaternion.identity(); overlay.scale.set(1, 1, 1);
          overlay.matrix.identity(); overlay.userData = {};
          overlay.morphTargetInfluences = mesh.morphTargetInfluences;
          if (overlay.isInstancedMesh) own(overlay); // Includes its instance buffers and cloned morph texture.
          overlay.renderOrder = 2;
          this.add(layer, overlay, mesh);
        }
      } else if (name === 'uv') {
        const size = 64, pixels = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.set(((x >> 3) + (y >> 3)) % 2 ? [25, 80, 180, 255] : [240, 220, 70, 255], (y * size + x) * 4);
        const texture = own(new THREE.DataTexture(pixels, size, size));
        texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
        this.uvMaterial = own(new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
      } else if (name === 'bbox') {
        const helper = new THREE.Box3Helper(modelBounds(this.view.meshes).box, 0xe8c45c);
        own(helper.geometry); own(helper.material); this.add(layer, helper);
      }
    }
    if (name === 'uv') {
      if (!on) for (const [mesh, material] of this.originals) mesh.material = material;
      this.refreshMaterials(); this.applyMaterials();
    }
    this.update(); this.renderState();
  }
  createNormals() {
    const plan = planNormals(this.view.meshes); // No resource allocation before all count/byte/work checks.
    if (!plan.samples) throw new Error('No normals available within inspection limits');
    const layer = this.layer('normals'); layer.plan = plan;
    const own = resource => this.own(layer, resource);
    const material = own(new THREE.LineBasicMaterial({ color: 0x70eac2 }));
    for (const spec of plan.entries) {
      const geometry = own(new THREE.BufferGeometry());
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(spec.count * 6), 3));
      let source = spec.geometry;
      if (!spec.normal) {
        source = own(new THREE.BufferGeometry());
        source.setAttribute('position', spec.position.clone());
        if (spec.geometry.index) source.setIndex(spec.geometry.index.clone());
        source.computeVertexNormals();
      }
      const helper = this.add(layer, new THREE.LineSegments(geometry, material));
      helper.userData.source = spec.mesh; helper.userData.normals = source.attributes.normal;
      helper.userData.spec = spec; helper.userData.previousMatrix = new THREE.Matrix4();
      helper.frustumCulled = false;
    }
    this.normalStatus = `Vertex normals: ${plan.samples < plan.total ? 'sampled ' : ''}${plan.samples} of ${plan.total}` + (plan.omitted ? `; ${plan.omitted} meshes omitted (inspection limits)` : '');
  }
  failNormals(error) {
    this.remove('normals'); this.normalWork = { samples: 0, operations: 0 };
    this.normalStatus = 'Vertex normals incomplete: ' + error.message;
    this.renderState();
  }
  applyMaterials() {
    if (this.uvMaterial) for (const mesh of this.view.meshes) if (mesh.geometry.attributes.uv) mesh.material = this.uvMaterial;
  }
  setMeasuring(on) {
    if (this.disposed) return;
    if (on) this.activateMeasure();
    this.measuring = on;
    this.view.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    this.renderState();
  }
  handleClick(event) {
    if (!this.measuring) return false;
    const hit = this.view.hit(event);
    if (hit) this.addPoint(hit.point);
    return true; // A miss must not create an annotation either.
  }
  addPoint(point) {
    if (this.disposed) return;
    if (this.points.length === 2) this.clearMeasurement();
    this.points.push(point.clone());
    this.remove('measurement');
    const layer = this.layer('measurement'), own = resource => this.own(layer, resource);
    const radius = Math.max((this.view.radius || 1) * 0.008, 0.0001);
    const geometry = own(new THREE.SphereGeometry(radius, 8, 6));
    const material = own(new THREE.MeshBasicMaterial({ color: 0xe8c45c, depthTest: false }));
    for (const p of this.points) { const marker = new THREE.Mesh(geometry, material); marker.position.copy(p); marker.renderOrder = 10; this.add(layer, marker); }
    if (this.points.length === 2) {
      const line = new THREE.Line(own(new THREE.BufferGeometry().setFromPoints(this.points)), own(new THREE.LineBasicMaterial({ color: 0xe8c45c, depthTest: false })));
      line.renderOrder = 10; this.add(layer, line);
    }
    this.renderState();
  }
  clearMeasurement() { this.points = []; this.remove('measurement'); this.renderState(); }
  update() {
    if (this.layers.has('bbox')) {
      this.view.root.updateWorldMatrix(true, true);
      for (const mesh of this.view.meshes) if (mesh.isSkinnedMesh) mesh.skeleton.update();
    }
    const bbox = this.layers.get('bbox');
    if (bbox) {
      const { box, dimensions } = modelBounds(this.view.meshes);
      bbox.objects[0].box.copy(box);
      const text = ['X', 'Y', 'Z'].map((axis, i) => `${axis}: ${formatDistance(dimensions.getComponent(i))}`).join(' · ');
      if (this.boundsOutput && this.boundsOutput.textContent !== text) this.boundsOutput.textContent = text;
    }
    try { this.updateNormals(); } catch (error) { this.failNormals(error); }
  }
  updateNormals() {
    this.normalWork = { samples: 0, operations: 0 };
    const length = Math.max((this.view.radius || 1) * 0.04, 0.001);
    for (const helper of this.layers.get('normals')?.objects || []) {
      const mesh = helper.userData.source, normals = helper.userData.normals, positions = helper.geometry.attributes.position;
      const data = helper.userData, spec = data.spec, current = normalSpec(mesh);
      if (current.omitted || current.geometry !== spec.geometry || current.position !== spec.position || current.normal !== spec.normal || current.vertices !== spec.vertices || current.instances !== spec.instances || current.prepOperations !== spec.prepOperations || current.sampleOperations !== spec.sampleOperations || current.positions !== spec.positions || current.normals !== spec.normals || current.bones !== spec.bones) throw new Error('Source changed; re-enable normals to inspect it');
      this.normalWork.operations += spec.prepOperations;
      mesh.updateWorldMatrix(true, false);
      const version = `${spec.position.version}/${spec.normal?.version}/${mesh.instanceMatrix?.version}`;
      if (!spec.dynamic && data.ready && data.previousMatrix.equals(mesh.matrixWorld) && data.version === version && data.length === length) continue;
      if (!spec.normal && data.ready && data.version !== version) throw new Error('Source changed; re-enable generated normals');
      if (mesh.isSkinnedMesh) { for (const bone of spec.bones) bone.updateWorldMatrix(true, false); mesh.skeleton.update(); }
      const p = new THREE.Vector3(), n = new THREE.Vector3(), matrix = new THREE.Matrix4(), instance = new THREE.Matrix4(), normalMatrix = new THREE.Matrix3();
      const baseNormal = new THREE.Vector3(), morphNormal = new THREE.Vector3(), boneMatrix = new THREE.Matrix4();
      const bindNormal = new THREE.Vector4(), boneNormal = new THREE.Vector4(), skinnedNormal = new THREE.Vector4();
      const skinIndices = new THREE.Vector4(), skinWeights = new THREE.Vector4();
      for (let sample = 0; sample < spec.count; sample++) {
        // Evenly cover the expanded vertex/instance domain without expanding it.
        const flat = Math.floor(sample * (spec.expanded / spec.count));
        const j = Math.floor(flat / spec.vertices), i = flat % spec.vertices;
        this.normalWork.samples++; this.normalWork.operations += spec.sampleOperations;
        matrix.copy(mesh.matrixWorld);
        if (mesh.isInstancedMesh) { mesh.getMatrixAt(j, instance); matrix.multiply(instance); }
        normalMatrix.getNormalMatrix(matrix);
        mesh.getVertexPosition(i, p); p.applyMatrix4(matrix);
        n.fromBufferAttribute(normals, i); baseNormal.copy(n);
        for (const [target, attribute] of (mesh.geometry.morphAttributes.normal || []).entries()) {
          const influence = mesh.morphTargetInfluences?.[target] || 0;
          morphNormal.fromBufferAttribute(attribute, i);
          if (!mesh.geometry.morphTargetsRelative) morphNormal.sub(baseNormal);
          n.addScaledVector(morphNormal, influence);
        }
        if (mesh.isSkinnedMesh) {
          skinIndices.fromBufferAttribute(mesh.geometry.attributes.skinIndex, i);
          skinWeights.fromBufferAttribute(mesh.geometry.attributes.skinWeight, i);
          bindNormal.set(n.x, n.y, n.z, 0).applyMatrix4(mesh.bindMatrix); skinnedNormal.set(0, 0, 0, 0);
          for (let k = 0; k < 4; k++) {
            boneMatrix.fromArray(mesh.skeleton.boneMatrices, skinIndices.getComponent(k) * 16);
            boneNormal.copy(bindNormal).applyMatrix4(boneMatrix).multiplyScalar(skinWeights.getComponent(k));
            skinnedNormal.add(boneNormal);
          }
          skinnedNormal.applyMatrix4(mesh.bindMatrixInverse); n.set(skinnedNormal.x, skinnedNormal.y, skinnedNormal.z);
        }
        n.applyNormalMatrix(normalMatrix).multiplyScalar(length);
        positions.setXYZ(sample * 2, p.x, p.y, p.z); p.add(n); positions.setXYZ(sample * 2 + 1, p.x, p.y, p.z);
      }
      positions.needsUpdate = true;
      data.ready = true; data.previousMatrix.copy(mesh.matrixWorld); data.version = version; data.length = length;
    }
  }
  mountToolbar(parent, { versions = [], current, compare, comparing = false, comparison } = {}) {
    const doc = parent.ownerDocument;
    const toolbar = this.toolbar = doc.createElement('div'); toolbar.className = 'ar-inspect-tools';
    toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '3D-controles');
    this.buttons = new Map();
    const row = doc.createElement('div'); row.className = 'ar-inspect-row'; toolbar.append(row);
    const button = (id, text, action, shortcut) => {
      const element = doc.createElement('button'); element.type = 'button'; element.textContent = text;
      element.dataset.inspect = id; element.title = shortcut ? `${text} (key ${shortcut.toUpperCase()}, click in the view first)` : text;
      if (shortcut) element.setAttribute('aria-keyshortcuts', shortcut.toUpperCase());
      element.addEventListener('click', action); row.append(element); this.buttons.set(id, element); return element;
    };
    button('measure', 'Measure distance', () => this.setMeasuring(!this.measuring), 'm');
    button('clear', 'Clear measurement', () => this.clearMeasurement());
    for (const [id, text, key] of [['wire', 'Wireframe', 'w'], ['normals', 'Vertex normals', 'v'], ['uv', 'UV checker', 'q'], ['bbox', 'Dimensions', 'b']]) button(id, text, () => this.toggle(id), key);
    const candidates = comparisonVersions(versions, current);
    if (compare && candidates.length) {
      const select = doc.createElement('select'); select.setAttribute('aria-label', 'A/B version');
      for (const version of candidates) { const option = doc.createElement('option'); option.value = version.v; option.textContent = `v${version.v}`; select.append(option); }
      select.value = (candidates.find(v => comparing && v.v === comparison) || candidates.filter(v => v.v < current).at(-1) || candidates[0]).v;
      row.append(select);
      const element = button('compare', 'A/B', () => compare(Number(select.value))); element.setAttribute('aria-pressed', String(comparing));
    }
    this.measureOutput = doc.createElement('output'); this.measureOutput.setAttribute('aria-live', 'polite'); toolbar.append(this.measureOutput);
    this.boundsOutput = doc.createElement('output'); this.boundsOutput.className = 'ar-inspect-bounds'; toolbar.append(this.boundsOutput);
    this.normalOutput = doc.createElement('output'); this.normalOutput.className = 'ar-inspect-normal-status'; this.normalOutput.setAttribute('aria-live', 'polite'); toolbar.append(this.normalOutput);
    parent.append(toolbar);
    const canvas = this.view.renderer.domElement; canvas.tabIndex = 0;
    this.onFocus = () => canvas.focus({ preventScroll: true }); canvas.addEventListener('pointerdown', this.onFocus);
    this.onKey = event => {
      if (event.target !== canvas || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
      const id = { m: 'measure', w: 'wire', v: 'normals', q: 'uv', b: 'bbox' }[event.key.toLowerCase()];
      if (id) { event.preventDefault(); event.stopPropagation(); this.buttons.get(id).click(); }
    };
    canvas.addEventListener('keydown', this.onKey);
    this.renderState();
    return toolbar;
  }
  renderState() {
    for (const [id, button] of this.buttons || []) {
      if (id !== 'clear' && id !== 'compare') button.setAttribute('aria-pressed', String(id === 'measure' ? this.measuring : this.layers.has(id)));
      if (id === 'clear') button.disabled = this.points.length === 0;
    }
    if (this.measureOutput) this.measureOutput.textContent = this.points.length === 2 ? formatDistance(measureDistance(...this.points).metres) : this.measuring ? (this.points.length ? 'Click the second point on the model' : 'Click two points on the model') : '';
    if (this.boundsOutput) this.boundsOutput.hidden = !this.layers.has('bbox');
    if (this.normalOutput) { this.normalOutput.hidden = !this.normalStatus; this.normalOutput.textContent = normalStatusText(this.normalStatus); }
  }
  dispose() {
    if (this.disposed) return;
    for (const [mesh, material] of this.originals) mesh.material = material;
    for (const name of [...this.layers.keys()]) this.remove(name);
    this.uvMaterial = null; this.points = []; this.originals.clear();
    const canvas = this.view.renderer.domElement;
    canvas.removeEventListener('keydown', this.onKey); canvas.removeEventListener('pointerdown', this.onFocus); canvas.style.cursor = '';
    this.toolbar?.remove(); this.disposed = true;
  }
}
