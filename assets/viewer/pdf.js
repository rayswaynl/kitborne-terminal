// PDF review: the server renders every page to a PNG (pages.json); a page is shown through the normal image view,
// so pointing, boxes, drawing, zoom, notes and comments work per page. Notes carry target.page and show only on their page.
export function makePdf(X) {
  const { ImageView, el, icon, dataUrl, S, typing, refreshMarks, renderDock, toast, select } = X;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const idOf = url => { const m = new URL(url, location.href).pathname.match(/^\/data\/([^/]+)\/([^/]+)\/v(\d+)\//); return m && { asset: decodeURIComponent(m[1]), stage: decodeURIComponent(m[2]), v: +m[3] }; };
  const fileOf = url => decodeURIComponent(new URL(url, location.href).pathname.split('/').pop());
  const loadImg = async src => { const i = new Image(); i.src = src; await i.decode(); return i; };
  const STATE = { mode: 'single', gray: false }; // remembered while the reviewer pages through versions
  async function pagesOf(url) {
    const id = idOf(url); if (!id) return null;
    try { const r = await fetch(dataUrl(id.asset, id.stage, id.v, 'pages/' + fileOf(url) + '/pages.json')); if (r.ok && r.status !== 204) { const doc = await r.json(); return doc && (doc.pages || []).length ? { id, doc } : null; } } catch (e) { /* not rendered yet */ }
    return null;
  }
  return class PdfView extends ImageView {
    constructor(pane, url, file, o) { super(pane, url, file, o); this.pdfUrl = url; this.n = 1; this.mode = STATE.mode; }
    get N() { return this.doc ? this.doc.pages.length : 0; }
    tools() { return this.broken ? [] : super.tools(); }
    pngOf(n) { const p = this.doc.pages[n - 1]; return dataUrl(this.id.asset, this.id.stage, this.id.v, p.png); }
    // facing pages: the cover stands alone, then 2-3, 4-5, ...; the last page stands alone when the count is even
    spreadOf(n) { const a = n <= 1 ? 1 : n - (n % 2); return [a, a > 1 && a + 1 <= this.N ? a + 1 : null]; }
    async load() {
      const got = await pagesOf(this.url); if (!got) return this.noPages();
      this.id = got.id; this.doc = got.doc;
      if (this.doc.pages.some(p => p.bleed_coverage)) this.bleedCoverage = await import('./bleed_coverage.js').catch(() => null);
      this.doc.pages.forEach((p, i) => { p.n = p.n || i + 1; });
      const key = this.id.asset + '/' + this.id.stage, start = clamp(STATE.at && STATE.at.key === key ? STATE.at.n : 1, 1, this.N); this.key = key;
      this.url = this.pngOf(start); await super.load(); this.page = false; this.pdfPage = start;
      if (STATE.gray) this.bg.style.filter = 'grayscale(1)';
      this.buildUi();
      this.layer.onDone = (s, extra) => {
        const [x, y] = extra && extra.start || (s.points ? s.points[0] : [s.x, s.y]);
        const p = this.frames.find(p => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
        if (!p) return this.clearSelection();
        select(this.pageSelector(s, p, true), { ...extra, view: { pdfPage: p.n } });
      };
      await this.show(start, { fresh: true });
      if (this.o.primary) { this.kd = e => { if (typing(e) || e.altKey || e.ctrlKey || e.metaKey) return; if (e.key === 'PageDown') { e.preventDefault(); this.step(1); } else if (e.key === 'PageUp') { e.preventDefault(); this.step(-1); } }; document.addEventListener('keydown', this.kd); }
    }
    noPages() {
      this.broken = true; this.pane.append(el('div', { class: 'empty pdfempty' }, el('h2', {}, this.file.name),
        el('p', { class: 'muted' }, 'The pages of this PDF are not ready yet. You can still download the PDF.'), el('p', {}, el('a', { href: this.pdfUrl, download: this.file.name }, 'Download PDF'))));
      for (const k of ['resize', 'zoomBy', 'zoomAt', 'fit', 'wholePage', 'actual', 'focus', 'ghost', 'setTool', 'clearSelection', 'marks', 'setParts']) this[k] = () => {};
      this.thumb = async () => null; this.capture = async () => ({}); this.info = () => this.file.name; this.extras = () => [this.dlButton()]; this.destroy = () => {};
    }
    dlButton() { return el('a', { class: 'mbtn', href: this.pdfUrl, download: this.file.name }, 'Download PDF'); }
    // ---- paging ----
    step(d) { const [a, b] = this.mode === 'spread' ? this.spreadOf(this.n) : [this.n, null]; return this.show(d > 0 ? (b || a) + 1 : (this.mode === 'spread' ? Math.max(1, a - 1) : a - 1)); }
    async show(n, o = {}) {
      n = clamp(Math.round(n) || 1, 1, this.N); if (this.mode === 'spread') n = this.spreadOf(n)[0];
      if (n === this.n && !o.fresh && !o.redraw) return; const seq = this.seq = (this.seq || 0) + 1;
      let img;
      if (this.mode === 'single') { img = await loadImg(this.pngOf(n)); this.frames = [{ n, x: 0, y: 0, w: 1, h: 1 }]; }
      else {
        const [a, b] = this.spreadOf(n), L = await loadImg(this.pngOf(a)), R = b ? await loadImg(this.pngOf(b)) : null;
        img = document.createElement('canvas'); img.width = L.width + (R ? R.width : 0); img.height = Math.max(L.height, R ? R.height : 0); const g = img.getContext('2d');
        g.fillStyle = '#0d0d0e'; g.fillRect(0, 0, img.width, img.height); g.drawImage(L, 0, (img.height - L.height) / 2); if (R) g.drawImage(R, L.width, (img.height - R.height) / 2);
        this.frames = [{ n: a, x: 0, y: (img.height - L.height) / 2 / img.height, w: L.width / img.width, h: L.height / img.height }];
        if (R) this.frames.push({ n: b, x: L.width / img.width, y: (img.height - R.height) / 2 / img.height, w: R.width / img.width, h: R.height / img.height });
      }
      if (seq !== this.seq || !this.layer) return;
      this.n = n; this.img = img; this.pdfPage = n; this.layer.sel = null; if (this.o.primary) STATE.at = { key: this.key, n };
      if (this.o.overlay) await this.loadOverlay(this.o.overlay);
      this.whole = false; this.z = 1; this.ox = this.oy = 0; this.changed(); this.applyMarks(); this.syncUi();
      if (this.o.primary && this.peer instanceof PdfView) this.peer.follow(n, this.mode);
      if (this.o.primary && !o.fresh && S.view === this) refreshMarks();
    }
    async follow(n, mode) { this.mode = mode; await this.show(Math.min(n, this.N), { redraw: true }); }
    async setMode(mode) {
      if (mode === this.mode) return; this.mode = STATE.mode = mode;
      this.layer.sel = null;
      await this.show(this.n, { redraw: true }); if (this.o.primary) renderDock();
    }
    async loadOverlay(ov) {
      if (!this.ovDoc) this.ovDoc = await pagesOf(ov.url);
      this.ov = null; this.diffCv = null; if (this.wh) { this.wh.remove(); this.wh = null; }
      const p = this.ovDoc && this.mode === 'single' && this.ovDoc.doc.pages[this.n - 1];
      if (p) await super.loadOverlay({ ...ov, url: dataUrl(this.ovDoc.id.asset, this.ovDoc.id.stage, this.ovDoc.id.v, p.png) });
    }
    // ---- notes: only on their own page ----
    marks(notes, active) { this.allNotes = notes; this.activeId = active; this.applyMarks(); }
    pageSelector(s, p, local = false) {
      const point = ([x, y]) => local ? [clamp((x - p.x) / p.w, 0, 1), clamp((y - p.y) / p.h, 0, 1)] : [p.x + x * p.w, p.y + y * p.h];
      const out = { ...s };
      if (s.points) out.points = s.points.map(point);
      if (s.x != null) [out.x, out.y] = point([s.x, s.y]);
      if (s.w != null) { const end = point([s.x + s.w, s.y + s.h]); out.w = end[0] - out.x; out.h = end[1] - out.y; }
      return out;
    }
    displayed(note) {
      const p = (this.frames || []).find(p => p.n === ((note.target || {}).page || 1));
      return p ? { ...note, target: { ...note.target, selector: this.pageSelector(note.target.selector, p) } } : null;
    }
    applyMarks() {
      if (!this.layer) return; const all = this.allNotes || [];
      this.layer.notes = all.map(x => this.displayed(x)).filter(Boolean); this.layer.active = this.activeId; this.layer.draw();
      this.counts = {}; for (const x of all) if ((x.status || 'open') === 'open' && x.verdict !== 'approve') { const p = (x.target || {}).page || 1; this.counts[p] = (this.counts[p] || 0) + 1; }
      this.syncUi();
    }
    async focus(note, ghost) {
      const pg = (note.target || {}).page || note.view?.pdfPage || 1;
      if (!(this.frames || []).some(p => p.n === pg)) await this.show(pg);
      return super.focus(this.displayed({ ...note, target: { ...note.target, page: pg } }), ghost);
    }
    ghost(note) { const shown = this.displayed(note); if (shown) super.ghost(shown); }
    async capture(n, all) { // crops come from the page the note is on
      const pg = (n.target || {}).page || 1, keep = this.img; try { this.img = await loadImg(this.pngOf(clamp(pg, 1, this.N))); return await super.capture(n, all.filter(m => ((m.target || {}).page || 1) === pg)); } finally { this.img = keep; }
    }
    viewState() { return { pdfPage: this.n }; }
    // ---- sizes ----
    physicalDimensions() {
      if (!this.doc || this.mode !== 'single') return null;
      const p = this.doc.pages[this.n - 1];
      const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
      if (positive(p?.w_mm) && positive(p?.h_mm)) return { w: p.w_mm, h: p.h_mm };
      // PDF points are 1/72 inch, multiplied by an explicitly supplied UserUnit.
      // Rendered PNG pixels and render DPI never establish a page's print size.
      const unit = p?.user_unit ?? 1;
      return positive(p?.w_pt) && positive(p?.h_pt) && positive(unit)
        ? { w: p.w_pt * unit / 72 * 25.4, h: p.h_pt * unit / 72 * 25.4 } : null;
    }
    resize() {
      if (this.physicalDisposed) return;
      super.resize();
      if (this.bg && this.doc && this.frames && !this.hideBleed && this.bleedCoverage) this.bleedCoverage.drawBleedCoverage(this.bg.getContext('2d'), this.doc.pages, this.frames, this.n, this.box());
      if (!this.physicalRequested && this.zl && this.z === 1 && !this.ox && !this.oy)
        this.zl.textContent = this.mode === 'spread' ? 'Spread, fit' : 'Fit';
    }
    setGray(on) { STATE.gray = on; if (this.bg) this.bg.style.filter = on ? 'grayscale(1)' : ''; if (this.peer instanceof PdfView) this.peer.setGray(on); }
    extras() {
      return [el('button', { class: 'mbtn', title: 'Fit (0)', onclick: () => this.fit() }, 'Fit to view'),
        el('button', { class: 'mbtn', title: 'Actual pixels', onclick: () => this.actual() }, 'Actual pixels (100%)'),
        ...this.physicalControls(),
        el('button', { class: 'tgl' + (STATE.gray ? ' on' : ''), title: 'How a black and white print looks', onclick: e => { this.setGray(!STATE.gray); e.currentTarget.classList.toggle('on', STATE.gray); } }, 'Greyscale'),
        ...(this.bleedCoverage ? [el('button', { class: 'tgl' + (!this.hideBleed ? ' on' : ''), title: this.bleedCoverage.coverageLabel(this.doc.pages[this.n - 1]), onclick: e => { this.hideBleed = !this.hideBleed; e.currentTarget.classList.toggle('on', !this.hideBleed); this.resize(); } }, 'Bleed gaps')] : []),
        this.dlButton()];
    }
    info() { const p = this.doc.pages[this.n - 1]; return this.file.name + ' · page ' + this.n + ' of ' + this.N + (p && p.w_mm ? ' · ' + Math.round(p.w_mm) + ' × ' + Math.round(p.h_mm) + ' mm' : '') + ' · ' + (this.bleedCoverage?.coverageLabel(p) || 'Bleed coverage not checked'); }
    // ---- page strip and page bar ----
    buildUi() {
      this.pane.classList.add('pdfpane'); if (!this.o.primary) return;
      const view = this.viewEl = this.pane.parentNode; view.classList.add('haspdf'); this.pane.classList.add('pdfpane');
      this.thumbs = this.doc.pages.map((p, i) => { const n = i + 1; const b = el('button', { class: 'pthumb', 'aria-label': 'Page ' + n + (p.label ? ' ' + p.label : ''), title: 'Page ' + n + (p.label ? ' · ' + p.label : ''), onclick: () => this.show(n) },
        el('img', { src: this.pngOf(n), loading: 'lazy', decoding: 'async', alt: '' }), el('span', { class: 'pno' }, String(n)), el('span', { class: 'pbadge', hidden: true })); return b; });
      this.strip = el('div', { class: 'pdfstrip', role: 'group', 'aria-label': "Pagina's" }, this.thumbs); view.append(this.strip);
      this.prevB = el('button', { class: 'pnav', 'aria-label': 'Previous page', title: 'Previous page (PageUp)', onclick: () => this.step(-1) }, icon('back', 18));
      this.nextB = el('button', { class: 'pnav', 'aria-label': 'Next page', title: 'Next page (PageDown)', onclick: () => this.step(1) }, icon('next', 18));
      this.label = el('span', { class: 'pgno', 'aria-live': 'polite' });
      this.segB = el('div', { class: 'seg pmode', role: 'group', 'aria-label': 'View' }, [['single', 'Single'], ['spread', 'Spread']].map(([k, l]) => el('button', { class: 'tool sm', 'data-mode': k, onclick: () => this.setMode(k) }, l)));
      this.bar = el('div', { class: 'pdfbar' }, this.prevB, this.label, this.nextB, this.N > 1 ? this.segB : null); view.append(this.bar);
    }
    syncUi() {
      if (!this.bar) return; const [a, b] = this.mode === 'spread' ? this.spreadOf(this.n) : [this.n, null];
      this.label.textContent = 'page ' + a + (b ? '\u2013' + b : '') + ' of ' + this.N; this.prevB.disabled = a <= 1; this.nextB.disabled = (b || a) >= this.N;
      this.thumbs.forEach((t, i) => { const n = i + 1, on = n === a || n === b, c = (this.counts || {})[n] || 0; t.setAttribute('aria-current', String(on)); const bd = t.querySelector('.pbadge'); bd.hidden = !c; bd.textContent = c ? String(c) : ''; bd.title = c + (c === 1 ? ' note' : ' notes'); });
      for (const x of this.segB.children) x.setAttribute('aria-pressed', String(x.dataset.mode === this.mode));
      const cur = this.thumbs[a - 1]; if (cur) this.strip.scrollTo({ top: cur.offsetTop - 8, left: cur.offsetLeft - 8 });
    }
    destroy() { document.removeEventListener('keydown', this.kd); if (this.strip) { this.strip.remove(); this.bar.remove(); this.viewEl.classList.remove('haspdf'); } super.destroy(); }
  };
}
