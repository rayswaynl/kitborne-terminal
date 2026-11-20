// R3C-111 begin
import { queueText } from './review-queue.js';
// R3C-111 end
// Navigation owns no review API. The app supplies its existing reader, guard and finalizer.
export const quickKey = item => JSON.stringify([item.p, item.id, item.s.id, item.v ?? item.ver?.v]);
export function quickItems(items, project) {
  const seen = new Set();
  return items.filter(item => {
    const key = quickKey(item);
    if (item.p !== project || !item.id || !item.s?.id || !Number.isInteger(item.v ?? item.ver?.v) || (item.v ?? item.ver?.v) < 1 || seen.has(key)) return false;
    seen.add(key); return true;
  }); // Keep the supplied queue's order; never merge identities across projects.
}
export function swipeStep(dx, dy) {
  return Math.abs(dx) >= 64 && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx < 0 ? 1 : -1) : 0;
}
export function makeQuick(X) {
  let active = false, busy = false, dead = false, items = [], index = -1, panel, pointer;
  const listeners = new AbortController();
  const refreshItems = () => { items = quickItems(X.queue(), X.project()); index = items.findIndex(it => quickKey(it) === quickKey(X.current())); };
  const editable = target => target.closest('button,a,input,textarea,select,summary,[contenteditable]');
  const message = text => X.toast(text, 6000);
  const move = async delta => {
    if (!active || busy || dead) return;
    refreshItems(); const item = items[index + delta]; if (!item) return;
    busy = true; render();
    try { await X.open(item); } catch (e) { message('Could not open: ' + e.message); }
    finally { busy = false; sync(); }
  };
  const submit = async verdict => {
    if (!active || busy || dead || !X.owner()) return;
    busy = true; render();
    try { await X.decide(verdict); } catch (e) { message('Could not send: ' + e.message); }
    finally { busy = false; sync(); if (verdict === 'changes' && X.wantSummary?.()) panel?.querySelector('textarea')?.focus({ preventScroll: true }); }
  };
  function render() {
    if (!active || dead) return;
    const { el } = X, item = items[index];
    panel ||= el('section', { class: 'quick-review', 'aria-label': 'Quick review' });
    const notesOpen = panel.dataset.identity === quickKey(item || X.current()) && panel.querySelector('.quick-notes')?.open;
    panel.dataset.identity = quickKey(item || X.current());
    const focus = panel.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    panel.replaceChildren(
      el('div', { class: 'quick-swipe', tabindex: '0', role: 'group', 'aria-label': 'Swipe left or right, or use the arrow keys' },
        el('button', { disabled: busy || index <= 0, 'aria-label': 'Previous candidate', onclick: () => move(-1) }, '←'),
        // R3C-111 begin
        el('span', { class: 'quick-position', role: 'status' }, item ? `${index + 1}/${items.length}${X.total?.() > items.length ? ' · ' + queueText(items.length, X.total()) : ''} · ${item.s.id} · v${item.v ?? item.ver.v}` : 'No candidates'),
        // R3C-111 end
        el('button', { disabled: busy || index < 0 || index >= items.length - 1, 'aria-label': 'Next candidate', onclick: () => move(1) }, '→'),
        el('button', { disabled: busy, 'aria-label': 'Close quick review', onclick: stop }, '×')),
      el('p', { class: 'quick-hint' }, 'Swiping only browses. A button sends your decision.'),
      X.owner() && item ? el('details', { class: 'quick-notes', open: !!(notesOpen || X.wantSummary?.()) }, el('summary', {}, 'Summary'),
        el('textarea', { rows: '2', 'aria-label': 'Summary for this version', value: X.summary(), disabled: busy, oninput: e => X.editSummary(e.target.value) })) : null,
      X.owner() && item ? el('div', { class: 'quick-decisions' },
        ...[['approved', 'Approve'], ['changes', 'Change'], ['rejected', 'Reject']].map(([verdict, label]) =>
          el('button', { class: verdict, disabled: busy || !X.ready(), 'data-quick-verdict': verdict, onclick: () => submit(verdict) }, label)))
        : el('p', { class: 'quick-hint' }, 'You can post notes. The owner decides.'));
    if (!panel.isConnected) document.body.append(panel);
    document.body.classList.add('quick-active');
    if (focus) [...panel.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focus)?.focus({ preventScroll: true });
  }
  function stop() {
    active = false; pointer = null; panel?.remove(); panel = null;
    document.body.classList.remove('quick-active');
    X.restore?.();
  }
  function sync() {
    if (!active || dead) return;
    refreshItems();
    if (!X.reviewing() || !items.length || index < 0) return stop();
    render();
  }
  // Only this strip handles swipes. Canvas gestures remain annotations/transport.
  document.addEventListener('pointerdown', e => {
    if (!active || busy || !e.target.closest('.quick-swipe') || editable(e.target) || e.isPrimary === false || e.button !== 0) return;
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }, { signal: listeners.signal });
  document.addEventListener('pointermove', e => {
    if (pointer?.id === e.pointerId && Math.abs(e.clientY - pointer.y) > Math.abs(e.clientX - pointer.x) && Math.abs(e.clientY - pointer.y) > 16) pointer = null;
  }, { signal: listeners.signal });
  document.addEventListener('pointerup', e => {
    const start = pointer; pointer = null;
    if (!start || start.id !== e.pointerId) return;
    const delta = swipeStep(e.clientX - start.x, e.clientY - start.y);
    if (delta) void move(delta);
  }, { signal: listeners.signal });
  document.addEventListener('pointercancel', () => { pointer = null; }, { signal: listeners.signal });
  document.addEventListener('keydown', e => {
    if (!active) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (!e.target.closest('.quick-review')) return;
    if (editable(e.target)) return;
    if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopImmediatePropagation(); stop(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); void move(e.key === 'ArrowLeft' ? -1 : 1); }
  }, { signal: listeners.signal });
  return {
    get active() { return active; },
    async start() {
      if (dead || active) return;
      refreshItems(); if (!items.length) { message('Nothing to quick review.'); return; }
      active = true; busy = true;
      try { await X.open(items[0]); } catch (e) { message('Could not open: ' + e.message); stop(); }
      finally { busy = false; sync(); panel?.querySelector('.quick-swipe')?.focus({ preventScroll: true }); }
    },
    sync, stop, move,
    destroy() { dead = true; stop(); listeners.abort(); }
  };
}
