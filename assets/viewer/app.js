// Asset Review viewer. Flow: home (what waits for you) -> one version at a time -> point at a part, say what should change -> one decision -> next.
import { THREE, GLTFLoader, OrbitControls, load3d } from './three-lazy.js';
import { makeComments, personChip, GUEST_COLORS } from './people.js';
import { makeHome, nice } from './home.js';
import { makeLibrary } from './library.js';
import { makeTuner } from './tuner.js';
import { makePdf } from './pdf.js';
import { makeSync } from './merge.js';
import { makeStudio } from './studio.js';
import { makeDrafts } from './drafts.js';
import { makeCategory } from './category.js';
import { InspectTools } from './inspect-tools.js';
import { checklistKey } from './legacy-checks.js';
// R3C-111 begin
import { queueBatch, queueSettings, projectQueueText } from './review-queue.js';
const waitingTotal = () => S.me?.owned_by ? 0 : S.cat.review_queue?.total ?? ownerQueue().length;
// R3C-111 end

const $ = (s, r = document) => r.querySelector(s);
// Who saves the review: the owner by default ("Owner"); agents testing the tool open the viewer with ?by=agent-test.
const REVIEWER = new URLSearchParams(location.search).get('by') || 'Owner';
// ?p=<project id> picks one of the projects this server knows (the tabs); every request carries it. No p = the server's own project.
const PROJECT = new URLSearchParams(location.search).get('p');
const withP = u => PROJECT ? u + (u.includes('?') ? '&' : '?') + 'p=' + PROJECT : u;
// Optional children are written inline as `cond ? node : null`; the DOM would print those as the text "null".
for (const k of ['replaceChildren', 'append']) { const f = Element.prototype[k]; Element.prototype[k] = function (...c) { return f.apply(this, c.flat().filter(x => x != null && x !== false)); }; }
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? e.style.setProperty(sk, sv) : (e.style[sk] = sv); }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (['value', 'checked', 'disabled', 'selected', 'title', 'textContent', 'open'].includes(k)) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const ICONS = {
  back: 'M15 18l-6-6 6-6', next: 'M9 18l6-6-6-6', point: 'M6 3l13 7.5-5.6 1.6L11 18z', pen: 'M4 20l4.5-1L19 8.5 15.5 5 5 15.5zM13.5 7l3.5 3.5',
  hand: 'M8 12.5V6a1.5 1.5 0 013 0v5.5M11 5a1.5 1.5 0 013 0v6.5M14 6.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-.5a6 6 0 01-5-2.6l-2.3-3.5a1.5 1.5 0 012.4-1.8L8 14',
  compare: 'M12 3v18M4 6h5v12H4zM15 6h5v12h-5z', sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4', clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  check: 'M5 12.5l4.5 4.5L19 7', x: 'M6 6l12 12M18 6L6 18', lock: 'M8 11V8a4 4 0 018 0v3M6 11h12v9H6z', eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  spark: 'M12 3.5l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7z', send: 'M4 12h15M13 6l6 6-6 6', help: 'M9.2 9a2.9 2.9 0 015.6 1c0 2-2.8 2.3-2.8 4M12 17.5v.5M12 3a9 9 0 100 18 9 9 0 000-18z', trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13',
  plus: 'M12 5v14M5 12h14', refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7', search: 'M10.5 4a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM15.3 15.3L20 20',
  download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  click: 'M9 9l10 4-4.2 1.6L13 19zM6 3.5l1 2.2M3 7.5l2.3.6M11.5 3l-.8 2.3',
  archive: 'M4 6h16v4H4zM6 10v9h12v-9M10 14h4', copy: 'M9 9h10v11H9zM5 15V4h10', play: 'M8 5l11 7-11 7z',
  note: 'M9 18V5l11-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z', cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  ft_text: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 15.5h7M9 19h4', ft_md: 'M3 6h18v12H3zM6.5 15V9l2.5 3 2.5-3v6M13.5 12.5l2 2.5 2-2.5M15.5 9v6',
  ft_video: 'M3 6.5h12v11H3zM15 10.5l6-3.5v10l-6-3.5', ft_gif: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7M10.5 9v6l4.5-3z',
  ft_game: 'M7 8h10a4 4 0 014 4v2.5a2.5 2.5 0 01-4.3 1.7L15 14.5H9l-1.7 1.7A2.5 2.5 0 013 14.5V12a4 4 0 014-4zM8 10.5v3M6.5 12h3M16 11.5h.01M18 13h.01',
  ft_image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5h.01',
  contrast: 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 3v18M12 7h4.5M12 11h6M12 15h5', textheight: 'M5 5h8M9 5v14M16 5v14M14 5h4M14 19h4',
};
// File-type icon per row (Text, MD, video, gif, game, plus image/audio/3D/archive). Colour comes from .ft-<kind> in style.css.
const FILE_KINDS = [
  ['md', ['md', 'markdown']], ['gif', ['gif']], ['video', ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']],
  ['game', ['rbxl', 'rbxlx', 'rbxm', 'rbxmx', 'exe', 'apk', 'pck', 'unitypackage', 'love']],
  ['image', ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg', 'avif', 'tga']], ['audio', ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']],
  ['model', ['glb', 'gltf', 'fbx', 'obj', 'blend', 'stl', 'step', 'stp', 'usdz']], ['archive', ['zip', '7z', 'rar', 'tar', 'gz']],
];
function fileKind(f) {
  const ext = (f.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || ''; const hit = FILE_KINDS.find(([, e]) => e.includes(ext));
  if (hit) return hit[0];
  return f.media === 'video' ? 'video' : f.media === 'audio' ? 'audio' : f.media === 'image' ? 'image' : 'text';
}
const KIND_ICON = { text: 'ft_text', md: 'ft_md', video: 'ft_video', gif: 'ft_gif', game: 'ft_game', image: 'ft_image', audio: 'note', model: 'cube', archive: 'archive' };
const KIND_LABEL = { text: 'Text', md: 'Markdown', video: 'Video', gif: 'GIF', game: 'Game', image: 'Image', audio: 'Audio', model: '3D model', archive: 'Archive' };
function fileTypeIcon(f) { const k = fileKind(f); const s = icon(KIND_ICON[k], 16); s.classList.add('ftype', 'ft-' + k); s.setAttribute('aria-hidden', 'false'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', KIND_LABEL[k]); const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = KIND_LABEL[k]; s.prepend(t); return s; }
function icon(n, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[n] || ''); s.append(p); return s;
}
const STATUS = { none: ['Nothing yet', '#3d4047'], in_review: ['Waiting for you', '#5b9cff'], changes: ['Changes requested', '#f0b44c'], approved: ['Approved', '#5fbf7a'], rejected: ['Rejected', '#e5654f'], gate: ['Held back', '#f0b44c'] };
// approve on a note = keep it exactly like this (a lock for agents)
const VERDICT = { change: ['Change', '#f0b44c'], approve: ['Keep as is', '#5fbf7a'], reject: ['Reject', '#e5654f'] };
Object.assign(VERDICT, GUEST_COLORS); // other people's comments on the canvas: purple while open, grey when settled
let HM = null; // home screen pieces (home.js)
let LB = null; // home tabs, library browser and archived projects (library.js)
let TN = null; // tuner tab for projects with tuner.json (tuner.js)
let CT = null; // per-category batch review (category.js)
let CM = null; // guest comments + identity (people.js), created in boot
const SENT = { approved: 'Approved', changes: 'Changes requested', rejected: 'Rejected' };
STATUS.unverified = ['Unverified', '#f0b44c'];
// One-click send-back: the agent works on its own (review field "auto"; review.py MANDATES holds the agent instruction).
const AUTO = { improve: ['Improve it all', 'pen', 'The agent reviews the whole asset critically and improves the weakest points. Anything you locked stays as it is.'],
  variants: ['3 variants', 'compare', 'The agent makes 3 clearly different versions. You pick 1 side by side.'],
  refs: ['With references', 'eye', 'The agent first finds real references (photos, sizes, good examples) and improves the asset to match.'],
  expand: ['Expand it', 'spark', 'The agent adds the most valuable missing parts. Anything you locked stays as it is.'] };
const autoChoice = rv => hasPro() && AUTO[rv?.auto];
const autoName = rv => rv?.verdict !== 'approved' ? autoChoice(rv)?.[0] || '' : '';
const withoutCoreMandate = rv => { if (rv && !hasPro()) delete rv.auto; return rv; };
const SHORT = { pitch: 'Pitch', design: 'Design', style: 'Style', level: 'Level', prototype: 'Prototype', ui: 'UI', brief: 'Brief', concept: 'Concept', turnaround: 'Turnaround', blockout: 'Blockout', model: 'Model', surface: 'Colour', rig: 'Rig', animation: 'Animation', vfx: 'VFX', audio: 'Audio', optimize: 'Optimise', engine: 'In-engine', playtest: 'Playtest', balance: 'Balance', assets: 'Assets', sound: 'Sound & music', slice: 'Slice', polish: 'Polish', qa: 'QA', store: 'Store', page: 'Web page', post: 'Social post', final: 'Final' };
// asset, game or web: which family of stages belongs to this item's route.
const routeGroup = id => (((S.cat.routes || {})[(S.cat.assets[id] || {}).route || 'full']) || {}).group || 'asset';
const MEDIA = { model: '3D model', video: 'Video', audio: 'Audio', text: 'Text', image: 'Image', pdf: 'PDF' };
// readable names for the parts inside Pocket Front GLBs (extras pf_group / pf_role)
const ROLE_NL = { blanket: 'Blanket', body: 'Hull', body_dark: 'Hull dark', boots: 'Boots', brass: 'Brass', camo: 'Camo', camo_dark: 'Camo dark', canvas: 'Canvas', emblem: 'Emblem', eye: 'Eyes', glass: 'Glass', helmet: 'Helmet', lamp: 'Lamp', metal: 'Metal', mud: 'Mud', pivot: 'Pivot', rubber: 'Rubber', skin: 'Skin', strap: 'Strap', track: 'Track', uniform: 'Uniform', uniform_dark: 'Uniform dark', wood: 'Wood', grass: 'Grass' };
const GROUP_NL = { armL: 'linkerarm', armR: 'rechterarm', body: '', gun: 'kanon', legL: 'linkerbeen', legR: 'rechterbeen', turret: 'toren', weapon: 'wapen' };
const pad3 = v => String(v).padStart(3, '0');
const S = { cat: null, mode: 'home', asset: null, stage: null, v: null, file: 0, review: null, prev: null, view: null, cmp: null, compare: false, cmpWith: null, cmpMode: 'side', sel: null, active: null, editing: false, lastPt: null, open: {} };
const hasPro = () => S.info?.pro === true;
// Every request gets a time limit: a phone whose Tailscale connection sleeps must never leave a button waiting forever.
const api = async (p, o = {}) => {
  let r; try { r = await fetch(o.p ? p + (p.includes('?') ? '&' : '?') + 'p=' + encodeURIComponent(o.p) : withP(p), { signal: AbortSignal.timeout(o.method && o.method !== 'GET' ? 60000 : 15000), ...o }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? 'the computer is not responding (is Tailscale on?)' : 'no connection to the computer (is Tailscale on?)'); }
  if (!r.ok) { let b = null; try { b = await r.json(); } catch (x) { /* no body */ } const e = new Error(b && b.error || p + ' ' + r.status); e.status = r.status; e.body = b; throw e; } return r.json(); };
const toast = (t, ms = 3000, action) => { const d = $('#toast'); d.replaceChildren(el('span', {}, t), action ? el('button', { onclick: () => { d.hidden = true; action[1](); } }, action[0]) : ''); d.hidden = false; placeToast(); clearTimeout(toast.t); toast.t = setTimeout(() => d.hidden = true, ms); };
// A phone held sideways, and a phone held either way (theme.css uses the same queries).
const SIDEWAYS = '(orientation:landscape) and (max-height:560px) and (min-width:568px)', PHONE = '(max-width:820px),' + SIDEWAYS;
// Review toasts stay at the top of the picture column, clear of tools and decisions; phones use the first free band.
function placeToast() {
  const d = $('#toast'); if (d.hidden) return; d.removeAttribute('style');
  if (!document.body.classList.contains('review')) return;
  const c = $('#canvas').getBoundingClientRect();
  if (!matchMedia(PHONE).matches) {
    Object.assign(d.style, { left: c.left + c.width / 2 + 'px', top: c.top + 12 + 'px', bottom: 'auto', maxWidth: Math.min(560, Math.max(0, c.width - 24)) + 'px' });
    return;
  }
  Object.assign(d.style, { left: c.left + 8 + 'px', right: innerWidth - c.right + 8 + 'px', width: 'fit-content', maxWidth: 'none', marginInline: 'auto', transform: 'none', top: 'calc(env(safe-area-inset-top) + 8px)', bottom: 'auto' });
  const t = d.getBoundingClientRect(); let y = t.top;
  const guards = [...document.querySelectorAll('#dock .tool, #decide button, #decide summary')].filter(e => e.checkVisibility()).map(e => e.getBoundingClientRect()).filter(g => g.left < t.right && g.right > t.left).sort((a, b) => a.top - b.top);
  for (const g of guards) if (g.bottom > y && g.top < y + t.height + 8) y = g.bottom + 8;
  if (y !== t.top && y + t.height <= innerHeight) d.style.top = y + 'px';
}
addEventListener('scroll', placeToast, { passive: true });
// Every review save says which version of the file it started from (base_rev); a new review starts from 0. A refused save (409) never overwrites.
const RS = makeSync();
const baseRev = rv => Number.isInteger(rv && rv.rev) ? rv.rev : 0;
const baseOf = rv => ({ notes: RS.snap(rv.notes), summary: rv.summary || '', checklist: JSON.stringify(rv.checklist || {}), followups: RS.snap(rv.followups) });
const postReview = (review, files, base, p) => api('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ review: hasPro() ? review : withoutCoreMandate({ ...review }), files: files || {}, base_rev: base }), p });
const draftTab = crypto.randomUUID(); // a duplicated tab or reload is a new writer; old slots remain recoverable
const drafts = makeDrafts(localStorage, draftTab);
const draftId = () => [PROJECT || (S.proj || {}).home, (S.me || {}).person || REVIEWER, S.asset, S.stage, S.v];
// pendingSave: still to send. unconfirmed: changed since the server last confirmed a save; only clearDraft() ends it.
function keepDraft() { if (S.review && S.asset && S.unconfirmed) { try { drafts.put(draftId(), { review: S.review, base: S.base, cbase: S.cbase, crev: S.crev, files: S.cfiles }); } catch (e) { toast('Could not save locally. Keep this screen open until saving works.', 8000); return false; } } return true; }
function clearDraft() { drafts.clear(draftId(), S.restoredDrafts); S.restoredDrafts = []; S.unconfirmed = false; }
// gen counts edits. A confirmed save ends `unconfirmed` only when no edit came after it was sent; a newer edit stays a draft and goes out again.
function confirmed(g) { if (S.gen === g && !S.pendingSave) { clearDraft(); return true; } S.pendingSave = true; keepDraft(); return false; }
// Send again what the server has not confirmed, also after a keepalive from a hidden or closing tab that never got an answer.
function resend() { if (!S.unconfirmed || !S.review) return; S.pendingSave = true; postDraft().catch(() => {}); }
async function leaveReview() {
  if (S.unconfirmed) S.pendingSave = true; // a save sent while the tab was hidden never got an answer: send it again
  try { await flushSave(); } catch (e) { /* pending edits are checked below */ }
  if (S.pendingSave) {
    if (!keepDraft()) { toast('Not saved. You stay on this screen until saving works. Try again once you have a connection or storage space.', 10000); return false; }
    toast('Not sent yet. Your draft stays saved on this device.', 6000);
  }
  clearTimeout(S.saveT); S.pendingSave = S.unconfirmed = false; return true;
}
const CONFLICT = 'This was just changed on another screen';
const dataUrl = (asset, stage, v, f) => withP('/data/' + asset + '/' + stage + '/v' + pad3(v) + '/' + encodeURIComponent(f));
const thumbUrl = (asset, stage, v, f) => withP('/api/thumb?asset=' + encodeURIComponent(asset) + '&stage=' + encodeURIComponent(stage) + '&v=' + v + '&file=' + encodeURIComponent(f)); // 480 px WebP from the server's cache
const hhmm = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
export function setInfo() {}
// The floating name tag that follows the pointer over a recognised part.
// 2D parts anchor it to the part's top-left corner; 3D keeps it where the pointer entered the part, so it does not flicker.
function showHover(label, x, y, anchored) {
  const h = $('#hover'); if (!label) { h.hidden = true; h.dataset.k = ''; return; }
  if (!anchored && h.dataset.k === label && !h.hidden) return;
  const c = $('#canvas').getBoundingClientRect(); h.textContent = label; h.dataset.k = label; h.hidden = false;
  h.style.left = Math.max(4, Math.min(c.width - 160, x - c.left + (anchored ? 0 : 14))) + 'px'; h.style.top = Math.max(4, anchored ? y - c.top - 32 : y - c.top + 14) + 'px';
}
const UNSURE = 0.36; // detector score below which a recognised name is shown as a guess ("Post?")
function partName(p) { // a GLB node -> readable part name
  const ex = (p && p.extras) || {}; const role = ex.pf_role, grp = ex.pf_group;
  if (role) { const r = ROLE_NL[role] || role.replace(/_/g, ' '); const g = grp && GROUP_NL[grp] !== undefined ? GROUP_NL[grp] : (grp || ''); return g ? r + ' · ' + g : r; }
  return String((p && p.node) || '?').replace(/[._]\d+$/, '').replace(/[._]/g, ' ');
}
// Short, human name of what a note points at.
function describe(t) { const pg = (t || {}).page; return describeSel(t) + (pg ? ' · page ' + pg : ''); }
function describeSel(t) {
  const s = (t || {}).selector || {}; const fr = s.frame != null ? ' · frame ' + s.frame : '';
  if (s.label) return (s.unsure ? s.label.replace(/( · |$)/, '?') : s.label) + fr;
  if (s.type === 'rect') return 'Box';
  if (s.type === 'polygon') return 'Vorm';
  if (s.type === 'stroke') return 'Drawing' + fr;
  if (s.type === 'sketch') return 'Drawing on ' + ([...new Set((s.parts || []).map(partName))].slice(0, 3).join(', ') || 'model') + fr;
  if (s.type === 'part') return [...new Set(s.parts.map(partName))].join(', ') + fr;
  if (s.type === 'point') return (s.part ? partName(s.part) : 'Point') + fr;
  if (s.type === 'time') {
    const when = s.start_ms != null ? s.start_ms + '–' + s.end_ms + ' ms' : s.frame_start != null ? (s.frame_start === s.frame_end ? 'frame ' + s.frame_start : 'frames ' + s.frame_start + '–' + s.frame_end) : s.start.toFixed(2) + '–' + s.end.toFixed(2) + ' s';
    return (s.parts ? [...new Set(s.parts.map(partName))].join(', ') + ' · ' : s.rect ? (s.stroke ? 'Drawing · ' : 'Box · ') : '') + when;
  }
  if (s.type === 'text') { const q = s.quote.replace(/\*\*|\x60/g, ''); return '"' + q.slice(0, 36) + (q.length > 36 ? '…' : '') + '"'; } // markdown marks are noise in a label
  return 'Whole';
}

// ---------------- data ----------------
function stageInfo(asset, sid) { const st = ((S.cat.assets[asset] || {}).stages || {})[sid]; return st && st.versions.length ? st : null; }
function stageDef() { return S.cat.stages.find(s => s.id === S.stage); }
function verInfo(v = S.v) { const st = stageInfo(S.asset, S.stage); return st ? st.versions[v - 1] : null; }
const isLatest = () => { const st = stageInfo(S.asset, S.stage); return st && S.v === st.versions.length; };
const isFinal = rv => !!(rv && !rv.draft && rv.verdict && rv.verdict !== 'pending');
const locked = () => isFinal(S.review) && !S.editing;
// Work that waits for the reviewer: newest version of a stage without a final review. Oldest first.
// R3C-111 begin
function queue() { return queueBatch(ownerQueue(), S.cat.review_queue); }
// R3C-111 end
function ownerQueue() {
  const q = [];
  if (S.me && S.me.owned_by) return q; // another owner decides in this project: their versions do not wait on the admin
  for (const [id, a] of Object.entries(S.cat.assets)) for (const s of S.cat.stages) {
    const st = stageInfo(id, s.id); if (!st || st.status !== 'in_review') continue;
    const ver = st.versions[st.versions.length - 1]; q.push({ id, a, s, st, ver });
  }
  return q.sort((x, y) => (x.ver.at || '').localeCompare(y.ver.at || ''));
}
// A commenter's own queue: the rows of "New to view" (one per asset, newest first), in this project or another.
const hereId = () => PROJECT || (S.proj || {}).home;
function gqueue() { return HM.newQueue(S.inbox || []).map(i => ({ id: i.asset, s: { id: i.stage }, p: i.p, v: i.v, seen: i.seen })); }
// Opening a version is "bekeken" for this person: one small write of her own status, apart from decision and comments.
function markSeen() {
  if (!S.v) return; const key = it => it.p === hereId() && it.asset === S.asset && it.stage === S.stage && it.v === S.v;
  api('/api/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: S.asset, stage: S.stage, version: S.v }) })
    .then(() => { for (const it of S.inbox || []) if (key(it)) it.seen = true; }).catch(() => { /* the next open tries again */ });
}
async function gstep(d) {
  const q = gqueue(); if (!q.length) { toast('Nothing to view.'); return showHome(); }
  const i = q.findIndex(x => x.id === S.asset && x.p === hereId());
  const todo = q.filter((x, k) => !x.seen && k !== i); // Next goes to the next one not seen yet, Previous simply back
  if (d > 0 && !S.showAll && !todo.length) { toast('All viewed.'); return showHome(); }
  const it = d > 0 && !S.showAll ? q.slice(i + 1).concat(q.slice(0, i + 1)).find(x => !x.seen && x !== q[i]) : q[i < 0 ? (d > 0 ? 0 : q.length - 1) : (i + d + q.length) % q.length];
  if (it.p !== hereId() || !S.cat.assets[it.id]) { location.href = '?p=' + encodeURIComponent(it.p) + '&by=' + encodeURIComponent(REVIEWER) + '#a=' + encodeURIComponent(it.id) + '&s=' + encodeURIComponent(it.s.id) + (it.v ? '&v=' + it.v : ''); return; }
  await pick(it.id, it.s.id, it.v);
}
function mediaCounts(files) {
  const words = { image: ['image', 'images'], model: ['model', 'models'], audio: ['sound', 'sounds'], video: ['video', 'videos'], text: ['text', 'texts'], pdf: ['PDF', 'PDFs'] };
  const other = files.filter(f => !Object.hasOwn(words, f.media)).length;
  return [...Object.entries(words).map(([k, w]) => { const n = files.filter(f => f.media === k).length; return n ? n + ' ' + w[n === 1 ? 0 : 1] : ''; }), other ? other + ' overig' : ''].filter(Boolean).join(' · ');
}
// Connected route segments are shared by the review header and the overview rows.
function routeStages(id) {
  const route = (S.cat.routes || {})[(S.cat.assets[id] || {}).route || 'full'];
  // Assets that started before the research stage existed skip it instead of showing an empty step.
  const legacy = !stageInfo(id, 'research') && S.cat.stages.some(s => stageInfo(id, s.id));
  // Follow the route's own order (story: premise, canon, ... proof, playtest, pack, final), not the global stage list.
  const stageIds = route && route.group === 'social' && stageInfo(id, 'page') && !stageInfo(id, 'post') ? ['page', 'final'] : route && route.stages;
  const defs = route ? stageIds.map(sid => S.cat.stages.find(s => s.id === sid)).filter(Boolean) : S.cat.stages;
  return defs.filter(s => !(legacy && s.id === 'research'));
}
// A commenter never reads agent words: work that is not ready is "In de maak".
const guestWord = (w, status) => CM && CM.guest() ? (['changes', 'rejected', 'gate'].includes(status) ? ['In progress', w[1]] : status === 'in_review' ? ['Waiting for the owner', w[1]] : w) : w;
// Shared wordmark for the viewer header.
const brandMark = () => el('button', { class: 'cd-brand', 'aria-label': 'Kitborne Terminal: go to overview', onclick: () => { S.homeTab = 'today'; showHome(); } },
  el('img', { src: '/terminal-wordmark.svg', alt: '', width: 156, height: 22 }));
function stageRail(id, mini = false) {
  const stages = routeStages(id);
  const description = stages.map(s => (SHORT[s.id] || s.label) + ': ' + (stageInfo(id, s.id)?.stale ? 'Outdated' : guestWord(STATUS[stageInfo(id, s.id)?.status || 'none'], stageInfo(id, s.id)?.status)[0])).join('; ');
  const rail = el('div', { class: 'rail' + (mini ? ' mini' : ''), role: mini ? 'img' : null, 'aria-label': mini ? description : 'Stages of ' + S.cat.assets[id].name }, stages.map(s => {
    const st = stageInfo(id, s.id), status = st ? st.status : 'none', word = st?.stale ? ['Outdated', STATUS.changes[1]] : guestWord(STATUS[status] || STATUS.none, status);
    const label = (SHORT[s.id] || s.label) + ' · ' + word[0] + (st ? ' · v' + st.versions.length : '') + (st?.stale ? ' · ' + st.stale : '');
    return el(mini ? 'span' : 'button', { class: 'rail-stage ' + status + (!mini && s.id === S.stage ? ' cur' : ''), style: { '--c': word[1] },
      title: label, 'aria-label': label, tabindex: mini ? '-1' : null, 'aria-current': !mini && s.id === S.stage ? 'step' : null, onclick: mini ? null : () => pick(id, s.id) },
      el('span', { class: 'track', 'aria-hidden': 'true' }, !mini && status === 'approved' && !st?.stale ? icon('check', 10) : null,
        !mini && status === 'in_review' ? el('i') : null), mini ? null : el('span', { class: 'rail-word' }, SHORT[s.id] || s.label), !mini && st?.stale ? el('span', { class: 'rail-badge' }, 'Outdated') : null);
  }));
  if (!mini) return rail;
  const done = stages.filter(s => stageInfo(id, s.id)?.status === 'approved').length;
  return el('div', { class: 'railwrap' }, rail, el('span', { class: 'rail-count' }, done + '/' + stages.length));
}
function tallThumb(ver) { const f = ver && ver.files.find(f => f.media === 'image'); const s = f && (f.preflight || {}).stats; return !!(s && s.height / s.width >= 1.6); }
function thumbOf(id, sid, ver, full) { // full: the original image, for views where the picture itself is judged
  if (!ver) return null;
  const files = ver.files || [];
  const render = ver.meta?.render; const sheet = render?.status === 'done' && render.previews?.[0]?.sheet;
  if (sheet) return dataUrl(id, sid, ver.v, 'renders/' + render.hash + '/' + sheet);
  const small = f => !full && /\.(png|jpe?g|webp)$/i.test(f) ? thumbUrl(id, sid, ver.v, f) : dataUrl(id, sid, ver.v, f);
  if (ver.thumb) return small(ver.thumb); const img = files.find(f => f.media === 'image'); if (img) return small(img.name);
    const pdf = files.find(f => f.media === 'pdf'); if (pdf && pdf.pages) return dataUrl(id, sid, ver.v, 'pages/' + pdf.name + '/p001.png');
  const glb = files.find(f => /\.glb$/i.test(f.name)); return glb ? dataUrl(id, sid, ver.v, 'renders/' + glb.name + '.turntable.png') : null;
}
function ago(iso, bare) { if (!iso) return ''; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); const n = m < 60 ? m : m < 1440 ? Math.floor(m / 60) : Math.floor(m / 1440); const t = m < 1 ? 'just now' : m < 60 ? n + ' min' : m < 1440 ? n + ' h' : n + (n === 1 ? ' day' : ' days'); return m < 1 || bare ? t : t + ' ago'; }

// ---------------- boot ----------------
// A hidden error becomes a visible message, so a button never seems to do nothing.
const showError = m => { if (m && !/ResizeObserver/.test(m)) toast('Something went wrong: ' + m, 8000); };
addEventListener('unhandledrejection', e => showError(e.reason && e.reason.message || String(e.reason)));
addEventListener('error', e => showError(e.message));
async function boot() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js?v=asset-review-ui-20261005-fix5');
      // Optional files use the worker's empty response when the server has no file yet.
      await Promise.race([navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller || new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))), new Promise(resolve => setTimeout(resolve, 2000))]);
    } catch (e) { /* the viewer also works without installation */ }
  }
  try { S.cat = await api('/api/catalog'); } catch (e) { if (PROJECT) return location.replace(location.pathname); throw e; } // a tab whose project is gone falls back to this server's own
  try { S.info = await api('/api/info'); } catch (e) { S.info = {}; }
  try { S.me = await api('/api/me'); } catch (e) { S.me = null; } // an older server sends no identity: everything stays as it was
  CM = makeComments({ S, el, icon, api, toast, describe, withP, locked, nextMark, changed, flushSave, focusNote, refreshMarks, renderSide, fileNotes, keepDraft, clearDraft, confirmed, dataUrl: f => dataUrl(S.asset, S.stage, S.v, f),
    afterSave: () => {
      const s = $('#saved'); if (s) s.textContent = S.review && S.review.guest ? CM.savedLine() : savedText();
      for (const a of document.querySelectorAll('#sidescroll audio[data-voice]')) {
        const src = (S.cfiles || {})[a.dataset.voice] || dataUrl(S.asset, S.stage, S.v, a.dataset.voice);
        if (a.getAttribute('src') !== src) a.src = src;
      }
    }, focusEditor: () => { const t = $('#sidescroll .note.act textarea'); if (t) t.focus({ preventScroll: true }); } });
  HM = makeHome({ S, el, quickPlay, dataUrl, icon, api, toast, ago, pick, stageInfo, routeStages, thumbOf, tallThumb, SHORT, withP, hasPro, can: w => CM.can(w), guest: () => CM.guest(), project: () => PROJECT, openRequest,
    // R3C-111 begin
    queueCount: (project, total) => projectQueueText(project.review_queue, total),
    // R3C-111 end
    reviewerQuery: () => REVIEWER !== 'Owner' ? '&by=' + encodeURIComponent(REVIEWER) : '', refresh: () => Promise.all([refreshCatalog(), refreshProjects()]), lb: () => LB, openProjects: () => { S.homeTab = 'projects'; showHome(); }, renderInbox: () => S.homeInbox && S.homeInbox(), approveMany: items => approveMany(items),
    bin: ids => binAssets(ids, '', async n => { if (n) await showHome(); }), askReason: (what, pre) => askBinReason(what, pre), reviewer: () => REVIEWER, archive: () => LB.archiveButton() });
  LB = makeLibrary({ S, el, icon, api, toast, ago, withP, hasPro, can: w => CM.can(w), guest: () => CM.guest(), post: HM.post, curId: () => PROJECT || (S.proj || {}).home,
    refresh: () => Promise.all([refreshCatalog(), refreshProjects()]), show: () => showHome(), reviewer: () => REVIEWER });
  TN = makeTuner({ S, el, api, toast, reviewer: () => REVIEWER });
  CT = makeCategory({ S, el, icon, api, toast, postReview, baseRev, thumbOf, tallThumb, SHORT, nice, ago, mediaCounts, dataUrl, queue: ownerQueue, reviewer: () => REVIEWER,
    canDecide: () => !CM.guest() && CM.can('decide'), show: name => showCategory(name), home: () => goHome(), pick: (a, s) => pick(a, s),
    reload: async () => { try { S.cat = await api('/api/catalog'); } catch (e) { /* keep the copy we have */ } }, mount: node => $('#home').replaceChildren(node) });
  S.autoplay = localStorage.getItem('ar-autoplay') !== '0';
  document.title = 'Kitborne Terminal · ' + S.cat.project;
  await refreshProjects();
  document.addEventListener('keydown', onKey);
  new ResizeObserver(() => document.body.style.setProperty('--footer-h', $('#decide').getBoundingClientRect().height + 'px')).observe($('#decide'));
  new ResizeObserver(measureClamps).observe($('#sidescroll'));
  // New deliveries appear without a reload: refresh the catalog when the tab comes back and every 20 s while visible.
  document.addEventListener('visibilitychange', () => { studioPolling(); if (document.hidden) { if (S.pendingSave) postDraft(true).catch(() => {}); } else { refreshCatalog(); refreshProjects(); if (S.unconfirmed && !S.saving && !CM.saving) resend(); } });
  window.addEventListener('pagehide', () => { if (S.pendingSave) postDraft(true).catch(() => {}); });
  setInterval(() => { if (!document.hidden) { refreshCatalog(); refreshProjects(); } }, 20000);
  // remember where the pointer was released, so the comment box opens next to what was pointed at
  $('#canvas').addEventListener('pointerup', e => { S.lastPt = [e.clientX, e.clientY]; }, true);
  document.addEventListener('pointerdown', e => { const m = $('#viewmenu'); if (!m.hidden && !e.target.closest('#viewmenu,[data-menu]')) m.hidden = true;
    const h = $('.heromore[open]'); if (h && !e.target.closest('.heromore')) h.open = false; });
  window.addEventListener('beforeunload', e => { if (S.unconfirmed) { if (!keepDraft()) { e.preventDefault(); e.returnValue = ''; } postDraft(true).catch(() => {}); } });
  // One turn gives the right layout at once: the window resize, the orientation media query and (below) the visual viewport all run the same re-layout.
  const relayout = () => { if (!$('#pop').hidden) placePop(); if (S.view) fitPhone(verInfo().files[S.file].media); if (S.view instanceof AudioView) renderDock(); };
  window.addEventListener('resize', relayout);
  matchMedia('(orientation:landscape)').addEventListener('change', relayout);
  // the comment box's chip lines swipe sideways on a phone: a keyboard-focused chip scrolls into view
  $('#pop').addEventListener('focusin', e => { if (e.target.closest('.reason-chips,.qchips,.pop-f')) e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  // A phone keyboard often shrinks only the visible part of the page (iOS Safari, Chrome): --cd-kb lifts the comment box above it (theme.css).
  if (window.visualViewport) { const vv = visualViewport, kb = () => document.documentElement.style.setProperty('--cd-kb', (vv.scale > 1.05 ? 0 : Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))) + 'px'); vv.addEventListener('resize', () => { kb(); requestAnimationFrame(() => { kb(); if (!$('#pop').hidden) placePop(); }); }); vv.addEventListener('scroll', kb); }
  matchMedia('(max-width:820px)').addEventListener('change', () => { renderBar(); if (S.mode === 'review') renderDecide(); });
  matchMedia('(max-width:820px) and (orientation:portrait)').addEventListener('change', () => { if (S.mode === 'review') renderDecide(); });
  // Browser/Android back: follow the URL like boot does. If leaving a review is refused (unsaved text), put the URL back.
  window.addEventListener('popstate', async () => {
    if (!navReady || location.href === shownUrl) return;
    const was = shownUrl, h = new URLSearchParams(location.hash.slice(1)); popping = true;
    try {
      if (h.get('a') && S.cat.assets[h.get('a')]) await pick(h.get('a'), h.get('s'), h.get('v') ? +h.get('v') : null);
      else if (h.get('choice')) await showChoice(h.get('choice'));
      else if (h.get('cat')) await showCategory(h.get('cat'));
      else { S.nav++; await showHome(); } // back to the overview cancels a pick that is still loading
    } finally { popping = false; }
    if (shownUrl === was && location.href !== was) history.pushState(/#(a|choice|cat)=/.test(was) ? { cd: 'from-home' } : null, '', was);
  });
  const hash = new URLSearchParams(location.hash.slice(1));
  if (['library', 'projects', 'archived', 'social', 'tuner'].includes(hash.get('tab'))) S.homeTab = hash.get('tab') === 'archived' ? 'projects' : hash.get('tab'); // tab=archived is the old name
  if (hash.get('a') && S.cat.assets[hash.get('a')]) await pick(hash.get('a'), hash.get('s'), hash.get('v') ? +hash.get('v') : null);
  else if (hash.get('choice')) await showChoice(hash.get('choice'));
  else if (hash.get('cat')) await showCategory(hash.get('cat'));
  else { await showHome(); if (hasPro() && hash.get('request')) await openRequest(hash.get('request')); }
  navReady = true;
}

// R3F-004 begin
// Location only: draft recovery and review/comment writes keep their existing paths.
const resumePrefix = 'ar.location1.';
const resumeLimit = 16384;
let resumeBusy = true, resumePending = null, resumeExact = null, resumeTimer, resumeWarned = false;
const resumeWho = () => JSON.stringify([S.me?.person || REVIEWER, REVIEWER]);
const resumeLast = () => resumePrefix + 'last.' + resumeWho();
const resumeText = x => typeof x === 'string' && x.length > 0 && x.length <= 512;
const resumeNumber = x => Number.isFinite(x) && Math.abs(x) <= 1e9;
const resumeHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const resumeBinding = f => ({ name: f.name, bytes: Number.isSafeInteger(f.bytes) && f.bytes >= 0 ? f.bytes : null, at: resumeText(verInfo()?.at) ? verInfo().at : null });
const resumeBound = (b, file) => b && b.name === file && (b.bytes === null || Number.isSafeInteger(b.bytes) && b.bytes >= 0) && (b.at === null || resumeText(b.at));
function resumeWarning(message) { toast(message || 'The saved view position is invalid. Choose a version from the overview.', 8000); }
function resumeForget() { try { localStorage.removeItem(resumeLast()); } catch (e) { /* storage may be unavailable */ } }
function resumeCaptureWarning(message) { resumeForget(); if (!resumeWarned) { resumeWarned = true; resumeWarning(message || 'The view position could not be saved on this device.'); } }
function resumeRead(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  if (raw.length > resumeLimit) throw new Error('location size');
  return JSON.parse(raw);
}
function resumeValid(r) {
  const v = r?.view, c = v?.camera, range = r?.range;
  return r?.schema === 1 && r.who === resumeWho() && [r.project, r.asset, r.stage, r.file].every(resumeText) &&
    Number.isSafeInteger(r.version) && r.version > 0 && (resumeHash(r.hash) || r.hash === null && resumeBound(r.binding, r.file)) &&
    (r.binding == null || resumeBound(r.binding, r.file)) &&
    (r.note === null || resumeText(r.note)) && v && typeof v === 'object' && !Array.isArray(v) &&
    (c == null || [c.position, c.target].every(a => Array.isArray(a) && a.length === 3 && a.every(resumeNumber)) &&
      resumeNumber(c.fov) && c.fov > 0 && c.fov < 180 && ['perspective', 'orthographic'].includes(c.projection) &&
      resumeNumber(c.zoom) && c.zoom > 0 && (c.orthoHeight == null || resumeNumber(c.orthoHeight) && c.orthoHeight > 0)) &&
    (v.time == null || resumeNumber(v.time) && v.time >= 0) &&
    (v.rotation == null || resumeNumber(v.rotation)) &&
    (v.pdfPage == null || Number.isSafeInteger(v.pdfPage) && v.pdfPage > 0) &&
    (v.clip == null || v.clip === 'all' || Number.isSafeInteger(v.clip) && v.clip >= 0) &&
    (v.inspection == null || ['material', 'wire', 'clay', 'normals', 'uv', 'bones'].includes(v.inspection)) &&
    (v.flags == null || typeof v.flags === 'object' && !Array.isArray(v.flags) && Object.values(v.flags).every(x => typeof x === 'boolean')) &&
    (range === null || Array.isArray(range) && range.length === 2 && range.every(x => x === null || resumeNumber(x) && x >= 0));
}
function resumeTarget(r) {
  const st = stageInfo(r.asset, r.stage), ver = st?.versions[r.version - 1];
  return S.cat.stages.some(s => s.id === r.stage) && ver?.v === r.version ? ver.files.findIndex(f => f.name === r.file) : -1;
}
function resumeFileHash(V) {
  if (V instanceof ModelView) {
    if (!resumeHash(V.assetHash)) throw new Error('loaded model hash unavailable');
    return V.assetHash; // ModelView already hashes its loaded bytes; never download them again.
  }
  return [V.file.source_hash, V.file.sha256, V.file.hash].find(resumeHash) || null;
}
function storeViewerLocation() {
  const V = S.view;
  if (resumeBusy || S.mode !== 'review' || !S.cat || !V || V.dead || !V.locationReady) return;
  const f = verInfo()?.files[S.file]; if (!f) return;
  try {
    const precise = resumeHash(V.locationHash), source = precise ? V.viewState?.() || {} : {}, view = {};
    for (const k of ['camera', 'inspection', 'flags', 'rotation', 'clip', 'time', 'pdfPage']) if (source[k] != null) view[k] = source[k];
    if (precise && V instanceof VideoView) view.time = V.v.currentTime;
    const r = { schema: 1, who: resumeWho(), project: hereId(), asset: S.asset, stage: S.stage, version: S.v,
      file: f.name, hash: V.locationHash, binding: resumeBinding(f), note: precise ? S.active || null : null, view,
      range: precise && (V instanceof VideoView || V instanceof ModelView) ? [V.inp ?? null, V.out ?? null] : null };
    const raw = JSON.stringify(r); if (raw.length > resumeLimit || !resumeValid(r)) throw new Error('invalid location');
    localStorage.setItem(resumeLast(), raw); // one atomic, reviewer-scoped location, bound to its project
  } catch (e) { resumeCaptureWarning(); }
}
function queueViewerLocation() { clearTimeout(resumeTimer); resumeTimer = setTimeout(storeViewerLocation, 150); }
const resumeMount = mountViews;
mountViews = async function (...args) {
  const r = resumePending;
  if (resumeExact && (S.asset !== resumeExact.asset || S.stage !== resumeExact.stage || S.v !== resumeExact.version || verInfo()?.v !== resumeExact.version)) {
    S.nav++; await showHome(); resumeWarning(); return;
  }
  if (r) {
    const index = resumeTarget(r);
    if (S.asset !== r.asset || S.stage !== r.stage || S.v !== r.version || index < 0) {
      S.nav++; await showHome(); resumeWarning(); return;
    }
    S.file = index;
  }
  await resumeMount(...args);
  const V = S.view; if (!V || V.dead) return;
  if (r) { V.playing = false; V.v?.pause(); }
  try { V.locationHash = resumeFileHash(V); V.locationReady = true; }
  catch (e) {
    if (S.view === V && !V.dead) { if (r) { S.nav++; await showHome(); } resumeCaptureWarning('The view position could not be saved on this device: the file could not be checked safely.'); }
    return;
  }
  if (S.view !== V || V.dead) return;
  if (r) {
    const binding = resumeBinding(V.file);
    if ((V instanceof ModelView || r.hash !== null) && V.locationHash !== r.hash || r.binding && ['name', 'bytes', 'at'].some(k => r.binding[k] !== binding[k])) {
      S.nav++; await showHome(); resumeWarning('The saved file has changed. Choose a version from the overview.'); return;
    }
    // A metadata binding identifies the version/file, not content anchors.
    if (r.hash !== null) {
      if ((V instanceof ModelView && (!r.view.camera || V.mixer && r.view.time == null)) ||
        (V instanceof VideoView && r.view.time == null) || (V instanceof PdfView && !r.view.pdfPage) ||
        (r.view.time != null && r.view.time > (V.v?.duration ?? V.duration ?? Infinity)) ||
        r.range?.some(t => t !== null && t > (V.v?.duration ?? V.duration ?? Infinity)) ||
        (r.view.pdfPage && r.view.pdfPage > V.N) || (typeof r.view.clip === 'number' && r.view.clip >= (V.clips?.length || 0))) {
        S.nav++; await showHome(); resumeWarning('The saved file has changed or the view position no longer exists. Choose a version from the overview.'); return;
      }
      const note = S.review.notes.find(n => n.id === r.note && ((n.target || {}).file || verInfo().files[0].name) === r.file);
      const origin = note?.view?.asset;
      if (note && (!origin || origin.id === r.asset && origin.stage === r.stage && origin.version === r.version && (!origin.hash || origin.hash === r.hash))) await focusNote(note);
      else { S.active = null; if (r.note) resumeWarning('The saved note no longer exists. The version was restored.'); }
      // Restore the current view after note focus: the camera/playhead may have moved since opening the note.
      if (V instanceof ModelView || V instanceof PdfView) await V.focus({ id: S.active, view: r.view, target: { selector: {} } });
      if (V instanceof VideoView && r.view.time != null) {
        await V.focus({ target: { selector: { type: 'time', at: r.view.time, start: r.range?.[0] ?? r.view.time, end: r.range?.[1] ?? r.view.time } } });
        await V.seek(r.view.time); // Note focus restores the range start; the saved playhead can be elsewhere.
      }
      if (r.range) { [V.inp, V.out] = r.range; V.syncTl?.(); }
    }
    refreshMarks(); renderSide();
  }
  V.controls?.addEventListener('change', queueViewerLocation);
  V.v?.addEventListener('timeupdate', queueViewerLocation);
  queueViewerLocation();
};
const resumeLeave = leaveReview;
leaveReview = async function (...args) { storeViewerLocation(); return resumeLeave(...args); };
const resumePick = pick;
pick = async function (asset, stage, version) {
  const exact = resumeExact = version == null ? null : { asset, stage, version };
  try {
    const known = () => stageInfo(asset, stage)?.versions.some(v => v.v === version);
    // a link to a version submitted after this tab loaded its catalog (same-tab hash change): reload the catalog once
    if (exact && Number.isSafeInteger(version) && !known()) { try { S.cat = await api('/api/catalog'); } catch (e) { /* keep the copy we have */ } }
    if (exact && (!Number.isSafeInteger(version) || version < 1 || !known())) {
      await showHome(); resumeWarning(); return;
    }
    await resumePick(asset, stage, version);
  } finally { if (resumeExact === exact) resumeExact = null; }
};
const resumeShowFile = showFile;
showFile = async function (...args) { storeViewerLocation(); await resumeShowFile(...args); storeViewerLocation(); };
const resumeFocusNote = focusNote;
focusNote = async function (...args) { await resumeFocusNote(...args); storeViewerLocation(); };
const resumeBoot = boot;
boot = async function () {
  const selection = !!location.hash, explicit = new URLSearchParams(location.search).has('p') || selection;
  let transfer;
  try { transfer = resumeReadSession(); } catch (e) { /* unavailable session storage: stay in the selected project */ }
  await resumeBoot();
  try {
    if (selection || explicit && transfer !== location.pathname + location.search) return;
    const r = resumeRead(resumeLast()); if (r === null) return;
    if (!resumeValid(r)) throw new Error('invalid location');
    if (r.project !== hereId()) {
      if (!S.proj?.projects.some(p => p.id === r.project)) throw new Error('missing project');
      const url = new URL(location.href); url.searchParams.set('p', r.project); url.hash = '';
      sessionStorage.setItem(resumePrefix + 'transfer', url.pathname + url.search);
      location.replace(url.href); return new Promise(() => {}); // boot finishes in the destination project
    }
    const index = resumeTarget(r); if (index < 0) throw new Error('missing target');
    resumePending = r; await pick(r.asset, r.stage, r.version);
  } catch (e) { resumeForget(); await showHome(); resumeWarning(); }
  finally { resumePending = null; resumeBusy = false; }
};
function resumeReadSession() { const key = resumePrefix + 'transfer', raw = sessionStorage.getItem(key); sessionStorage.removeItem(key); return raw; }
for (const name of ['pointerup', 'keyup', 'change']) document.addEventListener(name, queueViewerLocation);
addEventListener('pagehide', storeViewerLocation);
addEventListener('beforeunload', storeViewerLocation);
document.addEventListener('visibilitychange', () => { if (document.hidden) storeViewerLocation(); });
// R3F-004 end

// ---------------- home ----------------
async function refreshProjects() {
  let pr; try { pr = await api('/api/projects'); } catch (e) { return; }
  await HM.refreshSocial();
  const inb = await HM.fetchInbox(); const fresh = inb && JSON.stringify(inb) !== JSON.stringify(S.inbox);
  if (fresh) { S.inbox = inb; if (S.mode === 'home' && S.homeInbox) S.homeInbox(); }
  if (HM.sw && HM.sw.isConnected && HM.sw.isOpen()) return; // never close the open project menu; a later poll paints
  const key = p => JSON.stringify(((p || {}).projects || []).map(x => [x.id, x.project, x.role, x.waiting, x.agent && [x.agent.state, x.agent.open, x.agent.todo, x.agent.live.map(t => t.id), x.agent.threads.map(t => t.id + ':' + t.state)]]).concat((p || {}).home));
  if (!fresh && key(pr) === key(S.proj)) { S.proj = pr; return; } // the switcher counts new work from the inbox too; times alone repaint nothing
  S.proj = pr; renderBar(); HM.paintAgent(); if (LB.repaint) LB.repaint();
}
async function refreshCatalog() {
  if (S.mode === 'review' && S.review && S.review.guest) await CM.refresh(); // a commenter sees what the owner did with her comments, also through Vernieuwen
  let cat; try { cat = await api('/api/catalog'); } catch (e) { return; }
  if (JSON.stringify(cat) === JSON.stringify(S.cat)) return;
  const was = S.mode === 'review' && stageInfo(S.asset, S.stage); const n0 = was ? was.versions.length : 0; const cm0 = S.mode === 'review' ? JSON.stringify((verInfo() || {}).comments || null) : null;
  const render0 = S.mode === 'review' ? JSON.stringify(verInfo()?.meta?.render || null) : null; S.cat = cat;
  if (S.mode === 'home') return S.homeTab === 'social' || (S.homeTab && S.homeTab !== 'today' && LB.tabs()) ? null : $('#hsearch') === document.activeElement && S.hproj ? S.hproj.repaint() : showHome();
  if (S.mode === 'choice') return showChoice(S.choice.g, true);
  if (S.mode === 'category') return CT.repaint();
  const now = S.mode === 'review' && stageInfo(S.asset, S.stage);
  if (now && now.versions.length > n0) toast('There is a new version of this stage.', 8000, ['View', () => pick(S.asset, S.stage)]);
  renderBar(); renderSteps();
  if (S.mode === 'review' && render0 !== JSON.stringify(verInfo()?.meta?.render || null)) {
    const preview = $('#sidescroll .render-preview'); const next = rendersSection();
    if (preview && next) preview.replaceWith(next); else renderSide();
  }
  if (S.mode === 'review' && S.fbShown !== JSON.stringify((verInfo() || {}).feedback || null)) renderDecide();
  if (S.mode === 'review' && S.review && !S.review.guest && cm0 !== JSON.stringify((verInfo() || {}).comments || null) && !$('#pop:not([hidden])') && !$('#sidescroll textarea:focus')) { await CM.load(); refreshMarks(); renderSide(); }
}
async function checkNow() {
  await Promise.all([refreshCatalog(), refreshProjects()]); const n = queue().length;
  toast('Updated: ' + (n ? n + (n === 1 ? ' version is' : ' versions are') + ' waiting for you.' : 'nothing is waiting for you.'), 4000);
}
// A project without assets yet: agents get the submit command, an owner gets a clear first step, a commenter just sees it is empty.
function emptyProject(guest) {
  if (guest) return el('p', { class: 'sub' }, 'Nothing to see in this project yet.');
  if (!hasPro()) return el('div', { class: 'empty-own' }, el('h2', {}, 'No versions to review'),
    el('p', { class: 'sub' }, 'Submit a version with the Terminal CLI. It will appear here when it is ready to review.'));
  if (CM.can('execute')) return el('p', { class: 'sub' }, 'No assets yet. Agents submit with: python review.py submit --asset <id> --stage concept --file <file>');
  return el('div', { class: 'empty-own' }, el('h2', {}, 'No versions to review'),
    el('p', { class: 'sub' }, 'Start new work or ask your agent to submit a version. Submitted versions appear here for review.'),
    el('button', { class: 'primary big', onclick: newStudio }, '+ New work'));
}
// Browser history: opening a review or choice from the overview adds one entry, so back returns to the overview.
// Moves inside a screen (version, stage, asset) replace the entry; state.cd marks an entry that was opened from the overview.
let navReady = false, popping = false, shownUrl = location.href;
function goUrl(url, fromHome) {
  const push = fromHome && navReady && !popping;
  history[push ? 'pushState' : 'replaceState'](push ? { cd: 'from-home' } : history.state, '', url);
  shownUrl = location.href;
}
const leaveHome = () => { S.homeScroll = [scrollY, $('#home').scrollTop]; }; // phone scrolls the window, desktop scrolls #home
function restoreHomeScroll() { const s = S.homeScroll; S.homeScroll = null; if (s) { scrollTo(0, s[0]); $('#home').scrollTop = s[1]; } }
const goHome = () => history.state?.cd === 'from-home' ? history.back() : showHome();
function homeTabs() {
  const tabs = LB.tabs() || el('div', { class: 'htabs', role: 'tablist', 'aria-label': 'Sections' },
    el('button', { class: 'htab', role: 'tab', 'data-tab': 'today', 'aria-selected': String(S.homeTab !== 'social'), onclick: () => { S.homeTab = 'today'; showHome(); } }, 'Today'));
  const social = el('button', { class: 'htab', role: 'tab', 'data-tab': 'social', 'aria-selected': String(S.homeTab === 'social'), onclick: () => { S.homeTab = 'social'; showHome(); } }, 'Social');
  if (S.socialN) social.append(el('span', { class: 'n' }, S.socialN));
  tabs.insertBefore(social, tabs.children[1] || null); return tabs;
}
async function showHome() {
  if (!await leaveReview()) return; destroyViews(); closeComposer(); S.mode = 'home'; if (S.choiceRO) { S.choiceRO.disconnect(); S.choiceRO = null; } S.asset = null; document.body.className = 'home';
  studioPolling();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  shownUrl = location.href;
  renderBar();
  if (CM.can('decide') && S.tunerFor !== (PROJECT || '')) { S.tunerFor = PROJECT || ''; await TN.load(); }
  if (S.homeTab === 'tuner' && LB.tabs() && S.tuner && S.tuner.enabled) {
    S.homeInbox = null; S.hproj = null; $('#home').replaceChildren(el('div', { class: 'wrap tunerwrap' }, homeTabs(), TN.view())); return;
  }
  if (S.homeTab === 'social') {
    S.homeInbox = null; S.hproj = null; $('#home').replaceChildren(el('div', { class: 'wrap' }, homeTabs(), HM.socialView())); return;
  }
  if (LB.tabs() && (S.homeTab === 'library' || S.homeTab === 'projects')) { // owner-only tabs next to Today; they keep their own state, so catalog refreshes leave them alone
    S.homeInbox = null; S.hproj = null; $('#home').replaceChildren(el('div', { class: 'wrap' }, homeTabs(), S.homeTab === 'library' ? LB.libraryView() : LB.projectsView())); return;
  }
  const q = queue(); const ids = Object.keys(S.cat.assets); const guest = CM.guest();
  const groups = CM.guest() ? {} : choiceGroups(); const inGroup = new Set(Object.values(groups).flat().map(it => it.id + '|' + it.s.id));
  const ccards = Object.entries(groups).map(([g, its]) => el('div', { class: 'cardwrap wide' }, el('button', { class: 'card ccard', onclick: () => showChoice(g) },
    textChoice(its) ? el('div', { class: 'cqs' }, its.map((it, i) => el('div', { class: 'cq' }, el('b', {}, String.fromCharCode(65 + i)), it.a.name)))
      : el('div', { class: 'cmosaic' }, its.slice(0, 4).map(it => { const u = optUrl(it); return el('div', { class: 'cth' + (tallThumb(it.ver) ? ' page-thumb' : ''), style: u ? { backgroundImage: 'url("' + u + '")' } : {} }); })),
    el('div', { class: 'cbody' }, el('div', { class: 'ct' }, 'Pick 1 of ' + its.length + ': ' + choiceTitle(g)), textChoice(its) ? null : el('div', { class: 'cm' }, its.map(it => it.a.name).join(' · '))))));
  $('#home').replaceChildren(el('div', { class: 'wrap today-wrap' }, homeTabs(),
    el('div', { class: 'hero' }, el('div', {},
        el('h1', {}, 'Today'),
        el('p', { class: 'sub', id: 'herosub' }, '')),
      el('div', { class: 'heroact' },
        !q.length ? (guest ? null : el('span', { id: 'herocta' })) : el('button', { class: 'primary big', onclick: () => pick(q[0].id, q[0].s.id) }, guest ? 'Start viewing' : 'Start reviewing', icon('next')),
        heroMore(
        // R3C-111 begin
        CM.can('decide') && !guest ? queueSettings({ el, api, toast, state: S.cat.review_queue, saved: async state => { S.cat.review_queue = state; await showHome(); } }) : null,
        // R3C-111 end
        !hasPro() || guest || (!ids.length && !CM.can('execute')) ? null : el('button', { class: 'ghost', onclick: newStudio }, '+ New work'),
        !hasPro() || !CM.can('execute') ? null : el('button', { class: 'ghost', title: 'The agents improve their open assets and submit new versions', onclick: startRound }, icon('send', 15), 'Improvement round')))),
    el('div', { id: 'hinbox' }),
    guest ? null : CT.strip(ownerQueue()),
    // R3C-111 begin
    ccards.length ? [el('h2', { class: 'queuehead' }, 'Pick one'), el('div', { class: 'cards' }, ccards)] : null, // plain versions sit in the "Waiting for you" rows above
    // R3C-111 end
    hasPro() ? [el('div', { id: 'hstuck' }), el('section', { id: 'studio', hidden: true })] : null,
    ids.length ? (S.hproj = HM.projectView()) : [(HM.agentBox = hasPro() ? el('div', { class: 'hagent' }) : null), emptyProject(guest)]));
  S.homeInbox = () => {
    // R3C-111 begin
    if (S.mode !== 'home') return; const c = HM.counts(guest ? q.length : waitingTotal(), S.inbox); const sub = $('#herosub'); if (sub) { sub.textContent = ids.length || CM.can('execute') || c.wait ? HM.line(c) : ''; sub.hidden = !sub.textContent; }
    // R3C-111 end
    const cta = $('#herocta'), first = cta && (S.inbox || []).filter(i => i.kind === 'waiting').sort((a, b) => a.rank - b.rank)[0]; // nothing waits here, something does elsewhere
    if (first) cta.replaceChildren(el('button', { class: 'primary big', onclick: () => { location.href = HM.queueHref(first); } }, 'Start reviewing', icon('next'))); else if (cta) cta.replaceChildren();
    const box = $('#hinbox'); if (box) box.replaceChildren(HM.inbox(S.inbox, 'top'), guest ? HM.mineView() : null);
    const st = $('#hstuck'); if (st) st.replaceChildren(HM.inbox(S.inbox, 'stuck'));
  };
  S.homeInbox(); if (!ids.length) HM.paintAgent(); if (hasPro()) refreshStudio(); LB.countArchived();
  restoreHomeScroll();
  HM.fetchInbox().then(items => { if (items) S.inbox = items; if (S.mode === 'home') S.homeInbox(); });
}

let studioTimer = null;
function studioPolling() {
  clearInterval(studioTimer); studioTimer = null;
  if (hasPro() && S.mode === 'home' && !document.hidden) studioTimer = setInterval(refreshStudio, 5000);
}
async function openRequest(asset) {
  if (!hasPro()) return;
  if (S.mode !== 'home') await showHome();
  await refreshStudio();
  const card = [...document.querySelectorAll('#studio [data-request]')].find(e => e.dataset.request === asset);
  if (!card) return toast('This request is no longer available.', 5000);
  document.querySelectorAll('#studio .request-focus').forEach(e => e.classList.remove('request-focus'));
  card.classList.add('request-focus'); card.focus({ preventScroll: true }); card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  history.replaceState(null, '', '#request=' + encodeURIComponent(asset));
}
const { newStudio, refreshStudio } = makeStudio({ S, el, api, toast, $, withP, hasPro, refPicker, micButton, reviewer: () => REVIEWER, can: w => CM.can(w), guest: () => CM.guest() });

// ---------------- choice: several options for one question (styles, variants) -> pick 1, compare two with a slider ----------------
// Today keeps the start button in view; the other project actions open under More, settings last.
function heroMore(settings, ...acts) {
  const kids = [...acts, settings].filter(Boolean); if (!kids.length) return null;
  return el('details', { class: 'heromore' }, el('summary', {}, 'More'),
    el('div', { class: 'heromore-panel', onclick: e => { if (e.target.closest('button:not([type=submit])')) e.currentTarget.parentElement.open = false; } }, kids));
}
// Verbeterronde: every agent of this project improves its open assets on its own and submits new versions; approved parts stay locked.
async function startRound() {
  if (!hasPro()) return;
  let plan; try { plan = await api('/api/round'); } catch (e) { return toast('Could not prepare the improvement round: ' + e.message, 7000); }
  if (plan.running) return toast('An improvement round is already running (started at ' + plan.running.slice(11, 16) + ').', 5000);
  if (!plan.threads) return toast('There are no open assets with an agent to improve.', 5000);
  const note = el('textarea', { class: 'sum', rows: '3', placeholder: 'What should they pay attention to? (optional)' });
  const go = el('button', { class: 'primary', onclick: async () => {
    if (go.getAttribute('aria-busy') === 'true') return; go.setAttribute('aria-busy', 'true');
    try {
      const r = await fetch(withP('/api/round'), { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note.value, by: REVIEWER }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || r.status);
      d.close(); toast('Improvement round started: ' + j.threads + (j.threads === 1 ? ' agent' : ' agents') + ' at work. New versions appear here automatically.', 8000);
    } catch (e) { go.removeAttribute('aria-busy'); toast('Could not start: ' + e.message, 7000); }
  } }, icon('send', 15), 'Start improvement round');
  const d = el('dialog', { class: 'rounddlg' }, el('h2', {}, 'Improvement round'),
    el('p', {}, plan.threads + (plan.threads === 1 ? ' agent improves ' : ' agents improve ') + plan.assets + (plan.assets === 1 ? ' open asset' : ' open assets') + ' and ' + (plan.threads === 1 ? 'submits' : 'submit') + ' new versions.'),
    el('p', { class: 'muted sm' }, 'Approved parts stay locked. No credits, purchases or publishing.' + (plan.orphan ? ' ' + plan.orphan + ' without an agent are skipped.' : '')),
    note, el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Cancel'), el('span', { class: 'grow' }), go));
  d.onclick = e => { const b = d.getBoundingClientRect(); if (e.target === d && (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)) d.close(); };
  d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); note.focus();
}

// Speelveld scale: Roblox's guide models in studs (1 source unit = 1 stud); metre models use 1 stud = 0.28 m. Remembered per browser.
const fieldUnits = () => localStorage.getItem('ar-units') === 'm' ? 'm' : 'stud';
const unitLabel = () => 'Model in ' + (fieldUnits() === 'm' ? 'metres' : 'studs') + ' (switch)';
// Try in Roblox: the agent of this asset puts the model in its own test place in Studio and submits screenshots as stage In-engine.
async function tryInEngine(file) {
  if (!hasPro()) return;
  const q = '?asset=' + encodeURIComponent(S.asset) + '&stage=' + S.stage + '&v=' + S.v;
  let st; try { st = await api('/api/engine' + q); } catch (e) { return toast('Could not prepare: ' + e.message, 7000); }
  if (!st.thread) return toast('This asset has no linked agent. Ask an agent to put it in Studio.', 7000);
  if (st.running) return toast('This asset is already queued for Studio (requested at ' + st.running.slice(11, 16) + ').', 6000);
  const note = el('textarea', { class: 'sum', rows: '3', placeholder: 'What should it check? For example: next to a tank, in the shade, driving (optional)' });
  const go = el('button', { class: 'primary', onclick: async () => {
    if (go.getAttribute('aria-busy') === 'true') return; go.setAttribute('aria-busy', 'true');
    try {
      const r = await fetch(withP('/api/engine'), { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: S.asset, stage: S.stage, v: S.v, file, note: note.value, by: REVIEWER }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error || r.status);
      d.close(); toast('Requested: the agent puts ' + file + ' in Studio. The screenshots appear under In-engine.', 8000);
    } catch (e) { go.removeAttribute('aria-busy'); toast('Request failed: ' + e.message, 7000); }
  } }, icon('send', 15), 'Put in Studio');
  const d = el('dialog', { class: 'rounddlg' }, el('h2', {}, 'Try in Roblox Studio'),
    el('p', {}, 'The agent puts ' + file + ' in its own test place, next to a player and in Roblox lighting. The screenshots come back as the In-engine stage for review.'),
    el('p', { class: 'muted sm' }, 'Your real game place is not touched. Nothing is published.'),
    note, el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Cancel'), el('span', { class: 'grow' }), go));
  d.onclick = e => { const b = d.getBoundingClientRect(); if (e.target === d && (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom)) d.close(); };
  d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); note.focus();
}

// Agents group options with submit --choice <group>. Only options that still wait for you count; a group needs at least two.
function choiceGroups() {
  const g = {}; for (const it of queue()) { const c = it.a.choice; if (c) (g[c] = g[c] || []).push(it); }
  for (const k of Object.keys(g)) if (g[k].length < 2) delete g[k];
  // Stable A/B/C letters: order by asset id, so a new version of one option does not re-letter the others.
  for (const its of Object.values(g)) its.sort((x, y) => x.id.localeCompare(y.id));
  return g;
}
const afterChoiceBin = g => async n => { if (!n) return; S.choice = null; return choiceGroups()[g] ? showChoice(g) : showHome(); };
const choiceTitle = g => g.replace(/[-_]+/g, ' ');
const optUrl = it => thumbOf(it.id, it.s.id, it.ver);
// Open questions arrive as text options: show the explanation on big cards instead of an empty image compare.
const textChoice = its => its.every(it => it.ver.files.length && it.ver.files.every(f => f.media === 'text'));
async function showChoice(g, keep) {
  if (!await leaveReview()) return;
  const fromHome = S.mode === 'home'; if (fromHome) leaveHome();
  destroyViews(); closeComposer();
  const its = choiceGroups()[g] || [];
  if (its.length < 2) { toast('This choice is no longer waiting for you.'); return showHome(); }
  S.mode = 'choice'; S.asset = null; document.body.className = 'home';
  studioPolling();
  goUrl(location.pathname + location.search + '#choice=' + encodeURIComponent(g), fromHome);
  // Default: every option big, side by side; the slider compares two of them on request.
  const C = S.choice = keep && S.choice && S.choice.g === g ? S.choice : { g, sel: null, a: 0, b: 1, mode: 'wipe', pos: 0.5, text: '', view: its.length > 2 ? 'grid' : 'slider' };
  for (const k of ['a', 'b']) if (C[k] >= its.length) C[k] = k === 'a' ? 0 : 1;
  if (C.sel != null && C.sel >= its.length) C.sel = null;
  renderBar();
  const txt = el('textarea', { class: 'sum', rows: '2', placeholder: 'Note on your choice (optional; required for "change" and "none of these")', value: C.text, oninput: e => { C.text = e.target.value; upd(); } });
  const bPick = el('button', { class: 'primary green big', onclick: () => decideChoice(g, 'pick') }, icon('check'), C.sel == null ? 'First click the option you choose' : 'Choose ' + its[C.sel].a.name);
  const bMix = el('button', { class: 'ghost amber', title: 'This option, but the agent changes it based on your note', onclick: () => decideChoice(g, 'mix') }, icon('send', 15), 'This one, with changes');
  const bNone = el('button', { class: 'ghost red', title: 'Reject all; the agent makes new options based on your note', onclick: () => decideChoice(g, 'none') }, icon('x', 15), 'None of these');
  const bBin = CM.guest() ? null : el('button', { class: 'ghost red', 'data-bin': '1', title: 'Discard all ' + its.length + ' options: they go to the archive and the agent makes no new ones', onclick: () => binAssets(its.map(x => x.id), C.text.trim(), afterChoiceBin(g)) }, icon('trash', 15), 'Discard all');
  // Change and None of these stay clickable: without the needed choice or text they say what is missing instead of being dead grey.
  const upd = () => { bPick.setAttribute('aria-disabled', String(C.sel == null)); };
  upd();
  const L = i => String.fromCharCode(65 + i);
  const textOnly = textChoice(its); C.md = C.md || {};
  const sound = it => it.ver.files.find(f => f.media === 'audio');
  const audioOnly = !textOnly && its.every(sound); // voices and sounds: listen per option; the image slider has nothing to compare
  const mdBody = it => { const f = it.ver.files[0], url = dataUrl(it.id, it.s.id, it.ver.v, f.name), k = it.id + '/' + it.ver.v + '/' + f.name, box = el('div', { class: 'tqbody' });
    const show = t => { const tv = new TextView(box, url, f, {}); tv.raw = !tv.isMd; tv.txt = t; tv.div = el('div', { class: 'textview' });
      box.replaceChildren(...(/^\s*#/.test(t) ? [] : [el('div', { class: 'ct' }, it.a.name)]), tv.div); tv.render(); };
    if (C.md[k] != null) show(C.md[k]); // cached: picking a card re-renders without a flash
    else { box.append(el('div', { class: 'ct' }, it.a.name)); fetch(url).then(r => r.ok ? r.text() : Promise.reject(r.status)).then(t => { C.md[k] = t; show(t); }, () => box.append(el('p', { class: 'muted' }, 'Could not load the text.'))); }
    return box; };
  const opt = (it, i) => { const on = C.sel === i; const u = optUrl(it); const big = C.view === 'grid' || textOnly || audioOnly; const au = sound(it);
    return el('div', { class: big ? 'tile' : 'opt' },
      el('button', { class: textOnly || audioOnly ? 'tpick tq' : big ? 'tpick' : 'card', 'aria-pressed': String(on), 'data-l': L(i), title: on ? 'Chosen (click again to clear)' : 'Choose this option', onclick: () => { C.sel = on ? null : i; showChoice(g, true); } },
        textOnly ? mdBody(it) : audioOnly ? el('div', { class: 'tqbody' }, el('div', { class: 'ct' }, it.a.name), it.ver.note ? el('p', { class: 'muted' }, it.ver.note) : null)
          : big ? (u ? el('img', { src: u, alt: it.a.name }) : el('span', { class: 'tph' }, MEDIA[it.ver.files[0].media] || 'File'))
          : el('div', { class: 'cth' + (tallThumb(it.ver) ? ' page-thumb' : ''), style: u ? { backgroundImage: 'url("' + u + '")' } : {} }, u ? null : el('span', {}, MEDIA[it.ver.files[0].media] || 'File')),
        textOnly || audioOnly ? null : el('div', { class: 'cbody' }, el('div', { class: 'ct' }, el('span', { class: 'radio' }, on ? icon('check', 13) : null), L(i) + '. ' + it.a.name),
          it.ver.note ? el('div', { class: 'cm clamp' }, it.ver.note) : null)),
      el('div', { class: 'optbar' },
        au ? el('audio', { class: 'optaudio', controls: true, preload: 'metadata', src: dataUrl(it.id, it.s.id, it.ver.v, au.name), 'aria-label': 'Listen to ' + L(i) + '. ' + it.a.name }) : null,
        big && u ? el('button', { class: 'link', title: 'View full size', onclick: () => lightbox(u) }, 'Large') : null,
        el('button', { class: 'link', title: 'Open this option to point at something', onclick: () => pick(it.id, it.s.id) }, 'Point…'),
        CM.guest() ? null : el('button', { class: 'ghost sm red optbin', title: 'Discard this option: it goes to the archive and the agent does not make it again', onclick: () => binAssets([it.id], C.text.trim(), afterChoiceBin(g)) }, icon('trash', 14), 'Discard')));
  };
  // Which two options the slider shows: one letter row per side.
  const sides = its.length > 2 ? el('div', { class: 'srow' }, [['a', 'Left'], ['b', 'Right']].map(([k, l]) => el('span', { class: 'sidepick' }, el('span', { class: 'muted sm' }, l),
    el('div', { class: 'seg' }, its.map((it, i) => el('button', { class: 'tool sm', 'aria-pressed': String(C[k] === i), title: it.a.name,
      onclick: () => { const o = k === 'a' ? 'b' : 'a'; if (C[o] === i) C[o] = C[k]; C[k] = i; showChoice(g, true); } }, L(i))))))) : null;
  const views = el('div', { class: 'seg cview' }, [['grid', 'All ' + its.length + ' side by side'], ['slider', 'Compare two']].map(([k, l]) =>
    el('button', { class: 'tool sm', 'aria-pressed': String(C.view === k), onclick: () => { C.view = k; showChoice(g, true); } }, l)));
  $('#home').replaceChildren(el('div', { class: 'wrap choice' },
    el('div', { class: 'hero' }, el('div', {},
      el('button', { class: 'ghost', onclick: goHome }, icon('back'), 'Overview'),
      el('h1', {}, 'Pick 1 of ' + its.length + ': ' + choiceTitle(g)),
      el('p', { class: 'sub' }, 'Click the option you choose. The other options become "not chosen" and the agent leaves them alone.'))),
    textOnly || audioOnly ? null : views,
    textOnly || audioOnly || C.view === 'grid' ? el('div', { class: 'cgrid', style: { '--n': Math.min(its.length, 3) } }, its.map(opt))
      : [sides, sliderCompare(C, its[C.a], its[C.b]), el('div', { class: 'cards opts' }, its.map(opt))],
    el('div', { class: 'cdecide' }, txt, bPick, el('div', { class: 'choices' }, bMix, bNone, bBin))));
}
// Two options in one frame. Wipe: left of the line is "Left", right of it "Right". Fade: fade from Left to Right. Difference: what differs lights up.
function sliderCompare(C, A, B) {
  if (S.choiceRO) S.choiceRO.disconnect();
  const cv = el('canvas', { class: 'scv' }); const box = el('div', { class: 'sbox' }, cv, el('span', { class: 'tag l' }, 'Left: ' + A.a.name), el('span', { class: 'tag r' }, 'Right: ' + B.a.name));
  const ia = new Image(), ib = new Image();
  const range = el('input', { type: 'range', min: '0', max: '1000', value: String(Math.round(C.pos * 1000)), 'aria-label': 'Slide between left and right', oninput: e => { C.pos = e.target.value / 1000; draw(); } });
  const fit = (im, W, H) => { const s = Math.min(W / im.naturalWidth, H / im.naturalHeight); const w = im.naturalWidth * s, h = im.naturalHeight * s; return [(W - w) / 2, (H - h) / 2, w, h]; };
  function draw() {
    if (!ia.naturalWidth || !ib.naturalWidth) return;
    const W = box.clientWidth; if (!W) return; const H = Math.round(Math.min(W * ia.naturalHeight / ia.naturalWidth, innerHeight * 0.62)); const dpr = devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px';
    const g = cv.getContext('2d', { willReadFrequently: C.mode === 'diff' }); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0d0e10'; g.fillRect(0, 0, W, H); g.drawImage(ia, ...fit(ia, W, H));
    if (C.mode === 'wipe') { const x = W * C.pos; g.save(); g.beginPath(); g.rect(x, 0, W - x, H); g.clip(); g.fillRect(x, 0, W - x, H); g.drawImage(ib, ...fit(ib, W, H)); g.restore(); g.fillStyle = '#d9ae52'; g.fillRect(x - 1, 0, 2, H); }
    else if (C.mode === 'fade') { g.globalAlpha = C.pos; g.drawImage(ib, ...fit(ib, W, H)); g.globalAlpha = 1; }
    else { g.globalCompositeOperation = 'difference'; g.drawImage(ib, ...fit(ib, W, H)); g.globalCompositeOperation = 'source-over';
      try { const d = g.getImageData(0, 0, cv.width, cv.height); for (let i = 0; i < d.data.length; i += 4) for (let k = 0; k < 3; k++) d.data[i + k] = Math.min(255, d.data[i + k] * 3); g.putImageData(d, 0, 0); } catch (e) { /* tainted canvas: plain difference */ } }
  }
  const drag = e => { if (C.mode === 'diff' || !(e.buttons & 1)) return; const r = cv.getBoundingClientRect(); C.pos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); range.value = String(Math.round(C.pos * 1000)); draw(); };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag(e); }); cv.addEventListener('pointermove', drag);
  ia.onload = ib.onload = draw; ia.src = optUrl(A) || ''; ib.src = optUrl(B) || '';
  S.choiceRO = new ResizeObserver(() => draw()); S.choiceRO.observe(box);
  const modes = el('div', { class: 'seg' }, [['wipe', 'Wipe'], ['fade', 'Fade'], ['diff', 'Difference']].map(([k, l]) => el('button', { class: 'tool sm', 'aria-pressed': String(C.mode === k),
    onclick: e => { C.mode = k; for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); range.disabled = k === 'diff'; draw(); } }, l)));
  range.disabled = C.mode === 'diff';
  return el('div', { class: 'slider' }, box, el('div', { class: 'srow' }, modes, el('span', { class: 'muted sm' }, 'Left'), range, el('span', { class: 'muted sm' }, 'Right')));
}
// One decision for the whole group. The chosen option: approved (or "change" = back to the agent with your text).
// The others: rejected as "not chosen"; the autopilot does not wake an agent for those. "None of these" rejects all and wakes the agent once.
async function decideChoice(g, how) {
  if (S.busy) return toast('One moment: your previous choice is still being sent.', 3000);
  const its = choiceGroups()[g] || []; const C = S.choice; if (!C) return showChoice(g); const txt = (C.text || '').trim();
  if (how !== 'none' && C.sel == null) { const b = $('.tpick,.opt .card'); if (b) { b.scrollIntoView({ block: 'center' }); b.focus({ preventScroll: true }); } return toast('First click the option you mean.', 4000); }
  if (how !== 'pick' && !txt) { const t = $('.cdecide .sum'); if (t) { t.placeholder = how === 'none' ? 'Why none of these? What should the agent do differently?' : 'What should the agent change about this option?'; t.focus(); t.classList.remove('shake'); void t.offsetWidth; t.classList.add('shake'); }
    return toast(how === 'none' ? 'First type why none of these, then tap None of these again.' : 'First type what the agent should change, then tap again.', 5000); }
  const chosen = how === 'none' ? null : its[C.sel];
  S.busy = true; const undo = [];
  try {
    for (const [i, it] of its.entries()) {
      const v = it.st.versions.length; const cur = await api('/api/review?asset=' + it.id + '&stage=' + it.s.id + '&v=' + v);
      undo.push({ asset: it.id, stage: it.s.id, v, before: cur ? JSON.parse(JSON.stringify(cur)) : null });
      let verdict, role, sum;
      if (how === 'none') { verdict = 'rejected'; role = i === 0 ? 'none_chosen' : 'not_chosen'; sum = 'None of the ' + its.length + ' options chosen: ' + txt; }
      else if (i === C.sel) { verdict = how === 'pick' ? 'approved' : 'changes'; role = 'chosen'; sum = (how === 'pick' ? 'Chosen from ' : 'Chosen with changes from ') + its.length + ' options (' + its.map(x => x.a.name).join(', ') + ')' + (txt ? ': ' + txt : ''); }
      else { verdict = 'rejected'; role = 'not_chosen'; sum = 'Not chosen; the choice is ' + chosen.a.name + (txt ? '. ' + txt : ''); }
      const rv = cur || { notes: [], checklist: {}, followups: [], summary: '' };
      Object.assign(rv, { asset: it.id, stage: it.s.id, version: v, reviewer: REVIEWER, draft: false, verdict, summary: [rv.summary, sum].filter(Boolean).join('\n'), choice: { group: g, role, chosen: chosen ? chosen.id : null } });
      const out = await postReview(rv, {}, baseRev(cur)); undo[undo.length - 1].after = out.rev;
    }
  } catch (e) { S.busy = false; toast(e.status === 409 ? CONFLICT + '. Please check again.' : 'Could not send: ' + e.message, 7000); return; }
  S.busy = false; S.choice = null; S.cat = await api('/api/catalog'); await showHome();
  toast(how === 'none' ? 'None of these: the agent makes new options.' : (how === 'pick' ? 'Chosen: ' : 'Chosen, with changes: ') + chosen.a.name, 9000, ['Undo', async () => {
    for (const d of undo) { const rv = Object.assign(d.before || { notes: [], checklist: {}, followups: [], summary: '' }, { asset: d.asset, stage: d.stage, version: d.v, reviewer: REVIEWER, draft: true, verdict: 'pending' }); delete rv.choice;
      try { await postReview(rv, {}, d.after); } catch (e) { return toast(e.status === 409 ? CONFLICT + '. Not restored.' : 'Could not restore: ' + e.message, 7000); } }
    S.cat = await api('/api/catalog'); await showChoice(g); toast('Restored. The choice is waiting for you again.'); }]);
}

// ---------------- review: open one version ----------------
// Per categorie: every waiting version of one category side by side (category.js); back returns to Today.
async function showCategory(name) {
  if (!await leaveReview()) return;
  const fromHome = S.mode === 'home'; if (fromHome) leaveHome();
  destroyViews(); closeComposer(); S.mode = 'category'; S.asset = null; document.body.className = 'home';
  studioPolling();
  goUrl(location.pathname + location.search + '#cat=' + encodeURIComponent(name), fromHome);
  renderBar(); CT.open(name); scrollTo(0, 0); $('#home').scrollTop = 0;
}
// Listen to a sound straight from the overview row, without opening the review.
function quickPlay(btn, url) {
  const was = S.quick; if (was) { was.a.pause(); was.btn.textContent = '▶'; S.quick = null; if (was.btn === btn) return; }
  const a = new Audio(url); S.quick = { a, btn }; btn.textContent = '❚❚'; a.onended = () => { btn.textContent = '▶'; S.quick = null; }; a.play().catch(() => { btn.textContent = '▶'; S.quick = null; });
}
// The ticked or directly approved "Waiting for you" rows (any project, through ?p=): one toast with undo.
async function approveMany(items) {
  if (!items.length) return toast('Select at least one version first.', 4000);
  const done = [], skipped = []; const name = it => it.name || it.asset;
  for (const it of items) {
    const o = { p: it.p }; const get = k => api('/api/review?asset=' + encodeURIComponent(it.asset) + '&stage=' + encodeURIComponent(it.stage) + '&v=' + k, o);
    let cur; try { cur = await get(it.v); } catch (e) { skipped.push(name(it) + ' (' + e.message + ')'); continue; }
    if (cur && cur.draft === false && cur.verdict && cur.verdict !== 'pending') { skipped.push(name(it) + ' (already reviewed)'); continue; }
    if (cur && (cur.notes || []).some(n => n.verdict !== 'approve' && n.status === 'open')) { skipped.push(name(it) + ' (open notes)'); continue; }
    const before = cur ? JSON.parse(JSON.stringify(cur)) : null; const rv = cur || { notes: [], checklist: {}, followups: [], summary: '' }; rv.followups = rv.followups || [];
    const prev = it.v > 1 ? await get(it.v - 1).catch(() => null) : null;
    for (const n of (prev && prev.notes) || []) if (n.verdict !== 'approve' && !rv.followups.some(f => f.id === 'v' + (it.v - 1) + ':' + n.id)) rv.followups.push({ id: 'v' + (it.v - 1) + ':' + n.id, status: 'confirmed', text: n.text, target: n.target });
    Object.assign(rv, { asset: it.asset, stage: it.stage, version: it.v, reviewer: REVIEWER, draft: false, verdict: 'approved', via: 'batch' });
    let out; try { out = await postReview(rv, {}, baseRev(cur), it.p); } catch (e) { skipped.push(name(it) + (e.status === 409 ? ' (just changed)' : ' (' + e.message + ')')); continue; }
    done.push({ it, before, after: out.rev });
  }
  if (S.qsel) S.qsel.clear(); try { S.cat = await api('/api/catalog'); } catch (e) { /* keep the copy we have */ } await showHome();
  toast(done.length + ' approved' + (skipped.length ? '. Skipped: ' + skipped.join(', ') : '.'), 9000, done.length ? ['Undo', async () => {
    for (const d of done) { const rv = Object.assign(d.before || { notes: [], checklist: {}, followups: [], summary: '' }, { asset: d.it.asset, stage: d.it.stage, version: d.it.v, reviewer: REVIEWER, draft: true, verdict: 'pending' });
      try { await postReview(rv, {}, d.after, d.it.p); } catch (e) { return toast(e.status === 409 ? CONFLICT + '. Not everything was restored.' : 'Could not restore: ' + e.message, 7000); } }
    S.cat = await api('/api/catalog'); await showHome(); toast('Restored.'); }] : null);
}

async function pick(asset, stage, v) {
  if (!await leaveReview()) return;
  const fromHome = S.mode === 'home'; if (fromHome) leaveHome();
  keepUnsent(); closeComposer(); S.wantChange = false; S.rejecting = false; S.rejectText = '';
  if (!S.cat.assets[asset]) { toast('This item does not exist (anymore).'); return showHome(); }
  const tok = S.nav = (S.nav || 0) + 1; // a newer pick wins: older awaits below stop as soon as they see a different token
  try { S.cat = await api('/api/catalog'); } catch (e) { /* keep the copy we have */ }
  if (tok !== S.nav) return;
  if (stage && !S.cat.stages.some(s => s.id === stage)) stage = null; // an old or mistyped link falls back to the stage that waits (checked against the fresh catalog)
  if (!stage) stage = (S.cat.stages.find(s => { const st = stageInfo(asset, s.id); return st && st.status === 'in_review'; }) || S.cat.stages.find(s => stageInfo(asset, s.id)) || S.cat.stages[0]).id;
  if (stage !== S.stage || asset !== S.asset) { S.cmpWith = null; S.inspectCompare = null; S.cmpMode = 'side'; S.compare = false; }
  S.mode = 'review'; document.body.className = 'review';
  studioPolling();
  S.asset = asset; S.stage = stage; S.file = 0; S.sel = null; S.active = null; S.editing = false; S.sumOpen = false; S.moreOpen = false;
  const st = stageInfo(asset, stage);
  S.v = st ? (v && v <= st.versions.length ? v : st.versions.length) : null;
  goUrl('#a=' + asset + '&s=' + stage + (S.v ? '&v=' + S.v : ''), fromHome);
  renderBar(); renderSteps();
  destroyViews();
  if (!st) { S.review = null; renderEmpty(); renderSide(); return; }
  const get = k => api('/api/review?asset=' + asset + '&stage=' + stage + '&v=' + k);
  const rv = (await get(S.v)) || { asset, stage, version: S.v, verdict: 'pending', summary: '', notes: [], checklist: {}, followups: [], reviewer: REVIEWER, rev: 0 };
  rv.notes = rv.notes || []; rv.checklist = rv.checklist || {}; rv.followups = rv.followups || [];
  const guest = CM.guest(); // a commenter sees her own comments only: no earlier reviews, no locks
  const olders = guest ? [] : await Promise.all(Array.from({ length: S.v - 1 }, (_, k) => get(k + 1)));
  const mine = await CM.load();
  if (tok !== S.nav) return;
  markSeen();
  S.review = guest ? CM.guestReview(mine) : withoutCoreMandate(rv); S.prev = olders[S.v - 2] || null;
  if (!guest) S.base = baseOf(rv); // what the server has: the base for merging after a 409
  S.restoredDrafts = drafts.get(draftId());
  for (const d of S.restoredDrafts) {
    const cur = S.review, files = S.cfiles; S.review = withoutCoreMandate(d.value.review); S.cfiles = guest ? { ...d.value.files } : { ...files, ...d.value.files };
    if (guest) { S.cbase = d.value.cbase; S.crev = d.value.crev; CM.conflict({ comments: cur.notes, rev: mine ? mine.rev : 0 }, files); }
    else { S.base = d.value.base; reviewConflict(S.review, cur); }
  }
  if (S.restoredDrafts.length) { keepDraft(); toast('Local draft restored. Trying to save it again.', 6000); }
  S.locks = []; // locks add up over versions (same rule as review.py stage_locks)
  olders.forEach((r, k) => { for (const n of (r && r.notes) || []) if (n.verdict === 'approve' && n.status !== 'wontfix') S.locks.push({ v: k + 1, n }); });
  try { await mountViews(tok); } catch (e) { if (tok === S.nav) mediaError(e); }
  if (tok !== S.nav) return;
  renderSide(); renderBar(); restoreUnsent();
}
// A file that does not load gets a plain message and a download link, and the notes panel still works.
function mediaError(e) {
  const f = verInfo().files[S.file]; destroyViews(); $('#dock').replaceChildren();
  $('#view').replaceChildren(el('div', { class: 'empty' }, el('p', { class: 'muted' }, 'File'), el('h2', {}, 'This file cannot be shown'),
    el('p', { class: 'muted' }, f.name + ': ' + (e && e.message || e)), el('p', {}, el('a', { href: dataUrl(S.asset, S.stage, S.v, f.name), download: f.name }, 'Download the file')),
    el('p', { class: 'muted' }, 'You can still add a general note or reject the version.')));
}
async function step(d) {
  if (CM.guest()) return gstep(d);
  const q = queue(); if (!q.length) { toast('Nothing is waiting for you.'); return showHome(); }
  const i = q.findIndex(x => x.id === S.asset && x.s.id === S.stage);
  const it = i < 0 ? q[0] : q[(i + d + q.length) % q.length]; await pick(it.id, it.s.id);
}
function renderEmpty() {
  $('#main').className = ''; $('#filelabel').replaceChildren();
  const s = stageDef(); $('#dock').replaceChildren(); $('#cmpbar').hidden = true; $('#timeline').className = '';
  $('#view').className = ''; $('#view').replaceChildren(el('div', { class: 'empty' },
    el('p', { class: 'muted' }, SHORT[s.id] || s.label), el('h2', {}, 'Nothing submitted yet'), el('p', {}, 'Expected here: ' + s.media + '.'),
    el('p', { class: 'muted' }, 'What you will check here:'), el('ul', {}, s.checks.map(c => el('li', {}, c))),
    el('details', {}, el('summary', {}, 'For agents'), el('code', {}, 'python review.py submit --asset ' + S.asset + ' --stage ' + S.stage + ' --file <file> --note "what is new"'))));
}

// ---------------- bar + stage steps ----------------
function renderBar() {
  if ((S.mode === 'home' || S.mode === 'choice' || S.mode === 'category') && HM.sw && HM.sw.isConnected && HM.sw.isOpen()) return; // never close the open project menu
  const B = $('#bar'); const phone = matchMedia('(max-width:820px)').matches;
  const normal = new URL(location.href); normal.searchParams.delete('by');
  const badge = REVIEWER !== 'Owner' ? el('div', { class: 'reviewer-badge', role: 'status' }, el('span', {}, 'Test mode · saving as ' + REVIEWER), el('a', { href: normal.pathname + normal.search + normal.hash }, 'As owner')) : null;
  const chip = personChip(el, S.me);
  const help = el('button', { class: 'ghost sq help', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: showHelp }, icon('help'));
  const reload = el('button', { class: 'ghost sq', title: 'Refresh (R)', 'aria-label': 'Refresh', onclick: checkNow }, icon('refresh'));
  if (S.mode === 'home' || S.mode === 'choice' || S.mode === 'category') { B.replaceChildren(brandMark(), HM.switcher() || el('div', { class: 'brand' }, el('b', {}, S.cat.project), el('span', {}, 'Kitborne Terminal')), el('span', { class: 'grow' }), reload, help, chip, badge); return; }
  const projects = (S.proj || {}).projects || [];
  const project = el('select', { class: 'project-sel', 'aria-label': 'Project', onchange: e => { location.href = '?p=' + encodeURIComponent(e.target.value) + '&by=' + encodeURIComponent(REVIEWER); } },
    projects.length ? projects.map(p => el('option', { value: p.id, selected: p.id === (PROJECT || S.proj.home) }, p.project)) : el('option', {}, S.cat.project));
  const st = stageInfo(S.asset, S.stage), q = CM.guest() ? gqueue() : queue(), i = q.findIndex(x => x.id === S.asset && (CM.guest() || x.s.id === S.stage));
  const rv = S.review; let stat = ['Nothing yet', 'var(--faint)'];
  if (st && !isLatest()) stat = ['Older version', 'var(--faint)'];
  else if (st && isFinal(rv)) stat = verInfo()?.meta?.unverified ? STATUS.unverified : [SENT[rv.verdict], VERDICT[{ approved: 'approve', changes: 'change', rejected: 'reject' }[rv.verdict]][1]];
  else if (st) stat = [S.me && S.me.owned_by ? 'Waiting for ' + S.me.owned_by : 'Waiting for you', 'var(--blue)'];
  if (st && isLatest() && isFinal(rv) && S.editing) stat = ['Editing', 'var(--amber)'];
  if (st?.stale && isLatest()) stat = ['Outdated', 'var(--amber)'];
  if (CM.guest() && st && isLatest() && !st.stale) stat = st.status === 'in_review' ? ['Waiting for the owner', 'var(--blue)'] : [STATUS[st.status][0], STATUS[st.status][1]]; // a commenter does not decide
  const asset = el('div', { class: 'asset-picker' }, el('span', { class: 'asset-name' }, nice(S.cat.assets[S.asset].name)),
    el('select', { class: 'asset-sel', 'aria-label': 'Asset', onchange: e => pick(e.target.value) }, Object.entries(S.cat.assets).map(([id, a]) => el('option', { value: id, selected: id === S.asset }, nice(a.name)))));
  const version = st ? el('select', { class: 'vsel', 'aria-label': 'Version', onchange: e => pick(S.asset, S.stage, +e.target.value) }, st.versions.map(x => el('option', { value: x.v, selected: x.v === S.v }, 'v' + x.v))) : null;
  const status = el('span', { class: 'stat', style: { '--c': stat[1] } }, el('i', { 'aria-hidden': 'true' }), stat[0]);
  const nav = el('div', { class: 'qnav' }, el('span', {}, q.length ? (i >= 0 ? (i + 1) + (phone ? '/' : ' of ') + q.length : q.length + (phone ? ' waiting' : CM.guest() ? ' to view' : ' in queue')) : (phone ? '0 waiting' : 'Nothing waiting')),
    q.length ? [el('button', { class: 'ghost sq', title: 'Previous waiting', 'aria-label': 'Previous', onclick: () => step(-1) }, icon('back')),
      el('button', { class: 'ghost sq', title: 'Next waiting (N)', 'aria-label': 'Next', onclick: () => step(1) }, icon('next'))] : null);
  B.replaceChildren(brandMark(), el('button', { class: 'ghost back-home', title: 'Overview (G)', 'aria-label': phone ? 'Back to overview' : 'Overview', onclick: goHome }, icon('back'), phone ? 'Back' : 'Overview'),
    phone ? asset : el('div', { class: 'crumb' }, project, el('span', { class: 'sep' }, '/'), asset, version),
    phone ? help : el('span', { class: 'grow' }),
    phone ? el('div', { class: 'phone-row' }, el('div', { class: 'phone-context' }, el('span', { class: 'stage-name' }, SHORT[S.stage] || stageDef().label),
      version ? [el('span', { class: 'sep' }, '·'), version] : null, el('span', { class: 'sep' }, '·'), status), nav) : [status, nav, reload, help], chip, badge);
}
function renderSteps() {
  const rail = stageRail(S.asset), outside = !$('.cur', rail);
  $('#steps').replaceChildren(rail,
    el('select', { class: 'all-stages', 'aria-label': outside ? 'Current stage outside the route' : 'All stages', 'aria-current': outside ? 'step' : null,
      onchange: e => { if (e.target.value) pick(S.asset, e.target.value); } },
      el('option', { value: '' }, 'All stages'), S.cat.stages.filter(s => [routeGroup(S.asset), 'any'].includes(s.group || 'asset') || stageInfo(S.asset, s.id)).map(s => el('option', { value: s.id, selected: outside && s.id === S.stage }, (SHORT[s.id] || s.label) + (outside && s.id === S.stage ? ' (outside route)' : '')))));
  const cur = $('#steps [aria-current="step"]'); if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// ---------------- views, dock, compare ----------------
function destroyViews() { $('#modelcompare').replaceChildren(); if (S.photoOv) { S.photoOv.destroy(); S.photoOv = null; } for (const k of ['view', 'cmp']) { if (S[k]) S[k].destroy(); S[k] = null; } showHover(null); }
const canCompare = () => photoMedia() || (S.inspectCompare?.asset === S.asset && S.inspectCompare.stage === S.stage && S.inspectCompare.v !== S.v) || S.v > 1 || S.cat.stages.some(x => x.id !== S.stage && stageInfo(S.asset, x.id));
// What the compare pane shows: the previous version, or the newest version of another stage (model next to its concept).
function cmpSource() {
  if (photoMode()) return null;
  const chosen = S.inspectCompare;
  if (chosen?.asset === S.asset && chosen.stage === S.stage && chosen.v !== S.v) {
    const ver = stageInfo(S.asset, S.stage)?.versions.find(v => v.v === chosen.v);
    if (ver) return { stage: S.stage, v: ver.v, ver, label: 'version ' + ver.v };
  }
  if (S.cmpWith) { const st = stageInfo(S.asset, S.cmpWith); if (st) { const v = st.versions.length; return { stage: S.cmpWith, v, ver: st.versions[v - 1], label: S.cat.stages.find(x => x.id === S.cmpWith).label + ' v' + v }; } }
  if (S.v > 1) return { stage: S.stage, v: S.v - 1, ver: verInfo(S.v - 1), label: 'version ' + (S.v - 1) };
  return null;
}
async function mountViews(tok) {
  const live = () => tok == null || tok === S.nav; S.partsState = null;
  const ver = verInfo(); const f = ver.files[S.file]; const view = $('#view');
  // R3I-007 begin
  const webVersions = stageInfo(S.asset, S.stage)?.versions || [];
  if (routeGroup(S.asset) === 'web' && f.media === 'image') {
    const { mountWebReview } = await import('./web-review.js');
    if (!live()) return;
    $('#main').className = 'media-image';
    $('#filelabel').replaceChildren('version ' + S.v + ' · ' + f.name, el('span', { class: 'src-note' }, ' · submitted screenshot'));
    view.replaceChildren(); view.className = view.dataset.bg || '';
    const pane = el('div', { class: 'pane' }, el('span', { class: 'tag' }, 'version ' + S.v + ' · submitted screenshot'));
    view.append(pane);
    const V = S.view = new ImageView(pane, dataUrl(S.asset, S.stage, S.v, f.name), f, { primary: true });
    await V.load();
    if (!live() || S.view !== V) { V.destroy(); return; }
    mountWebReview({ container: $('#modelcompare'), versions: webVersions, current: S.v, url: (v, name) => dataUrl(S.asset, S.stage, v, name) });
    fitPhone('image'); renderDock(); refreshMarks();
    $('#dock [aria-label="Compare"]')?.remove(); $('#cmpbar').hidden = true;
    return;
  }
  // R3I-007 end
  $('#main').className = 'media-' + f.media + (f.media === 'audio' && ver.files.length > 1 ? ' audio-set' : '');
  $('#filelabel').replaceChildren(ver.files.length > 1 ? el('span', {}, (S.file + 1) + ' of ' + ver.files.length + ' · ' + f.name) : null);
  const src = S.compare ? cmpSource() : null;
  const pf = src ? (src.ver.files.find(x => x.media === f.media) || src.ver.files[0]) : null;
  const overlay = src && ['image', 'pdf'].includes(f.media) && pf.media === f.media && S.cmpMode !== 'side' ? { url: dataUrl(S.asset, src.stage, src.v, pf.name), mode: S.cmpMode, label: src.label } : null;
  view.replaceChildren(); view.className = (src && !overlay ? 'split ' : '') + (view.dataset.bg || '');
  const modelWipe = src && f.media === 'model' && pf.media === 'model' && S.cmpMode === 'wipe';
  if (modelWipe) { view.classList.remove('split'); view.classList.add('model-wipe'); }
  const paneA = el('div', { class: 'pane' }, src ? el('span', { class: 'tag' }, 'version ' + S.v + (overlay ? ' · right ' + overlay.label : '')) : null);
  view.append(paneA);
  const lv = src ? null : liveSource(ver, f); const page = lv && localStorage.getItem('ar.liveOff') !== '1' ? lv : null;
  const Cls = page ? LiveView : fileView(f);
  const V = S.view = new Cls(paneA, dataUrl(S.asset, S.stage, S.v, f.name), f, { primary: true, overlay, live: page, liveable: !!lv, down: liveDown });
  if (f.missing && !page) throw new Error((f.media === 'audio' ? 'sound' : 'file') + ' not found (missing on disk)');
  try { await V.load(); } catch (e) { if (!page) throw e; V.destroy(); S.liveFail = page.url; paneA.replaceChildren(); return mountViews(tok); }
  if (!live() || S.view !== V) { V.destroy(); return; } // the reviewer already moved on
  fitPhone(f.media);
  if (photoMode()) await mountPhoto(paneA, V);
  if (!live() || S.view !== V) return;
  if (!src && S.liveFail && !page && localStorage.getItem('ar.liveOff') !== '1' && liveSource(ver, f, true)) paneA.append(liveDownBar());
  if (f.media === 'image' && V.setParts && routeGroup(S.asset) === 'asset') await loadParts(V, f);
  if (REVIEWER !== 'agent-test' && !ver.thumb && S.view.thumb) setTimeout(() => postThumb(S.asset, S.stage, S.v), 600);
  if (src && !overlay) {
    const paneB = el('div', { class: 'pane' }, el('span', { class: 'tag' }, src.label)); view.append(paneB);
    const CB = fileView(pf);
    const C = S.cmp = new CB(paneB, dataUrl(S.asset, src.stage, src.v, pf.name), pf, { primary: false });
    await C.load();
    if (!live() || S.cmp !== C) { C.destroy(); return; }
    if (src.stage === S.stage) { S.view.peer = S.cmp; if (S.prev) S.cmp.marks(S.prev.notes.filter(n => (n.target || {}).file === pf.name), null); }
    if (V instanceof ModelView && C instanceof ModelView) {
      V.peer = C; C.peer = V; V.syncPeer();
      if (modelWipe) {
        const slider = el('input', { class: 'model-wipe-slider', type: 'range', min: 0, max: 100, value: 50, 'aria-label': 'Version slider', oninput: e => { paneB.style.clipPath = 'inset(0 ' + (100 - e.target.value) + '% 0 0)'; } });
        paneB.style.clipPath = 'inset(0 50% 0 0)'; view.append(slider);
      }
    }
  }
  $('#modelcompare').replaceChildren(...(V instanceof ModelView && S.cmp instanceof ModelView ? [modelCompareTable(f, pf, src)] : []));
  renderDock(); renderCmpBar(); refreshMarks();
}
// Recognised parts arrive in the background after a submit (segment.py, about 10-20 s per image). While that runs the panel says so and checks again.
async function loadParts(V, f, tries = 0) {
  const base = '/data/' + S.asset + '/' + S.stage + '/v' + pad3(S.v) + '/parts/';
  try { const r = await fetch(withP(base + encodeURIComponent(f.name + '.json'))); if (r.ok && r.status !== 204) { const doc = await r.json(); if (S.view === V) { V.setParts(doc); if (S.partsState) { S.partsState = null; renderSide(); } } return; } } catch (e) { /* parts are optional */ }
  let log = ''; try { const r = await fetch(withP(base + 'segment.log')); if (r.ok) log = await r.text(); } catch (e) { /* no run */ }
  if (S.view !== V) return;
  const state = !log || log.includes('PARTS ' + f.name) ? null : /ERROR|Traceback/.test(log) ? 'error' : 'running';
  if (state !== S.partsState) { S.partsState = state; if (tries) renderSide(); }
  if (state === 'running' && tries < 45) setTimeout(() => { if (S.view === V) loadParts(V, f, tries + 1); }, 4000);
}
// Phones: a wide image needs less height than the default; the space it does not need goes to the notes below.
function fitPhone(media) {
  const m = S.view && (S.view.img || S.view.v); const w = m && (m.naturalWidth || m.videoWidth), h = m && (m.naturalHeight || m.videoHeight);
  document.body.style.setProperty('--main-h', S.compare ? Math.round(innerHeight * 0.78) + 'px' : w && h ? Math.round(Math.max(300, Math.min(innerHeight * 0.62, innerWidth * h / w + (media === 'video' ? 220 : 150)))) + 'px' : '');
}
function renderDock() {
  const D = $('#dock'); if (!S.view) { D.replaceChildren(); return; }
  const keys = { point: 'A', part: 'A', range: 'A', text: 'A', pen: 'D', hand: 'H', time: 'T' }; const ICON = { point: 'point', part: 'point', range: 'point', text: 'point', pen: 'pen', hand: 'hand', time: 'clock', live: 'click', contrast: 'contrast', textheight: 'textheight' };
  const extra = S.view.extras ? S.view.extras() : [];
  const items = [el('div', { class: 'seg', role: 'group', 'aria-label': 'Tools' }, S.view.tools().map(([id, label, tip]) => el('button', { class: 'tool', 'aria-pressed': String(S.view.tool === id), 'aria-label': label, title: tip + (keys[id] ? ' (' + keys[id] + ')' : ''), onclick: () => setTool(id) }, icon(ICON[id] || 'point'), el('span', { class: 'lbl' }, label))))];
  const phoneAudio = S.view instanceof AudioView && matchMedia(PHONE).matches;
  const auto = phoneAudio && extra.find(x => x.classList.contains('autoplay'));
  const more = phoneAudio ? extra.slice(2).filter(x => x !== auto) : extra;
  if (S.view.inlineExtras) items.push(el('span', { class: 'div' }), ...(phoneAudio ? extra.slice(0, 2) : extra));
  if (auto) items.push(auto);
  if (phoneAudio) items.push(el('button', { class: 'tool labeled', 'data-menu': '1', 'aria-label': 'More sound options', onclick: e => toggleViewMenu(e.currentTarget, more) }, 'More'));
  if (canCompare()) items.push(el('span', { class: 'div' }), el('button', { class: 'tool', 'aria-pressed': String(S.compare), 'aria-label': 'Compare', title: 'Compare with another version or stage (C)', onclick: toggleCompare }, icon('compare'), el('span', { class: 'lbl' }, 'Compare')));
  items.push(el('button', { class: 'tool', 'data-menu': '1', 'aria-label': 'View', title: 'View', onclick: e => toggleViewMenu(e.currentTarget, S.view.inlineExtras ? [] : extra) }, icon('sliders'), el('span', { class: 'lbl' }, 'View')));
  items.push(downloadFile(verInfo().files[S.file]));
  D.replaceChildren(...items);
  // phone: a short word under each icon (data-s, shown by theme.css); the full name stays in aria-label and title
  const SHORT = { 'Text size': 'Text', 'Time range': 'Range' };
  for (const t of D.querySelectorAll('.tool:not(.labeled)')) { const n = t.getAttribute('aria-label') || ''; t.dataset.s = t.matches('.file-download') ? 'Download' : SHORT[n] || n; }
  // Auto moves into More when the row would scroll sideways or wrap to a second line
  const T = D.querySelectorAll('.tool');
  if (auto && (D.scrollWidth > D.clientWidth + 1 || T[T.length - 1].offsetTop > T[0].offsetTop)) { auto.remove(); more.splice(1, 0, auto); }
}
function toggleViewMenu(btn, extra) {
  const M = $('#viewmenu'); if (!M.hidden) { M.hidden = true; return; }
  const bg = $('#view').dataset.bg || '';
  M.replaceChildren(...extra, extra.length ? el('hr') : '', el('div', { class: 'mlabel' }, 'Background'),
    el('div', { class: 'bgrow' }, [['', 'Grey'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => el('button', { class: 'bgbtn', 'aria-pressed': String(bg === v), onclick: () => { const vw = $('#view'); vw.classList.remove('light', 'dark'); if (v) vw.classList.add(v); vw.dataset.bg = v; for (const x of [S.view, S.cmp]) if (x && x.applyMats) x.applyMats(); for (const x of [S.view, S.cmp]) if (x && x.resize) x.resize(); M.hidden = true; } }, l))));
  M.hidden = false; const c = $('#canvas').getBoundingClientRect(), b = btn.getBoundingClientRect();
  M.style.maxHeight = Math.max(44, b.top - Math.max(c.top, 0) - 18) + 'px';
  M.style.left = Math.max(8, Math.min(c.width - M.offsetWidth - 8, b.left - c.left + b.width / 2 - M.offsetWidth / 2)) + 'px'; M.style.bottom = (c.bottom - b.top + 10) + 'px';
}
function renderCmpBar() {
  const C = $('#cmpbar'); if (!S.compare) { C.hidden = true; return; }
  const others = S.cat.stages.filter(x => x.id !== S.stage && stageInfo(S.asset, x.id)); const f = verInfo().files[S.file]; const src = cmpSource();
  C.replaceChildren(
    el('select', { 'aria-label': 'Compare with', onchange: async e => { S.cmpWith = e.target.value || null; S.inspectCompare = null; destroyViews(); await mountViews(); } },
      (S.v > 1 || S.inspectCompare) ? el('option', { value: '', selected: !S.cmpWith }, 'with version ' + (src?.stage === S.stage ? src.v : S.v - 1)) : null,
      others.map(x => el('option', { value: x.id, selected: S.cmpWith === x.id }, 'with ' + x.label.toLowerCase() + ' v' + stageInfo(S.asset, x.id).versions.length)), photoMedia() ? photoOptions() : null),
    photoMode() ? photoControls() : src && ['image', 'pdf', 'model'].includes(f.media) && src.ver.files.some(x => x.media === f.media) ? el('div', { class: 'seg' }, [['side', 'Side by side'], ['wipe', 'Wipe'], ...(f.media === 'model' ? [] : [['diff', 'Difference']])].map(([k, l]) => el('button', { class: 'tool sm', 'aria-pressed': String(S.cmpMode === k), onclick: async () => { const state = S.view instanceof ModelView ? S.view.viewState() : null; S.cmpMode = k; destroyViews(); await mountViews(); if (state && S.view instanceof ModelView) { await S.view.focus({ view: state, target: { selector: {} } }); S.view.syncPeer(); } } }, l))) : null,
    el('button', { class: 'ghost sq', title: 'Stop comparing (C)', 'aria-label': 'Stop comparing', onclick: toggleCompare }, icon('x', 16)));
  C.hidden = false; C.classList.toggle('photo', photoMode());
}
function modelCompareTable(file, previous, src) {
  const after = file.preflight?.stats || {}, before = previous.preflight?.stats || {}, delta = after.delta;
  const fmt = (value, key) => value == null ? '—' : Array.isArray(value) ? value.map(v => v.toFixed(3)).join(' × ') + ' m' : key === 'est_texture_mb' ? value.toFixed(2) : String(value);
  return el('table', { class: 'model-compare-table', 'aria-label': 'Version metadata delta' },
    el('caption', {}, src.label + ' → version ' + S.v),
    el('thead', {}, el('tr', {}, ['Stat', 'Before', 'After', 'Delta'].map(t => el('th', {}, t)))),
    el('tbody', {}, ['tris', 'vertices', 'materials', 'textures', 'draw_calls', 'size', 'est_texture_mb'].map(key => {
      const stored = delta?.from === src.v && delta.stage === src.stage ? delta.changes[key] : null;
      const a = stored ? stored.before : before[key], b = stored ? stored.after : after[key];
      const diff = stored ? stored.diff : a != null && b != null ? Array.isArray(a) ? b.map((v, i) => +(v - a[i]).toFixed(6)) : b - a : null;
      const change = stored ? stored.text || '—' : key === 'size' && diff ? diff.some(v => Math.abs(v) >= 0.0005) ? diff.map(v => Math.abs(v) < 0.0005 ? '0' : (v > 0 ? '+' : '') + Math.round(v * 1000)).join(' × ') + ' mm' : '—' : key === 'est_texture_mb' && diff != null ? Math.abs(diff) < 0.01 ? '—' : (diff > 0 ? '+' : '') + diff.toFixed(2) + ' MB' : fmt(diff, key);
      return el('tr', {}, el('th', {}, key), el('td', {}, fmt(a, key)), el('td', {}, fmt(b, key)), el('td', {}, change));
    })));
}
function setTool(id) { if (!S.view || !S.view.tools().some(t => t[0] === id)) return; S.view.setTool(id); localStorage.setItem('ar.tool2.' + S.view.constructor.name, id); renderDock(); }
async function toggleCompare() { if (!canCompare()) return; S.compare = !S.compare; if (S.compare && S.v < 2 && !S.cmpWith && !S.inspectCompare) S.cmpWith = (S.cat.stages.find(x => x.id !== S.stage && stageInfo(S.asset, x.id)) || {}).id || null; if (S.compare && S.v < 2 && !S.cmpWith && !S.inspectCompare) S.cmpWith = '@photo'; destroyViews(); await mountViews(); renderSide(); }
// ---------------- foto vs render ----------------
// A reference photo over the render with a see-through slider, Maat and Uitlijnen to line them up (DDW product-shape reviews).
// Photos come from items/<asset>/refs/, the studio request, or a photo picked on this device (that one stays in this browser).
function photoMode() { return S.compare && typeof S.cmpWith === 'string' && S.cmpWith.startsWith('@photo'); }
function photoMedia() { try { return routeGroup(S.asset) !== 'web' && ['image', 'model', 'video'].includes(verInfo().files[S.file].media); } catch (e) { return false; } }
async function loadPhotos() {
  if (S.photos && S.photos.asset === S.asset) return; let list = [];
  try { list = ((await api('/api/refphotos?asset=' + encodeURIComponent(S.asset))).photos || []).map(p => ({ ...p, url: withP(p.url) })); } catch (e) { /* no refs: the device picker still works */ }
  S.photos = { asset: S.asset, list };
}
function photoList() { const list = S.photos && S.photos.asset === S.asset ? [...S.photos.list] : []; const loc = S.localPhoto && S.localPhoto.asset === S.asset ? S.localPhoto : null; if (loc) list.push({ id: 'local', name: loc.name + ' (this device)', url: loc.url }); return list; }
function currentPhoto() { const list = photoList(); const id = S.cmpWith.slice(7); return list.find(p => p.id === id) || (S.cmpWith === '@photo' ? list.find(p => p.id === 'local') || list[0] : null) || null; }
// One menu entry; the photo list is only read when it is chosen (opening Vergelijk stays free of extra requests).
function photoOptions() { return el('option', { value: '@photo', selected: photoMode() }, 'with reference photo'); }
function pickLocalPhoto() {
  const inp = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } }); document.body.append(inp);
  inp.onchange = async () => { const f = inp.files && inp.files[0]; inp.remove(); if (!f) return renderCmpBar(); if (S.localPhoto) URL.revokeObjectURL(S.localPhoto.url);
    S.localPhoto = { asset: S.asset, name: f.name, url: URL.createObjectURL(f) }; S.compare = true; S.cmpWith = '@photo:local'; S.inspectCompare = null; destroyViews(); await mountViews(); };
  inp.addEventListener('cancel', () => { inp.remove(); renderCmpBar(); }); inp.click();
}
async function mountPhoto(pane, V) {
  await loadPhotos(); const p = currentPhoto();
  if (!p) { pane.append(el('div', { class: 'photo-empty' }, el('b', {}, 'No reference photo for this asset'), el('span', {}, 'Pick one from this device (stays in this browser) or have the agent put it in items/' + S.asset + '/refs/.'), el('button', { class: 'primary sm', onclick: pickLocalPhoto }, 'Pick photo'))); return; }
  const O = new PhotoOverlay(pane, p.url, V);
  try { await O.ready; } catch (e) { O.destroy(); toast('Could not load the reference photo: ' + p.name, 5000); return; }
  if (S.view !== V) { O.destroy(); return; }
  S.photoOv = O; O.place(); pane.append(el('span', { class: 'tag photo-tag' }, 'foto: ' + p.name));
}
function photoControls() {
  const O = S.photoOv; if (!O) return null; const list = photoList(), cur = currentPhoto();
  const pct = () => Math.round(O.a * 100) + '% photo'; const lab = el('span', { class: 'photo-pct' }, pct());
  return el('div', { class: 'seg photo-ctl' },
    el('label', { class: 'photo-r' }, el('span', {}, 'Render'), el('input', { type: 'range', min: 0, max: 100, value: Math.round(O.a * 100), 'aria-label': 'Opacity: render on the left, photo on the right', oninput: e => { O.a = e.target.value / 100; localStorage.setItem('ar.photoA', String(O.a)); O.place(); lab.textContent = pct(); } }), el('span', {}, 'Photo')), lab,
    el('label', { class: 'photo-r sz' }, el('span', {}, 'Size'), el('input', { type: 'range', min: 50, max: 200, value: Math.round(O.s * 100), 'aria-label': 'Photo size', oninput: e => { O.s = e.target.value / 100; O.place(); } })),
    el('button', { class: 'tool sm', 'aria-pressed': String(!!O.moving), title: 'Drag the photo until it lines up with the render', onclick: e => { O.setMoving(!O.moving); e.currentTarget.setAttribute('aria-pressed', String(O.moving)); } }, 'Align'),
    el('button', { class: 'tool sm', title: 'Reset the photo size and position', onclick: () => { O.s = 1; O.dx = O.dy = 0; O.setMoving(false); O.place(); renderCmpBar(); } }, 'Reset'),
    list.length > 1 ? el('select', { class: 'photo-pick', 'aria-label': 'Which photo', onchange: async e => { S.cmpWith = e.target.value; destroyViews(); await mountViews(); } }, list.map(p => el('option', { value: '@photo:' + p.id, selected: cur && cur.id === p.id }, p.name))) : null,
    el('button', { class: 'tool sm', title: 'Use a photo from this device (stays in this browser)', onclick: pickLocalPhoto }, 'Other photo…'));
}
class PhotoOverlay {
  constructor(pane, url, view) {
    this.pane = pane; this.view = view; const a = parseFloat(localStorage.getItem('ar.photoA')); this.a = Number.isFinite(a) ? a : 0.5; this.s = 1; this.dx = 0; this.dy = 0;
    this.img = el('img', { class: 'photo-ov', alt: 'Reference photo', draggable: 'false', src: url }); pane.append(this.img);
    this.ready = this.img.decode(); this.ro = new ResizeObserver(() => this.place()); this.ro.observe(pane);
  }
  frame() { const v = this.view, r = this.pane.getBoundingClientRect(); return (v instanceof ImageView || v instanceof VideoView) && v.box ? v.box() : { x: 0, y: 0, w: r.width, h: r.height }; }
  place() {
    if (!this.img.naturalWidth) return; const b = this.frame(), iw = this.img.naturalWidth, ih = this.img.naturalHeight; const k = Math.min(b.w / iw, b.h / ih) * this.s, w = iw * k, h = ih * k;
    Object.assign(this.img.style, { left: (b.x + (b.w - w) / 2 + this.dx * b.w) + 'px', top: (b.y + (b.h - h) / 2 + this.dy * b.h) + 'px', width: w + 'px', height: h + 'px', opacity: String(this.a) });
  }
  setMoving(on) {
    this.moving = on; this.img.classList.toggle('moving', on); if (!on || this.bound) return; this.bound = true;
    this.img.addEventListener('pointerdown', e => { if (!this.moving) return; e.preventDefault(); e.stopPropagation(); this.img.setPointerCapture(e.pointerId); const b = this.frame(); this.drag = { x: e.clientX, y: e.clientY, dx: this.dx, dy: this.dy, w: b.w || 1, h: b.h || 1 }; });
    this.img.addEventListener('pointermove', e => { const d = this.drag; if (!d) return; this.dx = d.dx + (e.clientX - d.x) / d.w; this.dy = d.dy + (e.clientY - d.y) / d.h; this.place(); });
    const end = () => { this.drag = null; }; this.img.addEventListener('pointerup', end); this.img.addEventListener('pointercancel', end);
  }
  destroy() { this.ro.disconnect(); this.img.remove(); }
}
async function postThumb(asset, stage, v) {
  if (!CM.can('decide')) return;
  try { const url = S.view && S.view.thumb ? await S.view.thumb() : null; if (!url || asset !== S.asset || stage !== S.stage || v !== S.v) return;
    await api('/api/thumb', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset, stage, version: v, png: url }) });
    S.cat = await api('/api/catalog'); } catch (e) { /* thumbnails are optional */ }
}
function fileNotes() { const f = verInfo().files[S.file].name; return S.review.notes.filter(n => (n.target || {}).file === f || (!(n.target || {}).file && S.file === 0)); }
async function showFile(i) { S.file = i; cancelSel(); destroyViews(); await mountViews(); S.autoNext = false; renderSide(); }
function refreshMarks() { if (S.view && S.review) S.view.marks(fileNotes().concat(CM.markers(verInfo().files[S.file].name)), S.active); }

// ---------------- pointing -> comment box ----------------
function select(selector, extra = {}) {
  const clear = () => S.view && S.view.clearSelection && S.view.clearSelection();
  if (locked()) { clear(); const w = $('#decide .ghost'); if (w) { w.classList.remove('pulse'); void w.offsetWidth; w.classList.add('pulse'); } return; } // show the way out instead of a message
  if (!isLatest()) { toast('This is an older version. Notes belong on the newest one.'); clear(); return; }
  const { keep, ...rest } = extra;
  S.sel = { selector, view: S.view && S.view.viewState ? S.view.viewState() : null, ...rest };
  showHover(null);
  const chip = $('#pop .tchip'); // an open comment keeps its text: a new tap moves or extends what it points at
  if (chip && !$('#pop').hidden) {
    chip.replaceChildren(selector.auto ? icon('spark', 13) : '', describe({ selector, page: S.sel.view && S.sel.view.pdfPage })); if (!keep) placePop(); saveUnsent(); $('#pop textarea').focus();
    const add = $('#pop .chipbtn.add'); if (S.adding && add) { S.adding = false; add.setAttribute('aria-pressed', 'false'); add.lastChild.textContent = 'Part'; } // one tap adds one part
    return;
  }
  openComposer();
}
const unsentKey = () => 'ar.unsent.' + (PROJECT ? PROJECT + ':' : '') + S.asset + '/' + S.stage + '/' + S.v;
function saveUnsent() { const ta = $('#pop textarea'); if (S.sel && ta && ta.value.trim()) localStorage.setItem(unsentKey(), JSON.stringify({ text: ta.value, sel: S.sel, file: S.file })); }
function keepUnsent() { if (S.asset && S.v) saveUnsent(); }
// A comment that was typed but not placed comes back after a reload or a detour, on the same version.
function restoreUnsent() {
  const raw = localStorage.getItem(unsentKey()); if (!raw || locked() || !isLatest()) return; localStorage.removeItem(unsentKey());
  let u; try { u = JSON.parse(raw); } catch (e) { return; } if (u.file !== S.file || !u.sel) return;
  S.sel = u.sel; openComposer(); const ta = $('#pop textarea'); ta.value = u.text; grow(ta); saveUnsent(); toast('Your unposted note is back.', 5000);
}
// Recognition can be wrong: the reviewer renames the target in place (empty = no name). The agent sees both names.
function renameTarget(chip) {
  const s = S.sel.selector;
  const inp = el('input', { class: 'tname', value: s.label || '', 'aria-label': 'Name of what you point at', placeholder: 'Name (empty: no name)' });
  let closed = false;
  const done = ok => {
    if (closed) return; closed = true; const v = inp.value.trim(); // removing the field fires blur: run once
    if (ok && v !== (s.label || '')) { if (s.auto && !s.label_auto && s.label) s.label_auto = s.label; if (v) s.label = v; else delete s.label; }
    if (ok) delete s.unsure; // renamed or confirmed by the owner
    chip.replaceChildren(s.auto ? icon('spark', 13) : '', describe({ selector: s, page: S.sel && S.sel.view && S.sel.view.pdfPage })); inp.replaceWith(chip); saveUnsent(); $('#pop textarea').focus();
  };
  inp.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(e.key === 'Enter'); } };
  inp.onblur = () => done(true);
  chip.replaceWith(inp); inp.focus(); inp.select();
}
// One recognised part -> its outline. Several -> one note on all of them (to combine, compare or fix them together).
function partsSel(ps) {
  if (ps.length === 1) { const p = ps[0]; return { type: 'polygon', points: p.polygons[0], label: p.name, auto: true, ...(p.score < UNSURE ? { unsure: true } : {}), part: { id: p.id, prompt: p.prompt, score: p.score, bbox: p.bbox } }; }
  const xs = ps.flatMap(p => [p.bbox[0], p.bbox[0] + p.bbox[2]]), ys = ps.flatMap(p => [p.bbox[1], p.bbox[1] + p.bbox[3]]); const x = Math.min(...xs), y = Math.min(...ys); const names = ps.map(p => p.name);
  return { type: 'rect', x: r4(x), y: r4(y), w: r4(Math.max(...xs) - x), h: r4(Math.max(...ys) - y), auto: true,
    label: names.length > 3 ? names.slice(0, 3).join(' + ') + ' + ' + (names.length - 3) + ' more' : names.join(' + '),
    parts2d: ps.map(p => ({ id: p.id, name: p.name, bbox: p.bbox, polygon: p.polygons[0] })) };
}
const grow = t => { t.style.height = 'auto'; t.style.height = Math.min(260, t.scrollHeight + 2) + 'px'; };
function openComposer() {
  const P = $('#pop'); let lock = false, high = false; const auto = S.sel.selector.auto; S.adding = false;
  const ta = el('textarea', { rows: '2', placeholder: CM.guest() ? 'What do you notice?' : 'What should change?', 'aria-label': 'Note', oninput: e => { grow(e.target); saveUnsent(); },
    // Enter places the note; Ctrl+Enter here also only places it (sending the whole review stays a separate step)
    onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); place(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelSel(); } } });
  const lockB = el('button', { class: 'chipbtn ok', 'aria-pressed': 'false', title: 'Agents may not change this afterwards', onclick: () => { lock = !lock; lockB.setAttribute('aria-pressed', String(lock)); ta.placeholder = lock ? 'What must stay exactly like this?' : 'What should change?'; ta.focus(); } }, icon('lock', 14), 'Keep as is');
  const hiB = el('button', { class: 'chipbtn hi', 'aria-pressed': 'false', title: 'Do this first', onclick: () => { high = !high; hiB.setAttribute('aria-pressed', String(high)); ta.focus(); } }, 'Important');
  const place = () => { if (!ta.value.trim()) { ta.classList.remove('shake'); void ta.offsetWidth; ta.classList.add('shake'); ta.focus(); return; } addNote(lock ? 'approve' : 'change', high ? 'high' : 'med', ta.value); };
  const multi = auto || S.sel.selector.type === 'part'; // recognised parts can be combined in one note
  const addB = multi ? el('button', { class: 'chipbtn add', 'aria-pressed': 'false', title: 'Point at another part for this note (or Shift+click)', onclick: () => { S.adding = !S.adding; addB.setAttribute('aria-pressed', String(S.adding)); addB.lastChild.textContent = S.adding ? 'Tap another part' : 'Part'; ta.focus(); } }, icon('plus', 14), el('span', {}, 'Part')) : null;
  const chip = el('button', { class: 'tchip', title: auto ? 'Detected automatically. Wrong name? Click to change it.' : 'What this note is about. Click to name it.', onclick: () => renameTarget(chip) }, auto ? icon('spark', 13) : '', describe({ selector: S.sel.selector }));
  const ref = refPicker(ta);
  P.replaceChildren(el('div', { class: 'pop-h' }, el('strong', {}, 'Note'), chip, el('span', { class: 'grow' }),
      addB || '',
      el('button', { class: 'ghost sq sm', title: 'Cancel (Esc)', 'aria-label': 'Cancel', onclick: cancelSel }, icon('x', 16))),
    el('div', { class: 'pop-body' }, ta, quickChips(ta), el('div', { class: 'refrow' }, ref.button, ref.thumb)),
    el('div', { class: 'pop-f' }, ...(CM.guest() ? [] : [lockB, hiB]), micButton(ta), el('span', { class: 'grow' }),
      el('button', { class: 'primary sm', onclick: place }, 'Post')));
  S.composerRef = ref;
  P.hidden = false; document.body.classList.add('composing'); syncComposerApproval(); placePop(); ta.focus();
}
// One tap adds a common remark, so the reviewer types less. The set follows the stage and the file type.
const QUICK = {
  print: ['Text too small', 'Improve readability', 'Margin too small', 'Page order is wrong', 'Clue too easy', 'Clue too hard', 'Typo', 'Image does not fit'],
  look: ['Too busy', 'Too bare', 'Bigger', 'Smaller', 'Too dark', 'Too light', 'More contrast', 'Does not fit the style'],
  shape: ['Silhouette does not read', 'Chunkier', 'Too thin', 'Proportions are off', 'Less detail', 'More detail', 'Scale is off next to the player'],
  surface: ['Colour does not fit the palette', 'Too saturated', 'Too dull', 'Too glossy', 'More wear', 'Too dark', 'Too light'],
  motion: ['Too fast', 'Too slow', 'Stiff', 'More weight', 'More anticipation', 'Loop stutters', 'Overdone'],
  sound: ['Too loud', 'Too quiet', 'Too long', 'Too short', 'More bass', 'Too harsh', 'Starts too late', 'Click in the loop'],
  fx: ['Too bright', 'Too small', 'Lasts too long', 'Does not read on phone', 'Too busy'],
  text: ['Too long', 'Unclear', 'Missing sizes', 'More examples', 'Does not match the canon'],
  game: ['Not clear', 'Too hard', 'Too easy', 'Boring', 'Too slow', 'Too much text', 'Does not fit the pillars'],
  ui: ['Too small on phone', 'Button too small', 'Too busy', 'Unclear', 'Does not fit the style'],
  style: ['Palette is off', 'Shape language is off', 'Lighting does not fit', 'Does not read on phone'],
  assets: ['Missing engine approval', 'Missing in-game screenshot', 'Placeholder not justified', 'Scale/collision is off'],
  slice: ['Core GUI missing', 'Touch target too small', 'Look is off', 'Collision is off'],
  qa: ['Phone model missing', 'FPS measurement missing', 'Ownership fails', 'Double payment', 'Phone audio fails'],
};
function quickSet() {
  const f = ((verInfo().files || [])[S.file] || {}).name || '';
  if (/\.pdf$/i.test(f) || S.stage === 'layout' || (S.cat.assets[S.asset] || {}).route === 'story') return QUICK.print;
  if (/\.(wav|mp3|ogg|flac|m4a)$/i.test(f)) return QUICK.sound;
  if (['style', 'assets', 'sound', 'slice', 'qa'].includes(S.stage)) return QUICK[S.stage];
  if (S.stage === 'ui') return QUICK.ui;
  if (S.stage === 'polish') return QUICK.game.slice(3, 5).concat(QUICK.fx.slice(0, 2), QUICK.motion.slice(2, 4));
  if (['pitch', 'design', 'level', 'prototype', 'playtest', 'balance', 'store'].includes(S.stage)) return QUICK.game;
  if (/\.md$/i.test(f) || S.stage === 'brief') return QUICK.text;
  return { rig: QUICK.motion, animation: QUICK.motion, vfx: QUICK.fx, surface: QUICK.surface, audio: QUICK.sound }[S.stage] || QUICK.shape.concat(QUICK.look.slice(0, 2));
}
function quickChips(ta) {
  const add = w => { const v = ta.value.trim(); ta.value = v ? v + (/[.!?,]$/.test(v) ? ' ' : ', ') + w.toLowerCase() : w; ta.dispatchEvent(new Event('input')); ta.focus(); };
  const reasons = quickSet(), common = reasons.slice(0, 4), extra = reasons.slice(4);
  const group = (words, label) => el('div', { class: 'qchips', role: 'group', 'aria-label': label },
    words.map(w => el('button', { class: 'qchip', type: 'button', onclick: e => { e.stopPropagation(); add(w); } }, w)));
  return el('div', { class: 'note-reasons' },
    group(common, 'Common reasons'),
    extra.length || !CM.guest() ? el('details', { class: 'more-reasons' }, el('summary', {}, 'More reasons'),
      extra.length ? group(extra, 'Other suggestions') : null) : null);
}
// "Like this": paste (Ctrl+V), pick or photograph an example image. It is stored with the note in crops/ and goes to the agent in TASK.md.
function refPicker(ta, limit = 1, onError = e => toast(e)) {
  const R = { data: limit === 1 ? null : [], loading: 0 };
  const thumb = el('div', { class: 'refthumb', hidden: true });
  const del = i => el('button', { class: 'ghost sq sm', title: 'Remove example', 'aria-label': 'Remove example', onclick: e => { e.stopPropagation(); set(limit === 1 ? null : R.data.filter((_, n) => n !== i)); } }, icon('x', 14));
  const set = data => { R.data = data;
    if (limit === 1) { thumb.hidden = !data; thumb.replaceChildren(...(data ? [el('img', { src: data, alt: 'Example' }), el('span', {}, 'Like this'), del(0)] : [])); placePop(); return; }
    thumb.hidden = !data.length; thumb.replaceChildren(...data.map((src, i) => el('span', { class: 'refthumb' }, el('img', { src, alt: 'Example' }), del(i)))); };
  const load = async file => { if (!file || !/^image\//.test(file.type)) return;
    if (limit > 1 && R.data.length + R.loading >= limit) return onError('Maximum ' + limit + ' examples.');
    R.loading++; try { const data = await shrinkImage(file); set(limit === 1 ? data : [...R.data, data]); } catch (e) { onError('Could not read this image.'); } finally { R.loading--; } };
  const inp = el('input', { type: 'file', accept: 'image/*', hidden: true, ...(limit > 1 ? { multiple: true } : {}), onchange: e => { [...e.target.files].forEach(load); e.target.value = ''; } });
  ta.addEventListener('paste', e => { const items = [...(e.clipboardData || {}).items || []].filter(x => x.type.startsWith('image/')); if (items.length) { e.preventDefault(); (limit === 1 ? items.slice(0, 1) : items).forEach(it => load(it.getAsFile())); } });
  R.button = el('button', { class: 'chipbtn', type: 'button', title: 'Add an example: paste (Ctrl+V), pick or take a photo of how it should look', onclick: e => { e.stopPropagation(); inp.click(); } }, '🖼', el('span', {}, 'Example'), inp);
  R.thumb = thumb; R.set = set; return R;
}
function shrinkImage(file, max = 1600) {
  return new Promise((ok, bad) => { const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); ok(c.toDataURL('image/jpeg', 0.86)); };
    img.onerror = () => { URL.revokeObjectURL(u); bad(new Error('image')); }; img.src = u; });
}
async function uploadRef(n, data) {
  try { const r = await api('/api/ref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: S.asset, stage: S.stage, version: S.v, id: n.id, data }) }); n.ref = r.ref; changed(); renderSide(); }
  catch (e) { toast('Could not save the example: ' + e.message, 6000); }
}
// Speak a note: the browser records, the review pc turns it into text with a local Whisper model. The text lands in the box to check.
function micButton(ta, note) {
  if (!(S.info || {}).voice || !navigator.mediaDevices || !window.MediaRecorder) return null;
  const say = t => { b.lastChild.textContent = t; b.setAttribute('aria-label', t); };  // the label keeps the word when a phone shows only the icon
  const b = el('button', { class: 'chipbtn mic', 'aria-label': 'Dictate', title: 'Dictate: click, talk, click again', onclick: async e => {
    e.stopPropagation();
    if (b.rec) { b.rec.stop(); return; }
    const raw = !!(S.me && S.me.admin);  // admin notes keep unprocessed mic audio (owner request 2026-10-07)
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: raw ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } : true }); } catch (err) { toast('No access to the microphone.'); return; }
    const chunks = []; const rec = b.rec = new MediaRecorder(stream, raw ? { audioBitsPerSecond: 128000 } : undefined); rec.ondataavailable = x => chunks.push(x.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); b.rec = null; b.setAttribute('aria-pressed', 'false'); say('Transcribing…'); b.disabled = true;
      const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob(chunks, { type: rec.mimeType })); });
      if (CM.guest()) {
        if (new Blob(chunks).size > 2 * 1024 * 1024) { toast('Recording too large: 2 MB maximum.'); b.disabled = false; say('Dictate'); return; }
        if (note) { CM.voice(note, url); changed(); } else ta.voice = url;
      }
      try {
        const out = await api('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: url }) });
        if (out.text) { ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + out.text; ta.dispatchEvent(new Event('input')); ta.focus(); } else toast(out.error ? 'Transcription failed: ' + out.error : 'Nothing recognised.');
      } catch (err) { toast('Transcription failed: ' + err.message); }
      b.disabled = false; say('Dictate');
    };
    rec.start(); b.setAttribute('aria-pressed', 'true'); say('Stop');
  } }, '🎤', el('span', {}, 'Dictate'));
  return b;
}
function placePop() {
  const P = $('#pop');
  // held sideways the box shares the notes column's width (theme.css), from under the top bar down
  if (matchMedia(SIDEWAYS).matches) { P.style.left = P.style.top = P.style.maxHeight = ''; P.style.setProperty('--cd-pop-top', Math.round($('#bar').getBoundingClientRect().bottom) + 'px'); return; }
  if (matchMedia('(max-width:820px)').matches) { P.style.left = P.style.top = P.style.maxHeight = ''; return; }
  const side = $('#side').getBoundingClientRect();
  P.style.left = (side.left + 12) + 'px';
  P.style.top = (side.top + 12) + 'px';
  P.style.maxHeight = Math.max(160, side.height - $('#decide').offsetHeight - 24) + 'px';
}
function closeComposer() { const P = $('#pop'); if (P) { P.hidden = true; P.replaceChildren(); } S.adding = false; if (document.body.classList.contains('composing')) { document.body.classList.remove('composing'); syncComposerApproval(); } }
function cancelSel() { if (S.asset) localStorage.removeItem(unsentKey()); S.sel = null; closeComposer(); if (S.view && S.view.clearSelection) S.view.clearSelection(); }
function nextMark() { return S.review.notes.reduce((m, n) => Math.max(m, n.mark || 0), 0) + 1; }
function addNote(verdict, priority, text) {
  const mark = nextMark(); const f = verInfo().files[S.file].name;
  const guest = CM.guest(); const pgn = (S.sel.view && S.sel.view.pdfPage) || (S.view && S.view.pdfPage); const pg = pgn ? { page: pgn } : {};
  const n = { id: (guest ? 'C' : 'N') + mark, mark, verdict, priority, status: 'open', text: text.trim(), target: { file: f, ...pg, selector: S.sel.selector }, view: S.sel.view, created: new Date().toISOString() };
  if (verdict === 'approve') n.lock = true;
  const refData = S.composerRef && S.composerRef.data; S.composerRef = null;
  const voice = $('#pop textarea') && $('#pop textarea').voice;
  if (guest) { n.cid = crypto.randomUUID(); if (voice) CM.voice(n, voice); } // cid: one comment stays one comment when a save's answer is lost
  S.review.notes.push(n); S.sel = null; S.active = null; closeComposer();
  localStorage.removeItem(unsentKey());
  if (S.view && S.view.clearSelection) S.view.clearSelection();
  refreshMarks(); changed(); renderSide();
  if (guest) { n._new = true; CM.added(n, refData); } else if (refData) uploadRef(n, refData);
}

// ---------------- side panel ----------------
function pending() {
  const rv = S.review; const prevOpen = S.prev ? S.prev.notes.filter(n => n.verdict !== 'approve') : [];
  const st = n => ((rv.followups || []).find(f => f.id === 'v' + (S.v - 1) + ':' + n.id) || {}).status;
  return { prevOpen, st, fuDone: prevOpen.filter(n => st(n)).length, fuNo: prevOpen.filter(n => st(n) === 'reopened').length };
}
function renderSide() {
  const R = $('#sidescroll');
  if (!S.v) { R.replaceChildren(el('div', { class: 'quiet' }, 'No version to review yet.')); $('#decide').replaceChildren(); return; }
  const top = R.scrollTop;
  const ver = verInfo();
  const details = el('details', { class: 'fold', open: !!S.open.details, ontoggle: e => { S.open.details = e.target.open; } },
    el('summary', {}, 'Details'), el('div', { class: 'file', id: 'vinfo' }, S.view && S.view.info ? S.view.info() : ver.files[S.file].name), partsSection(), locksSection());
  let url = null; try { const u = new URL((ver.meta || {}).url); if (/^https?:$/.test(u.protocol)) url = u.href; } catch (e) { /* no page URL */ }
  R.replaceChildren(...[url ? el('a', { class: 'page-link mbtn', href: url, target: '_blank', rel: 'noopener' }, 'Open page ↗') : null,
    warnings(), followups(), fileList(ver), CM.section(), notesSection(), versionsSection(), rendersSection(),
    CM.guest() ? null : checklist(), evidenceOwner() ? null : delivered(), details].filter(Boolean));
  R.scrollTop = top; renderDecide(); requestAnimationFrame(measureClamps);
}
// R3I-018 begin
import { renderGltfReport } from './gltf-report.js';
const renderSideBeforeGltfReport = renderSide;
renderSide = function (...args) {
  const side = $('#sidescroll'), top = side.scrollTop;
  renderSideBeforeGltfReport.apply(this, args);
  if (!S.v) return;
  const report = renderGltfReport(verInfo().files[S.file], el);
  if (report) side.insertBefore(report, side.lastElementChild);
  side.scrollTop = top;
};
// R3I-018 end

function expandButton(key) {
  return el('button', { class: 'link', hidden: true, 'data-expand': key, 'aria-expanded': String(!!S.open[key]), onclick: () => { S.open[key] = !S.open[key]; renderSide(); } }, S.open[key] ? 'less' : 'more');
}
function measureClamps() {
  const R = $('#sidescroll');
  for (const button of R.querySelectorAll('[data-expand]')) {
    const text = $('[data-clamp="' + CSS.escape(button.dataset.expand) + '"]', R);
    const expanded = text.classList.contains('expanded');
    if (expanded) text.classList.remove('expanded');
    button.hidden = text.scrollHeight <= text.clientHeight;
    if (expanded) text.classList.add('expanded');
  }
}
function warnings() {
  if (CM.guest()) return null; // print and gate checks are for the owner
  const ver = verInfo(); const chips = []; const lc = ver.lock_check || []; const sc = ver.scope_check || {};
  if (ver.meta?.unverified) chips.push(['var(--amber)', 'Unverified: engine proof missing']);
  if (ver.gate) chips.push(['var(--red)', (ver.gate.skipped ? 'Gate skipped (' + ver.gate.skipped + '): ' : 'Held back by the gate: ') + ver.gate.blocked.join('; ')]);
  for (const f of ver.files) for (const w of ((f.preflight || {}).warn || [])) if (!w.startsWith('Engine unverified:')) chips.push(['var(--amber)', w]);
  const bad = lc.filter(c => c.result !== 'unchanged'); if (bad.length) chips.push(['var(--red)', bad.length + (bad.length === 1 ? ' locked spot changed' : ' locked spots changed')]);
  const outPct = sc.changed_outside_pct, outN = (sc.changed_nodes_outside || []).length;
  if (outPct > 0.5) chips.push(['var(--amber)', outPct.toFixed(1) + '% changed outside your notes']);
  if (outN) chips.push(['var(--amber)', outN + (outN === 1 ? ' part' : ' parts') + ' changed outside your notes']);
  if (!chips.length && (lc.length || outPct != null || sc.changed_nodes_outside)) chips.push(['var(--green)', 'Nothing changed outside your notes']);
  return chips.length ? el('section', { class: 'chips', 'aria-label': 'Checks on submit' }, chips.map(([c, t]) => el('div', { class: 'chip', style: { '--c': c } }, t))) : null;
}
function delivered() {
  const ver = verInfo();
  return el('section', { class: 'delivered' }, el('h3', {}, CM.guest() ? 'About this version' : 'Agent says'),
    CM.guest() ? el('div', { class: 'who' }, 'Posted ' + ago(ver.at)) : el('div', { class: 'who' }, el('b', {}, ver.by || 'agent'), ' submitted ' + ago(ver.at)),
    ver.note ? [el('p', { class: 'dnote' + (S.open.agent ? ' expanded' : ''), 'data-clamp': 'agent' }, ver.note), expandButton('agent')] : null);
}
function rendersSection() {
  if (verInfo().meta?.render) return renderPreview(S.asset, S.stage, verInfo());
  const renders = verInfo().files.filter(f => /\.glb$/i.test(f.name)).flatMap(f => ['turntable', 'poses'].map(k => dataUrl(S.asset, S.stage, S.v, 'renders/' + f.name + '.' + k + '.png')));
  return renders.length ? el('div', { class: 'renders' }, renders.map(src => el('img', { src, alt: 'Turntable views', title: 'Click to view large', loading: 'lazy', onerror: e => e.target.remove(), onclick: () => lightbox(src) }))) : null;
}
function renderPreview(asset, stage, ver, compact = false) {
  const render = ver.meta?.render; if (!render) return null;
  const label = {queued: 'Turntable views queued', running: 'Making turntable views', done: 'Turntable views ready', failed: 'Turntable views failed'}[render.status];
  const box = el('section', { class: 'render-preview', 'data-render-status': render.status },
    el('div', { class: 'cm', role: 'status' }, label));
  if (render.status === 'failed') box.append(el('pre', { class: 'render-error' }, render.log_tail || 'No render log available'));
  if (render.status === 'done') box.append(el('div', { class: 'renders' }, (render.previews || []).flatMap(p =>
    [...(compact ? [] : [p.sheet]), ...p.stills].map(name => {
      const src = dataUrl(asset, stage, ver.v, 'renders/' + render.hash + '/' + name);
      return el('img', { src, alt: name.endsWith('contact_sheet.png') ? 'Contact sheet' : 'Turntable view ' + name,
        loading: 'lazy', title: 'Click to view large', onclick: e => { e.stopPropagation(); lightbox(src); } });
    }))));
  return box;
}
function lightbox(src) { const d = el('dialog', { class: 'lightbox', onclick: () => d.close() }, el('img', { src })); d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); }
// Several files in one version (a set of sounds, sprites...): each file gets its own "Good" (lock) or "Redo" (change note on the whole file).
function fileVerdict(name) { return S.review.notes.find(n => (n.target || {}).file === name && ((n.target || {}).selector || {}).per_file); }
function fileLockedIn(name) { const l = (S.locks || []).find(({ n }) => (n.target || {}).file === name && ((n.target || {}).selector || {}).per_file); return l ? l.v : null; } // approved in an earlier version
function downloadFile(file, compact = false) {
  return el('a', { class: compact ? 'ghost sq fdownload' : 'tool file-download', href: dataUrl(S.asset, S.stage, S.v, file.name), download: file.name, title: 'Download ' + file.name, 'aria-label': 'Download ' + file.name }, icon('download', 16), compact ? null : el('span', { class: 'lbl' }, 'Download'));
}
function fileList(ver) {
  const vs = ver.files.map(f => fileVerdict(f.name)); const was = ver.files.map(f => fileLockedIn(f.name));
  const ok = vs.filter((n, i) => n ? n.verdict === 'approve' : was[i] != null).length, redo = vs.filter(n => n && n.verdict !== 'approve').length;
  return el('section', { class: 'files', 'aria-labelledby': 'files-title' },
    el('div', { class: 'section-head' }, el('h3', { id: 'files-title' }, 'File verdicts'),
      el('a', { class: 'mbtn download-all', href: withP('/api/zip?asset=' + encodeURIComponent(S.asset) + '&stage=' + encodeURIComponent(S.stage) + '&v=' + S.v), download: S.asset + '-' + S.stage + '-v' + pad3(S.v) + '.zip', title: 'Download everything in version ' + S.v }, icon('download', 16), 'Download all')),
    el('div', { class: 'fhead muted sm' }, (ver.files.length === 1 ? '1 file · ' : ver.files.length + ' files · ') + (locked() ? { approved: 'approved', changes: 'sent back', rejected: 'rejected' }[S.review.verdict] + ' with the version' : ok + ' good · ' + redo + ' redo · ' + (ver.files.length - ok - redo) + ' not judged yet')),
    allOkButton(ver, vs, was, redo),
    ver.files.map((f, i) => {
      const attachment = ver.files.some(x => x.media === 'audio') && f.media !== 'audio';
      const heading = attachment && !ver.files.slice(0, i).some(x => x.media !== 'audio') ? el('h3', { class: 'attachments' }, 'Attachments') : null;
      const n = vs[i]; const k = n ? (n.verdict === 'approve' ? 'ok' : 'redo') : was[i] != null ? 'ok' : ''; const more = S.review.notes.filter(x => (x.target || {}).file === f.name && x !== n).length;
      const cut = Math.max(0, f.name.slice(0, f.name.search(/[_-][^_-]*$/)).search(/[^_-]*$/)); // "kit_x_story_" + "ingotmould_v001.glb"
      return [heading, el('div', { class: 'frow' + (i === S.file ? ' cur' : '') + (k ? ' ' + k : '') },
        el('button', { class: 'fname', title: 'Open ' + f.name, onclick: async () => { S.autoNext = true; await showFile(i); if (matchMedia('(max-width:820px) and (orientation:portrait)').matches) scrollTo({ top: 0, behavior: 'smooth' }); } }, el('span', { class: 'fdot' }, k === 'ok' ? '✓' : k === 'redo' ? '↻' : locked() ? '✓' : ''), fileTypeIcon(f), el('span', { class: 'fn' }, el('span', {}, f.name.slice(0, cut)), el('span', {}, f.name.slice(cut))), more ? el('span', { class: 'pill' }, more) : null),
        downloadFile(f, true),
        !n && was[i] != null ? el('span', { class: 'muted sm', title: 'Approved in version ' + was[i] + '; stays locked' }, 'Already good (v' + was[i] + ')')
        : S.review.guest ? null : locked() ? el('span', { class: 'muted sm' }, k === 'ok' ? 'Good' : k === 'redo' ? 'Redo' : 'with version') : [
          el('button', { class: 'yn ok', title: 'This file is good: the agent may not change it anymore', 'aria-pressed': String(k === 'ok'), onclick: () => setFileVerdict(i, 'approve') }, icon('check', 14), 'Good'),
          el('button', { class: 'yn no', title: 'This file needs a redo', 'aria-pressed': String(k === 'redo'), onclick: () => setFileVerdict(i, 'change') }, '↻ Redo')])];
    }));
}
// One tap for every file that has no choice yet: "All good" (or "Rest good" next to files marked Redo). Each gets the same lock as its own Good.
function allOkButton(ver, vs, was, redo) {
  if (ver.files.length < 2 || locked() || S.review.guest) return null;
  const left = ver.files.filter((f, i) => !vs[i] && was[i] == null).length; if (!left) return null;
  return el('button', { class: 'mbtn allok', 'data-allok': '1', title: 'Mark ' + left + ' unjudged files as Good (locked for the agent)', onclick: setAllFilesOk }, icon('check', 16), (redo ? 'Rest good' : 'All good') + ' (' + left + ')');
}
function setAllFilesOk() {
  for (const f of verInfo().files) {
    if (fileVerdict(f.name) || fileLockedIn(f.name) != null) continue; const mark = nextMark();
    S.review.notes.push({ id: 'N' + mark, mark, verdict: 'approve', priority: 'med', status: 'open', text: 'Good, keep as is', lock: true, target: { file: f.name, selector: { type: 'whole', label: 'Whole file · ' + f.name, per_file: true } }, created: new Date().toISOString() });
  }
  S.active = null; refreshMarks(); changed(); renderSide();
}
// Reject asks why, in the footer itself: a reason chip sends at once; typed text sends with the button. Esc or Cancel goes back.
const REJECT_WHY = ['Does not match the photo', 'Wrong shape', 'Quality too low', 'Wrong style'];
function openReject() { if (S.busy || locked()) return; S.rejecting = true; renderDecide(); const c = $('#decide .rejchips button'); if (c) c.focus({ preventScroll: true }); }
function cancelReject() { S.rejecting = false; S.rejectText = ''; renderDecide(); }
function renderReject(F) {
  const rv = S.review; const typed = () => (S.rejectText || '').trim();
  const send = why => {
    if (!why && !typed()) { ta.focus(); return toast('Pick a reason or type what is wrong.', 3000); }
    const line = 'Rejected: ' + [why, typed()].filter(Boolean).join(' - '); let old = (rv.summary || '').trim();
    if (old.startsWith('Rejected: ') || old.startsWith('Afgekeurd: ')) old = old.split('\n\n').slice(1).join('\n\n'); // a retry replaces the reason line, keeps the rest
    rv.summary = old ? line + '\n\n' + old : line; S.rejecting = false; S.rejectText = ''; finalize('rejected');
  };
  const go = el('button', { class: 'primary red', 'data-decide': '1', 'aria-disabled': String(!typed()), title: 'Reject with the typed reason (Ctrl+Enter)', onclick: () => send('') }, icon('x'), 'Reject with this reason');
  const ta = el('textarea', { class: 'sum rejwhy', rows: '2', placeholder: 'Other: what is wrong?', 'aria-label': 'Your own reason', value: S.rejectText || '',
    oninput: e => { S.rejectText = e.target.value; grow(e.target); go.setAttribute('aria-disabled', String(!typed())); } });
  F.replaceChildren(el('div', { class: 'rejectbox', role: 'group', 'aria-label': 'Why reject?', onkeydown: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelReject(); } } },
    el('div', { class: 'rejhead' }, el('b', {}, 'Why reject?'), el('span', { class: 'muted sm' }, 'The agent starts over'), el('span', { class: 'grow' }), el('button', { class: 'ghost sm', onclick: cancelReject }, 'Cancel')),
    el('div', { class: 'rejchips' }, REJECT_WHY.map(w => el('button', { class: 'chipbtn rej', 'data-why': w, onclick: () => send(w) }, w)), el('button', { class: 'chipbtn rej other', onclick: () => ta.focus() }, 'Other…')),
    ta, go));
}
async function setFileVerdict(i, kind) {
  const files = verInfo().files; const name = files[i].name; const old = fileVerdict(name); let n = null;
  if (old) S.review.notes.splice(S.review.notes.indexOf(old), 1);
  if (!old || old.verdict !== kind) { // a second click on the same choice clears it
    const mark = nextMark();
    n = { id: 'N' + mark, mark, verdict: kind, priority: 'med', status: 'open', text: kind === 'approve' ? 'Good, keep as is' : 'Redo', target: { file: name, selector: { type: 'whole', label: 'Whole file · ' + name, per_file: true } }, created: new Date().toISOString() };
    if (kind === 'approve') n.lock = true;
    S.review.notes.push(n);
  }
  S.active = n && kind === 'change' ? n.id : null; refreshMarks(); changed();
  if (n && kind === 'approve' && i === S.file) { // next file without a choice
    const nx = [...files.keys()].map(d => (i + 1 + d) % files.length).find(j => !fileVerdict(files[j].name) && fileLockedIn(files[j].name) == null);
    if (nx != null && nx !== i) { S.autoNext = true; return showFile(nx); }
  }
  renderSide();
  const ta = n && kind === 'change' && $('#sidescroll .note.act textarea'); // type what must change, or keep "Redo"; never scroll the file list away
  if (ta) { const a = ta.getBoundingClientRect(), b = $('#sidescroll').getBoundingClientRect(); if (a.top >= Math.max(b.top, 0) && a.bottom <= Math.min(b.bottom, innerHeight)) { ta.focus({ preventScroll: true }); ta.select(); } } // on a phone the page scrolls, not the panel
}
function followups() {
  const pd = pending(); if (!S.prev || !pd.prevOpen.length) return null;
  const ver = verInfo(); const resp = ver.responses || {}; const res = ver.resolves || []; const rv = S.review;
  // Yes / No stay clickable after sending: on a sent version a click reopens the decision (Edit), so the answer goes out with the next send
  const set = (n, k) => { if (locked()) { if (!isLatest()) return; S.editing = true; renderBar(); } const id = 'v' + (S.v - 1) + ':' + n.id; const was = pd.st(n); rv.followups = (rv.followups || []).filter(f => f.id !== id); if (was !== k) rv.followups.push({ id, status: k, text: n.text, target: n.target }); changed(); renderSide(); };
  return el('section', { class: 'followups' }, el('h3', {}, 'Is this fixed?', el('span', { class: 'cnt' }, pd.fuDone + ' of ' + pd.prevOpen.length)),
    !locked() && pd.fuDone < pd.prevOpen.length ? el('p', { class: 'muted sm' }, 'Approving counts the unanswered questions as fixed.') : null,
    pd.prevOpen.map(n => { const st = pd.st(n);
      return el('div', { class: 'fu' + (st ? ' ' + st : '') },
        el('div', { class: 'fu-top' }, el('span', { class: 'num', style: { '--c': VERDICT[n.verdict][1] } }, n.mark), el('p', {}, n.text),
          locked() && !isLatest() ? el('span', { class: 'muted sm' }, st === 'confirmed' ? 'Yes' : st === 'reopened' ? 'No' : 'Not answered') : [
          el('button', { class: 'yn yes', 'aria-pressed': String(st === 'confirmed'), onclick: () => set(n, 'confirmed') }, icon('check', 15), 'Yes'),
          el('button', { class: 'yn no', 'aria-pressed': String(st === 'reopened'), onclick: () => set(n, 'reopened') }, icon('x', 15), 'No')]),
        el('p', { class: 'resp' + (res.includes(n.id) ? '' : ' none') + (S.open['fu:' + n.id] ? ' expanded' : ''), 'data-clamp': 'fu:' + n.id }, res.includes(n.id) ? (resp[n.id] || 'The agent reports this as fixed.') : 'The agent does not report this as fixed.'),
        el('div', { class: 'fu-act' }, el('button', { class: 'ghost sm', title: 'Show both versions at this spot', onclick: () => showFollowup(n) }, icon('eye', 16), 'View'),
          expandButton('fu:' + n.id)));
    }));
}
// Version history for the right panel: newest first, thumbnail + verdict dot, click opens that version.
// A commenter sees which versions exist, never earlier verdicts or agent words (same rule as the review itself).
function versionsSection() {
  const st = stageInfo(S.asset, S.stage); if (!st) return null;
  const verdicts = !CM.guest();
  const word = SENT;
  return el('section', { class: 'versions' }, el('h3', {}, 'Versions', el('span', { class: 'cnt' }, st.versions.length)),
    el('ol', { class: 'vlist' }, st.versions.slice().reverse().slice(0, 8).map(x => { const th = thumbOf(S.asset, S.stage, x), cur = x.v === S.v;
      return el('li', {}, el('button', { class: 'vitem' + (cur ? ' cur' : ''), 'aria-current': cur ? 'true' : null, 'data-reviewed': verdicts ? x.reviewed || 'open' : null, title: 'Open version ' + x.v, onclick: () => pick(S.asset, S.stage, x.v) },
        el('span', { class: 'vthumb', style: th ? { backgroundImage: 'url("' + th + '")' } : {} }, th ? null : icon('eye', 20)),
        el('span', { class: 'vtxt' }, el('b', {}, 'v' + x.v, x.v === st.versions.length ? el('i', {}, 'newest') : null), el('span', {}, (verdicts ? (word[x.reviewed] || 'Waiting for you') + ' · ' : '') + ago(x.at)))));
    })));
}
function notesSection() {
  const ns = S.review.notes; const touch = matchMedia('(hover: none)').matches;
  const general = locked() ? null : el('button', { class: 'link', title: 'A note about the whole version, without pointing at anything', onclick: () => { S.lastPt = null; select({ type: 'whole', label: 'Whole version' }); } }, '+ General note');
  const how = S.view instanceof ImageView && S.view.partsDoc ? (touch ? 'Tap a part. Use "+ Part" to add more.' : 'Detected parts light up when you hover over them. Shift+click adds more.')
    : S.view instanceof ModelView ? (touch ? 'Tap a part. Drag to rotate the model.' : 'Parts light up when you hover over them. Shift+click adds more. Drag to rotate the model.') : '';
  return el('section', { class: 'pins' }, el('h3', {}, CM.guest() ? 'Your notes' : 'Notes', ns.length ? el('span', { class: 'cnt' }, ns.length) : null),
    ns.length ? (CM.guest() ? CM.filtered(ns, n => !n.status || n.status === 'open', 'notes', noteRow) : el('ol', { class: 'notes' }, ns.map(noteRow))) : el('div', { class: 'hint' }, locked() ? 'No notes on this version.' :
      [el('p', {}, S.view instanceof TextView ? (touch ? 'Tap a paragraph, line or cell' : 'Click a paragraph, line or cell, or select words,') + ' and say what should change.' : (touch ? 'Tap' : 'Point at') + ' something in the view and say what should change.'), how ? el('p', { class: 'muted' }, how) : null]), general);
}
function noteRow(n) {
  const act = S.active === n.id; const c = VERDICT[n.verdict][1]; const off = !!(S.review.guest && n.status && n.status !== 'open');
  const del = e => { e.stopPropagation(); if (off) return toast('Handled notes stay saved with the decision.', 5000); const i = S.review.notes.indexOf(n); S.review.notes.splice(i, 1); if (S.active === n.id) S.active = null; refreshMarks(); changed(); renderSide(); toast('Note ' + n.mark + ' deleted.', 6000, ['Undo', () => { S.review.notes.splice(i, 0, n); refreshMarks(); changed(); renderSide(); }]); };
  return el('li', { class: 'note' + (act ? ' act' : '') + (off ? ' off' : ''), style: { '--c': c }, onclick: () => focusNote(n) },
    el('span', { class: 'num' }, n.verdict === 'approve' ? icon('lock', 13) : n.mark),
    el('div', { class: 'nb' }, el('div', { class: 'tg' }, describe(n.target), n.view?.asset ? el('b', { class: 'fromtag' }, 'made on v' + n.view.asset.version) : null, n.priority === 'high' ? el('b', { class: 'hi' }, 'Important') : null, n.verdict === 'approve' ? el('b', { class: 'ok' }, 'Keep as is') : null,
        n.from ? el('b', { class: 'fromtag' }, 'from ' + n.from.name) : null, off ? el('b', { class: 'gstate' }, n.status === 'adopted' ? 'Adopted by the owner' : 'Not adopted') : null),
      act && !locked() && !off ? (() => { const ta = el('textarea', { value: n.text, 'aria-label': 'Text of note ' + n.mark, oninput: e => { n.text = e.target.value; grow(e.target); changed(); }, onclick: e => e.stopPropagation() }); return [ta, micButton(ta, n)]; })() : el('p', {}, n.text),
      off && n.reason ? el('p', { class: 'greason' }, 'Reason: ' + n.reason) : null,
      n.voice ? el('audio', { class: 'note-voice', 'data-voice': n.voice, controls: '', preload: 'metadata', src: (S.cfiles || {})[n.voice] || dataUrl(S.asset, S.stage, S.v, n.voice), 'aria-label': 'Voice note', onclick: e => e.stopPropagation() }) : null,
      n.ref ? el('a', { class: 'nref', href: dataUrl(S.asset, S.stage, S.v, n.ref), target: '_blank', title: 'Example: like this', onclick: e => e.stopPropagation() }, el('img', { src: dataUrl(S.asset, S.stage, S.v, n.ref), alt: 'Example' }), 'Like this') : null),
    locked() || off ? el('span', { class: 'muted sm', title: off ? 'Handled notes stay saved with the decision.' : '' }, off ? 'Saved with decision' : '') : el('button', { class: 'ghost sq sm x', title: 'Delete', 'aria-label': 'Delete note ' + n.mark, onclick: del }, icon('trash', 15)));
}
function partsSection() {
  const pl = S.view && S.view.partList ? S.view.partList() : [];
  if (!pl.length) return S.partsState === 'running' ? el('p', { class: 'muted sm busy' }, el('span', { class: 'spin' }), 'Detecting parts…')
    : S.partsState === 'error' ? el('p', { class: 'muted sm' }, 'No parts detected · click = point, Shift+drag = box') : null;
  const d = el('details', { class: 'fold', open: !!S.open.parts, ontoggle: e => { S.open.parts = e.target.open; } },
    el('summary', {}, icon('spark', 14), 'Detected', el('span', { class: 'cnt' }, pl.reduce((a, p) => a + (p.count || 1), 0))),
    el('div', { class: 'pchips' }, pl.map(p => el('button', { class: 'pchip', title: 'Click: point. Shift+click: add to the open note', onpointerenter: () => S.view.hoverPart(p.id), onpointerleave: () => S.view.hoverPart(null), onclick: e => S.view.selectPart(p.id, e.shiftKey || e.ctrlKey || e.metaKey || !!S.adding) }, p.label, p.count > 1 ? el('span', {}, p.count) : null))));
  return d;
}
function locksSection() {
  if (!S.locks || !S.locks.length) return null;
  return el('details', { class: 'fold', open: !!S.open.locks, ontoggle: e => { S.open.locks = e.target.open; } }, el('summary', {}, icon('lock', 14), 'Stays as is', el('span', { class: 'cnt' }, S.locks.length)),
    el('ul', { class: 'locks' }, S.locks.map(({ v, n }) => el('li', {}, el('b', {}, describe(n.target)), ' ' + n.text, el('span', { class: 'muted' }, ' · version ' + v)))));
}
function checklist() {
  const s = stageDef(); const rv = S.review;
  // older reviews store ticks under the Dutch item text: read and write the key that already holds the tick
  const key = c => checklistKey(c, rv.checklist);
  const seen = s.checks.filter(c => rv.checklist[key(c)]).length;
  return el('details', { class: 'fold checklist', open: S.open.chk == null ? !locked() : S.open.chk, ontoggle: e => { S.open.chk = e.target.open; } }, el('summary', {}, icon('check', 14), 'Checklist', el('span', { class: 'cnt' }, locked() && !seen ? 'not filled in' : seen + ' / ' + s.checks.length)),
    s.checks.map(c => { const kc = key(c), v = rv.checklist[kc] || ''; const set = k => { if (locked()) return; if (rv.checklist[kc] === k) delete rv.checklist[kc]; else rv.checklist[kc] = k; changed(); renderSide(); };
      return el('div', { class: 'chk' }, el('span', {}, c), el('div', { class: 'seg' }, [['ok', 'check', 'Passes'], ['fail', 'x', 'Fails'], ['na', null, 'Not applicable']].map(([k, ic, tip]) => el('button', { class: 'yn ' + k, title: tip, 'aria-label': tip, 'aria-pressed': String(v === k), onclick: () => set(k) }, ic ? icon(ic, 15) : 'n/a')))); }));
}
// An owner who is not the admin can ask the admin for feedback on a version. The admin sees the question and closes it; the owner sees where it stands.
const feedbackPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: S.asset, stage: S.stage, version: S.v, ...body }) });
function feedbackBlock(canAsk) {
  const ver = verInfo() || {}, fb = ver.feedback; S.fbShown = JSON.stringify(fb || null);
  // The rev says which question the admin answered: when the owner changed it meanwhile, the server refuses (409) and the new question shows here.
  const done = async e => { const b = e.currentTarget; b.disabled = true;
    try { await feedbackPost('/api/feedback/done', { rev: fb.rev || 0 }); toast('Feedback given.'); await refreshCatalog(); }
    catch (x) { if (x.status !== 409 || !x.body || !x.body.current) { b.disabled = false; return toast('That did not work: ' + x.message, 6000); }
      ver.feedback = x.body.current; if (verInfo() === ver) renderDecide(); toast((fb.name || 'The owner') + ' just changed the question. Read the new question.', 7000); } };
  if (CM.can('execute')) return fb && fb.status === 'open' ? el('div', { class: 'fbbox', role: 'status' }, el('p', {}, el('b', {}, (fb.name || 'Someone') + ' asks for your feedback' + (fb.text ? ': ' : '')), fb.text),
    el('button', { class: 'ghost sm fbdone', onclick: done }, 'Feedback given')) : null;
  if (!CM.can('decide')) return null;
  const open = fb && fb.status === 'open';
  return el('div', { class: 'fbbox' }, fb ? el('p', { class: 'muted sm', role: 'status' }, open ? 'Feedback requested · waiting for the owner' : 'The owner gave feedback') : null,
    canAsk ? el('button', { class: 'ghost sm fbask', onclick: askFeedback }, open ? 'Change question' : fb ? 'Ask again' : 'Ask the owner for feedback') : null);
}
function askFeedback() {
  const fb = (verInfo() || {}).feedback, open = fb && fb.status === 'open';
  const text = el('textarea', { class: 'sum', rows: '3', maxlength: '500', 'aria-label': 'Your question for the owner', placeholder: 'What should the owner look at? (optional)', value: open ? fb.text || '' : '' });
  const error = el('p', { class: 'studio-error', role: 'alert' });
  const send = el('button', { class: 'primary', onclick: async () => {
    send.disabled = true; error.textContent = '';
    try { await feedbackPost('/api/feedback', { text: text.value }); d.close(); toast('The owner sees your question under Today.'); await refreshCatalog(); } catch (e) { error.textContent = 'Could not send: ' + e.message; send.disabled = false; }
  } }, open ? 'Change question' : 'Ask the owner');
  const d = el('dialog', { class: 'rounddlg', 'aria-labelledby': 'fb-heading' }, el('h2', { id: 'fb-heading' }, 'Ask the owner for feedback'),
    el('p', { class: 'muted sm' }, 'They see your question under Today. You decide what to do with their notes.'), text, error,
    el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Cancel'), el('span', { class: 'grow' }), send));
  d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); text.focus();
}
function renderDecide() {
  const F = $('#decide'); const rv = S.review; if (!rv) { F.replaceChildren(); return; }
  if (!isLatest()) { F.replaceChildren(feedbackBlock(false), el('p', { class: 'muted' }, 'You are viewing an older version.'), el('button', { class: 'primary', onclick: () => pick(S.asset, S.stage) }, 'Go to the newest version')); return; }
  if (rv.guest) return guestDecide(F);
  if (S.rejecting && !locked()) return renderReject(F);
  const q = queue().filter(x => !(x.id === S.asset && x.s.id === S.stage));
  if (locked()) {
    const k = { approved: 'approve', changes: 'change', rejected: 'reject' }[rv.verdict];
    F.replaceChildren(feedbackBlock(true), el('div', { class: 'sent', style: { '--c': verInfo()?.meta?.unverified ? 'var(--amber)' : VERDICT[k][1] } }, el('span', { class: 'dot' }, icon(verInfo()?.meta?.unverified ? 'help' : rv.verdict === 'approved' ? 'check' : rv.verdict === 'rejected' ? 'x' : 'send', 16)),
        el('div', { class: 'grow' }, el('b', {}, (verInfo()?.meta?.unverified ? 'Unverified' : SENT[rv.verdict]) + (autoName(rv) ? ' · ' + autoName(rv) : '')), el('span', { class: 'muted sm' }, ' · ' + hhmm(rv.updated))),
        el('button', { class: 'ghost sm', 'data-edit': '1', onclick: () => { S.editing = true; renderSide(); renderBar(); } }, 'Edit')),
      autoLine(rv),
      binButton(),
      q.length ? el('button', { class: 'primary', onclick: () => step(1) }, 'Next waiting', el('span', { class: 'pill' }, q.length), icon('next')) : el('button', { class: 'primary quiet', onclick: showHome }, 'Back to overview'));
    decisionMenu(); return;
  }
  // everything that asks the agent for work: open notes, follow-ups answered "No" and checks marked "Fails"
  const pd = pending(); const open = rv.notes.filter(n => n.verdict !== 'approve' && n.status === 'open').length; const fails = Object.values(rv.checklist).filter(x => x === 'fail').length;
  const back = open + pd.fuNo + fails; const unanswered = pd.prevOpen.length - pd.fuDone;
  const why = [open && open + ' open note' + (open > 1 ? 's' : ''), pd.fuNo && pd.fuNo + ' not fixed', fails && fails + ' check' + (fails > 1 ? 's' : '') + ' failed'].filter(Boolean).join(', ');
  // Three choices are always visible: Approve, Change (back to the agent; without notes it asks what should change) and Reject. Later skips without deciding.
  const mandate = autoChoice(rv);
  const want = !back && (S.wantChange || !!mandate); const hasTxt = !!(rv.summary || '').trim() || !!mandate;
  const sendLabel = hasPro() ? 'Back to agent' : 'Request changes';
  // data-decide marks the decision itself: Ctrl+Enter and finalize use it, never another primary button in the panel
  const primary = back ? el('button', { class: 'primary amber', 'data-decide': '1', title: why + ' (Ctrl+Enter)', onclick: () => finalize('changes') }, icon('send'), sendLabel, el('span', { class: 'pill' }, back))
    : want ? el('button', { class: 'primary amber', 'data-decide': '1', 'aria-disabled': String(!hasTxt), title: hasTxt ? 'Ctrl+Enter' : 'First write what should change', onclick: () => finalize('changes') }, icon('send'), sendLabel)
    : el('button', { class: 'primary green', 'data-decide': '1', 'data-approve': '', title: 'Ctrl+Enter', onclick: () => finalize('approved') }, icon('check'), 'Approve');
  const decisionHint = back ? 'Approval paused: ' + why + '.' : want ? 'Write what should change first.' :
    !want && unanswered ? 'Approval also confirms ' + unanswered + (unanswered === 1 ? ' open fix.' : ' open fixes.') : '';
  const sumOpen = S.sumOpen || rv.summary || want;
  const grp = (S.cat.assets[S.asset] || {}).choice; const opts = grp ? (choiceGroups()[grp] || []) : [];
  const autoRow = !hasPro() ? null : el('div', { class: 'autorow' }, el('span', { class: 'muted sm' }, 'Let the agent:'),
    ...Object.entries(AUTO).map(([k, [label, ic, tip]]) => el('button', { class: 'chipbtn hi', 'aria-pressed': String(rv.auto === k), title: tip, onclick: () => setAuto(k) }, icon(ic, 14), label)));
  F.replaceChildren(feedbackBlock(true),
    opts.some(it => it.id === S.asset && it.s.id === S.stage) ? el('button', { class: 'primary quiet', title: 'All options side by side, with a slider to compare', onclick: () => showChoice(grp) }, icon('compare'), 'Pick 1 of ' + opts.length + ': ' + choiceTitle(grp)) : null,
    autoRow,
    sumOpen ? el('textarea', { class: 'sum', rows: '2', placeholder: mandate ? 'Extra direction for the agent (optional)' : want ? 'What should change? (required to send back)' : 'Review summary (optional)', value: rv.summary || '',
      oninput: e => { rv.summary = e.target.value; grow(e.target); changed(); const b = $('#decide .primary.amber'); if (want && b) { const missing = !e.target.value.trim() && !mandate; b.setAttribute('aria-disabled', String(missing)); b.title = missing ? 'First write what should change' : 'Ctrl+Enter'; $('#decision-note').hidden = !missing; } } }) : '',
    primary,
    el('p', { id: 'decision-note', class: 'muted sm decision-note', role: 'status', hidden: !decisionHint || want && hasTxt ? true : null }, decisionHint),
    !back && !want ? el('p', { id: 'composer-decision-note', class: 'muted sm decision-note', role: 'status', hidden: true }, 'Post or close the note to approve.') : null,
    el('div', { class: 'choices' },
      back ? null : want ? el('button', { class: 'ghost sm green', title: 'Approve anyway', onclick: () => { S.wantChange = false; if (rv.auto) { delete rv.auto; changed(); } renderDecide(); } }, icon('check', 15), 'Approve')
        : el('button', { class: 'ghost sm amber', title: 'Say what should change, or point at something in the view', onclick: () => { S.wantChange = true; revealSummary(); } }, icon('send', 15), 'Change'),
      el('button', { class: 'ghost sm red', 'data-reject-open': '1', title: 'Reject the whole version and say why', onclick: openReject }, icon('x', 15), 'Reject'),
      binButton(),
      // Later is always there; when nothing else waits it goes back to the overview
      el('button', { class: 'ghost sm', title: q.length ? 'Decide later: go to the next waiting (N)' : 'Decide later: back to the overview', onclick: () => q.length ? step(1) : showHome() }, 'Later', icon('next', 15))),
    el('div', { class: 'drow' }, sumOpen ? null : el('button', { class: 'link', onclick: () => revealSummary() }, '+ Summary'),
      el('span', { class: 'saved', id: 'saved' }, savedText()), el('span', { class: 'grow' })));
  decisionMenu(); syncComposerApproval();
}
function syncComposerApproval() {
  const button = $('#decide [data-approve]'); if (!button || S.busy) return;
  const blocked = !$('#pop').hidden;
  const hint = $('#decision-note'), composerHint = $('#composer-decision-note');
  button.disabled = blocked;
  composerHint.hidden = !blocked;
  hint.hidden = blocked || !hint.textContent;
  if (blocked || !hint.hidden) button.setAttribute('aria-describedby', blocked ? composerHint.id : hint.id);
  else button.removeAttribute('aria-describedby');
}
// A commenter has no decision: only the saved state of her comments and the way to the next version.
function guestDecide(F) {
  const q = gqueue().filter(x => !(x.id === S.asset && x.p === hereId()) && (S.showAll || !x.seen));
  F.replaceChildren(el('p', { class: 'guestline', id: 'saved', role: 'status' }, CM.savedLine()),
    q.length ? el('button', { class: 'primary', onclick: () => step(1) }, 'Next', el('span', { class: 'pill' }, q.length), icon('next')) : el('button', { class: 'primary quiet', onclick: showHome }, 'Back to overview'));
}
function decisionMenu() {
  const phone = matchMedia('(max-width:820px) and (orientation:portrait)').matches;
  const F = $('#decide'), row = $('.drow', F);
  if (!phone) {
    // Desktop keeps Approve, Change, Reject and Later in view; Discard and the agent mandates open under More. A chosen mandate keeps it open.
    const ch = $('.choices', F), auto = $('.autorow', F), bin = ch && $('[data-bin]', ch); if (!ch || !bin) return;
    const open = !!S.moreOpen || !!autoChoice(S.review);
    const extra = el('div', { class: 'decision-extra', id: 'decision-extra' }, auto, bin); extra.hidden = !open;
    ch.append(el('button', { class: 'ghost sm morebtn', 'aria-expanded': String(open), 'aria-controls': 'decision-extra', title: auto ? 'Discard, or let the agent improve it' : 'Discard this asset',
      onclick: e => { S.moreOpen = extra.hidden; extra.hidden = !S.moreOpen; e.currentTarget.setAttribute('aria-expanded', String(S.moreOpen)); } }, 'More'));
    ch.after(extra); return;
  }
  const gj = CM.jump(); if (gj) F.prepend(gj);
  // Discard and Later share the first line of the sheet, so they show as soon as it opens
  const ends = [...document.querySelectorAll('#decide .choices [data-bin], #decide .choices button[title*="Decide later"]')];
  const content = [ends.length ? el('div', { class: 'endrow' }, ends) : null, row && $('.link:not([data-reject])', row), $('.fbask', F), $('.autorow', F), $('.sum', F), $('[data-reject]', F), $('[data-edit]', F)].filter(Boolean);
  if (!content.length) return;
  // on a short phone the open sheet (or, for a web item whose sheet grows with the page, the page) scrolls just far enough to show that line
  const reveal = () => requestAnimationFrame(() => { const r = $('.endrow', F), over = r ? r.getBoundingClientRect().bottom + 8 - Math.min(F.getBoundingClientRect().bottom, innerHeight) : 0;
    if (over > 0) F.scrollHeight > F.clientHeight + 1 ? F.scrollTop += over : scrollBy(0, over); });
  const menu = el('details', { class: 'decision-more', open: !!S.sumOpen, ontoggle: e => { S.sumOpen = e.currentTarget.open; if (S.sumOpen) reveal(); } }, el('summary', { 'aria-label': 'More actions' }, 'More actions'), el('div', { class: 'decision-options' }, content));
  F.append(menu);
}
function revealSummary(message) {
  S.sumOpen = true; renderDecide(); const t = $('#decide .sum');
  if (t) { t.focus({ preventScroll: true }); t.scrollIntoView({ block: 'nearest' }); }
  if (message) toast(message, 4000);
}
// A second click on the same choice clears it; choosing one turns the decision into "Back to agent".
function setAuto(k) {
  if (!hasPro()) return;
  const rv = S.review; if (rv.auto === k) { delete rv.auto; if (!(rv.summary || '').trim()) S.wantChange = false; } else { rv.auto = k; S.wantChange = true; }
  changed(); renderDecide();
}
function savedText() { const rv = S.review; if (rv && rv.guest) return CM.savedLine(); return S.pendingSave ? 'Saving…' : rv && rv.updated && rv.draft ? 'Saved ' + hhmm(rv.updated) : ''; }
// What the autopilot did with this decision: woke the agent that made the asset, or why it did not.
function autoLine(rv) {
  if (!hasPro()) return null;
  const st = stageInfo(S.asset, S.stage) || {}; const au = st.auto && st.auto.v === S.v ? st.auto : null;
  if (!au) return null;
  const failure = ['failed', 'gave_up', 'limit'].includes(au.result);
  const t = { failed: 'Could not wake the agent; retrying', gave_up: 'Could not wake the agent: start the agent yourself',
    limit: 'Stopped after ' + (au.max ? au.max + ' rounds' : 'too many rounds') + ': please take a look', no_thread: rv.verdict === 'approved' ? null : 'No agent linked: start the agent yourself' }[au.result];
  return t ? el('p', { class: 'muted sm autoline' + (failure ? ' failed' : '') }, t) : null;
}
async function focusNote(n) {
  const origin = n.view && n.view.asset;
  if (origin && (origin.version !== S.v || origin.stage !== S.stage || origin.id !== S.asset)) await pick(origin.id, origin.stage, origin.version);
  S.active = n.id;
  const i = verInfo().files.findIndex(f => f.name === (n.target || {}).file);
  if (i >= 0 && i !== S.file) { S.file = i; destroyViews(); await mountViews(); }
  if (S.view.focus) await S.view.focus(n);
  refreshMarks(); renderSide();
}
// Put both versions on the spot of an old note, so the reviewer can judge the fix without hunting.
async function showFollowup(n) {
  if (!S.compare || S.cmpWith || S.inspectCompare || S.cmpMode !== 'side') { S.compare = true; S.cmpWith = null; S.inspectCompare = null; S.cmpMode = 'side'; destroyViews(); await mountViews(); }
  if (S.cmp) { S.cmp.marks(S.prev.notes.filter(x => (x.target || {}).file === S.cmp.file.name), n.id); if (S.cmp.focus) await S.cmp.focus(n); }
  if (S.view.ghost) S.view.ghost(n); if (S.view.focus) await S.view.focus(n, true);
}

// ---------------- saving: drafts save themselves, the decision sends ----------------
function changed() { S.gen = (S.gen || 0) + 1; S.pendingSave = S.unconfirmed = true; keepDraft(); clearTimeout(S.saveT); S.saveT = setTimeout(() => postDraft().catch(() => {}), 800); const s = $('#saved'); if (s) s.textContent = 'Saving…'; if (isFinal(S.review)) { S.review.draft = true; S.review.verdict = 'pending'; renderBar(); } }
async function postDraft(leaving) {
  if (S.saving && !leaving) { await S.saving; if (!S.pendingSave) return; }
  if (!S.pendingSave || !S.review) return; keepDraft(); if (S.review.guest) return CM.save(leaving); S.pendingSave = false; clearTimeout(S.saveT);
  const rv = Object.assign(withoutCoreMandate(S.review), { asset: S.asset, stage: S.stage, version: S.v, reviewer: REVIEWER, draft: true, verdict: 'pending' });
  if (leaving) { try { fetch(withP('/api/review'), { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review: rv, files: {}, base_rev: baseRev(rv) }) }).catch(() => {}); } catch (e) { /* the tab is closing */ } return; } // survives a closed phone tab
  const sent = baseOf(rv), g = S.gen;
  S.saving = postReview(rv, {}, baseRev(rv));
  try { const out = await S.saving; rv.updated = new Date().toISOString(); if (out && out.rev != null) rv.rev = out.rev; S.base = sent; if (!confirmed(g)) { clearTimeout(S.saveT); S.saveT = setTimeout(resend, 300); } }
  catch (e) { if (e.status === 409 && e.body && e.body.conflict) return reviewConflict(rv, e.body.current); S.pendingSave = true; toast('Could not save (' + e.message + '). Retrying shortly.', 5000); keepDraft(); S.saveT = setTimeout(() => { if (S.review === rv) postDraft().catch(() => {}); }, 4000); throw e; }
  finally { S.saving = null; }
  const s = $('#saved'); if (s) s.textContent = savedText();
}
function reviewConflict(mine, cur) {
  toast(CONFLICT, 7000); cur = mergeReview(mine, cur);
  S.review = cur; S.gen = (S.gen || 0) + 1; S.pendingSave = S.unconfirmed = true; refreshMarks(); renderSide(); clearTimeout(S.saveT); keepDraft(); S.saveT = setTimeout(() => { if (S.review === cur) postDraft().catch(() => {}); }, 300);
}
// Two screens saved the same review: take the newer one from the server and lay back only what changed on this screen since the last save
// (notes compared per id), so two screens that edit different notes keep each other's work. Then save again.
function mergeReview(mine, cur) {
  cur = Object.assign({ notes: [], checklist: {}, followups: [], summary: '' }, cur || {});
  const base = S.base || baseOf({}); const server = baseOf(cur);
  cur.notes = RS.merge(cur.notes || [], mine.notes || [], base.notes, { renumber: (n, mark) => { n.mark = mark; n.id = 'N' + mark; } });
  cur.followups = RS.merge(cur.followups || [], mine.followups || [], base.followups || new Map());
  const bc = JSON.parse(base.checklist || '{}'), mc = mine.checklist || {}; cur.checklist = { ...(cur.checklist || {}) };
  for (const k of new Set([...Object.keys(mc), ...Object.keys(bc)])) if (mc[k] !== bc[k]) { if (mc[k] === undefined) delete cur.checklist[k]; else cur.checklist[k] = mc[k]; }
  const mySum = mine.summary || ''; // the summary only comes back when it changed here
  if (mySum.trim() && mySum !== base.summary && mySum !== cur.summary) cur.summary = !cur.summary || cur.summary === base.summary ? mySum : cur.summary + '\n\n' + mySum;
  if (mine.auto && !cur.auto) cur.auto = mine.auto;
  S.base = server; return cur;
}
async function flushSave() { if (S.saving) await S.saving; if (CM.saving) await CM.saving; if (S.pendingSave) await postDraft(); }
// A decision must start from the rev the last draft save got back: wait for a save that is still on its way (2026-10-29: the first tap on
// "Back to agent" right after placing a note raced the 800 ms autosave and was refused with the conflict message).
async function settleSaves() { for (let i = 0; i < 3 && S.saving; i++) { try { await S.saving; } catch (e) { /* the decision reports its own errors */ } } clearTimeout(S.saveT); S.pendingSave = false; }
async function makeCrops() {
  const files = {}; const ver = verInfo();
  for (const n of S.review.notes) {
    const fi = ver.files.findIndex(f => f.name === (n.target || {}).file);
    if ((fi < 0 ? 0 : fi) !== S.file) { S.file = fi < 0 ? 0 : fi; destroyViews(); await mountViews(); }
    if (!S.view || !S.view.capture) continue; // a file that did not load gets no crops; the note text still goes out
    const cap = await S.view.capture(n, S.review.notes.filter(x => (x.target || {}).file === ver.files[S.file].name));
    for (const k of ['crop', 'strip', 'context', 'clip']) { if (!cap[k]) { delete n[k]; continue; } n[k] = 'crops/' + n.id + (k === 'crop' ? '' : '_' + k) + '.' + (k === 'clip' ? 'wav' : 'png'); files[n[k]] = cap[k]; }
  }
  return files;
}
async function finalize(verdict) {
  if (S.busy || CM.guest()) return;
  // A spoken or typed note that is still open must never be dropped by the decision (2026-10-05: a voice note was lost on approve).
  if ($('.mic[aria-pressed="true"], .mic:disabled')) { toast('Your voice note is still being transcribed. Wait until the text appears.', 6000); return; }
  if (!S.sel && S.asset && localStorage.getItem(unsentKey())) restoreUnsent();
  const openTa = $('#pop textarea');
  if (S.sel && openTa && openTa.value.trim()) { $('#pop .pop-f .primary').click(); toast('Your open note has been posted. Choose again: approve or send back.', 8000); return; }
  if (verdict === 'changes' && !autoChoice(S.review) && !(S.review.summary || '').trim() && !S.review.notes.some(n => n.verdict !== 'approve' && n.status === 'open') && !pending().fuNo && !Object.values(S.review.checklist).includes('fail')) { S.wantChange = true; revealSummary('Write what should change first.'); return; }
  S.busy = true; cancelSel(); clearTimeout(S.saveT); S.pendingSave = false;
  await settleSaves();
  const btn = $('#decide [data-decide]'); if (btn) { btn.disabled = true; btn.replaceChildren('Making crops…'); }
  const where = [S.asset, S.stage, S.v]; const before = JSON.parse(JSON.stringify(S.review));
  withoutCoreMandate(S.review);
  if (verdict === 'approved') delete S.review.auto;
  if (verdict === 'approved') { const pd = pending(); for (const n of pd.prevOpen) if (!pd.st(n)) S.review.followups.push({ id: 'v' + (S.v - 1) + ':' + n.id, status: 'confirmed', text: n.text, target: n.target }); } // approving answers the open questions with "Yes"
  try {
    const files = await makeCrops();
    Object.assign(S.review, { asset: S.asset, stage: S.stage, version: S.v, reviewer: REVIEWER, draft: false, verdict });
    const out = await postReview(S.review, files, baseRev(S.review)); clearDraft();
    S.cat = await api('/api/catalog'); S.busy = false;
    const name = S.cat.assets[where[0]].name + ' · ' + S.cat.stages.find(s => s.id === where[1]).label;
    toast(SENT[verdict] + ': ' + name + (autoName(S.review) ? ' · ' + autoName(S.review) : ''), 7000, ['Undo', () => undoFinal(where, before, out.rev)]);
    const q = queue(); if (q.length) await pick(q[0].id, q[0].s.id); else await showHome();
  } catch (e) { S.busy = false; if (e.status === 409 && e.body && e.body.conflict) { S.review.draft = true; S.review.verdict = 'pending'; reviewConflict(S.review, e.body.current); return; }
    if (S.asset === where[0] && S.stage === where[1] && S.v === where[2]) S.review = before; // not sent: the version still waits (it showed "Rejected" while nothing was saved)
    toast('Could not send: ' + e.message + '. Your notes are still here.', 7000); renderDecide(); }
}
async function undoFinal([a, s, v], before, after) {
  const rv = Object.assign(before, { asset: a, stage: s, version: v, reviewer: REVIEWER, draft: true, verdict: 'pending' });
  try { await postReview(rv, {}, after); } catch (e) { return toast(e.status === 409 ? CONFLICT + '. Not restored.' : 'Could not restore: ' + e.message, 7000); }
  S.cat = await api('/api/catalog'); await pick(a, s, v); toast('Restored. This version is waiting for you again.');
}
// Discard: the owner does not want this asset at all. Every stage moves to the archive (never deleted) and no agent redoes it; the toast undoes it.
function binButton() { return el('button', { class: 'ghost sm red', 'data-bin': '1', title: 'Move this asset to the archive', onclick: binHere }, icon('trash', 15), 'Discard'); }
function postJson(p, body) { return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
async function binHere() {
  if (S.busy || CM.guest() || !S.asset) return;
  await binAssets([S.asset], ((S.review || {}).summary || '').trim(), async n => {
    if (!n) return renderDecide();
    const q = queue(); if (q.length) await pick(q[0].id, q[0].s.id); else await showHome();
  }, async () => { cancelSel(); return leaveReview(); });
}
// Discard always asks why: the reason goes into the archive, so agents learn what the owner does not want.
const BIN_WHY = ['Ugly / poor quality', 'Does not fit the style', 'Not needed', 'Duplicate', 'Wrong idea'];
function askBinReason(what, prefill) {
  return new Promise(done => {
    let result = null;
    const text = el('textarea', { class: 'sum', rows: '6', maxlength: '4000', 'aria-label': 'Why discard?', placeholder: 'Why are you discarding this? (required)', value: prefill || '' });
    const go = el('button', { class: 'primary red', 'data-bin-ok': '1', onclick: () => {
      const t = text.value.trim(); if (!t) { text.focus(); text.classList.remove('shake'); void text.offsetWidth; text.classList.add('shake'); return; }
      result = t; d.close(); } }, icon('trash', 15), 'Discard');
    const upd = () => { const empty = !text.value.trim(); go.setAttribute('aria-disabled', String(empty)); go.title = empty ? 'First write why' : 'Ctrl+Enter'; };
    text.addEventListener('input', upd); text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); } }); upd();
    const chips = el('div', { class: 'autorow' }, BIN_WHY.map(w => el('button', { class: 'chipbtn', onclick: () => { text.value = text.value.trim() ? text.value.trim() + '; ' + w : w; upd(); text.focus(); } }, w)));
    const d = el('dialog', { class: 'rounddlg', 'aria-labelledby': 'bin-heading' }, el('h2', { id: 'bin-heading' }, 'Discard: ' + what),
      el('p', { class: 'muted sm' }, 'The asset and your reason go to the archive.'), chips, text,
      el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: () => d.close() }, 'Cancel'), el('span', { class: 'grow' }), go));
    d.addEventListener('close', () => { d.remove(); done(result); }); document.body.append(d); d.showModal(); text.focus();
  });
}
// Discard from the review panel, the choice screen or the project list: each asset goes to the archive (never deleted) and no agent makes it again. One toast undoes them all.
async function binAssets(ids, prefill, after, before) {
  if (S.busy || CM.guest() || !ids.length) return;
  const names = ids.map(a => (S.cat.assets[a] || {}).name || a); const done = []; let err = null;
  const reason = await askBinReason(ids.length > 1 ? ids.length + ' opties' : nice(names[0]), prefill); if (!reason) return;
  S.busy = true;
  if (before && !await before()) { S.busy = false; return; }
  for (const a of ids) { try { done.push((await postJson('/api/bin', { asset: a, reason })).archive); } catch (e) { err = e; break; } }
  try { if (done.length) S.cat = await api('/api/catalog'); } catch (e) { err = err || e; }
  S.busy = false;
  if (!done.length) { toast('Could not discard: ' + err.message, 7000); return after(0); }
  toast('Discarded: ' + (ids.length > 1 ? done.length + ' of ' + ids.length : nice(names[0])) + (err ? ' · the rest failed: ' + err.message : ''), 10000, ['Undo', () => unbinAssets(done, ids)]);
  await after(done.length);
}
async function unbinAssets(archives, ids) {
  let err = null;
  for (const id of archives) { try { await postJson('/api/unbin', { archive: id }); } catch (e) { err = e; } }
  S.cat = await api('/api/catalog'); const a = ids[0]; const st = Object.keys((S.cat.assets[a] || {}).stages || {})[0];
  if (archives.length === 1 && st) await pick(a, st); else await showHome();
  toast(err ? 'Could not fully restore: ' + err.message : 'Restored: ' + (archives.length > 1 ? archives.length + ' options' : nice((S.cat.assets[a] || {}).name || a)), err ? 7000 : 4000);
}

// ---------------- keyboard ----------------
const HELP = [['A', 'Point'], ['D', 'Draw'], ['H', 'Pan (view)'], ['C', 'Compare'], ['Enter', 'Post note'], ['Shift+Enter', 'New line in a note'], ['Esc', 'Cancel'],
  ['Ctrl+Enter', 'Send: approve or back to agent'], ['N', 'Next waiting'], ['G', 'Overview'], ['R', 'Refresh'], ['J|K', 'Next or previous note'],
  ['Space', 'Play or pause'], ['←|→', 'Sound slower or faster'], ['1|2', 'File good or redo (sets)'], ['↓|↑', 'Next or previous file'], [',|.', 'Frame back or forward'], ['I|U', 'Start and end of a range'], ['Scroll wheel|+|-', 'Zoom'], ['0', 'Fit'], ['Space+drag', 'Pan'], ['Alt+click', 'One separate part (3D)']];
function showHelp() {
  const d = $('#help'); d.replaceChildren(el('h2', {}, 'Keyboard shortcuts'), el('dl', {}, HELP.flatMap(([k, t]) => [el('dt', {}, k.split('|').map(x => el('kbd', {}, x))), el('dd', {}, t)])),
    el('div', { class: 'drow' }, el('button', { class: 'ghost', onclick: checkNow }, icon('refresh'), 'Refresh'), el('span', { class: 'grow' }), el('button', { class: 'primary sm', onclick: () => d.close() }, 'Close')));
  d.onclick = e => { const r = d.getBoundingClientRect(); if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close(); };
  d.showModal();
}
const typing = e => { const t = e.target; return t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable); };
const onButton = e => !!(e.target && e.target.closest && e.target.closest('button,summary,[role=button]')); // Space must still press a focused button
async function onKey(e) {
  if (document.querySelector('dialog.studiodlg[open]')) return;
  if ($('#help').open) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.mode === 'review' && !S.sel && !locked() && !S.review.guest) { e.preventDefault(); const b = $('#decide [data-decide]'); if (b) b.click(); return; }
  if ((typing(e) && !(e.key === 'Escape' && e.target.tagName === 'SELECT')) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key, lk = k.toLowerCase(), V = S.view;
  if (V instanceof LiveView && ['+', '=', '-', '0'].includes(k)) return; // LiveView handles zoom only inside its focused pane.
  if (k === '?') return showHelp();
  if (lk === 'g') return goHome();
  if (lk === 'n') return step(1);
  if (lk === 'r') return checkNow();
  if (S.mode !== 'review' || !V) return;
  if (k === 'Escape') { if (S.sel) return cancelSel(); $('#viewmenu').hidden = true; if (S.compare) return toggleCompare(); return; }
  const first = V.tools()[0]?.[0]; const tool = { a: first, d: 'pen', h: 'hand', t: 'time' }[lk];
  if (tool && V.tools().some(x => x[0] === tool)) { e.preventDefault(); return setTool(tool); }
  if (lk === 'c') return toggleCompare();
  if (lk === 'j' || lk === 'k') { const ns = S.review.notes; if (!ns.length) return; const i = ns.findIndex(x => x.id === S.active); return focusNote(ns[(i + (lk === 'j' ? 1 : -1) + ns.length) % ns.length]); }
  if (k === ' ' && V.togglePlay && !onButton(e)) { e.preventDefault(); return V.togglePlay(); }
  if ((k === 'ArrowLeft' || k === 'ArrowRight') && V.setRate) { e.preventDefault(); return V.setRate(k === 'ArrowRight' ? 1 : -1); }
  const nf = (verInfo() || { files: [] }).files.length;
  if ((k === '1' || k === '2') && nf > 1 && !locked() && !S.review.guest) { e.preventDefault(); return setFileVerdict(S.file, k === '1' ? 'approve' : 'change'); }
  if ((k === 'ArrowDown' || k === 'ArrowUp') && nf > 1) { e.preventDefault(); S.autoNext = true; return showFile((S.file + (k === 'ArrowDown' ? 1 : -1) + nf) % nf); }
  if ((k === ',' || k === '.') && V.stepFrame) { e.preventDefault(); return V.stepFrame(k === '.' ? 1 : -1); }
  if (lk === 'i' && V.markIn) return V.markIn();
  if (lk === 'u' && V.markOut) return V.markOut();
  if (k === '0' && V.fit) return V.fit();
  if ((k === '+' || k === '=') && V.zoomBy) return V.zoomBy(1.25);
  if (k === '-' && V.zoomBy) return V.zoomBy(0.8);
}

// ---------------- shared 2D helpers ----------------
function drawMark(g, x, y, n, col, active) {
  g.save(); g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.lineWidth = active ? 4 : 2; g.strokeStyle = active ? '#fff' : '#111'; g.stroke();
  g.fillStyle = '#111'; g.font = 'bold 13px Segoe UI'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), x, y + 1); g.restore();
}
function drawShape(g, sel, W, H, col, active) {
  g.save(); g.strokeStyle = col; g.lineWidth = active ? 4 : 2.5; g.setLineDash(active ? [] : [8, 5]);
  let ax = null, ay = null;
  const many = (sel.parts2d || []).filter(p => p.polygon); // a note on several recognised parts shows each outline
  for (const p of many) { g.beginPath(); p.polygon.forEach(([x, y], i) => i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)); g.closePath(); g.stroke(); if (ax == null) [ax, ay] = [p.polygon[0][0] * W, p.polygon[0][1] * H]; }
  const r = many.length ? null : sel.type === 'rect' ? sel : sel.rect;
  if (r) { g.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H); ax = r.x * W; ay = r.y * H; }
  if (sel.type === 'polygon') { g.beginPath(); sel.points.forEach(([x, y], i) => i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)); g.closePath(); g.stroke(); [ax, ay] = [sel.points[0][0] * W, sel.points[0][1] * H]; }
  if (sel.type === 'point') { g.beginPath(); g.arc(sel.x * W, sel.y * H, 9, 0, 7); g.stroke(); ax = sel.x * W; ay = sel.y * H; }
  if (sel.type === 'stroke') { g.setLineDash([]); g.lineCap = g.lineJoin = 'round'; g.lineWidth = active ? 4 : 3; g.beginPath(); sel.points.forEach(([x, y], i) => i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)); g.stroke(); [ax, ay] = [sel.points[0][0] * W, sel.points[0][1] * H]; }
  g.restore(); return ax == null ? null : [ax, ay];
}
function bboxOf(sel) {
  const r = sel.type === 'rect' ? sel : sel.rect;
  if (r) return [r.x, r.y, r.w, r.h];
  if (sel.type === 'polygon') { const xs = sel.points.map(p => p[0]), ys = sel.points.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; }
  if (sel.type === 'point') return [sel.x - 0.06, sel.y - 0.06, 0.12, 0.12];
  if (sel.type === 'stroke') { const b = sel.w != null ? sel : bboxPts(sel.points); return [b.x, b.y, Math.max(b.w, 0.02), Math.max(b.h, 0.02)]; }
  return null;
}
function cropCanvas(src, bx, by, bw, bh, maxDim = 1024) {
  const pad = Math.max(24, 0.12 * Math.max(bw, bh));
  const x0 = Math.max(0, bx - pad), y0 = Math.max(0, by - pad), x1 = Math.min(src.width, bx + bw + pad), y1 = Math.min(src.height, by + bh + pad);
  if (x1 <= x0 || y1 <= y0) return null; // the shape lies outside this image (a live-page note below the screenshot)
  const s = Math.min(1, maxDim / Math.max(x1 - x0, y1 - y0)); const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((x1 - x0) * s)); c.height = Math.max(1, Math.round((y1 - y0) * s));
  c.getContext('2d').drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height); return c.toDataURL('image/png');
}
function scaled(src, maxDim = 1400) { const s = Math.min(1, maxDim / Math.max(src.width, src.height)); const c = document.createElement('canvas'); c.width = Math.round(src.width * s); c.height = Math.round(src.height * s); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c; }
// Phone/gameplay-size check: show the asset at 1/4, 1/8 or 1/16 resolution, scaled up with hard pixels.
function smallButton(view, apply) {
  const steps = [0, 4, 8, 16], lab = s => s ? 'Phone 1/' + s : 'Phone size';
  const b = el('button', { title: 'View it as on a phone or at play distance: low resolution, scaled up. Click again for smaller.', class: 'tgl' + (view.small ? ' on' : ''), onclick: () => { view.small = steps[(steps.indexOf(view.small || 0) + 1) % steps.length]; b.textContent = lab(view.small); b.classList.toggle('on', !!view.small); apply(); } }, lab(view.small));
  return b;
}

// 2D annotation layer used by image and video views: rect / polygon / pin / pen stroke in normalized coords, plus pan/zoom when the view supports it
const SPACE = { held: false };
document.addEventListener('keydown', e => { if (e.key === ' ' && !typing(e) && !onButton(e)) { SPACE.held = true; if (S.view instanceof ImageView) e.preventDefault(); } });
document.addEventListener('keyup', e => { if (e.key === ' ') SPACE.held = false; });
// pane pixels to box coordinates; a live page can run past its screenshot, so the box may allow more than 1 (xmax, ymax)
const toBox = (x, y, b) => [Math.min(b.xmax || 1, Math.max(0, (x - b.x) / b.w)), Math.min(b.ymax || 1, Math.max(0, (y - b.y) / b.h))];
const clamp01 = v => Math.min(1, Math.max(0, v)); const r4 = v => +v.toFixed(4);
function bboxPts(pts) { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); const x = Math.min(...xs), y = Math.min(...ys); return { x: r4(x), y: r4(y), w: r4(Math.max(...xs) - x), h: r4(Math.max(...ys) - y) }; }
function simplify(pts, eps) { // Ramer-Douglas-Peucker keeps the drawing shape with few points
  if (pts.length < 3) return pts; const [a, b] = [pts[0], pts[pts.length - 1]]; let dmax = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) { const p = pts[i]; const d = Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9); if (d > dmax) { dmax = d; idx = i; } }
  return dmax > eps ? simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps)) : [a, b];
}
class Layer2D {
  constructor(pane, getBox, onDone, nav) {
    this.cv = el('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } }); pane.append(this.cv);
    this.g = this.cv.getContext('2d'); this.getBox = getBox; this.onDone = onDone; this.nav = nav || null; this.tool = 'point'; this.pts = null; this.drag = null; this.stroke = null; this.notes = []; this.active = null; this.ghostSel = null;
    this.parts = null; this.hoverP = null; this.lit = null; this.down = null;
    const P = e => { const r = this.cv.getBoundingClientRect(); return toBox(e.clientX - r.left, e.clientY - r.top, this.getBox()); };
    const RAW = e => { const b = this.getBox(); const r = this.cv.getBoundingClientRect(); return [(e.clientX - r.left - b.x) / b.w, (e.clientY - r.top - b.y) / b.h]; };
    const ptrs = new Map(); let pan = null, pinch = null, lastTap = null; // plain drag pans; a second press right after a tap (or Shift) drags a box
    this.cv.addEventListener('pointerdown', e => {
      try { this.cv.setPointerCapture(e.pointerId); } catch (x) {} ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.nav && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; this.drag = this.stroke = this.down = null; pan = null; this.draw(); return; }
      if (this.nav && (this.tool === 'hand' || e.button === 1 || SPACE.held)) { e.preventDefault(); pan = [e.clientX, e.clientY]; this.cv.style.cursor = 'grabbing'; return; }
      if (!this.tool || this.tool === 'hand' || e.button !== 0) return;
      const p = P(e);
      if (this.tool === 'point') { const dbl = lastTap && e.timeStamp - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30; lastTap = null; this.down = { p, x: e.clientX, y: e.clientY, box: !this.nav || dbl || e.shiftKey }; }
      else if (this.tool === 'rect') this.drag = [p, p];
      else if (this.tool === 'pen') this.stroke = [p];
      else if (this.tool === 'pin') { this.sel = { type: 'point', x: r4(p[0]), y: r4(p[1]) }; this.draw(); this.onDone(this.sel); }
      else if (this.tool === 'poly') { this.pts = (this.pts || []).concat([p]); this.draw(); }
    });
    this.cv.addEventListener('pointermove', e => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); const r = this.cv.getBoundingClientRect(); this.nav.zoom(d / pinch.d, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top); pinch.d = d; return; }
      if (pan) { this.nav.pan(e.clientX - pan[0], e.clientY - pan[1]); pan = [e.clientX, e.clientY]; return; }
      if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6) {
        if (this.down.box) this.drag = [this.down.p, P(e)]; else { pan = [this.down.x, this.down.y]; this.cv.style.cursor = 'grabbing'; }
        this.down = null; this.setHover(null); if (pan) return;
      }
      if (this.drag) { this.drag[1] = P(e); this.draw(); }
      else if (this.stroke) { const p = P(e), q = this.stroke[this.stroke.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.0015) { this.stroke.push(p); this.draw(); } }
      else if (!ptrs.size && this.parts && this.tool === 'point') { this.setHover(this.partAt(RAW(e))); this.tag(); }
    });
    this.cv.addEventListener('pointerleave', () => { if (this.hoverP) { this.setHover(null); showHover(null); } });
    const up = e => {
      ptrs.delete(e.pointerId);
      if (pinch) { if (ptrs.size < 2) pinch = null; return; }
      if (pan) { pan = null; this.cv.style.cursor = ''; return; }
      if (this.down) { const p = this.down.p; this.down = null; lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY }; const hp = this.parts ? this.partAt(RAW(e)) : null;
        if (hp && this.multi && this.multi.length && (e.shiftKey || e.ctrlKey || e.metaKey || S.adding)) { // add or remove a part in the open note
          const i = this.multi.indexOf(hp); if (i >= 0) this.multi.splice(i, 1); else this.multi.push(hp);
          if (this.multi.length) { this.sel = partsSel(this.multi); this.lit = this.multi.length > 1 ? [...this.multi] : null; this.setHover(null); this.draw(); return this.onDone(this.sel, { keep: true }); }
        }
        this.multi = hp ? [hp] : null; this.lit = null;
        this.sel = hp ? partsSel([hp]) : { type: 'point', x: r4(p[0]), y: r4(p[1]) };
        this.setHover(null); this.draw(); return this.onDone(this.sel); }
      if (this.drag) { const [[x0, y0], [x1, y1]] = this.drag; this.drag = null; if (this.nav && this.nav.page ? Math.abs(x1 - x0) * this.getBox().w < 6 || Math.abs(y1 - y0) * this.getBox().h < 6 : Math.abs(x1 - x0) < 0.01 || Math.abs(y1 - y0) < 0.01) return this.draw(); this.sel = { type: 'rect', x: r4(Math.min(x0, x1)), y: r4(Math.min(y0, y1)), w: r4(Math.abs(x1 - x0)), h: r4(Math.abs(y1 - y0)) }; this.draw(); this.onDone(this.sel, { start: [x0, y0] }); }
      if (this.stroke) { const s = this.stroke; this.stroke = null; if (s.length < 3) return this.draw(); const pts = simplify(s, 0.0015).slice(0, 400).map(p => p.map(r4)); this.sel = { type: 'stroke', points: pts, ...bboxPts(pts) }; this.draw(); this.onDone(this.sel); }
    };
    this.cv.addEventListener('pointerup', up); this.cv.addEventListener('pointercancel', up);
    this.cv.addEventListener('dblclick', () => { if (this.tool === 'poly' && this.pts && this.pts.length >= 3) { this.sel = { type: 'polygon', points: this.pts.map(p => p.map(r4)) }; this.pts = null; this.draw(); this.onDone(this.sel); } });
    if (this.nav) this.cv.addEventListener('wheel', e => { e.preventDefault(); const r = this.cv.getBoundingClientRect(); const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY; if (this.nav.page && !e.ctrlKey) return this.nav.pan(0, -dy); this.nav.zoom(Math.min(1.35, Math.max(0.74, Math.exp(-dy * 0.0015))), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    this.cv.style.cursor = 'crosshair';
  }
  setTool(t) { this.tool = t; this.pts = null; this.cv.style.cursor = t === 'hand' ? 'grab' : t === 'point' ? 'default' : t ? 'crosshair' : 'default'; this.setHover(null); this.draw(); }
  // smallest recognised part under a normalized point (parts are sorted small to large); thin parts (antenna, rifle) also count within 12 px
  partAt([x, y]) {
    if (!this.parts || x < -0.05 || y < -0.05 || x > 1.05 || y > 1.05) return null;
    const hit = this.parts.find(p => p.polygons.some(poly => inPoly(x, y, poly))); if (hit) return hit;
    const b = this.getBox(), tol = 12; let best = null, bd = tol;
    for (const p of this.parts) {
      const [bx, by, bw, bh] = p.bbox; if ((bx - x) * b.w > tol || (x - bx - bw) * b.w > tol || (by - y) * b.h > tol || (y - by - bh) * b.h > tol) continue;
      for (const poly of p.polygons) { const d = polyDist(x * b.w, y * b.h, poly, b.w, b.h); if (d < bd) { bd = d; best = p; } }
    }
    return best;
  }
  tag() { const p = this.hoverP; if (!p) return showHover(null); const b = this.getBox(), r = this.cv.getBoundingClientRect(); showHover(p.score < UNSURE ? p.name.replace(/( · |$)/, '?$1') : p.name, r.left + b.x + p.bbox[0] * b.w, r.top + b.y + p.bbox[1] * b.h, true); }
  setHover(p) { if (p === this.hoverP) return; this.hoverP = p; if (this.tool === 'point') this.cv.style.cursor = p ? 'pointer' : 'default'; this.draw(); }
  resize() { const r = this.cv.getBoundingClientRect(); this.cv.width = r.width * devicePixelRatio; this.cv.height = r.height * devicePixelRatio; this.draw(); }
  draw() {
    const g = this.g; g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); g.clearRect(0, 0, this.cv.width, this.cv.height);
    const b = this.getBox(); g.translate(b.x, b.y);
    // outline first, a light tint only: the reviewer must still see the colours under a highlight; a guess (low score) is dashed
    for (const p of [...(this.lit || []), ...(this.hoverP ? [this.hoverP] : [])]) { g.save(); g.fillStyle = p === this.hoverP ? 'rgba(91,156,255,.07)' : 'rgba(91,156,255,.12)'; g.strokeStyle = '#5b9cff'; g.lineWidth = 2; g.lineJoin = 'round'; if (p.score < UNSURE) g.setLineDash([6, 4]);
      for (const poly of p.polygons) { g.beginPath(); poly.forEach(([x, y], i) => i ? g.lineTo(x * b.w, y * b.h) : g.moveTo(x * b.w, y * b.h)); g.closePath(); g.fill(); g.stroke(); } g.restore(); }
    if (this.ghostSel) { g.save(); g.globalAlpha = 0.9; drawShape(g, this.ghostSel, b.w, b.h, '#a8c8ff', false); g.restore(); }
    for (const n of this.notes) { const sel = shapeOf(n.target.selector); if (!sel || !this.visible(n)) continue; const col = VERDICT[n.verdict][1]; const a = drawShape(g, sel, b.w, b.h, col, n.id === this.active); if (a) drawMark(g, a[0], a[1], n.mark, col, n.id === this.active); }
    const live = this.drag ? { type: 'rect', x: Math.min(this.drag[0][0], this.drag[1][0]), y: Math.min(this.drag[0][1], this.drag[1][1]), w: Math.abs(this.drag[1][0] - this.drag[0][0]), h: Math.abs(this.drag[1][1] - this.drag[0][1]) }
      : this.stroke ? { type: 'stroke', points: this.stroke } : this.pts ? { type: 'polygon', points: this.pts } : this.sel;
    if (live) { if (live.type === 'polygon' && this.pts) { g.strokeStyle = '#5b9cff'; g.lineWidth = 2; g.beginPath(); this.pts.forEach(([x, y], i) => i ? g.lineTo(x * b.w, y * b.h) : g.moveTo(x * b.w, y * b.h)); g.stroke(); } else drawShape(g, live, b.w, b.h, '#5b9cff', true); }
  }
  visible() { return true; }
}
function inPoly(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function polyDist(px, py, poly, W, H) { // pixel distance from a point to a normalized polygon outline
  let d = Infinity; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const ax = poly[j][0] * W, ay = poly[j][1] * H, bx = poly[i][0] * W, by = poly[i][1] * H; const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0; d = Math.min(d, Math.hypot(px - ax - t * dx, py - ay - t * dy)); } return d;
}
// the drawable shape of any selector (time selectors may carry a region or a pen stroke on one frame)
function shapeOf(s) { if (s.type === 'sketch') return { type: 'stroke', points: s.points }; if (s.type !== 'time') return s.type === 'whole' || s.type === 'text' ? null : s; return s.stroke ? { type: 'stroke', points: s.stroke } : s.rect ? { type: 'rect', ...s.rect } : null; }

// ---------------- image ----------------
class ImageView {
  constructor(pane, url, file, o) { this.pane = pane; this.url = url; this.file = file; this.o = o; this.tool = 'point'; this.z = 1; this.ox = 0; this.oy = 0; } // always start pointing: a remembered "Verschuiven" made taps do nothing
  tools() { return [['point', 'Point', 'Tap a part or a point. Drag to pan; double-tap and drag (or Shift+drag) for a box'], ['pen', 'Draw', 'Draw how it should look'], ['hand', 'Pan', 'Pan and zoom without pointing at anything']]; }
  setParts(doc) { this.partsDoc = doc; this.layer.parts = (doc.parts || []).filter(p => p.polygons && p.polygons.length); this.layer.draw(); }
  // recognised parts grouped by name for the side panel: hover lights them all up, a click points at them
  partList() { const g = new Map(); for (const p of (this.layer && this.layer.parts) || []) { const k = p.label; if (!g.has(k)) g.set(k, []); g.get(k).push(p); } return [...g.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([label, ps]) => ({ id: label, label, count: ps.length, ps })); }
  hoverPart(id) { const it = id && this.partList().find(x => x.id === id); this.layer.lit = it ? it.ps : null; this.layer.draw(); }
  selectPart(id, add) {
    const it = this.partList().find(x => x.id === id); if (!it) return; const L = this.layer;
    const ps = add && L.multi && L.multi.length && !$('#pop').hidden ? [...new Set([...L.multi, ...it.ps])] : [...it.ps];
    L.multi = ps; L.lit = ps.length > 1 ? ps : null; L.sel = partsSel(ps); if (!add) S.lastPt = null;
    if (!add && ps.length > 1) L.sel.label = 'All ' + it.label.toLowerCase() + ' (' + ps.length + ')';
    L.draw(); select(L.sel, add ? { keep: true } : {});
  }
  async load() {
    this.img = new Image(); this.img.src = this.url; await this.img.decode(); this.page = this.img.height / this.img.width >= 1.6;
    this.bg = el('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } }); this.pane.append(this.bg);
    const nav = { page: this.page, zoom: (f, x, y) => this.zoomAt(f, x, y), pan: (dx, dy) => { this.ox += dx; this.oy += dy; this.changed(); } };
    this.layer = new Layer2D(this.pane, () => this.box(), (s, x) => select(s, x), nav); this.layer.setTool(this.o.primary ? this.tool : 'hand');
    this.zl = el('span', { class: 'zoom' }); this.pane.append(this.zl);
    if (this.o.overlay) await this.loadOverlay(this.o.overlay);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.pane); this.resize();
  }
  async loadOverlay(ov) {
    this.ov = new Image(); this.ov.src = ov.url; await this.ov.decode(); this.wipe = 0.5;
    if (ov.mode === 'wipe') {
      this.wh = el('div', { class: 'wipeh', title: 'Drag to wipe' }, el('span', {}, '\u2194')); this.pane.append(this.wh);
      this.wh.addEventListener('pointerdown', e => { e.preventDefault(); this.wh.setPointerCapture(e.pointerId); this.wiping = true; });
      this.wh.addEventListener('pointermove', e => { if (!this.wiping) return; const r = this.pane.getBoundingClientRect(), b = this.box(); this.wipe = clamp01((e.clientX - r.left - b.x) / b.w); this.resize(); });
      this.wh.addEventListener('pointerup', () => { this.wiping = false; });
    }
    if (ov.mode === 'diff') { // changed pixels in brass over a dimmed current image; the share is measured, not estimated
      const W = this.img.width, H = this.img.height; const a = document.createElement('canvas'); a.width = W; a.height = H; const ga = a.getContext('2d'); ga.drawImage(this.img, 0, 0);
      const bcv = document.createElement('canvas'); bcv.width = W; bcv.height = H; bcv.getContext('2d').drawImage(this.ov, 0, 0, W, H);
      const A = ga.getImageData(0, 0, W, H), B = bcv.getContext('2d').getImageData(0, 0, W, H); const O = ga.createImageData(W, H); let n = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
        const l = (A.data[i] * 0.3 + A.data[i + 1] * 0.59 + A.data[i + 2] * 0.11) * 0.35;
        if (d > 12) { n++; const k = Math.min(1, d / 80); O.data[i] = l + (217 - l) * k; O.data[i + 1] = l + (174 - l) * k; O.data[i + 2] = l + (82 - l) * k; } else { O.data[i] = O.data[i + 1] = O.data[i + 2] = l; }
        O.data[i + 3] = 255;
      }
      ga.putImageData(O, 0, 0); this.diffCv = a; this.diffPct = 100 * n / (W * H);
    }
  }
  fitScale() { const r = this.pane.getBoundingClientRect(); return (this.page ? r.width / this.img.width : Math.min(r.width / this.img.width, r.height / this.img.height)) * 0.98; }
  box() { const r = this.pane.getBoundingClientRect(); const s = this.fitScale() * this.z; const w = this.img.width * s, h = this.img.height * s; return { x: (r.width - w) / 2 + this.ox, y: (this.page && !this.whole ? 0 : (r.height - h) / 2) + this.oy, w, h }; }
  zoomAt(f, x, y) {
    const b = this.box(); const u = (x - b.x) / b.w, v = (y - b.y) / b.h;
    this.z = Math.min(48, Math.max(this.page ? 0.01 : 0.3, this.z * f)); const b2 = this.box(); this.ox += x - (b2.x + u * b2.w); this.oy += y - (b2.y + v * b2.h); this.changed();
  }
  zoomBy(f) { const r = this.pane.getBoundingClientRect(); this.zoomAt(f, r.width / 2, r.height / 2); }
  fit() { this.whole = false; this.z = 1; this.ox = this.oy = 0; this.changed(); }
  wholePage() { const r = this.pane.getBoundingClientRect(); this.whole = true; this.z = Math.min(r.width / this.img.width, r.height / this.img.height) * 0.98 / this.fitScale(); this.ox = this.oy = 0; this.changed(); }
  actual() { this.whole = false; this.z = 1 / this.fitScale(); this.ox = this.oy = 0; this.changed(); }
  // zoom so a normalized box fills most of the pane
  zoomTo(bb) {
    if (!bb) return this.fit(); this.whole = false; const r = this.pane.getBoundingClientRect(); const f = this.fitScale();
    this.z = Math.min(12, Math.max(1, 0.6 * Math.min(r.width / (bb[2] * this.img.width * f), r.height / (bb[3] * this.img.height * f))));
    const s = f * this.z; this.ox = -((bb[0] + bb[2] / 2) - 0.5) * this.img.width * s; this.oy = this.page ? r.height / 2 - (bb[1] + bb[3] / 2) * this.img.height * s : -((bb[1] + bb[3] / 2) - 0.5) * this.img.height * s; this.changed();
  }
  changed() { this.resize(); if (this.o.primary && this.peer instanceof ImageView) { this.peer.whole = this.whole; this.peer.z = this.z; this.peer.ox = this.ox; this.peer.oy = this.oy; this.peer.resize(); } }
  resize() {
    const r = this.pane.getBoundingClientRect();
    if (this.page && !this.whole) this.oy = Math.min(0, Math.max(Math.min(0, r.height - this.img.height * this.fitScale() * this.z), this.oy));
    this.bg.width = r.width * devicePixelRatio; this.bg.height = r.height * devicePixelRatio; const g = this.bg.getContext('2d'); g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); const b = this.box();
    const px = b.w / this.img.width; g.imageSmoothingEnabled = px < 2.5;  // show real pixels when zoomed in
    if (this.diffCv) g.drawImage(this.diffCv, b.x, b.y, b.w, b.h);
    else if (!this.small) g.drawImage(this.img, b.x, b.y, b.w, b.h);
    else { const t = document.createElement('canvas'); t.width = Math.max(1, Math.round(this.img.width * this.fitScale() / this.small)); t.height = Math.max(1, Math.round(this.img.height * this.fitScale() / this.small)); t.getContext('2d').drawImage(this.img, 0, 0, t.width, t.height); g.imageSmoothingEnabled = false; g.drawImage(t, b.x, b.y, b.w, b.h); }
    if (this.photoOv) this.photoOv.place();
    if (this.ov && this.o.overlay.mode === 'wipe') { const sx = b.x + b.w * this.wipe; g.save(); g.beginPath(); g.rect(sx, b.y, b.x + b.w - sx, b.h); g.clip(); g.drawImage(this.ov, b.x, b.y, b.w, b.h); g.restore(); g.fillStyle = '#d9ae52'; g.fillRect(sx - 1, b.y, 2, b.h); if (this.wh) { this.wh.style.left = (sx - 14) + 'px'; this.wh.style.top = Math.max(0, b.y) + 'px'; this.wh.style.height = Math.min(r.height, b.h) + 'px'; } }
    this.layer.resize(); if (this.zl) this.zl.textContent = (this.diffCv ? this.diffPct.toFixed(1) + '% of pixels differ. ' : '') + (this.z === 1 && !this.ox && (this.page || !this.oy) ? (this.page ? 'Fit width' : 'Fit') : this.whole ? 'Whole page' : Math.round(px * 100) + '%');
  }
  extras() { return [...(this.o.liveable ? [el('button', { class: 'mbtn', onclick: async () => { $('#viewmenu').hidden = true; localStorage.removeItem('ar.liveOff'); S.liveFail = false; destroyViews(); await mountViews(); } }, 'Live page')] : []), el('button', { class: 'mbtn', title: 'Fit (0)', onclick: () => this.fit() }, this.page ? 'Fit width' : 'Fit to view'), ...(this.page ? [el('button', { class: 'mbtn', onclick: () => this.wholePage() }, 'Whole page')] : []), el('button', { class: 'mbtn', title: 'Actual pixels', onclick: () => this.actual() }, 'Actual pixels (100%)'), smallButton(this, () => this.resize())]; }
  info() { return this.file.name + ' · ' + this.img.width + ' × ' + this.img.height + ' px' + (this.partsDoc ? ' · ' + this.partsDoc.parts.length + ' parts detected' : ''); }
  setTool(t) { this.tool = t; this.layer.setTool(t); }
  clearSelection() { this.layer.sel = null; this.layer.lit = null; this.layer.multi = null; this.layer.draw(); }
  marks(notes, active) { this.layer.notes = notes; this.layer.active = active; this.layer.draw(); }
  ghost(n) { this.layer.ghostSel = shapeOf(n.target.selector); this.layer.draw(); }
  async focus(n) { const s = n.target.selector; this.zoomTo(bboxOf(shapeOf(s) || {})); }
  async thumb() { const c = document.createElement('canvas'); const k = Math.min(1, 360 / this.img.width); c.width = Math.round(this.img.width * k); const h = this.page ? Math.min(this.img.height, this.img.width * 10 / 16) : this.img.height; c.height = Math.round(h * k); c.getContext('2d').drawImage(this.img, 0, 0, this.img.width, h, 0, 0, c.width, c.height); return c.toDataURL('image/png'); }
  async capture(n, all) {
    const W = this.img.width, H = this.img.height; const full = document.createElement('canvas'); full.width = W; full.height = H; full.getContext('2d').drawImage(this.img, 0, 0);
    const s = shapeOf(n.target.selector) || {}; const bb = bboxOf(s);
    const crop = bb ? (() => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(this.img, 0, 0); drawShape(g, s, W, H, VERDICT[n.verdict][1], true); return cropCanvas(c, bb[0] * W, bb[1] * H, bb[2] * W, bb[3] * H); })() : null;
    const ctx = scaled(full); const g = ctx.getContext('2d');
    for (const m of all) { const sh = shapeOf(m.target.selector); if (!sh) continue; const a = drawShape(g, sh, ctx.width, ctx.height, VERDICT[m.verdict][1], m.id === n.id); if (a) drawMark(g, a[0], a[1], m.mark, VERDICT[m.verdict][1], m.id === n.id); }
    return { crop, context: ctx.toDataURL('image/png') };
  }
  destroy() { this.ro && this.ro.disconnect(); }
}

// R3I-024 begin
{
  const loadOverlay = ImageView.prototype.loadOverlay, destroy = ImageView.prototype.destroy;
  let regions;
  ImageView.prototype.loadOverlay = async function (ov) {
    if (this.regionDisposed) return;
    const generation = this.regionGeneration = (this.regionGeneration || 0) + 1;
    this.regionController?.abort();
    if (ov.mode !== 'diff' || this.file.media !== 'image') return loadOverlay.call(this, ov);
    // Ordinary image/PDF views need no region module; install once on first diff.
    await (regions ||= import('./perceptual_regions.js').then(({ installImageRegions }) => installImageRegions(ImageView)));
    if (this.regionDisposed || this.regionGeneration !== generation) return;
    return ImageView.prototype.loadOverlay.call(this, ov);
  };
  ImageView.prototype.destroy = function () {
    this.regionDisposed = true; this.regionGeneration = (this.regionGeneration || 0) + 1;
    this.regionController?.abort();
    return destroy.call(this);
  };
}
// R3I-024 end

// R3F-005 begin
// Calibration is effective CSS pixels/inch at the CURRENT screen/browser zoom.
// DPR is only the canvas backing-store ratio; it is never the print DPI.
{
  const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const P = ImageView.prototype;
  const stamp = () => JSON.stringify([devicePixelRatio, window.visualViewport?.scale || 1,
    screen.width, screen.height, screen.availWidth, screen.availHeight,
    screen.orientation?.angle, window.screenX, window.screenY]);
  P.physicalDimensions = function () {
    const dpi = this.printDpi ?? this.file.print_dpi;
    return positive(dpi) ? { w: this.img.width / dpi * 25.4, h: this.img.height / dpi * 25.4 } : null;
  };
  P.calibrateScreen = function (cssPpi) {
    this.screenCalibration = positive(cssPpi) ? { cssPpi, stamp: stamp() } : null;
    this.physicalWarning = this.screenCalibration ? '' : 'Screen calibration is missing or invalid.';
    this.resize(); return !!this.screenCalibration;
  };
  P.checkScreenCalibration = function () {
    if (this.screenCalibration && this.screenCalibration.stamp !== stamp()) {
      this.screenCalibration = null;
      this.physicalWarning = 'Screen or browser zoom changed. Calibrate again.';
      if (this.calibrationInput) this.calibrationInput.value = '';
    }
  };
  P.physicalScale = function () {
    this.checkScreenCalibration();
    const mm = this.physicalDimensions(), c = this.screenCalibration;
    if (!c || !mm || !positive(mm.w) || !positive(mm.h)) return null;
    const w = mm.w / 25.4 * c.cssPpi, h = mm.h / 25.4 * c.cssPpi;
    return positive(w) && positive(h) ? { w, h, cssPpi: c.cssPpi } : null;
  };
  P.trueSize = function () {
    this.physicalRequested = true; this.whole = true; this.z = 1; this.ox = this.oy = 0;
    this.changed();
  };
  const box = P.box;
  P.box = function () {
    const s = this.physicalRequested && this.physicalScale();
    if (!s) return box.call(this);
    const r = this.pane.getBoundingClientRect();
    return { x: (r.width - s.w) / 2 + this.ox, y: (r.height - s.h) / 2 + this.oy, w: s.w, h: s.h };
  };
  const resize = P.resize;
  P.resize = function () {
    if (this.physicalDisposed) return;
    this.checkScreenCalibration();
    if (!this.bg) return;
    resize.call(this);
    if (!this.physicalRequested) { if (this.physicalOverlay) this.physicalOverlay.hidden = true; return; }
    if (!this.physicalOverlay) {
      this.physicalStatus = el('span', { role: 'status' });
      this.mmRuler = el('div', { class: 'mm-ruler', 'aria-label': '100 mm ruler' },
        Array.from({ length: 21 }, (_, i) => el('span', { class: i % 2 ? 'minor' : 'major',
          'data-mm': i * 5, style: { left: i * 5 + '%' } }, i % 2 ? '' : String(i * 5))));
      this.physicalOverlay = el('div', { class: 'physical-overlay' }, this.physicalStatus, this.mmRuler);
      this.pane.append(this.physicalOverlay);
    }
    this.physicalOverlay.hidden = false;
    const s = this.physicalScale(); this.mmRuler.hidden = !s;
    if (s) {
      this.mmRuler.style.width = (100 / 25.4 * s.cssPpi) + 'px';
      this.physicalStatus.textContent = 'Physical 100% · effective ' + s.cssPpi.toFixed(2) + ' CSS px/in · measures 100 mm on this screen';
      this.zl.textContent = 'Physical 100% (calibrated)';
    } else {
      this.physicalStatus.textContent = 'Physical 100% not available · ' +
        (this.physicalWarning || (!this.screenCalibration ? 'Calibrate the screen.' : 'Physical dimensions are missing or invalid.'));
      this.zl.textContent = 'Physical 100% not available';
    }
  };
  for (const name of ['fit', 'wholePage', 'actual', 'zoomTo', 'zoomAt']) {
    const original = P[name];
    P[name] = function (...args) {
      if (name === 'zoomAt' && this.physicalRequested) this.z = this.box().w / this.img.width / this.fitScale();
      this.physicalRequested = false; return original.apply(this, args);
    };
  }
  P.physicalControls = function () {
    this.calibrationInput = el('input', { type: 'number', min: '0', step: 'any',
      'aria-label': 'Effectieve scherm-DPI (CSS px per inch)', placeholder: 'CSS px/in',
      value: this.screenCalibration?.cssPpi ?? '', onchange: e => this.calibrateScreen(e.target.valueAsNumber) });
    const controls = [el('label', { class: 'mbtn physical-input' }, 'Screen calibration (CSS px/in)', this.calibrationInput)];
    if (this.file.media === 'image') controls.push(el('label', { class: 'mbtn physical-input' }, 'Declared print DPI',
      el('input', { type: 'number', min: '0', step: 'any', 'aria-label': 'Declared image print DPI',
        value: this.printDpi ?? this.file.print_dpi ?? '', onchange: e => { this.printDpi = e.target.valueAsNumber; this.resize(); } })));
    controls.push(el('button', { class: 'mbtn', onclick: () => this.trueSize() }, 'Physical 100%'),
      el('span', { class: 'physical-help' }, 'Enter the measured CSS pixels per inch at this zoom. Adjust the calibration until the ruler measures 100 mm. Calibrate again after a screen or zoom change.'));
    return controls;
  };
  const extras = P.extras;
  P.extras = function () { return [...extras.call(this), ...this.physicalControls()]; };
  const load = P.load, destroy = P.destroy;
  P.load = async function () {
    if (this.physicalDisposed) return;
    await load.call(this);
    // Decoding may finish after navigation disposed this view. The base load
    // can create an observer while finishing; disconnect it before returning.
    if (this.physicalDisposed) { destroy.call(this); return; }
    this.screenCheck = () => { if (this.bg) this.resize(); };
    window.addEventListener('resize', this.screenCheck);
    window.visualViewport?.addEventListener('resize', this.screenCheck);
    // Moving a window between screens need not emit resize. Conservatively require
    // recalibration after any window move; browsers cannot identify physical monitors.
    this.screenTimer = setInterval(() => {
      if (this.screenCalibration && this.screenCalibration.stamp !== stamp()) this.screenCheck();
    }, 500);
  };
  P.destroy = function () {
    if (this.physicalDisposed) return;
    this.physicalDisposed = true;
    clearInterval(this.screenTimer); window.removeEventListener('resize', this.screenCheck);
    window.visualViewport?.removeEventListener('resize', this.screenCheck);
    this.physicalOverlay?.remove(); destroy.call(this);
  };
}
// R3F-005 end

const PdfView = makePdf({ ImageView, el, icon, dataUrl, S, typing, refreshMarks, renderDock, toast, select });

// ---------------- live web page ----------------
// The site is not running (or the proxy page said so): show the screenshot of this version and let the reviewer try again.
async function liveDown() { if (!(S.view instanceof LiveView)) return; S.liveFail = S.view.o.live.url; destroyViews(); await mountViews(); }
const liveDownBar = () => el('div', { class: 'livebar down', role: 'status' }, el('span', { class: 'livedot', 'aria-hidden': 'true' }), el('span', { class: 'livepath' }, 'The site is not running \u2014 you see the screenshot of this version'),
  el('button', { class: 'chipbtn', onclick: async () => { S.liveFail = false; destroyViews(); await mountViews(); } }, 'Try again'));
// Website route: the real page in a frame (through the server's live proxy) at the CSS width of the screenshot. Notes and
// drawings are stored on the screenshot in its coordinates, so crops, locks, scope checks and TASK.md keep working.
const LOCAL_VIEWER = ['127.0.0.1', 'localhost'].includes(location.hostname);
function liveSource(ver, f, ignoreFail) {
  if (!LOCAL_VIEWER || routeGroup(S.asset) !== 'web' || f.media !== 'image') return null;
  const st = stageInfo(S.asset, S.stage); let url = (ver.meta || {}).url;
  for (let i = (st ? st.versions.length : 0) - 1; !url && i >= 0; i--) url = (st.versions[i].meta || {}).url; // a resubmit without --meta keeps the page of earlier versions
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url || '') || (!ignoreFail && S.liveFail === url)) return null;
  const phone = /mobile|phone|telefoon|mobiel/i.test(f.name), m = ver.meta || {}; // the window the screenshot was made in, so layout and coordinates match
  return { url, width: Number(m['width.' + f.name]) || (phone ? 390 : 1440), height: Number(m['height.' + f.name]) || (phone ? 844 : 900) };
}
class LiveView extends ImageView {
  constructor(pane, url, file, o) { super(pane, url, file, o); this.tool = localStorage.getItem('ar.liveTool') || 'live'; const z = Number(localStorage.getItem('ar.liveZoom')); this.liveZoom = z >= 0.25 && z <= 1.5 ? z : 'fit'; this.st = null; this.k = 1; this.x0 = 0; this.picks = new Map(); this.seq = 0; this.notes = []; }
  tools() { return [['live', 'Click', 'Use the page itself: click, scroll and type'], ['point', 'Point', 'Tap something to add a note. Drag or the wheel scrolls; Shift+drag makes a box'], ['pen', 'Draw', 'Draw on the page how it should look']]; }
  async load() {
    this.img = new Image(); this.img.src = this.url; await this.img.decode(); this.page = true;
    this.cssW = this.o.live.width; this.docH = this.img.height * this.cssW / this.img.width; // page height of the screenshot in CSS px
    this.base = new URL(this.o.live.url);
    const r = await api('/api/live?url=' + encodeURIComponent(this.o.live.url)); if (!r || !r.url) throw new Error(r && r.offline ? 'The site is not running' : 'live proxy');
    this.proxied = r.url; this.origin = new URL(r.url).origin;
    this.frame = el('iframe', { class: 'liveframe', src: r.url, title: 'Live page ' + this.base.pathname });
    this.wrap = el('div', { class: 'livewrap' }, this.frame); this.pane.append(this.wrap);
    this.onMsg = e => {
      const m = e.data; if (!this.frame || e.source !== this.frame.contentWindow || !m) return;
      if (m.type === 'ar-live-down') return this.o.down && this.o.down(); // the proxy's friendly error page: the site stopped
      if (m.ar !== 'live') return;
      if (m.type === 'state') { const was = this.onBase(); clearTimeout(this.helloT); this.st = m; if (was !== this.onBase()) this.marks(this.notes, this.activeId); this.layer.draw(); this.status(); }
      else if (m.type === 'picked' && this.picks.has(m.id)) { this.picks.get(m.id)(m); this.picks.delete(m.id); }
      else if (m.type === 'zoom') { if (m.fit) this.fit(); else this.zoomStep(m.delta); }
    };
    addEventListener('message', this.onMsg);
    this.helloT = setTimeout(() => { if (!this.st && this.o.down) this.o.down(); }, 10000); // no hello from the bridge: this is not a live page we can follow
    const nav = { page: true, zoom: f => this.zoomStep(f > 1 ? 1 : -1), pan: (dx, dy) => this.send({ type: 'scrollBy', dx: -dx / this.k, dy: -dy / this.k }) };
    this.layer = new Layer2D(this.pane, () => this.box(), (s, x) => this.picked(s, x), nav);
    this.bar = el('div', { class: 'livebar' }); this.pane.append(this.bar);
    this.pathLabel = el('span', { class: 'livepath' }); this.hint = el('span', { class: 'livehint' }, 'Notes here become general notes');
    this.backButton = el('button', { class: 'chipbtn', onclick: () => { this.frame.src = this.proxied; } }, 'Back to ' + this.base.pathname);
    this.zoomLabel = el('button', { class: 'chipbtn', title: 'Actual size (100%)', 'aria-label': 'Zoom 100%', onclick: () => this.setZoom(1) });
    this.fitButton = el('button', { class: 'chipbtn', onclick: () => this.fit() }, 'Fit');
    this.bar.append(el('span', { class: 'livedot', 'aria-hidden': 'true' }), this.pathLabel, this.hint, this.backButton,
      el('button', { class: 'chipbtn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoomStep(-1) }, '−'), this.zoomLabel,
      el('button', { class: 'chipbtn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoomStep(1) }, '+'), this.fitButton);
    this.pane.tabIndex = 0;
    this.onFocus = e => { if (e.target === this.pane || e.target === this.layer.cv) this.pane.focus({ preventScroll: true }); };
    this.onKey = e => { if (typing(e) || e.altKey || e.ctrlKey || e.metaKey || !['+', '=', '-', '0'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); e.key === '0' ? this.fit() : this.zoomStep(e.key === '-' ? -1 : 1); };
    this.onWheel = e => { if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return; e.preventDefault(); e.stopPropagation(); this.zoomStep(e.deltaY < 0 ? 1 : -1); };
    this.pane.addEventListener('pointerdown', this.onFocus); this.pane.addEventListener('keydown', this.onKey);
    this.pane.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    this.setTool(this.tool);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.pane); this.resize(); this.status();
  }
  send(m) { if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage({ ar: 'viewer', ...m }, this.origin); }
  onBase() { return !this.st || this.st.path.split('#')[0] === this.base.pathname + this.base.search; }
  // the unit stays the screenshot (1 = its width/height in CSS px), so notes keep their place; the real page may be longer or wider
  box() { const st = this.st, sx = st ? st.x : 0, sy = st ? st.y : 0; return { x: this.x0 - sx * this.k, y: -sy * this.k, w: this.cssW * this.k, h: this.docH * this.k, xmax: st && st.dw ? Math.max(1, st.dw / this.cssW) : 1, ymax: st && st.dh ? Math.max(1, st.dh / this.docH) : 1 }; }
  resize() {
    if (!this.wrap) return; const r = this.pane.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.k = Math.min(this.liveZoom === 'fit' ? 1 : this.liveZoom, r.width / this.cssW); this.x0 = Math.max(0, (r.width - this.cssW * this.k) / 2);
    this.frameH = r.height / this.k;
    Object.assign(this.wrap.style, { left: this.x0 + 'px', width: this.cssW * this.k + 'px', height: r.height + 'px' });
    Object.assign(this.frame.style, { width: this.cssW + 'px', height: this.frameH + 'px', transform: 'scale(' + this.k + ')' });
    this.layer.resize(); this.status();
  }
  status() {
    const off = !this.onBase(); const path = this.st ? this.st.path : this.base.pathname;
    this.bar.classList.toggle('off', off); this.bar.classList.toggle('wait', !this.st);
    this.pathLabel.textContent = 'Live ' + path + (!this.st ? ' · connecting…' : ''); this.pathLabel.title = path;
    this.hint.hidden = this.backButton.hidden = !off;
    this.zoomLabel.textContent = Math.round(this.k * 100) + '%'; this.fitButton.setAttribute('aria-pressed', String(this.liveZoom === 'fit'));
  }
  async picked(s, x) {
    if (this.tool === 'live') return;
    const sx = this.st ? this.st.x : 0, sy = this.st ? this.st.y : 0;
    const pt = s.type === 'point' ? [s.x, s.y] : s.type === 'rect' ? [s.x + s.w / 2, s.y + s.h / 2] : s.points ? s.points[Math.floor(s.points.length / 2)] : null;
    const info = !pt ? {} : await new Promise(res => { const id = ++this.seq; this.picks.set(id, res); this.send({ type: 'pick', id, x: pt[0] * this.cssW - sx, y: pt[1] * this.docH - sy }); setTimeout(() => { if (this.picks.delete(id)) res({}); }, 600); });
    const name = info.kind ? info.kind + (info.text ? ' "' + info.text + '"' : '') : '';
    const live = { path: this.st ? this.st.path : this.base.pathname, ...(info.css ? { css: info.css } : {}) };
    if (!this.onBase()) { this.layer.sel = null; this.layer.draw(); return select({ type: 'whole', label: 'On ' + live.path + (name ? ': ' + name : ''), live }, x); }
    select({ ...s, ...(name ? { label: s.type === 'stroke' ? 'Drawing at ' + name : name } : {}), live }, x);
  }
  viewState() { return { live: { path: this.st ? this.st.path : this.base.pathname, scroll: this.st ? Math.round(this.st.y) : 0, width: this.cssW } }; }
  marks(notes, active) { this.notes = notes; this.activeId = active; super.marks(this.onBase() ? notes : [], active); }
  async focus(n) { const bb = bboxOf(shapeOf(n.target.selector) || {}); if (bb && this.onBase()) this.send({ type: 'scrollTo', y: Math.max(0, bb[1] * this.docH - this.frameH / 3), smooth: true }); }
  zoomTo() {} zoomAt() {} wholePage() {} actual() {}
  setZoom(z) { this.liveZoom = z === 'fit' ? z : Math.max(0.25, Math.min(1.5, Math.round(z * 100) / 100)); localStorage.setItem('ar.liveZoom', String(this.liveZoom)); this.resize(); }
  zoomStep(d) { const z = this.liveZoom === 'fit' ? Math.round(this.k * 10) / 10 : this.liveZoom; this.setZoom(z + (d > 0 ? 0.1 : -0.1)); }
  fit() { this.setZoom('fit'); }
  setTool(t) { this.tool = t; localStorage.setItem('ar.liveTool', t); this.layer.setTool(t === 'live' ? null : t); this.layer.cv.style.pointerEvents = t === 'live' ? 'none' : ''; }
  extras() { return [el('button', { class: 'mbtn', onclick: () => { this.frame.src = this.frame.src; } }, 'Reload page'),
    el('button', { class: 'mbtn', onclick: () => open(this.base.href, '_blank', 'noopener') }, 'Open in new tab \u2197'),
    el('button', { class: 'mbtn', onclick: async () => { $('#viewmenu').hidden = true; localStorage.setItem('ar.liveOff', '1'); destroyViews(); await mountViews(); } }, 'Show screenshot')]; }
  info() { return 'Live ' + this.base.href + ' · ' + this.cssW + ' × ' + Math.round(this.frameH) + ' px · notes on ' + this.file.name; }
  destroy() { clearTimeout(this.helloT); removeEventListener('message', this.onMsg); this.pane.removeEventListener('pointerdown', this.onFocus); this.pane.removeEventListener('keydown', this.onKey); this.pane.removeEventListener('wheel', this.onWheel, true); this.ro && this.ro.disconnect(); for (const res of this.picks.values()) res({}); this.picks.clear(); this.frame = null; }
}

// ---------------- text ----------------
// .md files are rendered for reading; .txt files and "Source" show the raw file. Every visible character is a verbatim
// slice of the raw file and each text node remembers its raw offset, so a note always stores raw character offsets.
const MD_INLINE = /(\x60+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?![\s*])(.+?)\*(?![\w*])|(?<!\w)_(?![\s_])(.+?)_(?!\w)|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|#[0-9A-Fa-f]{6}(?![0-9A-Za-z])/;
const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;
const MD_BLOCK = /^\s*(#{1,6}\s|>|\x60\x60\x60|~~~|\||([-*_])(\s*\2){2,}\s*$|[-*+]\s|\d+[.)]\s)/;
function fileView(file) {
  return { image: ImageView, pdf: PdfView, model: ModelView, video: VideoView, audio: AudioView, text: TextView }[file.media]
    || (/\.(json|jsonl|csv|tsv|log|yaml|yml|toml|xml|html|css|js|mjs|cjs|ts|tsx|jsx|py|ps1|sh|lua|luau)$/i.test(file.name) ? TextView : DownloadView);
}
class DownloadView {
  constructor(pane, url, file) { this.pane = pane; this.url = url; this.file = file; }
  async load() {
    this.pane.append(el('div', { class: 'empty' }, el('h2', {}, this.file.name),
      el('p', { class: 'muted' }, 'No preview is available for this file. Download it to open it.'),
      el('p', {}, el('a', { href: this.url, download: this.file.name }, 'Download the file'))));
  }
  tools() { return []; }
  marks() {}
  setTool() {}
  destroy() {}
}
class TextView {
  constructor(pane, url, file, o) { this.pane = pane; this.url = url; this.file = file; this.o = o; this.tool = 'text'; this.isMd = /\.md$/i.test(file.name); this.raw = !this.isMd || localStorage.getItem('ar-md-raw') === '1'; this.notes = []; this.active = null; this.at = new WeakMap(); }
  tools() { return [['text', 'Point', 'Tap a line or select text and say what should change']]; }
  async load() {
    this.txt = await (await fetch(this.url)).text();
    this.div = el('div', { class: 'textview' + (this.o.primary ? ' pick' : '') }); this.pane.append(this.div);
    if (this.isMd) this.pane.append(this.tg = el('button', { class: 'tool sm mdtoggle', title: 'Switch between formatted text and the source file', onclick: () => { this.raw = !this.raw; localStorage.setItem('ar-md-raw', this.raw ? '1' : '0'); this.render(); } }));
    if (this.o.primary) this.div.addEventListener('click', e => this.pick(e));
    this.render();
  }
  info() { return this.file.name + ' · ' + this.txt.length + ' tekens'; }
  setTool() {}
  marks(notes, active) {
    if (!this.div) return; const go = active && active !== this.active; this.notes = notes || []; this.active = active; this.render();
    const m = go && this.div.querySelector('mark.act'); if (m) m.scrollIntoView({ block: 'center' });
  }
  render() {
    const top = this.div.scrollTop; this.at = new WeakMap(); this.mk = []; let p = 0;
    const ns = this.notes.filter(n => n.target.selector.type === 'text' && n.target.selector.start != null).sort((x, y) => x.target.selector.start - y.target.selector.start);
    for (const n of ns) { const s = n.target.selector; if (s.start < p) continue; this.mk.push({ s: s.start, e: s.end, n }); p = s.end; }
    this.div.classList.toggle('raw', this.raw); this.div.classList.toggle('md', !this.raw);
    this.div.replaceChildren(...(this.raw ? this.seg(0, this.txt.length) : this.md()));
    if (this.tg) this.tg.textContent = this.raw ? 'Formatted' : 'Source';
    this.div.scrollTop = top;
  }
  // raw text [a, b) as text nodes, split where note marks start and end
  seg(a, b) {
    const out = [], tn = (x, y) => { const t = document.createTextNode(this.txt.slice(x, y)); this.at.set(t, x); return t; }; let p = a;
    for (const m of this.mk) { if (m.e <= p || m.s >= b) continue; const s = Math.max(m.s, p), e = Math.min(m.e, b); if (s > p) out.push(tn(p, s));
      out.push(el('mark', { 'data-n': m.n.mark, class: (m.n.id === this.active ? 'act' : '') + (s > m.s ? ' cont' : ''), style: { '--c': VERDICT[m.n.verdict][1] } }, tn(s, e))); p = e; }
    if (p < b) out.push(tn(p, b)); return out;
  }
  url2(src) { try { const u = new URL(src, new URL(this.url, location.href)); if (!/^https?:$/.test(u.protocol)) return null; if (PROJECT && u.origin === location.origin && u.pathname.startsWith('/data/') && !u.searchParams.has('p')) u.searchParams.set('p', PROJECT); return u.href; } catch (e) { return null; } }
  inline(a, b) {
    const out = [], s = this.txt.slice(a, b), re = new RegExp(MD_INLINE.source, 'dg'); let p = 0, m;
    while ((m = re.exec(s))) {
      const I = k => [a + m.indices[k][0], a + m.indices[k][1]], href = m[10] != null ? this.url2(m[10]) : null;
      if (m.index > p) out.push(this.seg(a + p, a + m.index));
      if (m[2] != null) out.push(el('code', {}, this.seg(...I(2))));
      else if (m[3] != null || m[4] != null) out.push(el('strong', {}, this.inline(...I(m[3] != null ? 3 : 4))));
      else if (m[5] != null || m[6] != null) out.push(el('em', {}, this.inline(...I(m[5] != null ? 5 : 6))));
      else if (m[8] != null) out.push(this.fig(m[8], I(7)));
      else if (m[10] != null) out.push(href ? el('a', { href, target: '_blank', rel: 'noopener' }, this.inline(...I(9))) : this.inline(...I(9)));
      else out.push(el('span', { class: 'hex' }, el('i', { class: 'sw', style: { background: m[0] } }), this.seg(a + m.index, a + m.index + m[0].length)));
      p = m.index + m[0].length;
    }
    if (p < s.length) out.push(this.seg(a + p, b)); return out;
  }
  // an image in the brief: a file of this version opens in the viewer (to point at it), anything else in a new tab
  fig(src, [x, y]) {
    const url = this.url2(src), name = decodeURIComponent(src.replace(/^\.\//, '')), fi = this.o.primary ? verInfo().files.findIndex(f => f.name === name) : -1;
    return el('figure', {}, url ? el('img', { src: url, alt: this.txt.slice(x, y), loading: 'lazy', onerror: e => e.target.replaceWith(el('span', { class: 'imgmissing' }, 'Image missing: ' + (name.split('/').pop() || src))), title: fi >= 0 ? 'Open this image to point at it' : 'Open in a new tab', onclick: () => fi >= 0 ? showFile(fi) : open(url, '_blank', 'noopener') }) : null, x < y ? el('figcaption', {}, this.inline(x, y)) : null);
  }
  cells(ln) {
    const s = ln.s, out = []; let k = s.indexOf('|'); if (k < 0) return out;
    while (k < s.length) { let n = s.indexOf('|', k + 1); if (n < 0) n = s.length; let x = k + 1, y = n; while (x < y && /\s/.test(s[x])) x++; while (y > x && /\s/.test(s[y - 1])) y--;
      if (n < s.length || x < y) out.push([ln.a + x, ln.a + y]); k = n; }
    return out;
  }
  md() {
    const T = this.txt, L = []; for (let i = 0; i <= T.length;) { let j = T.indexOf('\n', i); if (j < 0) j = T.length; const b = T[j - 1] === '\r' ? j - 1 : j; L.push({ a: i, b, s: T.slice(i, b) }); i = j + 1; }
    const out = []; let i = 0;
    while (i < L.length) {
      const { a, s } = L[i]; let m;
      if (!s.trim()) { i++; continue; }
      if ((m = /^\s*(\x60\x60\x60|~~~)/.exec(s))) { let j = i + 1; while (j < L.length && !L[j].s.trimStart().startsWith(m[1])) j++;
        out.push(el('pre', {}, el('code', {}, j > i + 1 ? this.seg(L[i + 1].a, L[j - 1].b) : null))); i = j + 1; continue; }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/d.exec(s))) { const [x, y] = m.indices[2]; out.push(el('h' + Math.min(m[1].length, 4), {}, this.inline(a + x, a + y))); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) { out.push(el('hr')); i++; continue; }
      if (/^\s*\|/.test(s) && L[i + 1] && /^\s*\|?\s*:?-{2,}/.test(L[i + 1].s)) {
        let j = i + 2; while (j < L.length && /^\s*\|/.test(L[j].s)) j++;
        const row = (ln, tag) => el('tr', {}, this.cells(ln).map(([x, y]) => el(tag, {}, this.inline(x, y))));
        out.push(el('div', { class: 'tw' }, el('table', {}, el('thead', {}, row(L[i], 'th')), el('tbody', {}, L.slice(i + 2, j).map(ln => row(ln, 'td'))))));
        i = j; continue; }
      if (/^\s*>/.test(s)) { const kids = []; let j = i;
        while (j < L.length && /^\s*>/.test(L[j].s)) { const x = L[j].a + /^\s*>\s?/.exec(L[j].s)[0].length; if (j > i) kids.push(this.seg(L[j - 1].b, x)); kids.push(this.inline(x, L[j].b)); j++; }
        out.push(el('blockquote', {}, kids)); i = j; continue; }
      if (MD_LIST.test(s)) { const ord = /^\s*\d/.test(s), items = []; let j = i;
        while (j < L.length) { const t = L[j].s, lm = MD_LIST.exec(t);
          if (lm) { items.push({ d: Math.min(2, lm[1].replace(/\t/g, '  ').length >> 1), cb: lm[3] ? /x/i.test(lm[3]) : null, n: ord ? parseInt(lm[2], 10) : null, kids: [this.inline(L[j].a + lm[0].length, L[j].b)] }); j++; continue; }
          if (t.trim() && /^\s/.test(t) && items.length && !MD_BLOCK.test(t)) { const x = L[j].a + /^\s*/.exec(t)[0].length; items[items.length - 1].kids.push(this.seg(L[j - 1].b, x), this.inline(x, L[j].b)); j++; continue; } // continuation line
          if (!t.trim() && L[j + 1] && MD_LIST.test(L[j + 1].s)) { j++; continue; } // loose list
          break; }
        out.push(el(ord ? 'ol' : 'ul', {}, items.map(it => el('li', { class: [it.d ? 'd' + it.d : '', it.cb != null ? 'task' : ''].join(' ').trim() || null, value: it.n }, it.cb != null ? el('span', { class: 'cb' + (it.cb ? ' on' : ''), role: 'img', 'aria-label': it.cb ? 'done' : 'open' }) : null, it.kids))));
        i = j; continue; }
      let j = i + 1; while (j < L.length && L[j].s.trim() && !MD_BLOCK.test(L[j].s)) j++;
      if (L.slice(i, j).every(ln => /^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/.test(ln.s))) { out.push(el('div', { class: 'gallery' }, L.slice(i, j).map(ln => this.inline(ln.a, ln.b)))); i = j; continue; } // a paragraph of only images
      const kids = []; for (let k = i; k < j; k++) { if (k > i) kids.push(this.seg(L[k - 1].b, L[k].a)); kids.push(this.inline(L[k].a, L[k].b)); }
      out.push(el('p', {}, kids)); i = j;
    }
    return out;
  }
  // raw offset of a DOM point: inside a text node directly, otherwise the next text node after it
  pos(node, off) {
    if (node.nodeType === 3 && this.at.has(node)) return this.at.get(node) + off;
    const r = document.createRange(); r.setStart(node, off); const w = document.createTreeWalker(this.div, NodeFilter.SHOW_TEXT); let last = null;
    for (let t = w.nextNode(); t; t = w.nextNode()) { if (!this.at.has(t)) continue; if (r.comparePoint(t, 0) >= 0) return this.at.get(t); last = t; }
    return last ? this.at.get(last) + last.length : this.txt.length;
  }
  span(blk) { const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT); let a = null, b = null; for (let t = w.nextNode(); t; t = w.nextNode()) { const s = this.at.get(t); if (s == null) continue; if (a == null) a = s; b = s + t.length; } return a == null ? [0, 0] : [a, b]; }
  // a drag selects words; a tap selects the paragraph, list item or table cell (in the source view: the line)
  pick(e) {
    if (e.target.closest('a,img,button')) return;
    const T = this.txt, sel = getSelection(); let a, b;
    if (sel.rangeCount && !sel.isCollapsed && this.div.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0); a = this.pos(r.startContainer, r.startOffset); b = this.pos(r.endContainer, r.endOffset); const w = /[\p{L}\p{N}_]/u;
      while (a > 0 && w.test(T[a - 1])) a--; while (b < T.length && w.test(T[b])) b++;
    } else {
      const blk = !this.raw && e.target.closest('h1,h2,h3,h4,p,li,th,td,figcaption,blockquote,pre');
      if (blk && this.div.contains(blk)) [a, b] = this.span(blk);
      else { const c = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null; if (!c) return; const o = this.pos(c.startContainer, c.startOffset);
        a = T.lastIndexOf('\n', o - 1) + 1; b = T.indexOf('\n', o); if (b < 0) b = T.length; }
    }
    while (a < b && /\s/.test(T[a])) a++; while (b > a && /\s/.test(T[b - 1])) b--;
    if (b - a < 2) return; sel.removeAllRanges();
    select({ type: 'text', quote: T.slice(a, b), start: a, end: b, line: T.slice(0, a).split('\n').length, prefix: T.slice(Math.max(0, a - 30), a), suffix: T.slice(b, b + 30) });
  }
  async capture() { return {}; }
  destroy() {}
}

// Coloured bars above a timeline slider, one per time note; click jumps to the note.
function timelineMarks(wrap, notes, duration) {
  const layer = wrap.querySelector('.tlmarks') || wrap.appendChild(el('div', { class: 'tlmarks' }));
  layer.replaceChildren(...(notes || []).map(n => { const s = n.target.selector; const a = s.type === 'time' ? s.start : s.frame != null ? s.frame / (s.fps || 24) : null; if (a == null) return null; const b = s.type === 'time' ? s.end : a;
    return el('button', { class: 'tlm', title: '#' + n.mark + ' ' + n.text, style: { '--c': VERDICT[n.verdict][1], left: (100 * a / duration) + '%', width: 'max(6px, ' + (100 * (b - a) / duration) + '%)' }, onclick: () => focusNote(n) }, String(n.mark)); }).filter(Boolean));
}

// ---------------- video ----------------
class VideoView {
  constructor(pane, url, file, o) { this.pane = pane; this.url = url; this.file = file; this.o = o; this.tool = 'point'; const fps = Object.hasOwn(file, 'fps') ? file.fps : (verInfo().meta || {}).fps; this.fps = Number.isFinite(+fps) && +fps > 0 && +fps <= 1000 ? +fps : null; this.inp = null; this.out = null; }
  tools() { return [['point', 'Point', 'Click or drag on this frame; for a stretch of time: In and Out on the timeline'], ['pen', 'Draw', 'Draw on this frame']]; }
  async load() {
    this.v = el('video', { src: this.url, muted: '', playsinline: '', preload: 'auto', style: { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain' } }); this.v.muted = true; this.pane.append(this.v);
    await new Promise((r, no) => { if (this.v.readyState >= 2) r(); else { this.v.onloadeddata = r; this.v.onerror = () => no(new Error('video cannot be played')); } });
    this.layer = new Layer2D(this.pane, () => this.box(), s => { this.v.pause(); const r = s.w != null ? { x: s.x, y: s.y, w: s.w, h: s.h } : { x: r4(Math.max(0, s.x - 0.03)), y: r4(Math.max(0, s.y - 0.03)), w: 0.06, h: 0.06 };
      select({ type: 'time', ...this.range(), at: +this.v.currentTime.toFixed(3), frame: this.frame(), rect: r, ...(s.type === 'stroke' ? { stroke: s.points } : {}) }); });
    this.layer.setTool(this.o.primary ? this.tool : null);
    this.layer.visible = n => { const s = n.target.selector; const t = this.v.currentTime; return s.type !== 'time' || (t >= s.start - 0.02 && t <= s.end + 0.02); };
    this.ro = new ResizeObserver(() => this.layer.resize()); this.ro.observe(this.pane); this.layer.resize();
    this.v.ontimeupdate = () => { this.layer.draw(); this.syncTl(); if (this.peer && this.peer.v && Math.abs(this.peer.v.currentTime - this.v.currentTime) > 0.05) this.peer.v.currentTime = this.v.currentTime; };
    if (this.o.primary) { this.timeline(); this.posterFrame().catch(() => {}); }
  }
  // A clip that opens on black shows its first visible frame at once (the time label says where); never after the reviewer moved the playhead.
  async posterFrame() {
    const c = document.createElement('canvas'); c.width = 32; c.height = 18; const g = c.getContext('2d', { willReadFrequently: true });
    const lum = () => { g.drawImage(this.v, 0, 0, 32, 18); const d = g.getImageData(0, 0, 32, 18).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; return s / (d.length / 4); };
    if (lum() > 10) return; const end = Math.min(this.v.duration * 0.25, 8);
    for (let t = 0.25; t <= end; t += 0.25) { if (this.touched || this.dead || !this.v.paused) return; await this.seek(t); if (this.touched || this.dead) return; if (lum() > 10) { this.syncTl(); return; } }
    if (!this.touched && !this.dead) await this.seek(0);
  }
  jump(sec) { this.touched = true; this.v.pause(); this.v.currentTime = Math.max(0, Math.min(this.v.duration, this.v.currentTime + sec)); }
  // Fine scrubbing for a thumb: dragging this strip moves one frame per 8 px, the slider above stays for big jumps.
  jogStrip() {
    const dt = this.fps ? 1 / this.fps : 0.04; let d = null;
    const j = el('div', { class: 'jog', role: 'slider', 'aria-label': 'Fine seek: drag left or right', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(this.v.duration * 100) / 100), title: 'Drag to fine seek: 1 frame per 8 px' }, el('span', {}, '◂ fine seek ▸'));
    j.addEventListener('pointerdown', e => { e.preventDefault(); j.setPointerCapture(e.pointerId); this.touched = true; this.v.pause(); d = { x: e.clientX, t: this.v.currentTime }; j.classList.add('on'); });
    j.addEventListener('pointermove', e => { if (!d) return; const t = Math.max(0, Math.min(this.v.duration, d.t + Math.round((e.clientX - d.x) / 8) * dt)); if (Math.abs(t - this.v.currentTime) > 1e-4) { this.v.currentTime = t; if (this.peer && this.peer.v) this.peer.v.currentTime = t; } });
    const end = () => { d = null; j.classList.remove('on'); }; j.addEventListener('pointerup', end); j.addEventListener('pointercancel', end);
    return j;
  }
  box() { const r = this.pane.getBoundingClientRect(); const s = Math.min(r.width / this.v.videoWidth, r.height / this.v.videoHeight); const w = this.v.videoWidth * s, h = this.v.videoHeight * s; return { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h }; }
  frame() { return this.fps ? Math.round(this.v.currentTime * this.fps) : undefined; }
  range() { const a = this.inp ?? this.v.currentTime, b = this.out ?? a; const s = Math.min(a, b), e = Math.max(a, b); return { start: +s.toFixed(3), end: +e.toFixed(3), ...(this.fps ? { frame_start: Math.round(s * this.fps), frame_end: Math.round(e * this.fps), fps: this.fps } : {}) }; }
  timeline() {
    const tl = $('#timeline'); tl.className = 'on';
    this.play = el('button', { class: 'vplay', 'aria-label': 'Play or pause', onclick: () => { this.touched = true; if (this.v.paused) { this.v.play(); this.peer && this.peer.v && this.peer.v.play(); } else { this.v.pause(); this.peer && this.peer.v && this.peer.v.pause(); } this.syncTl(); } }, '▶');
    this.sl = el('input', { type: 'range', min: 0, max: this.v.duration, step: this.fps ? 1 / this.fps : 0.01, value: 0, 'aria-label': 'Timeline', oninput: e => { this.touched = true; this.v.currentTime = +e.target.value; if (this.peer && this.peer.v) this.peer.v.currentTime = +e.target.value; } });
    this.lab = el('span', { class: 'fr' }); this.tlw = el('div', { class: 'tlwrap' }, this.sl);
    const speed = el('select', { 'aria-label': 'Speed', title: 'Playback speed', onchange: e => { this.v.playbackRate = +e.target.value; if (this.peer && this.peer.v) this.peer.v.playbackRate = +e.target.value; } }, [['0.25', '0.25x'], ['0.5', '0.5x'], ['1', '1x']].map(([v, l]) => el('option', { value: v, selected: v === '1' }, l)));
    const loop = el('button', { class: 'tgl', title: 'Repeat the range between In and Out', onclick: e => { this.loop = !this.loop; e.currentTarget.classList.toggle('on', this.loop); } }, 'Loop');
    const onion = this.fps ? el('button', { class: 'tgl', title: 'Show 2 frames before and after, see-through (when paused)', onclick: e => { this.onion = !this.onion; e.currentTarget.classList.toggle('on', this.onion); this.drawOnion(); } }, 'Onion skin') : null;
    this.sound = el('button', { title: 'Sound of the open video on or off', 'aria-pressed': 'false', onclick: () => { this.v.muted = !this.v.muted; if (this.peer && this.peer.v) this.peer.v.muted = true; this.syncTl(); } }, 'Sound on');
    const volume = el('input', { type: 'range', class: 'video-volume', min: 0, max: 1, step: 0.05, value: this.v.volume, title: 'Volume', 'aria-label': 'Volume', oninput: e => { this.v.volume = +e.target.value; this.v.muted = this.v.volume === 0; if (this.peer && this.peer.v) this.peer.v.muted = true; this.syncTl(); } });
    tl.replaceChildren(this.play, el('button', { class: 'vsec', title: '1 second back', 'aria-label': '1 second back', onclick: () => this.jump(-1) }, '−1s'), el('button', { class: 'vframe', 'aria-label': this.fps ? 'Previous frame' : '0.1 second back', title: this.fps ? 'Previous frame (,)' : '0.1 second back (,)' , onclick: () => this.step(-1) }, '◀|'), el('button', { class: 'vframe', 'aria-label': this.fps ? 'Next frame' : '0.1 second forward', title: this.fps ? 'Next frame (.)' : '0.1 second forward (.)' , onclick: () => this.step(1) }, '|▶'), el('button', { class: 'vsec', title: '1 second forward', 'aria-label': '1 second forward', onclick: () => this.jump(1) }, '+1s'), this.tlw, this.jogStrip(), this.lab, el('div', { class: 'tlmore' },
      el('button', { title: 'Start of the range (I)', onclick: () => this.markIn() }, 'In'), el('button', { title: 'End of the range (U)', onclick: () => this.markOut() }, 'Out'), loop, speed, this.sound, volume, onion),  // the dock already holds Download for this file
      el('button', { class: 'addnote', title: 'Note on this frame or the range between In and Out', onclick: () => { this.v.pause(); S.lastPt = null; select({ type: 'time', ...this.range() }); } }, '+ Note'));
    const tick = () => { if (this.dead) return; if (this.loop && !this.v.paused) { const r = this.range(); if (r.end > r.start && (this.v.currentTime >= r.end || this.v.currentTime < r.start - 0.05)) this.v.currentTime = r.start; } this.raf = this.v.requestVideoFrameCallback ? this.v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick); };
    tick(); this.v.addEventListener('seeked', () => this.drawOnion()); this.v.addEventListener('pause', () => this.drawOnion()); this.v.addEventListener('play', () => this.drawOnion());
    this.syncTl();
  }
  async drawOnion() {
    if (!this.oc) { this.oc = el('canvas', { class: 'onion', style: { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' } }); this.pane.insertBefore(this.oc, this.layer.cv); }
    const r = this.pane.getBoundingClientRect(); this.oc.width = r.width; this.oc.height = r.height; const g = this.oc.getContext('2d'); g.clearRect(0, 0, r.width, r.height);
    if (!this.onion || !this.v.paused) return;
    if (!this.ghosts) this.ghosts = [0, 1].map(() => { const v = el('video', { src: this.url, muted: '', preload: 'auto' }); v.muted = true; return v; });
    const t = this.v.currentTime, b = this.box();
    for (const [v, dt, tint] of [[this.ghosts[0], -2, '#d4573f'], [this.ghosts[1], 2, '#6f9dcb']]) {
      const tt = Math.max(0, Math.min(this.v.duration, t + dt / this.fps)); if (v.readyState < 2) await new Promise(res => { v.onloadeddata = res; });
      await new Promise(res => { v.onseeked = res; v.currentTime = tt; }); if (Math.abs(this.v.currentTime - t) > 1e-3) return;
      g.globalAlpha = 0.38; g.drawImage(v, b.x, b.y, b.w, b.h); g.globalAlpha = 0.16; g.fillStyle = tint; g.fillRect(b.x, b.y, b.w, b.h); g.globalAlpha = 1;
    }
  }
  step(d) { this.touched = true; this.v.pause(); this.v.currentTime = Math.max(0, Math.min(this.v.duration, this.v.currentTime + d * (this.fps ? 1 / this.fps : 0.1))); }
  syncTl() { if (this.sound) { this.sound.textContent = this.v.muted ? 'Sound on' : 'Sound off'; this.sound.setAttribute('aria-pressed', String(!this.v.muted)); } if (!this.sl) return; this.sl.value = this.v.currentTime; this.play.textContent = this.v.paused ? '▶' : '❚❚'; const r = this.range(); this.lab.textContent = this.fps ? 'frame ' + this.frame() + ' / ' + Math.round(this.v.duration * this.fps) + (this.inp != null || this.out != null ? '  [' + r.frame_start + '-' + r.frame_end + ']' : '') : this.v.currentTime.toFixed(2) + ' / ' + this.v.duration.toFixed(2) + ' s'; }
  info() { return this.file.name + ' · ' + this.v.videoWidth + 'x' + this.v.videoHeight + ' · ' + this.v.duration.toFixed(2) + ' s' + (this.fps ? ' @' + this.fps + ' fps' : this.file.fps_source === 'variable' ? ' · variable frame rate' : ' · frame rate unknown'); }
  setTool(t) { this.tool = t; this.layer.setTool(t === 'point' || t === 'pen' ? t : null); }
  togglePlay() { this.play.click(); }
  stepFrame(d) { this.step(d); }
  markIn() { this.inp = this.v.currentTime; this.syncTl(); }
  markOut() { this.out = this.v.currentTime; this.syncTl(); }
  async thumb() { const v = el('video', { src: this.url, muted: '', preload: 'auto' }); v.muted = true; await new Promise(r => { v.onloadeddata = r; v.onerror = r; }); await new Promise(r => { v.onseeked = r; v.currentTime = v.duration * 0.4; });
    const c = document.createElement('canvas'); c.width = 360; c.height = Math.round(360 * v.videoHeight / v.videoWidth); c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); return c.toDataURL('image/png'); }
  clearSelection() { this.layer.sel = null; this.layer.draw(); }
  marks(notes, active) { this.layer.notes = notes; this.layer.active = active; this.layer.draw(); if (this.tlw) timelineMarks(this.tlw, notes, this.v.duration); }
  async seek(t) { if (Math.abs(this.v.currentTime - t) < 1e-3) return; await new Promise(r => { this.v.onseeked = r; this.v.currentTime = t; }); }
  async focus(n) { const s = n.target.selector; if (s.type === 'time') { this.touched = true; this.v.pause(); await this.seek(s.at ?? s.start); this.inp = s.start; this.out = s.end; this.syncTl(); } }
  // Range notes without a region get a start/middle/end filmstrip so the agent sees the motion, not one frame.
  async strip(s) {
    const W = this.v.videoWidth, H = this.v.videoHeight, k = Math.min(1, 480 / W), w = Math.round(W * k), h = Math.round(H * k);
    const ts = [s.start, (s.start + s.end) / 2, s.end]; const c = document.createElement('canvas'); c.width = w * 3 + 8; c.height = h; const g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, h); g.font = 'bold 14px Segoe UI';
    for (let i = 0; i < 3; i++) { await this.seek(ts[i]); const x = i * (w + 4); g.drawImage(this.v, x, 0, w, h); g.fillStyle = '#000a'; g.fillRect(x, 0, 104, 24); g.fillStyle = '#fff'; g.fillText(this.fps ? 'frame ' + Math.round(ts[i] * this.fps) : ts[i].toFixed(2) + ' s', x + 6, 17); }
    return c.toDataURL('image/png');
  }
  async capture(n, all) {
    const s = n.target.selector; this.v.pause();
    const film = s.type === 'time' && !s.rect && s.end - s.start > (this.fps ? 1.5 / this.fps : 0.1) ? await this.strip(s) : null;
    if (s.type === 'time') await this.seek(s.at ?? s.start);
    const W = this.v.videoWidth, H = this.v.videoHeight; const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(this.v, 0, 0, W, H);
    const plain = scaled(c); const r = s.rect || (s.type !== 'time' && s.type !== 'whole' ? s : null);
    const sh = shapeOf(s); if (sh) drawShape(g, sh, W, H, VERDICT[n.verdict][1], true);
    const crop = film || (r && r.w ? cropCanvas(c, r.x * W, r.y * H, r.w * W, r.h * H) : scaled(c, 1024).toDataURL('image/png'));
    const ctx = plain.getContext('2d'); ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, 360, 34); ctx.fillStyle = '#fff'; ctx.font = 'bold 18px Segoe UI'; ctx.fillText('#' + n.mark + '  ' + describe(n.target), 10, 23);
    if (sh) drawShape(ctx, sh, plain.width, plain.height, VERDICT[n.verdict][1], true);
    return { crop, context: plain.toDataURL('image/png') };
  }
  destroy() { this.dead = true; this.ro && this.ro.disconnect(); if (this.v) { this.v.pause(); this.v.removeAttribute('src'); this.v.load(); } this.loop = false; if (this.o.primary) $('#timeline').className = ''; }
}

// R3I-003 begin
// R3I-002 begin
import { installVideoReview } from './video-review.js';
const videoReviewKey = installVideoReview(VideoView, { el, $, active: () => S.mode === 'review' ? S.view : null });
const reviewKeyFallback = onKey;
onKey = function (e) { if (!videoReviewKey(e)) return reviewKeyFallback(e); };
// R3I-002 end
import { installVideoTimestamps } from './video-timestamps.js';
installVideoTimestamps(VideoView, { el });
// R3I-003 end

// ---------------- audio ----------------
const ACtx = new (window.AudioContext || window.webkitAudioContext)();
function wavUrl(buf, s0, s1) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = Math.max(1, s1 - s0); const dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c)); let o = 44;
  for (let i = s0; i < s0 + n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i] || 0)); dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  let bin = ''; const u = new Uint8Array(dv.buffer); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return 'data:audio/wav;base64,' + btoa(bin);
}
function levels(buf, a = 0, b = buf.duration) {
  const d = buf.getChannelData(0); const s0 = Math.floor(a * buf.sampleRate), s1 = Math.min(d.length, Math.ceil(b * buf.sampleRate)); let pk = 0, sq = 0;
  for (let i = s0; i < s1; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; sq += v * v; }
  const db = x => x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf'; return { peak: db(pk), rms: db(Math.sqrt(sq / Math.max(1, s1 - s0))) };
}
function drawWave(g, buf, W, H, a, b) {
  g.fillStyle = '#101317'; g.fillRect(0, 0, W, H); g.strokeStyle = '#2b3139'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  const d = buf.getChannelData(0); const s0 = a * buf.sampleRate, per = (b - a) * buf.sampleRate / W; g.fillStyle = '#7fb3e6';
  for (let x = 0; x < W; x++) { let mn = 1, mx = -1; const i0 = Math.floor(s0 + x * per), i1 = Math.floor(s0 + (x + 1) * per); for (let i = i0; i < Math.max(i1, i0 + 1) && i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; } if (mx < mn) continue; g.fillRect(x, H / 2 - mx * H * 0.45, 1, Math.max(1, (mx - mn) * H * 0.45)); }
  const raw = (b - a) * 80 / W, p = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 5, 10].map(m => m * p).find(s => s >= raw);
  g.fillStyle = '#8b95a1'; g.font = '11px Segoe UI'; for (let t = Math.ceil(a / step) * step; t < b; t += step) { const x = (t - a) / (b - a) * W; g.fillRect(x, H - 10, 1, 10); g.fillText(step < 1 ? (t * 1000).toFixed(0) + ' ms' : t.toFixed(step < 10 ? 1 : 0) + ' s', x + 3, H - 2); }
}
// Integrated loudness after ITU-R BS.1770 (K-weighting, 400 ms blocks, -70 LUFS and -10 LU gates).
// WebAudio's shelf has a fixed slope, so the value is an approximation (about 0.5 LU); label it as such.
async function lufs(buf, a = 0, b = buf.duration) {
  const sr = buf.sampleRate, n = Math.max(1, Math.round((b - a) * sr)); const oc = new OfflineAudioContext(buf.numberOfChannels, n, sr);
  const src = oc.createBufferSource(); src.buffer = buf; const hs = oc.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 1681.97; hs.gain.value = 4;
  const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38.13; hp.Q.value = -6.02;
  src.connect(hs).connect(hp).connect(oc.destination); src.start(0, a, b - a); const out = await oc.startRendering();
  const blk = Math.min(n, Math.round(0.4 * sr)), hop = Math.max(1, Math.round(0.1 * sr)), zs = [];
  for (let s = 0; s + blk <= n; s += hop) { let z = 0; for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); let q = 0; for (let i = s; i < s + blk; i++) q += d[i] * d[i]; z += q / blk; } zs.push(z); }
  const L = z => -0.691 + 10 * Math.log10(z), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let g = zs.filter(z => z > 0 && L(z) > -70); if (!g.length) return null; const rel = L(mean(g)) - 10; g = g.filter(z => L(z) > rel);
  return +L(mean(g)).toFixed(1);
}
class AudioView {
  constructor(pane, url, file, o) { this.pane = pane; this.url = url; this.file = file; this.o = o; this.tool = 'range'; this.sel = null; this.useB = false; this.inlineExtras = true; this.rate = 1; }
  tools() { return [['range', 'Point', 'Drag over the waveform to select a range']]; }
  async load() {
    const res = await fetch(this.url); if (!res.ok) throw new Error('sound not found (' + res.status + ')');
    this.buf = await ACtx.decodeAudioData(await res.arrayBuffer());
    this.lufsAll = await lufs(this.buf);
    this.cv = el('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } }); this.pane.append(this.cv);
    this.infoEl = el('div', { class: 'waveinfo' }); this.pane.append(this.infoEl);
    const T = e => { const r = this.cv.getBoundingClientRect(); return Math.max(0, Math.min(this.buf.duration, (e.clientX - r.left) / r.width * this.buf.duration)); };
    if (this.o.primary) {
      this.cv.onpointerdown = e => { try { this.cv.setPointerCapture(e.pointerId); } catch (x) {} this.drag = [T(e), T(e)]; };
      this.cv.onpointercancel = () => { this.drag = null; this.draw(); };
      this.cv.onpointermove = e => { if (this.drag) { this.drag[1] = T(e); this.sel = this.cur(); this.draw(); } };
      this.cv.onpointerup = async () => {
        if (!this.drag) return; const s = this.cur(); this.drag = null;
        if (s.end - s.start < 0.005) { const had = !!this.sel; this.sel = null; this.seek(s.start); if (had) renderDock(); return; } // a click sets the play position
        this.stop(); const lv = levels(this.buf, s.start, s.end); s.lufs = await lufs(this.buf, s.start, s.end); this.sel = s; this.draw(); renderDock();
        select({ type: 'time', start: s.start, end: s.end, start_ms: Math.round(s.start * 1000), end_ms: Math.round(s.end * 1000), levels: { peak_dbfs: +lv.peak, rms_dbfs: +lv.rms, lufs_approx: s.lufs, file_lufs_approx: this.lufsAll } });
      };
    }
    this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(this.pane); this.draw();
    if (this.o.primary && S.autoNext) { S.autoNext = false; if (S.autoplay) this.playSel(); } // the next file of a set starts by itself
  }
  cur() { const [a, b] = this.drag; return { start: +Math.min(a, b).toFixed(4), end: +Math.max(a, b).toFixed(4) }; }
  extras() {
    this.playBtn = el('button', { class: 'tool labeled', title: 'Play / pause (space)', onclick: () => this.togglePlay() });
    this.rateBtn = el('button', { class: 'tool labeled', title: 'Speed: ← slower, → faster. Click = 1×', onclick: () => { this.rate = 1; this.setRate(0); } });
    this.syncBtn();
    const rateControls = matchMedia('(pointer:coarse)').matches ? el('div', { class: 'audio-speed', role: 'group', 'aria-label': 'Playback speed' },
      el('button', { class: 'tool', 'aria-label': 'Slower', title: 'Slower (←)', onclick: () => this.setRate(-1) }, '−'), this.rateBtn,
      el('button', { class: 'tool', 'aria-label': 'Faster', title: 'Faster (→)', onclick: () => this.setRate(1) }, '+')) : this.rateBtn;
    const b = [this.playBtn, el('button', { class: 'tool', title: 'Stop and go back to the start', 'aria-label': 'Stop', onclick: () => this.stop() }, '■'), rateControls];
    const autoLabel = () => matchMedia(PHONE).matches ? 'Auto ' + (S.autoplay ? 'on' : 'off') : 'Auto-play';
    if (verInfo().files.length > 1) b.push(el('button', { class: 'tool labeled autoplay', 'aria-pressed': String(!!S.autoplay), title: 'Play the next file automatically', onclick: e => { S.autoplay = !S.autoplay; localStorage.setItem('ar-autoplay', S.autoplay ? '1' : '0'); e.currentTarget.setAttribute('aria-pressed', String(S.autoplay)); $('.lbl', e.currentTarget).textContent = autoLabel(); } }, el('span', { class: 'lbl' }, autoLabel())));
    // Hear it in context: loop another sound of this project quietly underneath (music or ambience under an SFX).
    const beds = []; for (const [aid, a] of Object.entries(S.cat.assets)) for (const [sid, st] of Object.entries(a.stages)) { const ver = st.versions[st.versions.length - 1]; for (const f of (ver ? ver.files : [])) if (f.media === 'audio') { const u = dataUrl(aid, sid, ver.v, f.name); if (u !== this.url) beds.push([u, f.name.replace(/\.[^.]+$/, '')]); } }
    const key = 'ar-bed-' + (PROJECT || ''); if (this.bedUrl === undefined) { const m = localStorage.getItem(key); this.bedUrl = beds.some(x => x[0] === m) ? m : ''; }
    if (beds.length) b.push(el('select', { class: 'bedsel', title: 'Play another sound quietly underneath, to hear it in context', 'aria-label': 'Underneath',
      onchange: e => { this.bedUrl = e.target.value; localStorage.setItem(key, this.bedUrl); if (this.bed) { this.bed.pause(); this.bed = null; } if (this.playing) this.startBed(); } },
      el('option', { value: '' }, 'Underneath: nothing'), beds.map(([u, l]) => el('option', { value: u, selected: u === this.bedUrl }, 'Underneath: ' + l))));
    if (this.peer && this.peer.buf) b.push(el('button', { class: 'tool', 'aria-pressed': String(this.useB), title: 'Play the same range from the previous version at equal loudness (LUFS), so the louder one does not win by default', onclick: e => { this.useB = !this.useB; e.currentTarget.setAttribute('aria-pressed', String(this.useB)); } }, 'A/B', el('span', { class: 'lbl' }, 'previous, equal loudness')));
    return b;
  }
  syncBtn() {
    if (this.playBtn) this.playBtn.replaceChildren(this.playing ? '❚❚' : '▶', el('span', { class: 'lbl' }, this.playing ? 'Pause' : 'Play'));
    if (this.rateBtn) this.rateBtn.replaceChildren(el('span', { class: 'lbl' }, 'Snelheid'), String(this.rate).replace('.', ',') + '×');
  }
  // Playback runs through an <audio> element so speed changes keep the pitch; WebAudio still sets the A/B loudness gain.
  media(v) { if (!v.au) { v.au = new Audio(v.url); v.au.preload = 'auto'; v.gainN = ACtx.createGain(); ACtx.createMediaElementSource(v.au).connect(v.gainN).connect(ACtx.destination); } return v.au; }
  now() { return this.playing && this.live ? this.live.currentTime : this.pos; }
  halt() { if (this.live) { this.live.onended = null; this.live.pause(); } if (this.bed) this.bed.pause(); this.playing = false; cancelAnimationFrame(this.raf); }
  startBed() { if (!this.bedUrl) return; if (!this.bed) { this.bed = new Audio(this.bedUrl); this.bed.loop = true; this.bed.volume = 0.3; } this.bed.play().catch(() => {}); }
  finish() { this.halt(); this.pos = null; this.syncBtn(); this.draw(); }
  setRate(d) { const R = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]; const i = R.indexOf(this.rate); this.rate = R[Math.max(0, Math.min(R.length - 1, (i < 0 ? 3 : i) + d))]; if (this.live) this.live.playbackRate = this.rate; this.syncBtn(); }
  playSel() {
    this.halt();
    const v = this.useB && this.peer ? this.peer : this; const s = this.sel || { start: 0, end: v.buf.duration }; const end = Math.min(s.end, v.buf.duration);
    const from = this.pos != null && this.pos >= s.start && this.pos < end - 0.01 ? this.pos : s.start;
    const a = this.media(v); const db = v !== this && this.lufsAll != null && v.lufsAll != null ? this.lufsAll - v.lufsAll : 0;
    v.gainN.gain.value = Math.pow(10, Math.max(-24, Math.min(24, db)) / 20);
    a.currentTime = from; a.playbackRate = this.rate; a.preservesPitch = true; ACtx.resume();
    this.live = a; this.playing = true; a.onended = () => this.finish(); a.play().catch(() => this.finish()); this.startBed();
    const tick = () => { if (!this.playing) return; if (a.currentTime >= end - 0.005) return this.finish(); this.draw(); this.raf = requestAnimationFrame(tick); }; tick(); this.syncBtn();
  }
  pause() { if (!this.playing) return; const t = this.now(); this.halt(); this.pos = t; this.syncBtn(); this.draw(); }
  stop() { this.halt(); this.pos = null; this.syncBtn(); if (this.cv) this.draw(); }
  seek(t) { const was = this.playing; this.halt(); this.pos = t; if (was) this.playSel(); else { this.syncBtn(); this.draw(); } }
  draw() {
    const r = this.pane.getBoundingClientRect(), k = devicePixelRatio || 1; this.cv.width = r.width * k; this.cv.height = r.height * k; const g = this.cv.getContext('2d'); g.setTransform(k, 0, 0, k, 0, 0);
    drawWave(g, this.buf, r.width, r.height, 0, this.buf.duration);
    const X = t => t / this.buf.duration * r.width;
    for (const n of this.notes || []) { const s = n.target.selector; if (s.type !== 'time') continue; const col = VERDICT[n.verdict][1]; g.fillStyle = col + '44'; g.fillRect(X(s.start), 0, Math.max(2, X(s.end) - X(s.start)), r.height); drawMark(g, X(s.start) + 14, 46, n.mark, col, n.id === this.active); }
    if (this.sel) { const a = X(this.sel.start), w = Math.max(2, X(this.sel.end) - a); g.fillStyle = 'rgba(91,156,255,.16)'; g.fillRect(a, 0, w, r.height); g.fillStyle = '#5b9cff'; g.fillRect(a, 0, 2, r.height); g.fillRect(a + w - 2, 0, 2, r.height); }
    const ph = this.now(); if (ph != null) { g.fillStyle = '#ffd166'; g.fillRect(Math.round(X(Math.min(ph, this.buf.duration))) - 1, 0, 2, r.height); }
    const f = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0');
    const key = this.sel ? this.sel.start + '-' + this.sel.end : 'all'; if (this.lvKey !== key) { this.lvKey = key; this.lv = levels(this.buf, ...(this.sel ? [this.sel.start, this.sel.end] : [])); } const L = this.lv;
    const lu = this.sel ? this.sel.lufs : this.lufsAll;
    this.infoEl.textContent = f(Math.min(ph ?? this.sel?.start ?? 0, this.buf.duration)) + ' / ' + f(this.buf.duration) + (this.rate !== 1 ? ' @ ' + this.rate + '×' : '') + ' · ' + (this.sel ? 'range ' + Math.round(this.sel.start * 1000) + '-' + Math.round(this.sel.end * 1000) + ' ms · ' : '') + 'peak ' + L.peak + ' dBFS · RMS ' + L.rms + ' dBFS · ' + (lu == null ? '' : '≈' + lu + ' LUFS') + (this.sel ? ' (file ≈' + this.lufsAll + ' LUFS)' : '');
  }
  info() { return this.file.name + ' · ' + this.buf.duration.toFixed(3) + ' s · ' + this.buf.sampleRate + ' Hz · ' + this.buf.numberOfChannels + ' ch'; }
  setTool() {}
  togglePlay() { if (this.playing) this.pause(); else this.playSel(); }
  async thumb() { const c = document.createElement('canvas'); c.width = 360; c.height = 120; drawWave(c.getContext('2d'), this.buf, 360, 120, 0, this.buf.duration); return c.toDataURL('image/png'); }
  clearSelection() { this.sel = null; this.stop(); }
  marks(notes, active) { this.notes = notes; this.active = active; if (this.cv) this.draw(); }
  async focus(n) { const s = n.target.selector; if (s.type === 'time') { this.sel = { start: s.start, end: s.end }; this.stop(); } }
  async capture(n, all) {
    const s = n.target.selector; const D = this.buf.duration;
    const ctx = document.createElement('canvas'); ctx.width = 1400; ctx.height = 260; const g = ctx.getContext('2d'); drawWave(g, this.buf, 1400, 260, 0, D);
    for (const m of all) { const t = m.target.selector; if (t.type !== 'time') continue; const col = VERDICT[m.verdict][1]; g.fillStyle = col + (m.id === n.id ? '66' : '33'); g.fillRect(t.start / D * 1400, 0, Math.max(2, (t.end - t.start) / D * 1400), 260); drawMark(g, t.start / D * 1400 + 14, 18, m.mark, col, m.id === n.id); }
    if (s.type !== 'time') return { context: ctx.toDataURL('image/png') };
    const pad = Math.max(0.02, (s.end - s.start) * 0.25); const a = Math.max(0, s.start - pad), b = Math.min(D, s.end + pad);
    const cc = document.createElement('canvas'); cc.width = 1000; cc.height = 240; const g2 = cc.getContext('2d'); drawWave(g2, this.buf, 1000, 240, a, b);
    g2.fillStyle = VERDICT[n.verdict][1] + '44'; g2.fillRect((s.start - a) / (b - a) * 1000, 0, (s.end - s.start) / (b - a) * 1000, 240); drawMark(g2, (s.start - a) / (b - a) * 1000 + 14, 18, n.mark, VERDICT[n.verdict][1], true);
    return { crop: cc.toDataURL('image/png'), context: ctx.toDataURL('image/png'), clip: wavUrl(this.buf, Math.floor(s.start * this.buf.sampleRate), Math.ceil(s.end * this.buf.sampleRate)) };
  }
  destroy() { this.ro && this.ro.disconnect(); this.halt(); if (this.au) { this.au.removeAttribute('src'); this.au.load(); } }
}

// R3I-004 begin
import { installAudioReview } from './audio-review.js';
installAudioReview(AudioView, { context: ACtx, el, comparing: () => S.compare });
// Preserve transport through the existing navigation/remount paths, including reviewed versions.
let audioRemount = null;
const destroyAudioViews = destroyViews, mountAudioViews = mountViews;
const audioCompareSource = cmpSource;
cmpSource = function () {
  const source = audioCompareSource(), file = verInfo()?.files[S.file];
  if (!source || file?.media !== 'audio') return source;
  const match = source.ver.files.find(item => item.media === 'audio' && item.name === file.name);
  return match ? { ...source, ver: { ...source.ver, files: [match, ...source.ver.files.filter(item => item !== match)] } } : source;
};
destroyViews = function () {
  if (S.view instanceof AudioView) audioRemount = { ...S.view.audioIdentity, state: S.view.audioState() };
  else audioRemount = null;
  destroyAudioViews();
};
mountViews = async function (token) {
  const saved = audioRemount; audioRemount = null;
  const sameReview = saved && saved.asset === S.asset && saved.stage === S.stage;
  const restore = sameReview && (saved.version !== S.v || verInfo().files[S.file]?.name === saved.file);
  const index = restore ? verInfo().files.findIndex(file => file.media === 'audio' && file.name === saved.file) : -1;
  if (index >= 0) S.file = index;
  await mountAudioViews(token);
  if ((token != null && token !== S.nav) || !(S.view instanceof AudioView)) return;
  const view = S.view;
  view.audioIdentity = { asset: S.asset, stage: S.stage, version: S.v, file: view.file.name };
  view.peer = S.cmp instanceof AudioView && S.cmp.file.name === view.file.name ? S.cmp : null;
  if (restore && index >= 0) view.restoreAudio(saved.state);
  else if (restore) { view.restoreAudio({ ...saved.state, playing: false }); view.useB = true; view.peer = null; view.bounds(saved.state.position); view.draw(); }
  renderDock();
};
// R3I-004 end

// R3I-016 begin
import { makeAbFlip } from './ab-flip.js';
let abFlip = null, abMounting = 0;
const renderAbBar = renderCmpBar, destroyAbViews = destroyViews, mountAbViews = mountViews, abKeyFallback = onKey;
renderCmpBar = function () {
  renderAbBar();
  if (!S.compare || abMounting) return;
  if (!abFlip) abFlip = makeAbFlip({
    get: () => ({ compare: S.compare, mode: S.cmpMode, primary: S.view, peer: S.cmp,
      source: cmpSource(), version: S.v, scope: [PROJECT || S.proj?.home || '', S.asset, S.stage] }),
    bar: $('#cmpbar'), container: $('#view'), el, storage: () => localStorage,
    blocked: () => S.mode !== 'review' || !!document.querySelector('dialog[open]')
  });
  abFlip.render();
};
destroyViews = function () { abFlip?.destroy(); abFlip = null; destroyAbViews(); };
mountViews = async function (token) {
  abMounting++;
  try { await mountAbViews(token); } finally { abMounting--; }
  if (!abMounting && (token == null || token === S.nav)) renderCmpBar();
};
onKey = function (event) {
  if (event.key?.toLowerCase() === 'f') { abFlip?.key(event); return; }
  return abKeyFallback(event);
};
// R3I-016 end

// R3I-006 begin
import { mountSpectralEvents } from './spectral-events.js';
// Additive lifecycle hook keeps waveform, loudness, selections and verdicts intact.
const spectralAudioLoad = AudioView.prototype.load;
const spectralAudioDestroy = AudioView.prototype.destroy;
AudioView.prototype.load = async function (...args) {
  await spectralAudioLoad.apply(this, args);
  if (!this.spectralUnmounted) this.spectralStrip = mountSpectralEvents(this.pane, { seek: t => {
    this.sel = null; this.seek(t); if (this.o.primary) renderDock();
  } }, this.file.preflight?.stats?.spectral_events, this.buf.duration);
};
AudioView.prototype.destroy = function (...args) {
  this.spectralUnmounted = true;
  this.spectralStrip?.destroy();
  return spectralAudioDestroy.apply(this, args);
};
// R3I-006 end

// R3C-014 begin
// Keep audio failures local to the view, including comparison panes and late loads.
const recoverAudioLoad = AudioView.prototype.load;
const releaseAudioResources = AudioView.prototype.destroy;
AudioView.prototype.destroy = function (...args) {
  releaseAudioResources.apply(this, args);
  this.cv?.remove(); this.infoEl?.remove(); this.audioError?.remove();
  this.buf = null;
};
AudioView.prototype.load = async function (...args) {
  try {
    await recoverAudioLoad.apply(this, args);
    if (this.dead) this.destroy();
  } catch (cause) {
    if (this.dead) return;
    this.destroy();
    const error = new Error(this.file.name + ' could not be loaded. Choose another file.', { cause });
    error.audioView = this;
    this.audioError = el('div', { class: 'empty', role: 'alert', 'aria-atomic': 'true' }, error.message);
    this.pane.append(this.audioError);
    throw error;
  }
};
const mountRecoverableAudio = mountViews;
mountViews = async function (...args) {
  try { await mountRecoverableAudio.apply(this, args); }
  catch (error) {
    const failed = error.audioView;
    if (!(failed instanceof AudioView)) throw error;
    const key = failed.o.primary ? 'view' : 'cmp';
    if (S[key] !== failed) return;
    S[key] = null;
    if (failed.o.primary) S.autoNext = false;
    renderDock(); renderCmpBar(); refreshMarks();
  }
};
// R3C-014 end

// ---------------- 3D model (GLB) ----------------
const groupColor = g => { let h = 0; for (const c of String(g)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.55); };
// Automatic 3D parts. Nodes with extras pf_part (names from the brief's parts list) are one part each, labelled pf_label or pf_part.
// Each other group (pf_group or node-name prefix) has a shell: its big pieces, named after the group ("Toren").
// Small pieces that touch with the same material, or sit inside each other, form one part; repeated parts share a name with a number ("Wiel 3").
const GROUP_NAME = { body: 'Hull', turret: 'Turret', gun: 'Gun', armL: 'Left arm', armR: 'Right arm', legL: 'Left leg', legR: 'Right leg', weapon: 'Weapon', head: 'Head' };
const PART_NAME = { rubber: 'Wheel', track: 'Track', lamp: 'Lamp', glass: 'Glass', emblem: 'Emblem', wood: 'Wood', canvas: 'Tarp', mud: 'Mud', helmet: 'Helmet', boots: 'Boot', strap: 'Strap', eye: 'Eye', brass: 'Brass', blanket: 'Blanket' };
const PAINT = new Set(['body', 'body_dark', 'camo', 'camo_dark', 'uniform', 'uniform_dark']); // small pieces in these colours are part of the shell they sit on
function autoParts(meshes, root) {
  if (!meshes.length) return new Map();
  root.updateMatrixWorld(true);
  const vol = b => { const s = b.getSize(new THREE.Vector3()); return Math.max(s.x, 1e-6) * Math.max(s.y, 1e-6) * Math.max(s.z, 1e-6); };
  const info = meshes.map(o => {
    const tagged = u => u && (u.pf_role || u.pf_part); const ex = tagged(o.userData) ? o.userData : (o.parent && tagged(o.parent.userData) ? o.parent.userData : {}); const node = String(o.userData.gltfName || o.name);
    const box = new THREE.Box3().setFromObject(o);
    return { o, node, pf: !!ex.pf_role, part: ex.pf_label || ex.pf_part, role: ex.pf_role || (o.material && o.material.name) || '', grp: ex.pf_group || (/^[A-Za-z]+\.[A-Za-z]/.test(node) ? node.split('.')[0] : ''), box, size: box.getSize(new THREE.Vector3()), vol: vol(box) };
  });
  const vehicle = info.some(m => m.role === 'track' || m.grp === 'turret' || m.grp === 'gun');
  const roleN = {}; info.forEach(m => { roleN[m.role] = (roleN[m.role] || 0) + 1; });
  const chain = m => m.role === 'track' || /track|link|chain/i.test(m.node) || roleN[m.role] >= 40; // track links: many copies with small gaps between them
  const gname = g => g === 'body' && !vehicle ? 'Body' : GROUP_NAME[g] || (g ? g.replace(/[_.]/g, ' ') : 'Model');
  const byG = new Map(), named = new Map(); info.forEach((m, i) => { const k = m.part ? named : byG, key = m.part || m.grp; if (!k.has(key)) k.set(key, []); k.get(key).push(i); });
  const main = byG.size ? [...byG.entries()].sort((a, b) => b[1].length - a[1].length)[0][0] : '';
  const clusters = [...named].map(([name, ids]) => { const c = new THREE.Vector3(); ids.forEach(i => c.add(info[i].box.getCenter(new THREE.Vector3()))); return { id: 'n:' + name, grp: info[ids[0]].grp, own: ids, all: ids, name, suf: '', base: name, c: c.divideScalar(ids.length) }; });
  for (const [g, idx] of byG) {
    const gb = new THREE.Box3(); idx.forEach(i => gb.union(info[i].box)); const gs = gb.getSize(new THREE.Vector3()); const eps = gs.length() * 0.004;
    const gv = vol(gb); let shell = idx.filter(i => { const s = info[i].size; return info[i].vol > 0.12 * gv && (s.x > gs.x * 0.6) + (s.y > gs.y * 0.6) + (s.z > gs.z * 0.6) >= 2; }); // a helmet is as wide as the body, but not as big
    if (!shell.length) shell = [idx.reduce((a, b) => info[b].vol > info[a].vol ? b : a)];
    const small = idx.filter(i => !shell.includes(i)); const par = new Map(small.map(i => [i, i]));
    const find = i => { while (par.get(i) !== i) { par.set(i, par.get(par.get(i))); i = par.get(i); } return i; };
    if (small.length <= 1500) for (let a = 0; a < small.length; a++) { const A = info[small[a]], ea = A.box.clone().expandByScalar(chain(A) ? Math.max(eps, 0.6 * Math.max(A.size.x, A.size.y, A.size.z)) : eps);
      for (let b = a + 1; b < small.length; b++) { const B = info[small[b]]; if (!ea.intersectsBox(B.box)) continue;
        if (A.role !== B.role) { const I = A.box.clone().intersect(B.box); if (I.isEmpty() || vol(I) < 0.5 * Math.min(A.vol, B.vol)) continue; }
        par.set(find(small[a]), find(small[b])); } }
    const cm = new Map(); for (const i of small) { const r = find(i); if (!cm.has(r)) cm.set(r, []); cm.get(r).push(i); }
    const paint = new Set([...PAINT, ...shell.map(i => info[i].role)]);
    if (info[shell[0]].pf) for (const [r, ids] of [...cm]) if (ids.every(i => paint.has(info[i].role))) { shell.push(...ids); cm.delete(r); }
    clusters.push({ id: 'g:' + g, grp: g, shell: true, own: shell, all: idx, label: gname(g), base: gname(g) });
    for (const ids of cm.values()) {
      const roles = {}; ids.forEach(i => { roles[info[i].role] = (roles[info[i].role] || 0) + 1; });
      const dom = Object.entries(roles).sort((a, b) => b[1] - a[1])[0][0]; const big = ids.reduce((a, b) => info[b].vol > info[a].vol ? b : a);
      let name = !info[big].pf ? info[big].node.replace(/[._]\d+$/, '').replace(/[._]/g, ' ')
        : roles.rubber ? 'Wheel' : roles.track ? 'Track' : dom === 'skin' ? (/^arm/.test(g) ? 'Hand' : 'Face') : dom === 'canvas' && !vehicle ? 'Canvas' : PART_NAME[dom] || ROLE_NL[dom] || dom.replace(/_/g, ' ');
      const suf = g !== main ? ' · ' + gname(g).toLowerCase() : '';
      const c = new THREE.Vector3(); ids.forEach(i => c.add(info[i].box.getCenter(new THREE.Vector3()))); c.divideScalar(ids.length);
      clusters.push({ id: 'c' + clusters.length, grp: g, own: ids, all: ids, name, suf, base: name + suf, c });
    }
  }
  const all = new THREE.Box3(); info.forEach(m => all.union(m.box)); const as = all.getSize(new THREE.Vector3()); const ax = as.x >= as.z ? 'x' : 'z', bx = ax === 'x' ? 'z' : 'x';
  const same = new Map(); for (const c of clusters) if (!c.shell) { if (!same.has(c.base)) same.set(c.base, []); same.get(c.base).push(c); }
  for (const cs of same.values()) { cs.sort((a, b) => (a.c[ax] - b.c[ax]) || (a.c[bx] - b.c[bx])); cs.forEach((c, n) => { c.label = cs.length > 1 ? c.name + ' ' + (n + 1) + c.suf : c.base; }); }
  const out = new Map(); for (const c of clusters) { const ms = c.all.map(i => info[i].o); out.set(c.id, { id: c.id, label: c.label, base: c.base, shell: !!c.shell, grp: c.grp, meshes: ms }); for (const i of c.own) info[i].o.userData.pkey = c.id; }
  return out;
}
// three.js arrives with the first 3D view. Only then can the inspection overlays hook the loader, so that install runs again here.
const need3d = () => load3d().then(() => installInspectionOverlays(ModelView, { el, GLTFLoader }));
class ModelView {
  constructor(pane, url, file, o) { this.pane = pane; this.url = url; this.file = file; this.o = o; this.tool = 'part'; this.selected = new Set(); this.hi = new Set(); this.flags = { wire: false, groups: S.stage === 'rig', spin: false, pivots: S.stage === 'rig' }; this.pin = null; }
  tools() { return [['part', 'Point', 'Click a part (Shift = more, Alt = one separate piece). Drag to rotate the model'], ['pen', 'Draw', 'Draw on the model from this camera; the tool finds the parts underneath']].concat(this.mixer ? [['time', 'Time range', 'Click a part for the range between In and Out']] : []); }
  async load() {
    await need3d(); if (this.dead) return;
    const resourceBytes = Math.max(this.file.bytes || 0, this.file.preflight?.stats?.resource_bytes || 0, this.file.preflight?.stats?.resource_workload_bytes || 0);
    if (!this.largeModelAllowed && resourceBytes > 150 * 1024 * 1024) {
      await new Promise(resolve => {
        this.cancelLoad = resolve;
        const gate = this.loadGate = el('div', { class: 'empty' }, (resourceBytes / 1024 / 1024).toFixed(1) + ' MiB · Model over 150 MiB', el('button', { class: 'mbtn', onclick: () => { this.largeModelAllowed = true; gate.remove(); this.loadGate = null; resolve(); } }, 'Load anyway'));
        this.pane.append(gate);
      });
      this.cancelLoad = null; if (this.dead) return;
    }
    while (!this.dead) {
      try { await this.loadModel(); return; }
      catch (error) {
        if (this.dead) return;
        if (!this.renderer) throw error; // renderer allocation errors are not failed file loads
        this.teardownLoad();
        await new Promise(resolve => {
          this.cancelLoad = resolve;
          this.loadError = el('div', { class: 'empty', role: 'alert' },
            el('div', {}, this.file.name + ' could not be loaded. ' + String(error.message || error)),
            el('button', { class: 'mbtn', 'aria-label': 'Try again: ' + this.file.name, onclick: () => { this.loadError?.remove(); this.loadError = null; resolve(); } }, 'Try again'));
          this.pane.append(this.loadError);
        });
        this.cancelLoad = null;
      }
    }
  }
  async loadModel() {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true }); r.setPixelRatio(Math.min(devicePixelRatio, 2)); r.outputColorSpace = THREE.SRGBColorSpace;
    this.pane.append(r.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(getComputedStyle($('#view')).getPropertyValue('--canvas').trim() || '#4b4b49');
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 2000);
    this.scene.add(new THREE.HemisphereLight(0xe6eeff, 0x6b5f4a, 1.7)); const sun = this.sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(5, 9, 6); this.scene.add(sun, sun.target);
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; // only the Speelveld turns castShadow on
    this.controls = new OrbitControls(this.camera, r.domElement); this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.syncPeer());
    const loader = new GLTFLoader(), extensions = new Set([...(this.file.preflight?.stats?.extensionsUsed || []), ...(this.file.preflight?.stats?.extensionsRequired || [])]);
    // Older catalogs lack extension facts: inspect the JSON before configuring decoders.
    this.loadAbort = new AbortController();
    const response = await fetch(this.url, { cache: 'no-store', signal: this.loadAbort.signal }); if (!response.ok) throw new Error('Model HTTP ' + response.status);
    const data = await response.arrayBuffer();
    if (this.dead) return;
    this.assetHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), x => x.toString(16).padStart(2, '0')).join('');
    if (this.dead) return;
    const jsonData = this.url.split('?')[0].toLowerCase().endsWith('.gltf') ? JSON.parse(new TextDecoder().decode(data)) : JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, new DataView(data).getUint32(12, true))));
    for (const extension of [...(jsonData.extensionsUsed || []), ...(jsonData.extensionsRequired || [])]) extensions.add(extension);
    if (extensions.has('KHR_draco_mesh_compression')) {
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      this.draco = new DRACOLoader().setDecoderPath('/vendor/three/addons/libs/draco/gltf/'); loader.setDRACOLoader(this.draco);
    }
    if (extensions.has('KHR_texture_basisu')) {
      const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
      this.ktx2 = new KTX2Loader().setTranscoderPath('/vendor/three/addons/libs/basis/').detectSupport(r); loader.setKTX2Loader(this.ktx2);
    }
    if (extensions.has('EXT_meshopt_compression') || extensions.has('KHR_meshopt_compression')) {
      const { MeshoptDecoder } = await import('/vendor/meshoptimizer/meshopt_decoder.module.js'); loader.setMeshoptDecoder(MeshoptDecoder);
    }
    if (this.dead) { this.disposeScene(); return; }
    const gltf = await loader.parseAsync(data, new URL('.', new URL(this.url, location.href)).href); this.root = gltf.scene; this.scene.add(this.root);
    if (this.dead) { this.disposeScene(); return; } // the reviewer moved on while the model loaded
    // three.js strips '.' from node names; keep the exact glTF/Blender node name for agents
    const json = gltf.parser.json; this.byName = new Map();
    this.root.traverse(o => { const a = gltf.parser.associations.get(o); const ni = a && a.nodes !== undefined ? a.nodes : null; o.userData.gltfName = ni != null ? json.nodes[ni].name : (o.parent && o.parent.userData.gltfName && o.isMesh ? o.parent.userData.gltfName : o.name); this.byName.set(o.userData.gltfName, o); });
    this.meshes = []; this.tris = 0;
    this.root.traverse(o => { if (o.isMesh) { this.meshes.push(o); o.userData.orig = o.material; const g = o.geometry; this.tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
    // R3I-019 begin
    let reference;
    try { reference = await import('./reference-view.js'); }
    catch (error) {
      this.referenceAvailability = { schema: 'r3i-019/reference-1', status: 'unsupported', metrics: {}, units: {}, assumptions: [], diagnostics: ['Reference controls unavailable: ' + error.message] };
      this.pane.append(el('span', { role: 'status' }, this.referenceAvailability.diagnostics[0]));
    }
    if (reference && !this.dead) await reference.attachReferenceView(this, gltf, { THREE, el });
    if (this.dead) { this.disposeScene(); return; }
    // R3I-019 end
    this.groups = autoParts(this.meshes, this.root); // logical parts with readable names; mesh.userData.pkey points at its part
    const box = new THREE.Box3().setFromObject(this.root); const size = box.getSize(new THREE.Vector3()); const c = box.getCenter(new THREE.Vector3()); this.radius = size.length() / 2; this.size0 = size;
    const grid = this.grid = new THREE.GridHelper(this.radius * 6, 24, 0x555b63, 0x3a3f46); grid.position.y = box.min.y; this.scene.add(grid);
    this.c0 = c; this.controls.addEventListener('start', () => { this.userMoved = true; });
    this.setView(this.home = this.homeView());
    this.pivotHelpers = []; this.root.traverse(o => { if (!o.isMesh && o.userData && o.userData.pf_role === 'pivot') { const a = new THREE.AxesHelper(this.radius * 0.35); a.material.depthTest = false; a.renderOrder = 9; o.add(a); this.pivotHelpers.push(a); } });
    if (gltf.animations.length) { this.clips = gltf.animations; this.mixer = new THREE.AnimationMixer(this.root); for (const cl of gltf.animations) this.mixer.clipAction(cl).play(); this.duration = Math.max(...gltf.animations.map(a => a.duration)); this.fps = 24; this.time = 0; this.playing = true; this.inp = null; this.out = null; }
    this.markDiv = el('div', { class: 'marks' }); this.pane.append(this.markDiv);
    if (this.o.primary) {
      this.sketch = new Layer2D(this.pane, () => { const r = this.pane.getBoundingClientRect(); return { x: 0, y: 0, w: r.width, h: r.height }; }, s => this.onSketch(s));
      this.sketch.setTool(null); this.sketch.cv.style.pointerEvents = 'none'; this.sketch.visible = n => n.target.selector.type !== 'sketch' ? false : this.camMatches(n.view);
      this.controls.addEventListener('change', () => this.sketch.draw()); this.sro = new ResizeObserver(() => this.sketch.resize()); this.sro.observe(this.pane); this.sketch.resize();
    }
    if (this.o.primary) {
      this.inspectTools = new InspectTools(this, { refreshMaterials: () => this.applyMats(), activateMeasure: () => { this.setTool('part'); if (this.o.primary) renderDock(); } });
      this.inspectTools.mountToolbar(this.pane, {
        versions: stageInfo(S.asset, S.stage).versions, current: S.v, comparing: S.compare && cmpSource()?.stage === S.stage, comparison: cmpSource()?.v,
        compare: async version => {
          if (S.compare && cmpSource()?.stage === S.stage && cmpSource()?.v === version) return toggleCompare();
          S.inspectCompare = { asset: S.asset, stage: S.stage, v: version }; S.cmpWith = null; S.compare = true; S.cmpMode = 'side';
          destroyViews(); await mountViews(); renderSide();
        }
      });
    }
    this.ray = new THREE.Raycaster(); let down = null;
    r.domElement.onpointerdown = e => { down = [e.clientX, e.clientY]; this.dragging = true; this.setHoverKey(null); showHover(null); };
    r.domElement.onpointerup = e => { this.dragging = false; const d = down; down = null; if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4 || !this.o.primary) return; if (!this.inspectTools.handleClick(e)) this.pick(e); };
    r.domElement.onpointermove = e => {
      this.hover = e; if (this.dragging || !this.o.primary || this.tool === 'pen' || e.pointerType === 'touch') return;
      if (!this.hoverRaf) this.hoverRaf = requestAnimationFrame(() => { this.hoverRaf = 0; const h = this.hit(this.hover); const k = h ? h.object.userData.pkey : null; this.setHoverKey(k); showHover(k ? (this.hover.altKey ? partName(this.partInfo(h.object)) + ' (one piece)' : this.groups.get(k).label) : null, this.hover.clientX, this.hover.clientY); });
    };
    r.domElement.onpointerleave = () => { this.setHoverKey(null); showHover(null); };
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.pane); this.resize();
    this.applyMats(); this.clock = new THREE.Timer();
    r.setAnimationLoop(() => this.frame());
    if (this.o.primary && this.mixer) this.timeline();
  }
  setView(v) {
    const damping = this.controls.enableDamping; this.controls.enableDamping = false; this.controls.update();
    const projection = v.projection || 'perspective', aspect = this.camera.aspect || 1;
    if ((projection === 'orthographic') !== !!this.camera.isOrthographicCamera) {
      this.camera = projection === 'orthographic' ? new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.01, 2000) : new THREE.PerspectiveCamera(v.fov || 38, aspect, 0.01, 2000);
      this.camera.aspect = aspect; this.controls.object = this.camera;
    }
    this.camera.position.fromArray(v.position); this.controls.target.fromArray(v.target); this.camera.fov = v.fov || 38; this.camera.zoom = v.zoom || 1;
    if (this.camera.isOrthographicCamera) { this.orthoHeight = v.orthoHeight || 2 * this.camera.position.distanceTo(this.controls.target) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)); this.camera.top = this.orthoHeight / 2; this.camera.bottom = -this.camera.top; this.camera.right = this.camera.top * aspect; this.camera.left = -this.camera.right; }
    this.camera.updateProjectionMatrix(); this.controls.update(); this.controls.enableDamping = damping;
  }
  viewState() { return { camera: { position: this.camera.position.toArray(), target: this.controls.target.toArray(), fov: this.camera.fov, projection: this.camera.isOrthographicCamera ? 'orthographic' : 'perspective', zoom: this.camera.zoom, orthoHeight: this.orthoHeight }, inspection: this.inspection || 'material', flags: { ...this.flags }, rotation: this.root.rotation.y, clip: this.activeClip ?? 'all', time: this.mixer ? this.time : undefined, frame: this.mixer ? Math.round(this.time * this.fps) : undefined, asset: { id: S.asset, stage: S.stage, version: S.v, hash: this.assetHash } }; }
  resize() { const r = this.pane.getBoundingClientRect(); if (!r.width) return; this.renderer.setSize(r.width, r.height, false); this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%'; this.camera.aspect = r.width / r.height; if (this.camera.isOrthographicCamera) { this.camera.right = this.camera.top * this.camera.aspect; this.camera.left = -this.camera.right; } this.camera.updateProjectionMatrix(); if (this.c0 && !this.userMoved) this.setView(this.home = this.homeView()); }
  setClip(clip) { this.activeClip = clip; for (const [i, cl] of (this.clips || []).entries()) this.mixer.clipAction(cl).enabled = clip === 'all' || i === clip; }
  syncPeer() {
    const peer = this.peer; if (!peer?.camera || this.syncing || peer.syncing) return;
    this.syncing = peer.syncing = true;
    try { peer.userMoved = true; peer.setView(this.viewState().camera); peer.root.rotation.y = this.root.rotation.y; if (peer.mixer && this.mixer) { peer.time = this.time; peer.playing = false; } }
    finally { this.syncing = peer.syncing = false; }
  }
  // R3C-094 begin
  homeView() {
    const pr = this.pane.getBoundingClientRect(), aspect = pr.width > 0 && pr.height > 0 ? pr.width / pr.height : this.camera.aspect || 1;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const tv = Math.tan(vfov / 2) * 0.92, th = Math.tan(hfov / 2) * 0.92; // 4% canvas margin on every edge
    const direction = new THREE.Vector3(1, 0.55, 1.25).normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, direction).normalize(), up = direction.clone().cross(right);
    let d = this.camera.near * 2;
    // Fit all eight corners in camera space, including each corner's depth.
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      const corner = new THREE.Vector3(x * this.size0.x, y * this.size0.y, z * this.size0.z);
      d = Math.max(d, corner.dot(direction) + Math.max(Math.abs(corner.dot(right)) / th, Math.abs(corner.dot(up)) / tv, this.camera.near * 2));
    }
    return { position: this.c0.clone().add(direction.multiplyScalar(d)).toArray(), target: this.c0.toArray() };
  }
  // R3C-094 end
  frame() {
    const dt = this.clock.update().getDelta();
    if (this.mixer) { if (this.playing) this.time = (this.time + dt) % this.duration; this.mixer.setTime(this.time); this.syncTl(); }
    if (this.flags.spin) this.root.rotation.y += dt * 0.5;
    this.inspectTools?.update(); this.controls.update(); if (this.flags.spin || (this.mixer && this.playing)) this.syncPeer(); this.renderer.render(this.scene, this.camera); this.placeMarks();
  }
  path(o) { const p = []; for (let x = o; x && x !== this.root; x = x.parent) p.unshift(x.userData.gltfName || x.name); return p.join('/'); }
  partInfo(o) { const g = o.geometry; const { orig, gltfName, hi, pkey, ...extras } = o.userData; return { node: gltfName || o.name, path: this.path(o), extras, material: (orig && orig.name) || '', tris: (g.index ? g.index.count : g.attributes.position.count) / 3 }; }
  hit(e) { const rc = this.renderer.domElement.getBoundingClientRect(); const m = new THREE.Vector2((e.clientX - rc.left) / rc.width * 2 - 1, -(e.clientY - rc.top) / rc.height * 2 + 1); this.ray.setFromCamera(m, this.camera); return this.ray.intersectObjects(this.meshes, false)[0] || null; }
  // a part id is one part ("c12", "g:turret") or all parts with the same name ("n:Wiel")
  meshesOf(id) { if (!id) return []; if (id.startsWith('n:')) return [...this.groups.values()].filter(g => !g.shell && g.base === id.slice(2)).flatMap(g => g.meshes); const g = this.groups.get(id); return g ? g.meshes : []; }
  setHoverKey(k) { if (k === this.hoverKey) return; this.hoverKey = k; this.hoverSet = k ? new Set(this.meshesOf(k)) : null; this.applyMats(); }
  partList() {
    const gs = [...this.groups.values()], agg = new Map();
    for (const g of gs) if (!g.shell) agg.set(g.base, (agg.get(g.base) || 0) + 1);
    return gs.filter(g => g.shell).map(g => ({ id: g.id, label: g.label, count: 1 }))
      .concat([...agg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'nl')).map(([base, n]) => ({ id: 'n:' + base, label: base, count: n })));
  }
  hoverPart(id) { this.setHoverKey(id || null); }
  selectPart(id, add) {
    const ms = this.meshesOf(id); if (!ms.length) return; const one = this.groups.get(id); const n = id.startsWith('n:') ? [...this.groups.values()].filter(g => g.base === id.slice(2)).length : 1;
    const name = one ? one.label : id.slice(2) + (n > 1 ? ' (all ' + n + ')' : ''); add = add && this.selected.size && !$('#pop').hidden;
    if (add) { for (const o of ms) this.selected.add(o); this.selLabels = [...new Set([...(this.selLabels || []), name])]; } else { this.selected = new Set(ms); this.selLabels = [name]; }
    this.applyMats(); S.lastPt = null;
    select({ type: 'part', label: this.selLabels.join(' + '), parts: [...this.selected].map(o => this.partInfo(o)) }, add ? { keep: true } : {});
  }
  pick(e) {
    const hit = this.hit(e);
    if (!hit) { if (!e.shiftKey) { this.selected.clear(); this.applyMats(); } return; }
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    const rg = this.mixer ? this.range() : null;
    const time = rg ? { frame: Math.round(this.time * this.fps), frames: [rg.frame_start, rg.frame_end], fps: this.fps } : {};
    if (this.tool === 'pin') {
      if (!this.pin) { this.pin = new THREE.Mesh(new THREE.SphereGeometry(this.radius * 0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xe8c45c, depthTest: false })); this.pin.renderOrder = 10; this.scene.add(this.pin); }
      this.pin.position.copy(hit.point); this.pin.visible = true;
      select({ type: 'point', point: hit.point.toArray().map(x => +x.toFixed(4)), normal: n.toArray().map(x => +x.toFixed(3)), node: hit.object.userData.gltfName || hit.object.name, part: this.partInfo(hit.object), ...time });
      return;
    }
    const g = this.groups.get(hit.object.userData.pkey); const objs = e.altKey ? [hit.object] : g.meshes;
    const add = (e.shiftKey || e.ctrlKey || e.metaKey || S.adding) && this.selected.size > 0; // Shift, or "+ Part" on a phone: combine parts in one note
    const name = e.altKey ? partName(this.partInfo(hit.object)) + ' (one piece)' : g.label;
    if (add) { const all = objs.every(o => this.selected.has(o)); for (const o of objs) all ? this.selected.delete(o) : this.selected.add(o); this.selLabels = all ? (this.selLabels || []).filter(x => x !== name) : [...(this.selLabels || []), name]; }
    else { this.selected = new Set(objs); this.selLabels = [name]; }
    this.applyMats();
    const parts = [...this.selected].map(o => this.partInfo(o)); if (!parts.length) return;
    const label = this.selLabels.join(' + ');
    select({ type: this.tool === 'time' ? 'time' : 'part', label, parts, point: hit.point.toArray().map(x => +x.toFixed(4)), ...(this.tool === 'time' ? this.range() : time) }, add ? { keep: true } : {});
  }
  // highlight copies live in a WeakMap: storing them in material.userData made every later clone serialise the earlier ones
  hiMat(base, col) { const cache = this.hiCache = this.hiCache || new WeakMap(); let per = cache.get(base); if (!per) cache.set(base, per = {}); if (!per[col]) { const m = base.clone(); m.emissive = new THREE.Color(col); m.emissiveIntensity = col === 0x1f4a99 ? 0.22 : 0.3; per[col] = m; (this.hiMaterials ||= new Set()).add(m); } const m = per[col]; m.wireframe = this.flags.wire; return m; }
  disposeInspection() {
    for (const [mesh, geometry] of this.normalGeometries || []) mesh.geometry = geometry; this.normalGeometries = [];
    for (const overlay of this.wireOverlays || []) overlay.removeFromParent(); this.wireOverlays = [];
    this.bones?.removeFromParent(); this.bones = null;
    for (const resource of this.inspectionResources || []) resource.dispose(); this.inspectionResources = new Set();
    for (const mesh of this.meshes || []) mesh.material = mesh.userData.orig;
    this.inspectionMat = null;
  }
  setInspection(mode, sync = true) {
    this.disposeInspection(); this.inspection = mode;
    const own = resource => { this.inspectionResources.add(resource); return resource; };
    if (mode === 'clay') this.inspectionMat = own(new THREE.MeshStandardMaterial({ color: 0xbcb9b0, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
    if (mode === 'normals') {
      for (const mesh of this.meshes || []) if (!mesh.geometry.attributes.normal) { this.normalGeometries.push([mesh, mesh.geometry]); mesh.geometry = own(mesh.geometry.clone()); mesh.geometry.computeVertexNormals(); }
      this.inspectionMat = own(new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }));
    }
    if (mode === 'uv') {
      const size = 64, pixels = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const c = ((x >> 3) + (y >> 3)) % 2 ? [25, 80, 180] : [240, 220, 70]; pixels.set([...c, 255], (y * size + x) * 4); }
      const texture = own(new THREE.DataTexture(pixels, size, size)); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
      this.inspectionMat = own(new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    }
    if (mode === 'wire') {
      const material = own(new THREE.MeshBasicMaterial({ color: 0x121417, wireframe: true, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      this.wireOverlays = this.meshes.map(mesh => { const overlay = mesh.clone(false); overlay.material = material; overlay.position.set(0, 0, 0); overlay.quaternion.identity(); overlay.scale.set(1, 1, 1); overlay.morphTargetInfluences = mesh.morphTargetInfluences; overlay.renderOrder = 1; mesh.add(overlay); return overlay; });
    }
    if (mode === 'bones') { this.bones = new THREE.SkeletonHelper(this.root); this.bones.material.depthTest = false; this.bones.renderOrder = 2; this.scene.add(this.bones); own(this.bones); }
    this.applyMats(); if (sync && this.peer?.setInspection) this.peer.setInspection(mode, false);
  }
  applyMats() {
    this.gmats = this.gmats || {};
    for (const o of this.meshes) {
      const g = o.userData.pf_group || String(o.userData.gltfName || o.name).split('.')[0];
      let base = this.inspectionMat || o.userData.orig;
      if (!this.inspectionMat && this.flags.groups) base = this.gmats[g] = this.gmats[g] || new THREE.MeshStandardMaterial({ color: groupColor(g), roughness: 0.8 });
      if (this.flags.sil) base = this.silMat = this.silMat || new THREE.MeshBasicMaterial({ color: 0x15181c });
      const col = this.hi.has(o.userData.gltfName) ? 0xf0a020 : this.selected.has(o) ? 0x3f7fff : this.hoverSet && this.hoverSet.has(o) ? 0x1f4a99 : null;
      o.material = col && !this.inspectionMat ? (Array.isArray(base) ? base.map(m => this.hiMat(m, col)) : this.hiMat(base, col)) : base;
    }
    for (const a of this.pivotHelpers || []) a.visible = this.flags.pivots && !this.flags.sil;
    this.scene.background = new THREE.Color(this.flags.sil ? '#f2f0ea' : (getComputedStyle($('#view')).getPropertyValue('--canvas').trim() || '#4b4b49')); if (this.grid) this.grid.visible = !this.flags.sil;
    this.inspectTools?.applyMaterials();
    this.applyField();
  }
  extras() {
    const t = (k, l, tip) => el('button', { class: 'tgl' + (this.flags[k] ? ' on' : ''), title: tip, onclick: e => { this.flags[k] = !this.flags[k]; e.target.classList.toggle('on', this.flags[k]); if (k !== 'spin') this.applyMats(); if (k === 'spin' && !this.flags.spin) this.root.rotation.y = 0; } }, l);
    return [el('div', { class: 'mlabel' }, 'Inspection'), ...[['material', 'Material'], ['wire', 'Wireframe'], ['clay', 'Clay'], ['normals', 'Normals'], ['uv', 'UV checker'], ['bones', 'Bones']].map(([mode, label]) => el('button', { class: 'mbtn', 'aria-pressed': String((this.inspection || 'material') === mode), onclick: e => { this.flags.sil = false; if (this.peer) this.peer.flags.sil = false; this.setInspection(mode); for (const b of e.currentTarget.parentNode.querySelectorAll('button[aria-pressed]')) b.setAttribute('aria-pressed', String(b === e.currentTarget)); } }, label)),
      el('select', { 'aria-label': 'Projection', onchange: e => { this.userMoved = true; this.setView({ ...this.viewState().camera, projection: e.target.value }); } }, ['perspective', 'orthographic'].map(mode => el('option', { value: mode, selected: mode === (this.camera.isOrthographicCamera ? 'orthographic' : 'perspective') }, mode))),
      this.mixer ? el('select', { 'aria-label': 'Animation clip', onchange: e => { this.setClip(e.target.value === 'all' ? 'all' : +e.target.value); } }, el('option', { value: 'all', selected: (this.activeClip ?? 'all') === 'all' }, 'All clips'), this.clips.map((clip, i) => el('option', { value: i, selected: this.activeClip === i }, clip.name || 'Clip ' + i))) : null,
      t('groups', 'Moving groups', 'Colour per group that moves together (rig)'), t('pivots', 'Pivots', 'Show the pivot points'), t('sil', 'Silhouette', 'Flat shape on white: does the shape read at a glance?'), t('spin', 'Rotate', 'Turntable'),
      t('field', 'Play field', 'Roblox baseplate, daylight and a 5-stud player beside it: is the in-game scale right?'),
      this.unitB = el('button', { class: 'mbtn', hidden: !this.flags.field, title: 'Which unit was the model made in? 1 stud = 0.28 m. If the player looks wrong, switch.', onclick: () => { localStorage.setItem('ar-units', fieldUnits() === 'm' ? 'stud' : 'm'); this.field = this.field && (this.scene.remove(this.field), null); this.applyField(); this.playerView(); } }, unitLabel()),
      smallButton(this, () => { this.renderer.setPixelRatio(this.small ? 1 / this.small : Math.min(devicePixelRatio, 2)); this.renderer.domElement.style.imageRendering = this.small ? 'pixelated' : ''; this.resize(); }),
      el('button', { class: 'mbtn', onclick: () => { this.userMoved = false; this.setView(this.home = this.homeView()); } }, 'Reset camera'),
      hasPro() && this.o.primary && S.stage !== 'engine' && CM.can('execute') ? el('button', { class: 'mbtn', title: 'The agent puts this model in its own test place in Roblox Studio and submits screenshots as the In-engine stage', onclick: () => tryInEngine(this.file.name) }, 'Put in Roblox Studio…') : null];
  }
  // Speelveld: a Roblox-like baseplate (1-stud grid), daylight with shadows and a classic 5-stud player next to the asset.
  applyField() {
    const on = !!this.flags.field && !this.flags.sil, u = fieldUnits() === 'm' ? 0.28 : 1;
    const fresh = on && !this.field;
    if (fresh) this.scene.add(this.field = this.buildField(u));
    if (this.field) this.field.visible = on;
    if (this.unitB) { this.unitB.hidden = !this.flags.field; this.unitB.textContent = unitLabel(); }
    if (this.grid) this.grid.visible = !on && !this.flags.sil;
    for (const m of this.meshes) m.castShadow = on;
    this.sun.castShadow = on;
    if (on) { this.scene.background = new THREE.Color(0x9cc8f2); this.scene.fog = new THREE.Fog(0x9cc8f2, this.fieldR * 3, this.fieldR * 9); } else this.scene.fog = null;
    if (fresh && this.o.primary) this.playerView();
  }
  buildField(u) {
    const box = new THREE.Box3().setFromObject(this.root), y0 = box.min.y, c = this.c0, g = new THREE.Group();
    const R = this.fieldR = Math.max(this.radius, 8 * u) * 4;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const x = cv.getContext('2d');
    x.fillStyle = '#7b7e85'; x.fillRect(0, 0, 64, 64); x.strokeStyle = 'rgba(255,255,255,.16)'; x.lineWidth = 2; x.strokeRect(1, 1, 62, 62);
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const size = R * 6; tex.repeat.set(size / u, size / u); // one tile = one stud
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    plate.rotation.x = -Math.PI / 2; plate.position.set(c.x, y0 - 0.002 * u, c.z); plate.receiveShadow = true; g.add(plate);
    // classic R6 proportions in studs: legs 2, torso 2, head 1.2 -> 5.2 studs
    const p = new THREE.Group(), part = (w, h, d, col, px, py) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 })); m.position.set(px, py, 0); m.castShadow = m.receiveShadow = true; p.add(m); };
    part(1, 2, 1, 0xa4bd47, -0.5, 1); part(1, 2, 1, 0xa4bd47, 0.5, 1); part(2, 2, 1, 0x0d69ac, 0, 3); part(1, 2, 1, 0xf5cd30, -1.5, 3); part(1, 2, 1, 0xf5cd30, 1.5, 3); part(1.2, 1.2, 1.2, 0xf5cd30, 0, 4.6);
    p.scale.setScalar(u); p.position.set(box.max.x + 3 * u, y0, c.z); p.rotation.y = -Math.PI / 2; g.add(p); this.player = p;
    const s = this.sun; s.position.copy(c).add(new THREE.Vector3(0.45, 0.8, 0.4).multiplyScalar(R)); s.target.position.copy(c);
    Object.assign(s.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 0.01, far: R * 3 }); s.shadow.camera.updateProjectionMatrix(); s.shadow.mapSize.set(2048, 2048); s.shadow.bias = -0.0005; s.shadow.normalBias = 0.02 * u;
    return g;
  }
  // Over the player's shoulder towards the asset, roughly where the Roblox camera sits.
  playerView() {
    if (!this.player) return; const u = fieldUnits() === 'm' ? 0.28 : 1, head = this.player.position.clone().add(new THREE.Vector3(0, 6 * u, 0));
    const away = head.clone().sub(this.c0).setY(0).normalize(), side = new THREE.Vector3(-away.z, 0, away.x), d = Math.max(14 * u, this.radius * 1.4); this.userMoved = true;
    this.setView({ position: head.clone().add(away.multiplyScalar(d)).add(side.multiplyScalar(d * 0.35)).add(new THREE.Vector3(0, d * 0.3, 0)).toArray(), target: this.c0.clone().lerp(this.player.position, 0.3).toArray() });
  }
  info() {
    const stats = this.file.preflight?.stats, delta = stats?.delta;
    if (!this.groups) return el('div', {}, this.file.name + ' · waiting to load');
    const box = el('div', {}, this.file.name + ' · ' + this.groups.size + ' parts (' + this.meshes.length + ' pieces) · ' + Math.round(stats?.tris ?? this.tris) + ' tris' + (this.mixer ? ' · ' + this.clips.length + ' clips, ' + Math.round(this.duration * this.fps) + ' frames' : ''));
    if (delta) {
      const line = el('div', { class: 'model-delta' }, 'DELTA v' + String(delta.from).padStart(3, '0') + '→v' + String(delta.to).padStart(3, '0') + ': ');
      for (const [i, change] of Object.values(delta.changes).filter(c => c.text).entries()) {
        const diffs = [].concat(change.diff), pcts = [].concat(change.pct);
        const larger = pcts.some((v, j) => v > 15 || (v === null && diffs[j] > 0));
        const smaller = diffs.some(v => v < 0) && diffs.every(v => v <= 0);
        line.append(el('span', { style: { color: larger ? '#e8b35c' : smaller ? '#7aca91' : 'inherit' }, title: 'From ' + change.before + ' to ' + change.after }, (i ? ' · ' : '') + change.text));
      }
      box.append(line);
    }
    // R3F-002 begin
    const sanity = this.file.material_sanity, checks = sanity?.metrics?.checks;
    const known = sanity?.schema_version === 1 && sanity.status === 'ok' && ['pbr_fields', 'texture_roles', 'normal_prerequisites'].every(key => ['pass', 'issues'].includes(checks?.[key]));
    box.append(el('div', {}, 'Material sanity · ' + (known ? (Object.values(checks).includes('issues') ? 'findings' : 'checked') : 'unknown') + (sanity?.status === 'budget_exceeded' ? ' (budget exceeded)' : '')));
    // R3F-002 end
    return box;
  }
  timeline() {
    const tl = $('#timeline'); tl.className = 'on';
    this.play = el('button', { onclick: () => { this.playing = !this.playing; } }, '❚❚');
    this.sl = el('input', { type: 'range', min: 0, max: this.duration, step: this.fps ? 1 / this.fps : 0.01, value: 0, oninput: e => { this.playing = false; this.time = +e.target.value; } });
    this.lab = el('span', { class: 'fr' }); this.tlw = el('div', { class: 'tlwrap' }, this.sl);
    tl.replaceChildren(this.play, el('button', { title: this.fps ? 'Previous frame (,)' : '0.1 second back (,)' , onclick: () => this.stepFrame(-1) }, '◀|'), el('button', { title: this.fps ? 'Next frame (.)' : '0.1 second forward (.)' , onclick: () => this.stepFrame(1) }, '|▶'), this.tlw, this.lab,
      el('button', { title: 'Range start (I)', onclick: () => this.markIn() }, 'In'), el('button', { title: 'Range end (U)', onclick: () => this.markOut() }, 'Out'),
      el('button', { class: 'addnote', title: 'Note on this frame or the range between In and Out (whole model)', onclick: () => { S.lastPt = null; select({ type: 'time', ...this.range() }); } }, '+ Note'));
  }
  range() { const a = this.inp ?? this.time, b = this.out ?? this.time; const s = Math.min(a, b), e = Math.max(a, b); return { start: +s.toFixed(3), end: +e.toFixed(3), ...(this.fps ? { frame_start: Math.round(s * this.fps), frame_end: Math.round(e * this.fps), fps: this.fps } : {}) }; }
  syncTl() { if (this.sound) { this.sound.textContent = this.v.muted ? 'Sound on' : 'Sound off'; this.sound.setAttribute('aria-pressed', String(!this.v.muted)); } if (!this.sl) return; this.sl.value = this.time; this.play.textContent = this.playing ? '❚❚' : '▶'; this.lab.textContent = 'frame ' + Math.round(this.time * this.fps) + ' / ' + Math.round(this.duration * this.fps) + (this.inp != null || this.out != null ? '  [' + this.range().frame_start + '-' + this.range().frame_end + ']' : ''); }
  anchor(n) {
    const s = n.target.selector;
    if (s.parts && s.parts.length) { const b = new THREE.Box3(); for (const p of s.parts) { const o = this.byName.get(p.node); if (o) b.expandByObject(o); } if (!b.isEmpty()) return b.getCenter(new THREE.Vector3()); }
    if (s.point) return new THREE.Vector3().fromArray(s.point);
    return null;
  }
  placeMarks() {
    const r = this.renderer.domElement.getBoundingClientRect(); const kids = [];
    for (const n of this.notes || []) { if (n.target.selector.type === 'sketch' && this.camMatches(n.view)) continue; const a = this.anchor(n); if (!a) continue; const p = a.clone().project(this.camera); if (p.z > 1) continue; kids.push(el('span', { class: 'mk' + (n.id === this.active ? ' act' : ''), style: { '--c': VERDICT[n.verdict][1], left: ((p.x + 1) / 2 * r.width) + 'px', top: ((1 - p.y) / 2 * r.height) + 'px' } }, n.mark)); }
    if (kids.length !== this.markDiv.children.length || kids.some((k, i) => k.style.cssText !== this.markDiv.children[i].style.cssText || k.className !== this.markDiv.children[i].className)) this.markDiv.replaceChildren(...kids);
  }
  setTool(t) { this.inspectTools?.setMeasuring(false); this.tool = t; if (this.sketch) { this.sketch.setTool(t === 'pen' ? 'pen' : null); this.sketch.cv.style.pointerEvents = t === 'pen' ? 'auto' : 'none'; } if (this.controls) this.controls.enabled = t !== 'pen'; }
  // a sketch is tied to the camera it was drawn from; it only shows when the camera is back there
  camMatches(v) { if (!v || !v.camera) return false; const p = new THREE.Vector3().fromArray(v.camera.position), q = new THREE.Vector3().fromArray(v.camera.target); return p.distanceTo(this.camera.position) < this.radius * 0.03 && q.distanceTo(this.controls.target) < this.radius * 0.03; }
  onSketch(s) {
    // sample evenly along the whole drawn line (a straight stroke has only two points)
    const hits = new Map(); const pts = s.points; const seg = []; let len = 0;
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); len += d; }
    const N = 60; const sample = [];
    for (let k = 0; k <= N; k++) { let t = len * k / N, i = 0; while (i < seg.length - 1 && t > seg[i]) { t -= seg[i]; i++; } const f = seg[i] ? t / seg[i] : 0; const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)]; sample.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
    for (const q of sample) { this.ray.setFromCamera(new THREE.Vector2(q[0] * 2 - 1, -(q[1] * 2 - 1)), this.camera); const h = this.ray.intersectObjects(this.meshes, false)[0]; if (h) hits.set(h.object, (hits.get(h.object) || 0) + 1); }
    const parts = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([o]) => this.partInfo(o));
    this.selected = new Set([...hits.keys()].slice(0, 12)); this.applyMats();
    const labels = [...new Set([...this.selected].map(o => this.groups.get(o.userData.pkey).label))];
    select({ type: 'sketch', label: 'Drawing on ' + (labels.slice(0, 3).join(', ') || 'model'), points: s.points, x: s.x, y: s.y, w: s.w, h: s.h, parts, ...(this.mixer ? { frame: Math.round(this.time * this.fps) } : {}) });
  }
  clearSelection() { this.selected.clear(); if (this.pin) this.pin.visible = false; if (this.sketch) { this.sketch.sel = null; this.sketch.draw(); } this.applyMats(); }
  marks(notes, active) { this.notes = notes; this.active = active; const n = (notes || []).find(x => x.id === active); this.hi = new Set(n && n.target.selector.parts ? n.target.selector.parts.map(p => p.node) : []); if (this.meshes) this.applyMats(); if (this.tlw) timelineMarks(this.tlw, notes, this.duration); if (this.sketch) { this.sketch.notes = notes || []; this.sketch.active = active; this.sketch.draw(); } }
  async focus(n) {
    const v = n.view;
    if (v?.asset?.hash && v.asset.hash !== this.assetHash) { toast('The model hash differs from this note. Restore the original file.'); return; }
    if (v?.camera) { this.userMoved = true; this.setView(v.camera); }
    if (v?.flags) this.flags = { ...v.flags, spin: false };
    if (v?.rotation != null) this.root.rotation.y = v.rotation;
    if (this.setInspection && v?.inspection) this.setInspection(v.inspection);
    if (this.mixer && v?.time != null) { this.playing = false; this.time = v.time; this.setClip(v.clip ?? 'all'); this.mixer.setTime(this.time); this.syncTl(); }
    this.marks(this.notes, n.id); const ps = n.target.selector.parts; if (ps) this.hi = new Set(ps.map(p => p.node)); this.applyMats();
  }
  togglePlay() { if (this.mixer) this.playing = !this.playing; }
  stepFrame(d) { if (!this.mixer) return; this.playing = false; this.time = Math.max(0, Math.min(this.duration, this.time + d / this.fps)); }
  markIn() { if (this.mixer) this.inp = this.time; }
  markOut() { if (this.mixer) this.out = this.time; }
  async thumb() { this.renderer.render(this.scene, this.camera); const cv = this.renderer.domElement; const c = document.createElement('canvas'); c.width = 360; c.height = Math.round(360 * cv.height / cv.width); c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); return c.toDataURL('image/png'); }
  async capture(n, all) {
    const keep = { view: this.viewState(), playing: this.playing, sel: this.selected, active: this.active, hi: this.hi };
    this.selected = new Set(); this.flags.spin = false; this.root.rotation.y = 0;
    await this.focus(n); this.mixer && this.mixer.setTime(this.time); this.controls.update(); this.renderer.render(this.scene, this.camera);
    const cv = this.renderer.domElement; const ctxShot = document.createElement('canvas'); ctxShot.width = cv.width; ctxShot.height = cv.height; const g = ctxShot.getContext('2d'); g.drawImage(cv, 0, 0);
    const sx = cv.width, sy = cv.height; let bb = null;
    const s = n.target.selector; const objs = s.type === 'sketch' ? [] : (s.parts || []).map(p => this.byName.get(p.node)).filter(Boolean);
    let src = cv;
    if (s.type === 'sketch') { src = document.createElement('canvas'); src.width = sx; src.height = sy; const sg = src.getContext('2d'); sg.drawImage(cv, 0, 0); drawShape(sg, { type: 'stroke', points: s.points }, sx, sy, VERDICT[n.verdict][1], true); drawShape(g, { type: 'stroke', points: s.points }, sx, sy, VERDICT[n.verdict][1], true); bb = [s.x * sx, s.y * sy, Math.max(s.w * sx, 40), Math.max(s.h * sy, 40)]; }
    const pts = [];
    for (const o of objs) { const b = new THREE.Box3().setFromObject(o); for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) pts.push(new THREE.Vector3(x, y, z)); }
    if (!pts.length && s.point) pts.push(new THREE.Vector3().fromArray(s.point));
    if (pts.length) { const pp = pts.map(p => p.project(this.camera)).map(p => [(p.x + 1) / 2 * sx, (1 - p.y) / 2 * sy]); const xs = pp.map(p => p[0]), ys = pp.map(p => p[1]); bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; if (bb[2] < 40) { bb[0] -= 30; bb[2] += 60; } if (bb[3] < 40) { bb[1] -= 30; bb[3] += 60; } }
    for (const m of all) { const a = this.anchor(m); if (!a) continue; const p = a.clone().project(this.camera); if (p.z <= 1) drawMark(g, (p.x + 1) / 2 * sx, (1 - p.y) / 2 * sy, m.mark, VERDICT[m.verdict][1], m.id === n.id); }
    const crop = bb ? cropCanvas(src, ...bb) : null;
    // Animation range: start/middle/end frames from the same camera, so the agent sees the motion.
    let strip = null;
    if (this.mixer && s.type === 'time' && s.end - s.start > (this.fps ? 1.5 / this.fps : 0.1)) {
      const k = Math.min(1, 480 / sx), w = Math.round(sx * k), h = Math.round(sy * k); const sc = document.createElement('canvas'); sc.width = w * 3 + 8; sc.height = h; const sg = sc.getContext('2d');
      sg.fillStyle = '#111'; sg.fillRect(0, 0, sc.width, h); sg.font = 'bold 14px Segoe UI';
      [s.start, (s.start + s.end) / 2, s.end].forEach((t, i) => { this.mixer.setTime(t); this.renderer.render(this.scene, this.camera); const x = i * (w + 4); sg.drawImage(cv, x, 0, w, h); sg.fillStyle = '#000a'; sg.fillRect(x, 0, 104, 24); sg.fillStyle = '#fff'; sg.fillText('frame ' + Math.round(t * this.fps), x + 6, 17); });
      strip = sc.toDataURL('image/png');
    }
    await this.focus({ id: keep.active, view: keep.view, target: { selector: {} } }); this.playing = keep.playing; this.selected = keep.sel; this.hi = keep.hi; this.flags = keep.view.flags; this.applyMats();
    return { crop, strip, context: scaled(ctxShot).toDataURL('image/png') };
  }
  disposeScene() {
    this.inspectTools?.dispose();
    this.disposeInspection();
    const geometries = new Set(), materials = new Set(this.hiMaterials || []), textures = new Set();
    for (const material of [...Object.values(this.gmats || {}), this.silMat]) if (material) materials.add(material);
    this.scene?.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      for (const m of [...[].concat(o.material || []), ...[].concat(o.userData.orig || [])]) materials.add(m);
    });
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      material.dispose();
    }
    for (const texture of textures) texture.dispose();
    for (const geometry of geometries) geometry.dispose();
    this.draco?.dispose(); this.ktx2?.dispose();
  }
  teardownLoad() {
    this.loadAbort?.abort(); this.loadAbort = null;
    this.ro?.disconnect(); this.sro?.disconnect(); this.ro = this.sro = null;
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf); this.hoverRaf = 0;
    this.mixer?.stopAllAction(); if (this.mixer && this.root) this.mixer.uncacheRoot(this.root);
    this.controls?.dispose(); this.disposeScene();
    this.draco = this.ktx2 = null; this.hiMaterials = new Set(); this.hiCache = null; this.gmats = {}; this.silMat = null;
    this.scene?.clear(); this.root = null; this.meshes = null; this.groups = null;
    if (this.renderer) { this.renderer.setAnimationLoop(null); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove(); } // phones allow only a few WebGL contexts
    this.renderer = this.controls = null;
    this.sketch?.cv.remove(); this.sketch = null; this.markDiv?.remove(); this.markDiv = null;
    this.mixer = this.clips = this.assetHash = null;
    this.field = this.grid = this.player = this.tlw = null; this.selected.clear(); this.hi.clear(); this.hoverSet = null;
    if (this.o.primary) $('#timeline').className = '';
  }
  destroy() {
    if (this.dead) return; this.dead = true; this.cancelLoad?.();
    this.loadGate?.remove(); this.loadGate = null;
    this.loadError?.remove(); this.loadError = null;
    this.teardownLoad();
  }
}

// R3C-050 begin
const contextLoadModel = ModelView.prototype.loadModel;
const contextTeardownLoad = ModelView.prototype.teardownLoad;
ModelView.prototype.loadModel = function (...args) {
  const loading = contextLoadModel.apply(this, args), renderer = this.renderer;
  if (!renderer) return loading;
  const owner = this.webglContextOwner = { renderer, lost: false };
  const animate = renderer.setAnimationLoop.bind(renderer);
  // A late parse must not restart the frame loop after context loss.
  renderer.setAnimationLoop = loop => animate(owner.lost ? null : loop);
  const hide = () => {
    if (this.dead || this.webglContextOwner !== owner || !owner.lost) return;
    this.ro?.disconnect(); this.sro?.disconnect();
    if (this.controls) this.controls.enabled = false;
    for (const child of this.pane.children) {
      if (child !== owner.error && !child.classList.contains('tag')) child.style.display = 'none';
    }
  };
  owner.onLost = event => {
    if (this.dead || this.webglContextOwner !== owner || owner.lost) return;
    event.preventDefault(); owner.lost = true; animate(null);
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf); this.hoverRaf = 0;
    showHover(null);
    const reload = el('button', { class: 'mbtn', 'aria-label': 'Reload model: ' + this.file.name,
      onclick: async () => {
        if (owner.reloading || this.dead || this.webglContextOwner !== owner || (S.view !== this && S.cmp !== this)) return;
        owner.reloading = true; reload.disabled = true;
        const token = S.nav;
        // Remount the current panes, preserving version, file and review state.
        destroyViews();
        try { await mountViews(token); } catch (error) { if (token === S.nav) mediaError(error); }
      }
    }, 'Reload model');
    owner.error = el('div', { class: 'empty', role: 'alert', 'data-webgl-context-loss': '',
      style: { position: 'absolute', inset: '0', padding: '24px', overflow: 'auto', zIndex: '6',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start' }
    }, el('p', {}, this.file.name + ' · WebGL context lost. Reload the model. You stay on this version.'), reload);
    this.pane.append(owner.error); hide();
  };
  renderer.domElement.addEventListener('webglcontextlost', owner.onLost);
  // Hide overlays added by a load that finishes after the loss, including ink.
  loading.then(() => { if (owner.lost) requestAnimationFrame(hide); }, () => {});
  return loading;
};
ModelView.prototype.teardownLoad = function (...args) {
  const owner = this.webglContextOwner; this.webglContextOwner = null;
  if (owner) {
    const canvas = owner.renderer.domElement;
    // Deliberate forceContextLoss during disposal is never a recovery error.
    canvas.removeEventListener('webglcontextlost', owner.onLost);
    for (const key of ['onpointerdown', 'onpointerup', 'onpointermove', 'onpointerleave']) canvas[key] = null;
    owner.error?.remove();
  }
  return contextTeardownLoad.apply(this, args);
};
// R3C-050 end

window.__review = S;
// R3I-015 begin
import { makeNoteTaxonomy, makeSeverityPins } from './note-taxonomy.js';
const noteTaxonomy = makeNoteTaxonomy({ el, $, S, changed: () => changed(), locked,
  saveUnsent: () => saveUnsent(), advise: message => toast(message, 5000) });
const taxonomyComposer = openComposer, taxonomyAdd = addNote, taxonomyRow = noteRow;
const taxonomySelect = select;
const taxonomyChanged = changed, taxonomyDraft = postDraft, taxonomyFinal = finalize;
openComposer = () => { taxonomyComposer(); noteTaxonomy.composer(); placePop(); };
select = (...args) => noteTaxonomy.select(taxonomySelect, args);
addNote = (...args) => noteTaxonomy.place(taxonomyAdd, args);
changed = () => { noteTaxonomy.beforeChange(); return taxonomyChanged(); };
noteRow = note => noteTaxonomy.row(taxonomyRow(note), note);
postDraft = (...args) => { noteTaxonomy.prepare(); return taxonomyDraft(...args); };
finalize = (...args) => { noteTaxonomy.prepare(); return taxonomyFinal(...args); };
const severityPins = makeSeverityPins(drawMark);
drawMark = (...args) => severityPins.mark(...args);
Layer2D.prototype.draw = severityPins.wrap(Layer2D.prototype.draw);
AudioView.prototype.draw = severityPins.wrap(AudioView.prototype.draw);
el = severityPins.element(el);
ModelView.prototype.placeMarks = severityPins.wrap(ModelView.prototype.placeMarks);
// R3I-015 end
// R3C-072 begin
import { installMeasurement } from './measurement.js';
installMeasurement(ModelView, {
  units: view => verInfo()?.meta?.units ?? view.file.preflight?.stats?.budgets?.units,
  ownsInput: view => S.view === view && S.mode === 'review' && !S.sel && !S.editing && !document.querySelector('dialog[open]'),
  changed: renderDock
});
// R3C-072 end

// R3F-001 begin
// Validate the saved target against its own bytes; A/B versions may differ.
const savedNoteHash = n => n.target?.hash || n.view?.asset?.hash;
function noteFocusWarning(view, message) {
  document.querySelectorAll('[data-note-focus-warning]').forEach(e => e.remove());
  if (message) {
    (view?.pane || $('#view')).append(el('div', { role: 'alert', 'data-note-focus-warning': '', class: 'empty' }, message));
    toast(message, 6000);
  }
  return !message;
}
const modelNoteFocus = ModelView.prototype.focus;
ModelView.prototype.focus = async function (n) {
  if (this.dead) return false;
  const hash = savedNoteHash(n);
  if (hash && hash !== this.assetHash) return noteFocusWarning(this, 'Stale note: the model hash differs. Restore the original file to focus this note.');
  noteFocusWarning(this);
  await modelNoteFocus.call(this, n);
  const s = n.target?.selector;
  if (this.mixer && s?.type === 'time') {
    this.inp = s.start; this.out = s.end; this.syncTl();
  }
  this.syncPeer();
  return true;
};
const modelNoteCapture = ModelView.prototype.capture;
ModelView.prototype.capture = async function (n, ...args) {
  if (savedNoteHash(n) && savedNoteHash(n) !== this.assetHash) {
    noteFocusWarning(this, 'Stale note: the model hash differs. Restore the original file before capturing this note.');
    return {};
  }
  return modelNoteCapture.call(this, n, ...args);
};
const modelNoteMarks = ModelView.prototype.marks;
ModelView.prototype.marks = function (notes, active) {
  // A stale selector must not highlight a same-named node in replacement bytes.
  return modelNoteMarks.call(this, (notes || []).filter(n => !savedNoteHash(n) || savedNoteHash(n) === this.assetHash), active);
};
const modelNoteLoad = ModelView.prototype.loadModel;
ModelView.prototype.loadModel = async function () {
  await modelNoteLoad.call(this);
  const fps = Number(this.file.fps ?? verInfo()?.meta?.fps);
  if (this.mixer && Number.isFinite(fps) && fps > 0 && fps <= 1000) this.fps = fps;
};
const modelNoteState = ModelView.prototype.viewState;
ModelView.prototype.viewState = function () {
  const state = modelNoteState.call(this);
  state.asset.file = this.file.name;
  if (this.mixer) state.fps = this.fps;
  return state;
};
VideoView.prototype.viewState = function () {
  return { asset: { id: S.asset, stage: S.stage, version: S.v, file: this.file.name }, time: this.v.currentTime, fps: this.fps };
};
const videoNoteFocus = VideoView.prototype.focus;
VideoView.prototype.focus = async function (n) {
  if (this.dead) return false;
  const s = n.target?.selector;
  // Keep decoded PTS anchors owned by the existing timestamp adapter.
  if (s?.video_anchor && !this.presentationClock?.seek?.(s)) return noteFocusWarning(this, 'Stale note: video frame identity differs. Restore the original file.');
  noteFocusWarning(this);
  await videoNoteFocus.call(this, n);
  if (s?.type === 'time') {
    const start = s.video_start?.media_time ?? (s.fps > 0 && Number.isSafeInteger(s.frame_start) ? s.frame_start / s.fps : s.start);
    const end = s.video_end?.media_time ?? (s.fps > 0 && Number.isSafeInteger(s.frame_end) ? s.frame_end / s.fps : s.end);
    this.inp = start; this.out = end;
    this.stopShuttle?.(); this.loop = false; this.v.pause(); this.peer?.v?.pause();
    await this.seek(start); this.syncTl();
  }
  return true;
};
focusNote = async function (n) {
  const origin = n.view?.asset;
  if (origin) {
    const versions = S.cat.assets[origin.id]?.stages?.[origin.stage]?.versions;
    if (!versions?.some(v => v.v === origin.version)) return noteFocusWarning(S.view, 'Stale note: the saved target version is unavailable. Restore the original version.');
    if (origin.version !== S.v || origin.stage !== S.stage || origin.id !== S.asset) await pick(origin.id, origin.stage, origin.version);
    if (origin.version !== S.v || origin.stage !== S.stage || origin.id !== S.asset) return false;
  }
  const file = n.target?.file || origin?.file;
  const i = verInfo()?.files.findIndex(f => f.name === file);
  if (file && !(i >= 0)) return noteFocusWarning(S.view, 'Stale note: the saved target file is unavailable. Restore the original file.');
  if (i >= 0 && i !== S.file) { S.file = i; destroyViews(); await mountViews(); }
  S.active = n.id;
  const restored = S.view?.focus ? await S.view.focus(n) : false;
  refreshMarks(); renderSide();
  return restored;
};
const followupNoteFocus = showFollowup;
showFollowup = async function (n) {
  if (!(S.view instanceof ModelView)) return followupNoteFocus(n);
  if (!S.compare || S.cmpWith || S.inspectCompare || S.cmpMode !== 'side') { S.compare = true; S.cmpWith = null; S.inspectCompare = null; S.cmpMode = 'side'; destroyViews(); await mountViews(); }
  if (!(S.cmp instanceof ModelView) || await S.cmp.focus(n) !== true) return false;
  // The original target is verified on B. Compare its camera/time on A without
  // claiming that the old selector or hash belongs to A's different bytes.
  if (await S.view.focus({ view: { ...n.view, asset: undefined }, target: { selector: {} } }) !== true) return false;
  S.view.ghost?.(n);
  return true;
};
// R3F-001 end


// R3I-014 begin
import { makeDeltaBanner } from './delta-banner.js';
const evidenceOwner = () => S.me?.can?.decide && !S.me.owned_by ? (S.me.name || REVIEWER) : null;
const updateDeltaBanner = makeDeltaBanner({ S, api, guest: () => CM.guest(),
  owner: evidenceOwner });
const renderSideBeforeDelta = renderSide;
renderSide = function () { renderSideBeforeDelta(); updateDeltaBanner(); };
// R3I-014 end

// R3I-017 begin
import { installInkAnchors } from './ink-anchor.js';
installInkAnchors({ ImageView, VideoView, ModelView, Layer2D }, { project: PROJECT, el, toast });
// R3I-017 end
// R3I-021 begin
import { installLookPresets } from './look_presets.js';
installLookPresets(ModelView, { el, refresh: renderDock });
// R3I-021 end
// R3C-073 begin
import { installInspectionOverlays } from './inspection_overlays.js';
import { installCompareMetrics, metricStrip } from './compare_metrics.js';
// Extend only the supported mode; retain all existing location/binding checks.
const resumeBeforeInspection = resumeValid;
resumeValid = r => resumeBeforeInspection(r?.view && !Array.isArray(r.view) && r.view.inspection === 'inspect'
  ? { ...r, view: { ...r.view, inspection: 'material' } } : r);
let inspectionRequested = false;
const refreshInspectionMetrics = () => {
  const a = S.view, b = S.cmp, host = $('#modelcompare');
  if (!host) return;
  if (a?.inspection !== 'inspect') {
    if (host.querySelector('[data-compare-metrics]')) host.replaceChildren(...(S.compare && a?.modelMetrics && b?.modelMetrics ? [comparisonBeforeInspection(a.file, b.file, cmpSource())] : []));
    return;
  }
  host.replaceChildren(...(S.compare && !a.dead && !b?.dead && a.modelMetrics && b?.modelMetrics ? [metricStrip(b.modelMetrics, a.modelMetrics, el)] : []));
};
installInspectionOverlays(ModelView, { el, GLTFLoader, changed: refreshInspectionMetrics,
  modeChanged: (view, mode) => { if (S.view === view) inspectionRequested = mode === 'inspect'; } });
installCompareMetrics(ModelView, { changed: refreshInspectionMetrics, identity: view => {
  const source = view.o.primary ? { stage: S.stage, v: S.v, ver: verInfo() } : cmpSource();
  return { asset: S.asset, stage: source?.stage, version: source?.v,
    units: source?.ver?.meta?.units ?? view.file.preflight?.stats?.budgets?.units };
} });
const comparisonBeforeInspection = modelCompareTable;
modelCompareTable = function (...args) {
  return S.view?.inspection === 'inspect' ? metricStrip(S.cmp?.modelMetrics, S.view.modelMetrics, el) : comparisonBeforeInspection(...args);
};
const mountBeforeInspection = mountViews;
mountViews = async function (...args) {
  await mountBeforeInspection(...args);
  if (inspectionRequested && S.view instanceof ModelView && S.view.modelMetrics && !S.view.dead && S.view.inspection !== 'inspect') S.view.setInspection('inspect');
};
// R3C-073 end
// R3I-001 begin
import { startDecisionSheet, installDecisionSheetEntry } from './sheet.js';
const decisionSheetSource = location.hash;
startDecisionSheet({ api, S }).then(async shown => {
  if (shown) return;
  await boot();
  installDecisionSheetEntry({ S, focusNote, sourceHash: decisionSheetSource });
}).catch(e => { document.body.append(el('pre', { style: { color: '#f88', padding: '20px' } }, String(e.stack || e))); });
// R3I-001 end

// R3I-013 begin
import { makeQuick, quickItems } from './quick.js';
import { quickReviewEntry } from './home.js';
document.head.append(el('link', { rel: 'stylesheet', href: new URL('./quick.css', import.meta.url).href }));
const quickQueue = () => quickItems(CM.guest() ? gqueue() : queue().map(it => ({ ...it, p: hereId() })), hereId());
// R3C-111 begin
const quickContext = { el, toast, queue: quickQueue, total: () => CM.guest() ? gqueue().length : waitingTotal(), project: hereId,
// R3C-111 end
  current: () => ({ p: hereId(), id: S.asset, s: { id: S.stage }, v: S.v }),
  reviewing: () => S.mode === 'review', owner: () => CM.can('decide') && !CM.guest(),
  ready: () => !!S.review && isLatest() && !locked() && !S.busy,
  wantSummary: () => S.wantChange, summary: () => S.review?.summary || '', editSummary: text => { S.review.summary = text; changed(); },
  open: it => pick(it.id, it.s.id, it.v ?? it.ver.v), restore: () => { if (S.mode === 'review') renderDecide(); },
  decide: async verdict => {
    if (!CM.can('decide') || CM.guest() || !isLatest() || locked() || S.busy) return;
    if (!await quickLeaveGuard()) return;
    await finalize(verdict);
    // A failed final POST must not make the still-open candidate look final.
    if (quick.active && S.mode === 'review' && isFinal(S.review) && queue().some(it => it.id === S.asset && it.s.id === S.stage)) {
      S.review.draft = true; S.review.verdict = 'pending'; keepDraft(); renderDecide();
    }
  }
};
let quick = makeQuick(quickContext);
async function quickLeaveGuard() {
  if (!quick.active) return true;
  if (S.sel && ($('#pop textarea')?.value.trim() || localStorage.getItem(unsentKey()))) {
    toast('First post or cancel your open note.', 6000); return false;
  }
  if (S.unconfirmed) S.pendingSave = true;
  try { await flushSave(); } catch (e) { toast('Your draft is not confirmed yet. You stay on this version.', 6000); return false; }
  if (S.pendingSave || S.unconfirmed) { toast('Your draft is not confirmed yet. You stay on this version.', 6000); return false; }
  return true;
}
const quickLeaveReview = leaveReview;
leaveReview = async function () { return await quickLeaveGuard() && quickLeaveReview(); };
const quickShowHome = showHome;
showHome = async function () {
  await quickShowHome(); if (S.mode !== 'home') return;
  quick.stop();
  const entry = quickReviewEntry({ el, count: quickQueue().length, open: () => quick.start() });
  if (entry) $('#home .heroact')?.append(entry);
};
const quickPick = pick;
pick = async function (...args) { await quickPick(...args); quick.sync(); };
const quickRenderDecide = renderDecide;
renderDecide = function () { quickRenderDecide(); quick.sync(); };
window.addEventListener('pagehide', () => quick.destroy());
window.addEventListener('pageshow', e => { if (e.persisted) quick = makeQuick(quickContext); });
// R3I-013 end

// R3C-122 begin
import { installImageProbe } from './probe.js';
installImageProbe(ImageView, {
  save(selector, text) {
    if (locked() || !isLatest() || S.sel || !$('#pop').hidden) { toast('Close your note and open the newest editable version.'); return false; }
    S.sel = { selector, view: S.view.viewState?.() || null };
    addNote('change', 'med', text);
    return true;
  }
});
// R3C-122 end
