// Kitborne Terminal: small behaviours on top of the viewer (long-press tips and layout measurements). Reads the DOM only; no viewer state is touched.
const $ = (s, r = document) => r.querySelector(s);

// 2. Phone tool row: icons only, the name shows on long press.
let tip = null, pressT = 0, swallow = 0;
const hideTip = () => { if (tip) { tip.remove(); tip = null; } };
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('#dock .tool, #dock a');
  if (!b || e.pointerType === 'mouse' || !matchMedia('(max-width:820px)').matches) return;
  clearTimeout(pressT);
  pressT = setTimeout(() => {
    const text = b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent.trim(); if (!text) return;
    const r = b.getBoundingClientRect(); hideTip();
    tip = Object.assign(document.createElement('div'), { className: 'cd-tip', textContent: text.replace(/ \(.\)$/, ''), role: 'status' });
    tip.style.left = Math.max(60, Math.min(innerWidth - 60, r.left + r.width / 2)) + 'px'; tip.style.top = (r.top - 10) + 'px';
    document.body.append(tip); swallow = Date.now() + 700;
  }, 420);
}, true);
for (const t of ['pointerup', 'pointercancel', 'pointermove']) document.addEventListener(t, () => { clearTimeout(pressT); if (tip) setTimeout(hideTip, 900); }, true);
document.addEventListener('click', e => { if (Date.now() < swallow && e.target.closest && e.target.closest('#dock')) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('#dock')) e.preventDefault(); });

const steps = $('#steps');

// 6. Breadcrumb selects shrink to the chosen text, so project / asset / version read as one group.
const bar = $('#bar'), fitProbe = Object.assign(document.createElement('span'), { ariaHidden: 'true' }); // DOM text measure: no canvas context
function fit() {
  if (matchMedia('(max-width:820px)').matches) return;
  for (const s of document.querySelectorAll('.crumb select')) {
    const o = s.options[s.selectedIndex]; if (!o) continue;
    const c = getComputedStyle(s); fitProbe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + c.fontWeight + ' ' + c.fontSize + ' ' + c.fontFamily;
    fitProbe.textContent = o.text; document.body.append(fitProbe); const w = fitProbe.getBoundingClientRect().width; fitProbe.remove();
    s.style.width = Math.ceil(w + parseFloat(c.paddingLeft) + parseFloat(c.paddingRight) + 4) + 'px';
  }
}
if (bar) { new MutationObserver(() => fit()).observe(bar, { childList: true, subtree: true }); bar.addEventListener('change', fit, true); document.fonts && document.fonts.ready.then(fit); addEventListener('resize', fit); fit(); }


// 7. Phone: the canvas ends where the fixed decision bar starts, whatever its height.
const dec = $('#decide');
if (dec && window.ResizeObserver) new ResizeObserver(() => { const h = Math.ceil(dec.getBoundingClientRect().height); if (h) document.documentElement.style.setProperty('--cd-decide', h + 'px'); }).observe(dec); // hidden while composing: keep the last height


// 8. Long stage rails scroll sideways: a fade marks the side with more stages, and the wheel scrolls the rail.
function railFade() { const r = $('#steps>.rail'); if (!r) return; const max = r.scrollWidth - r.clientWidth; r.classList.toggle('fade-l', r.scrollLeft > 2); r.classList.toggle('fade-r', r.scrollLeft < max - 2); }
if (steps) {
  steps.addEventListener('scroll', railFade, true); addEventListener('resize', railFade);
  new MutationObserver(() => requestAnimationFrame(railFade)).observe(steps, { childList: true });
  steps.addEventListener('wheel', e => { const r = e.target.closest('.rail'); if (!r || r.scrollWidth <= r.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; r.scrollLeft += e.deltaY; e.preventDefault(); }, { passive: false });
}
// R1 (2026-10-29): the phone canvas starts where the sticky bar and the stage rail end; a long title can take two lines.
{
  const tops = ['#bar', '#steps'].map(s => $(s)).filter(Boolean);
  if (tops.length && window.ResizeObserver) { const ro = new ResizeObserver(() => { const h = Math.ceil(tops.reduce((n, e) => n + e.getBoundingClientRect().height, 0)); if (h) document.documentElement.style.setProperty('--cd-top', h + 'px'); }); tops.forEach(e => ro.observe(e)); }
}
