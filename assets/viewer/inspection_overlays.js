import { THREE } from './three-lazy.js';
import { planNormals } from './inspect-tools.js';

export const INSPECTION_LIMITS = Object.freeze({ meshes: 256, provenanceMappings: 1024, vertices: 200000, triangles: 50000, seamEdges: 4096, normalVectors: 512,
  positionTolerance: 1e-6, seamTolerance: 1e-5 });
const finite = vector => vector.toArray().every(Number.isFinite);
const unsupported = mesh => mesh.isSkinnedMesh || mesh.isInstancedMesh || Object.values(mesh.geometry?.morphAttributes || {}).some(a => a.length);
const sourceFrames = new WeakMap(), loaders = new WeakSet();
const inspectionLayout = `@media (max-width:820px) {
  #main:has(#view.split [data-inspection-overlay]) { height:auto;min-height:0; }
  #canvas:has(#view.split [data-inspection-overlay]) { flex:none; }
  #view.split:has([data-inspection-overlay]) { flex:none;min-height:420px; }
  #canvas:has(#view.split [data-inspection-overlay]) #cmpbar {
    position:relative;top:auto;left:auto;transform:none;flex:none;margin:8px;width:calc(100% - 16px);order:0;
  }
}`;


// Only the loader can prove primitive membership. Use the actual mesh instance
// frame, not a mesh index/name shared by unrelated nodes or repeated instances.
export function registerInspectionSources(gltf) {
  const parser = gltf.parser;
  let mappings = 0, meshes = 0;
  for (const [object, association] of parser?.associations || []) {
    if (mappings === INSPECTION_LIMITS.provenanceMappings || meshes === INSPECTION_LIMITS.meshes) break;
    mappings++;
    if (!object.isMesh) continue;
    const primitives = parser.json?.meshes?.[association.meshes]?.primitives;
    if (!Number.isInteger(association.primitives) || !primitives?.[association.primitives]) continue;
    const frame = primitives.length === 1 ? object : object.parent;
    if (frame !== object && parser.associations.get(frame)?.meshes !== association.meshes) continue;
    sourceFrames.set(object, frame); meshes++;
  }
  return { mappings, meshes };
}

// Shared geometric edges are welded in source-frame position bins; open UV borders are
// not seams. UV discontinuity compares both aligned endpoints without wrapping.
export function inspectionPlan(meshes, limits = INSPECTION_LIMITS) {
  const seams = [], normals = [], diagnostics = new Set();
  let vertices = 0, triangles = 0, seamCount = 0, normalCandidates = 0;
  const entries = [], edgeGroups = new Map();
  // Use the same ordered mesh window and allowances as Inspect Tools. Unsupported
  // overlay meshes still consume their share; never grant their budget to props.
  let computed = new Map();
  try {
    computed = new Map(planNormals(meshes.slice(0, limits.meshes)).entries.filter(spec => !spec.normal).map(spec => [spec.mesh, spec]));
  } catch { diagnostics.add('Normals outside inspection limits or source data invalid; calculation skipped.'); }
  let computedCandidates = 0;
  for (const mesh of meshes.slice(0, limits.meshes)) {
    const g = mesh.geometry, p = g?.attributes.position, uv = g?.attributes.uv;
    let n = g?.attributes.normal;
    if (unsupported(mesh)) { diagnostics.add('Skin, morph or instance mesh not supported; overlays skipped.'); continue; }
    const count = g?.index?.count ?? p?.count, tris = count / 3;
    if (!p || p.itemSize !== 3 || !Number.isInteger(tris) || vertices + p.count > limits.vertices || triangles + tris > limits.triangles) {
      diagnostics.add('Topology not supported or inspection budget exceeded; mesh skipped.'); continue;
    }
    vertices += p.count; triangles += tris;
    if (!n) {
      const spec = computed.get(mesh);
      if (spec) {
        const source = new THREE.BufferGeometry();
        try {
          source.setAttribute('position', spec.position.clone());
          if (g.index) source.setIndex(g.index.clone());
          source.computeVertexNormals(); n = source.attributes.normal;
          computedCandidates += p.count;
          diagnostics.add('No own normals; generated ones shown.');
        } finally { source.dispose(); }
      } else diagnostics.add('No own normals; calculation outside inspection limits, vectors skipped.');
    }
    if (n?.itemSize === 3 && n.count === p.count) { entries.push({ mesh, p, n, offset: normalCandidates }); normalCandidates += p.count; }
    else if (n) diagnostics.add('Invalid vertex normals; vectors skipped.');
    if (!uv || uv.itemSize !== 2 || uv.count !== p.count) { diagnostics.add('UV attributes missing or invalid; seams skipped.'); continue; }
    let frame = sourceFrames.get(mesh);
    if (!frame || (frame !== mesh && frame !== mesh.parent)) {
      diagnostics.add('Source mesh origin unknown; UV coverage across primitives not supported.'); frame = mesh;
    }
    if (mesh.matrixAutoUpdate) mesh.updateMatrix();
    const transform = frame === mesh ? new THREE.Matrix4() : mesh.matrix;
    if (!edgeGroups.has(frame)) edgeGroups.set(frame, new Map());
    const edges = edgeGroups.get(frame), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const key = v => v.toArray().map(x => Math.round(x / limits.positionTolerance)).join(',');
    for (let i = 0; i < count; i += 3) {
      const ids = [0, 1, 2].map(j => g.index ? g.index.getX(i + j) : i + j);
      if (ids.some(id => !Number.isInteger(id) || id < 0 || id >= p.count)) { diagnostics.add('Invalid triangle indices; triangle skipped.'); continue; }
      const points = ids.map(id => new THREE.Vector3().fromBufferAttribute(p, id).applyMatrix4(transform));
      const uvs = ids.map(id => [uv.getX(id), uv.getY(id)]);
      if (!points.every(finite) || !uvs.flat().every(Number.isFinite)) { diagnostics.add('Non-finite position or UV; triangle skipped.'); continue; }
      if (c.crossVectors(a.copy(points[1]).sub(points[0]), b.copy(points[2]).sub(points[0])).lengthSq() === 0) {
        diagnostics.add('Degenerate triangle; seams skipped.'); continue;
      }
      for (let j = 0; j < 3; j++) {
        let x = j, y = (j + 1) % 3, kx = key(points[x]), ky = key(points[y]);
        if (kx === ky) continue;
        if (kx > ky) { [x, y] = [y, x]; [kx, ky] = [ky, kx]; }
        const k = kx + '/' + ky, coords = [...uvs[x], ...uvs[y]], previous = edges.get(k);
        if (!previous) edges.set(k, { mesh: frame, a: points[x], b: points[y], coords, seam: false, faces: 1 });
        else { previous.faces++; if (coords.some((v, t) => Math.abs(v - previous.coords[t]) > limits.seamTolerance)) previous.seam = true; }
      }
    }
  }
  for (const edges of edgeGroups.values()) {
    for (const edge of edges.values()) {
      if (edge.faces > 2) diagnostics.add('Non-manifold UV edge; discontinuity shown without manifold guarantee.');
      if (edge.seam) { seamCount++; if (seams.length < limits.seamEdges) seams.push(edge); }
    }
  }
  if (meshes.length > limits.meshes) diagnostics.add('Mesh limit reached; remaining meshes skipped.');
  const sampleCount = Math.min(normalCandidates, limits.normalVectors);
  let entry = 0;
  for (let j = 0; j < sampleCount; j++) {
    const id = Math.floor(j * normalCandidates / sampleCount);
    while (entry + 1 < entries.length && entries[entry + 1].offset <= id) entry++;
    const { mesh, p, n, offset } = entries[entry], index = id - offset;
    const position = new THREE.Vector3().fromBufferAttribute(p, index), normal = new THREE.Vector3().fromBufferAttribute(n, index);
    if (!finite(position) || !finite(normal) || normal.lengthSq() === 0) { diagnostics.add('Degenerate or non-finite normal; sample vector skipped.'); continue; }
    normals.push({ mesh, position, normal });
  }
  if (seamCount > seams.length) diagnostics.add('UV seam edge limit reached.');
  if (normalCandidates > sampleCount) diagnostics.add('World normals shown as a sample because of the vector limit.');
  return { seams, normals, diagnostics, seamCount, normalCandidates, computedCandidates, vertices, triangles, sourceGroups: edgeGroups.size, limits };
}

export class InspectionOverlay {
  constructor(view) {
    this.view = view; this.plan = inspectionPlan(view.meshes || []); this.owned = new Set();
    this.seams = this.lines(this.plan.seams.length, 0xffb84d);
    this.normals = this.lines(this.plan.normals.length, 0x70eac2);
    this.label = view.pane.ownerDocument.createElement('output'); this.label.dataset.inspectionOverlay = 'status';
    this.label.setAttribute('role', 'status');
    const toolbar = view.inspectTools?.toolbar;
    this.statusContainer = toolbar || view.pane.ownerDocument.createElement('div');
    if (!toolbar) { this.statusContainer.className = 'ar-inspect-tools'; view.pane.append(this.statusContainer); }
    this.peerStatus = !toolbar;
    // Both panes reserve a bottom status row; short phone comparisons reflow.
    this.label.style.cssText = 'padding:8px;background:#111e;color:white;pointer-events:none;box-sizing:border-box;overflow-wrap:anywhere;flex-basis:100%;max-width:100%';
    this.layout = view.pane.ownerDocument.createElement('style'); this.layout.textContent = inspectionLayout;
    view.pane.append(this.layout);
    this.render = view.renderer.render;
    this.renderOverlay = (...args) => { this.update(); return this.render.apply(view.renderer, args); };
    view.renderer.render = this.renderOverlay;
    this.statusContainer.append(this.label); this.update();
  }
  lines(count, color) {
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    const material = new THREE.LineBasicMaterial({ color, depthTest: false });
    this.owned.add(geometry); this.owned.add(material);
    const lines = new THREE.LineSegments(geometry, material); lines.frustumCulled = false; lines.renderOrder = 3;
    this.view.scene.add(lines); return lines;
  }
  update() {
    if (this.disposed) return;
    this.view.root.updateWorldMatrix(true, true);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
    const matrices = new Map();
    const matrixFor = mesh => {
      if (!matrices.has(mesh)) {
        const determinant = mesh.matrixWorld.determinant();
        matrices.set(mesh, Number.isFinite(determinant) && determinant !== 0 ? new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld) : null);
      }
      return matrices.get(mesh);
    };
    const write = (lines, index, start, end) => {
      const p = lines.geometry.attributes.position;
      p.setXYZ(index * 2, start.x, start.y, start.z); p.setXYZ(index * 2 + 1, end.x, end.y, end.z);
    };
    let edges = 0, vectors = 0;
    for (const edge of this.plan.seams) {
      a.copy(edge.a).applyMatrix4(edge.mesh.matrixWorld); b.copy(edge.b).applyMatrix4(edge.mesh.matrixWorld);
      if (finite(a) && finite(b)) write(this.seams, edges++, a, b);
      else this.plan.diagnostics.add('Non-finite world edge; seam skipped.');
    }
    const length = Math.max(Number.isFinite(this.view.radius) ? this.view.radius * .1 : .1, 1e-6);
    for (const sample of this.plan.normals) {
      const matrix = matrixFor(sample.mesh);
      if (!matrix) { this.plan.diagnostics.add('Singular world transform; normal vectors not supported.'); continue; }
      a.copy(sample.position).applyMatrix4(sample.mesh.matrixWorld);
      // Inverse transpose includes reflections. Do not transformDirection or
      // multiply by determinant sign: these are shading normals.
      normalMatrix.copy(matrix); b.copy(sample.normal).applyMatrix3(normalMatrix);
      if (!finite(a) || !finite(b) || b.lengthSq() === 0) { this.plan.diagnostics.add('Degenerate world normal; vector skipped.'); continue; }
      b.normalize().multiplyScalar(length).add(a); write(this.normals, vectors++, a, b);
    }
    for (const [lines, count] of [[this.seams, edges], [this.normals, vectors]]) {
      lines.geometry.setDrawRange(0, count * 2); lines.geometry.attributes.position.needsUpdate = true;
    }
    this.state = { space: 'world', seamEdges: edges, seamCount: this.plan.seamCount, normalVectors: vectors,
      normalCandidates: this.plan.normalCandidates, computedCandidates: this.plan.computedCandidates, limits: this.plan.limits, diagnostics: [...this.plan.diagnostics] };
    const source = this.plan.normalCandidates > this.plan.computedCandidates ? ' · Own normals' : '';
    const text = `UV-naden ${edges}/${this.plan.seamCount} · Wereldnormals ${vectors}/${this.plan.normalCandidates}${source}` +
      (this.state.diagnostics.length ? ' · ' + this.state.diagnostics.join(' ') : '');
    if (this.label.textContent !== text) this.label.textContent = text;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.seams.removeFromParent(); this.normals.removeFromParent(); this.label.remove(); this.layout.remove();
    if (this.peerStatus) this.statusContainer.remove();
    if (this.view.renderer.render === this.renderOverlay) this.view.renderer.render = this.render;
    for (const resource of this.owned) resource.dispose(); this.owned.clear();
    this.plan.seams.length = this.plan.normals.length = 0;
  }
}

const installed = new WeakSet(), modeControls = new WeakMap(), controlOwners = new WeakMap();
const modeLabels = new Map([['Material', 'material'], ['Wireframe', 'wire'], ['Clay', 'clay'], ['Normals', 'normals'], ['UV checker', 'uv'], ['Bones', 'bones']]);
function syncModeControls(view) {
  const controls = new Set([...(modeControls.get(view) || []), ...view.pane.ownerDocument.querySelectorAll('[data-inspection-mode]')]);
  for (const control of controls) if (controlOwners.get(control) === view) {
    control.setAttribute('aria-pressed', String(control.dataset.inspectionMode === (view.inspection || 'material')));
  }
}
export function installInspectionOverlays(ModelView, { el, GLTFLoader, changed, modeChanged = () => {} }) {
  if (GLTFLoader && !loaders.has(GLTFLoader)) {
    loaders.add(GLTFLoader);
    const parse = GLTFLoader.prototype.parseAsync;
    GLTFLoader.prototype.parseAsync = async function (...args) {
      const gltf = await parse.apply(this, args); registerInspectionSources(gltf); return gltf;
    };
  }
  if (installed.has(ModelView)) return; installed.add(ModelView);
  const p = ModelView.prototype, { setInspection, disposeInspection, extras, teardownLoad } = p;
  p.disposeInspection = function (...args) {
    this.inspectionOverlay?.dispose(); this.inspectionOverlay = null;
    return disposeInspection.apply(this, args);
  };
  p.setInspection = function (mode, sync = true) {
    setInspection.call(this, mode, false);
    if (mode === 'inspect' && this.root && !this.dead) this.inspectionOverlay = new InspectionOverlay(this);
    if (sync && this.peer?.setInspection) this.peer.setInspection(mode, false);
    syncModeControls(this);
    modeChanged(this, mode);
    changed();
  };
  p.extras = function () {
    const inspect = el('button', { class: 'mbtn', 'data-inspection-mode': 'inspect', 'aria-label': 'Inspect UV seams, world normals and A/B measurements',
      'aria-pressed': String(this.inspection === 'inspect'), onclick: e => {
        this.flags.sil = false; if (this.peer) this.peer.flags.sil = false;
        this.setInspection(this.inspection === 'inspect' ? 'material' : 'inspect');
      } }, 'Inspect');
    const nodes = extras.call(this), controls = [inspect];
    for (const node of nodes) if (node?.tagName === 'BUTTON' && modeLabels.has(node.textContent)) {
      node.dataset.inspectionMode = modeLabels.get(node.textContent); controls.push(node);
      // Legacy handlers update pressed state after setInspection returns.
      node.addEventListener('click', () => syncModeControls(this));
    }
    for (const control of controls) controlOwners.set(control, this);
    modeControls.set(this, controls); syncModeControls(this);
    return [inspect, ...nodes];
  };
  p.teardownLoad = function (...args) { modeControls.delete(this); return teardownLoad.apply(this, args); };
}
