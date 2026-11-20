// Asset Review live bridge. The review server's live proxy adds this script to every HTML page it serves, so the
// viewer can follow the scroll position, scroll the page and name the element under a note. The site itself stays unchanged.
(() => {
  if (window.parent === window || window.__arLive) return;
  window.__arLive = true;
  const post = m => parent.postMessage({ ar: 'live', ...m }, '*');
  const de = document.documentElement;
  const state = () => post({ type: 'state', path: location.pathname + location.search + location.hash, title: document.title,
    x: scrollX, y: scrollY, vw: innerWidth, vh: innerHeight, dw: de.scrollWidth, dh: de.scrollHeight });
  let raf = 0; const queue = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; state(); }); };
  addEventListener('scroll', queue, { passive: true }); addEventListener('resize', queue); addEventListener('load', state);
  addEventListener('wheel', e => { if ((e.ctrlKey || e.metaKey) && e.deltaY) { e.preventDefault(); post({ type: 'zoom', delta: e.deltaY < 0 ? 1 : -1 }); } }, { passive: false });
  addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select,[contenteditable]') || e.ctrlKey || e.metaKey || e.altKey || !['+', '=', '-', '0'].includes(e.key)) return;
    e.preventDefault(); post({ type: 'zoom', fit: e.key === '0', delta: e.key === '-' ? -1 : 1 });
  });
  addEventListener('DOMContentLoaded', () => { new ResizeObserver(queue).observe(document.body || de); state(); });
  const KIND = { A: 'Link', BUTTON: 'Knop', INPUT: 'Invoerveld', SELECT: 'Keuzelijst', TEXTAREA: 'Tekstvak', LABEL: 'Label', IMG: 'Afbeelding', VIDEO: 'Video',
    IFRAME: 'Ingebed', CANVAS: 'Canvas', H1: 'Kop', H2: 'Kop', H3: 'Kop', H4: 'Kop', H5: 'Kop', H6: 'Kop', P: 'Tekst', LI: 'Lijstitem', FIGURE: 'Figuur',
    NAV: 'Navigatie', HEADER: 'Kopbalk', FOOTER: 'Voettekst', SECTION: 'Sectie', FORM: 'Formulier', TD: 'Tabelcel', TH: 'Tabelkop', BLOCKQUOTE: 'Citaat' };
  const SEL = 'a,button,input,select,textarea,label,img,video,iframe,canvas,h1,h2,h3,h4,h5,h6,p,li,figure,td,th,blockquote,[role],nav,header,footer,form,section';
  const css = el => { const out = []; for (let e = el; e && e.nodeType === 1 && e !== de && out.length < 5; e = e.parentElement) {
      if (e.id) { out.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.tagName.toLowerCase(); const sib = e.parentElement ? [...e.parentElement.children].filter(x => x.tagName === e.tagName) : [];
      if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')'; out.unshift(s); }
    return out.join(' > '); };
  const describe = (x, y) => {
    const hit = document.elementFromPoint(x, y); if (!hit) return {};
    const el = hit.closest(SEL) || hit; const r = el.getBoundingClientRect();
    const text = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    return { kind: KIND[el.tagName] || el.tagName.toLowerCase(), text: text.length > 70 ? text.slice(0, 67) + '...' : text, css: css(el),
      rect: [r.left + scrollX, r.top + scrollY, r.width, r.height] };
  };
  addEventListener('message', e => {
    const m = e.data; if (e.source !== parent || !m || m.ar !== 'viewer') return;
    if (m.type === 'scrollBy') scrollBy({ left: m.dx || 0, top: m.dy || 0, behavior: 'instant' });
    else if (m.type === 'scrollTo') scrollTo({ top: m.y || 0, behavior: m.smooth ? 'smooth' : 'instant' });
    else if (m.type === 'pick') post({ type: 'picked', id: m.id, ...describe(m.x, m.y) });
    else if (m.type === 'state') state();
  });
  state();
})();
