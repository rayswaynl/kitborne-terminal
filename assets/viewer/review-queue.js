// R3C-111: bounded owner batches, with legacy catalog fallback.
export const queueLimit = state => Number.isInteger(state?.limit) && state.limit > 0 ? state.limit : 6;
export const queueBatch = (items, state) => {
  const allowed = state?.items && new Set(state.items.map(it => JSON.stringify([it.asset, it.stage, it.v])));
  return (allowed ? items.filter(it => allowed.has(JSON.stringify([it.id, it.s.id, it.v ?? it.ver?.v]))) : items).slice(0, queueLimit(state));
};
export const queueText = (shown, total) => total > shown ? `${shown} of ${total} in the queue` : `${total} in the queue`;
export const projectQueueText = (state, total) => total > queueLimit(state) ? queueText(queueLimit(state), total) : null;
export function queueSettings({ el, api, toast, state, saved }) {
  const input = el('input', { type: 'number', min: '1', step: '1', value: queueLimit(state), 'aria-label': 'Queue limit', style: { width: '5em' } });
  const button = el('button', { type: 'submit', class: 'ghost' }, 'Save');
  return el('details', { class: 'queue-settings' }, el('summary', {}, 'Settings'),
    el('form', { onsubmit: async event => {
      event.preventDefault(); const limit = Number(input.value);
      if (!Number.isInteger(limit) || limit < 1) return toast('Choose a positive whole number.');
      button.disabled = true;
      try {
        const next = await api('/api/review-queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit }) });
        await saved(next); toast('Queue limit saved.');
      } catch (error) { toast('Could not save: ' + error.message); }
      finally { button.disabled = false; }
    } }, el('label', {}, 'Versions per review batch and in the queue ', input), button));
}
