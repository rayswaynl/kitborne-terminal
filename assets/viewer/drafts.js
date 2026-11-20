const encode = value => JSON.stringify(value, (_, v) => v instanceof Map ? { $map: [...v] } : v);
const decode = value => JSON.parse(value, (_, v) => v && v.$map ? new Map(v.$map) : v);
export function makeDrafts(storage, tab) {
  const prefix = id => 'ar.pending.' + JSON.stringify(id) + '.';
  const written = new Map();
  return {
    put(id, value) { const key = prefix(id) + tab, raw = encode(value); storage.setItem(key, raw); written.set(key, raw); },
    get(id) {
      const own = prefix(id) + tab;
      const keys = storage.getItem(own) ? [own] : Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(k => k.startsWith(prefix(id)));
      return keys.map(key => ({ key, raw: storage.getItem(key) })).map(r => ({ ...r, value: decode(r.raw) }));
    },
    clear(id, restored = []) {
      const key = prefix(id) + tab;
      for (const r of [{ key, raw: written.get(key) }, ...restored]) if (r.raw != null && storage.getItem(r.key) === r.raw) storage.removeItem(r.key);
      written.delete(key);
    }
  };
}
