// Raycast points are already in world space. Never apply the model transform twice.
export function measurementUnit(declared) {
  return declared === 'm' ? 'm' : declared === 'stud' ? 'studs' : 'model units';
}

export class Measurement {
  constructor(view, { units, ownsInput, changed = () => {} }) {
    this.view = view; this.units = units; this.ownsInput = ownsInput; this.changed = changed;
    this.points = []; this.active = false;
    this.onKey = e => {
      if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || !this.ownsInput()) return;
      if (e.target?.closest?.('input,textarea,select,[contenteditable],dialog[open]')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.view.setTool('part'); this.changed();
    };
  }
  start() {
    this.stop(); this.active = true;
    const doc = this.view.pane.ownerDocument;
    this.label = doc.createElement('output'); this.label.setAttribute('aria-live', 'polite');
    this.label.dataset.measurement = 'status';
    this.label.style.cssText = 'position:absolute;left:12px;top:12px;padding:8px;background:#111e;color:white;pointer-events:none;z-index:12';
    this.svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.dataset.measurement = 'overlay';
    this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:11';
    this.svg.setAttribute('aria-hidden', 'true');
    this.view.pane.append(this.svg, this.label);
    doc.addEventListener('keydown', this.onKey, true);
    this.status = 'first_point'; this.updateLabel();
  }
  pick(event) {
    if (!this.active || !this.ownsInput()) return;
    // Keep the existing raycaster, camera and mesh filtering as the source of hits.
    this.view.scene.updateMatrixWorld(true); this.view.camera.updateMatrixWorld(true);
    const hit = this.view.hit(event), point = hit?.point;
    if (!point || !point.toArray().every(Number.isFinite)) {
      this.status = 'ray_miss'; this.updateLabel(); return;
    }
    if (this.points.length === 2) this.points = [];
    this.points.push(point.clone());
    this.status = this.points.length === 2 ? 'measured' : 'second_point';
    this.updateLabel(); this.draw();
  }
  snapshot() {
    return { status: this.status, points: this.points.map(p => p.toArray()),
      distance: this.points.length === 2 ? this.points[0].distanceTo(this.points[1]) : null,
      unit: measurementUnit(this.units()), space: 'world' };
  }
  updateLabel() {
    const state = this.snapshot();
    const value = state.distance === null ? '' : `${Number(state.distance.toPrecision(7))} ${state.unit} · `;
    this.label.textContent = value + (this.status === 'ray_miss' ? 'Ray miss — click the model' :
      this.status === 'measured' ? 'World-space distance · Escape cancels' :
      `Pick ${this.points.length ? 'second' : 'first'} model point · ${state.unit} · Escape cancels`);
  }
  draw() {
    if (!this.active) return;
    const { width, height } = this.view.renderer.domElement.getBoundingClientRect();
    const projected = this.points.map(p => p.clone().project(this.view.camera));
    this.svg.replaceChildren();
    if (projected.some(p => p.z < -1 || p.z > 1)) return;
    const coords = projected.map(p => [(p.x + 1) * width / 2, (1 - p.y) * height / 2]);
    const add = (tag, attrs) => {
      const node = this.svg.ownerDocument.createElementNS(this.svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      this.svg.append(node);
    };
    if (coords.length === 2) add('line', { x1: coords[0][0], y1: coords[0][1], x2: coords[1][0], y2: coords[1][1], stroke: '#ffe06b', 'stroke-width': 3 });
    for (const [cx, cy] of coords) add('circle', { cx, cy, r: 5, fill: '#ffe06b', stroke: '#111', 'stroke-width': 2 });
  }
  stop() {
    this.view.pane.ownerDocument.removeEventListener('keydown', this.onKey, true);
    this.svg?.remove(); this.label?.remove(); this.svg = this.label = null;
    this.active = false; this.points = []; this.status = 'cancelled';
  }
}

// Install once on the view prototype; no additional pointer handlers or GPU resources.
const installed = new WeakSet();
export function installMeasurement(ModelView, options) {
  if (installed.has(ModelView)) return;
  installed.add(ModelView);
  const proto = ModelView.prototype;
  const { tools, setTool, pick, frame, teardownLoad } = proto;
  proto.tools = function () {
    return tools.call(this).concat(this.o.primary ? [['measure', 'Measure', 'Measure two model points in world space; Escape cancels']] : []);
  };
  proto.setTool = function (tool) {
    if (tool === 'measure' && (!this.o.primary || this.dead || !this.root || !options.ownsInput(this))) return;
    this.measurement?.stop(); setTool.call(this, tool);
    if (tool !== 'measure') return;
    this.measurement ||= new Measurement(this, { units: () => options.units(this), ownsInput: () => options.ownsInput(this), changed: options.changed });
    this.measurement.start();
  };
  proto.pick = function (event) {
    if (this.tool === 'measure') { this.measurement?.pick(event); return; }
    return pick.call(this, event);
  };
  proto.frame = function (...args) { const value = frame.apply(this, args); this.measurement?.draw(); return value; };
  proto.teardownLoad = function (...args) {
    this.measurement?.stop(); this.measurement = null;
    if (this.tool === 'measure') this.tool = 'part';
    return teardownLoad.apply(this, args);
  };
}
