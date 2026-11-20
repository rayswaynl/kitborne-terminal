// Draw & Grow 7-day economy sim for the Kitborne Terminal tuner. Port of design/tuner/sim.js (design/econ-sim.py v1),
// changed to follow the game code: flat deliveriesPerStorey (Lots.luau), onboarding bonus at the start (Session.luau),
// prices, lot count and cooldown from Config.luau. Numbers are design estimates, not playtest data.
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const ARCH = {
  casual: { label: 'Casual', hint: '1x 8 min per day', days: [1, 2, 3, 4, 5, 6, 7], sess: 1, mins: 8, think: 14 },
  regular: { label: 'Regular', hint: '2x 12 min', days: [1, 2, 3, 4, 5, 6, 7], sess: 2, mins: 12, think: 11 },
  grinder: { label: 'Grinder', hint: '4x 20 min', days: [1, 2, 3, 4, 5, 6, 7], sess: 4, mins: 20, think: 8 },
  sporadic: { label: 'Sporadic', hint: '3 days', days: [1, 3, 6], sess: 1, mins: 10, think: 12 },
};
// Config.luau value -> sim input. Missing values fall back to these defaults.
export function simInput(v, arrays, assume) {
  const g = (k, d) => (v[k] ?? d);
  return {
    BASE_PAY: g('Economy.basePayout', 8), STOREY_STEP: g('Economy.payoutPerStorey', 0.4), NEED: g('City.deliveriesPerStorey', 3),
    SPEED0: g('Truck.cruise', 28), SPEED_STEP: g('Truck.speedPerLevel', 0.12), RENT: g('Economy.mailboxPerStoreyPerMin', 0.06),
    RENT_CAP: g('Economy.mailboxCapMin', 120), DAILY: g('Economy.dailyOrders', 10), ONBOARD: g('Economy.onboardingBonus', 6),
    FIRST_LOTS: g('Economy.firstLots', 2), MAX_STOREY: g('City.maxStoreys', 4), FIRST_HOUSE: g('City.firstHouseStoreyAfter', 2),
    COOLDOWN: g('City.orderCooldown', 4), LOT_COUNT: g('Island.lotCount', 12),
    LOT_PRICES: arrays['Economy.permitPrices'] || [20, 28, 38, 50, 66, 86, 110, 140, 175, 220],
    SPD_PRICES: arrays['Economy.speedPrices'] || [60, 140, 280, 450], ...assume,
  };
}
function simulate(K, name, seed) {
  const r0 = mulberry(seed), U = (a, b) => a + (b - a) * r0(), RI = n => Math.floor(r0() * n);
  const a = ARCH[name], N = K.LOT_COUNT, first = Math.max(1, Math.min(N, Math.round(K.FIRST_LOTS)));
  const LOT = K.LOT_PRICES.map(x => x * K.LOT_MULT), SPD = K.SPD_PRICES.map(x => x * K.UPG_MULT), CARGO = [600 * K.UPG_MULT];
  const RS = [1, 1.2, 1.4], RP = [1, 1.15, 1.3], PF = [0, .5, 1], LM = [3000, 7000, 14000, 26000, 45000], COS = [150, 150, 250, 250, 400];
  const s = { b: K.ONBOARD, lots: first, speed: 0, cargo: 0, pave: 0, dels: Array(first).fill(0), stor: Array(first).fill(1), bought: 0, since: 0, waits: [], lm: 0, cos: 0, i2: false, i2day: null, ftue: false, last: null, tfr: null, tfb: null, clock: 0 };
  const pay = st => K.BASE_PAY * (1 + K.STOREY_STEP * (st - 1)) * RP[s.pave], spd = () => K.SPEED0 * (1 + K.SPEED_STEP * s.speed) * RS[s.pave];
  const avg = () => s.stor.reduce((x, y) => x + y, 0) / s.stor.length, need = Math.max(1, K.NEED);
  const mark = k => { s.bought++; s.waits.push([s.bought, s.since, k]); s.since = 0; if (s.tfb === null) s.tfb = s.clock; };
  function cands() {
    const c = [];
    if (s.lots < N) c.push(['lots', LOT[Math.min(LOT.length - 1, s.lots - first)], 150 * PF[s.pave]]);
    if (s.speed < SPD.length) c.push(['speed', SPD[s.speed], 0]);
    if (s.cargo < 1) c.push(['cargo', CARGO[s.cargo], 0]);
    if (s.pave < 2 && s.lots >= 3) c.push(['pave', 150 * s.lots * (PF[s.pave + 1] - PF[s.pave]), 0]);
    return c;
  }
  function tryBuy() {
    for (;;) {
      const c = cands();
      if (c.length) {
        c.sort((x, y) => x[1] + x[2] - y[1] - y[2]); const [k, cost, ex] = c[0];
        if (s.b >= cost + ex) { s.b -= cost + ex; if (k === 'lots') { s.lots++; s.dels.push(0); s.stor.push(1); } else if (k === 'speed') s.speed++; else if (k === 'cargo') s.cargo++; else s.pave++; mark(k); continue; }
        break;
      }
      if (!s.i2 && s.lots === N && avg() >= 3) { if (s.b >= K.ISLAND2) { s.b -= K.ISLAND2; s.i2 = true; mark('sink'); continue; } break; }
      if (s.lm < 5 && s.b >= LM[s.lm]) { s.b -= LM[s.lm]; s.lm++; mark('sink'); continue; }
      if (s.cos < 5 && s.b >= COS[s.cos] && s.lm >= 1) { s.b -= COS[s.cos]; s.cos++; mark('sink'); continue; }
      break;
    }
  }
  function trip() {
    const c = Math.min(1 + s.cargo, s.lots), draw = a.think * K.THINK_MULT * U(.75, 1.3), drive = K.DIST * (1 + .4 * (c - 1)) / spd(), t = draw + drive + K.COOLDOWN + 2; let tot = 0;
    for (let j = 0; j < c; j++) {
      const i = RI(s.lots), p = pay(s.stor[i]); s.dels[i]++;
      if (i === 0 && !s.ftue && s.stor[0] === 1 && s.dels[0] >= K.FIRST_HOUSE) { s.stor[0] = 2; s.dels[0] = 0; s.ftue = true; }
      else if (s.stor[i] < K.MAX_STOREY && s.dels[i] >= need) { s.stor[i]++; s.dels[i] = 0; }
      tot += p;
    }
    s.b += tot; if (s.tfr === null) s.tfr = s.clock + 4 + draw + drive + 1; return t;
  }
  const rows = [];
  for (let day = 1; day <= 7; day++) {
    if (a.days.includes(day)) for (let k = 0; k < a.sess; k++) {
      if (s.last !== null) s.b += K.RENT * s.stor.reduce((x, y) => x + y, 0) * Math.min((day - s.last) * 1440, K.RENT_CAP);
      if (k === 0 && s.last !== null) s.b += K.DAILY * pay(Math.max(1, Math.round(avg())));
      tryBuy(); const len = a.mins * 60 * U(.7, 1.3); let t = 4;
      while (t < len) { const dt = trip(); t += dt; s.since += dt / 60; s.clock += dt; tryBuy(); }
      s.last = day;
    }
    if (s.i2 && s.i2day === null) s.i2day = day; rows.push({ day, lots: s.lots, storey: avg() });
  }
  return { s, rows };
}
export function summarize(K, n = 60) {
  const med = v => { v = [...v].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const out = {};
  for (const name of Object.keys(ARCH)) {
    const res = []; for (let sd = 100; sd < 100 + n; sd++) res.push(simulate(K, name, sd));
    out[name] = {
      firstReward: med(res.map(r => r.s.tfr)), firstBuy: med(res.filter(r => r.s.tfb !== null).map(r => r.s.tfb)),
      allLots: res.filter(r => r.s.lots === K.LOT_COUNT).length / n, i2: res.filter(r => r.s.i2day).length / n, i2day: med(res.filter(r => r.s.i2day).map(r => r.s.i2day)),
      lots: [1, 2, 3, 4, 5, 6, 7].map(d => med(res.map(r => r.rows[d - 1].lots))),
    };
  }
  return out;
}
export const CHECKS = [
  ['First reward within 60 s (everyone)', o => Object.values(o).every(r => r.firstReward <= 60)],
  ['First purchase within 90 s (everyone)', o => Object.values(o).every(r => r.firstBuy != null && r.firstBuy <= 90)],
  ['Casual has all lots in week 1 (min. 50%)', o => o.casual.allLots >= .5],
  ['Regular reaches island 2 in week 1 (min. 80%)', o => o.regular.i2 >= .8],
  ['Casual does not reach island 2 in week 1 (max. 20%)', o => o.casual.i2 <= .2],
  ['Grinder does not finish island 1 by day 1-2', o => !(o.grinder.i2day && o.grinder.i2day <= 2)],
];

