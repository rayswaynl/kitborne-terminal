// Kitborne Terminal tuner tab (owner only): sliders for a game's Config.luau with the 7-day sim beside them.
// Shown when the project root has tuner.json (scripts/tuner.py). Draft changes stay in the browser until Save.
import { ARCH, CHECKS, simInput, summarize } from './tuner-sim.js';

const fmt = v => v == null ? '-' : String(Math.round(v * 100) / 100);
const COLORS = { casual: '#FFB547', regular: '#D6FF3F', grinder: '#7FD8FF', sporadic: '#F49BFF' };

export function makeTuner(X) {
  const { S, el, api, toast, reviewer } = X;
  const T = { data: null, draft: {}, assume: {}, show: new Set(['casual', 'regular']), timer: 0 };
  const changed = () => Object.keys(T.draft).filter(k => T.draft[k] !== T.data.values[k]);
  const order = () => T.data.spec.params.map(p => p.section + '.' + p.key);
  const sinceCommit = () => order().filter(k => T.data.committed[k] !== undefined && T.draft[k] !== undefined && T.draft[k] !== T.data.committed[k]);
  const assumeDefaults = () => Object.fromEntries((T.data.spec.sim || []).map(a => [a.key, a.default]));

  T.load = async () => {
    try { S.tuner = await api('/api/tuner'); } catch (e) { S.tuner = { enabled: false }; }
    return S.tuner.enabled;
  };
  const reset = data => { T.data = data; T.draft = { ...data.values }; if (!Object.keys(T.assume).length) T.assume = assumeDefaults(); };

  function slider(key, p, value, base, onInput, live) {
    const diff = base !== undefined && value !== base;
    const out = el('b', { class: diff ? 'diff' : '' }, fmt(value), diff ? el('small', {}, ' (was ' + fmt(base) + ')') : null);
    const input = el('input', { type: 'range', min: p.min, max: p.max, step: p.step, value, 'aria-label': p.label });
    const tick = base !== undefined ? el('i', { class: 'tick', style: { left: ((base - p.min) / (p.max - p.min) * 100) + '%' } }) : null;
    input.addEventListener('input', () => {
      const v = +input.value; onInput(v);
      const d = base !== undefined && v !== base;
      out.className = d ? 'diff' : ''; out.replaceChildren(fmt(v), d ? el('small', {}, ' (was ' + fmt(base) + ')') : null);
    });
    return el('div', { class: 'tsl', 'data-key': key },
      el('label', {}, el('span', {}, p.label, live ? el('span', { class: 'tlive', title: 'Can also be adjusted live in Studio (F8 during playtest)' }, 'Studio') : null), out),
      el('div', { class: 'ttrack' }, input, tick), el('small', {}, p.hint || ''));
  }

  function sliders() {
    const spec = T.data.spec, box = el('div', { class: 'tcard tsliders' });
    for (const g of spec.groups) {
      const ps = spec.params.filter(p => p.section === g.id && T.data.values[p.section + '.' + p.key] !== undefined);
      if (!ps.length) continue;
      box.append(el('h3', {}, g.label));
      for (const p of ps) {
        const k = p.section + '.' + p.key;
        box.append(slider(k, p, T.draft[k], T.data.committed[k], v => { T.draft[k] = v; paintSide(); run(); }, p.live !== false));
      }
    }
    if ((spec.sim || []).length) {
      box.append(el('h3', {}, 'Sim assumptions'), el('p', { class: 'muted sm' }, 'Not in Config.luau; they only change the forecast.'));
      for (const a of spec.sim) box.append(slider('sim.' + a.key, a, T.assume[a.key], a.default, v => { T.assume[a.key] = v; run(); }, false));
    }
    return box;
  }

  const delta = (now, was, unit, lowerIsBetter = true) => {
    if (now == null || was == null || Math.round(now) === Math.round(was)) return null;
    const d = Math.round(now - was), good = lowerIsBetter ? d < 0 : d > 0;
    return el('span', { class: good ? 'tup' : 'tdn' }, ' ' + (d > 0 ? '+' : '') + d + (unit || ''));
  };
  function impact(o, b) {
    const pct = v => Math.round(v * 100) + '%';
    const rows = Object.keys(ARCH).map(n => {
      const r = o[n], w = b[n];
      return el('tr', {}, el('td', {}, el('i', { class: 'tdot', style: { background: COLORS[n] } }), ARCH[n].label, el('small', {}, ' ' + ARCH[n].hint)),
        el('td', {}, fmt(Math.round(r.firstReward)) + ' s', delta(r.firstReward, w.firstReward, ' s')),
        el('td', {}, r.firstBuy == null ? '-' : Math.round(r.firstBuy) + ' s', delta(r.firstBuy, w.firstBuy, ' s')),
        el('td', {}, pct(r.allLots)),
        el('td', {}, r.i2 ? pct(r.i2) + ', day ' + r.i2day : '-', r.i2day && w.i2day ? delta(r.i2day, w.i2day, '', false) : null));
    });
    return el('div', { class: 'tcard' }, el('h2', {}, 'Impact', el('span', { class: 'tpill' }, '4 player types x 60 runs x 7 days')),
      el('div', { class: 'tscroll' }, el('table', { class: 'ttable' }, el('tr', {}, ...['Player type', '1st reward', '1st purchase', 'all lots', 'island 2'].map(h => el('th', {}, h))), rows)));
  }
  function chart(o, b) {
    const W = 560, H = 200, L = 34, n = T.data.values['Island.lotCount'] || 12;
    const R = 28, x = i => L + i * (W - L - R) / 6, y = v => H - 24 - v / n * (H - 40);
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('class', 'tchart');
    const add = (tag, at) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); svg.append(e); return e; };
    for (const v of [0, n / 2, n]) { add('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#262626' }); add('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', fill: '#9C9C95', 'font-size': 11 }).textContent = Math.round(v); }
    for (let i = 0; i < 7; i++) add('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', fill: '#9C9C95', 'font-size': 11 }).textContent = 'day ' + (i + 1);
    for (const nme of T.show) {
      const line = (lots, dash) => add('polyline', { fill: 'none', stroke: dash ? '#6f6f69' : COLORS[nme], 'stroke-width': dash ? 2 : 3, 'stroke-dasharray': dash ? '6 5' : '', points: lots.map((v, i) => x(i) + ',' + y(v)).join(' ') });
      line(b[nme].lots, true); line(o[nme].lots, false);
    }
    const chips = el('div', { class: 'tchips' }, Object.keys(ARCH).map(nme => el('button', { class: 'tchip' + (T.show.has(nme) ? ' on' : ''), style: { '--c': COLORS[nme] },
      onclick: () => { T.show.has(nme) ? T.show.delete(nme) : T.show.add(nme); run(true); } }, ARCH[nme].label)));
    return el('div', { class: 'tcard' }, el('h2', {}, 'Lots per day', el('span', { class: 'tpill' }, 'dotted = last commit')), chips, svg);
  }
  function checks(o, b) {
    return el('div', { class: 'tcard' }, el('h2', {}, 'Design checks'), CHECKS.map(([label, f]) => {
      const ok = f(o), was = f(b);
      return el('div', { class: 'tchk' }, el('i', { class: 'tdot ' + (ok ? 'ok' : 'bad') }), label, ok !== was ? el('small', { class: ok ? 'tup' : 'tdn' }, ok ? ' turns green' : ' turns red') : null);
    }));
  }

  let side = null, mid = null, bar = null;
  function paintSide() {
    if (!side) return;
    const unsaved = changed(), vsCommit = sinceCommit();
    if (bar) bar.querySelector('.tsave').replaceChildren(unsaved.length ? 'Save (' + unsaved.length + ')' : 'Saved'), bar.querySelector('.tsave').disabled = !unsaved.length;
    const lines = vsCommit.map(k => el('div', {}, el('span', { class: 'tminus' }, '- ' + k + ' = ' + fmt(T.data.committed[k])), el('span', { class: 'tplus' }, '+ ' + k + ' = ' + fmt(T.draft[k]))));
    side.replaceChildren(
      el('div', { class: 'tcard' }, el('h2', {}, 'Changes', unsaved.length ? el('span', { class: 'tpill amber' }, unsaved.length + ' not saved') : null),
        el('p', { class: 'muted sm' }, 'Compared with the last commit (' + (T.data.commit || '?') + ' on ' + (T.data.branch || '?') + ').'),
        vsCommit.length ? el('div', { class: 'tdiff' }, lines) : el('p', { class: 'muted' }, 'Nothing changed yet.'),
        el('div', { class: 'tbtns' },
          el('button', { class: 'tsave', disabled: !unsaved.length, onclick: save }, 'Save to Config.luau'),
          el('button', { class: 'ghost', disabled: !unsaved.length, onclick: () => { T.draft = { ...T.data.values }; paint(); } }, 'Back to file'),
          vsCommit.length ? el('button', { class: 'ghost', onclick: () => { for (const k of Object.keys(T.draft)) if (T.data.committed[k] !== undefined) T.draft[k] = T.data.committed[k]; paint(); } }, 'Back to commit') : null),
        el('p', { class: 'muted sm' }, 'Writes to ' + T.data.repo.replace(/\\/g, '/') + '/' + T.data.file + '. Only the numbers change; comments stay.')),
      el('div', { class: 'tcard' }, el('h2', {}, 'Live in Studio'),
        el('p', { class: 'muted' }, 'Start a playtest in your own Studio copy and press ', el('kbd', {}, 'F8'), ' (or tap the Tuner button). Values with the label ', el('span', { class: 'tlive' }, 'Studio'), ' change there right away; you see it on the next run. Lock in good values here with Save.')));
  }
  function run(now) {
    clearTimeout(T.timer);
    T.timer = setTimeout(() => {
      if (!mid) return;
      const o = summarize(simInput(T.draft, T.data.arrays, T.assume)), b = summarize(simInput(T.data.committed, T.data.arrays, assumeDefaults()));
      mid.replaceChildren(impact(o, b), chart(o, b), checks(o, b));
      if (bar) {
        const ok = CHECKS.filter(([, f]) => f(o)).length, was = CHECKS.filter(([, f]) => f(b)).length;
        bar.querySelector('.tsum').replaceChildren(el('b', { class: ok === CHECKS.length ? 'tup' : '' }, ok + '/' + CHECKS.length + ' checks green'), ok !== was ? el('small', { class: ok > was ? 'tup' : 'tdn' }, ' (was ' + was + ')') : null,
          el('br'), 'Casual 1st purchase ' + Math.round(o.casual.firstBuy ?? 0) + ' s · Regular island 2 ' + (o.regular.i2day ? 'day ' + o.regular.i2day : '-'));
      }
    }, now ? 0 : 80);
  }
  async function save() {
    const values = Object.fromEntries(changed().map(k => [k, T.draft[k]]));
    try {
      const r = await api('/api/tuner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values, base: T.data.base, by: reviewer ? reviewer() : undefined }) });
      toast('Saved to Config.luau: ' + Object.keys(r.changed).length + ' waarde(n)');
      reset(r); paint();
    } catch (e) {
      toast(e.status === 409 ? 'Config.luau changed in the meantime; reloading it' : 'Save failed: ' + e.message, 5000);
      if (e.status === 409 && await T.load()) { reset(S.tuner); paint(); }
    }
  }
  let root = null;
  function paint() {
    side = el('aside', { class: 'tside' }); mid = el('section', { class: 'tmid' });
    bar = el('div', { class: 'tbar' }, el('div', { class: 'tsum' }), el('button', { class: 'tsave', onclick: save }, 'Saved'));
    root.replaceChildren(
      el('div', { class: 'hhead' }, el('h2', {}, 'Tuner'), el('span', { class: 'muted sm' }, (S.cat && S.cat.project || '') + ' · ' + T.data.file + ' · ' + T.data.branch)),
      el('div', { class: 'tgrid' }, sliders(), mid, side), bar);
    paintSide(); run(true);
  }
  T.view = () => {
    root = el('div', { class: 'tuner' }, el('p', { class: 'muted' }, 'Loading tuner...'));
    (async () => {
      if (!(S.tuner && S.tuner.enabled) && !await T.load()) { root.replaceChildren(el('p', { class: 'muted' }, 'This project has no tuner (tuner.json is missing).')); return; }
      if (!T.data || T.data.repo !== S.tuner.repo) reset(S.tuner); else if (!changed().length) reset(S.tuner);
      paint();
    })();
    return root;
  };
  return T;
}



