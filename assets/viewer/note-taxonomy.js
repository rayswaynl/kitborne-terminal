// Optional owner annotations. No text/selector inference and no severity field:
// priority remains the existing high/med/low value on the original note.
export const REASONS = Object.freeze({
  readability: 'Readability', style: 'Style', content: 'Content', technical: 'Technical'
});
const SEVERITY = Object.freeze({
  high: Object.freeze({ text: 'Important', color: '#e5654f' }),
  med: Object.freeze({ text: 'Normal', color: '#f0b44c' }),
  low: Object.freeze({ text: 'Minor', color: '#5b9cff' })
});
const UNKNOWN = Object.freeze({ text: 'Priority unknown', color: '#a0a4af' });
export const severityOf = priority => Object.hasOwn(SEVERITY, priority) ? SEVERITY[priority] : UNKNOWN;
export const reasonOf = code => typeof code === 'string' && Object.hasOwn(REASONS, code) ? code : null;
export const REASON_ADVISORY = 'Unknown reason ignored. Saving still works.';
export function cleanReason(note, advise = () => {}) {
  if (!Object.hasOwn(note, 'reason_code')) return;
  if (reasonOf(note.reason_code)) return;
  const invalid = note.reason_code != null && note.reason_code !== '';
  delete note.reason_code;
  if (invalid) advise(REASON_ADVISORY); // never echo an untrusted code
}

export function makeNoteTaxonomy({ el, $, S, changed, locked, saveUnsent, advise }) {
  let placing = null;
  const chips = (currentNote, update) => {
    const group = el('div', { class: 'reason-chips', role: 'group', 'aria-label': 'Reason (optional)',
      style: { display: 'flex', flexWrap: 'wrap', gap: '4px' }, onclick: e => e.stopPropagation() },
    el('span', { class: 'muted sm' }, 'Reason (optional)'));
    const buttons = Object.entries(REASONS).map(([code, label]) => el('button', {
      type: 'button', class: 'chipbtn', 'data-reason-code': code,
      'aria-pressed': String(currentNote().reason_code === code), onclick: e => {
        e.stopPropagation();
        const note = currentNote();
        if (note.reason_code === code) delete note.reason_code; else note.reason_code = code;
        for (const b of buttons) b.setAttribute('aria-pressed', String(b.getAttribute('data-reason-code') === note.reason_code));
        update();
      }
    }, label));
    group.append(...buttons); return group;
  };
  return {
    composer() {
      // Keep the optional choice inside the existing unsent selection draft.
      if (!S.review.guest) $('#pop .more-reasons').append(chips(() => S.sel, saveUnsent));
    },
    select(original, args) {
      const code = $('#pop .reason-chips') && S.sel?.reason_code;
      const result = original(...args);
      if (code && S.sel) { S.sel.reason_code = code; saveUnsent(); }
      return result;
    },
    place(original, args) {
      placing = S.review.guest ? null : { code: S.sel.reason_code };
      try { return original(...args); } finally { placing = null; }
    },
    beforeChange() {
      if (!placing) return;
      const note = S.review.notes.at(-1);
      if (placing.code != null) { note.reason_code = placing.code; cleanReason(note, advise); }
    },
    prepare() { for (const note of S.review?.notes || []) cleanReason(note, advise); },
    row(row, note) {
      const severity = severityOf(note.priority);
      const badge = row.querySelector('.tg .hi') || el('b', {}, severity.text);
      badge.classList.add('severity'); badge.style.color = severity.color;
      badge.setAttribute('aria-label', 'Priority: ' + severity.text);
      if (!badge.parentNode) row.querySelector('.tg').append(badge);
      const code = reasonOf(note.reason_code);
      if (code) row.querySelector('.tg').append(el('span', { class: 'reason-code' }, REASONS[code]));
      if (row.querySelector('textarea') && !S.review.guest && !locked()) {
        row.querySelector('.nb').append(chips(() => note, changed));
      }
      return row;
    }
  };
}

// Scope the existing numbered-pin drawer to the notes of the view being drawn.
// Outlines, pointer handlers, active rings and guest identities stay with the view.
export const PIN_LIMITS = Object.freeze({ markers: 1024, labelChars: 2048, markChars: 32 });
const pinText = mark => String(mark).slice(0, PIN_LIMITS.markChars);
const omittedText = count => `${count} more notes not shown.`;
function pinLabel(notes, omitted) {
  const more = '; More priorities in the notes list.';
  const suffix = omitted ? '; ' + omittedText(omitted) : '';
  let text = '';
  for (const note of notes) {
    const part = `Note ${pinText(note.mark)}: ${severityOf(note.priority).text}`;
    if (text.length + part.length + 2 + more.length + suffix.length > PIN_LIMITS.labelChars) {
      return text + more + suffix;
    }
    text += (text ? '; ' : '') + part;
  }
  return (text || 'Notes') + suffix;
}
export function makeSeverityPins(drawMark) {
  let scope = null;
  const notices = new WeakMap();
  return {
    wrap(draw) {
      return function (...args) {
        const original = this.notes, hadNotes = Object.hasOwn(this, 'notes'), previous = scope;
        const notes = (original || []).slice(0, PIN_LIMITS.markers), index = new Map();
        // One bounded pass; retain find's first match, including typed duplicate
        // keys. NaN never matches under the old strict-equality lookup.
        for (const note of notes) {
          const mark = note.mark;
          if (mark === mark && !index.has(mark)) index.set(mark, note);
        }
        const omitted = Math.max(0, (original?.length || 0) - notes.length);
        const notice = notices.get(this), noticeParent = notice?.parentNode;
        // Keep the status out of the model's existing children comparison so
        // an unchanged capped frame does not recreate all mounted pins.
        notice?.remove();
        scope = { index }; this.notes = notes;
        let completed = false;
        try {
          const result = draw.apply(this, args);
          const label = pinLabel(notes, omitted);
          if (this.cv) {
            this.cv.setAttribute('role', 'img');
            this.cv.setAttribute('aria-label', label);
            if (omitted) {
              const g = this.g || this.cv.getContext('2d'), k = globalThis.devicePixelRatio || 1;
              const text = omittedText(omitted), width = Math.max(1, this.cv.width / k - 16);
              g.save(); g.setTransform(k, 0, 0, k, 0, 0);
              g.font = '12px Segoe UI'; g.textAlign = 'left'; g.textBaseline = 'middle';
              g.fillStyle = '#111'; g.fillRect(4, 4, Math.min(width + 8, g.measureText(text).width + 16), 20);
              g.fillStyle = '#fff'; g.fillText(text, 8, 14, width); g.restore();
            }
          }
          if (this.markDiv) {
            this.markDiv.setAttribute('role', 'group');
            this.markDiv.setAttribute('aria-label', label);
            if (omitted) {
              const status = notice || this.markDiv.ownerDocument.createElement('span');
              notices.set(this, status); status.className = 'pin-limit'; status.setAttribute('role', 'status');
              status.setAttribute('aria-live', 'off'); // repeated frames must not repeat announcements
              Object.assign(status.style, { position: 'absolute', top: '4px', left: '4px',
                maxWidth: 'calc(100% - 8px)', background: '#111', color: '#fff', padding: '4px', pointerEvents: 'none' });
              status.textContent = omittedText(omitted); this.markDiv.append(status);
            }
          }
          completed = true;
          return result;
        } finally {
          scope = previous;
          if (hadNotes) this.notes = original; else delete this.notes;
          if (!completed && noticeParent) noticeParent.append(notice);
        }
      };
    },
    mark(g, x, y, mark, color, active) {
      const note = scope?.index.get(mark), text = scope ? pinText(mark) : mark;
      if (!note || ['guest', 'guestoff'].includes(note.verdict)) return drawMark(g, x, y, text, color, active);
      const severity = severityOf(note.priority);
      drawMark(g, x, y, text, severity.color, active);
      g.save(); g.font = 'bold 12px Segoe UI'; g.textAlign = 'left'; g.textBaseline = 'middle';
      const width = g.measureText(severity.text).width + 8;
      g.fillStyle = '#111'; g.fillRect(x + 14, y - 9, width, 18);
      g.fillStyle = severity.color; g.fillText(severity.text, x + 18, y); g.restore();
    },
    element(original) {
      return (tag, props = {}, ...kids) => {
        const isPin = props.class?.split(' ').includes('mk'), mark = kids[0];
        const note = isPin && scope?.index.get(mark);
        if (isPin && scope) kids[0] = pinText(mark);
        if (!note || ['guest', 'guestoff'].includes(note.verdict)) return original(tag, props, ...kids);
        const severity = severityOf(note.priority);
        return original(tag, { ...props, 'aria-label': `Note ${pinText(mark)}: ${severity.text}`,
          style: { ...props.style, '--c': severity.color, width: 'auto', borderRadius: '12px', padding: '0 6px' }
        }, pinText(mark) + ' · ' + severity.text);
      };
    }
  };
}
