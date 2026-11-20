// Two screens, one review. When the server refuses a save (409: another screen saved first), take the server's version
// and lay back only what changed HERE since the last save: new, edited or deleted notes (compared per note id). Notes the other screen
// changed stay as they are, so two screens that edit different notes keep each other's work.
export function makeSync(skip = []) {
  const stable = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
  const sig = n => stable(Object.fromEntries(Object.entries(n).filter(([k]) => k[0] !== '_' && !skip.includes(k))));
  const snap = notes => new Map((notes || []).map(n => [n.id, sig(n)]));
  // server: the notes now on the server; local: the notes on this screen; base: snap() of the last state both agreed on.
  // renumber(n, mark) gives a new note another id when the other screen already used its id; edit(serverNote, myNote) returns the edited note.
  const merge = (server, local, base, { renumber, edit } = {}) => {
    const out = server.slice(); let mark = out.reduce((m, n) => Math.max(m, n.mark || 0), 0);
    for (const n of local) {
      const was = base.get(n.id); if (was !== undefined && was === sig(n)) continue; // not touched here
      const same = out.find(c => c.id === n.id);
      if (same && sig(same) === sig(n)) continue; // the server already has exactly this
      if (was === undefined) { // new here; the other screen may have made one with the same id
        if (same && !renumber) out[out.indexOf(same)] = n; // one answer per follow-up: this screen's answer replaces the other one
        else { if (same) renumber(n, ++mark); out.push(n); }
      }
      else if (same) { // edited here: only the fields I changed win, the other screen keeps its own field edits
        const b = JSON.parse(was), mixed = { ...same };
        for (const k of new Set([...Object.keys(n), ...Object.keys(b)])) {
          if (k[0] === '_') mixed[k] = n[k];
          else if (!skip.includes(k) && stable(n[k]) !== stable(b[k])) { if (n[k] === undefined) delete mixed[k]; else mixed[k] = n[k]; }
        }
        out[out.indexOf(same)] = edit ? edit(same, mixed) : mixed;
      }
      else out.push(n); // deleted on the other screen, edited here: keep my edit
    }
    for (const [id, s] of base) { // deleted here: remove it, unless the other screen changed it
      if (local.some(n => n.id === id)) continue;
      const same = out.find(c => c.id === id); if (same && sig(same) === s) out.splice(out.indexOf(same), 1);
    }
    return out;
  };
  return { sig, snap, merge };
}
