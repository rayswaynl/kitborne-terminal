// Image-only, ephemeral WCAG and source-pixel measurements.
export const PROBE_TOOLS = [
  ['contrast', 'Contrast', 'Tap text first, then the background'],
  ['textheight', 'Text size', 'Drag a vertical line over a capital letter']
];
export function luminance(rgb) {
  const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text) n.textContent = text; return n; };
const bounded = (n, max) => Math.max(0, Math.min(max, n));
const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

export class ImageProbe {
  constructor(view, save) {
    this.view = view; this.save = save; this.cursor = [0, 0]; this.points = [];
    this.cv = node('canvas', 'image-probe-canvas'); this.cv.hidden = true; this.cv.tabIndex = 0;
    this.cv.setAttribute('role', 'img'); this.cv.setAttribute('aria-label', 'Probe: arrows move one source pixel, Shift ten; Enter picks a point; Escape clears the measurement');
    view.pane.insertBefore(this.cv, view.layer.cv);
    this.panel = node('div', 'image-probe-readout'); this.panel.hidden = true;
    this.output = node('div', 'image-probe-values'); this.output.setAttribute('role', 'status'); this.output.setAttribute('aria-live', 'polite');
    this.button = node('button', 'ghost', 'As note'); this.button.disabled = true;
    this.panel.append(this.output, this.button);
    document.querySelector('#dock').before(this.panel);
    this.button.onclick = () => {
      if (!this.result || this.button.disabled) return;
      this.button.disabled = true;
      if (this.save(this.result.selector, this.result.text) === false) this.button.disabled = false;
    };
    this.cv.addEventListener('pointerdown', e => {
      if (e.button !== 0 || this.pointer != null) return;
      const p = this.fromEvent(e); if (!p) return;
      e.preventDefault(); this.cv.focus({ preventScroll: true }); this.pointer = e.pointerId;
      this.cv.setPointerCapture(e.pointerId); this.cursor = p;
      if (this.mode === 'textheight') { this.reset(); this.points = [p, p]; this.draw(); }
    });
    this.cv.addEventListener('pointermove', e => {
      if (e.pointerId !== this.pointer || this.mode !== 'textheight') return;
      const p = this.fromEvent(e, true); this.cursor = p;
      this.points[1] = [this.points[0][0], p[1]]; this.draw();
    });
    this.cv.addEventListener('pointerup', e => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      if (this.mode === 'contrast') { const p = this.fromEvent(e); if (p) this.choose(p); }
      else { const p = this.fromEvent(e, true); this.points[1] = [this.points[0][0], p[1]]; this.measure(); }
    });
    for (const event of ['pointercancel', 'lostpointercapture']) this.cv.addEventListener(event, () => {
      if (this.pointer == null) return; this.pointer = null; this.reset(); this.draw();
    });
    this.cv.addEventListener('keydown', e => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!moves[e.key] && !['Enter', ' ', 'Escape'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (moves[e.key]) this.cursor = this.cursor.map((v, i) => bounded(v + moves[e.key][i] * (e.shiftKey ? 10 : 1), [view.img.naturalWidth - 1, view.img.naturalHeight - 1][i]));
      else if (e.key === 'Escape') this.reset();
      else this.choose(this.cursor);
      this.draw();
    });
    this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(view.pane);
  }
  setTool(mode) {
    this.mode = PROBE_TOOLS.some(t => t[0] === mode) ? mode : null;
    this.pointer = null; this.reset(); this.cv.hidden = this.panel.hidden = !this.mode; this.draw();
    if (this.mode) this.cv.focus({ preventScroll: true });
  }
  reset() { this.points = []; this.result = null; this.button.disabled = true; this.prompt(); }
  prompt() {
    this.output.textContent = this.mode === 'contrast' ? (this.points.length ? 'Tap the background.' : 'Tap a text pixel, then the background.') : 'Drag from top to bottom over a capital letter. Keyboard: pick two points with Enter.';
  }
  fromEvent(e, clamp = false) {
    const r = this.cv.getBoundingClientRect(), b = this.view.box(), W = this.view.img.naturalWidth, H = this.view.img.naturalHeight;
    const x = (e.clientX - r.left - b.x) / b.w * W, y = (e.clientY - r.top - b.y) / b.h * H;
    if (!clamp && (x < 0 || y < 0 || x >= W || y >= H)) return null;
    if (this.mode === 'textheight') return [bounded(x, W), bounded(y, H)];
    return [bounded(Math.floor(x + 1e-7), W - 1), bounded(Math.floor(y + 1e-7), H - 1)];
  }
  choose(p) {
    if (this.points.length === 2) this.reset();
    this.points.push(this.mode === 'textheight' && this.points.length ? [this.points[0][0], p[1]] : [...p]);
    if (this.points.length === 2) this.measure(); else this.prompt();
    this.draw();
  }
  sample([x, y]) {
    // A 1x1 source crop avoids allocating another full-size image canvas.
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(this.view.img, x, y, 1, 1, 0, 0, 1, 1);
    const rgba = g.getImageData(0, 0, 1, 1).data;
    if (rgba[3] !== 255) throw new Error('Pick two opaque pixels; transparency has no fixed background colour.');
    return Array.from(rgba.slice(0, 3));
  }
  measure() {
    const [a, b] = this.points, H = this.view.img.naturalHeight, W = this.view.img.naturalWidth;
    let text;
    try {
      if (this.mode === 'contrast') {
        const ca = this.sample(a), cb = this.sample(b), ratio = contrastRatio(ca, cb);
        text = `Contrast ${ratio.toFixed(2)}:1 · ${hex(ca)} / ${hex(cb)}`;
        this.output.replaceChildren(node('div', '', text));
        for (const [label, threshold] of [['text', 4.5], ['large / button', 3]]) {
          this.output.append(node('span', ratio >= threshold ? 'probe-pass' : 'probe-fail', `${label}: ${ratio >= threshold ? '✓ passes' : '✗ fails'} (${threshold}:1)`));
        }
        text += ` · text: ${ratio >= 4.5 ? 'passes' : 'fails'} (4.5:1) · large / button: ${ratio >= 3 ? 'passes' : 'fails'} (3:1)`;
      } else {
        const height = Math.round(Math.abs(b[1] - a[1]));
        if (!height) { this.reset(); this.draw(); return; }
        text = `Text height ${height} px / ${(height / H * 100).toFixed(1)}% of image height (${H} px)`;
        this.output.textContent = text;
      }
      this.result = { text, selector: { type: 'point', x: a[0] / W, y: a[1] / H } };
      this.button.disabled = false;
    } catch (error) { this.result = null; this.button.disabled = true; this.output.textContent = error.message; }
    this.draw();
  }
  draw() {
    if (!this.mode) return;
    const r = this.cv.getBoundingClientRect(), dpr = devicePixelRatio, b = this.view.box();
    this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
    const g = this.cv.getContext('2d'); g.scale(dpr, dpr);
    const pos = p => [b.x + p[0] / this.view.img.naturalWidth * b.w, b.y + p[1] / this.view.img.naturalHeight * b.h];
    const line = (color, width) => {
      g.strokeStyle = color; g.lineWidth = width;
      if (this.mode === 'textheight' && this.points.length === 2) { g.beginPath(); g.moveTo(...pos(this.points[0])); g.lineTo(...pos(this.points[1])); g.stroke(); }
      for (const p of [...this.points, this.cursor]) { const [x, y] = pos(p); g.beginPath(); g.moveTo(x - 6, y); g.lineTo(x + 6, y); g.moveTo(x, y - 6); g.lineTo(x, y + 6); g.stroke(); }
    };
    line('#000', 4); line('#fff', 2);
  }
  destroy() { this.ro.disconnect(); this.cv.remove(); this.panel.remove(); }
}

export function installImageProbe(ImageView, { save }) {
  const P = ImageView.prototype, { tools, load, setTool, resize, destroy } = P;
  P.tools = function () { return [...tools.call(this), ...(this.file.media === 'image' && this.o.primary ? PROBE_TOOLS : [])]; };
  P.load = async function (...args) {
    if (this.probeDisposed) return;
    await load.apply(this, args);
    if (!this.probeDisposed && this.file.media === 'image' && this.o.primary) this.probe = new ImageProbe(this, save);
  };
  P.setTool = function (id) { setTool.call(this, id); this.probe?.setTool(id); };
  P.resize = function (...args) { const result = resize.apply(this, args); this.probe?.draw(); return result; };
  P.destroy = function (...args) { this.probeDisposed = true; this.probe?.destroy(); return destroy.apply(this, args); };
}
