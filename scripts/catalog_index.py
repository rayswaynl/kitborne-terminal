"""Rebuildable, root-local home summaries. No source files are written.

Only page() is the facade. The JSON index is disposable derived state, atomically
replaced after a stable read. Dependency polling remains portable and is
coalesced for REFRESH_TTL seconds; catalog/index replacements bypass the TTL.
The existing viewer/detail catalog API is independent of this index.
"""
import copy
import hashlib
import json
import os
import threading
import time
import urllib.parse

import review

INDEX_NAME = '.catalog-summary-index.json'
INDEX_VERSION = 1
REFRESH_TTL = 0.25  # seconds; sidecar changes become visible at the next poll
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_JSON_DEPTH = 64
MAX_ASSETS = 10000
GROUPS = [('game', 'Game'), ('web', 'Website'), ('sound', 'Sound'),
          ('video', 'Video'), ('story', 'Story & print'), ('asset', 'Assets')]
_CACHE = {}
_LOCK = threading.RLock()
_ROOT_LOCKS = {}


class BudgetError(ValueError):
    """Input exceeds the home catalog's bounded refresh work."""


def _load_json(path, default):
    """Bound bytes and nesting before the JSON decoder allocates containers."""
    try:
        with open(path, 'rb') as handle:
            raw = handle.read(MAX_JSON_BYTES + 1)
    except FileNotFoundError:
        return default
    _check_json_budget(raw, path)
    return json.loads(raw)


def _check_json_budget(raw, path):
    if len(raw) > MAX_JSON_BYTES:
        raise BudgetError('catalog JSON size budget exceeded (%d bytes): %s' % (MAX_JSON_BYTES, path))
    depth, quoted, escaped = 0, False, False
    for char in raw:
        if quoted:
            if escaped: escaped = False
            elif char == 92: escaped = True
            elif char == 34: quoted = False
        elif char == 34: quoted = True
        elif char in (123, 91):
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise BudgetError('catalog JSON depth budget exceeded (%d): %s' % (MAX_JSON_DEPTH, path))
        elif char in (125, 93): depth -= 1


def _validate_catalog(cat):
    if not isinstance(cat, dict) or not isinstance(cat.get('assets'), dict):
        raise ValueError('catalog assets must be an object')
    if len(cat['assets']) > MAX_ASSETS:
        raise BudgetError('catalog asset-count budget exceeded (%d)' % MAX_ASSETS)
    if cat.get('project') is not None and not isinstance(cat['project'], str):
        raise ValueError('catalog project must be a string')
    for aid, asset in cat['assets'].items():
        if not isinstance(asset, dict) or not isinstance(asset.get('stages'), dict):
            raise ValueError('catalog asset stages must be an object: ' + aid)
        if asset.get('name') is not None and not isinstance(asset['name'], str):
            raise ValueError('catalog asset name must be a string: ' + aid)
        if asset.get('route') is not None and not isinstance(asset['route'], str):
            raise ValueError('catalog asset route must be a string: ' + aid)
        for stage in asset['stages'].values():
            if not isinstance(stage, dict) or not isinstance(stage.get('versions'), list):
                raise ValueError('catalog stage versions must be an array: ' + aid)
            if not isinstance(stage.get('status', 'empty'), str):
                raise ValueError('catalog stage status must be a string: ' + aid)
            for ver in stage['versions']:
                if not isinstance(ver, dict) or type(ver.get('v')) is not int or ver['v'] < 1:
                    raise ValueError('catalog version must have a positive integer v: ' + aid)
                if not isinstance(ver.get('files', []), list) or not isinstance(ver.get('meta', {}), dict):
                    raise ValueError('catalog version files/meta have invalid types: ' + aid)
                if ver.get('at') is not None and not isinstance(ver['at'], str):
                    raise ValueError('catalog version at must be a string: ' + aid)
                if ver.get('thumb') is not None and not isinstance(ver['thumb'], str):
                    raise ValueError('catalog version thumb must be a string: ' + aid)
                for file in ver.get('files', []):
                    if not isinstance(file, dict) or not isinstance(file.get('name'), str):
                        raise ValueError('catalog file name must be a string: ' + aid)
                if not isinstance(ver.get('feedback') or {}, dict):
                    raise ValueError('catalog version feedback must be an object: ' + aid)
                render = ver.get('meta', {}).get('render', {})
                if (not isinstance(render, dict) or not isinstance(render.get('previews') or [], list)
                        or any(not isinstance(p, dict) for p in render.get('previews') or [])
                        or (render.get('hash') is not None and not isinstance(render['hash'], str))):
                    raise ValueError('catalog render metadata has invalid types: ' + aid)
                if any(p.get('sheet') is not None and not isinstance(p['sheet'], str)
                       for p in render.get('previews') or []):
                    raise ValueError('catalog render sheet must be a string: ' + aid)


def _valid_state(state, root):
    """Validate disposable state only; canonical input errors must propagate."""
    try:
        if (not isinstance(state, dict) or state['index_version'] != INDEX_VERSION
                or state['root'] != root or not isinstance(state['revision'], str)):
            return False
        _validate_catalog(state['catalog'])
        assets = state['catalog']['assets']
        records, digests = state['records'], state['digests']
        if not isinstance(records, dict) or not isinstance(digests, dict): return False
        if records.keys() != assets.keys() or digests.keys() != assets.keys(): return False
        def signature(sig):
            return sig is None or (isinstance(sig, list) and len(sig) == 4
                                   and all(type(n) is int for n in sig))
        if not signature(state['catalog_sig']): return False
        for aid, rec in records.items():
            if not isinstance(digests[aid], str) or digests[aid] != _digest(assets[aid]): return False
            if not isinstance(rec, dict) or rec['source'] != digests[aid]: return False
            if any(not isinstance(rec[key], list) or any(not isinstance(v, str) for v in rec[key])
                   for key in ('links', 'extra')): return False
            if not isinstance(rec['linked'], dict) or rec['linked'] != {lid: digests.get(lid) for lid in rec['links']}:
                return False
            if not isinstance(rec['sig'], list): return False
            for path, sig in rec['sig']:
                if not isinstance(path, str): return False
                if not signature(sig):
                    if not isinstance(sig, list) or any(not isinstance(name, str) or not signature(st)
                                                      for name, st in sig): return False
            summary = rec['summary']
            if not isinstance(summary, dict) or not isinstance(summary['open_by'], dict): return False
            if any(type(summary[k]) is not int or summary[k] < 0 for k in ('waiting', 'feedback')): return False
            if any(type(n) is not int or n < 0 for n in summary['open_by'].values()): return False
            for role in ('owner', 'commenter'):
                row = summary[role]
                if set(row) != {'id', 'name', 'group', 'stage', 'v', 'status', 'progress', 'thumbnail'}: return False
                if row['id'] != aid or any(not isinstance(row[k], str) for k in ('name', 'group', 'status')):
                    return False
                if row['stage'] is not None and not isinstance(row['stage'], str): return False
                if row['v'] is not None and type(row['v']) is not int: return False
                if row['thumbnail'] is not None and not isinstance(row['thumbnail'], str): return False
                if set(row['progress']) != {'approved', 'total', 'pct'}: return False
                if any(type(row['progress'][k]) is not int for k in ('approved', 'total', 'pct')): return False
            new = summary['new']
            if new is not None:
                if (not isinstance(new, dict) or not isinstance(new['key'], str)
                        or (new['at'] is not None and not isinstance(new['at'], str))
                        or not isinstance(new['commenters'], list)
                        or any(not isinstance(pid, str) for pid in new['commenters'])): return False
        return True
    except (KeyError, TypeError, ValueError):
        return False


def _ordered(records):
    groups = {g: i for i, (g, _) in enumerate(GROUPS)}
    rank = {'in_review': 0, 'changes': 1, 'gate': 1, 'rejected': 1, 'approved': 2}
    def key(aid, role):
        row = records[aid]['summary'][role]
        return groups.get(row['group'], len(groups)), rank.get(row['status'], 1), row['name'].casefold(), aid
    return {role: sorted(records, key=lambda aid: key(aid, role)) for role in ('owner', 'commenter')}


def _root_lock(root):
    with _LOCK:
        return _ROOT_LOCKS.setdefault(root, threading.RLock())


def _stat(path):
    try:
        st = os.stat(path)
        return [st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino]
    except FileNotFoundError:
        return None


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def _dependencies(root, aid, asset, extra):
    files, directories = set(extra), set()
    for sid, stage in asset['stages'].items():
        for ver in stage['versions']:
            d = review.vdir(root, aid, sid, ver['v'])
            directories.add(os.path.join(d, 'comments'))
            files.update(os.path.join(d, name) for name in ('feedback.json', 'review.json'))
            render = ver.get('meta', {}).get('render', {})
            if render.get('hash'):
                from auto_render import job_path
                files.add(str(job_path(root, render['hash'])))
    manifest = review.approved_manifest(root, aid, asset) if asset.get('route') == 'game' else None
    if manifest:
        files.add(manifest)
    sig = [[p, _stat(p)] for p in sorted(files)]
    for path in sorted(directories):
        try:
            with os.scandir(path) as entries:
                listing = sorted([e.name, _stat(e.path)] for e in entries if e.name.endswith('.json'))
        except FileNotFoundError:
            listing = None
        sig.append([path, listing])
    return sig


def _game_inputs(root, aid, asset):
    path = review.approved_manifest(root, aid, asset) if asset.get('route') == 'game' else None
    doc = _load_json(path, {}) if path else {}
    if not isinstance(doc, dict) or not isinstance(doc.get('entries', []), list):
        raise ValueError('catalog game manifest entries must be an array: ' + str(path))
    entries = doc.get('entries', [])
    links, files = set(), set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('catalog game manifest entry must be an object: ' + str(path))
        if entry.get('class') in ('hero', 'kit') and isinstance(entry.get('asset'), str):
            links.add(entry['asset'])
        screenshot = entry.get('screenshot')
        if isinstance(screenshot, str) and review.SAFE.fullmatch(screenshot):
            files.add(os.path.join(os.path.dirname(path), screenshot))
    return sorted(links), sorted(files)


def _thumbnail(root, aid, sid, ver):
    if not ver: return None
    render = ver.get('meta', {}).get('render', {})
    previews = render.get('previews') or []
    sheet = previews[0].get('sheet') if render.get('status') == 'done' and previews else None
    files = ver.get('files', [])
    image = next((f['name'] for f in files if f.get('media') == 'image'), None)
    pdf = next((f for f in files if f.get('media') == 'pdf' and f.get('pages')), None)
    model = next((f['name'] for f in files if f['name'].lower().endswith('.glb')), None)
    name = ('renders/' + render['hash'] + '/' + sheet) if sheet else ver.get('thumb') or image
    if not name and pdf: name = 'pages/' + pdf['name'] + '/p001.png'
    if not name and model: name = 'renders/' + model + '.turntable.png'
    if not name: return None
    return '/data/' + '/'.join(urllib.parse.quote(str(p), safe='') for p in
        (aid, sid, 'v%03d' % ver['v'], *name.replace('\\', '/').split('/'))) + '?p=' + review.project_id(root)


def _summarize(root, aid, asset, people):
    """One recomputation per asset, shared by every role/person/page projection."""
    route = review.route_of(asset)
    approved = sum(review.stage_approved(asset['stages'].get(sid)) for sid in route)
    total = len(route) or 1
    entries = [(sid, asset['stages'][sid]) for sid in review.STAGE_IDS
               if asset['stages'].get(sid, {}).get('versions')]
    def row(owner):
        def rank(entry):
            st = entry[1]
            return (0 if owner and st.get('stuck') else 1 if st.get('status') == 'in_review'
                    else 2 if st.get('status') in ('changes', 'gate', 'rejected') else 3)
        # Stable newest-first ordering preserves stage order for equal timestamps.
        ordered = sorted(entries, key=lambda e: e[1]['versions'][-1].get('at') or '', reverse=True)
        ordered.sort(key=rank)
        sid, st = ordered[0] if ordered else (None, {})
        ver = st['versions'][-1] if st else None
        return dict(id=aid, name=asset.get('name') or aid, group=review.ROUTE_GROUP.get(asset.get('route'), 'asset'),
                    stage=sid, v=ver['v'] if ver else None, status=st.get('status', 'empty'),
                    progress=dict(approved=approved, total=total, pct=int(100 * approved / total + .5)),
                    thumbnail=_thumbnail(root, aid, sid, ver))
    waiting, feedback, open_by = 0, 0, {}
    for sid, st in entries:
        ver = st['versions'][-1]
        if st.get('status') != 'gate':
            rv = _load_json(os.path.join(review.vdir(root, aid, sid, ver['v']), 'review.json'), None)
            if not rv or rv.get('draft'): waiting += 1
        for ver in st['versions']:
            feedback += bool((ver.get('feedback') or {}).get('status') == 'open')
            for pid, doc in people.get((sid, ver['v']), {}).items():
                open_by[pid] = open_by.get(pid, 0) + sum(n.get('status', 'open') == 'open' for n in doc.get('comments', []))
    newest = max(entries, key=lambda e: e[1]['versions'][-1].get('at') or '', default=None)
    new = None
    if newest:
        sid, st = newest; ver = st['versions'][-1]
        new = dict(at=ver.get('at'), key='%s/%s/%d' % (aid, sid, ver['v']),
                   commenters=[pid for pid, doc in people.get((sid, ver['v']), {}).items() if doc.get('comments')])
    return dict(owner=row(True), commenter=row(False), waiting=waiting, feedback=feedback, open_by=open_by, new=new)


def _refresh(root):
    path = os.path.join(root, INDEX_NAME)
    disk_sig = _stat(path)
    cached = _CACHE.get(root)
    catalog_path = os.path.join(root, 'catalog.json')
    if (cached and cached[0] == disk_sig and cached[1]['catalog_sig'] == _stat(catalog_path)
            and time.monotonic() < cached[2]):
        return cached[1]
    state = cached[1] if cached and cached[0] == disk_sig else None
    if state is None:
        try: state = _load_json(path, None)
        except BudgetError: raise
        except (ValueError, OSError): state = None
        if not _valid_state(state, root):
            state = dict(index_version=INDEX_VERSION, root=root, records={})
    # Replace records on write; never mutate a committed snapshot during retries.
    state = dict(state, records=dict(state['records']))
    for _ in range(3):
        catalog_sig = _stat(os.path.join(root, 'catalog.json'))
        changed = state.get('catalog_sig') != catalog_sig or 'catalog' not in state
        if changed:
            cat = _load_json(catalog_path, {'assets': {}})
            _validate_catalog(cat)
            if _stat(os.path.join(root, 'catalog.json')) != catalog_sig: continue
            state['catalog'] = cat
            state['digests'] = {aid: _digest(asset) for aid, asset in cat['assets'].items()}
        cat, digests = state['catalog'], state['digests']
        records = state['records']
        for aid in set(records) - set(cat['assets']):
            del records[aid]; changed = True
        for aid, source in cat['assets'].items():
            old = records.get(aid, {})
            sig = _dependencies(root, aid, source, old.get('extra', []))
            linked = {lid: digests.get(lid) for lid in old.get('links', [])}
            if old.get('source') == digests[aid] and old.get('sig') == sig and old.get('linked') == linked:
                continue
            links, extra = _game_inputs(root, aid, source)
            before = _dependencies(root, aid, source, extra)
            asset = copy.deepcopy(source)
            assets = dict(cat['assets'], **{aid: asset}) if source.get('route') == 'game' else {aid: asset}
            derived = dict(cat, assets=assets)
            review.game_stale(root, derived, asset_ids=[aid])
            people = review.catalog_asset(root, aid, asset, load_json=_load_json, missing=False)
            summary = _summarize(root, aid, asset, people)
            after = _dependencies(root, aid, source, extra)
            if before != after: break
            records[aid] = dict(source=digests[aid], sig=after, links=links, extra=extra,
                                linked={lid: digests.get(lid) for lid in links}, summary=summary)
            changed = True
        else:
            if _stat(os.path.join(root, 'catalog.json')) != catalog_sig: continue
            # Catch changes to an earlier asset while a later one was being read.
            if any(rec['sig'] != _dependencies(root, aid, cat['assets'][aid], rec['extra'])
                   for aid, rec in records.items()): continue
            state['catalog_sig'] = catalog_sig
            if changed or disk_sig is None:
                state['revision'] = _digest([catalog_sig, [(aid, rec['sig'], rec['linked']) for aid, rec in records.items()]])
                _check_json_budget(json.dumps(state, indent=1, ensure_ascii=False).encode('utf-8'), path)
                review.jsave(path, state)
                disk_sig = _stat(path)
            _CACHE[root] = disk_sig, state, time.monotonic() + REFRESH_TTL, _ordered(records)
            return state
    raise RuntimeError('summary inputs changed during three reads: ' + root)


def page(root, project=None, *, role='owner', person=None, offset=0, limit=100,
         query='', group=None, status=None, authorized_ids=None):
    """Page v1: authorize/project first, filter and order the whole set, then slice.

    The HTTP handler supplies the trusted role and identity. authorized_ids is an
    optional internal allowlist, never accepted from HTTP query parameters.
    """
    if role not in ('owner', 'commenter'): raise PermissionError('Project not authorized')
    if offset < 0 or not 1 <= limit <= 2000: raise ValueError('offset >= 0 and 1 <= limit <= 2000 required')
    person = person or {}
    root = os.path.abspath(root)
    with _root_lock(root):
        state = _refresh(root)
        allowed = set(authorized_ids) if authorized_ids is not None else None
        seen = _load_json(review.seen_path(root, person.get('person', '')), {}) if role == 'commenter' else {}
        rows, total = [], 0
        needle = query.strip().casefold()
        for aid in _CACHE[root][3][role]:
            if allowed is not None and aid not in allowed: continue
            summary = state['records'][aid]['summary']
            source_row = summary[role]
            if needle not in (source_row['name'] + ' ' + aid).casefold(): continue
            if group is not None and source_row['group'] != group: continue
            if status is not None and source_row['status'] != status: continue
            total += 1
            if total <= offset or len(rows) >= limit: continue
            row = copy.deepcopy(summary[role])
            if role == 'owner':
                row['counts'] = dict(waiting=summary['waiting'], comments=sum(n for pid, n in summary['open_by'].items()
                                    if pid != person.get('person')))
                if person.get('admin'): row['counts']['feedback'] = summary['feedback']
            else:
                new = summary['new']
                row['counts'] = dict(new=int(bool(new and review.stamp(new['at']) >= time.time() - 7 * 86400
                    and person.get('person') not in new['commenters'] and new['key'] not in seen)))
            rows.append(row)
        return dict(schema_version=1, project=state['catalog'].get('project') or project or os.path.basename(root),
                    revision=state['revision'], stages=[dict(id=i, label=l, group=review.STAGE_GROUP[i]) for i, l, _, _ in review.STAGES],
                    groups=[dict(id=g, label=label) for g, label in GROUPS], items=rows,
                    total=total, offset=offset, limit=limit)
