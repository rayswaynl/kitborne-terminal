#!/usr/bin/env python3
"""Asset Review: local review server + CLI for agents (stdlib only).

  python review.py up     --root <review dir> [--port 4780] [--project "Name"]  # start the server if needed, print the URL
  python review.py next   --root <dir> [--json]                                  # the one thing an agent should do now
  python review.py submit --root <dir> --asset tank_green --stage model --file a.glb [--file b.png]
                          [--name "Tank (Green)"] [--note "what changed"] [--resolves N1,N2] [--response "N1=fixed by ..."] [--meta fps=24]
  python review.py wait   --root <dir> --asset ID --stage ID [--timeout 900]     # block until the reviewer finishes
  python review.py notes  --root <dir> [--asset ID] [--stage ID] [--json]        # agent task list
  python review.py link   --root <dir> --asset ID [--stage ID] [--v N]           # deep link for the reviewer
  python review.py status --root <dir>  |  events --root <dir> [--since ISO]      # pipeline overview, activity log
  python review.py archive --root <dir> --asset ID [--stage S ...|--keep brief] --reason "..."  # take old work out (moved, not deleted)
  python review.py archive --root <dir> [--restore <archive id>]                 # list archives, or put one back
  python review.py project archive --project <id|root> --reason "..." [--restore]  # hide a whole project (registry only, no file touched)
  python review.py library build | search <words> [--kind k] [--json] [--limit n]  # asset library index (colab library + output folders)
  python review.py serve  --root <dir> [--port 4780]                             # foreground server (up starts this)
Data: <root>/catalog.json and <root>/items/<asset>/<stage>/v###/{files, review.json, REVIEW.md, crops/}
"""
import argparse, base64, datetime, glob, hashlib, http.server, json, mimetypes, os, re, shutil, socket, socketserver, subprocess, sys, threading, time, urllib.parse, urllib.request
import contextlib
import importlib.util
import pathlib
# R3C-095 begin
import ipaddress
import ntpath
# R3C-095 end
from collections import OrderedDict
import csv
import ctypes
import gzip
import tempfile
import zipfile
import math
from fractions import Fraction
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preflight import preflight, lock_check, scope_check, glb_stats, model_delta
from provenance_policy import load_policy
from material_sanity import analyze as material_sanity, compact_evidence, MAX_ROWS, MAX_ROW_BYTES
import tuner

MAX_CATALOG_BYTES = 8 * 1024**2  # compatible with evidence_export and the home index
MAX_LEGACY_CATALOG_BYTES = 32 * 1024**2
# Adapter callbacks are confined to the package caller; manual submits keep their I/O.
PACKAGE_IO = threading.local()
import library

HERE = os.path.dirname(os.path.abspath(__file__))
SETTLE = 10  # seconds a decision must stay final before wait returns (the viewer offers undo for 7 s)
CLI = 'python "%s"' % os.path.abspath(__file__)  # printed commands are copy-paste ready from any folder
# Part recognition (scripts/segment.py) needs torch + transformers, so it runs in its own venv; review.py itself stays stdlib.
# Opt in per submit with --parts or ASSET_REVIEW_PARTS=1; ASSET_REVIEW_SEG_PYTHON names the python of that venv.
SEG_PY = os.environ.get('ASSET_REVIEW_SEG_PYTHON', '')
PARTS_OFF = 'PARTS off (opt in with --parts; needs ASSET_REVIEW_SEG_PYTHON)'


def start_parts(root, d, names, wait=False, route=None):
    """Recognise and name the parts of image files in version folder d (background by default). Returns a status line."""
    if route in ROUTE_GROUP:
        return 'PARTS skipped: %s route' % route
    imgs = [os.path.join(d, n) for n in names if MEDIA.get(os.path.splitext(n)[1].lower()) == 'image']
    if not imgs: return None
    if not os.path.isfile(SEG_PY): return 'PARTS skipped: ASSET_REVIEW_SEG_PYTHON does not point to an existing python'
    cmd = [SEG_PY, os.path.join(HERE, 'segment.py'), *imgs] + (['--vocab-file', os.path.join(root, 'vocab.json')] if os.path.isfile(os.path.join(root, 'vocab.json')) else [])
    env = dict(os.environ, HF_HUB_OFFLINE=os.environ.get('HF_HUB_OFFLINE', '1'), HF_HUB_DISABLE_XET='1')
    # CREATE_NO_WINDOW alone: the venv python.exe relaunches the base interpreter, which must inherit a hidden console.
    # DETACHED_PROCESS left it console-less, so Windows opened a visible terminal for that child.
    nw = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    if wait: return subprocess.run(cmd, env=env, capture_output=True, text=True, encoding='utf-8', creationflags=nw).stdout.strip() or 'PARTS no output'
    os.makedirs(os.path.join(d, 'parts'), exist_ok=True)
    log = open(os.path.join(d, 'parts', 'segment.log'), 'w', encoding='utf-8')
    subprocess.Popen(cmd, env=env, stdout=log, stderr=log, creationflags=nw)
    return 'PARTS recognising %d image(s) in the background (about 20 s each); the viewer shows them on the next open' % len(imgs)


def blender_exe():
    if os.environ.get('ASSET_REVIEW_BLENDER'): return os.environ['ASSET_REVIEW_BLENDER']
    found = sorted(glob.glob(r'C:\Program Files\Blender Foundation\Blender *\blender.exe'), key=lambda p: [int(x) for x in re.findall(r'\d+', os.path.basename(os.path.dirname(p)))])
    return found[-1] if found else shutil.which('blender')


def start_renders(d, names):
    """Keep the submit hook; the finite worker owns automatic angle rendering."""
    from auto_render import start_worker
    start_worker(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(d)))))
    return 'RENDERS queued or cached'


# Spoken notes: the viewer records, a local faster-whisper worker (transcribe.py) turns it into text. Nothing leaves this pc.
VOICE_OK = importlib.util.find_spec('faster_whisper') is not None
VOICE = {'proc': None, 'lock': threading.Lock()}
# Recordings are deleted after transcription; ASSET_REVIEW_VOICE_ARCHIVE keeps the admin's recordings with their transcript in that folder.
VOICE_ARCHIVE = os.environ.get('ASSET_REVIEW_VOICE_ARCHIVE', '')


def keep_voice(src, text):
    if not VOICE_ARCHIVE: return
    try:
        d = os.path.join(VOICE_ARCHIVE, time.strftime('%Y-%m')); os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, time.strftime('%Y%m%d-%H%M%S-') + os.path.basename(src))
        shutil.copy2(src, dst)
        with open(os.path.splitext(dst)[0] + '.txt', 'w', encoding='utf-8') as f: f.write(text or '')
    except OSError: pass


def transcribe(root, data_url, keep=False):
    raw = base64.b64decode(data_url.split(',', 1)[1]); tmp = os.path.join(root, '.voice'); os.makedirs(tmp, exist_ok=True)
    stem = os.path.join(tmp, '%d_%d' % (os.getpid(), int(time.time() * 1000))); src, wav = stem + '.webm', stem + '.wav'
    NW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        with open(src, 'wb') as f: f.write(raw)
        r = subprocess.run([shutil.which('ffmpeg') or 'ffmpeg', '-y', '-v', 'error', '-i', src, '-ac', '1', '-ar', '16000', wav], capture_output=True, creationflags=NW)
        if r.returncode: return {'error': 'ffmpeg: ' + r.stderr.decode('utf-8', 'replace')[-200:]}
        with VOICE['lock']:
            p = VOICE['proc']
            if not p or p.poll() is not None:
                p = VOICE['proc'] = subprocess.Popen([sys.executable, os.path.join(HERE, 'transcribe.py'), '--serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                     stderr=subprocess.DEVNULL, text=True, encoding='utf-8', creationflags=NW)
                p.stdout.readline()  # {"ready": true} once the model is loaded
            p.stdin.write(json.dumps({'wav': wav}) + '\n'); p.stdin.flush()
            line = p.stdout.readline()
        out = json.loads(line) if line else {'error': 'speech recognition stopped'}
        if keep: keep_voice(src, out.get('text'))
        return out
    finally:
        for x in (src, wav):
            try: os.remove(x)
            except OSError: pass
VIEWER = os.path.normpath(os.path.join(HERE, '..', 'assets', 'viewer'))
mimetypes.add_type('application/manifest+json', '.webmanifest')
mimetypes.add_type('image/x-icon', '.ico')
mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('application/wasm', '.wasm')
# R3C-095 begin
WINDOWS_DEVICE_STEM = r'CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$'
SAFE = re.compile(r'^(?!(?:' + WINDOWS_DEVICE_STEM + r')(?:\.|$))[A-Za-z0-9][A-Za-z0-9_.-]{0,80}(?<!\.)$', re.IGNORECASE | re.ASCII)


def safe_path_segment(part):
    """Reject Windows device/alias segments on every platform, before path IO."""
    stem = part.rstrip(' .').partition('.')[0].rstrip(' ').upper()
    if re.fullmatch(WINDOWS_DEVICE_STEM, stem):
        return False
    if part not in ('.', '..') and part.endswith(('.', ' ')): return False
    return not (len(part.partition('.')[0]) <= 8
                and re.fullmatch(r'[^ .~]{1,6}~[0-9]+(?:\.[^ .~]{1,3})?', part))


def safe_name(name):
    """Names stored by SAFE users must also be readable through inside()."""
    return isinstance(name, str) and bool(SAFE.fullmatch(name)) and safe_path_segment(name)
# R3C-095 end
MEDIA = {'.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.glb': 'model', '.gltf': 'model',
         '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.wav': 'audio', '.mp3': 'audio', '.ogg': 'audio', '.md': 'text', '.txt': 'text'}
MEDIA['.pdf'] = 'pdf'


def render_pages(d, name):
    """Render synchronously: pages.json exists before submit returns; no background lifecycle to manage."""
    src = os.path.join(d, name); out = os.path.join(d, 'pages', name); os.makedirs(out, exist_ok=True)
    labels, errors = [], []
    try:
        from pypdf import PdfReader
        labels = PdfReader(src).page_labels
    except Exception: pass  # labels are optional even for encrypted/malformed documents
    for backend in ('pypdfium2', 'fitz', 'pdftoppm'):
        pages = []
        try:
            if backend == 'pypdfium2':
                import pypdfium2 as pdfium
                doc = pdfium.PdfDocument(src)
                try:
                    for i in range(min(len(doc), 300)):
                        page = doc[i]
                        try:
                            w, h = page.get_size(); scale = min(150 / 72, 2000 / max(w, h)); bitmap = page.render(scale=scale)
                            try:
                                image = bitmap.to_pil(); image.save(os.path.join(out, 'p%03d.png' % (i+1))); wp, hp = image.size; image.close()
                            finally: bitmap.close()
                            pages.append(dict(n=i+1, png='pages/%s/p%03d.png' % (name, i+1), w_px=wp, h_px=hp, w_mm=round(w*25.4/72, 2), h_mm=round(h*25.4/72, 2), rotation=page.get_rotation(), label=labels[i] if i < len(labels) else str(i+1)))
                        finally: page.close()
                finally: doc.close()
            else:
                if backend == 'fitz':
                    import fitz
                    with fitz.open(src) as doc:
                        for i, page in enumerate(doc):
                            if i >= 300: break
                            w, h = page.rect.width, page.rect.height; scale = min(150/72, 2000/max(w, h))
                            image = page.get_pixmap(matrix=fitz.Matrix(scale, scale)); image.save(os.path.join(out, 'p%03d.png' % (i+1)))
                            pages.append(dict(n=i+1, png='pages/%s/p%03d.png' % (name, i+1), w_px=image.width, h_px=image.height, w_mm=round(w*25.4/72, 2), h_mm=round(h*25.4/72, 2), rotation=page.rotation, label=labels[i] if i < len(labels) else str(i+1)))
                else:
                    exe = shutil.which('pdftoppm')
                    if not exe: continue
                    from pypdf import PdfReader
                    doc = PdfReader(src)
                    for i, page in enumerate(doc.pages[:300]):
                        stem = os.path.join(out, 'p%03d' % (i+1))
                        subprocess.run([exe, '-f', str(i+1), '-l', str(i+1), '-singlefile', '-png', '-r', '150', '-scale-to', '2000', src, stem], check=True, capture_output=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                        from preflight import image_size
                        wp, hp = image_size(stem + '.png'); w, h = float(page.mediabox.width), float(page.mediabox.height)
                        pages.append(dict(n=i+1, png='pages/%s/p%03d.png' % (name, i+1), w_px=wp, h_px=hp, w_mm=round(w*25.4/72, 2), h_mm=round(h*25.4/72, 2), rotation=page.get('/Rotate', 0), label=labels[i] if i < len(labels) else str(i+1)))
            # R3I-012: isolated optional analysis; existing PDF checks/renderers stay intact.
            try:
                from bleed_coverage import analyze_pdf
                coverage = analyze_pdf(src, [p['n'] for p in pages])
                if len(coverage) != len(pages): raise ValueError('incomplete bleed coverage results')
            except Exception:
                coverage = [dict(schema='asset-review/bleed-coverage-1', status='not_checked',
                                 approximate=True, metrics={}, units={}, assumptions=[],
                                 diagnostics=[dict(code='analyzer_unavailable')]) for p in pages]
            for p, estimate in zip(pages, coverage):
                # pdftoppm uses MediaBox, whereas the other previews use CropBox.
                # Do not draw CropBox coordinates on an unverified fallback preview.
                if backend == 'pdftoppm' and estimate.get('status') == 'ok':
                    estimate = dict(schema='asset-review/bleed-coverage-1', status='not_checked',
                                    approximate=True, metrics={}, units={}, assumptions=[],
                                    diagnostics=[dict(code='fallback_preview_geometry_unverified')])
                p['bleed_coverage'] = estimate
            jsave(os.path.join(out, 'pages.json'), dict(schema='asset-review/pages-1', count=len(pages), pages=pages))
            return len(pages), None
        except ImportError: continue
        except Exception as e: errors.append(str(e))
    jsave(os.path.join(out, 'pages.json'), dict(schema='asset-review/pages-1', count=0, pages=[]))
    return 0, "PDF pages not rendered (%s)" % ('file could not be read' if errors else 'no renderer')


def pdf_pages_pending(d, f):
    """A published PDF file whose page render was never recorded (a crash can fall between publication and render)."""
    if f.get('media') != 'pdf' or f.get('pages'): return False
    done = jload(os.path.join(d, 'pages', f['name'], 'pages.json'), None)
    return not (isinstance(done, dict) and done.get('count') == 0)


def finish_pdf_pages(root, project, asset, stage, v, d, files):
    """Render each PDF's pages and record the count; shared by submit and package recovery."""
    for f in files:
        if f['media'] != 'pdf': continue
        count, warning = render_pages(d, f['name'])  # rendering stays outside the catalog transaction
        f['pages'] = count
        if warning: f['preflight']['warn'].append(warning)
        with FileLock(root):
            cat = catalog(root, project)
            target = next(x for x in cat['assets'][asset]['stages'][stage]['versions'][v-1]['files'] if x['name'] == f['name'])
            target['pages'] = count
            if warning: target['preflight']['warn'].append(warning)
            jsave(os.path.join(root, 'catalog.json'), cat)


# Every development stage of an asset. label = UI label; media = what belongs there; checks = review checklist.
STAGES = [
    # Game stages: the game or feature itself, before and after its assets.
    ('pitch', 'Pitch & pillars', 'text/image', ['Hook in one sentence, audience and platform', '3 pillars that drive decisions', 'Reference games: what to take and what not', 'Kill criteria: what the first playable must prove']),
    ('design', 'Game design', 'text/image', ['Core loop: 30 seconds, 5 minutes, whole session', 'Progression and rewards clear', 'Economy: sources and sinks named', 'Fits the pillars', 'Assumptions and open questions named']),
    ('style', 'Style & look', 'text/image', ['Style bible: palette, shape language, light and camera', 'References and look fit the pillars', 'Readable at gameplay distance and on a phone', 'AI images are references, not gameplay proof']),
    ('level', 'Level & greybox', 'model/image/video', ['Sizes measured with the real player/controller', 'Route, landmarks and sightlines read', 'Spawn, goal and way back clear', 'Room for gameplay and camera']),
    ('prototype', 'Playable prototype', 'video/image', ['Core loop playable from start to reward', 'First 30 seconds clear without explanation', 'Controls feel good (touch, gamepad, keys)', 'Known bugs listed']),
    ('ui', 'UI & HUD', 'image/video', ['Screenshot of the real core GUI on phone and desktop', 'Touch targets large enough, safe areas clear', 'Key info readable at a glance', 'Style fits the game; a failed UI check in the slice reopens UI']),
    ('research', 'Research', 'text/image', ['3-8 real references, each with source link and licence or usage', "Comparable game assets: what works and what doesn't", 'Real sizes and scale where it is a real object',
                                             "Fits the style bible and the project's existing assets", 'Direction proposed, open questions named']),
    ('brief', 'Brief & references', 'text/image', ['Role, camera and reading distance are clear', 'Sizes and silhouette measured, with a scale figure', 'Parts, colours (hex) and budget per LOD recorded',
                                                    'Motion, VFX and sound named', 'References: what to copy and what not', 'Acceptance per phase, never-list and open questions']),
    ('concept', 'Concept', 'image', ['Silhouette reads at phone size', 'Palette within the style bible', 'Faction recognisable without a real insignia', 'No AI errors (melted or nonsensical parts)']),
    ('turnaround', 'Turnaround', 'image', ['Front/side/back consistent', 'Proportions match player scale', 'Details that become 3D are clear']),
    ('blockout', 'Blockout', 'model', ['Scale next to the player/mini is right', 'Silhouette reads at gameplay distance', 'Large volumes follow the concept', 'Room for collision and gameplay']),
    ('model', 'Model & detail', 'model', ['Shape language (facets/bevels) follows the bible', 'Details read at a distance', 'No floating or intersecting parts', 'Tris/parts within budget']),
    ('surface', 'Colour & material', 'model/image', ['Colours from the palette', 'Faction colour reads against the grass', 'Camo/mud not too busy', 'Holds up under game lighting']),
    ('rig', 'Rig & pivots', 'model', ['Pivots in the right place', 'Groups move together logically', 'Names/hierarchy usable in code']),
    ('animation', 'Animation', 'model/video', ['Timing and weight', 'Anticipation and overshoot', 'Loop seam is clean', 'No sliding feet', 'Reads at a distance']),
    ('vfx', 'VFX', 'video/image', ['Anticipation -> impact -> fade out', 'Value/colour readable in the scene', 'Duration and size fit the gameplay', 'Within particle/light budget']),
    ('audio', 'Sound', 'audio', ['Timing fits the animation/VFX', 'No clipping; tail and length are right', 'Distance/variants present', 'Loudness fits the other sounds']),
    ('optimize', 'Optimisation & LOD', 'model/image', ['Tris/parts/draw calls within budget', 'LOD/streaming set up', 'Measured on a phone']),
    ('engine', 'In-engine', 'image/video', ['Holds up in Roblox lighting', 'Scale in the game is right', 'Performance in play mode', 'Collision/gameplay works']),
    ('playtest', 'Playtest', 'text/video', ['Greybox fun test with at least 1 player who did not build the game', 'Who played and what was fun, with footage', 'Where players got stuck or quit', 'Concrete fix per finding; phone and multiplayer are proven in QA']),
    ('balance', 'Balance & economy', 'text/image', ['Time to first reward and next goal measured', 'Prices and payouts add up, no dead currency', 'Difficulty rises gradually', 'No exploit or endless farm loop']),
    ('assets', 'Assets in the game', 'text/image', ['assets.json: at most 9 entries, more only with owner approval', 'Hero: latest engine version approved', 'Kit: latest model version approved plus an in-game screenshot', 'Primitive: owner, deliberate reason and integrated screenshot; the owner approves this step']),
    ('sound', 'Sound & music', 'audio/text', ['Every audio file has a ledger.csv row: file, source, licence', 'Timing, mix and music fit the game', 'The tool checks rows, not whether licences are true', 'Phone speaker is tested in QA']),
    ('slice', 'Vertical slice', 'video/image/text', ['Representative section with approved assets and a recorded build ID', 'Look, scale, collision and gameplay judged together', 'UI: phone screenshot, core GUI and touch targets; reopen UI on failure', 'All earlier steps approved and current']),
    ('polish', 'Game feel & polish', 'video', ['Feedback on every action (sound, VFX, camera)', 'Transitions and waits feel smooth', 'No empty or dull stretches', 'Same slice build and exact asset versions recorded; QA rechecks the look']),
    ('qa', 'QA: phone & multiplayer', 'text/video/image', ['Build ID and exact integrated asset versions recorded', 'Real phone: model named, at least 30 fps with MicroProfiler or stats overlay, session with at least 2 clients', '8 clients via Studio local server: server stats, simultaneous claim with the right owner, a double attempt pays exactly once', 'Phone session client count recorded for the store claim', 'Slice look checked again after polish; audio through the phone speaker']),
    ('store', 'Store & launch', 'image/text/video', ['Icon beside a slice/QA screenshot; AI art that does not show the game fails', 'Images and footage only from the QA-approved build ID and asset versions', 'Player claim at most the measured client count in the phone session; 2-8 needs a phone measurement with 8', 'Title and description say what you do', 'Age rating, compliance and monetization checked', 'Launch checklist: analytics, bugs, rollback']),
    ('page', 'Web page', 'image/text', ['Purpose of the page is clear at once', 'Text is to the point and readable for a layperson', 'Works on mobile (no overflow, buttons large enough)',
                                      'Images, links and demos work', 'Fits the rest of the site (style and tone)']),
    ('final', 'Final', 'any', ['All notes resolved', 'Locks intact', 'Source files and provenance recorded']),
]
STAGE_IDS = [s[0] for s in STAGES]
GAME_ONLY = ['pitch', 'design', 'style', 'level', 'prototype', 'ui', 'playtest', 'balance', 'assets', 'sound', 'slice', 'polish', 'qa', 'store']
STAGE_GROUP = {s: 'game' if s in GAME_ONLY else 'web' if s == 'page' else 'any' if s == 'final' else 'asset' for s in STAGE_IDS}
ASSET_STAGES = [s for s in STAGE_IDS if STAGE_GROUP[s] in ('asset', 'any')]
# Routes: the stages an asset of one kind goes through. A sound does not need a turnaround or a rig.
ROUTES = {'full': ASSET_STAGES, 'audio': ['research', 'brief', 'audio', 'engine', 'final'], 'sprite': ['research', 'brief', 'concept', 'engine', 'final'],
          'vfx': ['research', 'brief', 'concept', 'vfx', 'audio', 'engine', 'final'], 'prop': ['research', 'brief', 'concept', 'model', 'surface', 'optimize', 'engine', 'final'],
          'character': ASSET_STAGES, 'web': ['page', 'final'],
          'game': GAME_ONLY + ['final'], 'feature': ['design', 'prototype', 'ui', 'playtest', 'balance', 'final'], 'level': ['design', 'level', 'prototype', 'playtest', 'final']}
ROUTE_LABELS = {'full': 'All steps', 'audio': 'Sound', 'sprite': '2D / sprite', 'vfx': 'VFX', 'prop': 'Prop', 'character': 'Character', 'web': 'Website',
                'game': 'Whole game', 'feature': 'Feature', 'level': 'Level'}
ROUTE_GROUP = {'web': 'web', 'game': 'game', 'feature': 'game', 'level': 'game'}  # every other route is an asset route


# Separate disciplines: the original asset and game route lists above stay unchanged.
STAGES += [
    ('post', 'Social post', 'text/image/video', ['Platform and language are right', 'Length within limit (X 270 characters; long posts 150-250 words)', 'Claims have a source', 'Privacy checked in the images', 'Media belongs with the text']),
    ('treatment', 'Goal & setup', 'text', ['Goal and audience in one sentence', 'length and formats (16:9, 9:16) fixed', 'sources and rights for footage and music known', 'what the viewer does afterwards']),
    ('script', 'Script', 'text', ['Beats with seconds per beat', 'hook within 3 s', 'voice lines only where needed, human final voice', 'claims match the real build']),
    ('storyboard', 'Storyboard', 'image/pdf', ['Chosen shots from EDL/brief with framing, motion and duration', 'order and continuity are right', 'text only where the destination allows it', 'total length within target']),
    ('animatic', 'Animatic', 'video', ['Script and timing against picture, music and any voice', 'text only per destination; TTS stays labelled scratch', 'hardest mechanic visible; no polish notes']),
    ('capture', 'Captures', 'video', ['Real footage from a named build ID where product proof is needed', 'no AI image as gameplay', 'required EDL shots present, or missing ones named']),
    ('roughcut', 'Rough cut', 'video', ['Hook, story and key action readable', 'pauses and holds have a purpose', 'temporary music and colour are fine']),
    ('finecut', 'Fine cut', 'video', ['Picture locked', 'colour and mix finished; text only per destination', 'no clipping or unintended picture errors']),
    ('delivery', 'Export & delivery', 'video', ['Requested formats played back; missing coverage named', 'chosen audio profile checked; audio measured where required, deliberate silence recorded', 'target format, poster and actual attachment bytes checked']),
    ('soundbrief', 'Sound brief', 'text', ['List of every sound with trigger, variants and reference', 'where it plays (phone, headphones, PC)', 'loudness target and budget', 'provenance/licence planned per source']),
    ('palette', 'Sound palette', 'audio', ['3-5 representative sounds', 'they sound like one family', "fits the game's style"]),
    ('demo', 'Demo', 'audio', ['30-60 s sketch', 'mood and tempo match the brief', 'motif recognisable']),
    ('arrangement', 'Arrangement', 'audio', ['Build-up and transitions work', 'instrument balance', 'loop point planned', 'stems planned']),
    ('mix', 'Mix', 'audio', ['Nothing masks the main sound', 'levels even within the set', 'no clipping']),
    ('master', 'Master', 'audio', ['Loudness on target, true peak ≤ −1 dBTP', 'loop seam seamless', 'stems delivered']),
    ('casting', 'Voice casting', 'audio', ['3 voice options as Choose 1 of 3', 'fits the character and the audience age', 'voice rights recorded']),
    ('premise', 'Premise', 'text', ['Number of players, play time, party or mail-in (rounds/weeks)', 'tone, era, age', 'home printer or print shop']),
    ('canon', 'The truth', 'text', ['Solution first: what happened, timeline per minute', 'culprit, motive, means', 'only fictional people and brands']),
    ('cast', 'Characters', 'text/image', ['Card per suspect: public story, secret, motive, what they know', 'everyone gets their own moment']),
    ('clues', 'Clues', 'text/image', ['Clue map: clue → round/envelope → what it proves', 'every key conclusion has ≥ 2 clues', 'red herring resolved', 'solvable without a host']),
    ('documents', 'Documents', 'text/pdf', ['Letters, clippings, reports and photos written', 'consistent with the timeline', 'no spoilers in early envelopes']),
    ('layout', 'Layout & PDF', 'pdf', ['Page size is right (A4/A5/Letter)', 'fonts embedded', 'images ≥ 300 ppi', 'bleed ≥ 3 mm where needed', 'host and player pages kept apart']),
    ('proof', 'Test print', 'image', ['Photo of a real print', 'folding, cutting and envelope labels work', 'readable in greyscale']),
    ('pack', 'Pack & manual', 'text/pdf', ['Host manual, envelope order, print instructions, labels', 'solution separate and sealed']),
]
STAGE_GROUP.update(dict.fromkeys(['treatment', 'script', 'storyboard', 'animatic', 'capture', 'roughcut', 'finecut', 'delivery'], 'video'))
STAGE_GROUP.update(dict.fromkeys(['soundbrief', 'palette', 'demo', 'arrangement', 'mix', 'master', 'casting'], 'sound'))
STAGE_GROUP.update(dict.fromkeys(['premise', 'canon', 'cast', 'clues', 'documents', 'layout', 'proof', 'pack'], 'story'))
STAGE_GROUP['post'] = 'social'
STAGE_IDS = [s[0] for s in STAGES]
ROUTES['social'] = ['post', 'final']
ROUTE_LABELS['social'] = 'Social'
ROUTE_GROUP['social'] = 'social'
ROUTES.update({'video': ['treatment', 'script', 'storyboard', 'animatic', 'capture', 'roughcut', 'finecut', 'delivery', 'final'], 'clip': ['treatment', 'capture', 'finecut', 'delivery', 'final'], 'sfx': ['soundbrief', 'palette', 'audio', 'mix', 'engine', 'final'], 'music': ['soundbrief', 'demo', 'arrangement', 'mix', 'master', 'engine', 'final'], 'voice': ['script', 'casting', 'audio', 'mix', 'engine', 'final'], 'story': ['premise', 'canon', 'cast', 'clues', 'documents', 'layout', 'proof', 'playtest', 'pack', 'final']})
ROUTE_LABELS.update(dict(video='Video', clip='Short clip', sfx='SFX set', music='Music', voice='Voice-over', story='Story & print'))
ROUTE_GROUP.update(dict(video='video', clip='video', sfx='sound', music='sound', voice='sound', story='story'))
ROUTES.update({'video-short': ['roughcut', 'finecut', 'delivery'], 'clip-short': ['finecut', 'delivery'], 'explainer': ['animatic', 'finecut', 'delivery']})
ROUTE_LABELS.update({'video-short': 'Trailer (short route)', 'clip-short': 'Clip (short route)', 'explainer': 'Explainer'})
ROUTE_GROUP.update({'video-short': 'video', 'clip-short': 'video', 'explainer': 'video'})
ROUTE_CHECKLISTS = {
    ('sfx', 'audio'): ['All variants present', 'Tails not cut off', 'No breaths or clicks (voice)', 'Loudness even within the set'],
    ('sfx', 'engine'): ['Timing matches the animation/VFX', 'Tested on a phone speaker', 'Simultaneous sounds and distance work'],
    ('sfx', 'final'): ['File names follow the list', 'ledger.csv row per file', 'Locks intact'],
    ('music', 'audio'): ['All variants present', 'Tails not cut off', 'No breaths or clicks (voice)', 'Loudness even within the set'],
    ('music', 'engine'): ['Timing matches the animation/VFX', 'Tested on a phone speaker', 'Simultaneous sounds and distance work'],
    ('music', 'final'): ['File names follow the list', 'ledger.csv row per file', 'Locks intact'],
    ('voice', 'audio'): ['All variants present', 'Tails not cut off', 'No breaths or clicks (voice)', 'Loudness even within the set'],
    ('voice', 'engine'): ['Timing matches the animation/VFX', 'Tested on a phone speaker', 'Simultaneous sounds and distance work'],
    ('voice', 'final'): ['File names follow the list', 'ledger.csv row per file', 'Locks intact'],
    ('voice', 'script'): ['Voice-over readable aloud', 'Claims match the real build', 'Length and pronunciation checked'],
    ('story', 'playtest'): ['Test group that did not know the solution', 'Solved or not, where stuck, play time'],
    ('story', 'final'): ["Player PDFs, host PDF, solution, inventory", 'Provenance of every image recorded'],
    ('feature', 'playtest'): ['Acceptance criteria with a threshold per criterion', 'PASS/FAIL/not measurable per session with measured value', 'Clip or log per criterion (test label in frame)', 'Limits: what can only be proven on device/QA'],
}
def route_of(asset):
    return ROUTES.get((asset or {}).get('route') or 'full', ASSET_STAGES)


def next_stage(asset, stage):
    """First stage after this one in the asset's route that is not approved yet, or None when the route is done."""
    r = route_of(asset)
    if (asset or {}).get('route') == 'social' and stage == 'page': stage = 'post'
    r = r if stage in r else next(v for v in ROUTES.values() if stage in v)
    return next((s for s in r[r.index(stage) + 1:] if not stage_approved(asset['stages'].get(s))), None)


def stage_approved(st):
    return bool(st and st.get('status') == 'approved' and not st.get('stale') and not (st.get('versions') or [{}])[-1].get('meta', {}).get('unverified'))


LOCK = threading.RLock()


class FileLock:
    """OS-released guard protects creation/recovery of the legacy .lock owner record."""
    def __init__(self, root, lock=LOCK): self.path = os.path.join(root, '.lock'); self.lock = lock
    def guard_lock(self, unlock=False):
        os.lseek(self.guard, 0, os.SEEK_SET)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(self.guard, msvcrt.LK_UNLCK if unlock else msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.guard, fcntl.LOCK_UN if unlock else fcntl.LOCK_EX | fcntl.LOCK_NB)
    def __enter__(self):
        self.lock.acquire(); end = time.monotonic() + 30
        self.guard = self.fd = None
        try:
            self.guard = os.open(self.path + '.guard', os.O_CREAT | os.O_RDWR, 0o600)
            while True:
                try: self.guard_lock(); break
                except OSError:
                    if time.monotonic() > end: raise SystemExit('ERROR review root is locked by another process: ' + self.path)
                    time.sleep(0.05)
            while True:
                try: self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY); os.write(self.fd, json.dumps({'pid': os.getpid(), 'since': time.time(), 'created': process_creation(os.getpid())}).encode()); return self
                except (FileExistsError, PermissionError):  # Windows: PermissionError while another process deletes .lock
                    try:
                        owner = jload(self.path, None)
                        if isinstance(owner, int): owner = {'pid': owner, 'since': os.path.getmtime(self.path)}  # older CLI locks
                        valid = (isinstance(owner, dict) and isinstance(owner.get('pid'), int) and owner['pid'] > 0
                                 and isinstance(owner.get('since'), (int, float)) and owner['since'] > 0
                                 and (owner.get('created') is None or isinstance(owner['created'], str)))
                        if not valid:
                            os.remove(self.path); continue
                        if isinstance(owner, dict) and owner.get('pid') and not pid_alive(owner['pid'], owner.get('since'), owner.get('created')):
                            os.remove(self.path); continue
                    except ValueError:
                        os.remove(self.path); continue  # guard proves no current writer owns this incomplete record
                    except OSError: pass
                    if time.monotonic() > end: raise SystemExit('ERROR review root is locked by another process: ' + self.path)
                    time.sleep(0.05)
        except BaseException:
            try:
                if self.fd is not None:
                    os.close(self.fd)
                    os.remove(self.path)
            finally:
                if self.guard is not None: os.close(self.guard)
                self.lock.release()
            raise
    def __exit__(self, *e):
        os.close(self.fd)
        try: os.remove(self.path)
        finally:
            try: os.close(self.guard)  # closing releases the OS lock even after an interrupted owner write
            finally: self.lock.release()


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


class StatCache:
    """Bounded, thread-safe LRU. Values are immutable text or directory-name tuples."""
    def __init__(self, entries=4096, budget=8 << 20, ttl=None):
        self.entries, self.budget, self.ttl = entries, budget, ttl
        self.data, self.bytes, self.lock = OrderedDict(), 0, threading.Lock()

    def get(self, path, sig):
        with self.lock:
            hit = self.data.get(path)
            if hit and hit[0] == sig:
                if hit[3] is not None and time.monotonic() >= hit[3]:
                    self.bytes -= self.data.pop(path)[2]
                    return None
                self.data.move_to_end(path)
                return hit[1]

    def put(self, path, sig, value, size, *, created=None):
        with self.lock:
            old = self.data.pop(path, None)
            if old: self.bytes -= old[2]
            if size > self.budget: return
            expires = None if self.ttl is None else (time.monotonic() if created is None else created) + self.ttl
            self.data[path] = sig, value, size, expires
            self.bytes += size
            while len(self.data) > self.entries or self.bytes > self.budget:
                self.bytes -= self.data.popitem(last=False)[1][2]


DISPLAY_CACHE_TTL = 1.0  # seconds from read start; hits never extend display freshness
JSON_CACHE = StatCache(ttl=DISPLAY_CACHE_TTL)
DIRECTORY_CACHE = StatCache(budget=1 << 20, ttl=DISPLAY_CACHE_TTL)
READ_CACHE_POLICY = threading.local()


def jload(path, default):
    """Read authorization, configuration and control state fresh on every call."""
    try:
        with open(path, encoding='utf-8') as f:
            if os.path.basename(path) == 'catalog.json':
                raw = f.buffer.read(MAX_LEGACY_CATALOG_BYTES + 1)
                if len(raw) > MAX_LEGACY_CATALOG_BYTES:
                    raise ValueError('catalog exceeds bounded legacy read budget')
                return json.loads(raw)
            return json.load(f)
    except FileNotFoundError:
        return default


def jload_cached(path, default):
    """Display reads expire within one second even if all metadata is unchanged.

    Windows ctime is not proof of content freshness. Access/configuration reads
    use jload(); this opt-in cache permits only a finite display delay.
    """
    if not getattr(READ_CACHE_POLICY, 'enabled', True):
        return jload(path, default)
    path = os.path.abspath(path)
    started = time.monotonic()
    sig = stat_sig(path)
    text = JSON_CACHE.get(path, sig) if sig else None
    if text is not None: return json.loads(text)  # each caller owns its mutable result
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except FileNotFoundError:
        return default
    result = json.loads(text)
    if sig and sig == stat_sig(path):
        JSON_CACHE.put(path, sig, text, sig[1], created=started)
    return result


def catalog_text(data):
    data = dict(data, assets={aid: dict(a, stages={sid: {k: v for k, v in st.items() if k != 'stale'} for sid, st in a['stages'].items()}) for aid, a in data['assets'].items()})
    # Copy only paths with old amplified reports. Never edit a caller's catalog.
    for asset in data['assets'].values():
        for stage in asset['stages'].values():
            versions = []
            for version in stage['versions']:
                files = []
                for file in version.get('files', []):
                    if 'missing' in file: file = {k: v for k, v in file.items() if k != 'missing'}  # derived per build, never stored
                    report = file.get('material_sanity')
                    if report:
                        rows = [report.get('diagnostics', []), report.get('metrics', {}).get('texture_uses', [])]
                        if any(len(r) > MAX_ROWS or len(json.dumps(r, ensure_ascii=False).encode('utf-8')) > MAX_ROW_BYTES for r in rows):
                            file = dict(file, material_sanity=compact_evidence(report))
                    files.append(file)
                versions.append(dict(version, files=files))
            stage['versions'] = versions
    chunks, size = [], 0
    for chunk in json.JSONEncoder(indent=1, ensure_ascii=False).iterencode(data):
        size += len(chunk.encode('utf-8'))
        if size > MAX_CATALOG_BYTES:
            raise ValueError('catalog exceeds publication budget (8 MiB); compact-catalog or archive old versions')
        chunks.append(chunk)
    return ''.join(chunks)


def compact_catalog(a):
    """Confined, locked migration of legacy reports in a canonical local root."""
    if os.name != 'nt':
        raise ValueError('POSIX catalog replacement requires a private, descriptor-anchored rename source')
    from pathlib import Path, PureWindowsPath
    import stat
    import evidence_export as confinement

    given = os.fspath(a.root)
    windows = PureWindowsPath(given)
    if (given.startswith(('\\', '//')) or windows.drive.startswith('\\')
            or (windows.drive and not windows.is_absolute())
            or (os.name == 'nt' and windows.root and not windows.drive)
            or (windows.drive and os.name != 'nt')
            or any(part in ('.', '..') or part != part.rstrip(' .')
                   or any(ord(c) < 32 or c in '<>:"|?*' for c in part)
                   or part.lower().split('.')[0] in confinement.WINDOWS_DEVICES
                   for part in windows.parts if part != windows.anchor)):
        raise ValueError('compact-catalog requires a canonical local root')
    root = Path(os.path.abspath(given))
    confinement.no_symlinks(root)

    class CatalogDirectory(confinement.DestinationDirectory):
        def check(self):
            confinement.no_symlinks(self.path)
            if not confinement.same_identity(self.expected, self.path.lstat()):
                raise ValueError('catalog directory identity changed')

    with LOCK, CatalogDirectory(root, root) as directory, contextlib.ExitStack() as handles:
        # The guard is the same OS lock all FileLock writers acquire first.
        for name in ('catalog.json', '.lock', '.lock.guard'):
            try:
                _, info = confinement.checked_file(root, name)
            except FileNotFoundError:
                if name == 'catalog.json': raise
            else:
                if info.st_nlink != 1:
                    raise ValueError('linked catalog/lock file is not allowed')
        guard = os.open(directory.entry('.lock.guard'), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600, **directory.options())
        handles.callback(os.close, guard)
        opened = os.fstat(guard)
        _, expected = confinement.checked_file(root, '.lock.guard')
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or not confinement.same_identity(opened, expected)):
            raise ValueError('catalog lock identity changed')
        lock = FileLock(str(root))
        lock.guard = guard
        lock.guard_lock()
        directory.check()
        if directory.fd is None:
            source = confinement.open_source(root, 'catalog.json')
        else:
            fd = os.open('catalog.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory.fd)
            source = os.fdopen(fd, 'rb')
        with source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                raise ValueError('linked catalog file is not allowed')
            directory.check()
            raw = source.read(MAX_LEGACY_CATALOG_BYTES + 1)
        if len(raw) > MAX_LEGACY_CATALOG_BYTES:
            raise ValueError('catalog exceeds bounded legacy read budget')
        text = catalog_text(json.loads(raw)).encode('utf-8')
        with directory.create_temp() as staging:
            with staging.open() as destination:
                destination.write(text)
                destination.flush()
                os.fsync(destination.fileno())
                destination.seek(0)
                json.load(destination)
            staging.publish('catalog.json', replace=True)
        directory.sync()
    print('COMPACTED ' + str(root / 'catalog.json'))


def jsave(path, data):
    package_io = getattr(PACKAGE_IO, 'current', None)
    if package_io is not None and os.path.abspath(path) == str(package_io.root / 'catalog.json'):
        return package_io.write_catalog(path, data)
    text = catalog_text(data) if os.path.basename(path) == 'catalog.json' else None
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = '%s.%d.%d.tmp' % (path, os.getpid(), threading.get_ident())
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        if text is not None:
            f.write(text)
        else:
            json.dump(data, f, indent=1, ensure_ascii=False)
    with open(tmp, encoding='utf-8') as f:
        json.load(f)  # parse check before replace
    for i in range(8):  # Windows refuses the replace while a reader has the file open
        try: return os.replace(tmp, path)
        except PermissionError:
            if i == 7: raise
            time.sleep(0.05 * (i + 1))


CATALOG_CACHE = {}  # (root, project) -> (signature, deps, catalog as JSON text, expiry)


def stat_sig(path):
    try: s = os.stat(path); return s.st_mtime_ns, s.st_size, s.st_ctime_ns, s.st_ino, s.st_dev
    except OSError: return None


def directory_names(path):
    """Names expire within one second even with unchanged directory metadata.

    Cache names only: child stats must still be checked for in-place edits.
    """
    path = os.path.abspath(path)
    started = time.monotonic()
    sig = stat_sig(path)
    if sig is None: return None
    names = DIRECTORY_CACHE.get(path, sig)
    if names is not None: return names
    try:
        with os.scandir(path) as it: names = tuple(sorted(e.name for e in it))
    except OSError: return None
    if sig == stat_sig(path):
        DIRECTORY_CACHE.put(path, sig, names, sum(len(n.encode('utf-8')) + 64 for n in names), created=started)
    return names


def listing_sig(path):
    names = directory_names(path)
    return tuple((n, stat_sig(os.path.join(path, n))) for n in names) if names is not None else None


def catalog_sig(root, deps):
    """Stat-only fingerprint of every file catalog() reads: catalog.json, each version's comments/ and feedback.json, game manifest folders."""
    listings, files = deps
    return stat_sig(os.path.join(root, 'catalog.json')), tuple(map(listing_sig, listings)), tuple(map(stat_sig, files))


def catalog(root, project=None):
    """Derived display catalog, invalidated by stats or the one-second limit.

    Rebuilds read sidecars fresh, so display-cache delays cannot accumulate.
    Every call returns its own copy, so callers may edit and save it.
    """
    key = (os.path.abspath(root), project); hit = CATALOG_CACHE.get(key)
    if hit and time.monotonic() < hit[3] and hit[0] == catalog_sig(root, hit[1]): return json.loads(hit[2])
    for _ in range(3):
        started = time.monotonic()
        before = stat_sig(os.path.join(root, 'catalog.json'))
        cat = jload(os.path.join(root, 'catalog.json'), {'schema': 'asset-review/1', 'project': project or os.path.basename(os.path.abspath(root)), 'assets': {}})
        deps = ([], [])
        for aid, asset in cat['assets'].items():
            for sid, st in asset['stages'].items():
                for ver in st['versions']:
                    d = vdir(root, aid, sid, ver['v']); deps[0].append(os.path.join(d, 'comments')); deps[1].append(os.path.join(d, 'feedback.json'))
                    render = ver.get('meta', {}).get('render', {})
                    if render.get('hash'):
                        from auto_render import job_path
                        deps[1].append(str(job_path(root, render['hash'])))
            path = approved_manifest(root, aid, asset) if asset.get('route') == 'game' else None
            if path: deps[0].append(os.path.dirname(path))
        sig = catalog_sig(root, deps)
        if before != sig[0]: continue
        cat['stages'] = [{'id': i, 'label': l, 'media': m, 'checks': c, 'group': STAGE_GROUP[i]} for i, l, m, c in STAGES]
        cat['routes'] = {k: {'label': ROUTE_LABELS[k], 'stages': v, 'group': ROUTE_GROUP.get(k, 'asset'),
                              'checklists': {sid: ROUTE_CHECKLISTS.get((k, sid), next(s[3] for s in STAGES if s[0] == sid)) for sid in v}} for k, v in ROUTES.items()}
        game_stale(root, cat)
        for aid, asset in cat['assets'].items():
            catalog_asset(root, aid, asset, load_json=jload)
        if sig != catalog_sig(root, deps): continue
        CATALOG_CACHE[key] = sig, deps, json.dumps(cat), started + DISPLAY_CACHE_TTL
        return cat
    raise RuntimeError('catalog changed during three reads: ' + os.path.abspath(root))


def catalog_asset(root, aid, asset, *, load_json=None, missing=True):
    """Apply the same version sidecars for full catalogs and incremental summaries.

    The bounded summary index passes missing=False: it keeps its own stat budget and cache."""
    load = load_json or jload_cached
    people_by_version = {}
    for sid, st in asset['stages'].items():
        for ver in st['versions']:
            d = vdir(root, aid, sid, ver['v'])
            if missing:
                present = directory_names(d)  # one listing per version; a file removed from disk shows its missing state without being requested
                for f in ver.get('files', []):
                    if present is not None and f['name'] in present: f.pop('missing', None)
                    else: f['missing'] = True
            if os.path.isdir(os.path.join(d, 'comments')):
                people = (comments(d)['people'] if load_json is None else
                          {os.path.basename(p)[:-5]: load(p, {}) for p in sorted(glob.glob(os.path.join(d, 'comments', '*.json')))})
                notes = [n for p in people.values() for n in p.get('comments', [])]
                people_by_version[(sid, ver['v'])] = people
                ver['comments'] = {'open': sum(n.get('status', 'open') == 'open' for n in notes), 'total': len(notes), 'by': [p['name'] for p in people.values() if p.get('comments')]}
            fb = load(os.path.join(d, 'feedback.json'), None)
            if fb: ver['feedback'] = fb
            render = ver.get('meta', {}).get('render', {})
            if render.get('hash'):
                from auto_render import job_path
                job = load(str(job_path(root, render['hash'])), {})
                ver['meta']['render'] = {k: job[k] for k in ('hash', 'status', 'machine', 'runner', 'fallback', 'seconds', 'log_tail', 'previews') if k in job}
        if st.get('status') == 'approved' and (st.get('versions') or [{}])[-1].get('meta', {}).get('unverified'): st['status'] = 'unverified'
    return people_by_version


def catalog_page(root, project=None, **options):
    """Bounded home summaries; sidecar polling coalesces within a short TTL."""
    from catalog_index import page
    # The summary index owns stable-read validation and caching. Avoid repeating
    # those stats or retaining its disposable index in the general read cache.
    enabled = getattr(READ_CACHE_POLICY, 'enabled', True)
    READ_CACHE_POLICY.enabled = False
    try: return page(root, project, **options)
    finally: READ_CACHE_POLICY.enabled = enabled


def approved_manifest(root, aid, asset):
    st = asset['stages'].get('assets') or {}
    ver = next((v for v in reversed(st.get('versions', [])) if v.get('reviewed') == 'approved'), None)
    if not ver: return None
    return os.path.join(vdir(root, aid, 'assets', ver['v']), 'assets.json')


def manifest_assets(cat, d, check_limit=True):
    """Validate a submission manifest and resolve its current approved hero/kit versions."""
    blocked, versions = [], {}
    try:
        doc = jload(os.path.join(d, 'assets.json'), None)
        if not isinstance(doc, dict) or not isinstance(doc.get('entries'), list): raise ValueError('entries must be a list')
        entries = doc['entries']
    except (ValueError, OSError) as e:
        return {}, ['assets.json is missing or invalid: %s' % e]
    if check_limit and len(entries) > 9: blocked.append('assets.json has more than 9 entries: needs owner approval; use --skip-gate with their reason')
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict): blocked.append('assets.json: entry must be an object'); continue
        eid, cls = entry.get('id'), entry.get('class')
        if not isinstance(eid, str) or not safe_name(eid) or eid in seen:
            blocked.append('assets.json: missing, invalid or duplicate entry id'); continue
        seen.add(eid)
        if cls not in ('hero', 'kit', 'primitive'): blocked.append('%s: class must be hero, kit or primitive' % eid); continue
        for field in ('owner', 'reason', 'screenshot'):
            if not isinstance(entry.get(field), str) or not entry[field].strip(): blocked.append('%s: %s missing' % (eid, field))
        screenshot = entry.get('screenshot')
        if not isinstance(screenshot, str) or not safe_name(screenshot) or not os.path.isfile(os.path.join(d, screenshot)):
            blocked.append('%s: screenshot missing from this submission' % eid)
        if cls == 'primitive': continue
        source = entry.get('source')
        if not isinstance(source, str) or not re.fullmatch(r'blender|kit|generated:[a-z0-9._-]+|marketplace:[a-z0-9._-]+', source):
            blocked.append('%s: source missing or invalid (blender, kit, generated:<tool> or marketplace:<site>)' % eid)
        linked = entry.get('asset')
        item = cat['assets'].get(linked) if isinstance(linked, str) else None
        sid = 'engine' if cls == 'hero' else 'model'
        st = (item or {}).get('stages', {}).get(sid)
        if not stage_approved(st) or not st.get('versions'):
            blocked.append('%s: %s asset %s latest %s version is not approved in the same root' % (eid, cls, linked, sid))
        else: versions[linked] = st['versions'][-1]['v']
    return versions, blocked


def game_stale(root, cat, asset_ids=None):
    """Derived flags only: saved verdicts and approval history remain unchanged."""
    for aid in (cat['assets'] if asset_ids is None else asset_ids):
        asset = cat['assets'][aid]
        for st in asset['stages'].values(): st.pop('stale', None)
        if asset.get('route') != 'game': continue
        path = approved_manifest(root, aid, asset)
        versions, errors = manifest_assets(cat, os.path.dirname(path), check_limit=False) if path else ({}, ['No approved assets stage'])
        # Keep the manifest ids even while their latest versions are awaiting approval.
        try:
            doc = jload(path, {}) if path else {}
            entries = doc.get('entries', []) if isinstance(doc, dict) else []
            if not isinstance(entries, list): entries = []
        except (ValueError, OSError): entries = []
        linked = [e['asset'] for e in entries if isinstance(e, dict) and e.get('class') in ('hero', 'kit') and isinstance(e.get('asset'), str)]
        for sid in ('level', 'slice', 'polish', 'qa', 'store', 'final'):
            st = asset['stages'].get(sid)
            if not st or st.get('status') != 'approved' or not st.get('versions'): continue
            ver = st['versions'][-1]
            if sid != 'level' and (errors or (ver.get('build') or {}).get('assets') != versions):
                st['stale'] = ('Outdated: approved without a build record (from before the build gate); resubmit with --build-id'
                               if not ver.get('build') else 'Outdated: approved manifest assets or recorded asset versions have changed')
                continue
            rvpath = os.path.join(vdir(root, aid, sid, ver['v']), 'review.json')
            cutoff = datetime.datetime.fromisoformat(ver['at']).timestamp() if sid != 'level' else (os.path.getmtime(rvpath) if os.path.isfile(rvpath) else datetime.datetime.fromisoformat(ver['at']).timestamp())
            if any(datetime.datetime.fromisoformat(v['at']).timestamp() > cutoff for lid in linked for ls in cat['assets'].get(lid, {}).get('stages', {}).values() for v in ls.get('versions', []) if v.get('at')):
                st['stale'] = 'Outdated: a manifest asset got a new submission; check sizes/collision and resubmit'


# 2026-10-06: four voucher colours went in as one sheet, so the owner could not pick one in the viewer.
# 2026-10-10: a contact sheet is proof of ONE asset (animation poses, model angles), not a choice; it blocked
# a starter-kit animation and a level. Option sheets still match on their own words (Dutch file names included).
OPTION_SHEET = re.compile(r'variant|optie|option|overzicht', re.I)


def options_gate(asset, files):
    """An overview of several options cannot be chosen from: each option must be its own --choice asset."""
    if asset.get('choice'): return []
    return ['%s: looks like an overview of several options. Submit each option as its own asset with --choice <group>, '
            'then the owner picks 1 in the viewer (no extra overview sheet)' % f['name'] for f in files if OPTION_SHEET.search(f['name'])]


def game_gate(root, cat, aid, asset, sid, d, files, a, ver):
    if asset.get('route') != 'game': return []
    blocked = []
    if sid == 'assets':
        _, blocked = manifest_assets(cat, d)
    if sid == 'sound':
        print('  LICENCE: the tool checks ledger rows; it cannot verify that licences are true.')
        try:
            with open(os.path.join(d, 'ledger.csv'), encoding='utf-8-sig', newline='') as f:
                reader = csv.DictReader(f)
                if not {'file', 'source', 'licence'} <= set(reader.fieldnames or []): raise ValueError('columns file,source,licence required')
                rows = {r['file'] for r in reader if all((r.get(k) or '').strip() for k in ('file', 'source', 'licence'))}
            blocked += ['ledger.csv: row missing for ' + f['name'] for f in files if f['media'] == 'audio' and f['name'] not in rows]
        except (OSError, ValueError, csv.Error) as e: blocked.append('ledger.csv is missing or invalid: %s' % e)
    if sid in ('slice', 'polish', 'qa', 'store', 'final'):
        if sid != 'final' and not (a.build_id or '').strip(): blocked.append('--build-id required for ' + sid)
        path = approved_manifest(root, aid, asset)
        versions, errors = manifest_assets(cat, os.path.dirname(path), check_limit=False) if path else ({}, ['No approved assets stage with assets.json'])
        if not stage_approved(asset['stages'].get('assets')): blocked.append('Latest assets stage must be approved')
        blocked += errors
        store = (asset['stages'].get('store') or {}).get('versions', [])
        ver['build'] = {'id': a.build_id if sid != 'final' else ((store[-1].get('build') or {}).get('id') if store else None), 'assets': versions}
        if sid == 'qa':
            if a.phone_clients is None or a.phone_clients < 1: blocked.append('--phone-clients N required: a real phone session with at least 1 client')
            ver['build']['phone_clients'] = a.phone_clients
        if sid == 'store':
            qa = asset['stages'].get('qa') or {}; qvers = qa.get('versions', [])
            qb = (qvers[-1].get('build') or {}) if qvers else {}
            if not stage_approved(asset['stages'].get('slice')) or not stage_approved(qa): blocked.append('Store needs an approved, current slice and QA')
            if ver['build']['id'] != qb.get('id') or versions != qb.get('assets'): blocked.append('Store build ID and asset versions must match the QA-approved build')
            ver['build']['claim_players'] = a.claim_players
            if a.claim_players is None or a.claim_players < 1 or a.claim_players > (qb.get('phone_clients') or 0):
                blocked.append('--claim-players must be at least 1 and may not exceed the measured phone session client count (%s); measure the promised player count' % qb.get('phone_clients', 0))
    if sid in ('slice', 'qa', 'store', 'final'):
        earlier = ROUTES['game'][:ROUTES['game'].index(sid)]
        bad = [s for s in earlier if not stage_approved(asset['stages'].get(s))]
        if bad: blocked.append('Earlier steps not approved or outdated: ' + ', '.join(bad))
    return blocked


# Every root that `up` or `submit` touches is registered here; viewers use this project index and ?p=<id>.
# Keep the registry visible to both packaged launchers and the desktop app.
PROJECTS = os.environ.get('ASSET_REVIEW_PROJECTS') or os.path.join(os.path.expanduser('~'), '.asset-review', 'projects.json')
PEOPLE = os.environ.get('ASSET_REVIEW_PEOPLE') or os.path.join(os.path.dirname(PROJECTS), 'people.json')
ARCHIVED = os.path.join(os.path.dirname(PROJECTS), 'projects-archived.json')  # [{id, root, project, reason, by, at}]: archived projects stay registered but hidden
if not os.environ.get('ASSET_REVIEW_LIBRARY_INDEX'): library.INDEX = os.path.join(os.path.dirname(PROJECTS), 'LIBRARY.json')


def archived_projects():
    return jload(ARCHIVED, [])


def live_roots():
    """Registered roots that are not archived."""
    hidden = {a['id'] for a in archived_projects()}
    return [r for r in jload(PROJECTS, []) if project_id(r) not in hidden]


def project_archive(target, reason, by, restore=False):
    """Archive project / Restore: hides the project from active navigation, inbox and counters. Registry only; no file of the project is touched."""
    pid = str(target) if re.fullmatch(r'[a-f0-9]{8}', str(target)) else project_id(target)
    with FileLock(os.path.dirname(os.path.abspath(ARCHIVED))):
        rows = archived_projects()
        if restore:
            row = next((a for a in rows if a['id'] == pid), None)
            if not row: raise ValueError('This project is not archived')
            jsave(ARCHIVED, [a for a in rows if a['id'] != pid]); return row
        root = next((r for r in jload(PROJECTS, []) if project_id(r) == pid), None) or (os.path.abspath(target) if os.path.isdir(str(target)) else None)
        if not root or not os.path.isfile(os.path.join(root, 'catalog.json')): raise ValueError('Unknown project')
        if EXTENSION is not None: EXTENSION.before_project_archive(root)
        if any(a['id'] == pid for a in rows): raise ValueError('This project is already archived')
        reason = ' '.join(str(reason or '').split())[:4000]
        if not reason: raise ValueError('Give a reason to archive')
        register(root)  # a restore needs the root in the registry again
        row = dict(id=pid, root=os.path.abspath(root), project=jload(os.path.join(root, 'catalog.json'), {}).get('project') or os.path.basename(os.path.abspath(root)), reason=reason, by=by, at=now())
        jsave(ARCHIVED, rows + [row]); return row


def project_cmd(a):
    if a.action == 'list':
        for r in archived_projects(): print('%s  %s  (%s: %s)  %s' % (r['id'], r['project'], r['by'], r['reason'], r['root']))
        return
    if not a.project: raise SystemExit('ERROR --project <id|root> required')
    try: row = project_archive(a.project, a.reason, a.by, a.restore)
    except ValueError as e: raise SystemExit('ERROR ' + str(e))
    print('%s %s (%s); no project file touched' % ('RESTORED' if a.restore else 'ARCHIVED', row['project'], row['id']))


def identity(ip='', remote=False):
    people = jload(PEOPLE, {}).get('people', {})
    if remote:
        for pid, person in people.items():
            for device, addr in person.get('devices', {}).items():
                if addr == ip: return dict(person, person=pid, device=device, remote=True)
        if os.path.exists(PEOPLE):  # once people.json exists, an unlisted device is a guest; without it every allowed device is the owner (v1)
            return dict(person='guest', name=ip, admin=False, device=ip, remote=True, default='none')
    pid = 'owner'
    if not remote and pid not in people:
        admins = [key for key, person in people.items() if person.get('admin') is True]
        if len(admins) == 1:
            pid = admins[0]
    return dict(people.get(pid, {}), person=pid, name=people.get(pid, {}).get('name') or 'Owner', admin=True, device=ip if remote else 'local', remote=remote)


def person_role(person, root):
    if person.get('person') == 'guest': return 'none'
    return 'owner' if person.get('admin') else person.get('projects', {}).get(project_id(root), person.get('default', 'none'))


def owned_by_other(root):
    """Name of a non-admin owner of this project: the admin does not wait on a version that owner decides."""
    pid = project_id(root)
    return next((p.get('name') or k for k, p in jload(PEOPLE, {}).get('people', {}).items() if not p.get('admin') and p.get('projects', {}).get(pid) == 'owner'), None)


def people_cmd(a):
    doc = jload(PEOPLE, {'schema': 'asset-review/people-1', 'people': {}})
    if a.action == 'list': print(json.dumps(doc, ensure_ascii=False, indent=1)); return
    if not a.id or not safe_name(a.id): raise SystemExit('ERROR invalid person')
    with FileLock(os.path.dirname(os.path.abspath(PEOPLE))):
        doc = jload(PEOPLE, doc)
        if a.action == 'add':
            p = doc['people'].setdefault(a.id, {'devices': {}})
            if a.name: p['name'] = a.name
            if getattr(a, 'admin', False): p['admin'] = True
            for device in a.device or []:
                name, _, ip = device.partition('=')
                if not safe_name(name): raise SystemExit('ERROR invalid device')
                if not ip:
                    st = ts_status(); nodes = [st.get('Self', {})] + list(st.get('Peer', {}).values())
                    node = next((n for n in nodes if name.lower() in (str(n.get('HostName', '')).lower(), str(n.get('DNSName', '')).split('.')[0].lower())), {})
                    ip = next(iter(node.get('TailscaleIPs', [])), '')
                if not ip: raise SystemExit('ERROR device not found: ' + name)
                import ipaddress
                ipaddress.ip_address(ip)
                p.setdefault('devices', {})[name] = ip
        else:
            if a.id not in doc['people']: raise SystemExit('ERROR unknown person')
            if a.action == 'default': doc['people'][a.id]['default'] = a.role
            else:
                if not a.project: raise SystemExit('ERROR --project required')
                pid = a.project if re.fullmatch(r'[a-f0-9]{8}', a.project) else project_id(a.project)
                doc['people'][a.id].setdefault('projects', {})[pid] = a.role
        jsave(PEOPLE, doc)
    print('PEOPLE ' + PEOPLE)


def project_id(root):
    return hashlib.sha1(os.path.normcase(os.path.abspath(root)).encode('utf-8')).hexdigest()[:8]


def register(root):
    roots = jload(PROJECTS, [])
    if project_id(root) not in map(project_id, roots): jsave(PROJECTS, roots + [os.path.abspath(root)])


OVERVIEW_CACHE = OrderedDict()
OVERVIEW_LOCK = threading.RLock()


def overview_catalog(root):
    """Reuse compact project data without repeatedly decoding route/checklist metadata.

    Kept as JSON text like CATALOG_CACHE: every caller gets its own copy.
    """
    key = os.path.abspath(root)
    with OVERVIEW_LOCK:
        hit = OVERVIEW_CACHE.get(key)
        if hit and time.monotonic() < hit[3] and hit[0] == catalog_sig(root, hit[1]):
            OVERVIEW_CACHE.move_to_end(key)
            return json.loads(hit[2])
    started = time.monotonic()
    cat = catalog(root)
    source = CATALOG_CACHE.get((key, None))
    if source:
        compact = {k: v for k, v in cat.items() if k not in ("routes", "stages")}
        compact['stages'] = [{'id': stage['id']} for stage in cat.get('stages', [])]
        with OVERVIEW_LOCK:
            OVERVIEW_CACHE[key] = (
                source[0],
                source[1],
                json.dumps(compact),
                started + DISPLAY_CACHE_TTL,
            )
            OVERVIEW_CACHE.move_to_end(key)
            while len(OVERVIEW_CACHE) > 128:
                OVERVIEW_CACHE.popitem(last=False)
        return compact
    return cat


def project_read_error(root, error):
    detail = str(error)[:200]
    print('PROJECT read error in %s: %s' % (root, detail), file=sys.stderr, flush=True)
    return dict(id=project_id(root), root=os.path.abspath(root), error=detail)


def projects(home, catalogs=None, person=None):
    """Visible registered projects in registry order, plus diagnostics for unavailable catalogs."""
    roots = live_roots(); hidden = {a['id'] for a in archived_projects()}
    roots = roots if project_id(home) in map(project_id, roots) or project_id(home) in hidden else [home] + roots
    out, errors = [], []
    for r in roots:
        if person is not None and person_role(person, r) == 'none': continue
        if not os.path.isfile(os.path.join(r, 'catalog.json')):
            errors.append(project_read_error(r, 'catalog.json is missing or unreachable'))
            continue
        if project_id(r) not in [p['id'] for p in out]:
            try:
                cat = overview_catalog(r)
                if catalogs is not None: catalogs[project_id(r)] = cat
                out.append({'id': project_id(r), 'project': cat['project'], 'waiting': len(waiting(r, cat))})
            except Exception as error:
                errors.append(project_read_error(r, error))
    return {'home': project_id(home), 'projects': out, 'errors': errors}


def vdir(root, asset, stage, v):
    return os.path.join(root, 'items', asset, stage, 'v%03d' % v)


def check_ids(asset, stage, v=1):
    if not safe_name(asset or '') or stage not in STAGE_IDS or not (1 <= int(v) <= 999):
        raise ValueError('bad asset/stage/version')


def stage_status(review):
    if (review or {}).get('draft'): return 'in_review'
    return {'approved': 'approved', 'changes': 'changes', 'rejected': 'rejected'}.get((review or {}).get('verdict'), 'in_review')


def final_review(path):
    """review.json if it exists and is final; drafts are invisible to agents."""
    rv = jload(path, None)
    return rv if rv and not rv.get('draft') else None


def event(root, **kw):
    package_io = getattr(PACKAGE_IO, 'current', None)
    if package_io is not None and kw.get('event_id') == package_io.marker['event_id']:
        return package_io.write_event(root, kw)
    kw = dict(at=now(), **kw)
    with open(os.path.join(root, 'events.jsonl'), 'a', encoding='utf-8', newline='\n') as f: f.write(json.dumps(kw, ensure_ascii=False) + '\n')


def base_url(root):
    info = jload(os.path.join(root, '.server.json'), None) or {}
    return 'http://127.0.0.1:%d/' % info.get('port', 4780)


def home_url(root):
    """Local start page of a project; one that the hub serves without a port of its own needs ?p=."""
    info = jload(os.path.join(root, '.server.json'), None) or {}
    return base_url(root) + ('?p=' + project_id(root) if info.get('hub') else '')


def viewer_live(root):
    """True when the viewer recorded in .server.json answers /api/info for this root, or the live hub serves it."""
    info = jload(os.path.join(root, '.server.json'), None) or {}
    if type(info.get('port')) is not int: return False
    if info.get('hub'): return pid_alive(info.get('pid'), None, info.get('created'))
    return server_port(root) is not None


def link(root, asset, stage=None, v=None):
    return base_url(root) + '?p=' + project_id(root) + '#a=' + asset + ('&s=' + stage if stage else '') + ('&v=%d' % v if v else '')


# ---------------- submit (agents) ----------------
def set_choice(asset, group):
    if group.lower() == 'none': asset.pop('choice', None); return
    if not safe_name(group): raise SystemExit('ERROR bad choice group (letters, digits, _ . - only): ' + group)
    asset['choice'] = group


def set_category(asset, name):
    """Optional review category (Heroes, Buildings, UI ...). Without one the viewer groups by the route label."""
    name = ' '.join(str(name or '').split())
    if name.lower() == 'none': asset.pop('category', None); return
    if not re.fullmatch(r"[\w .&/+'-]{1,40}", name): raise SystemExit('ERROR bad category (max 40 letters, digits, spaces or & / + . - \'): ' + name)
    asset['category'] = name


def category_of(asset):
    """Same rule as the viewer (category.js): the stored category, else the route label."""
    return asset.get('category') or ROUTE_LABELS.get(asset.get('route') or 'full', 'Overig')


def category_cmd(a):
    """--set labels existing assets; without --set: every category with its waiting versions."""
    if a.set is not None:
        if not a.asset: raise SystemExit('ERROR give --asset with --set')
        with FileLock(a.root):
            cat = catalog(a.root, a.project)
            for x in a.asset:
                if x not in cat['assets']: raise SystemExit('ERROR unknown asset ' + x)
                set_category(cat['assets'][x], a.set)
            jsave(os.path.join(a.root, 'catalog.json'), cat)
        print('CATEGORY %s: %s' % (a.set, ', '.join(a.asset)))
        if a.set.lower() != 'none': print('  REVIEW_URL %s?p=%s#cat=%s' % (base_url(a.root), project_id(a.root), urllib.parse.quote(' '.join(a.set.split()), safe='')))
        return
    cat = catalog(a.root, a.project); rows = {}
    for aid, asset in cat['assets'].items(): rows.setdefault(category_of(asset), {'assets': [], 'waiting': 0})['assets'].append(aid)
    for w in waiting(a.root, cat): rows[category_of(cat['assets'][w['asset']])]['waiting'] += 1
    for name, r in sorted(rows.items(), key=lambda kv: (-kv[1]['waiting'], kv[0].lower())):
        print('%s: %d wachten · %s' % (name, r['waiting'], ', '.join(r['assets'])))


def choice_cmd(a):
    """Group existing assets as options of one question; the viewer shows them as one "pick 1 of N" card with a slider compare."""
    with FileLock(a.root):
        cat = catalog(a.root, a.project)
        for x in a.asset:
            if x not in cat['assets']: raise SystemExit('ERROR unknown asset ' + x)
            set_choice(cat['assets'][x], a.group)
        jsave(os.path.join(a.root, 'catalog.json'), cat)
    print('CHOICE %s: %s' % (a.group, ', '.join(a.asset)))
    if a.group.lower() != 'none': print('  REVIEW_URL ' + home_url(a.root) + '#choice=' + a.group)


def parse_meta(s):
    """JSON object, or key=value pairs separated by commas (PowerShell strips JSON quotes)."""
    s = (s or '').strip()
    if not s: return {}
    if s.startswith('{'):
        def unique(pairs):
            out = {}
            for key, value in pairs:
                if key in out: raise ValueError('duplicate metadata key: ' + key)
                out[key] = value
            return out
        return json.loads(s, object_pairs_hook=unique)
    out = {}
    for kv in s.split(','):
        k, _, v = kv.partition('=')
        if k.strip() in out: raise ValueError('duplicate metadata key: ' + k.strip())
        try: out[k.strip()] = json.loads(v.strip())
        except ValueError: out[k.strip()] = v.strip()
    return out

SCREENSHOT_LIMITS = {'entries': 256, 'filename': 255, 'page': 1024}


def screenshot_meta(meta, filenames):
    """Validate optional per-file submitted CSS viewport metadata; preserve other meta.

    screenshots maps submitted image basenames to width/height/dpr/page. Legacy
    width.<file>, height.<file>, dpr.<file>, page.<file> declarations are additive.
    Page strings are opaque identities, never addresses to fetch or normalize.
    """
    if not isinstance(meta, dict): raise ValueError('meta must be an object')
    shots = meta.get('screenshots', {})
    if not isinstance(shots, dict): raise ValueError('screenshots must be a filename map')
    if len(shots) > SCREENSHOT_LIMITS['entries']: raise ValueError('too many screenshot declarations')
    shots = dict(shots)
    legacy = {}
    for key, value in meta.items():
        if key.startswith(('width.', 'height.', 'dpr.', 'page.')) and len(key) > SCREENSHOT_LIMITS['filename'] + 7:
            raise ValueError('screenshot filename identity too long')
        field, _, name = key.partition('.')
        if name and field in ('width', 'height', 'dpr', 'page'):
            legacy.setdefault(name, {})[field] = value
            if len(legacy) + len(shots) > SCREENSHOT_LIMITS['entries']: raise ValueError('too many screenshot declarations')
    for name, entry in legacy.items():
        if name in shots: raise ValueError('duplicate screenshot declaration: ' + name)
        shots[name] = entry
    for name, entry in shots.items():
        if (not isinstance(name, str) or len(name) > SCREENSHOT_LIMITS['filename'] or not re.fullmatch(r'[A-Za-z0-9_.-]+', name)
                or name in ('.', '..') or name not in filenames
                or MEDIA.get(os.path.splitext(name)[1].lower()) != 'image'):
            raise ValueError('screenshot must name a confined submitted image')
        if not isinstance(entry, dict): raise ValueError('screenshot viewport must be an object')
        for key in ('width', 'height', 'dpr'):
            if key not in entry: continue  # unknown evidence remains unpaired
            value = entry[key]
            try: finite = math.isfinite(value)
            except (TypeError, OverflowError): finite = False
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not finite or value <= 0:
                raise ValueError('screenshot ' + key + ' must be finite and positive')
        if 'page' in entry and (not isinstance(entry['page'], str) or len(entry['page']) > SCREENSHOT_LIMITS['page'] or not entry['page'].strip() or any(ord(c) < 32 for c in entry['page'])):
            raise ValueError('screenshot page must be a bounded nonempty identity')
        if 'preset' in entry and (isinstance(entry['preset'], bool) or entry['preset'] not in (375, 820, 1440) or entry.get('width') != entry['preset']):
            raise ValueError('screenshot preset must match 375, 820 or 1440 CSS pixels')
    return dict(meta, screenshots=shots) if shots or 'screenshots' in meta else meta


def video_timing(path, meta, decoded=False):
    def rate(value):
        try:
            n = float(Fraction(str(value)))
            return n if 0 < n <= 1000 else None
        except (ValueError, ZeroDivisionError):
            return None
    if decoded:
        from video_timestamps import probe as presentation_probe
        timing = presentation_probe(path)
        def bounded_rate(value):
            text = str(value)
            return rate(text) if len(text) <= 64 and re.fullmatch(r'\d{1,16}(?:/\d{1,16}|\.\d{1,16})?', text) else None
        nominal, average = (bounded_rate(timing.get('rates', {}).get(k)) for k in ('r_frame_rate', 'avg_frame_rate'))
        fps = average if nominal and average and abs(nominal - average) <= .001 else None
        source = 'ffprobe' if fps else 'variable' if nominal and average else 'unknown'
        if source == 'unknown':
            fps = bounded_rate(meta.get('fps')); source = 'meta' if fps else 'unknown'
        return {'fps': fps, 'fps_source': source, 'presentation_timing': timing,
                **({'source_hash': timing['source_hash']} if timing.get('source_hash') else {})}
    probe = shutil.which('ffprobe')
    if probe:
        try:
            from video_timestamps import legacy_metadata
            streams = legacy_metadata(path, probe)
            if streams:
                nominal, average = (rate(streams[0].get(k)) for k in ('r_frame_rate', 'avg_frame_rate'))
                if nominal and average:
                    if abs(nominal - average) > .001:
                        return {'fps': None, 'fps_source': 'variable'}
                    return {'fps': average, 'fps_source': 'ffprobe'}
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
    fps = rate(meta.get('fps'))
    return {'fps': fps, 'fps_source': 'meta' if fps else 'unknown'}


def proof_warnings(root, stage, paths):
    """Game stages: [(file name, warning)] for each submitted .md that is older than the newest file in the project's proof/ folder (the document may state old numbers)."""
    if STAGE_GROUP.get(stage) != 'game': return []
    base = os.path.abspath(root); proof = next((p for p in (os.path.join(d, 'proof') for d in (base, os.path.dirname(base), os.path.dirname(os.path.dirname(base)))) if os.path.isdir(p)), None)
    if not proof: return []
    newest = max(((os.path.getmtime(os.path.join(r, n)), n) for r, _, names in os.walk(proof) for n in names), default=None)
    if not newest: return []
    return [(os.path.basename(f), 'proof/ is newer than this document (%s changed after %s was written): check its numbers against proof/ and update it, or submit on purpose' % (newest[1], os.path.basename(f)))
            for f in paths if f.lower().endswith('.md') and os.path.getmtime(f) < newest[0]]


# R3C-111 begin
from review_queue import QueueFull, queue_size, catalog_queue, save_limit, require_slot
# R3C-111 end


def submit(a):
    if a.asset in jload(os.path.join(a.root, 'catalog.json'), {}).get('binned', {}):
        raise SystemExit('ERROR asset was discarded; restore it first: ' + a.asset)
    # R3C-111 begin
    require_slot(a.root, a.asset, a.stage)  # fast refusal before any root write
    # R3C-111 end
    package_io = getattr(a, '_package_commit', None)
    check_ids(a.asset, a.stage)
    meta = parse_meta(a.meta)  # fail before anything is copied
    for f in a.file:  # check every file before a version folder exists
        name = os.path.basename(f)
        if not safe_name(name): raise SystemExit('ERROR bad file name (letters, digits, _ . - only): ' + name)
        if name.lower() in ('review.json', 'review.md', 'review-thumb.png'):  # 2026-10-06: a copied review.json made v3 look already reviewed
            raise SystemExit('ERROR %s belongs to the review tool; submit only your own deliverables' % name)
        if not os.path.isfile(f): raise SystemExit('ERROR file not found: ' + f)
    if len({os.path.basename(f) for f in a.file}) != len(a.file): raise SystemExit('ERROR two files have the same name')
    meta = screenshot_meta(meta, {os.path.basename(f) for f in a.file})
    os.makedirs(a.root, exist_ok=True)  # the first submit creates the review root
    policy = load_policy(a.root)  # owner-managed configuration, never submitted meta
    with tempfile.TemporaryDirectory(prefix='.submit-', dir=a.root) as d:
        cat = catalog(a.root, a.project)
        original_asset = json.loads(json.dumps(cat['assets'].get(a.asset)))
        new_asset = a.asset not in cat['assets']
        asset = cat['assets'].setdefault(a.asset, {'name': a.name or a.asset, 'stages': {}})
        if a.name: asset['name'] = a.name
        if a.route:
            if a.route not in ROUTES: raise SystemExit('ERROR unknown route %s; choose from %s' % (a.route, ', '.join(ROUTES)))
            asset['route'] = a.route
        elif new_asset and a.stage == 'audio': asset['route'] = 'audio'  # a sound skips concept, model, rig...
        elif new_asset and STAGE_GROUP[a.stage] == 'game': asset['route'] = 'game'  # a game item never needs a turnaround or rig
        if a.choice: set_choice(asset, a.choice)  # one of several options for the same question: the owner picks one in the viewer
        if a.category: set_category(asset, a.category)  # review category for the batch view (Heroes, Buildings, UI ...)
        if 'units' not in meta:
            for pv in reversed(asset['stages'].get('brief', {}).get('versions', [])):
                if pv.get('meta', {}).get('units') in ('m', 'stud'): meta['units'] = pv['meta']['units']; break
                for pf in pv['files']:
                    if pf['media'] != 'text': continue
                    with open(os.path.join(vdir(a.root, a.asset, 'brief', pv['v']), pf['name']), encoding='utf-8') as brief: declaration = re.search(r'(?im)^\s*units\s*:\s*(m|stud)\s*$', brief.read())
                    if declaration: meta['units'] = declaration[1]; break
                if 'units' in meta: break
        st = asset['stages'].setdefault(a.stage, {'status': 'none', 'versions': []})
        v = len(st['versions']) + 1
        for f in a.file: shutil.copy2(f, os.path.join(d, os.path.basename(f)))
        files = []  # pre-flight after all copies: a brief checks that its images are in the same version
        for f in a.file:
            name = os.path.basename(f)
            media = MEDIA.get(os.path.splitext(name)[1].lower(), 'other')
            args = (os.path.join(d, name), media, a.stage, dict(meta, kind='doc') if asset.get('route') in ROUTE_GROUP else meta)  # a non-asset route never gets the asset-brief template checks
            # Preserve the legacy call contract when there is no trusted
            # restriction or declared provenance to verify.
            if policy.require_provenance or policy.allowed_licences is not None or 'provenance' in meta:
                checked = preflight(*args, policy)
            else:
                checked = preflight(*args)
            files.append({'name': name, 'media': media, 'bytes': os.path.getsize(f), 'preflight': checked})
            if media == 'model': files[-1]['material_sanity'] = material_sanity(os.path.join(d, name))
            if media == 'video': files[-1].update(video_timing(os.path.join(d, name), meta, decoded=True))
            if media == 'pdf': files[-1]['pages'] = 0
        # Locks add up over versions: every approved note of every reviewed earlier version must survive, compared with the version it was approved on.
        checks = []
        for pv, locks in stage_locks(a.root, a.asset, a.stage, st):
            for c in lock_check(locks, vdir(a.root, a.asset, a.stage, pv), d): checks.append(dict(c, note='v%d:%s' % (pv, c['note'])))
        # Scope: what changed outside the notes of the newest final review (measured here, not reported by the agent).
        last = next((pv['v'] for pv in reversed(st['versions']) if final_review(os.path.join(vdir(a.root, a.asset, a.stage, pv['v']), 'review.json'))), None)
        scope = scope_check(final_review(os.path.join(vdir(a.root, a.asset, a.stage, last), 'review.json'))['notes'], vdir(a.root, a.asset, a.stage, last), d, files) if last else {}
        resp = {}
        for r in a.response or []:
            k, _, t = r.partition('=')
            resp[k.strip()] = t.strip()
        ver = {'v': v, 'files': files, 'note': a.note or '', 'by': a.by, 'at': datetime.datetime.now().astimezone().isoformat(timespec='microseconds'),
               'resolves': [x.strip() for x in (a.resolves or '').split(',') if x.strip()], 'responses': resp, 'meta': meta,
               'lock_check': checks, 'scope_check': scope}
        validators = {f['name']: f['preflight']['validator'] for f in files if 'validator' in f['preflight']}
        if validators: ver['meta']['validator'] = validators
        if a.stage == 'engine':
            ver['meta']['unverified'] = not any(f['media'] == 'image' or f['name'].lower().endswith(('.log', '.txt')) for f in files)
            if ver['meta']['unverified'] and files: files[0]['preflight']['warn'].append('Engine unverified: submit an image or runtime log as evidence')
        prior = [(a.stage, pv) for pv in reversed(st['versions'])]
        if not any(f['media'] == 'model' for _, pv in prior for f in pv['files']):
            route = route_of(asset)
            if a.stage in route:
                prior += [(sid, pv) for sid in reversed(route[:route.index(a.stage)])
                          for pv in reversed(asset['stages'].get(sid, {}).get('versions', []))]
        for f in files:
            if f['media'] != 'model' or not f['preflight']['stats']: continue
            candidates = [(sid, pv, pf) for sid, pv in prior for pf in pv['files'] if pf['media'] == 'model']
            if not candidates: continue
            sid, pv, pf = candidates[0]
            pf = next((x[2] for x in candidates if x[0] == sid and x[1]['v'] == pv['v'] and x[2]['name'] == f['name']), pf)
            previous = pf.get('preflight', {}).get('stats', {})
            if 'vertices' not in previous:
                previous = glb_stats(os.path.join(vdir(a.root, a.asset, sid, pv['v']), pf['name']))
            f['preflight']['stats']['delta'] = model_delta(previous, f['preflight']['stats'], pv['v'], v, sid)
        if EXTENSION is not None: EXTENSION.record_submission(a, asset, ver)
        for name, msg in proof_warnings(a.root, a.stage, a.file): next(f for f in files if f['name'] == name)['preflight']['warn'].append(msg)
        # The gate: hard pre-flight failures go straight back to the agent; the owner never sees a broken version.
        gate = ['%s: %s' % (f['name'], b) for f in files for b in f['preflight'].get('block', [])]
        gate += options_gate(asset, files)
        with FileLock(a.root):
            latest = catalog(a.root, a.project)
            if a.asset in latest.get('binned', {}):
                raise SystemExit('ERROR asset was discarded; restore it first: ' + a.asset)
            # R3C-111 begin
            require_slot(a.root, a.asset, a.stage, cat=latest)  # authoritative publication check
            # R3C-111 end
            if latest['assets'].get(a.asset) != original_asset:
                raise SystemExit('ERROR asset changed during preflight; retry submit: ' + a.asset)
            gate += game_gate(a.root, latest, a.asset, asset, a.stage, d, files, a, ver)
            if gate: ver['gate'] = dict({'blocked': gate}, **({'skipped': a.skip_gate} if a.skip_gate else {}))
            st['versions'].append(ver); st['status'] = 'gate' if gate and not a.skip_gate else 'in_review'
            latest['assets'][a.asset] = asset; cat = latest
            target = vdir(a.root, a.asset, a.stage, v)
            render_plan = None
            if not getattr(a, 'skip_render', False) and os.environ.get('ASSET_REVIEW_RENDER') == '1':
                from auto_render import prepare_enqueue, enqueue
                render_plan = prepare_enqueue(a.root, d, [f['name'] for f in files], target=target)
                if render_plan:
                    job, _, key, _ = render_plan
                    ver['meta']['render'] = dict(hash=key, status=job['status'])
            catalog_text(cat)  # include render metadata before either publication
            if os.path.exists(target): raise SystemExit('ERROR version folder v%03d already exists without a catalog entry; check %s' % (v, os.path.dirname(target)))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if package_io is not None:
                package_io.prepare(original_asset, asset, ver)
            os.rename(d, target); d = target
            if render_plan:
                enqueue(a.root, d, [f['name'] for f in files], prepared=render_plan)
            jsave(os.path.join(a.root, 'catalog.json'), cat)
            event(a.root, type='submit', asset=a.asset, stage=a.stage, v=v, by=a.by, resolves=ver['resolves'], gate=len(gate),
                  **({'event_id': package_io.marker['event_id']} if package_io is not None else {}))
    finish_pdf_pages(a.root, a.project, a.asset, a.stage, v, d, files)
    register(a.root)
    print('SUBMITTED %s/%s v%03d -> %s' % (a.asset, a.stage, v, d))
    if project_id(a.root) in {x['id'] for x in archived_projects()}: print('  NOTE this project is archived and hidden from the reviewer; restore: %s project archive --project %s --restore' % (CLI, project_id(a.root)))
    for f in files:
        if f['preflight']['stats'].get('delta'): print('  ' + f['preflight']['stats']['delta']['line'])
        for w in f['preflight']['warn']: print('  PREFLIGHT %s: %s' % (f['name'], w))
    for c in checks:
        if c['result'] != 'unchanged': print('  LOCK %s %s (%s): %s' % (c['note'], c['target'], c['file'], c['result'].upper()))
    if checks and all(c['result'] == 'unchanged' for c in checks): print('  LOCKS OK: %d locked targets unchanged' % len(checks))
    if scope.get('changed_outside_pct') is not None: print('  SCOPE %s: %.2f%% of pixels outside the notes changed (inside: %.1f%%)' % (scope['file'], scope['changed_outside_pct'], scope['changed_inside_pct']))
    if scope.get('changed_nodes_outside') is not None: print('  SCOPE %s: %d nodes changed, %d outside the notes %s' % (scope['file'], scope['changed_nodes'], len(scope['changed_nodes_outside']), scope['changed_nodes_outside'][:8]))
    if viewer_live(a.root): print('  REVIEW_URL ' + link(a.root, a.asset, a.stage, v))
    else: print('  VIEWER not running for this folder; start it and open the URL it prints: %s serve --root "%s"   (or in the background: %s up --root "%s")' % (CLI, a.root, CLI, a.root))
    pl = start_parts(a.root, d, [f['name'] for f in files], route=asset.get('route')) if getattr(a, 'parts', False) or os.environ.get('ASSET_REVIEW_PARTS') == '1' else PARTS_OFF
    if pl: print('  ' + pl)
    if ver['meta'].get('render'):
        tt = start_renders(d, [f['name'] for f in files])
        if tt: print('  ' + tt)
    for g in gate: print('  GATE %s' % g)
    if gate and not a.skip_gate:
        print('  GATE BLOCKED: the reviewer does not see v%03d. Fix these files and submit again (all files, same names). Only when the check itself is wrong: --skip-gate "why".' % v)
    else:
        next_step = EXTENSION.submission_next(a, ver) if EXTENSION is not None else None
        print('  NEXT: ' + (next_step or 'tell the reviewer, then: ' + CLI + ' wait --root "%s" --asset %s --stage %s' % (a.root, a.asset, a.stage)))
    if a.stage not in route_of(cat['assets'][a.asset]): print('  NOTE stage %s is not in route %s' % (a.stage, cat['assets'][a.asset].get('route', 'full')))


# ---------------- notes (agents read) ----------------
def stage_locks(root, asset, stage, st):
    """[(version, [approved notes])] for every reviewed version of one asset stage; a note set to 'wontfix' releases its lock."""
    out = []
    for pv in st['versions']:
        rv = final_review(os.path.join(vdir(root, asset, stage, pv['v']), 'review.json'))
        locks = [n for n in (rv or {}).get('notes', []) if n.get('verdict') == 'approve' and n.get('status') != 'wontfix']
        if locks: out.append((pv['v'], locks))
    return out


def latest_reviews(root):
    cat = catalog(root)
    for aid, asset in cat['assets'].items():
        for sid in STAGE_IDS:
            st = asset['stages'].get(sid)
            if not st or not st['versions']: continue
            for ver in reversed(st['versions']):
                rv = final_review(os.path.join(vdir(root, aid, sid, ver['v']), 'review.json'))
                if rv:
                    yield aid, sid, ver, st, rv
                    break


def describe(t):
    """One line, whatever the target holds: comment targets come from other people and end up in agent markdown."""
    return ' '.join(_describe(t).split())[:400]


def _describe(t):
    if (t or {}).get('page') is not None:
        return 'page %s, %s' % (t['page'], describe({k: v for k, v in t.items() if k != 'page'}))
    s = (t or {}).get('selector', {})
    k = s.get('type')
    if s.get('live'):  # Website route: made on the live page; the coordinates are those of the screenshot file
        lv, s2 = s['live'], {x: y for x, y in s.items() if x not in ('live', 'label')}
        return '%s, on the live page %s%s%s' % (describe({'selector': s2}), lv.get('path', '/'), (': ' + s['label']) if s.get('label') else '', (' (css %s)' % lv['css']) if lv.get('css') else '')
    at = (' at frame %s' % s['frame']) if s.get('frame') is not None else ''
    if s.get('label') and k in ('polygon', 'rect', 'part', 'sketch'):
        what = {'polygon': 'auto-detected image part', 'rect': 'auto-detected image parts' if s.get('parts2d') else 'region', 'part': '3D part', 'sketch': 'pen drawing'}[k]
        if k == 'polygon' and not s.get('auto'): what = 'shape'
        s2 = dict(s); s2.pop('label'); inner = describe({'selector': s2})
        fixed = (' (the owner renamed it from "%s")' % s['label_auto']) if s.get('label_auto') else ''
        if s.get('unsure'): fixed += ' (low recognition score; check that this is the right part)'
        return '%s "%s"%s (%s)' % (what, s['label'], fixed, inner)
    if k == 'rect':
        out = 'region x%.0f%% y%.0f%% w%.0f%% h%.0f%%' % (s['x'] * 100, s['y'] * 100, s['w'] * 100, s['h'] * 100)
        if s.get('parts2d'): out += ' covering ' + ', '.join(p.get('name', '?') for p in s['parts2d'])
        return out
    if k == 'polygon':
        xs = [p[0] for p in s.get('points', [])] or [0]; ys = [p[1] for p in s.get('points', [])] or [0]
        return 'polygon %d points in region x%.0f%% y%.0f%% w%.0f%% h%.0f%%' % (len(s.get('points', [])), min(xs) * 100, min(ys) * 100, (max(xs) - min(xs)) * 100, (max(ys) - min(ys)) * 100)
    if k == 'stroke': return 'pen drawing (%d points) in region x%.0f%% y%.0f%% w%.0f%% h%.0f%%' % (len(s.get('points', [])), s['x'] * 100, s['y'] * 100, s['w'] * 100, s['h'] * 100)
    if k == 'sketch': return 'pen drawing on the 3D view (saved camera in note.view) over parts ' + ', '.join(p.get('node', '?') for p in s.get('parts', [])) + at
    if k == 'part': return 'parts ' + ', '.join(p.get('node', '?') for p in s.get('parts', [])) + at
    if k == 'point': return ('point at x%.0f%% y%.0f%%%s' % (s['x'] * 100, s['y'] * 100, at)) if 'x' in s else 'surface point near %s%s' % (s.get('node', '?'), at)
    if k == 'time':
        out = 'time %.3f-%.3f s' % (s.get('start', 0), s.get('end', 0))
        if s.get('frame_start') is not None: out += ' frames %s-%s' % (s.get('frame_start'), s.get('frame_end'))
        if s.get('rect'): r = s['rect']; out += ' + %s x%.0f%% y%.0f%% w%.0f%% h%.0f%%%s' % ('pen drawing in region' if s.get('stroke') else 'region', r['x'] * 100, r['y'] * 100, r['w'] * 100, r['h'] * 100, at)
        if s.get('parts'): out += ' parts ' + ', '.join(p.get('node', '?') for p in s['parts'])
        lv = s.get('levels')
        if lv: out += ' (peak %s dBFS, RMS %s dBFS, ~%s LUFS; file ~%s LUFS)' % (lv.get('peak_dbfs'), lv.get('rms_dbfs'), lv.get('lufs_approx'), lv.get('file_lufs_approx'))
        return out
    if k == 'text': return 'text "%s"%s' % (s.get('quote', '')[:60], (' (line %s, chars %s-%s)' % (s['line'], s.get('start'), s.get('end'))) if s.get('line') else '')
    if k == 'whole' and s.get('per_file'): return 'whole file %s' % (t or {}).get('file', '?')
    if k == 'whole' and s.get('label') in ('Whole version', 'Hele versie'): return 'whole version'  # older reviews carry the Dutch label
    return 'whole asset'


def gather(root, asset=None, stage=None):
    out = []
    for aid, sid, ver, st, rv in latest_reviews(root):
        if asset and aid != asset: continue
        if stage and sid != stage: continue
        a = argparse.Namespace(root=root)
        base = os.path.relpath(vdir(a.root, aid, sid, rv['version']), a.root).replace('\\', '/')
        todo = [n for n in rv.get('notes', []) if n.get('verdict') in ('change', 'reject') and n.get('status', 'open') == 'open']
        todo += [dict(f, verdict='change', reopened=True) for f in rv.get('followups', []) if f.get('status') == 'reopened']
        locks = [dict(n, id='v%d:%s' % (pv, n['id'])) for pv, ls in stage_locks(a.root, aid, sid, st) for n in ls]
        verdict = 'unverified' if rv.get('verdict') == 'approved' and ver.get('meta', {}).get('unverified') else rv.get('verdict')
        out.append({'asset': aid, 'stage': sid, 'version': rv['version'], 'verdict': verdict, 'summary': rv.get('summary', ''),
                    'dir': base, 'todo': todo, 'locks': locks, 'checklist': rv.get('checklist', {}), 'latest_version': st['versions'][-1]['v'], 'mandate': EXTENSION.mandate(rv) if EXTENSION is not None else None, 'choice': (rv.get('choice') or {}).get('role'),
                    'lock_check': st['versions'][-1].get('lock_check', []) if st['versions'][-1]['v'] != rv['version'] else []})
    return out


def notes(a):
    out = gather(a.root, a.asset, a.stage)
    if a.json:
        print(json.dumps(out, indent=1, ensure_ascii=False)); return
    if not out: print('No reviews yet.'); return
    for r in out:
        stale = '' if r['latest_version'] == r['version'] else '  (v%03d submitted, not reviewed yet)' % r['latest_version']
        print('## %s / %s v%03d: %s%s' % (r['asset'], r['stage'], r['version'], r['verdict'], stale))
        for c in r.get('lock_check', []):
            if c['result'] != 'unchanged': print('   ! LOCK %s %s in v%03d: %s' % (c['note'], c['target'], r['latest_version'], c['result']))
        if r['summary']: print('   summary: ' + r['summary'])
        for n in r['todo']:
            tag = 'REOPENED ' if n.get('reopened') else ''
            print('   - [ ] %s%s #%s (%s, %s) %s :: %s' % (tag, n.get('id'), n.get('mark', ''), n.get('verdict'), n.get('priority', 'med'), describe(n.get('target')), n.get('text', '')))
            for key in ('crop', 'strip', 'context', 'clip'):
                if n.get(key): print('         %s: %s/%s' % (key, r['dir'], n[key]))
            if n.get('ref'): print('         reference (reviewer: make it look like this): %s/%s' % (r['dir'], n['ref']))
        for n in r['locks']:
            print('   - LOCK %s #%s %s :: %s' % (n.get('id'), n.get('mark', ''), describe(n.get('target')), n.get('text', '')))


def status(a):
    warn_server_versions(a.root)
    cat = catalog(a.root)
    for aid, asset in cat['assets'].items():
        row = []
        for sid in STAGE_IDS:
            if STAGE_GROUP[sid] in ('video', 'sound', 'story') and sid not in route_of(asset) and sid not in asset['stages']: continue
            st = asset['stages'].get(sid)
            row.append('%s:%s' % (sid, (st or {}).get('status', '-') + ('/v%d' % len(st['versions']) if st and st['versions'] else '') + ('/outdated (%s)' % st['stale'] if st and st.get('stale') else '')))
        print('%-24s %s' % (aid, ' '.join(row)))


def archive_cmd(a):
    """Take old work out of the pipeline without deleting it: stage folders and their catalog entries move to <root>/archive/<id>/."""
    arch = os.path.join(a.root, 'archive')
    binning = getattr(a, 'bin', False)
    with EXTENSION.archive_lock(a.root) if EXTENSION is not None and binning else FileLock(a.root):
        cat = catalog(a.root, a.project)
        if a.restore:
            src = os.path.join(arch, a.restore); m = jload(os.path.join(src, 'archive.json'), None) if safe_name(a.restore) else None
            if not m: raise SystemExit('ERROR no archive ' + a.restore)
            asset = cat['assets'].setdefault(m['asset'], dict(m.get('meta') or {'name': m['name']}, stages={}))
            clash = [s for s in m['stages'] if asset['stages'].get(s, {}).get('versions') or os.path.exists(os.path.join(a.root, 'items', m['asset'], s))]
            if clash: raise SystemExit('ERROR back in the pipeline already: %s; archive those first' % ', '.join(clash))
            for s, entry in m['stages'].items():
                os.makedirs(os.path.join(a.root, 'items', m['asset']), exist_ok=True)
                rename_retry(os.path.join(src, s), os.path.join(a.root, 'items', m['asset'], s)); asset['stages'][s] = entry
            if cat.get('binned', {}).get(m['asset']) == a.restore:
                del cat['binned'][m['asset']]
                if EXTENSION is not None: EXTENSION.restore_asset(a.root, a.restore, m)
            jsave(os.path.join(a.root, 'catalog.json'), cat); os.remove(os.path.join(src, 'archive.json')); os.rmdir(src)
            event(a.root, type='restore', asset=m['asset'], stages=list(m['stages']), by=a.by)
            return print('RESTORED %s: %s' % (m['asset'], ', '.join(m['stages'])))
        if not a.asset:
            for d in sorted(os.listdir(arch)) if os.path.isdir(arch) else []:
                m = jload(os.path.join(arch, d, 'archive.json'), None)
                if m: print('%s  %s: %s  (%s)' % (d, m['asset'], ', '.join(m['stages']), m.get('reason', '')))
            return
        asset = cat['assets'].get(a.asset)
        if not asset: raise SystemExit('ERROR unknown asset ' + a.asset)
        stages = [s for s in (a.stage or [s for s in STAGE_IDS if s in asset['stages']]) if s not in (a.keep or [])]
        if not stages or any(s not in asset['stages'] for s in stages): raise SystemExit('ERROR nothing to archive, or a stage is not in the pipeline: %s' % stages)
        aid = '%s-%s' % (datetime.datetime.now().strftime('%Y%m%d-%H%M%S'), a.asset); dst = os.path.join(arch, aid); os.makedirs(dst)
        manifest = {'asset': a.asset, 'name': asset['name'], 'meta': {k: v for k, v in asset.items() if k != 'stages'}, 'stages': {s: asset['stages'][s] for s in stages}, 'reason': a.reason or '', 'by': a.by, 'at': now()}
        manifest_path = os.path.join(dst, 'archive.json')
        extra = contextlib.nullcontext()
        if EXTENSION is not None and binning:
            extra = EXTENSION.archive_asset(a.root, aid, manifest, manifest_path)
        else:
            jsave(manifest_path, manifest)
        with extra:
            moved = []
            stop_jobs(os.path.join(a.root, 'items', a.asset))
            try:
                for s in stages:
                    src = os.path.join(a.root, 'items', a.asset, s)
                    if os.path.isdir(src): rename_retry(src, os.path.join(dst, s)); moved.append(s)
            except OSError as e:  # a background job may still have a file open (especially on Windows)
                for s in moved: os.rename(os.path.join(dst, s), os.path.join(a.root, 'items', a.asset, s))
                shutil.rmtree(dst, ignore_errors=True)
                raise SystemExit('ERROR %s is still in use (%s); try again shortly' % (a.asset, e.strerror or e))
        for s in stages: del asset['stages'][s]
        if not asset['stages']:
            del cat['assets'][a.asset]
            try: os.rmdir(os.path.join(a.root, 'items', a.asset))
            except OSError: pass  # other files left in the asset folder stay where they are
        if binning: cat.setdefault('binned', {})[a.asset] = aid
        jsave(os.path.join(a.root, 'catalog.json'), cat)
        event(a.root, type='archive', asset=a.asset, stages=stages, reason=a.reason or '', by=a.by, archive=aid)
    print('ARCHIVED %s: %s -> %s' % (a.asset, ', '.join(stages), dst))
    return aid


def rename_retry(src, dst, tries=6):
    """Atomic folder move inside the review root; Windows refuses while a file inside is open, so wait briefly instead of half-copying."""
    for i in range(tries):
        try: return os.rename(src, dst)
        except PermissionError:
            if i == tries - 1: raise
            time.sleep(0.5)


def stop_jobs(folder):
    """Background part recognition (about 20 s per image) and GLB turntables keep files open inside a fresh version; Windows then refuses the move.
    Work out of the pipeline needs neither, so stop the jobs whose command line points into this asset folder."""
    try: import psutil
    except ImportError: return 0
    key = os.path.normcase(os.path.abspath(folder)) + os.sep; hit = []
    for p in psutil.process_iter(['cmdline']):
        try:
            if p.pid != os.getpid() and any(os.path.normcase(os.path.abspath(c)).startswith(key) for c in p.info['cmdline'] or [] if c and not c.startswith('-')):
                p.kill(); hit.append(p)
        except (psutil.Error, ValueError, OSError): pass
    psutil.wait_procs(hit, timeout=5)
    return len(hit)


def bin_asset(root, project, body, by, restore=False):
    """Weggooien in the viewer: the whole asset moves to the archive (never deleted), so no agent picks it up again. Undo restores it."""
    rid = str(body.get('archive') or '')
    if restore and not SAFE.match(rid): raise ValueError('Unknown archive')
    reason = ' '.join(str(body.get('reason') or '').split())[:4000]
    if not restore and not reason: raise ValueError('Give a reason to discard')
    a = argparse.Namespace(root=root, project=project, restore=rid if restore else None, asset=None if restore else str(body.get('asset') or ''),
                           stage=None, keep=None, reason='Discarded by %s%s' % (by, ': ' + reason if reason else ''), by=by, bin=True)
    if not restore and not a.asset: raise ValueError('No asset selected')
    try: aid = archive_cmd(a)
    except SystemExit as e: raise ValueError(str(e.code).replace('ERROR ', ''))
    except OSError as e: raise ValueError('Restore failed: %s' % (e.strerror or e))
    return {'ok': True, 'archive': rid if restore else aid}


# ---------------- agent helpers: next / wait / link / events / up ----------------
def waiting(root, cat=None):
    """Newest versions without a final review: the owner's turn. Oldest first."""
    if cat is None: cat = catalog(root)
    out = []
    for aid, asset in cat['assets'].items():
        for sid in STAGE_IDS:
            st = asset['stages'].get(sid)
            if not st or not st['versions'] or st.get('status') == 'gate': continue  # held at the gate: the agent's turn
            ver = st['versions'][-1]
            if not final_review(os.path.join(vdir(root, aid, sid, ver['v']), 'review.json')):
                draft = os.path.exists(os.path.join(vdir(root, aid, sid, ver['v']), 'review.json'))
                out.append({'asset': aid, 'stage': sid, 'version': ver['v'], 'at': ver.get('at'), 'by': ver.get('by'), 'draft_in_progress': draft, 'url': link(root, aid, sid, ver['v'])})
    return sorted(out, key=lambda x: x['at'] or '')


def next_cmd(a):
    fix, progress = [], []
    for aid, asset in catalog(a.root)['assets'].items():  # versions held at the gate come first: nobody else can move them
        if asset.get('route') == 'game':
            open_stages = [s for s in route_of(asset) if not stage_approved(asset['stages'].get(s))]
            if open_stages: progress.append({'asset': aid, 'stage': open_stages[0], 'open': open_stages})
        for sid, st in asset['stages'].items():
            if st.get('stale'):
                fix.append({'asset': aid, 'stage': sid, 'version': st['versions'][-1]['v'], 'open': 0, 'urgent': 0, 'locks': 0,
                            'stale': st['stale'], 'task': 'resubmit after checking the current manifest assets: ' + st['stale']})
            if st.get('status') == 'gate' and st.get('versions'):
                ver = st['versions'][-1]
                fix.append({'asset': aid, 'stage': sid, 'version': ver['v'], 'open': len(ver['gate']['blocked']), 'urgent': 99, 'locks': 0, 'gate': ver['gate']['blocked'],
                            'task': 'fix the gate problems, then submit all files again: ' + '; '.join(ver['gate']['blocked'])})
    for r in gather(a.root):
        if r['latest_version'] != r['version']: continue  # newer version already waits for review
        # a quick Improve/Reject sends work back without notes; an option that lost a choice asks nothing
        why = {'changes': (r['mandate'] or [''])[0] or r['summary'], 'rejected': r['summary'] or 'rejected', 'unverified': 'runtime evidence required: submit again with an image or runtime log'}.get(r['verdict'] if r['choice'] != 'not_chosen' else None)
        if not r['todo'] and why is None: continue
        hi = sum(1 for n in r['todo'] if n.get('priority') == 'high' or n.get('reopened'))
        fix.append({'asset': r['asset'], 'stage': r['stage'], 'version': r['version'], 'open': len(r['todo']), 'urgent': hi, 'locks': len(r['locks']), 'verdict': r['verdict'], 'why': ' '.join((why or '').split())[:200],
                    'task': CLI + ' task --root %s --asset %s --stage %s' % (a.root, r['asset'], r['stage'])})
    fix.sort(key=lambda x: (-x['urgent'], -x['open']))
    wait = waiting(a.root)
    if a.json: print(json.dumps({'fix': fix, 'wait': wait, 'next': progress}, indent=1, ensure_ascii=False)); return
    if fix:
        f = fix[0]
        if f.get('gate'): print('NEXT gate %s/%s v%03d: %s' % (f['asset'], f['stage'], f['version'], f['task']))
        elif f.get('stale'): print('NEXT outdated %s/%s v%03d: %s' % (f['asset'], f['stage'], f['version'], f['task']))
        else:
            print('NEXT fix %s/%s v%03d: %d open notes (%d urgent), %d locks to keep.' % (f['asset'], f['stage'], f['version'], f['open'], f['urgent'], f['locks']))
            if not f['open']: print('  Reviewer: %s%s' % (f['verdict'], ': ' + f['why'] if f['why'] else ', no notes: improve it against the brief'))
            print('  do:    ' + f['task'] + '   # writes TASK.md with paths, notes, locks and the exact submit + wait commands')
        for f in fix[1:6]: print('  then:  %s/%s v%03d (%s)' % (f['asset'], f['stage'], f['version'], '%d open' % f['open'] if f['open'] or 'verdict' not in f else f['verdict']))
    if wait:
        w = wait[0]
        print('%s %d version(s) wait for the reviewer; oldest %s/%s v%03d%s: %s' % ('ALSO' if fix else 'WAIT', len(wait), w['asset'], w['stage'], w['version'], ' (draft review in progress)' if w['draft_in_progress'] else '', w['url']))
        if not fix: print('  block until reviewed: ' + CLI + ' wait --root %s --asset %s --stage %s' % (a.root, w['asset'], w['stage']))
    if progress:
        for item in progress: print('OPEN %s: %s; next %s' % (item['asset'], ', '.join(item['open']), item['stage']))
    if not fix and not wait and not progress: print('IDLE nothing to fix and nothing waits for review.')


def wait_cmd(a):
    cat = catalog(a.root)
    st = cat['assets'].get(a.asset, {}).get('stages', {}).get(a.stage)
    if not st or not st.get('versions'): raise SystemExit('ERROR no versions for %s/%s' % (a.asset, a.stage))
    v = a.v or st['versions'][-1]['v']
    path = os.path.join(vdir(a.root, a.asset, a.stage, v), 'review.json')
    def report():
        ver = next(x for x in catalog(a.root)['assets'][a.asset]['stages'][a.stage]['versions'] if x['v'] == v)
        verdict = final_review(path).get('verdict')
        unverified = verdict == 'approved' and ver.get('meta', {}).get('unverified')
        print('%s %s/%s v%03d: %s' % ('UNVERIFIED' if unverified else 'REVIEWED', a.asset, a.stage, v, 'runtime evidence required' if unverified else verdict))
        return notes(argparse.Namespace(root=a.root, asset=a.asset, stage=a.stage, json=a.json))
    if final_review(path) and not a.new:
        return report()
    start = os.path.getmtime(path) if os.path.exists(path) else 0
    print('WAITING for the reviewer on %s/%s v%03d, up to %d s: %s' % (a.asset, a.stage, v, a.timeout, link(a.root, a.asset, a.stage, v)), flush=True)
    end = time.time() + a.timeout
    while time.time() < end:
        if os.path.exists(path) and os.path.getmtime(path) > start and final_review(path):
            settled = os.path.getmtime(path)  # the owner can undo a decision for a few seconds: start only when it stayed final
            while time.time() < end and time.time() - settled < SETTLE:
                time.sleep(1)
                if not final_review(path): break
                if os.path.getmtime(path) != settled: settled = os.path.getmtime(path)
            if not final_review(path): continue
            return report()
        time.sleep(a.interval)
    print('TIMEOUT no final review after %d s. Ask the reviewer or run wait again.' % a.timeout); sys.exit(3)


def link_cmd(a):
    if a.remote:
        cfg = jload(os.path.join(a.root, '.remote.json'), None)
        if not cfg: raise SystemExit('ERROR remote is off; run: ' + CLI + ' remote --root %s on --allow <device>' % a.root)
        host = ts_status()['Self']['DNSName'].rstrip('.')
        print('https://%s:%d/?p=%s#a=%s%s%s' % (host, cfg['https_port'], project_id(a.root), a.asset, '&s=' + a.stage if a.stage else '', '&v=%d' % a.v if a.v else '')); return
    print(link(a.root, a.asset, a.stage, a.v))


def events_cmd(a):
    try:
        lines = open(os.path.join(a.root, 'events.jsonl'), encoding='utf-8').read().splitlines()
    except FileNotFoundError:
        lines = []
    evs = [json.loads(x) for x in lines if x.strip()]
    if a.since: evs = [e for e in evs if e.get('at', '') > a.since]
    evs = evs[-a.last:]
    if a.json: print(json.dumps(evs, indent=1, ensure_ascii=False)); return
    for e in evs: print('%s %-6s %s/%s v%03d %s' % (e['at'], e['type'], e['asset'], e['stage'], e['v'], e.get('verdict') or e.get('by') or ''))


def server_port(root, recover=False, preferred=None):
    """Find this root's listener; only up may repair lost operational metadata."""
    path = os.path.join(root, '.server.json')
    info = jload(path, None) or {}
    ports = [info.get('port', 4780), preferred]
    if recover: ports += list(range(preferred or 4780, (preferred or 4780) + PORT_SPAN))
    expected = os.path.normcase(os.path.abspath(root))
    deadline = time.monotonic() + 5 if recover else None
    uncertain = False
    for port in dict.fromkeys(ports):
        if type(port) is not int or not 0 < port < 65536: continue
        if recover and time.monotonic() >= deadline:
            raise SystemExit('ERROR viewer discovery exceeded 5 seconds; no duplicate started')
        if recover and port_free(port): continue  # nothing listens here; on Windows a refused localhost connect waits for the full timeout
        try:
            timeout = min(0.15, max(0.001, deadline - time.monotonic())) if recover else 0.4
            with urllib.request.urlopen('http://127.0.0.1:%d/api/info' % port, timeout=timeout) as r:
                j = json.loads(r.read())
            if not isinstance(j, dict) or j.get('schema') != 'asset-review/1' or not isinstance(j.get('root'), str): continue
            if os.path.normcase(os.path.abspath(j['root'])) != expected: continue
            if type(j.get('pid')) is not int or j['pid'] <= 0: continue
            if recover and (info.get('port') != port or info.get('pid') != j['pid']):
                recovered = {k: j[k] for k in ('started', 'created', 'code_hash') if k in j}
                recovered.update(port=port, pid=j['pid'])
                try: jsave(path, recovered)
                except Exception as e:
                    raise SystemExit('ERROR viewer found but metadata repair failed; no duplicate started: %s' % e) from e
            return port
        except Exception as e:
            if isinstance(e, TimeoutError) or isinstance(getattr(e, 'reason', None), TimeoutError): uncertain = True
            continue
    if recover and uncertain:
        raise SystemExit('ERROR a listener timed out during discovery; no duplicate started')
    return None


PORT_SPAN = 60  # 4780-4839; 4840 and up belong to other local sites


def up(a):
    root = os.path.abspath(a.root)
    if any(row['id'] == project_id(root) for row in archived_projects()):
        raise SystemExit('ERROR archived project: open its history through an existing viewer with ?p=<project id>, or restore it explicitly; no viewer started')
    os.makedirs(root, exist_ok=True)
    register(root)
    if os.path.exists(HUB_ON): return up_hub(a, root)
    port = server_port(root, recover=True, preferred=a.port)
    if not port:
        info = jload(os.path.join(root, '.server.json'), None) or {}
        if info.get('pid') and pid_alive(info['pid'], None, info.get('created')):
            raise SystemExit('ERROR recorded viewer PID is still alive but /api/info is unavailable; no duplicate started. Verify the process before an authorized restart.')
        # Several projects run their own server: keep this root's last port, else take the first free one from --port up.
        last = (jload(os.path.join(root, '.server.json'), None) or {}).get('port')
        port = next((p for p in dict.fromkeys([last] + list(range(a.port, a.port + PORT_SPAN))) if p and port_free(p)), None)
        if not port:
            print('ERROR no free port in %d-%d' % (a.port, a.port + PORT_SPAN - 1)); sys.exit(1)
        launch_server(root, port, a.project)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            time.sleep(0.25)
            if server_port(root): break
        else:
            print('ERROR the server did not start (port %d busy?). Log: %s' % (port, os.path.join(root, '.server.log'))); sys.exit(1)
    follow_remote(root, port)
    print('UP http://127.0.0.1:%d/' % port)


def launch_server(root, port, project=None, hub=None):
    args = [sys.executable, os.path.abspath(__file__), 'serve', '--root', root, '--port', str(port)] + (['--project', project] if project else []) + (['--hub', str(hub)] if hub else [])
    log_path = os.path.join(root, '.server.log')
    if not spawn_outside_job(args, log_path, root):
        flags = (0x00000008 | 0x00000200) if os.name == 'nt' else 0  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(args, stdout=open(log_path, 'ab'), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True)


# ---------------- hub: one viewer process for every project ----------------
# Off unless hub.on exists next to projects.json. The hub is an ordinary viewer of its first project that also listens for every other live
# project: on that project's recorded port, else on the first free one. Local links, tailnet mappings, .remote.json rules and the watchdog
# therefore keep working unchanged. A project that finds no free port is served as ?p=<id> on the hub port, so a full range never blocks a start.
HUB_ON = os.path.join(os.path.dirname(PROJECTS), 'hub.on')
HUB_DIR = os.path.join(os.path.dirname(PROJECTS), '.hub')


def hub_info():
    """/api/info of the live hub, or None. The record must name a live process that answers on its port."""
    rec = jload(os.path.join(HUB_DIR, 'hub.json'), None) or {}
    if type(rec.get('port')) is not int or not pid_alive(rec.get('pid'), None, rec.get('created')): return None
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/api/info' % rec['port'], timeout=2) as r: j = json.loads(r.read())
    except Exception: return None
    return j if isinstance(j, dict) and j.get('schema') == 'asset-review/1' and j.get('pid') == rec['pid'] else None


def up_hub(a, root):
    """Join the live hub, or start it with this root as its home. Never starts a second process for a root that is already served."""
    port = server_port(root, recover=True, preferred=a.port)  # served already: by the hub, or by a separate viewer from before the switch
    if not port:
        if not os.path.exists(os.path.join(root, 'catalog.json')):  # the hub only serves roots that have a catalog
            os.makedirs(os.path.join(root, 'items'), exist_ok=True); jsave(os.path.join(root, 'catalog.json'), catalog(root, a.project))
        os.makedirs(HUB_DIR, exist_ok=True)
        with FileLock(HUB_DIR):  # two chats running up at the same moment start one hub
            hub = hub_info()
            if not hub:
                last = (jload(os.path.join(root, '.server.json'), None) or {}).get('port')
                first = next((p for p in dict.fromkeys([last] + list(range(a.port, a.port + PORT_SPAN))) if p and port_free(p)), None)
                if not first:
                    print('ERROR no free port in %d-%d' % (a.port, a.port + PORT_SPAN - 1)); sys.exit(1)
                launch_server(root, first, a.project, hub=a.port)
                deadline = time.monotonic() + 15
                while not hub and time.monotonic() < deadline: time.sleep(0.25); hub = hub_info()
                if not hub:
                    print('ERROR the hub did not start. Log: %s' % os.path.join(root, '.server.log')); sys.exit(1)
        deadline = time.monotonic() + 15  # the hub follows the registry and picks this root up within seconds
        while not port:
            port = server_port(root)
            info = jload(os.path.join(root, '.server.json'), None) or {}
            if not port and info.get('hub') and (info.get('pid'), info.get('created')) == (hub['pid'], hub.get('created')):
                print('UP ' + home_url(root)); return
            if not port and time.monotonic() > deadline:
                print('ERROR the hub does not serve %s. Log: %s' % (root, os.path.join(hub.get('home') or root, '.server.log'))); sys.exit(1)
            if not port: time.sleep(0.25)
    follow_remote(root, port)
    print('UP http://127.0.0.1:%d/' % port)


def hub_listen(main, home, base):
    """Thread inside the hub: gives every other live project its listener, and keeps following the registry, so a project that registers later,
    or whose separate viewer stops, joins within seconds."""
    os.makedirs(HUB_DIR, exist_ok=True)
    jsave(os.path.join(HUB_DIR, 'hub.json'), dict(main.review_identity, home=home))
    def recorded(r):
        try: return (jload(os.path.join(r, '.server.json'), None) or {}).get('port')
        except ValueError: return None
    served = set()
    while True:
        try:
            hidden = {row['id'] for row in archived_projects()}
            rest = {r: recorded(r) for r in map(os.path.abspath, other_roots(home)) if os.path.normcase(r) not in served and project_id(r) not in hidden}
        except Exception as e: rest = {}; print('HUB registry error: %s' % e, file=sys.stderr, flush=True)
        for r, own in rest.items():
            try:
                if type(own) is int and not port_free(own) and server_port(r): continue  # its separate viewer still runs; take over when it stops
                extra = None
                for port in dict.fromkeys([own] + [p for p in range(base, base + PORT_SPAN) if p not in rest.values()]):  # never another project's recorded port
                    if type(port) is not int or not 0 < port < 65536 or not port_free(port): continue
                    try: extra = Server(('127.0.0.1', port), type('ProjectHandler', (Handler,), {'home': r, 'project': None})); break
                    except OSError: continue
                if extra:
                    extra.review_identity = dict(main.review_identity, port=port)
                    threading.Thread(target=extra.serve_forever, name='cutdesk-port-%d' % port, daemon=True).start()
                jsave(os.path.join(r, '.server.json'), extra.review_identity if extra else dict(main.review_identity, hub=True))
                served.add(os.path.normcase(r))
                print('HUB %s -> %s' % (r, ':%d' % port if extra else '?p=%s (no free port)' % project_id(r)), flush=True)
                if os.environ.get('ASSET_REVIEW_RENDER') == '1':
                    from auto_render import start_worker
                    start_worker(r)
            except (Exception, SystemExit) as e: print('HUB error in %s: %s' % (r, e), file=sys.stderr, flush=True)
        time.sleep(2)


def spawn_outside_job(args, log_path, cwd):
    """Windows: launch through WMI so closing the caller does not stop the server.
    WMI does not inherit this environment, so preserve ASSET_REVIEW_* overrides with plain Popen."""
    if os.name != 'nt' or any(k.startswith('ASSET_REVIEW_') and k != 'ASSET_REVIEW_ROOT' for k in os.environ): return False
    exe = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
    cmd = subprocess.list2cmdline([exe if os.path.exists(exe) else sys.executable] + args[1:] + ['--log', log_path])
    ps = ("$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:AR_CMD; CurrentDirectory=$env:AR_CWD}; "
          "exit $r.ReturnValue")
    try:
        r = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], env=dict(os.environ, AR_CMD=cmd, AR_CWD=cwd),
                           capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=20)
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        raise SystemExit('ERROR WMI launch outcome is uncertain; no fallback process started. Check /api/info or retry up after the existing launch settles.')
    except OSError:
        return False


def port_free(port):
    s = socket.socket()
    try:
        s.bind(('127.0.0.1', port)); return True
    except OSError:
        return False
    finally:
        s.close()


def follow_remote(root, port):
    """A root with remote viewing keeps its tailnet URL when the server comes back on another port."""
    cfg = jload(os.path.join(root, '.remote.json'), None)
    if not cfg: return
    if cfg.get('root') and os.path.normcase(os.path.abspath(cfg['root'])) != os.path.normcase(os.path.abspath(root)):
        print('REMOTE skipped: .remote.json belongs to %s (copied root?)' % cfg['root']); return
    try:
        owner = serve_owner(cfg['https_port'], strict=True)
    except (ValueError, subprocess.TimeoutExpired):
        print('REMOTE skipped: ownership is unknown; existing mapping left unresolved')
        return
    if owner and os.path.normcase(os.path.abspath(owner)) != os.path.normcase(os.path.abspath(root)):
        print('REMOTE skipped: :%d serves %s (copied .remote.json?)' % (cfg['https_port'], owner)); return
    # R3C-095 begin
    try:
        host = ts_status()['Self']['DNSName'].rstrip('.').lower()
        if not host: raise ValueError('missing Serve DNS name')
    except (OSError, ValueError, KeyError, SystemExit):
        remote_upgrade_warning()
        return
    # R3C-095 end
    try:
        r = subprocess.run(['tailscale', 'serve', '--bg', '--https=%d' % cfg['https_port'], 'http://127.0.0.1:%d' % port], capture_output=True, text=True,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=5)
        print('REMOTE :%d -> %d %s' % (cfg['https_port'], port, 'ok' if r.returncode == 0 else 'FAILED ' + (r.stderr or r.stdout).strip()))
        # R3C-095 begin
        if r.returncode == 0:
            cfg['serve_host'] = host
            jsave(os.path.join(root, '.remote.json'), cfg)
        else:
            remote_upgrade_warning()
        # R3C-095 end
    except (FileNotFoundError, subprocess.TimeoutExpired):
        print('REMOTE skipped: tailscale not found or mapping timed out; verify the existing mapping before retrying')
        remote_upgrade_warning()


def serve_owner(https_port, strict=False):
    """Root currently served by this tailnet port; strict recovery fails closed on unknown ownership."""
    try:
        result = subprocess.run(['tailscale', 'serve', 'status', '--json'], capture_output=True, text=True,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=5)
        if result.returncode != 0: raise ValueError('Serve status failed')
        st = json.loads(result.stdout)
        if not isinstance(st, dict) or not isinstance(st.get('Web', {}), dict): raise ValueError('Invalid Serve status')
        proxy = next((h['Proxy'] for k, w in st.get('Web', {}).items() if k.endswith(':%d' % https_port)
                      for h in (w.get('Handlers') or {}).values() if h.get('Proxy')), None)
        if proxy is None: return None  # a successful status response says this port has no proxy
        with urllib.request.urlopen(proxy.rstrip('/') + '/api/info', timeout=2) as r:
            info = json.loads(r.read())
        if not isinstance(info, dict) or info.get('schema') != 'asset-review/1' or not isinstance(info.get('root'), str) or not info['root']:
            raise ValueError('Proxy owner could not be identified')
        return info['root']
    except Exception as e:
        if strict: raise ValueError('Tailnet port ownership is unknown') from e
        return None


class Conflict(ValueError):
    def __init__(self, current): self.current = current


def comments(d):
    folder = os.path.join(d, 'comments')
    if not getattr(READ_CACHE_POLICY, 'enabled', True):
        return {'people': {os.path.basename(p)[:-5]: jload(p, {}) for p in sorted(glob.glob(os.path.join(folder, '*.json')))}}
    return {'people': {n[:-5]: jload_cached(os.path.join(folder, n), {}) for n in directory_names(folder) or ()
                       if not n.startswith('.') and os.path.normcase(n).endswith('.json')}}


def seen_path(root, person): return os.path.join(root, 'seen', re.sub(r'[^A-Za-z0-9_.-]', '_', person) + '.json')


def mark_seen(root, person, body):
    """'Bekeken' per version and per person, apart from decision and comments: <root>/seen/<person>.json holds only that person's own status."""
    a, s, v = body['asset'], body['stage'], int(body['version']); check_ids(a, s, v)
    st = catalog(root)['assets'].get(a, {}).get('stages', {}).get(s)
    if not st or not any(x['v'] == v for x in st.get('versions', [])): raise ValueError('unknown version')
    path = seen_path(root, person)
    with FileLock(root):
        rows = jload(path, {})
        rows.setdefault('%s/%s/%d' % (a, s, v), now()); jsave(path, rows)
    return {'seen': True}


def feedback_ask(root, body, person):
    """An owner who is not the admin asks the admin for feedback on one version. Asking again replaces the question under a new rev."""
    a, s, v = body['asset'], body['stage'], int(body['version']); check_ids(a, s, v)
    text = str(body.get('text') or '').strip()
    if len(text) > 500: raise ValueError('500 characters max')
    if not os.path.isdir(vdir(root, a, s, v)): raise ValueError('Version does not exist')
    path = os.path.join(vdir(root, a, s, v), 'feedback.json')
    with FileLock(root):
        doc = dict(by=person['person'], name=person['name'], at=now(), text=text, status='open', rev=jload(path, {}).get('rev', 0) + 1)
        jsave(path, doc)
    return doc


def feedback_done(root, body):
    a, s, v = body['asset'], body['stage'], int(body['version']); check_ids(a, s, v)
    path = os.path.join(vdir(root, a, s, v), 'feedback.json')
    with FileLock(root):
        doc = jload(path, None)
        if not doc or doc.get('status') != 'open': raise ValueError('No open feedback request')
        if body.get('rev') != doc.get('rev', 0): raise Conflict(doc)  # the owner changed their question after the admin opened it
        doc.update(status='done', done_at=now()); jsave(path, doc)
    return doc


def save_comment(root, body, person):
    a, s, v = body['asset'], body['stage'], int(body['version']); check_ids(a, s, v)
    d = vdir(root, a, s, v); pid = person['person']
    if not os.path.isdir(d): raise ValueError('Version does not exist')
    if not safe_name(pid): raise ValueError('Invalid person')
    rows = body.get('comments')
    if not isinstance(rows, list) or any(not isinstance(n, dict) or not re.fullmatch(r'C\d{1,4}', str(n.get('id', ''))) for n in rows): raise ValueError('Invalid notes')
    if len({n['id'] for n in rows}) != len(rows): raise ValueError('Duplicate note')
    if any('cid' in n and not (isinstance(n['cid'], str) and re.fullmatch(r'[A-Za-z0-9-]{1,64}', n['cid'])) for n in rows): raise ValueError('Invalid notes')
    pattern = r'crops/' + re.escape(pid) + r'/[A-Za-z0-9_.-]+\.(png|jpg|wav)'
    voice_pattern = r'voice/' + re.escape(pid) + r'/C\d{1,4}\.(webm|ogg)'
    files = {}
    for rel, data in (body.get('files') or {}).items():
        if not re.fullmatch(pattern, rel) and not re.fullmatch(voice_pattern, rel): raise ValueError('Only your own attachments are allowed')
        if rel.startswith('voice/') and (len(data) > 3 * 1024 * 1024 or not re.fullmatch(r'data:audio/(webm|ogg)(;codecs=[\w,.-]+)?;base64,[A-Za-z0-9+/=]+', data)): raise ValueError('Invalid recording')
        files[rel] = base64.b64decode(data.split(',', 1)[1], validate=True)
        if rel.startswith('voice/') and len(files[rel]) > 2 * 1024 * 1024: raise ValueError('Recording too large: 2 MB max')
    for n in rows:
        for key in ('crop', 'ref', 'voice'):
            if n.get(key) and not re.fullmatch(voice_pattern if key == 'voice' else pattern, n[key]): raise ValueError('Only your own attachments are allowed')
    with FileLock(root):
        path = os.path.join(d, 'comments', pid + '.json'); current = jload(path, {'rev': 0, 'comments': []})
        if type(body.get('base_rev')) is not int or body['base_rev'] != current['rev']: raise Conflict(current)
        previous = {n['id']: n for n in current['comments']}; saved = []
        for n in rows:
            old = previous.get(n['id'], {})
            if old.get('status', 'open') != 'open': saved.append(old); continue
            row = {k: n[k] for k in ('id', 'cid', 'mark', 'text', 'target', 'view', 'crop', 'ref', 'voice', 'at') if k in n}
            row.update(status='open', adopted_as=None, by_status=None); row.setdefault('at', now()); saved.append(row)
        saved += [n for n in previous.values() if n.get('status', 'open') != 'open' and n['id'] not in {r['id'] for r in saved}]
        doc = dict(schema='asset-review/comments-1', asset=a, stage=s, version=v, person=pid, name=person['name'], rev=current['rev'] + 1, updated=now(), comments=saved)
        for rel, raw in files.items():
            # Resolved comments cannot have their evidence overwritten by their author.
            if any(n.get('status') != 'open' and rel in [n.get(k) for k in ('crop', 'ref', 'voice')] for n in saved): continue
            path2 = os.path.join(d, rel); os.makedirs(os.path.dirname(path2), exist_ok=True)
            with open(path2, 'wb') as f: f.write(raw)
        jsave(path, doc)
    return doc


def comment_status(root, body, by):
    a, s, v, pid = body['asset'], body['stage'], int(body['version']), body['person']; check_ids(a, s, v)
    if not safe_name(pid) or body['status'] not in ('open', 'adopted', 'dismissed'): raise ValueError('Invalid status')
    with FileLock(root):
        path = os.path.join(vdir(root, a, s, v), 'comments', pid + '.json'); doc = jload(path, {})
        row = next((n for n in doc.get('comments', []) if n['id'] == body['id']), None)
        if row is None: raise ValueError('Note not found')
        row.update(status=body['status'], adopted_as=body.get('adopted_as') if body['status'] == 'adopted' else None, by_status=by)
        row.pop('reason', None)
        reason = ' '.join(str(body.get('reason') or '').split())[:200]  # one line, only with Negeer; the commenter sees it
        if body['status'] == 'dismissed' and reason: row['reason'] = reason
        doc.update(rev=doc['rev'] + 1, updated=now()); jsave(path, doc)
    return doc


def viewer_review(rv):
    if rv is not None and EXTENSION is None:
        rv.pop('auto', None)
    return rv


def write_review(root, rv, project=None, base_rev=None, files=None):
    """Store a review and update its catalog status and activity event."""
    a, s, v = rv['asset'], rv['stage'], int(rv['version'])
    if base_rev is not None and type(base_rev) is not int: raise ValueError('base_rev must be an integer')
    d = vdir(root, a, s, v)
    rv['updated'] = now(); rv['schema'] = 'asset-review/1'
    md = review_md(rv, a)  # render first: a note the text cannot describe must fail before anything is written
    with FileLock(root):
        was = jload(os.path.join(d, 'review.json'), None) or {}
        if base_rev is not None and base_rev != was.get('rev', 0): raise Conflict(viewer_review(was or None))
        if EXTENSION is not None:
            EXTENSION.normalize_review(rv)
        else:
            rv.pop('auto', None)
            if 'auto' in was: rv['auto'] = was['auto']
        rv['rev'] = was.get('rev', 0) + 1
        for rel, raw in (files or {}).items():
            os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
            with open(os.path.join(d, rel), 'wb') as f: f.write(raw)
        jsave(os.path.join(d, 'review.json'), rv)
        cat = catalog(root, project)
        asset = cat['assets'][a]; st = asset['stages'][s]
        md = review_md(rv, asset.get('name', a))
        if v == st['versions'][-1]['v']: st['status'] = stage_status(rv)
        if rv.get('draft'): st['versions'][v - 1].pop('reviewed', None)
        else: st['versions'][v - 1]['reviewed'] = rv.get('verdict')
        jsave(os.path.join(root, 'catalog.json'), cat)
        with open(os.path.join(d, 'REVIEW.md'), 'w', encoding='utf-8', newline='\n') as f: f.write(md)
        if not (rv.get('draft') and was.get('draft')):  # the viewer autosaves drafts; log only the first one
            event(root, type='draft' if rv.get('draft') else 'review', asset=a, stage=s, v=v, verdict=rv.get('verdict'), by=rv.get('reviewer'), notes=len(rv.get('notes', [])), via=rv.get('via') or rv.get('source'))


# ---------------- remote (Tailscale Serve, tailnet only), verdicts, task files ----------------
def ts_status():
    out = subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if out.returncode: raise SystemExit('ERROR tailscale status failed: ' + out.stderr.strip())
    return json.loads(out.stdout)


# R3C-095 begin
def remote_upgrade_warning():
    print('WARNING: remote host is missing or changed; after an update or DNS change, run `remote on` again to restore phone review.')
# R3C-095 end


def remote(a):
    root = os.path.abspath(a.root); cfg_path = os.path.join(root, '.remote.json')
    cfg = jload(cfg_path, None) or {'https_port': a.https_port, 'allow': {}}
    if a.action in ('on', 'off') and cfg.get('root') and os.path.normcase(os.path.abspath(cfg['root'])) != os.path.normcase(root):
        raise SystemExit('ERROR .remote.json belongs to %s (copied root?); delete it here before turning remote %s' % (cfg['root'], a.action))
    port = (jload(os.path.join(root, '.server.json'), None) or {}).get('port', 4780)
    if a.action == 'on' and (jload(os.path.join(root, '.server.json'), None) or {}).get('hub'):
        raise SystemExit('ERROR this project has no port of its own (the hub serves it as ?p=); free a port in 4780-4839, restart the hub, then turn remote on')
    if a.action == 'off':
        subprocess.run(['tailscale', 'serve', '--https=%d' % cfg['https_port'], 'off'], capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        print('REMOTE off (tailnet listener %d removed; local viewer still runs)' % cfg['https_port']); return
    st = ts_status(); host = st['Self']['DNSName'].rstrip('.')
    # R3C-095 begin
    if a.action == 'status' and str(cfg.get('serve_host') or '').lower() != host.lower():
        remote_upgrade_warning()
    # R3C-095 end
    peers = {}
    for p in list((st.get('Peer') or {}).values()) + [st['Self']]:
        if not p.get('TailscaleIPs'): continue
        for nm in (p.get('HostName', ''), (p.get('DNSName') or '').split('.')[0]):  # "Alex's S24+" or its DNS label "alexs-s24"
            if nm: peers[nm.lower()] = p['TailscaleIPs'][0]
    for name in [x.strip().lower() for x in (a.allow or '').split(',') if x.strip()]:
        if name not in peers: raise SystemExit('ERROR unknown tailnet device %r; known: %s' % (name, ', '.join(sorted(peers))))
        cfg['allow'][name] = peers[name]
    cfg['allow'][st['Self']['HostName'].lower()] = st['Self']['TailscaleIPs'][0]  # this pc, for testing the remote URL
    if a.action == 'on':
        if not server_port(root): raise SystemExit('ERROR start the viewer first: ' + CLI + ' up --root ' + a.root)
        owner = serve_owner(cfg['https_port'])
        if owner and os.path.normcase(os.path.abspath(owner)) != os.path.normcase(root):
            raise SystemExit('ERROR :%d already serves %s; turn that remote off first or pick --https-port' % (cfg['https_port'], owner))
        r = subprocess.run(['tailscale', 'serve', '--bg', '--https=%d' % cfg['https_port'], 'http://127.0.0.1:%d' % port], capture_output=True, text=True,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if r.returncode: raise SystemExit('ERROR tailscale serve: ' + (r.stderr or r.stdout).strip())
        # R3C-095 begin
        cfg['serve_host'] = host.lower()  # pin the Serve authority; forwarded headers cannot widen it
        # R3C-095 end
        cfg['root'] = root; jsave(cfg_path, cfg)
    url = 'https://%s:%d/' % (host, cfg['https_port'])
    print('REMOTE %s (tailnet only; allowed devices: %s)' % (url, ', '.join(sorted(cfg['allow']))))
    if a.action == 'status': print(subprocess.run(['tailscale', 'serve', 'status'], capture_output=True, text=True).stdout.strip())


def verdict_cmd(a):
    """Record the owner's verdict that arrived outside the viewer (a Peach+ button or feedback form). Never invent one."""
    cat = catalog(a.root); st = cat['assets'][a.asset]['stages'][a.stage]; v = a.v or st['versions'][-1]['v']
    path = os.path.join(vdir(a.root, a.asset, a.stage, v), 'review.json')
    old = jload(path, None)
    if old and not old.get('draft') and not a.force: raise SystemExit('ERROR v%03d already has a final review; use --force to replace it' % v)
    notes = (old or {}).get('notes', []) if old else []
    if a.text:
        m = max([n.get('mark', 0) for n in notes] + [0]) + 1
        notes = notes + [{'id': 'N%d' % m, 'mark': m, 'verdict': 'approve' if a.verdict == 'approved' else 'change', 'priority': 'med', 'status': 'open', 'text': a.text,
                          'target': {'file': st['versions'][v - 1]['files'][0]['name'], 'selector': {'type': 'whole'}}, 'created': now()}]
    rv = dict(old or {}, asset=a.asset, stage=a.stage, version=v, verdict=a.verdict, summary=a.text or (old or {}).get('summary', ''), notes=notes,
              checklist=(old or {}).get('checklist', {}), followups=(old or {}).get('followups', []), reviewer=a.by, source=a.source, draft=False)
    write_review(a.root, rv)
    print('VERDICT %s/%s v%03d: %s by %s (%s)' % (a.asset, a.stage, v, a.verdict, a.by, a.source))


def task_cmd(a):
    return task_impl(a)


def home_link(a):
    """Reviewer home link: the project named in --text (else the one with the most waiting), tailnet URL when remote is on."""
    roots = [r for r in live_roots() if os.path.isfile(os.path.join(r, 'catalog.json'))]
    if not roots: raise SystemExit('ERROR no registered review roots')
    t = (a.text or '').lower()
    named = sorted((r for r in roots if (catalog(r).get('project') or '').lower() in t and catalog(r).get('project')), key=lambda r: -len(catalog(r)['project']))
    root = named[0] if named else max(roots, key=lambda r: len(waiting(r)))
    rem = jload(os.path.join(root, '.remote.json'), None)
    try: print('https://%s:%d/' % (ts_status()['Self']['DNSName'].rstrip('.'), rem['https_port']) if rem else home_url(root))
    except SystemExit: print(home_url(root))


def task_impl(a):
    """Write a task file with the review notes, relevant files and resubmission command."""
    rs = gather(a.root, a.asset, a.stage)
    if not rs: raise SystemExit('No final review for %s/%s yet.' % (a.asset, a.stage))
    r = rs[0]; base = os.path.join(os.path.abspath(a.root), r['dir'].replace('/', os.sep))
    files = catalog(a.root)['assets'][a.asset]['stages'][a.stage]['versions'][r['version'] - 1]['files']
    L = ['# Task: apply review of %s / %s v%03d (%s)' % (a.asset, a.stage, r['version'], r['verdict']), '',
         *(EXTENSION.task_intro(a) if EXTENSION is not None else []),
         'Source files of the reviewed version: ' + ', '.join(os.path.join(base, f['name']) for f in files), '']
    if r['latest_version'] != r['version']:
        out = os.path.normpath(os.path.join(base, '..', 'TASK.md'))
        stop = ('# STOP: newer submission exists\n\n'
                '%s/%s: review v%03d is superseded by submitted v%03d. '
                'Do not revise or submit from this review; wait for the newer version decision.\n'
                % (a.asset, a.stage, r['version'], r['latest_version']))
        with open(out, 'w', encoding='utf-8', newline='\n') as f: f.write(stop)
        raise SystemExit('STALE_TASK: ' + out)
    if r['summary']: L += ['Reviewer summary: ' + r['summary'], '']
    if r['mandate']: L += ["## Reviewer's mandate: %s" % r['mandate'][0], r['mandate'][1], '']
    if r['todo']: L.append('## Do (one change per note%s)' % (', then the mandate above' if r['mandate'] else ', nothing else'))
    else: L += ['## Do', '- [ ] ' + ('The mandate above.' if r['mandate'] else 'The reviewer sent this version back without notes. Rework it against the brief%s; check the recurring feedback when it is listed below. Say in --note what you changed.' % (' and the summary above' if r['summary'] else ''))]
    for n in r['todo']:
        reviewer = jload(os.path.join(base, 'review.json'), {}).get('reviewer', 'Owner') if n.get('from') else 'Owner'
        L.append('- [ ] %s%s (%s, priority %s) on %s: %s' % ('REOPENED ' if n.get('reopened') else '', n.get('id'), n.get('verdict'), n.get('priority', 'med'), describe(n.get('target')), note_text(n, reviewer)))
        for k in ('crop', 'strip', 'context', 'clip'):
            if n.get(k): L.append('  - %s: %s' % (k, os.path.join(base, n[k].replace('/', os.sep))))
        if n.get('ref'): L.append('  - reference image from the reviewer (make it look like this, open it first): %s' % os.path.join(base, n['ref'].replace('/', os.sep)))
    L += ['', '## Keep exactly as it is (locks)'] + ['- %s on %s: %s' % (n['id'], describe(n.get('target')), note_text(n, jload(os.path.join(base, 'review.json'), {}).get('reviewer', 'Owner'))) for n in r['locks']] + ['']
    rec = recurring([a.root] + other_roots(a.root), a.stage)
    if rec: L += ["## The reviewer's recurring feedback on %s (check all of these before you submit)" % a.stage] + ['- %dx: %s' % (c['count'], ' '.join(c['text'].split())[:200]) for c in rec[:8]] + ['']
    # A version with several files: say per file whether it is redone or resubmitted unchanged, so approved files are not reported missing.
    first = files[0]['name']; todo_files = {(n.get('target') or {}).get('file') or first for n in r['todo']}
    file_args = ' '.join('--file "%s"' % ('<new %s>' % f['name'] if f['name'] in todo_files else os.path.join(base, f['name'])) for f in files)
    if len(files) > 1:
        L += ['## Files (submit every file again, with the same name)'] + [
            '- %s %s%s' % ('REDO' if f['name'] in todo_files else 'KEEP', f['name'], (': ' + ', '.join(n['id'] for n in r['todo'] if ((n.get('target') or {}).get('file') or first) == f['name'])) if f['name'] in todo_files else ': resubmit unchanged from ' + os.path.join(base, f['name']))
            for f in files] + ['']
    L += ['## Rules', '- Keep file names, node names, image framing, video length/fps and audio start stable. If the requested pacing change requires new timing, submit an old-to-new time/shot mapping and flag affected time locks for renewed owner review; preserve unrelated locks.',
          '- Do not edit review.json or REVIEW.md. The submit command measures locks and scope itself.',
          '- Unclear note: do the smallest reasonable change and say what you assumed in --response.', '',
          '## When done', 'python "%s" submit --root "%s" --asset %s --stage %s %s --by <model>%s %s --note "what changed"' % (
              os.path.abspath(__file__), os.path.abspath(a.root), a.asset, a.stage, file_args if len(files) > 1 else '--file <changed file>',
              (' --resolves ' + ','.join(n['id'] for n in r['todo'] if not n.get('reopened'))) if any(not n.get('reopened') for n in r['todo']) else '',
              ' '.join('--response "%s=..."' % n['id'] for n in r['todo'] if not n.get('reopened'))),
          EXTENSION.task_next(a) if EXTENSION is not None else
          'Check for the next review: %s wait --root "%s" --asset %s --stage %s' % (CLI, os.path.abspath(a.root), a.asset, a.stage)]
    out = os.path.join(base, '..', 'TASK.md'); out = os.path.normpath(out)
    with open(out, 'w', encoding='utf-8', newline='\n') as f: f.write('\n'.join(L) + '\n')
    print('TASK ' + out)


def card_cmd(a):
    """Review card PNG for a Peach+ DM: thumbnail, what changed, what waits. Prints the card path."""
    from PIL import Image, ImageDraw, ImageFont
    cat = catalog(a.root); asset = cat['assets'][a.asset]; st = asset['stages'][a.stage]; ver = st['versions'][(a.v or len(st['versions'])) - 1]
    d = vdir(a.root, a.asset, a.stage, ver['v'])
    src = next((f['name'] for f in ver['files'] if f['media'] == 'image'), None) or ver.get('thumb')  # the real image beats the small viewer thumb
    W, H = 1200, 630; img = Image.new('RGB', (W, H), (34, 38, 30)); g = ImageDraw.Draw(img)
    def font(sz, bold=False):
        for n in (('bahnschrift.ttf',), ('segoeuib.ttf' if bold else 'segoeui.ttf',), ('arial.ttf',)):
            try: return ImageFont.truetype(n[0], sz)
            except OSError: pass
        return ImageFont.load_default()
    if src and os.path.exists(os.path.join(d, src)):
        th = Image.open(os.path.join(d, src)).convert('RGB')
        if th.height / th.width >= 1.6:
            th = th.crop((0, 0, th.width, min(th.height, round(th.width * 470 / 700))))
        s = min(700 / th.width, 470 / th.height)
        th = th.resize((max(1, round(th.width * s)), max(1, round(th.height * s))), Image.LANCZOS)
        g.rectangle([40, 120, 740, 590], fill=(75, 75, 73)); img.paste(th, (40 + (700 - th.width) // 2, 120 + (470 - th.height) // 2))
    elif any(f['name'].lower().endswith('.wav') for f in ver['files']):
        import wave, struct
        wf = next(f['name'] for f in ver['files'] if f['name'].lower().endswith('.wav'))
        with wave.open(os.path.join(d, wf)) as w: ch, sw, n = w.getnchannels(), w.getsampwidth(), w.getnframes(); raw = w.readframes(n)
        vals = struct.unpack('<%dh' % (len(raw) // 2), raw)[::ch] if sw == 2 else [0]
        g.rectangle([40, 120, 740, 590], fill=(16, 19, 23)); per = max(1, len(vals) // 700)
        for i in range(700):
            seg = vals[i * per:(i + 1) * per] or [0]; hi, lo = max(seg) / 32768, min(seg) / 32768
            g.line([40 + i, 355 - hi * 220, 40 + i, 355 - lo * 220], fill=(127, 179, 230))
    else:
        g.rectangle([40, 120, 740, 590], fill=(75, 75, 73)); g.text((60, 140), ver['files'][0]['media'], font=font(32), fill=(232, 227, 209))
    label = next(s[1] for s in STAGES if s[0] == a.stage)
    g.rectangle([0, 0, W, 8], fill=(111, 157, 203))
    g.text((40, 32), '%s: %s version %d' % (asset.get('name', a.asset), label.lower(), ver['v']), font=font(40, True), fill=(232, 227, 209))
    g.text((40, 80), 'Waiting for your verdict. Submitted by %s.' % ver.get('by', 'agent'), font=font(24), fill=(166, 169, 145))
    y = 130; x = 770; f = font(24); fb = font(26, True)
    def para(t, fill=(232, 227, 209), ft=f, width=24):
        nonlocal y
        words, line = t.split(), ''
        for w in words:
            if len(line) + len(w) > width: g.text((x, y), line, font=ft, fill=fill); y += 32; line = ''
            line += w + ' '
        if line: g.text((x, y), line, font=ft, fill=fill); y += 32
    para("What's new", ft=fb)
    para(ver.get('note') or '(no note)')
    y += 10
    if ver.get('resolves'): para('Meldt opgelost: ' + ', '.join(ver['resolves']), fill=(169, 198, 230))
    bad = [c for c in ver.get('lock_check', []) if c['result'] != 'unchanged']
    if ver.get('lock_check'): para(('%d locked spot(s) changed' % len(bad)) if bad else 'All locked spots unchanged', fill=(226, 166, 60) if bad else (138, 174, 92))
    sc = ver.get('scope_check') or {}
    if sc.get('changed_outside_pct') is not None: para('%.1f%% changed outside the notes' % sc['changed_outside_pct'], fill=(226, 166, 60) if sc['changed_outside_pct'] > 0.5 else (138, 174, 92))
    if sc.get('changed_nodes_outside') is not None: para('%d part%s changed outside the notes' % (len(sc['changed_nodes_outside']), '' if len(sc['changed_nodes_outside']) == 1 else 's'), fill=(226, 166, 60) if sc['changed_nodes_outside'] else (138, 174, 92))
    out = os.path.join(os.path.abspath(a.root), 'cards'); os.makedirs(out, exist_ok=True)
    p = os.path.join(out, '%s_%s_v%03d.png' % (a.asset, a.stage, ver['v'])); img.save(p)
    print('CARD ' + p)
    print('LINK ' + link(a.root, a.asset, a.stage, ver['v']))


# ---------------- review markdown ----------------
def note_text(n, reviewer):
    if not n.get('from'): return n.get('text', '')
    return '(from %s, adopted by %s)\n\n%s' % (n['from'].get('name', n['from'].get('person', '?')), reviewer, '\n'.join('> ' + line for line in n.get('text', '').splitlines()))


def review_md(rv, cat_asset_name):
    L = ['# Review: %s / %s v%03d' % (cat_asset_name, rv['stage'], rv['version']), '',
         ('DRAFT (not final, agents wait) by %s at %s' % (rv.get('reviewer', 'Owner'), rv.get('updated'))) if rv.get('draft') else
         'Verdict: **%s** by %s at %s' % (rv.get('verdict'), rv.get('reviewer', 'Owner'), rv.get('updated')), '']
    if rv.get('summary'): L += ['Summary: ' + rv['summary'], '']
    m = EXTENSION.mandate(rv) if EXTENSION is not None else None
    if m: L += ['Mandate: **%s** - %s' % m, '']
    if rv.get('checklist'):
        L.append('Checklist:')
        for k, v in rv['checklist'].items(): L.append('- [%s] %s%s' % ({'ok': 'x', 'fail': '!', 'na': '-'}.get(v, ' '), k, ' (n/a)' if v == 'na' else ''))
        L.append('')
    for n in rv.get('notes', []):
        L.append('## #%s %s - %s (%s, %s)' % (n.get('mark'), n.get('id'), n.get('verdict'), n.get('priority', 'med'), n.get('status', 'open')))
        L.append(note_text(n, rv.get('reviewer', 'Owner')))
        L.append('- target: %s in %s' % (describe(n.get('target')), (n.get('target') or {}).get('file', '')))
        for key in ('crop', 'strip', 'context', 'clip'):
            if n.get(key): L.append('- %s: %s' % (key, n[key]))
        if n.get('ref'): L.append('- reference (make it look like this): %s' % n['ref'])
        if n.get('verdict') == 'approve': L.append('- LOCKED: do not change this region/part in later versions')
        L.append('')
    for f in rv.get('followups', []):
        L.append('- follow-up %s: %s %s' % (f.get('id'), f.get('status'), f.get('text', '')))
    return '\n'.join(L) + '\n'


# ---------------- recurring feedback: the owner's notes that come back become checks for agents ----------------
STOP = set('de het een en van te is in op met voor dat die er nog wat aan bij maar ook dan als zo naar om je zijn moet dit deze kan the an and of to is in on for it this that be are with'.split())
DEFAULT_NOTE = {'redo', 'good, keep as is', 'opnieuw maken', 'goed, zo houden'}  # the Dutch pair: notes written by older versions


def other_roots(root):
    me = os.path.normcase(os.path.abspath(root))
    return [r for r in jload(PROJECTS, []) if os.path.normcase(os.path.abspath(r)) != me and os.path.isfile(os.path.join(r, 'catalog.json'))]


def feedback_items(roots, stage=None):
    """Every change/reject note, reopened follow-up and failed checklist item from final reviews."""
    out = []
    for root in roots:
        for aid, asset in catalog(root)['assets'].items():
            for sid, st in asset['stages'].items():
                if stage and sid != stage: continue
                for ver in st.get('versions', []):
                    rv = final_review(os.path.join(vdir(root, aid, sid, ver['v']), 'review.json'))
                    if not rv: continue
                    src = '%s v%d' % (aid, ver['v'])
                    for n in rv.get('notes', []):
                        if n.get('from'): continue  # adopted advice from someone else is not the owner's own recurring feedback
                        t = (n.get('text') or '').strip()
                        if n.get('verdict') in ('change', 'reject') and t and t.lower() not in DEFAULT_NOTE: out.append({'stage': sid, 'text': t, 'src': src})
                    for f in rv.get('followups', []):
                        if f.get('status') == 'reopened' and f.get('text'): out.append({'stage': sid, 'text': f['text'] + ' (was not resolved)', 'src': src})
                    out += [{'stage': sid, 'text': 'checklist: ' + k, 'src': src, 'exact': True} for k, v in (rv.get('checklist') or {}).items() if v == 'fail']
    return out


def recurring(roots, stage=None, min_count=2):
    """Group similar feedback (shared words) and keep what came back at least min_count times, most frequent first."""
    toks = lambda t: {w for w in re.findall(r'[a-z0-9\u00e0-\u00ff]+', t.lower()) if len(w) > 2 and w not in STOP}
    groups = []
    for it in feedback_items(roots, stage):
        k = toks(it['text'])
        g = next((g for g in groups if g['stage'] == it['stage'] and (g['text'] == it['text'] if it.get('exact') or g.get('exact') else
                  k and g['k'] and len(k & g['k']) / len(k | g['k']) >= 0.34)), None)
        if g: g['count'] += 1; g['src'].append(it['src'])
        else: groups.append({'stage': it['stage'], 'text': it['text'], 'k': k, 'count': 1, 'src': [it['src']], 'exact': it.get('exact')})
    return sorted([{'stage': g['stage'], 'text': g['text'], 'count': g['count'], 'src': g['src']} for g in groups if g['count'] >= min_count], key=lambda g: -g['count'])


def rules_cmd(a):
    roots = [a.root] + (other_roots(a.root) if not a.this_only else [])
    rec = recurring(roots, a.stage, a.min)
    L = ["# The reviewer's recurring feedback", '', 'Generated by review.py rules from %d project(s); do not edit. Agents: check these before every submit of that stage.' % len(roots), '']
    for sid in STAGE_IDS:
        rows = [c for c in rec if c['stage'] == sid]
        if rows: L += ['## ' + sid] + ['- %dx: %s  (%s)' % (c['count'], c['text'], ', '.join(c['src'][:4])) for c in rows] + ['']
    if not rec: L.append('Nothing came back twice yet.')
    if not a.stage:
        with open(os.path.join(a.root, 'rules.md'), 'w', encoding='utf-8', newline='\n') as f: f.write('\n'.join(L) + '\n')
        L.append('RULES written to ' + os.path.join(a.root, 'rules.md'))
    print('\n'.join(L))


def process_info(pid):
    """Return exact creation identity and epoch time, or None after process exit."""
    if not pid or pid <= 0:
        return None
    if os.name == "nt":
        from ctypes import wintypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        h = k.OpenProcess(0x1000, False, pid)
        if not h:
            if ctypes.get_last_error() == 5: raise PermissionError('process identity unavailable')
            return None
        try:
            code = wintypes.DWORD()
            if not (k.GetExitCodeProcess(h, ctypes.byref(code)) and code.value == 259):
                return None
            t = [wintypes.FILETIME() for _ in range(4)]
            if not k.GetProcessTimes(h, *map(ctypes.byref, t)):
                raise PermissionError('process creation identity unavailable')
            created = (t[0].dwHighDateTime << 32) + t[0].dwLowDateTime
            return str(created), created / 1e7 - 11644473600
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
        with open('/proc/%d/stat' % pid, encoding='ascii') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        if fields[0] == 'Z': return None
        ticks = int(fields[19])
        with open('/proc/stat', encoding='ascii') as f:
            boot = next(int(line.split()[1]) for line in f if line.startswith('btime '))
        return '%d:%d' % (boot, ticks), boot + ticks / os.sysconf('SC_CLK_TCK')
    except ProcessLookupError:
        return None
    except FileNotFoundError:
        return None


def process_creation(pid):
    info = process_info(pid)
    return info[0] if info else None


def pid_alive(pid, since=None, created=None):
    """Prefer exact identity; legacy timestamps have no PID reuse tolerance."""
    try:
        info = process_info(pid)
        if not info: return False
        return info[0] == created if created is not None else not since or info[1] <= since
    except PermissionError:
        return True  # inaccessible identity is not proof that an owner exited


def stamp(value):
    try: return datetime.datetime.fromisoformat(value).timestamp()
    except (ValueError, TypeError): return 0


def viewer_catalog(root, cat):
    if EXTENSION is not None:
        return EXTENSION.auto_status(root, cat)
    # A Core server can open a project last written by an optional add-on.
    cat.pop('autopilot', None)
    for asset in cat['assets'].values():
        asset.pop('thread', None)
        asset.pop('studio', None)
        for stage in asset['stages'].values():
            stage.pop('auto', None)
            stage.pop('stuck', None)
            for version in stage['versions']:
                version.pop('thread', None)
    return cat


def queue_cmd(a):
    def items():
        return [i for i in inbox(os.environ.get('ASSET_REVIEW_ROOT') or '.', identity())['items'] if i['kind'] == 'waiting']

    if EXTENSION is not None:
        EXTENSION.refresh_queue(a, items)
    for it in sorted(items(), key=lambda i: i['rank']):
        print('%3d  %s  %s / %s  %s v%s  since %s' % (it['rank'], ('%.2f' % it['score']) if 'score' in it else ' -- ', it['project'], it['asset'], it['stage'], it['v'], it['since']))


def inbox(home, person):
    out, errors = [], []
    hidden = {a['id'] for a in archived_projects()}
    for root in {project_id(r): r for r in reversed([home] + jload(PROJECTS, []))}.values():  # one row per project, also when home is spelled differently from the registry
        role = person_role(person, root)
        if role == 'none' or project_id(root) in hidden or not os.path.isfile(os.path.join(root, 'catalog.json')): continue
        try:
            cat = viewer_catalog(root, overview_catalog(root))
        except Exception as error:
            errors.append(project_read_error(root, error))
            continue
        seen = jload(seen_path(root, person['person']), {})
        mine = not person.get('admin') or not owned_by_other(root)  # the admin does not wait on versions its own owner decides
        def add(aid, asset, sid, ver, kind, since, by='', count=1, text='', **extra):
            out.append(dict(p=project_id(root), project=cat['project'], asset=aid, name=asset.get('name') or aid.replace('_', ' ').replace('-', ' ').capitalize(),
                            stage=sid, v=ver, kind=kind, since=since, by=by, count=count, text=text, seen='%s/%s/%d' % (aid, sid, ver) in seen, **extra))
        if role == 'owner' and mine:
            for w in waiting(root, cat): add(w['asset'], cat['assets'][w['asset']], w['stage'], w['version'], 'waiting', w['at'], w['by'])
        for aid, asset in cat['assets'].items():
            for sid, st in asset['stages'].items():
                if not st.get('versions'): continue
                latest = st['versions'][-1]
                if EXTENSION is not None and role == 'owner' and st.get('stuck'): add(aid, asset, sid, latest['v'], 'stuck', st['stuck']['since'], text=st['stuck'].get('reason') or '', rest=st['stuck'].get('rest'))
                for ver in st['versions']:
                    people = comments(vdir(root, aid, sid, ver['v']))['people']
                    fb = ver.get('feedback')
                    if person.get('admin') and fb and fb['status'] == 'open': add(aid, asset, sid, ver['v'], 'feedback', fb['at'], fb['name'], text=fb['text'])
                    if role == 'owner':
                        for pid, doc in (people.items() if mine else ()):
                            n = sum(c.get('status', 'open') == 'open' for c in doc.get('comments', []))
                            if n and pid != person['person']: add(aid, asset, sid, ver['v'], 'comments', doc.get('updated'), doc.get('name', pid), n)
                    elif ver is latest and stamp(ver.get('at')) >= time.time() - 7 * 86400 and not people.get(person['person'], {}).get('comments'):
                        add(aid, asset, sid, ver['v'], 'new', ver.get('at'), ver.get('by', ''))
        if EXTENSION is not None and person.get('admin'):
            EXTENSION.inbox_items(root, cat, add)
    pending = [it for it in out if it['kind'] == 'waiting']
    if EXTENSION is not None:
        EXTENSION.order_queue(pending)
    else:
        for rank, item in enumerate(sorted(pending, key=lambda it: it['since'] or ''), 1):
            item['rank'] = rank
    return {'items': sorted(out, key=lambda x: x['since'] or ''), 'errors': errors}


def social_posts(home, person):
    """Read-only cross-project drafts; all decisions use the existing review/bin APIs."""
    out = []
    hidden = {a['id'] for a in archived_projects()}
    for root in dict.fromkeys([home] + jload(PROJECTS, [])):
        role = person_role(person, root)
        if role == 'none' or project_id(root) in hidden or not os.path.isfile(os.path.join(root, 'catalog.json')): continue
        cat = catalog(root)
        for aid, asset in cat['assets'].items():
            if asset.get('route') != 'social': continue
            sid = next((s for s in ('post', 'page') if asset['stages'].get(s, {}).get('versions')), None)
            if not sid: continue
            st = asset['stages'][sid]; ver = st['versions'][-1]; d = vdir(root, aid, sid, ver['v'])
            blocks = []
            for f in ver.get('files', []):
                if f.get('media') != 'text': continue
                path = os.path.realpath(os.path.join(d, f['name']))
                if os.path.commonpath([os.path.realpath(d), path]) != os.path.realpath(d): continue
                try:
                    with open(path, encoding='utf-8-sig') as fh: text = fh.read(256 * 1024)
                except (OSError, UnicodeError): continue
                blocks.extend(b.strip() for b in re.findall(r'^```text[^\S\n]*\r?\n(.*?)^```[^\S\n]*\r?$', text, re.M | re.S))
            platform = str(ver.get('meta', {}).get('platform') or '').lower()
            if platform not in ('x', 'vcnl'):
                platform = 'vcnl' if 'vcnl' in aid.lower() else 'x' if re.search(r'(^|-)x(-|$)', aid.lower()) else 'unknown'
            out.append(dict(p=project_id(root), project=cat['project'], asset=aid, name=asset.get('name') or aid,
                            stage=sid, v=ver['v'], status=st.get('status', 'in_review'), platform=platform, blocks=blocks,
                            files=ver.get('files', []), since=ver.get('at', ''), can_decide=role == 'owner'))
    return {'items': sorted(out, key=lambda it: it['since'], reverse=True)}


# ---------------- server ----------------
def accepts_gzip(header):
    """An explicit gzip preference overrides '*', including gzip;q=0."""
    preferences = {}
    for part in header.lower().split(','):
        coding, *params = part.strip().split(';')
        quality = 1.0
        for param in params:
            key, _, value = param.strip().partition('=')
            if key == 'q':
                try: quality = float(value)
                except ValueError: quality = 0.0
        preferences[coding.strip()] = quality if 0 <= quality <= 1 else 0.0
    return preferences.get('gzip', preferences.get('*', 0)) > 0


class Handler(http.server.SimpleHTTPRequestHandler):
    home = '.'  # the root this server was started for; ?p=<project id> picks another registered root per request
    project = None

    # R3C-095 begin
    LOCAL_HOSTS = frozenset(('127.0.0.1', 'localhost', '::1'))

    def accepted_authority(self, authority):
        """Match a local/recorded Serve authority using only Host and the real peer."""
        try:
            peer = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        if not (getattr(peer, 'ipv4_mapped', None) or peer).is_loopback: return False
        if authority.scheme not in ('', 'http', 'https') or not authority.hostname: return False
        if authority.username is not None or authority.password is not None: return False
        if authority.path or authority.query or authority.fragment: return False
        # Host has no scheme: absent ports mean 80 locally, 443 for Serve.
        default_port = 443 if authority.scheme == 'https' or (
            not authority.scheme and authority.hostname not in self.LOCAL_HOSTS) else 80
        port = authority.port if authority.port is not None else default_port
        if authority.hostname in self.LOCAL_HOSTS: return port == self.server.server_port
        cfg = jload(os.path.join(self.home, '.remote.json'), None) or {}
        return (authority.hostname == str(cfg.get('serve_host') or '').lower()
                and port == cfg.get('https_port'))

    def parse_request(self):
        """Check Host before dispatching any method, including unsupported ones."""
        if not super().parse_request(): return False
        hosts = self.headers.get_all('Host', [])
        valid = False
        if len(hosts) == 1 and hosts[0] and not any(
                c in hosts[0] for c in '/\\?#@') and not any(c.isspace() or ord(c) < 32 for c in hosts[0]):
            try:
                authority = urllib.parse.urlsplit('//' + hosts[0])
                valid = self.accepted_authority(authority)
                if valid and authority.hostname not in self.LOCAL_HOSTS:
                    # Device authorization is separate: XFF can never make a
                    # foreign Host match the recorded Serve authority.
                    allow = (jload(os.path.join(self.home, '.remote.json'), None) or {}).get('allow', {})
                    valid = bool(self.headers.get('X-Forwarded-For')) and self.client_ip() in allow.values()
            except ValueError:
                pass  # malformed brackets or port
        if valid: return True
        self.close_connection = True  # a rejected POST body must not become a request
        self.send_response(403)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()
        return False
    # R3C-095 end

    def log_message(self, *a):
        pass

    def authorize(self, path, method='GET'):
        self.person = identity(self.client_ip(), bool(self.headers.get('X-Forwarded-For') or self.headers.get('Tailscale-User-Login')))
        self.role = person_role(self.person, self.root)
        if self.role == 'none' and path not in ('/api/projects', '/api/inbox', '/api/social'):
            self.send_json({'ok': False, 'error': 'Project not found'}, 404); return False
        if method == 'POST':
            # R3C-111 begin
            if path == '/api/review-queue' and self.role != 'owner':
                self.send_json({'ok': False, 'error': 'Only the owner can change the queue limit'}, 403); return False
            # R3C-111 end
            decide = {'/api/review', '/api/comment/status', '/api/thumb', '/api/feedback', '/api/bin', '/api/unbin', '/api/tuner'}
            execute = {'/api/feedback/done', '/api/project/archive', '/api/project/restore'}
            required = EXTENSION.POST_PERMISSIONS.get(path) if EXTENSION is not None else None
            if ((path in decide or required == 'owner') and self.role != 'owner') or (
                    (path in execute or required == 'admin') and not self.person.get('admin')):
                self.send_json({'ok': False, 'error': 'You are not allowed to do this'}, 403); return False
        return True

    def who(self, q):
        if self.person['remote']: return self.person['name']
        return q.get('by', ['Owner'])[0]

    def pick_root(self, q):
        p = q.get('p', [''])[0]
        if not p or p == project_id(self.home):
            self.root = self.home; return True
        r = next((r for r in jload(PROJECTS, []) if project_id(r) == p and os.path.isfile(os.path.join(r, 'catalog.json'))), None)
        if not r: self.send_json({'ok': False, 'error': 'unknown project'}, 404); return False
        self.root, self.project = os.path.abspath(r), None
        return True

    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Vary', 'Accept-Encoding')
        b = self.compress(b)
        self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def compress(self, data):
        if len(data) >= 1024 and accepts_gzip(self.headers.get('Accept-Encoding', '')):
            compressed = gzip.compress(data, compresslevel=1, mtime=0)
            if len(compressed) < len(data):
                self.send_header('Content-Encoding', 'gzip')
                return compressed
        return data

    def send_file(self, path, cache=False):
        if not os.path.isfile(path): return self.send_error(404)
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if path.endswith('.js'): ctype = 'text/javascript'
        if path.endswith('.glb'): ctype = 'model/gltf-binary'
        size = os.path.getsize(path)
        policy = 'max-age=31536000, immutable' if cache is True else 'private, max-age=600' if cache == 'short' else 'no-cache' if cache else 'no-store'
        # Weak validators describe the same bytes after optional transfer compression.
        etag = 'W/"%s"' % hashlib.sha256(repr(stat_sig(path)).encode()).hexdigest() if cache else None
        text = ctype.startswith('text/') or ctype in ('application/json', 'application/manifest+json', 'image/svg+xml', 'application/javascript')
        compressible = text and 1024 <= size <= (8 << 20)
        if etag:
            candidates = [tag.strip().removeprefix('W/') for tag in self.headers.get('If-None-Match', '').split(',')]
            if '*' in candidates or etag.removeprefix('W/') in candidates:
                self.send_response(304); self.send_header('ETag', etag); self.send_header('Cache-Control', policy)
                if compressible: self.send_header('Vary', 'Accept-Encoding')
                self.end_headers(); return
        rng = self.headers.get('Range')
        start, end = 0, size - 1
        if rng and rng.startswith('bytes='):
            s, _, e = rng[6:].partition('-')
            try: start = int(s) if s else max(0, size - int(e)); end = min(size - 1, int(e)) if (s and e) else size - 1
            except ValueError: start, end = size, 0
            if start >= size or start > end:
                self.send_response(416); self.send_header('Content-Range', 'bytes */%d' % size); self.send_header('Content-Length', '0'); self.end_headers(); return
            self.send_response(206); self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        else:
            self.send_response(200)
        self.send_header('Content-Type', ctype); self.send_header('Accept-Ranges', 'bytes'); self.send_header('Cache-Control', policy)
        if etag: self.send_header('ETag', etag)
        if compressible: self.send_header('Vary', 'Accept-Encoding')
        if urllib.parse.urlparse(self.path).path.startswith(('/data/', '/api/library/')):
            self.send_header('X-Content-Type-Options', 'nosniff'); self.send_header('Content-Security-Policy', 'sandbox')
        if compressible and not rng and accepts_gzip(self.headers.get('Accept-Encoding', '')):
            with open(path, 'rb') as f:
                opened_size = os.fstat(f.fileno()).st_size
                if 1024 <= opened_size <= (8 << 20):
                    limit = min(size, opened_size)
                    data = f.read(limit + 1)  # one overflow byte, even if the file grows after fstat
                    # Growth uses the original streaming ceiling and identity bytes.
                    data = self.compress(data) if len(data) <= limit else data[:size]
                    self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data); return
        self.send_header('Content-Length', str(end - start + 1)); self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start); left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk: break
                self.wfile.write(chunk); left -= len(chunk)

    def inside(self, base, rel):
        # R3C-095 begin
        # Windows realpath can contact a UNC/device host before containment is
        # checked. Reject non-relative forms before even joining the path.
        if (rel.startswith(('/', '\\')) or '\\' in rel or ':' in rel or '\x00' in rel
                or ntpath.splitdrive(rel)[0] or ntpath.isabs(rel)):
            return None
        if not all(safe_path_segment(part) for part in rel.split('/')): return None
        # R3C-095 end
        base = os.path.normcase(os.path.realpath(base))
        p = os.path.normcase(os.path.realpath(os.path.join(base, rel)))
        try: return p if os.path.commonpath([base, p]) == base else None
        except ValueError: return None  # a different drive cannot be inside this root

    def send_zip(self, q):
        try:
            a, s, v = q.get('asset', [''])[0], q.get('stage', [''])[0], int(q.get('v', ['1'])[0]); check_ids(a, s, v)
            versions = catalog(self.root)['assets'][a]['stages'][s]['versions']
            ver = next(x for x in versions if x['v'] == v)
            d = os.path.realpath(vdir(self.root, a, s, v)); paths = []
            items = os.path.realpath(os.path.join(self.root, 'items'))
            if os.path.commonpath([items, d]) != items: raise ValueError('Invalid version path')
            for f in ver['files']:
                name = f['name']; path = self.inside(d, name)
                parts = (name + '/' + (os.path.normcase(os.path.relpath(path, d)) if path else '')).replace('\\', '/').lower().split('/')  # the canonical name too: voice./ and review.json. open the same files on Windows
                if os.path.isabs(name) or not path or any(p in ('', '.', '..', 'comments', 'voice', 'crops', 'review.json', 'review.md') for p in parts):
                    raise ValueError('Invalid file path')
                if not os.path.isfile(path): raise ValueError('File missing')
                paths.append((path, name.replace('\\', '/')))
        except (ValueError, KeyError, TypeError, StopIteration) as e:
            return self.send_json({'ok': False, 'error': 'Invalid version: ' + str(e)}, 400)
        with tempfile.TemporaryFile(dir=self.root) as archive:
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
                for path, name in paths: z.write(path, name)
            size = archive.tell(); archive.seek(0)
            self.send_response(200); self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Disposition', 'attachment; filename="%s-%s-v%03d.zip"' % (a, s, v))
            self.send_header('X-Content-Type-Options', 'nosniff'); self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(size)); self.end_headers()
            shutil.copyfileobj(archive, self.wfile, 1 << 16)

    def do_GET(self):
        if not self.allowed(): return
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path in ('/', '/index.html'): return self.send_file(os.path.join(VIEWER, 'index.html'), cache='revalidate')
        if u.path.startswith(('/api/', '/data/')) and not self.pick_root(q): return
        if u.path.startswith(('/api/', '/data/')) and not self.authorize(u.path): return
        if EXTENSION is not None and u.path in EXTENSION.GET_ROUTES:
            return EXTENSION.get(self, u.path, q)
        if u.path == '/api/thumb': return self.get_thumb(q)
        if u.path == '/api/me':
            admin, owner = bool(self.person.get('admin')), self.role == 'owner'
            return self.send_json(dict(person=self.person['person'], name=self.who(q), device=self.person['device'], admin=admin, role=self.role,
                                       can=dict(decide=owner, comment=True, execute=admin, request=owner), owned_by=owned_by_other(self.root) if admin else None))
        # R3C-111 begin
        if u.path == '/api/review-queue': return self.send_json(queue_size(self.root))
        if u.path == '/api/catalog': return self.send_json(catalog_queue(self.root, viewer_catalog(self.root, catalog(self.root, self.project))))
        # R3C-111 end
        if u.path == '/api/catalog/page':
            try:
                return self.send_json(catalog_page(self.root, self.project, role=self.role, person=self.person,
                    offset=int(q.get('offset', ['0'])[0]), limit=int(q.get('limit', ['100'])[0]),
                    query=q.get('q', [''])[0], group=q.get('group', [None])[0], status=q.get('status', [None])[0]))
            except ValueError as e: return self.send_json({'ok': False, 'error': str(e)}, 400)
        if u.path == '/api/inbox': return self.send_json(inbox(self.home, self.person))
        if u.path == '/api/social': return self.send_json(social_posts(self.home, self.person))
        if u.path == '/api/zip': return self.send_zip(q)
        if u.path == '/api/comments':
            try:
                a, s, v = q.get('asset', [''])[0], q.get('stage', [''])[0], int(q.get('v', ['1'])[0]); check_ids(a, s, v)
            except ValueError as e: return self.send_json({'ok': False, 'error': str(e)}, 400)
            return self.send_json(comments(vdir(self.root, a, s, v)))
        if u.path == '/api/projects':
            catalogs = {}; listing = projects(self.home, catalogs, self.person)
            roots = {project_id(r): r for r in [self.home] + jload(PROJECTS, [])}
            for p in listing['projects']:
                # R3C-111 begin
                p['review_queue'] = queue_size(roots[p['id']], catalogs.get(p['id']))
                p['waiting'] = p['review_queue']['total']
                # R3C-111 end
                p['role'] = person_role(self.person, roots[p['id']])
                if p['role'] != 'owner' or (self.person.get('admin') and owned_by_other(roots[p['id']])): p['waiting'] = 0  # only the owner of a project has versions waiting
                if EXTENSION is not None: EXTENSION.project_info(p, roots[p['id']], catalogs.get(p['id']), self.person)
            listing['projects'] = [p for p in listing['projects'] if p['role'] != 'none']
            if listing['home'] not in [p['id'] for p in listing['projects']]: listing['home'] = None
            return self.send_json(listing)
        if u.path == '/api/projects/archived':
            if not self.person.get('admin'): return self.send_json({'ok': False, 'error': 'You are not allowed to do this'}, 403)
            return self.send_json({'projects': archived_projects()})
        if u.path in ('/api/library', '/api/library/file', '/api/library/describe'):
            if not self.person.get('admin'): return self.send_json({'ok': False, 'error': 'You are not allowed to do this'}, 403)
            return self.library(u.path, q)
        if u.path in ('/api/refphotos', '/api/refphoto'):
            a = q.get('asset', [''])[0]
            if not safe_name(a) or not os.path.isdir(os.path.join(self.root, 'items', a)): return self.send_json({'ok': False, 'error': 'unknown asset'}, 404)
            dirs = [('refs', os.path.join(self.root, 'items', a, 'refs'))]
            if EXTENSION is not None and self.role == 'owner': dirs.extend(EXTENSION.reference_dirs(self.root, a))
            ext = ('.png', '.jpg', '.jpeg', '.webp')
            if u.path == '/api/refphoto':
                d, n = dict(dirs).get(q.get('src', ['refs'])[0]), q.get('name', [''])[0]
                if not d or not safe_name(n) or not n.lower().endswith(ext): return self.send_error(400)
                return self.send_file(os.path.join(d, n))
            photos = [{'id': src + '-' + n, 'name': n, 'source': src, 'url': '/api/refphoto?asset=%s&src=%s&name=%s' % (a, src, urllib.parse.quote(n))}
                      for src, d in dirs if os.path.isdir(d) for n in sorted(os.listdir(d)) if safe_name(n) and n.lower().endswith(ext) and os.path.isfile(os.path.join(d, n))]
            return self.send_json({'ok': True, 'photos': photos})
        if u.path == '/api/live':
            if self.person['remote']: return self.send_json({'ok': False, 'error': 'live only on this PC'}, 403)
            target = q.get('url', [''])[0]
            def origin(url):
                p = urllib.parse.urlparse(url); return p.scheme, p.hostname, p.port or 80
            try:
                known = [v.get('meta', {}).get('url') for a in catalog(self.root)['assets'].values() for s in a['stages'].values() for v in s['versions']]
                if origin(target) not in [origin(x) for x in known if x]: return self.send_json({'ok': False, 'error': 'Site does not belong to this project'}, 403)
                p = urllib.parse.urlparse(target)
                if p.scheme != 'http' or p.hostname not in ('localhost', '127.0.0.1'): raise ValueError('local http page only')
                try:
                    with LIVE_OPENER.open(urllib.request.Request(target, method='HEAD'), timeout=2): pass
                except urllib.error.HTTPError: pass  # reachable, even if HEAD is unsupported
                except OSError: return self.send_json({'offline': True, 'error': 'The site is not running right now'})
            except ValueError as e: return self.send_json({'ok': False, 'error': str(e)}, 400)
            url = live_url(target)
            return self.send_json({'url': url} if url else {'error': 'local http page only'}, 200 if url else 400)
        if u.path == '/api/info': return self.send_json(dict(self.server.review_identity, root=self.root, home=self.home, schema='asset-review/1', parts=os.path.isfile(SEG_PY), voice=VOICE_OK, pro=EXTENSION is not None))
        if u.path == '/api/tuner': return self.send_json(tuner.state(self.root) if self.role == 'owner' else dict(enabled=False))
        if u.path == '/api/review':
            try: a, s, v = q.get('asset', [''])[0], q.get('stage', [''])[0], int(q.get('v', ['1'])[0])
            except ValueError: return self.send_error(400)
            check_ids(a, s, v)
            return self.send_json(viewer_review(jload_cached(os.path.join(vdir(self.root, a, s, v), 'review.json'), None)))
        if u.path.startswith('/data/'):
            rel = urllib.parse.unquote(u.path[6:])
            items = os.path.realpath(os.path.join(self.root, 'items'))
            p = self.inside(items, rel)
            if not p: return self.send_error(403)
            try:
                p = os.path.realpath(p)
                base = os.path.normcase(items)
                target = os.path.normcase(p)
                if os.path.commonpath((base, target)) != base:
                    return self.send_error(403)
                normalized = os.path.normcase(os.path.relpath(p, items)).replace('\\', '/').lower()
            except (OSError, ValueError):
                return self.send_error(403)
            voice = re.search(r'/voice/([^/]+)/', normalized)
            if voice and not (self.person.get('admin') or self.role == 'owner' or voice[1] == self.person['person'].lower()): return self.send_json({'ok': False, 'error': 'No access to this recording'}, 403)
            if EXTENSION is None and normalized.endswith('/review.json') and os.path.isfile(p):
                return self.send_json(viewer_review(jload_cached(p, None)))
            fixed = not re.search(r'/(parts|crops|renders|voice)/|review-thumb\.png$|review\.json$|review\.md$', normalized)  # delivered files never change after submit
            return self.send_file(p, cache=fixed)
        if u.path.startswith('/api/'): return self.send_error(404)
        p = self.inside(VIEWER, urllib.parse.unquote(u.path.lstrip('/')))
        return self.send_file(p, cache=True if '/vendor/' in u.path else 'revalidate') if p else self.send_error(403)

    def library(self, path, q):
        """Read-only library API (admin only): search over LIBRARY.json, and the media files of the configured library folders."""
        if path == '/api/library/describe':
            try: receipt = library.describe(q.get('id', [''])[0])
            except (OSError, ValueError) as e: return self.send_json({'ok': False, 'error': str(e)}, 409)
            return self.send_json(receipt)
        if path == '/api/library/file':
            src, rel = q.get('src', [''])[0], q.get('rel', [''])[0]; p = library.file_path(src, rel)
            if not p: return self.send_json({'ok': False, 'error': 'File not found'}, 403 if re.search(r'(^|[\\/])\.\.([\\/]|$)|:|^[\\/]|\0', rel) else 404)
            return self.send_file(p, cache='short')
        doc = library.load(rebuild=False)
        if not doc: return self.send_json({'ok': False, 'error': 'No library index'}, 503)
        errors = library.index_errors(doc)
        if errors: return self.send_json({'ok': False, 'error': 'The library admin must refresh the index: ' + '; '.join(errors)}, 503)
        try: limit, offset = max(1, min(200, int(q.get('limit', ['60'])[0]))), max(0, int(q.get('offset', ['0'])[0]))
        except ValueError: return self.send_json({'ok': False, 'error': 'Invalid request'}, 400)
        res = library.search(doc, q.get('q', [''])[0], q.get('kind', [''])[0], limit, offset, q.get('excluded', [''])[0] == '1')
        res.update(built=doc['built'], totals=doc['counts'], kinds=list(library.KINDS), sources=[{k: s[k] for k in ('id', 'label', 'items', 'root')} for s in doc['sources']])
        return self.send_json(res)

    def do_HEAD(self):
        if self.allowed(): self.send_error(405)

    # R3C-095 begin
    def same_origin(self):
        """Writes require JSON and an Origin belonging to this viewer."""
        if not (self.headers.get('Content-Type') or '').startswith('application/json'): return False
        try:
            host = urllib.parse.urlsplit('//' + (self.headers.get('Host') or ''))
            org = self.headers.get('Origin')
            return self.accepted_authority(host) and (
                not org or self.accepted_authority(urllib.parse.urlsplit(org)))
        except ValueError:
            return False
    # R3C-095 end

    def do_POST(self):
        if not self.allowed(): return
        if not self.same_origin(): return self.send_json({'ok': False, 'error': 'only the viewer can write'}, 403)
        u = urllib.parse.urlparse(self.path)
        if not self.pick_root(urllib.parse.parse_qs(u.query)): return
        if not self.authorize(u.path, 'POST'): return
        try:
            n = int(self.headers.get('Content-Length', '0'))
            limit = 200 if u.path == '/api/review' else 30 if u.path in ('/api/comment', '/api/transcribe') else 4 if u.path == '/api/thumb' else 20
            if n < 0 or n > limit * 1024 * 1024: return self.send_json({'ok': False, 'error': 'Request too large'}, 413)
            self.body = json.loads(self.rfile.read(n) or b'{}')
            if not isinstance(self.body, dict): raise ValueError('Invalid request')
            if self.person['remote']:
                self.body.update(by=self.person['name'], via='remote ' + self.person['device'])
                if isinstance(self.body.get('review'), dict): self.body['review'].update(reviewer=self.person['name'], via=self.body['via'])
            elif 'by' in urllib.parse.parse_qs(u.query):
                by = self.who(urllib.parse.parse_qs(u.query)); self.body['by'] = by
                if isinstance(self.body.get('review'), dict): self.body['review']['reviewer'] = by
            return self.post(u)
        except Conflict as e: return self.send_json({'ok': False, 'conflict': True, 'current': e.current}, 409)
        except tuner.TunerConflict as e: return self.send_json({'ok': False, 'conflict': True, 'error': str(e)}, 409)
        except (ValueError, TypeError, KeyError, IndexError) as e: return self.send_json({'ok': False, 'error': 'Invalid request: ' + str(e)}, 400)

    def post(self, u):
        if EXTENSION is not None and u.path in EXTENSION.POST_PERMISSIONS:
            return EXTENSION.post(self, u)
        if u.path in ('/api/project/archive', '/api/project/restore'):
            restore = u.path.endswith('restore')
            return self.send_json({'ok': True, 'project': project_archive(self.body.get('id') if restore else self.root, self.body.get('reason'), self.body.get('by') or self.who(urllib.parse.parse_qs(u.query)), restore)})
        if u.path == '/api/tuner':
            return self.send_json(tuner.save(self.root, self.body.get('values'), self.body.get('base'), self.body.get('by') or self.who(urllib.parse.parse_qs(u.query))))
        if u.path in ('/api/bin', '/api/unbin'):
            return self.send_json(bin_asset(self.root, self.project, self.body, self.body.get('by') or self.who(urllib.parse.parse_qs(u.query)), u.path == '/api/unbin'))
        # R3C-111 begin
        if u.path == '/api/review-queue': return self.send_json(save_limit(self.root, self.body.get('limit'), FileLock, jsave))
        # R3C-111 end
        if u.path == '/api/comment': return self.send_json(dict(ok=True, **save_comment(self.root, self.body, self.person)))
        if u.path == '/api/comment/status': return self.send_json(dict(ok=True, **comment_status(self.root, self.body, self.body.get('by') or self.who(urllib.parse.parse_qs(u.query)))))
        if u.path == '/api/feedback':
            if self.person.get('admin'): raise ValueError('The admin cannot ask themselves for feedback')
            return self.send_json(dict(ok=True, **feedback_ask(self.root, self.body, self.person)))
        if u.path == '/api/feedback/done': return self.send_json(dict(ok=True, **feedback_done(self.root, self.body)))
        if u.path == '/api/seen': return self.send_json(dict(ok=True, **mark_seen(self.root, self.person['person'], self.body)))
        if u.path == '/api/thumb': return self.post_thumb()
        if u.path == '/api/ref':
            n = int(self.headers.get('Content-Length', '0'))
            if n > 20 * 1024 * 1024: return self.send_error(413)
            body = self.body; a, s, v, nid = body['asset'], body['stage'], int(body['version']), str(body.get('id', ''))
            check_ids(a, s, v); m = re.match(r'data:image/(jpeg|png|webp);base64,', body.get('data') or '')
            comment = self.role == 'commenter' or body.get('scope') == 'comment'
            if not re.fullmatch(r'C\d{1,4}' if comment else r'N\d{1,4}', nid) or not m: return self.send_json({'ok': False, 'error': 'Invalid example'}, 400)
            if comment and m.group(1) == 'webp': return self.send_json({'ok': False, 'error': 'Use PNG or JPEG for notes'}, 400)
            d = vdir(self.root, a, s, v)
            if not os.path.isdir(d): return self.send_json({'ok': False, 'error': 'version does not exist'}, 404)
            rel = 'crops/%s%s_ref.%s' % ((self.person['person'] + '/') if comment else '', nid, 'jpg' if m.group(1) == 'jpeg' else m.group(1))
            with FileLock(self.root):
                if comment and any(n['id'] == nid and n.get('status', 'open') != 'open' for n in jload(os.path.join(d, 'comments', self.person['person'] + '.json'), {}).get('comments', [])):
                    return self.send_json({'ok': False, 'error': 'This note has already been handled'}, 409)
                os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
                with open(os.path.join(d, rel), 'wb') as fh: fh.write(base64.b64decode(body['data'].split(',', 1)[1]))
            return self.send_json({'ok': True, 'ref': rel})
        if u.path == '/api/transcribe':
            n = int(self.headers.get('Content-Length', '0'))
            if n > 30 * 1024 * 1024: return self.send_error(413)
            if not VOICE_OK: return self.send_json({'error': 'faster-whisper is not installed'}, 501)
            return self.send_json(transcribe(self.root, self.body['audio'], keep=bool(self.person.get('admin'))))
        if u.path != '/api/review': return self.send_error(404)
        n = int(self.headers.get('Content-Length', '0'))
        if n > 200 * 1024 * 1024: return self.send_error(413)
        body = self.body
        rv = body['review']; a, s, v = rv['asset'], rv['stage'], int(rv['version'])
        check_ids(a, s, v)
        d = vdir(self.root, a, s, v)
        if not os.path.isdir(d): return self.send_json({'ok': False, 'error': 'version does not exist'}, 404)
        written = {}
        for rel, data_url in (body.get('files') or {}).items():
            if not re.fullmatch(r'crops/[A-Za-z0-9_.-]+\.(png|jpg|wav)', rel): continue
            written[rel] = base64.b64decode(data_url.split(',', 1)[1], validate=True)
        if self.person['remote']: rv.update(reviewer=self.person['name'], via='remote ' + self.person['device'])
        write_review(self.root, rv, self.project, body.get('base_rev'), written)
        self.send_json({'ok': True, 'dir': d, 'files': list(written), 'notes': len(rv.get('notes', [])), 'rev': rv['rev']})

    def client_ip(self):
        return (self.headers.get('X-Forwarded-For') or '').split(',')[-1].strip()

    def allowed(self):
        """Direct local requests pass. Requests proxied by Tailscale Serve pass only from devices on the remote allow list."""
        if not self.headers.get('X-Forwarded-For') and not self.headers.get('Tailscale-User-Login'): return True
        allow = (jload(os.path.join(self.home, '.remote.json'), None) or {}).get('allow', {})
        if self.client_ip() in allow.values(): return True
        b = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:24px">'
             '<h2>This device is not on the list</h2><p>Add it on the PC with: <code>review.py remote --root &lt;folder&gt; on --allow &lt;device name&gt;</code></p>').encode('utf-8')
        self.send_response(403); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        return False

    def post_thumb(self):
        n = int(self.headers.get('Content-Length', '0'))
        if n > 4 * 1024 * 1024: return self.send_error(413)
        body = self.body; a, s, v = body['asset'], body['stage'], int(body['version'])
        check_ids(a, s, v); d = vdir(self.root, a, s, v)
        if not os.path.isdir(d) or not body.get('png', '').startswith('data:image/png;base64,'): return self.send_json({'ok': False}, 400)
        with open(os.path.join(d, 'review-thumb.png'), 'wb') as f: f.write(base64.b64decode(body['png'].split(',', 1)[1]))
        with FileLock(self.root):
            cat = catalog(self.root, self.project); cat['assets'][a]['stages'][s]['versions'][v - 1]['thumb'] = 'review-thumb.png'
            jsave(os.path.join(self.root, 'catalog.json'), cat)
        self.send_json({'ok': True})


    def get_thumb(self, q):
        """Fingerprint URLs redirect to immutable 480px WebP files."""
        from PIL import Image, ImageOps, UnidentifiedImageError

        try:
            aid, sid = q.get("asset", [""])[0], q.get("stage", [""])[0]
            version = int(q.get("v", ["1"])[0])
            check_ids(aid, sid, version)
            cat = overview_catalog(self.root)
            ver = next(
                v
                for v in cat["assets"][aid]["stages"][sid]["versions"]
                if v["v"] == version
            )
            name = q.get(
                "file",
                [
                    ver.get("thumb")
                    or next((f["name"] for f in ver["files"] if f["media"] == "image"), "")
                ],
            )[0]
            allowed = {f["name"] for f in ver["files"] if f["media"] == "image"} | {
                ver.get("thumb")
            }
            if name not in allowed or not name:
                raise ValueError("Image not found")
            folder = self.inside(
                os.path.join(self.root, "items"), "%s/%s/v%03d" % (aid, sid, version)
            )
            src = self.inside(folder, name) if folder else None
            if not src or not os.path.isfile(src):
                raise ValueError("Image missing")
            signature = stat_sig(src)
            token = hashlib.sha256(
                repr((os.path.realpath(src), signature, "webp480-v2")).encode()
            ).hexdigest()[:24]
            cached_folder = self.inside(self.root, ".thumb-cache")
            if not cached_folder:
                raise ValueError("Invalid thumbnail cache")
            requested = q.get("sig", [""])[0]
            if requested != token:
                if requested:
                    return self.send_json(dict(ok=False, error="Thumbnail changed"), 410)
                location = "/api/thumb?" + urllib.parse.urlencode(
                    dict(
                        p=project_id(self.root),
                        asset=aid,
                        stage=sid,
                        v=version,
                        file=name,
                        sig=token,
                    )
                )
                self.send_response(302)
                self.send_header("Location", location)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            os.makedirs(cached_folder, exist_ok=True)
            with FileLock(cached_folder):
                # Windows realpath can change form while another writer publishes the file.
                target = self.inside(cached_folder, token + ".webp")
                if not target:
                    raise ValueError("Invalid thumbnail cache file")
                if os.path.isfile(target):
                    try:
                        with Image.open(target) as cached:
                            if cached.format != 'WEBP':
                                raise ValueError('Cache file is not WebP')
                            cached.load()
                    except (ValueError, OSError):
                        os.remove(target)
                if not os.path.isfile(target):
                    with Image.open(src) as image:
                        image = ImageOps.exif_transpose(image)
                        # A full-page capture keeps its width; the overview shows its top.
                        image.thumbnail((480, 4800 if image.height >= image.width * 1.6 else 480), Image.Resampling.LANCZOS)
                        image = image.convert(
                            "RGBA"
                            if "A" in image.getbands() or "transparency" in image.info
                            else "RGB"
                        )
                        if signature != stat_sig(src):
                            raise ValueError("Image changed while reading")
                        tmp = target + ".tmp"
                        try:
                            image.save(tmp, format="WEBP", quality=80, method=4)
                            os.replace(tmp, target)
                        finally:
                            if os.path.exists(tmp):
                                os.remove(tmp)
            return self.send_file(target, cache=True)
        except (
            ValueError,
            KeyError,
            TypeError,
            StopIteration,
            OSError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
        ) as error:
            return self.send_json(
                dict(ok=False, error="Invalid thumbnail: " + str(error)), 400
            )


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    LISTEN_BACKLOG = 64  # queue parallel viewer modules/assets while the accept loop is busy
    request_queue_size = LISTEN_BACKLOG
    daemon_threads = True
    allow_reuse_address = os.name != 'nt'  # on Windows SO_REUSEADDR lets a second server bind a port that is already in use


# ---------------- live page proxy ----------------
# The Website route reviews the real page: the viewer frames it through a small proxy per local site that adds
# live-bridge.js to every HTML page (scroll position, element names under a note). Only local http sites are proxied.
LIVE, LIVE_LOCK = {}, threading.Lock()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None  # the browser follows it through the proxy


LIVE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
LIVE_DROP = {'content-length', 'transfer-encoding', 'connection', 'content-encoding', 'x-frame-options', 'content-security-policy', 'keep-alive'}


class LiveProxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def forward(self, method):
        target = self.server.target
        if urllib.parse.urlparse(self.path).path == '/__ar_live.js':
            b = open(os.path.join(VIEWER, 'live-bridge.js'), 'rb').read()
            self.send_response(200); self.send_header('Content-Type', 'text/javascript'); self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(b))); self.end_headers(); return self.wfile.write(b)
        n = int(self.headers.get('Content-Length') or 0); body = self.rfile.read(n) if n else None
        hdr = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'accept-encoding', 'connection', 'origin', 'referer')}
        hdr['Accept-Encoding'] = 'identity'
        try: r = LIVE_OPENER.open(urllib.request.Request(target + self.path, data=body, headers=hdr, method=method), timeout=20)
        except urllib.error.HTTPError as e: r = e
        except OSError:
            data = b'<!doctype html><meta charset="utf-8"><p>The site is not running right now. Try again.</p><script>parent.postMessage({type:"ar-live-down"},"*")</script>'
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(data))); self.end_headers()
            if method != 'HEAD': self.wfile.write(data)
            return
        data = r.read(); ctype = (r.headers.get('Content-Type') or '').lower()
        if 'text/html' in ctype:
            tag = b'<script src="/__ar_live.js"></script>'; i = data.lower().find(b'</head>')
            data = data[:i] + tag + data[i:] if i >= 0 else tag + data
        self.send_response(r.code)
        for k, v in r.headers.items():
            if k.lower() in LIVE_DROP: continue
            if k.lower() == 'location' and v.startswith(target): v = v[len(target):] or '/'
            self.send_header(k, v)
        self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(data))); self.end_headers()
        if method != 'HEAD': self.wfile.write(data)

    def do_GET(self): self.forward('GET')
    def do_HEAD(self): self.forward('HEAD')
    def do_POST(self): self.forward('POST')


def live_url(url):
    """Proxied address of a local http page, or None. One proxy port per site origin, started on first use."""
    p = urllib.parse.urlparse(url or '')
    if p.scheme != 'http' or (p.hostname or '').lower() not in ('127.0.0.1', 'localhost'): return None
    origin = 'http://%s:%d' % (p.hostname, p.port or 80)
    with LIVE_LOCK:
        if origin not in LIVE:
            srv = Server(('127.0.0.1', 0), LiveProxy); srv.target = origin
            threading.Thread(target=srv.serve_forever, daemon=True).start(); LIVE[origin] = srv.server_address[1]
    return 'http://127.0.0.1:%d%s%s' % (LIVE[origin], p.path or '/', '?' + p.query if p.query else '')


def code_hash():
    with open(__file__, 'rb') as f: return hashlib.sha256(f.read()).hexdigest()


def warn_server_versions(root):
    current = code_hash()
    for r in [root] + other_roots(root):
        info = jload(os.path.join(r, '.server.json'), None) or {}
        if info.get('code_hash') != current and pid_alive(info.get('pid')):
            print('WARNING viewer code differs: %s; stop all viewer servers, then restart all with the same code in one rollout.' % r, file=sys.stderr, flush=True)


def serve(a):
    root = os.path.abspath(a.root)
    if any(row['id'] == project_id(root) for row in archived_projects()):
        raise SystemExit('ERROR archived project cannot start its own viewer; use an existing viewer with ?p=<project id> for history')
    if a.log: sys.stdout = sys.stderr = open(a.log, 'a', encoding='utf-8', buffering=1)  # pythonw via WMI has no console
    Handler.home = root; Handler.project = a.project
    os.makedirs(os.path.join(root, 'items'), exist_ok=True)
    if not os.path.exists(os.path.join(root, 'catalog.json')):
        jsave(os.path.join(root, 'catalog.json'), catalog(root, a.project))
    httpd = Server(('127.0.0.1', a.port), Handler)
    httpd.review_identity = {'port': a.port, 'pid': os.getpid(), 'started': now(), 'created': process_creation(os.getpid()), 'code_hash': code_hash()}
    jsave(os.path.join(root, '.server.json'), httpd.review_identity)
    if a.hub: threading.Thread(target=hub_listen, args=(httpd, root, a.hub), name='cutdesk-hub', daemon=True).start()
    warn_server_versions(root)
    print('ASSET_REVIEW http://127.0.0.1:%d  root=%s' % (a.port, root), flush=True)
    if os.environ.get('ASSET_REVIEW_RENDER') == '1':
        from auto_render import start_worker
        start_worker(root)
    if EXTENSION is not None: EXTENSION.start_server(root)
    httpd.serve_forever()


def find_root(given):
    """--root, else $ASSET_REVIEW_ROOT, else the nearest folder (cwd upwards) that is a review root or holds review/catalog.json."""
    if given: return given
    if os.environ.get('ASSET_REVIEW_ROOT'): return os.environ['ASSET_REVIEW_ROOT']
    d = os.getcwd()
    while True:
        if os.path.isfile(os.path.join(d, 'catalog.json')) and os.path.isdir(os.path.join(d, 'items')): return d
        if os.path.isfile(os.path.join(d, 'review', 'catalog.json')): return os.path.join(d, 'review')
        up_ = os.path.dirname(d)
        if up_ == d: sys.exit('No review root found. Pass --root <folder> (created on first submit) or set ASSET_REVIEW_ROOT.')
        d = up_


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    for name in ('up', 'serve', 'next', 'submit', 'wait', 'notes', 'task', 'link', 'status', 'events', 'remote', 'verdict', 'card', 'archive', 'rules', 'home-link', 'choice', 'category', 'compact-catalog'):
        sp = sub.add_parser(name); sp.add_argument('--root', help='review folder; default: $ASSET_REVIEW_ROOT, else ./review or a parent with catalog.json'); sp.add_argument('--project')
        if name in ('serve', 'up'): sp.add_argument('--port', type=int, default=4780)
        if name == 'serve': sp.add_argument('--log', help='append server output here (set by up)'); sp.add_argument('--hub', type=int, metavar='BASE', help='also serve every other live project from this process, new listeners from port BASE up (set by up when hub.on exists)')
        if name == 'submit':
            sp.add_argument('--asset', required=True); sp.add_argument('--stage', required=True, choices=STAGE_IDS)
            sp.add_argument('--file', action='append', required=True); sp.add_argument('--name'); sp.add_argument('--note')
            sp.add_argument('--resolves'); sp.add_argument('--response', action='append'); sp.add_argument('--by', default='agent'); sp.add_argument('--meta', help='JSON or key=value pairs, e.g. url=...,units=m; kind=doc marks a brief as a business document (no asset-template checks)')
            sp.add_argument('--route', help='stages this asset goes through: ' + ', '.join(ROUTES) + ' (default full; audio for a new sound)')
            submit_parser = sp
            sp.add_argument('--parts', action='store_true', help='recognise and name image parts (needs ASSET_REVIEW_SEG_PYTHON)')
            sp.add_argument('--skip-gate', metavar='WHY', help='submit despite a hard pre-flight failure; the reviewer sees the reason')
            sp.add_argument('--skip-render', action='store_true', help='skip automatic 3D angle stills and contact sheet for this submit')
            sp.add_argument('--build-id', help='game slice/polish/qa/store build identifier')
            sp.add_argument('--phone-clients', type=int, help='clients in the measured QA phone session (at least 2)')
            sp.add_argument('--claim-players', type=int, help='store player claim, at most QA phone_clients')
            sp.add_argument('--choice', metavar='GROUP', help='this asset is one option of a question (e.g. style); the reviewer picks 1 of the group ("none" = leave the group)')
            sp.add_argument('--category', metavar='NAME', help='review category for the batch view, e.g. Heroes or Buildings ("none" = route label)')
        if name == 'choice':
            sp.add_argument('--group', required=True, help='group name, or "none" to take the assets out of their group'); sp.add_argument('--asset', action='append', required=True)
        if name == 'category':
            sp.add_argument('--set', metavar='NAME', help='category name, or "none" to fall back to the route label; without --set: list categories'); sp.add_argument('--asset', action='append')
        if name == 'rules':
            sp.add_argument('--stage', choices=STAGE_IDS); sp.add_argument('--min', type=int, default=2); sp.add_argument('--this-only', action='store_true', help='only this root, not every registered project')
        if name in ('notes', 'next', 'wait', 'events'): sp.add_argument('--json', action='store_true')
        if name == 'notes':
            sp.add_argument('--asset'); sp.add_argument('--stage', choices=STAGE_IDS)
        if name in ('wait', 'link', 'task', 'verdict', 'card'):
            sp.add_argument('--asset', required=True); sp.add_argument('--stage', required=(name != 'link'), choices=STAGE_IDS); sp.add_argument('--v', type=int)
        if name == 'home-link': sp.add_argument('--text', help='message text; the project named in it wins')
        if name == 'link': sp.add_argument('--remote', action='store_true', help='tailnet URL instead of the local one')
        if name == 'remote':
            sp.add_argument('action', choices=['on', 'off', 'status']); sp.add_argument('--allow', help='tailnet device names, comma separated'); sp.add_argument('--https-port', type=int, default=8443)
        if name == 'verdict':
            sp.add_argument('--verdict', required=True, choices=['approved', 'changes', 'rejected']); sp.add_argument('--text')
            sp.add_argument('--by', default='Owner'); sp.add_argument('--source', required=True, help='e.g. manual:review'); sp.add_argument('--force', action='store_true')
        if name == 'wait':
            sp.add_argument('--timeout', type=int, default=900); sp.add_argument('--interval', type=float, default=2.0)
            sp.add_argument('--new', action='store_true', help='ignore an existing final review and wait for a new save')
        if name == 'events':
            sp.add_argument('--since'); sp.add_argument('--last', type=int, default=30)
        if name == 'archive':
            sp.add_argument('--asset'); sp.add_argument('--stage', action='append', choices=STAGE_IDS); sp.add_argument('--keep', action='append', choices=STAGE_IDS)
            sp.add_argument('--reason'); sp.add_argument('--by', default='agent'); sp.add_argument('--restore', metavar='ARCHIVE_ID')
    sp = sub.add_parser('people'); sp.add_argument('action', choices=['list', 'add', 'role', 'default'])
    sp.add_argument('--id'); sp.add_argument('--name'); sp.add_argument('--device', action='append'); sp.add_argument('--project')
    sp.add_argument('--role', choices=['owner', 'commenter', 'none']); sp.add_argument('--admin', action='store_true', help='with add: may administer all projects')
    sp = sub.add_parser('project', help='archive a whole project (hidden, never deleted) or list the archived ones'); sp.add_argument('action', choices=['archive', 'list'])
    sp.add_argument('--project', help='project id or root folder'); sp.add_argument('--reason'); sp.add_argument('--restore', action='store_true'); sp.add_argument('--by', default='cli')
    sp = sub.add_parser('library', help='asset library index: build | search <words> [--kind k] [--json] [--limit n] [--excluded]'); sp.add_argument('rest', nargs=argparse.REMAINDER)
    queue_parser = sub.add_parser('queue', help='the waiting review queue across projects')
    extra_commands = EXTENSION.configure_cli(sub, submit_parser, queue_parser) if EXTENSION is not None else {}
    a = p.parse_args()
    if a.cmd == 'people':
        os.makedirs(os.path.dirname(os.path.abspath(PEOPLE)), exist_ok=True)
        if a.action in ('role', 'default') and not a.role: p.error('--role required')
        return people_cmd(a)
    if sys.stdout and sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        try: sys.stdout.reconfigure(encoding='utf-8')
        except Exception: pass
    if a.cmd == 'library': return library.main(a.rest)
    if a.cmd == 'project': return project_cmd(a)
    if a.cmd == 'queue': return queue_cmd(a)
    if a.cmd in extra_commands: return extra_commands[a.cmd](a)
    if a.cmd == 'home-link': return home_link(a)  # works from any folder: picks a registered root itself
    a.root = find_root(a.root)
    # R3C-111 begin
    try:
        {'up': up, 'serve': serve, 'next': next_cmd, 'submit': submit, 'wait': wait_cmd, 'notes': notes, 'task': task_cmd, 'link': link_cmd, 'status': status,
         'events': events_cmd, 'remote': remote, 'verdict': verdict_cmd, 'card': card_cmd, 'archive': archive_cmd, 'rules': rules_cmd,
         'choice': choice_cmd, 'category': category_cmd, 'compact-catalog': compact_catalog}[a.cmd](a)
    except QueueFull as error:
        p.exit(error.exit_code, str(error) + '\n')
    # R3C-111 end


def load_extension():
    """Load the optional local add-on from the installation directory."""
    path = pathlib.Path(HERE).parent / 'pro' / 'extension.py'
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location(
        'kitborne_terminal_extension', path, submodule_search_locations=[str(path.parent)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    sys.modules['review'] = sys.modules[__name__]
EXTENSION = load_extension()

if __name__ == '__main__':
    main()
