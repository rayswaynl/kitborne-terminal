// Advisory candidates on AudioView's existing time scale; no review writes.
export function mountSpectralEvents(pane, review, result, duration) {
  const doc = pane.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'spectral-events';
  root.style.cssText = 'position:absolute;left:0;right:0;top:0;z-index:2;font-size:11px;pointer-events:none';
  const heading = doc.createElement('div');
  heading.style.cssText = 'background:#101317;color:#cbd5e1;padding:2px 6px';
  const valid = result?.schema_version === 1 && ['ok', 'unsupported', 'not_checked', 'budget_exceeded'].includes(result.status) && Array.isArray(result.events);
  const status = valid ? (result.events.length > 256 ? 'budget_exceeded' : result.status) : 'not_checked';
  heading.textContent = `Signal candidates · advisory · ${status}`;
  if (status !== 'ok') heading.textContent += ' · analysis incomplete';
  root.append(heading);
  const strip = doc.createElement('div');
  strip.style.cssText = 'position:relative;height:60px';
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'Advisory signal candidates on the audio timeline');
  root.append(strip);
  const listeners = [];
  const colors = { click: '#ffd166', hum: '#b8a1ff', whistle: '#80d6ce' };
  const events = valid && Array.isArray(result.events) ? result.events.slice(0, 256) : [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || !Object.hasOwn(colors, event.kind) || !Number.isFinite(duration) || duration <= 0
        || !Number.isFinite(event.start_s) || !Number.isFinite(event.end_s)
        || event.start_s < 0 || event.start_s >= duration || event.end_s < event.start_s || event.end_s > duration) continue;
    const button = doc.createElement('button');
    button.type = 'button';
    const frequency = Number.isFinite(event.frequency_hz) ? ` · ${event.frequency_hz.toFixed(1)} Hz` : '';
    const label = typeof event.label === 'string' ? event.label.slice(0, 200) : event.kind;
    button.textContent = `${label} candidate${frequency}`;
    button.title = `${button.textContent} · ${event.start_s.toFixed(3)}–${event.end_s.toFixed(3)} s`;
    button.setAttribute('aria-label', button.title);
    button.style.cssText = `position:absolute;pointer-events:auto;top:${['click', 'hum', 'whistle'].indexOf(event.kind) * 20}px;height:20px;min-width:6px;max-width:100%;padding:0 3px;overflow:hidden;white-space:nowrap;text-align:left;color:#101317;border:0;border-radius:2px;background:${colors[event.kind]};left:${event.start_s / duration * 100}%;width:${Math.max(0.3, (event.end_s - event.start_s) / duration * 100)}%`;
    const seek = e => { e.stopPropagation(); review.seek(event.start_s); };
    button.addEventListener('click', seek);
    listeners.push([button, seek]);
    strip.append(button);
  }
  // Keep incomplete evidence visible even when there are no candidates.
  if (valid && Array.isArray(result.diagnostics)) heading.title = result.diagnostics.slice(0, 8).map(s => String(s).slice(0, 200)).join('; ');
  pane.append(root);
  const clear = () => {
    for (const [button, seek] of listeners) button.removeEventListener('click', seek);
    listeners.length = 0;
    strip.replaceChildren();
  };
  return { root, clear, destroy() { clear(); root.remove(); } };
}
