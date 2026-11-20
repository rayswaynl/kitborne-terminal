// Painted-alpha estimates only. Draw on the preview canvas, never on note layers
// or source images. Only the selected page receives uncovered-margin highlights.
const SCHEMA = 'asset-review/bleed-coverage-1';
export function coverageLabel(page) {
  const r = page?.bleed_coverage;
  if (!r || r.schema !== SCHEMA) return 'Bleed coverage not checked';
  if (r.status !== 'ok') return 'Bleed coverage not checked (' + r.status + ')';
  const share = r.metrics?.coverage_fraction, dpi = r.raster?.dpi;
  if (!Number.isFinite(share) || share < 0 || share > 1 || !Number.isFinite(dpi)) return 'Bleed coverage not checked';
  return 'Bleed about ' + (share * 100).toFixed(1) + '% painted · ' + dpi + ' dpi · tolerance 1 pixel · no print certification';
}

export function drawBleedCoverage(g, pages, frames, selectedPage, box) {
  const frame = (frames || []).find(f => f.n === selectedPage);
  const r = (pages || []).find(p => p.n === selectedPage)?.bleed_coverage;
  if (!frame || r?.schema !== SCHEMA || r.status !== 'ok' || !Array.isArray(r.gaps) || r.gaps.length > 4096) return;
  const x = box.x + frame.x * box.w, y = box.y + frame.y * box.h;
  const w = frame.w * box.w, h = frame.h * box.h;
  g.save();
  try {
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = 'rgba(255, 48, 80, 0.42)';
    for (const gap of r.gaps) {
      const a = gap.rect;
      if (!Array.isArray(a) || a.length !== 4 || !a.every(Number.isFinite) || a[0] < 0 || a[1] < 0 || a[2] <= 0 || a[3] <= 0 || a[0]+a[2] > 1.000001 || a[1]+a[3] > 1.000001) continue;
      g.fillRect(x + a[0]*w, y + a[1]*h, a[2]*w, a[3]*h);
    }
  } finally { g.restore(); }
}
