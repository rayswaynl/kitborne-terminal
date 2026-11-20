#!/usr/bin/env python3
"""Cutdesk library index (stdlib only): scans the libraries named in library-sources.json into one LIBRARY.json and searches it.

review.py wraps this as "library build" and "library search"; the viewer serves it through /api/library. Nothing here writes into a library:
the index is the only file it creates. A file leaves the machine only through file_path(), which stays inside the configured roots."""
import csv, datetime, fnmatch, hashlib, json, ntpath, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.environ.get('ASSET_REVIEW_LIBRARY_SOURCES') or os.path.join(HERE, 'library-sources.json')
INDEX = os.environ.get('ASSET_REVIEW_LIBRARY_INDEX') or os.path.join(os.path.expanduser('~'), '.asset-review', 'LIBRARY.json')  # review.py moves it next to projects.json
KINDS = ('prop', 'sky', 'texture', 'vfx', 'ui', 'sound', 'physics', 'terrain', 'shader', 'lighting', 'tool')
SECTION_KIND = {'props': 'prop', 'sky': 'sky', 'textures': 'texture', 'vfx': 'vfx', 'vfx-flipbooks': 'vfx', 'ui': 'ui', 'surface-fills': 'ui', 'terrain': 'terrain', 'tools': 'tool'}
MEDIA = {}  # extension -> media type; the order of the tuple below is the preference when a stem has several files
for media, exts in (('video', '.mp4 .webm'), ('model', '.glb'), ('audio', '.ogg .wav .mp3'), ('gif', '.gif'), ('image', '.png .jpg .jpeg .webp .svg')):
    for e in exts.split(): MEDIA[e] = media
RANK = {e: i for i, e in enumerate('.mp4 .webm .glb .ogg .wav .mp3 .gif .png .jpg .jpeg .webp .svg'.split())}
PREVIEW_FILES = ('preview.png', 'preview.jpg', 'tiled-3x3.jpg', 'hillshade.png', 'fill.png', 'flipbook16.png', 'premultiplied-256.png', 'straight-256.png', 'Color.png', 'equirect.png')
SKIP_DIRS = {'node_modules', '__pycache__', 'frames', 'tmp', 'temp'}
HISTORY = 'retained history (not in CATALOG)'
# A word that no item uses is matched through these (weaker) related words, so "explosion" finds burst, shockwave and impact effects.
SYNONYMS = {'explosion': 'blast burst shockwave impact', 'explode': 'blast burst shockwave impact', 'sunset': 'dusk golden evening sundown', 'sunrise': 'dawn golden',
            'lantern': 'lamp', 'lamp': 'lantern', 'button': 'btn', 'sfx': 'sound', 'music': 'sound',
            'munten': 'currency coins', 'munt': 'currency coin', 'geld': 'currency money', 'knop': 'button btn',
            'tekst': 'text typography', 'projectiel': 'projectile', 'explosie': 'explosion burst impact',
            'geluid': 'sound audio', 'squeak': 'chirp creak rubber', 'eraser': 'rubber', 'banner': 'ribbon toast', 'telegraph': 'warning alert countdown danger',
            'stinger': 'mus jingle', 'victory': 'win fanfare', 'defeat': 'lose', 'bar': 'meter gauge', 'whoosh': 'swish swoosh sweep', 'sweep': 'whoosh swoosh', 'phase': 'levelup banner', 'terrein': 'terrain', 'lucht': 'sky', 'licht': 'lighting', 'materiaal': 'texture material'}
READINESS = ('source-ready', 'integration-needed', 'review-only', 'held', 'unavailable')
PACKAGE_KIND = dict(SECTION_KIND, model='prop', asset='prop', kit='prop', full='prop', sprite='ui', materials='texture')


def slash(p): return str(p).replace('\\', '/')


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f: return json.load(f)
    except (OSError, ValueError): return default


def sources(config=None):
    doc = load_json(config or CONFIG, None)
    if not isinstance(doc, dict) or not isinstance(doc.get('sources'), list): raise SystemExit('ERROR library config missing or invalid: ' + (config or CONFIG))
    out = []
    for s in doc['sources']:
        if isinstance(s, dict) and s.get('id') and s.get('root'): out.append(dict(s, root=os.path.abspath(os.path.expanduser(s['root']))))
    if len({s['id'] for s in out}) != len(out): raise ValueError('Duplicate library source id')
    return out


def includes(src):
    """Folders of a source that may be indexed and served: the root itself, or the folders matching the include patterns (globs allowed)."""
    pats = src.get('include')
    if not pats: return [src['root']]
    try: names = sorted(os.listdir(src['root']))
    except OSError: return []
    return [os.path.join(src['root'], n) for n in names if os.path.isdir(os.path.join(src['root'], n)) and any(fnmatch.fnmatch(n, p) for p in pats)]


def nice(text):
    t = re.sub(r'-s\d{3,}$', '', str(text)); t = re.sub(r'[_\-.]+', ' ', t).strip()
    return t[:1].upper() + t[1:] if t else str(text)


def words(*parts):
    seen = []
    for p in parts:
        for w in re.split(r'[^a-z0-9]+', re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', slash(p)).lower()):
            if len(w) >= 3 and not re.fullmatch(r's?\d+', w) and w not in seen: seen.append(w)
    return seen


def pick_preview(names):
    """(file name, media) of the best visual in one item folder."""
    lower = {n.lower(): n for n in names}
    for n in PREVIEW_FILES:
        if n.lower() in lower: return lower[n.lower()], 'image'
    best = None
    for n in sorted(names):
        e = os.path.splitext(n)[1].lower()
        if e in MEDIA and MEDIA[e] in ('image', 'gif') and not n.lower().startswith('skybox') and (best is None or RANK[e] < RANK[os.path.splitext(best)[1].lower()]): best = n
    return (best, MEDIA[os.path.splitext(best)[1].lower()]) if best else (None, None)


def catalog_items(src, notes):
    root = src['root']; cat = load_json(os.path.join(root, 'CATALOG.json'), {})
    active = {slash(p) for p in cat.get('active', [])}
    ledger = {}
    try:
        with open(os.path.join(root, 'LEDGER.csv'), encoding='utf-8', newline='') as f:
            for r in csv.DictReader(f):
                if r.get('path'): ledger[slash(r['path'])] = r
    except OSError: pass
    excluded = {}
    for e in load_json(os.path.join(root, 'EXCLUDED.json'), []):
        if isinstance(e, dict): excluded[(e.get('run'), e.get('id'))] = e.get('reasons') or []
    found = set(); items = []
    def item(rel, folder, section, mani):
        names = os.listdir(folder); prev, media = pick_preview(names)
        glb = next((n for n in sorted(names) if n.lower().endswith('.glb')), None)
        lr = ledger.get(rel) or {}; m = mani or {}
        run, iid = lr.get('run') or m.get('run'), lr.get('id') or m.get('id') or os.path.basename(folder)
        reasons = list(excluded.get((run, iid), []))
        is_active = rel in active
        if not is_active: reasons.insert(0, HISTORY)
        sub = rel.split('/')[1:-1]
        prov = {k: v for k, v in (('model', lr.get('model') or m.get('model')), ('seed', lr.get('seed') or m.get('seed')), ('run', run), ('qa_score', lr.get('qa_score') or m.get('qa_score')),
                                  ('source_sha256', lr.get('source_sha256') or m.get('source_sha256')), ('ledger', lr.get('status')), ('prompt', (lr.get('prompt') or m.get('prompt') or '')[:400])) if v not in (None, '')}
        it = dict(id='%s:%s' % (src['id'], rel), src=src['id'], kind=SECTION_KIND.get(section, 'prop'), title=nice(iid), tags=words(section, sub, iid)[:12], path=slash(folder), rel=rel,
                  licence=lr.get('licence') or m.get('licence') or '', status='excluded' if reasons else 'active')
        if prev: it.update(preview=rel + '/' + prev, media=media)
        if glb: it['model'] = rel + '/' + glb
        if reasons: it['reasons'] = reasons[:4]
        if prov: it['provenance'] = prov
        return it
    for section in sorted(SECTION_KIND):
        base = os.path.join(root, section)
        if not os.path.isdir(base): continue
        if section == 'tools':
            for n in sorted(os.listdir(base)):
                p = os.path.join(base, n)
                if os.path.isfile(p): items.append(dict(id='%s:tools/%s' % (src['id'], n), src=src['id'], kind='tool', title=nice(os.path.splitext(n)[0]), tags=words('tools', n), path=slash(p), rel='tools/' + n, licence='', status='active'))
            continue
        for d, dirs, files in os.walk(base):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith('.'))
            if 'manifest.json' in files:
                rel = slash(os.path.relpath(d, root)); found.add(rel); dirs[:] = []
                items.append(item(rel, d, section, load_json(os.path.join(d, 'manifest.json'), {}) if rel not in active else None))
    notes['missing'] = len(active - found)
    return items


def folder_items(src, notes):
    root = src['root']; exts = {e.lower() if e.startswith('.') else '.' + e.lower() for e in src.get('ext', [])} or set(MEDIA)
    kind = src.get('kind') or 'prop'; items = []; seen = set()
    for base in includes(src):
        label = os.path.basename(base) if base != root else src['id']
        for d, dirs, files in os.walk(base):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith(('.', '_')))
            groups = {}
            for n in sorted(files):
                e = os.path.splitext(n)[1].lower()
                if e in MEDIA and e in exts: groups.setdefault(os.path.splitext(n)[0].lower(), []).append(n)
                elif e in MEDIA and e not in exts and e in ('.png', '.jpg', '.jpeg', '.webp') and src.get('ext'): groups.setdefault(os.path.splitext(n)[0].lower(), [])  # keeps a poster slot without an item
            for stem, names in groups.items():
                if not names: continue
                allf = [n for n in files if os.path.splitext(n)[0].lower() == stem and os.path.splitext(n)[1].lower() in MEDIA]
                names.sort(key=lambda n: RANK[os.path.splitext(n)[1].lower()]); main = names[0]; me = os.path.splitext(main)[1].lower(); media = MEDIA[me]
                rel = slash(os.path.relpath(os.path.join(d, main), root))
                if rel in seen: continue
                seen.add(rel); sub = slash(os.path.relpath(d, base)).split('/') if d != base else []
                it = dict(id='%s:%s' % (src['id'], rel), src=src['id'], kind=kind, title=nice(os.path.splitext(main)[0]), tags=words(label, sub, os.path.splitext(main)[0])[:12], path=slash(os.path.join(d, main)), rel=rel,
                          licence=src.get('licence', ''), status='active', preview=rel, media=media)
                if media in ('video', 'audio', 'model'):
                    poster = next((n for n in sorted(allf) if MEDIA[os.path.splitext(n)[1].lower()] in ('image', 'gif')), None)
                    if poster: it['poster'] = slash(os.path.relpath(os.path.join(d, poster), root))
                if media == 'model': it['model'] = rel
                alt = [slash(os.path.relpath(os.path.join(d, n), root)) for n in names[1:] if MEDIA[os.path.splitext(n)[1].lower()] == media]
                if alt: it['alt'] = alt
                it['group'] = label
                items.append(it)
    return items


def cuelib_items(src, notes):
    """Cue library (R3 library.json): one item per cue with its description, category, bus and family; the first variant is the file, the rest are alt."""
    root = src['root']; man = os.path.join(root, src.get('manifest', 'library.json')); doc = load_json(man, {}); items = []
    for c in doc.get('cues', []):
        vs = [v for v in c.get('variants', []) if v.get('ogg') or v.get('wav')]
        if not vs or not c.get('id'): continue
        rel = slash(vs[0].get('ogg') or vs[0].get('wav'))
        if not os.path.isfile(os.path.join(root, rel)): continue
        v0 = vs[0]; lufs = v0.get('lufs')
        prov = {k: v for k, v in (('route', c.get('route')), ('proof', v0.get('proof_level')), ('bus', c.get('bus')), ('lufs', round(lufs, 1) if isinstance(lufs, (int, float)) else None),
                                  ('sha256', v0.get('sha256_ogg') or v0.get('sha256_wav')), ('prompt', (c.get('desc') or '')[:400])) if v not in (None, '')}
        it = dict(id='%s:%s' % (src['id'], c['id']), src=src['id'], kind=src.get('kind') or 'sound', title=nice(c['id']), tags=words(c.get('category', ''), c.get('bus', ''), c.get('family', ''), c.get('desc', ''))[:16],
                  path=slash(os.path.join(root, rel)), rel=rel, licence=src.get('licence', ''), status='active', preview=rel, media='audio', group=c.get('family') or c.get('category', ''), provenance=prov)
        alt = [slash(v.get('ogg') or v.get('wav')) for v in vs[1:]]
        if alt: it['alt'] = alt
        items.append(it)
    notes['manifest'] = slash(man)
    return items


def package_path(root, rel):
    """Resolve a declared child below its explicit root, including symlink targets."""
    if not isinstance(rel, str) or not rel or '\0' in rel or ':' in rel or ntpath.splitdrive(rel)[0] or rel.startswith(('/', '\\')) or '..' in slash(rel).split('/'):
        raise ValueError('Unsafe package path: %r' % rel)
    root = os.path.realpath(root); path = os.path.realpath(os.path.join(root, *slash(rel).split('/')))
    try: inside = os.path.commonpath([os.path.normcase(root), os.path.normcase(path)]) == os.path.normcase(root)
    except ValueError: inside = False
    if not inside: raise ValueError('Package path escapes sourceRoot: ' + rel)
    return path


def required_files(record):
    inventory = record.get('importInventory', [])
    required = inventory.get('requiredFiles', []) if isinstance(inventory, dict) else inventory
    if not isinstance(required, list) or any(not isinstance(p, str) or not p for p in required):
        raise ValueError('Invalid package importInventory: ' + record['id'])
    return required


def manifest_snapshot(path):
    """Bind parsed bytes and freshness metadata to one stable file identity."""
    with open(path, 'rb') as f:
        before = os.fstat(f.fileno()); data = f.read(); after = os.fstat(f.fileno())
    current = os.stat(path)
    def identity(s): return (s.st_dev, s.st_ino, s.st_mtime_ns, s.st_size)
    if identity(before) != identity(after) or identity(after) != identity(current):
        raise ValueError('Package manifest changed during read: ' + path)
    return data, [after.st_mtime_ns, after.st_size], hashlib.sha256(data).hexdigest()


def package_items(src, notes, config=None):
    manifest = package_path(src['root'], src.get('manifest', 'packages.json'))
    data, stamp, digest = manifest_snapshot(manifest)
    try: doc = json.loads(data)
    except ValueError as e: raise ValueError('Invalid packages manifest: ' + manifest) from e
    if not isinstance(doc, dict) or doc.get('schema') != 'asset-review/packages-1' or not isinstance(doc.get('packages'), list):
        raise ValueError('Invalid packages manifest: ' + manifest)
    notes.update(manifest=slash(manifest), manifestStamp=stamp, manifestSha256=digest)
    items = []; seen = set()
    for record in doc['packages']:
        if not isinstance(record, dict): raise ValueError('Package must be an object')
        for field in ('id', 'title', 'kind', 'sourceRoot'):
            if not isinstance(record.get(field), str) or not record[field].strip(): raise ValueError('Package requires ' + field)
        pid = record['id']
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', pid) or pid in seen: raise ValueError('Invalid or duplicate package id: ' + pid)
        seen.add(pid)
        if not os.path.isabs(record['sourceRoot']): raise ValueError('Invalid package sourceRoot: ' + pid)
        readiness = record.get('readiness', 'review-only'); status = record.get('status', 'active')
        if readiness not in READINESS or status not in ('active', 'excluded'): raise ValueError('Invalid package readiness/status: ' + pid)
        for field in ('tags', 'platform', 'importTree'):
            if not isinstance(record.get(field, []), list) or any(not isinstance(x, str) or not x for x in record.get(field, [])):
                raise ValueError('Invalid package ' + field + ': ' + pid)
        for field in ('notes', 'licence', 'entryPoint', 'usageDoc'):
            if field in record and (not isinstance(record[field], str) or (field in ('entryPoint', 'usageDoc') and not record[field])):
                raise ValueError('Invalid package ' + field + ': ' + pid)
        deps = record.get('dependencies', [])
        if not isinstance(deps, list) or any(not isinstance(d, dict) or not isinstance(d.get('path'), str) or not d['path'] or not isinstance(d.get('note', ''), str) for d in deps):
            raise ValueError('Invalid package dependencies: ' + pid)
        review = record.get('review', {})
        if 'entrySha256' in record and (not isinstance(record['entrySha256'], str) or not re.fullmatch(r'[0-9a-fA-F]{64}', record['entrySha256'])):
            raise ValueError('Invalid package entrySha256: ' + pid)
        if not isinstance(review, dict) or review.get('status', 'unknown') not in ('approved', 'unreviewed', 'changes', 'unknown'):
            raise ValueError('Invalid package review: ' + pid)
        root = record['sourceRoot']; errors = []
        children = record.get('importTree', []) + required_files(record) + [d['path'] for d in deps] + [record[f] for f in ('entryPoint', 'usageDoc') if f in record]
        for child in children:
            try: package_path(root, child)
            except ValueError as e: errors.append(str(e))
        it = dict(record, id=src['id'] + ':' + pid, packageId=pid, src=src['id'], type='package', path=slash(root), rel=record.get('entryPoint', ''),
                  tags=record.get('tags', []), licence=record.get('licence', 'unknown'), readiness=readiness, status=status,
                  review=review, importErrors=errors)
        if record['kind'] not in KINDS: it.update(kind=PACKAGE_KIND.get(record['kind'], 'tool'), sourceKind=record.get('sourceKind', record['kind']))
        preview = record.get('preview'); it.pop('preview', None)
        if preview is not None:
            if not isinstance(preview, dict) or not isinstance(preview.get('src'), str) or not isinstance(preview.get('rel'), str):
                raise ValueError('Invalid package preview: ' + pid)
            if file_path(preview['src'], preview['rel'], config):
                it.update(preview=preview['rel'], previewSrc=preview['src'], media=MEDIA[os.path.splitext(preview['rel'])[1].lower()])
        items.append(it)
    return items


def describe(item_id, config=None):
    """Fresh selection receipt. Read and hash source files; never execute or import them."""
    try: srcs = sources(config)
    except SystemExit as e: raise ValueError(str(e)) from e
    packages = [i for s in srcs if s.get('type') == 'packages' for i in package_items(s, {}, config)]
    if len({i['packageId'] for i in packages}) != len(packages): raise ValueError('Duplicate package id across manifests')
    matches = [i for i in packages if i['id'] == item_id]
    if len(matches) != 1: raise ValueError('Package not found or ambiguous: ' + item_id)
    it = matches[0]; root = os.path.realpath(it['sourceRoot']); errors = list(it['importErrors']); paths = {}; tree_files = []
    required = required_files(it)
    declared = [('entryPoint', it.get('entryPoint')), ('usageDoc', it.get('usageDoc'))]
    declared += [('dependency', d['path']) for d in it.get('dependencies', [])] + [('importTree', p) for p in it.get('importTree', [])]
    declared += [('required file', p) for p in required]
    if not it.get('entryPoint'): errors.append('No entryPoint declared')
    def walk_error(error): raise error
    for role, rel in declared:
        if rel is None: continue
        try:
            path = package_path(root, rel)
            if not os.path.exists(path): raise ValueError('Missing %s: %s' % (role, rel))
            if role != 'importTree' and not os.path.isfile(path): raise ValueError('Expected file for %s: %s' % (role, rel))
            paths[rel] = slash(path)
            if role == 'importTree' and os.path.isdir(path):
                for folder, dirs, files in os.walk(path, onerror=walk_error):
                    for name in sorted(dirs + files):
                        child = slash(os.path.relpath(os.path.join(folder, name), root))
                        resolved = package_path(root, child)
                        if (os.path.islink(os.path.join(folder, name)) or getattr(os.path, 'isjunction', lambda p: False)(os.path.join(folder, name))) and os.path.isdir(resolved):
                            raise ValueError('Symlink directory in importTree: ' + child)
                        if name in files:
                            if not os.path.isfile(resolved): raise ValueError('Missing/non-file importTree member: ' + child)
                            tree_files.append(slash(resolved))
                            if len(tree_files) > 10000: raise ValueError('importTree exceeds 10000 files')
            elif role == 'importTree': tree_files.append(slash(path))
        except (OSError, ValueError) as e: errors.append(str(e))
    entry_sha = None
    if it.get('entryPoint') in paths:
        try:
            with open(package_path(root, it['entryPoint']), 'rb') as f: entry_sha = hashlib.file_digest(f, 'sha256').hexdigest()
        except (OSError, ValueError) as e: errors.append(str(e))
    blockers = list(dict.fromkeys(errors))
    expected_sha = it.get('entrySha256')
    if expected_sha and entry_sha and expected_sha.lower() != entry_sha:
        errors.append('Entry SHA256 drift: curator review required; manifest approval does not transfer')
        blockers.append(errors[-1])
    if it['readiness'] not in ('source-ready', 'integration-needed'): blockers.append('Readiness: ' + it['readiness'])
    if it['status'] == 'excluded': blockers.append('Package excluded')
    result = dict(schema='asset-review/selection-1', id=it['id'], packageId=it['packageId'], title=it['title'], sourceRoot=slash(os.path.realpath(root)),
                  entryPoint=paths.get(it.get('entryPoint')), entrySha256=entry_sha, expectedEntrySha256=expected_sha,
                  entryProvenance='matches-manifest' if expected_sha and entry_sha and expected_sha.lower() == entry_sha else 'unverified',
                  importTree=[paths.get(p, p) for p in it.get('importTree', [])],
                  treeFiles=sorted(set(tree_files)), dependencies=[dict(d, resolved=paths.get(d['path'])) for d in it.get('dependencies', [])],
                  usageDoc=paths.get(it.get('usageDoc')), platform=it.get('platform', []), licence=it['licence'], readiness=it['readiness'],
                  importInventory=[paths.get(p, p) for p in required],
                  dependencyCompleteness='declared-files-verified' if required and not errors else 'unverified',
                  review=it['review'], status=it['status'], notes=it.get('notes', ''), sourceVerified=not errors, verified=not blockers, blockers=blockers)
    lines = ['Selection receipt: ' + result['id'], 'Source root: ' + result['sourceRoot'], 'Entry: ' + str(result['entryPoint']),
             'Entry SHA256: ' + str(entry_sha), 'Readiness: ' + result['readiness'], 'Approval (manifest claim): ' + result['review'].get('status', 'unknown'),
             'Licence: ' + result['licence'], 'Platform: ' + ', '.join(result['platform'])]
    lines += ['Expected entry SHA256 (manifest): ' + str(expected_sha), 'Entry provenance: ' + result['entryProvenance'] + '; approval is a manifest claim, never transferred to changed source.']
    lines += ['Import tree: ' + p for p in result['importTree']]
    lines += ['Tree file: ' + p for p in result['treeFiles']]
    lines += ['Required file: ' + p for p in result['importInventory']]
    lines += ['Dependency: %s (%s)' % (d.get('resolved') or d['path'], d.get('note', '')) for d in result['dependencies']]
    lines += ['Dependency completeness: ' + result['dependencyCompleteness'] + '. Existing-file enumeration alone cannot prove required members or dynamic dependencies.']
    lines += ['Usage document: ' + str(result['usageDoc']), 'Instructions: ' + result['notes']]
    lines += ['BLOCKED: ' + b for b in blockers] or ['Source verified. Integration and owner approval remain separate gates.']
    result['brief'] = '\n'.join(lines)
    return result


def stale_reason(doc, config=None, max_age_h=24):
    """Why a non-package index is out of date, or None. Packages keep their curator gate in index_errors()."""
    if not doc: return 'no index'
    try: built = datetime.datetime.fromisoformat(doc['built']).timestamp()
    except (KeyError, ValueError): return 'no build time'
    import time
    if time.time() - built > max_age_h * 3600: return 'older than %d h' % max_age_h
    if os.path.getmtime(config or CONFIG) > built: return 'library-sources.json changed'
    try: srcs = sources(config)
    except (SystemExit, ValueError): return None
    if {s['id'] for s in srcs} != {s['id'] for s in doc['sources']}: return 'source list changed'
    for s in srcs:
        man = {'catalog': 'CATALOG.json', 'cuelib': s.get('manifest', 'library.json')}.get(s.get('type'))
        paths = [os.path.join(s['root'], man)] if man else includes(s)
        for p in paths:
            try:
                if os.path.getmtime(p) > built: return s['id'] + ' changed'
            except OSError: pass
    return None


def index_errors(doc, config=None):
    errors = [s['id'] + ': ' + s['error'] for s in doc['sources'] if s.get('error')]
    indexed = {s['id']: s for s in doc['sources']}
    try: configured = sources(config)
    except (SystemExit, ValueError) as e: return errors + [str(e)]
    configured_packages = {s['id'] for s in configured if s.get('type') == 'packages'}
    indexed_packages = {s['id'] for s in doc['sources'] if s.get('type') == 'packages'}
    if configured_packages != indexed_packages: errors.append('Configured/indexed package sources differ; curator refresh required')
    for src in configured:
        if src.get('type') != 'packages': continue
        try:
            manifest = package_path(src['root'], src.get('manifest', 'packages.json')); _, stamp, digest = manifest_snapshot(manifest)
            info = indexed.get(src['id'], {})
            if info.get('manifest') != slash(manifest) or info.get('manifestStamp') != stamp or info.get('manifestSha256') != digest:
                errors.append('Stale/missing package index: ' + src['id'])
        except (OSError, ValueError) as e: errors.append(str(e))
    return errors


def build(config=None, index=None):
    """Scan every source and write the index (atomic). Returns the index document."""
    srcs = sources(config); items = []; info = []
    for s in srcs:
        notes = {}
        try: got = package_items(s, notes, config) if s.get('type') == 'packages' else catalog_items(s, notes) if s.get('type') == 'catalog' else cuelib_items(s, notes) if s.get('type') == 'cuelib' else folder_items(s, notes)
        except (OSError, ValueError) as e: got = []; notes['error'] = str(e)
        items += got
        info.append(dict({'id': s['id'], 'label': s.get('label') or s['id'], 'type': s.get('type', 'folder'), 'root': slash(s['root']), 'items': len(got)}, **notes))
    package_ids = [i['packageId'] for i in items if i.get('type') == 'package']
    if len(package_ids) != len(set(package_ids)): raise ValueError('Duplicate package id across manifests')
    items.sort(key=lambda i: (KINDS.index(i['kind']) if i['kind'] in KINDS else 99, i['title'].lower(), i['id']))
    counts = {}
    for i in items: counts.setdefault(i['kind'], {'active': 0, 'excluded': 0})[i['status']] += 1
    doc = {'schema': 'asset-review/library-1', 'built': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'sources': info, 'counts': counts, 'items': items}
    path = index or INDEX; os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f: json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    json.load(open(tmp, encoding='utf-8')); os.replace(tmp, path)
    return doc


_CACHE = {}


def load(index=None, rebuild=True):
    """The index with lowercase search fields added; rebuilt when missing, reloaded when the file changed."""
    path = index or INDEX
    if not os.path.isfile(path):
        if not rebuild: return None
        build(None, path)
    stamp = os.path.getmtime(path)
    if _CACHE.get(path, (None,))[0] != stamp:
        doc = load_json(path, None)
        if not isinstance(doc, dict): return None
        for i in doc['items']:
            i['_t'] = i['title'].lower(); i['_g'] = (' '.join(i.get('tags', [])) + ' ' + i['kind'] + ' ' + i.get('group', '')).lower()
            i['_x'] = ((i.get('provenance') or {}).get('prompt', '') + ' ' + ' '.join(i.get('reasons', [])) + ' ' + slash(i.get('rel', '')) + ' ' + slash(i.get('sourceRoot', '')) + ' ' +
                       json.dumps({k: i[k] for k in ('sourceRoot', 'dependencies', 'importTree', 'importInventory', 'usageDoc', 'notes', 'readiness', 'review', 'platform') if k in i}, ensure_ascii=False)).lower()
        _CACHE[path] = (stamp, doc)
    return _CACHE[path][1]


def score(item, term):
    t, g, x = item['_t'], item['_g'], item['_x']
    s = 0
    if re.search(r'\b' + re.escape(term) + r'\b', t): s += 6
    elif len(term) > 3 and re.search(r'\b' + re.escape(term), t): s += 3
    if term in g.split(): s += 4
    elif len(term) > 3 and re.search(r'\b' + re.escape(term), g): s += 2
    if re.search(r'\b' + re.escape(term) + r'\b', x): s += 1.5
    elif len(term) > 3 and re.search(r'\b' + re.escape(term), x): s += 1
    return s


def term_score(item, term):
    return max([score(item, term)] + [0.6 * score(item, w) for w in SYNONYMS.get(term, '').split()])


def search(doc, q='', kind=None, limit=10, offset=0, excluded=False):
    """{'total', 'counts' (per kind, for this query), 'partial', 'items'}. Every word must match; when nothing matches them all, items matching some words are returned (partial)."""
    terms = [t for t in re.split(r'[\s,]+', slash(q).lower()) if t]; kinds = {k for k in str(kind or '').split(',') if k}
    pool = [i for i in doc['items'] if excluded or i['status'] == 'active']
    scored = []
    for i in pool:
        ss = [term_score(i, t) for t in terms]
        scored.append((sum(1 for s in ss if s), sum(ss), i))
    full = [x for x in scored if x[0] == len(terms)]
    partial = bool(terms) and len(terms) > 1 and not full
    hits = [x for x in scored if x[0] > 0] if partial else full
    counts = {}
    for _, _, i in hits: counts[i['kind']] = counts.get(i['kind'], 0) + 1
    if kinds: hits = [x for x in hits if x[2]['kind'] in kinds]
    hits.sort(key=lambda x: (-x[0], -x[1], KINDS.index(x[2]['kind']) if x[2]['kind'] in KINDS else 99, x[2]['title'].lower(), x[2]['id']))
    if terms:  # one row per look-alike: repeats of one kind+title become a variant count on the best hit
        best = {}; keep = []
        for x in hits:
            k = (x[2]['kind'], x[2]['title'].lower())
            if k in best: best[k] += 1; continue
            best[k] = 1; keep.append(x)
        for x in keep: x[2]['_n'] = best[(x[2]['kind'], x[2]['title'].lower())]
        hits = keep
    if not terms and not kinds:  # browsing: interleave kinds, repeats of one title come later
        seen, nth = {}, {}
        for x in hits:
            n = seen.get((x[2]['kind'], x[2]['title']), 0); seen[(x[2]['kind'], x[2]['title'])] = n + 1
            if n == 0: nth[x[2]['kind']] = nth.get(x[2]['kind'], 0) + 1
            x[2]['_o'] = (n, nth.get(x[2]['kind'], 0))
        hits.sort(key=lambda x: (x[2]['_o'], KINDS.index(x[2]['kind']) if x[2]['kind'] in KINDS else 99))
    out = [dict({k: v for k, v in x[2].items() if not k.startswith('_')}, **({'variants': x[2]['_n']} if terms and x[2].get('_n', 1) > 1 else {})) for x in hits[offset:offset + limit]]
    return {'total': len(hits), 'counts': counts, 'partial': partial, 'items': out}


def file_path(src_id, rel, config=None):
    """Absolute path of a servable library file, or None. Only media files inside a configured folder; no '..', no drive or stream syntax, symlinks resolved first."""
    rel = str(rel or '')
    if not rel or '\0' in rel or ':' in rel or rel.startswith(('/', '\\')) or '..' in slash(rel).split('/') or os.path.splitext(rel)[1].lower() not in MEDIA: return None
    src = next((s for s in sources(config) if s['id'] == src_id), None)
    if not src or src.get('type') == 'packages': return None
    root = os.path.realpath(src['root']); p = os.path.realpath(os.path.join(root, rel))
    if os.path.splitext(p)[1].lower() not in MEDIA: return None
    for base in includes(src):
        base = os.path.realpath(base)
        try:
            if os.path.commonpath([os.path.normcase(root), os.path.normcase(base)]) != os.path.normcase(root): continue
            if os.path.commonpath([os.path.normcase(base), os.path.normcase(p)]) == os.path.normcase(base) and os.path.isfile(p): return p
        except ValueError: continue
    return None


def short(i):
    return '%-8s %s  [%s]  %s' % (i['kind'], i['title'], ', '.join(i.get('tags', [])[:5]), i['path'])


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest='cmd', required=True)
    for n in ('build', 'search', 'describe'):
        sp = sub.add_parser(n); sp.add_argument('--config'); sp.add_argument('--index')
    sp = sub.choices['describe']; sp.add_argument('id'); sp.add_argument('--json', action='store_true')
    sp = sub.choices['search']; sp.add_argument('query', nargs='*'); sp.add_argument('--kind'); sp.add_argument('--limit', type=int, default=10); sp.add_argument('--json', action='store_true'); sp.add_argument('--excluded', action='store_true', help='include excluded items')
    return run(p.parse_args(argv))


def run(a):
    if a.cmd == 'describe':
        try: receipt = describe(a.id, a.config)
        except (OSError, ValueError) as e: raise SystemExit('ERROR ' + str(e))
        print(json.dumps(receipt, ensure_ascii=False, indent=2) if a.json else receipt['brief'])
        if not receipt['verified']: raise SystemExit(1)
        return
    if a.cmd == 'build':
        doc = build(a.config, a.index)
        print('LIBRARY %s  %d items from %d sources' % (a.index or INDEX, len(doc['items']), len(doc['sources'])))
        for k in KINDS:
            if k in doc['counts']: print('  %-8s %5d active %5d excluded' % (k, doc['counts'][k]['active'], doc['counts'][k]['excluded']))
        for s in doc['sources']: print('  source %-12s %5d items%s' % (s['id'], s['items'], '  (%d catalogued folders missing)' % s['missing'] if s.get('missing') else '') + ('  ERROR ' + s['error'] if s.get('error') else ''))
        if any(s.get('error') for s in doc['sources']): raise SystemExit(1)
        return
    doc = load(a.index, rebuild=False)
    why = stale_reason(doc, a.config)
    if why and not (doc and index_errors(doc, a.config)):
        doc = build(a.config, a.index); doc = load(a.index or INDEX, rebuild=False); print('LIBRARY rebuilt (%s)' % why, file=sys.stderr)
    if not doc: raise SystemExit('ERROR no library index; ask the curator for an explicit refresh')
    errors = index_errors(doc, a.config)
    if errors: raise SystemExit('ERROR library curator refresh required: ' + '; '.join(errors))
    res = search(doc, ' '.join(a.query), a.kind, a.limit, 0, a.excluded)
    if a.json: return print(json.dumps(res['items'], ensure_ascii=False, indent=1))
    print('%d hits%s' % (res['total'], ' (partial: no item matches every word)' if res['partial'] else ''))
    for i in res['items']: print('  ' + short(i))


if __name__ == '__main__':
    if sys.stdout and sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8': sys.stdout.reconfigure(encoding='utf-8')
    main()
