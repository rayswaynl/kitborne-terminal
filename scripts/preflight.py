"""Pre-flight facts and lock checks (pinned numpy; Pillow optional for image locks).

preflight(path, media, stage, meta, policy=resolved_policy) -> {'stats': {...}, 'warn': [...], 'block': [...]}   written into catalog.json per file
                                        block = hard failures: the version goes back to the agent before the reviewer sees it (the gate)
                                        audio includes stereo_cancellation and pcm_diagnostics advisories, independent of the gate
lock_check(locks, old_dir, new_dir) -> [{'note', 'target', 'result'}]     result: unchanged | changed | missing | not_checked
"""
import array, base64, hashlib, json, math, os, re, shutil, struct, subprocess, sys, urllib.parse, wave
from contextvars import ContextVar
# Match review.py's sibling imports for package and direct file entry points.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if __package__:
    from .provenance_policy import TrustedPolicy
else:
    from provenance_policy import TrustedPolicy

COMP = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
FULL_STATS_LIMIT = 150 * 1024 ** 2
JSON_LIMIT = DATA_URI_LIMIT = 16 * 1024 ** 2
RESOURCE_TOTAL_LIMIT = 512 * 1024 ** 2
_URI_SIZES = ContextVar('preflight_uri_sizes', default=None)
_BASE64_PAYLOAD = re.compile(r'[A-Za-z0-9+/]*={0,2}')
_PERCENT_ESCAPE = re.compile(r'%[0-9A-Fa-f]{2}')
_BASE64_WHITESPACE = str.maketrans('', '', ' \r\n\t')


class ResourceError(ValueError):
    pass


class MalformedModel(ValueError):
    def __init__(self, message, validator_safe=True):
        super().__init__(message)
        self.validator_safe = validator_safe


class UnverifiedModel(ValueError):
    pass


class _ModelDocumentBudget:
    """Use preflight's byte ceilings, including bounded JSON container overhead."""
    def __init__(self, source_size=0):
        self.used = {'bytes': 0, 'operations': 0}
        self.chunks = 0
        self.source_size = source_size

    def reserve(self, **amounts):
        # Reserving the on-disk source does not allocate its geometry payload.
        limits = {'bytes': self.source_size + RESOURCE_TOTAL_LIMIT + 64 * JSON_LIMIT,
                  'operations': JSON_LIMIT + FULL_STATS_LIMIT // 8}
        for key, amount in amounts.items():
            if self.used[key] + amount > limits[key]:
                raise UnverifiedModel('model document exceeds %s limit' % key)
            self.used[key] += amount

    def reserve_chunk(self):
        self.chunks += 1
        if self.chunks > 64:
            raise MalformedModel('GLB chunk count exceeds 64 limit', validator_safe=False)
        self.reserve(operations=1)

    def reserve_json(self, size):
        if size > JSON_LIMIT:
            raise UnverifiedModel('model JSON exceeds 16 MiB verification limit')
        self.reserve(bytes=size * 64, operations=size)


def model_structure(path):
    """Admit structure before stats/validator reads; never decode geometry here."""
    # Missing input diagnostics belong to the existing stats/validator boundaries.
    if not os.path.exists(path): return
    if __package__:
        from . import analysis_mesh as reader
    else:
        import analysis_mesh as reader
    try:
        try:
            g, binary = reader._document(path, _ModelDocumentBudget(os.path.getsize(path)))
        except reader.MeshError as error:
            if os.path.getsize(path) <= FULL_STATS_LIMIT or str(error) != 'invalid GLB header': raise
            # The protected header-only path permits trailing padding. Reuse the
            # confined preflight reader, which bounds the entire declared table.
            g, binary = gltf_document(path)
            reader._require(reader._object(g).get('asset', {}).get('version') == '2.0', 'expected glTF 2.0')
        buffers = reader._list(g.get('buffers', []))
        views = reader._list(g.get('bufferViews', []))

        def compressed(item):
            extensions = reader._object(item.get('extensions', {}))
            return [reader._object(extensions[name]) for name in
                    ('EXT_meshopt_compression', 'KHR_meshopt_compression') if name in extensions]

        lengths, physical_lengths = [], []
        for index, buffer in enumerate(buffers):
            buffer = reader._object(buffer)
            length = reader._integer(buffer.get('byteLength'), 'buffer length')
            lengths.append(length)
            # Known meshopt fallback buffers can be virtual and lack a URI/BIN.
            virtual = any(extension.get('fallback') is True for extension in compressed(buffer))
            uri = buffer.get('uri')
            if uri:
                available = _resource_uri_size(uri) if uri.startswith('data:') else os.path.getsize(resource_path(path, uri))
            elif index == 0 and binary is not None:
                available = binary[1]
            else:
                reader._require(virtual, 'missing glTF buffer')
                available = None
            physical_lengths.append(available)
            if available is not None:
                reader._require(length <= available, 'declared buffer exceeds resource')

        for view in views:
            view = reader._object(view)
            index = reader._integer(view.get('buffer', 0), 'buffer')
            reader._item(buffers, index)
            offset = reader._integer(view.get('byteOffset', 0), 'bufferView offset')
            size = reader._integer(view.get('byteLength'), 'bufferView length')
            reader._require(offset + size <= lengths[index], 'bufferView exceeds buffer')
            for extension in compressed(view):
                # Preserve explicitly unsupported empty descriptors used by fixtures.
                if not extension: continue
                source = reader._integer(extension.get('buffer'), 'compressed buffer')
                reader._item(buffers, source)
                start = reader._integer(extension.get('byteOffset', 0), 'compressed offset')
                size = reader._integer(extension.get('byteLength'), 'compressed length')
                reader._require(start + size <= lengths[source], 'compressed view exceeds buffer')
                reader._require(physical_lengths[source] is not None and start + size <= physical_lengths[source],
                                'compressed source exceeds resource')

        for accessor in reader._list(g.get('accessors', [])):
            accessor = reader._object(accessor)
            if 'bufferView' not in accessor: continue  # Sparse/implicit data stays supported.
            view = reader._item(views, accessor['bufferView'])
            component = struct.calcsize(COMP[accessor['componentType']])
            kind = accessor['type']
            if kind in ('MAT2', 'MAT3', 'MAT4'):
                columns = int(kind[-1])
                element = columns * ((columns * component + 3) // 4 * 4)
            else:
                element = component * NCOMP[kind]
            count = reader._integer(accessor.get('count'), 'accessor count')
            offset = reader._integer(accessor.get('byteOffset', 0), 'accessor offset')
            stride = reader._integer(view.get('byteStride', element), 'accessor stride')
            reader._require(stride >= element, 'accessor stride smaller than element')
            span = (count - 1) * stride + element if count else 0
            reader._require(offset + span <= view['byteLength'], 'accessor exceeds bufferView')
    except ResourceError:
        raise
    except (MalformedModel, UnverifiedModel):
        raise
    except RecursionError as error:
        raise MalformedModel('model JSON nesting too deep', validator_safe=False) from error
    except OSError as error:
        # Do not expose an absolute local resource path in catalog diagnostics.
        raise MalformedModel('model resource unavailable') from error
    except (ValueError, KeyError, TypeError, AttributeError, IndexError, struct.error) as error:
        if type(error) is ValueError and str(error) == 'glTF JSON exceeds 16 MiB limit':
            raise UnverifiedModel(str(error)) from error
        raise MalformedModel(str(error), validator_safe=str(error) != 'input must be a regular file') from error


def resource_path(path, uri):
    decoded = urllib.parse.unquote(uri)
    if (re.search(r'[?#\\\\]|%(?:23|3f|2f|5c)', uri, re.I)
            or re.search(r'[?#\\\\%]', decoded) or '..' in decoded.split('/')):
        raise ResourceError('glTF resource refused: must stay inside submission directory: %s' % uri)
    parts = urllib.parse.urlsplit(decoded)
    root = os.path.realpath(os.path.dirname(os.path.abspath(path)))
    target = os.path.realpath(os.path.join(root, parts.path))
    if (parts.scheme or parts.netloc or os.path.isabs(parts.path)
            or re.match(r'^[A-Za-z]:', decoded) or decoded.startswith(('\\', '/'))
            or os.path.splitdrive(root)[0].lower() != os.path.splitdrive(target)[0].lower()
            or os.path.commonpath([root, target]) != root):
        raise ResourceError('glTF resource refused: must stay inside submission directory: %s' % uri)
    return target


def _model_resources(g):
    # Inspect every recognizable URI even if adjacent schema fields are broken.
    # The external validator may diagnose those fields only after confinement.
    if isinstance(g, dict):
        for key in ('buffers', 'images'):
            items = g.get(key, [])
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict): yield item


def check_resources(path, g):
    resources = {}
    for item in _model_resources(g):
        uri = item.get('uri')
        if not isinstance(uri, str): continue
        if uri and not uri.startswith('data:'): resources[uri] = resource_path(path, uri)
        elif uri: _resource_uri_size(uri)
    sizes = [os.path.getsize(target) for target in set(resources.values())]
    if any(size > FULL_STATS_LIMIT for size in sizes):
        raise ResourceError('glTF resource exceeds 150 MiB limit')
    if resource_workload_bytes(path, g, resources) > RESOURCE_TOTAL_LIMIT:
        raise ResourceError('glTF aggregate resource exceeds 512 MiB limit')
    return resources


def resource_bytes(path, g):
    return os.path.getsize(path) + sum(os.path.getsize(p) for p in set(check_resources(path, g).values()))


def resource_workload_bytes(path, g, resources=None):
    if resources is None: resources = check_resources(path, g)
    sizes = {p: os.path.getsize(p) for p in set(resources.values())}
    total = os.path.getsize(path) + sum(sizes.values())
    for item in _model_resources(g):
        uri = item.get('uri')
        if not isinstance(uri, str): continue
        if uri in resources: total += sizes[resources[uri]]
        elif uri: total += _resource_uri_size(uri)
    return total


def data_uri_size(uri):
    comma = uri.index(','); length = len(uri) - comma - 1
    base64_data = uri.find(';base64', 0, comma) >= 0
    upper = length * 3 // 4 if base64_data else length
    if upper > DATA_URI_LIMIT: raise ResourceError('data URI exceeds 16 MiB limit')
    # The pre-check bounds all temporary strings before splitting/normalizing.
    payload = uri[comma + 1:]
    if base64_data:
        payload = payload.translate(_BASE64_WHITESPACE)
        if len(payload) % 4: raise ValueError('invalid base64 data URI padding')
        if not _BASE64_PAYLOAD.fullmatch(payload): raise ValueError('invalid base64 data URI')
        padding = 2 if payload.endswith('==') else 1 if payload.endswith('=') else 0
        size = len(payload) * 3 // 4 - padding
    else:
        size = len(payload.encode('utf-8')) - 2 * len(_PERCENT_ESCAPE.findall(payload))
    if size > DATA_URI_LIMIT: raise ResourceError('data URI exceeds 16 MiB limit')
    return size


def _resource_uri_size(uri):
    cache = _URI_SIZES.get()
    if cache is None: return data_uri_size(uri)
    if uri not in cache: cache[uri] = data_uri_size(uri)
    return cache[uri]


def validate_gltf(path):
    if os.path.isfile(path) and os.path.getsize(path) > FULL_STATS_LIMIT:
        return {'available': False, 'errors': None, 'warnings': None, 'messages': ['validator skipped: file exceeds 150 MiB limit']}
    try:
        gltf_document(path)  # reject resources before any external validator can read them
    except OSError:
        return {'available': False, 'errors': None, 'warnings': None, 'messages': ['model resource unavailable']}
    except RecursionError:
        return {'available': False, 'errors': None, 'warnings': None, 'messages': ['model JSON nesting too deep']}
    except MalformedModel as e:
        if not e.validator_safe:
            return {'available': False, 'errors': None, 'warnings': None, 'messages': [str(e)]}
    except ResourceError as e:
        return {'available': False, 'errors': None, 'warnings': None, 'messages': [str(e)]}
    except (ValueError, KeyError, TypeError, AttributeError, IndexError, struct.error) as e:
        if (isinstance(e, UnverifiedModel) or str(e).startswith('GLB chunk count exceeds ')
                or str(e) == 'glTF JSON exceeds 16 MiB limit'):
            return {'available': False, 'errors': None, 'warnings': None, 'messages': [str(e)]}
        # Malformed geometry still earns the external validator's diagnostic report.
    local_wrapper = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'staged', 'validate.mjs')
    wrapper = os.environ.get('ASSET_REVIEW_VALIDATOR', local_wrapper if os.path.isfile(local_wrapper) else 'D:/AI/tools/asset-pipeline/validate.mjs')
    node = shutil.which('node')
    if not node or not os.path.isfile(wrapper): return {'available': False, 'errors': None, 'warnings': None, 'messages': ['validator unavailable']}
    try:
        result = subprocess.run([node, wrapper, os.path.abspath(path), '--json'], capture_output=True, text=True, encoding='utf-8', timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        report = json.loads(result.stdout); issues = report['issues']
        return {'available': True, 'errors': issues['numErrors'], 'warnings': issues['numWarnings'],
                'version': report.get('validatorVersion'), 'messages': [{'code': m.get('code'), 'message': m.get('message'), 'severity': m.get('severity'), 'pointer': m.get('pointer')} for m in issues.get('messages', [])[:8]]}
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
        return {'available': False, 'errors': None, 'warnings': None, 'messages': ['validator unavailable']}


def roblox_budgets(path, stats, meta):
    """Warning budgets from work/research/report.md:32-33; no automatic geometry edits."""
    g, binary = gltf_document(path); warn = []; rows = []
    asset_type = meta.get('asset_type', 'prop'); units = meta.get('units') or g.get('asset', {}).get('extras', {}).get('units')
    triangles_limit = {'layered_accessory': 4000, 'body_head': 4000, 'body_torso': 1750, 'body_limb': 1248}.get(asset_type, 20000)
    size = stats.get('size') or []
    studs = max(size, default=0) if units == 'stud' else max(size, default=0) / .28
    texture_limit = 2048 if asset_type == 'layered_accessory' else 1024 if asset_type.startswith('body_') else 256 if studs <= 5 else 512 if studs <= 10 else 1024
    influences = None; resource_cache = {}
    for mesh in g.get('meshes', []):
        tris = 0
        for p in mesh['primitives']:
            count = g['accessors'][p['indices']]['count'] if 'indices' in p else g['accessors'][p['attributes']['POSITION']]['count']
            mode = p.get('mode', 4); tris += count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
            weights = []
            for name, index in sorted(p['attributes'].items()):
                if not name.startswith('WEIGHTS_'): continue
                a = g['accessors'][index]
                if 'bufferView' not in a or 'sparse' in a: warn.append('Roblox influences not checked: sparse/missing accessor'); continue
                bv = g['bufferViews'][a['bufferView']]
                if bv.get('extensions'): warn.append('Roblox influences not checked: compressed accessor'); continue
                data = buffer_bytes(path, g, binary, bv.get('buffer', 0), bv.get('byteOffset', 0), bv['byteLength'], cache=resource_cache)
                raw = acc_bytes({'accessors': [dict(a, bufferView=0)], 'bufferViews': [dict(bv, byteOffset=0)]}, data, 0)
                weights.append([sum(v > 0 for v in row) for row in struct.iter_unpack('<' + COMP[a['componentType']] * NCOMP[a['type']], raw)])
            if weights: influences = max(influences or 0, max((sum(row) for row in zip(*weights)), default=0))
        rows.append({'mesh': mesh.get('name', len(rows)), 'tris': tris, 'limit': triangles_limit})
        if tris > triangles_limit: warn.append('Roblox mesh %s: %d tris > %d (%s)' % (rows[-1]['mesh'], tris, triangles_limit, asset_type))
    if influences is not None and influences > 4: warn.append('Roblox influences %d > 4' % influences)
    dimensions = stats.get('texture_max_size')
    if dimensions and max(dimensions) > texture_limit: warn.append('Roblox texture %dx%d > %d px (%s)' % (*dimensions, texture_limit, asset_type))
    if units not in ('m', 'stud'): warn.append('Roblox units undeclared: set units=m|stud in brief/meta')
    elif units == 'm' and .1 <= max(size, default=0) <= 5: warn.append('Roblox bbox is metre-sized; verify importer scale (1 stud = 0.28 m)')
    return {'asset_type': asset_type, 'units': units, 'meshes': rows, 'influences': influences, 'influence_limit': 4, 'texture_limit': texture_limit, 'source': 'work/research/report.md:32-33'}, warn


def _check_model_json_depth(document):
    """Bound already-decoded containers without copying or recursive traversal."""
    stack = [iter((document,))]
    while stack:
        try:
            value = next(stack[-1])
        except StopIteration:
            stack.pop(); continue
        if isinstance(value, (dict, list)):
            if len(stack) >= 1000:
                raise MalformedModel('model JSON nesting too deep', validator_safe=False)
            stack.append(iter(value.values() if isinstance(value, dict) else value))


def gltf_document(path):
    """Read JSON and locate BIN without reading the geometry payload."""
    if str(path).lower().endswith('.gltf'):
        if os.path.getsize(path) > JSON_LIMIT: raise ValueError('glTF JSON exceeds 16 MiB limit')
        with open(path, encoding='utf-8') as f: g = json.load(f)
        _check_model_json_depth(g)
        check_resources(path, g)
        return g, None
    with open(path, 'rb') as f:
        magic, version, length = struct.unpack('<4sII', f.read(12))
        physical = os.fstat(f.fileno()).st_size
        if magic != b'glTF' or version != 2 or length < 12:
            raise ValueError('invalid GLB header')
        if length > physical: raise ValueError('truncated GLB payload')
        if length != physical and physical <= FULL_STATS_LIMIT:
            raise ValueError('invalid GLB header')
        binary, document, seen, chunks = None, None, set(), 0
        while f.tell() < length:
            chunks += 1
            if chunks > 64: raise MalformedModel('GLB chunk count exceeds 64 limit', validator_safe=False)
            if f.tell() + 8 > length: raise ValueError('truncated GLB chunk')
            size, kind = struct.unpack('<I4s', f.read(8)); offset = f.tell()
            if size % 4 or offset + size > length: raise ValueError('invalid GLB chunk length')
            if chunks == 1 and kind != b'JSON': raise ValueError('GLB must start with JSON')
            if kind in (b'JSON', b'BIN\0'):
                if kind in seen: raise ValueError('duplicate GLB chunk')
                seen.add(kind)
            if kind == b'JSON':
                document = (offset, size)
            elif kind == b'BIN\0': binary = (offset, size)
            f.seek(size, 1)
        if document is None or not document[1]: raise ValueError('GLB has no JSON chunk')
        # Complete the cheap table walk before allocating any JSON bytes.
        if document[1] > JSON_LIMIT: raise UnverifiedModel('glTF JSON exceeds 16 MiB limit')
        f.seek(document[0]); g = json.loads(f.read(document[1]))
        _check_model_json_depth(g)
        check_resources(path, g)
        return g, binary


def uri_bytes(path, uri, offset=0, size=None, cache=None):
    if uri.startswith('data:'):
        cache = {} if cache is None else cache
        key = (uri, offset, size); decoded = ('data', uri)
        if key in cache: return cache[key]
        size_key = ('size', uri)
        if size_key not in cache: cache[size_key] = _resource_uri_size(uri)
        length = cache[size_key]
        allocation = max(0, length - offset)
        if size is not None: allocation = min(allocation, size)
        # Reserve the payload split, decoder input/output and range copy before allocating.
        if decoded not in cache: allocation += 2 * len(uri) + length
        total = cache.get('allocated', 0) + allocation
        if os.path.getsize(path) + total > RESOURCE_TOTAL_LIMIT:
            raise ResourceError('glTF aggregate resource exceeds 512 MiB limit')
        cache['allocated'] = total
        if decoded not in cache:
            header, data = uri.split(',', 1)
            cache[decoded] = base64.b64decode(data) if ';base64' in header else urllib.parse.unquote_to_bytes(data)
        raw = cache[decoded]
        cache[key] = raw[offset:] if size is None else raw[offset:offset + size]
        return cache[key]
    target = resource_path(path, uri)
    if os.path.getsize(target) > FULL_STATS_LIMIT: raise ResourceError('resource read exceeds 150 MiB limit')
    key = (os.path.normcase(target), offset, size)
    if cache is not None:
        if key in cache: return cache[key]
        allocation = max(0, os.path.getsize(target) - offset)
        if size is not None: allocation = min(allocation, size)
        total = cache.get('allocated', 0) + allocation
        if os.path.getsize(path) + total > RESOURCE_TOTAL_LIMIT:
            raise ResourceError('glTF aggregate resource exceeds 512 MiB limit')
        cache['allocated'] = total
    with open(target, 'rb') as f:
        f.seek(offset); raw = f.read() if size is None else f.read(size)
    if cache is not None: cache[key] = raw
    return raw


def buffer_bytes(path, g, binary, index=0, offset=0, size=None, cache=None):
    if offset < 0 or (size is not None and (size < 0 or size > FULL_STATS_LIMIT)):
        raise ValueError('buffer read exceeds resource limits')
    uri = g['buffers'][index].get('uri')
    if uri: return uri_bytes(path, uri, offset, size, cache=cache)
    if index != 0 or binary is None: raise ValueError('missing glTF buffer')
    if size is None and binary[1] > FULL_STATS_LIMIT: raise ValueError('buffer read exceeds 150 MiB limit')
    with open(path, 'rb') as f:
        f.seek(binary[0] + offset)
        return f.read(min(binary[1] - offset, size if size is not None else binary[1] - offset))


def read_glb(path):
    g, binary = gltf_document(path)
    return g, buffer_bytes(path, g, binary) if g.get('buffers') else b''


def acc_bytes(g, binc, i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
    size = struct.calcsize('<' + COMP[a['componentType']]) * NCOMP[a['type']]
    o = bv.get('byteOffset', 0) + a.get('byteOffset', 0); stride = bv.get('byteStride', size)
    count = a['count']; end = a.get('byteOffset', 0) + (count - 1) * stride + size if count else a.get('byteOffset', 0)
    if count < 0 or stride < size or o < 0 or end > bv['byteLength'] or bv.get('byteOffset', 0) + end > len(binc) or count * size > FULL_STATS_LIMIT:
        raise ValueError('accessor count exceeds bufferView/buffer or allocation limit')
    return b''.join(binc[o + k * stride:o + k * stride + size] for k in range(a['count']))


def acc_max(g, i):
    return (g['accessors'][i].get('max') or [0])[0]


def mat4(n):
    if 'matrix' in n: m = n['matrix']; return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = n.get('translation', [0, 0, 0]); x, y, z, w = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def world_mats(g):
    parent = {c: i for i, n in enumerate(g.get('nodes', [])) for c in n.get('children', [])}
    out = {}
    def w(i):
        if i not in out: out[i] = mul(w(parent[i]), mat4(g['nodes'][i])) if i in parent else mat4(g['nodes'][i])
        return out[i]
    for i in range(len(g.get('nodes', []))): w(i)
    return out


def part_ids(g):
    nodes = g.get('nodes', []); parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    def ancestry(i):
        name = nodes[i].get('name', '')
        return ancestry(parent[i]) + '/' + name if i in parent else name
    names = [n.get('name', '') for n in nodes]; paths = [ancestry(i) for i in range(len(nodes))]
    ids = []
    for i, n in enumerate(nodes):
        explicit = (n.get('extras') or {}).get('pf_part_id')
        value = str(explicit) if explicit else names[i] if names[i] and names.count(names[i]) == 1 else paths[i] if paths[i] and paths.count(paths[i]) == 1 else None
        if explicit and value in ids: raise ValueError('ambiguous part id %s: pf_part_id must be unique' % value)
        ids.append(value)
    if len([x for x in ids if x]) != len(set(x for x in ids if x)): raise ValueError('ambiguous part ids: use unique extras.pf_part_id')
    return ids


def node_hashes(path, stable=False):
    """Part hashes include geometry, shading, skin and relevant animation; legacy names remain readable."""
    g, binary = gltf_document(path); W = world_mats(g); ids = part_ids(g); groups = {}; out = {}; resource_cache = {}
    def accessor(i):
        a = g['accessors'][i]
        if 'sparse' in a: raise ValueError('sparse accessor lock not checked')
        descriptor = json.dumps([a['componentType'], a['type'], a['count'], a.get('normalized', False)]).encode() + b'\0'
        if 'bufferView' not in a:
            size = a['count'] * NCOMP[a['type']] * struct.calcsize(COMP[a['componentType']])
            if size < 0 or size > FULL_STATS_LIMIT: raise ValueError('accessor allocation exceeds 150 MiB limit')
            return descriptor + bytes(size)
        bv = g['bufferViews'][a['bufferView']]
        if any('meshopt' in x for x in bv.get('extensions', {})): raise ValueError('compressed geometry lock not checked; submit an uncompressed lock source')
        data = buffer_bytes(path, g, binary, bv.get('buffer', 0), bv.get('byteOffset', 0), bv['byteLength'], cache=resource_cache)
        return descriptor + acc_bytes({'accessors': [dict(a, bufferView=0)], 'bufferViews': [dict(bv, byteOffset=0)]}, data, 0)
    def image(i):
        im = g['images'][i]
        if 'uri' in im: return uri_bytes(path, im['uri'], cache=resource_cache)
        bv = g['bufferViews'][im['bufferView']]
        return buffer_bytes(path, g, binary, bv.get('buffer', 0), bv.get('byteOffset', 0), bv['byteLength'], cache=resource_cache)
    def shading(material, h):
        h.update(json.dumps(material, sort_keys=True).encode())
        def walk(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key.endswith('Texture') and isinstance(child, dict) and 'index' in child:
                        texture = g['textures'][child['index']]
                        h.update(json.dumps(texture, sort_keys=True).encode())
                        source = next((ext['source'] for ext in texture.get('extensions', {}).values() if 'source' in ext), texture.get('source'))
                        if source is not None: h.update(image(source))
                        if 'sampler' in texture: h.update(json.dumps(g['samplers'][texture['sampler']], sort_keys=True).encode())
                    walk(child)
            elif isinstance(value, list):
                for child in value: walk(child)
        walk(material)
    parent = {c: j for j, node in enumerate(g.get('nodes', [])) for c in node.get('children', [])}
    for i, n in enumerate(g.get('nodes', [])):
        h = hashlib.sha1(json.dumps([[round(v, 4) + 0.0 for v in row] for row in W[i]]).encode())
        targets = {i}
        ancestor = i
        while ancestor in parent: ancestor = parent[ancestor]; targets.add(ancestor)
        if 'mesh' in n:
            mesh = g['meshes'][n['mesh']]
            if 'weights' in mesh or 'weights' in n:
                h.update(json.dumps([mesh.get('weights'), n.get('weights')]).encode())
            for p in mesh['primitives']:
                if 'KHR_draco_mesh_compression' in p.get('extensions', {}): raise ValueError('Draco geometry lock not checked; submit an uncompressed lock source')
                h.update(str(p.get('mode', 4)).encode())
                for name, index in sorted(p['attributes'].items()):
                    h.update(name.encode()); h.update(accessor(index))
                for target in p.get('targets', []):
                    h.update(b'morph\0')
                    for name, index in sorted(target.items()):
                        h.update(name.encode()); h.update(accessor(index))
                if 'indices' in p: h.update(accessor(p['indices']))
                if 'material' in p: shading(g['materials'][p['material']], h)
            if 'skin' in n:
                skin = g['skins'][n['skin']]; targets.update(skin['joints'])
                h.update(json.dumps([(ids[j], W[j]) for j in skin['joints']], sort_keys=True).encode())
                if 'inverseBindMatrices' in skin: h.update(accessor(skin['inverseBindMatrices']))
        for animation in g.get('animations', []):
            for channel in animation.get('channels', []):
                if channel.get('target', {}).get('node') not in targets: continue
                sampler = animation['samplers'][channel['sampler']]
                h.update(json.dumps([animation.get('name'), channel['target'].get('path'), sampler.get('interpolation', 'LINEAR')]).encode())
                h.update(accessor(sampler['input'])); h.update(accessor(sampler['output']))
        groups.setdefault(n.get('name', '#%d' % i), []).append(h.hexdigest()[:16])
        if ids[i]: out[ids[i]] = h.hexdigest()[:16]
        elif stable: raise ValueError('ambiguous part id for node %s; add unique extras.pf_part_id' % n.get('name', i))
    # A legacy selector names every occurrence; aggregate duplicates so none can hide a change.
    if stable: return out
    return dict(out, **{name: hashes[0] if len(hashes) == 1 else hashlib.sha1(json.dumps(hashes).encode()).hexdigest()[:16]
                       for name, hashes in groups.items()})


def texture_header(read, size):
    """Dimensions and resident-byte estimate from bounded image-header reads."""
    b = read(0, 48); wh = None; ktx = b.startswith(b'\xabKTX 20\xbb\r\n\x1a\n')
    if b.startswith(b'\x89PNG\r\n\x1a\n') and len(b) >= 24: wh = struct.unpack_from('>II', b, 16)
    elif ktx and len(b) >= 28: wh = struct.unpack_from('<II', b, 20)
    elif b[:2] == b'\xff\xd8':
        offset = 2
        while offset + 4 <= size:
            marker = read(offset, 2)
            if marker[:1] != b'\xff': break
            if marker[1] == 255: offset += 1; continue
            if marker[1] in (0xd8, 0x01) or 0xd0 <= marker[1] <= 0xd7: offset += 2; continue
            if marker[1] in (0xd9, 0xda): break
            n = struct.unpack('>H', read(offset + 2, 2))[0]
            if n < 2: break
            if marker[1] in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                h, w = struct.unpack('>HH', read(offset + 5, 4)); wh = (w, h); break
            offset += 2 + n
    elif b[:4] == b'RIFF' and b[8:12] == b'WEBP':
        offset = 12
        while offset + 8 <= size:
            chunk = read(offset, 18); kind = chunk[:4]; n = struct.unpack_from('<I', chunk, 4)[0]
            if kind == b'VP8X': wh = (1 + int.from_bytes(chunk[12:15], 'little'), 1 + int.from_bytes(chunk[15:18], 'little')); break
            if kind == b'VP8L' and len(chunk) >= 13 and chunk[8] == 0x2f:
                bits = int.from_bytes(chunk[9:13], 'little'); wh = ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1); break
            if kind == b'VP8 ' and chunk[11:14] == b'\x9d\x01\x2a':
                wh = tuple(v & 0x3fff for v in struct.unpack_from('<HH', chunk, 14)); break
            offset += 8 + n + (n % 2)
    return wh, size if ktx else (wh[0] * wh[1] * 4 * 1.33 if wh else 0)


def glb_stats(path):
    g, binary = gltf_document(path); nodes = g.get('nodes', []); tris = vertices = draws = 0
    total_bytes = resource_bytes(path, g); workload_bytes = resource_workload_bytes(path, g); resource_cache = {}
    if os.path.getsize(path) > FULL_STATS_LIMIT:
        return {'header_only': True, 'bytes': os.path.getsize(path), 'resource_bytes': total_bytes, 'resource_workload_bytes': workload_bytes, 'stats_warning': 'Full stats skipped: file exceeds 150 MiB limit',
                'extensionsUsed': g.get('extensionsUsed', []), 'extensionsRequired': g.get('extensionsRequired', [])}
    for a in g.get('accessors', []):
        element = struct.calcsize(COMP[a['componentType']]) * NCOMP.get(a['type'], 16)
        if a['count'] < 0 or a['count'] * element > FULL_STATS_LIMIT: raise ValueError('accessor allocation exceeds 150 MiB limit')
        if 'bufferView' not in a: continue
        bv = g['bufferViews'][a['bufferView']]
        if any('meshopt' in x for x in bv.get('extensions', {})): continue
        index = bv.get('buffer', 0); buf = g['buffers'][index]; uri = buf.get('uri')
        length = _resource_uri_size(uri) if uri and uri.startswith('data:') else os.path.getsize(resource_path(path, uri)) if uri else binary[1]
        stride = bv.get('byteStride', element); end = a.get('byteOffset', 0) + ((a['count'] - 1) * stride + element if a['count'] else 0)
        if stride < element or a.get('byteOffset', 0) < 0 or bv.get('byteOffset', 0) < 0 or end > bv['byteLength'] or bv.get('byteOffset', 0) + bv['byteLength'] > min(buf['byteLength'], length):
            raise ValueError('accessor count exceeds bufferView/buffer length')
    world = world_mats(g); low = [math.inf] * 3; high = [-math.inf] * 3
    for n in nodes:
        for p in g['meshes'][n['mesh']]['primitives'] if 'mesh' in n else []:
            pos = g['accessors'][p['attributes']['POSITION']]; vertices += pos['count']; draws += 1
            count = g['accessors'][p['indices']]['count'] if 'indices' in p else pos['count']
            mode = p.get('mode', 4); tris += count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
    for i, n in enumerate(nodes):
        for p in g['meshes'][n['mesh']]['primitives'] if 'mesh' in n else []:
            a = g['accessors'][p['attributes']['POSITION']]
            if 'min' not in a or 'max' not in a: continue
            bounds = [a['min'], a['max']]
            if a.get('normalized') and a['componentType'] != 5126:
                divisor = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295}[a['componentType']]
                bounds = [[max(-1, v / divisor) for v in side] for side in bounds]
            for x in (bounds[0][0], bounds[1][0]):
                for y in (bounds[0][1], bounds[1][1]):
                    for z in (bounds[0][2], bounds[1][2]):
                        point = [sum(world[i][r][c] * v for c, v in enumerate((x, y, z, 1))) for r in range(3)]
                        low = [min(a, b) for a, b in zip(low, point)]; high = [max(a, b) for a, b in zip(high, point)]
    bbox = {'min': low, 'max': high, 'unit': 'm'} if all(math.isfinite(v) for v in low + high) else None
    size = [round(b - a, 6) for a, b in zip(low, high)] if bbox else None
    texture_sizes, texture_bytes = [], 0
    images = g.get('images', [])
    for texture in g.get('textures', []):
        source = next((ext['source'] for ext in texture.get('extensions', {}).values() if 'source' in ext), texture.get('source'))
        if source is None: continue
        image = images[source]
        if 'bufferView' in image:
            bv = g['bufferViews'][image['bufferView']]; length = bv['byteLength']
            read = lambda offset, count, bv=bv: buffer_bytes(path, g, binary, bv.get('buffer', 0), bv.get('byteOffset', 0) + offset, min(count, bv['byteLength'] - offset), cache=resource_cache)
        else:
            uri = image['uri']
            length = len(uri_bytes(path, uri, cache=resource_cache)) if uri.startswith('data:') else os.path.getsize(resource_path(path, uri))
            read = lambda offset, count, uri=uri: uri_bytes(path, uri, offset, count, cache=resource_cache)
        wh, estimate = texture_header(read, length)
        if wh: texture_sizes.append(list(wh))
        texture_bytes += estimate
    names = [n.get('name', '') for n in nodes]
    clips = [{'name': a.get('name', ''), 'seconds': round(max((acc_max(g, s['input']) for s in a['samplers']), default=0), 3)} for a in g.get('animations', [])]
    return {'nodes': len(nodes), 'resource_bytes': total_bytes, 'resource_workload_bytes': workload_bytes, 'mesh_nodes': sum('mesh' in n for n in nodes), 'tris': tris, 'materials': len(g.get('materials', [])),
            'vertices': vertices, 'triangles': tris, 'draw_calls': draws, 'textures': len(g.get('textures', [])),
            'texture_max_size': max(texture_sizes, key=lambda wh: wh[0] * wh[1], default=None),
            'est_texture_mb': round(texture_bytes / 1024 ** 2, 6), 'bbox': bbox, 'size': size,
            'size_studs': [round(v / 0.28, 6) for v in size] if size else None, 'stud_metres': 0.28,
            'skins': len(g.get('skins', [])), 'joints': sum(len(s.get('joints', [])) for s in g.get('skins', [])),
            'animations': len(clips), 'extensionsUsed': g.get('extensionsUsed', []), 'extensionsRequired': g.get('extensionsRequired', []),
            'clips': clips, 'pivots': sum((n.get('extras') or {}).get('pf_role') == 'pivot' for n in nodes),
            'roots': len(g['scenes'][g.get('scene', 0)]['nodes']) if g.get('scenes') else 0, 'duplicate_names': sorted({x for x in names if x and names.count(x) > 1})[:10]}


def wav_stats(path):
    with wave.open(path) as w:
        ch, sw, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes(); raw = w.readframes(n)
    if sw == 2: vals = struct.unpack('<%dh' % (len(raw) // 2), raw); full = 32768
    elif sw == 1: vals = [v - 128 for v in raw]; full = 128
    else: vals = [int.from_bytes(raw[i:i + sw], 'little', signed=True) for i in range(0, len(raw), sw)]; full = 2 ** (8 * sw - 1)
    pk = max((abs(v) for v in vals), default=0) / full
    return {'channels': ch, 'rate': rate, 'seconds': round(n / rate, 3), 'peak_dbfs': round(20 * math.log10(pk), 1) if pk else None}


def model_delta(before, after, old_version, new_version, old_stage):
    changes = {}
    for key in ('tris', 'vertices', 'draw_calls', 'materials', 'textures', 'est_texture_mb', 'size'):
        a, b = before.get(key), after.get(key)
        if a is None or b is None: continue
        if key == 'size':
            diff = [round(y - x, 6) for x, y in zip(a, b)]
            pct = [round(100 * (y - x) / abs(x), 1) if x else (0 if not y else None) for x, y in zip(a, b)]
            text = 'size ' + 'x'.join('%+d' % round(v * 1000) if abs(v) >= .0005 else '0' for v in diff) + ' mm' if any(abs(v) >= .0005 for v in diff) else ''
        else:
            diff = round(b - a, 6); pct = round(100 * diff / abs(a), 1) if a else (0 if not b else None)
            text = '%s %+.3g' % (key, diff)
            if key == 'est_texture_mb': text = 'texture MB %+.2f' % diff if abs(diff) >= .01 else ''
        changes[key] = {'before': a, 'after': b, 'diff': diff, 'pct': pct, 'text': text}
    return {'from': old_version, 'to': new_version, 'stage': old_stage, 'changes': changes,
            'line': 'DELTA v%03d->v%03d: %s' % (old_version, new_version, ', '.join(c['text'] for c in changes.values() if c['text']) or 'no measured change')}


def audio_stats(path):
    """Any audio ffmpeg reads (wav, ogg, mp3): duration, sample peak, true peak, loudness, silence at both ends, loop-seam jump."""
    ff = shutil.which('ffmpeg')
    if not ff: return dict(wav_stats(path), note='ffmpeg missing: only WAV peak measured') if path.lower().endswith('.wav') else {}
    NW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    raw = subprocess.run([ff, '-v', 'error', '-i', path, '-ac', '1', '-ar', '22050', '-f', 's16le', '-'], capture_output=True, creationflags=NW, timeout=120).stdout
    pcm = array.array('h'); pcm.frombytes(raw[:len(raw) // 2 * 2])
    rate, n = 22050, len(pcm)
    if not n: return {'seconds': 0, 'peak_dbfs': None}
    full = 32768.0; thr = full * 10 ** (-50 / 20)
    lead = next((i for i, v in enumerate(pcm) if abs(v) > thr), n); tail = next((i for i, v in enumerate(reversed(pcm)) if abs(v) > thr), n)
    pk = max(abs(min(pcm)), abs(max(pcm))) / full
    w = max(1, rate // 100)  # 10 ms at each end: a loop must continue smoothly from its last sample into its first
    rms = lambda s: math.sqrt(sum(x * x for x in s) / len(s)) / full
    st = {'seconds': round(n / rate, 3), 'peak_dbfs': round(20 * math.log10(pk), 1) if pk else None,
          'lead_silence_s': round(lead / rate, 3), 'tail_silence_s': round(tail / rate, 3),
          'seam_jump': round(abs(pcm[-1] - pcm[0]) / full, 3), 'seam_rms_ratio': round((rms(pcm[-w:]) + 1e-6) / (rms(pcm[:w]) + 1e-6), 2)}
    err = subprocess.run([ff, '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, creationflags=NW, timeout=120).stderr.decode('utf-8', 'replace')
    summ = err[err.rfind('Summary:'):] if 'Summary:' in err else ''
    m = re.search(r'I:\s+(-?[\d.]+) LUFS', summ); st['lufs'] = float(m.group(1)) if m and float(m.group(1)) > -69 else None  # -70 = no 400 ms block passed the gate (very short sound), not a measurement
    m = re.search(r'Peak:\s+(-?[\d.]+|-inf) dBFS', summ[summ.find('True peak'):] if 'True peak' in summ else ''); st['true_peak_dbtp'] = float(m.group(1)) if m and m.group(1) != '-inf' else None
    return st


def audio_check(path, st, meta):
    """(warn, block) for one audio file. Block only what is wrong for certain, never taste."""
    warn, block = [], []
    name = os.path.basename(path).lower(); is_loop = 'loop' in name or meta.get('loop') is True
    pk, tp, lu = st.get('peak_dbfs'), st.get('true_peak_dbtp'), st.get('lufs')
    if pk is None or pk < -60: block.append('silent file (peak %s dBFS)' % pk); return warn, block
    if (tp is not None and tp > 0.0) or pk >= -0.05: block.append('clipping: true peak %s dBTP, peak %s dBFS (keep at least 1 dB headroom)' % (tp, pk))
    elif (tp if tp is not None else pk) > -1.0: warn.append('little headroom: true peak %s dBTP' % (tp if tp is not None else pk))
    if pk < -24: warn.append('peak %s dBFS: very quiet' % pk)
    if lu is not None and lu > -8: warn.append('very loud: %s LUFS' % lu)
    if lu is not None and lu < -32: warn.append('very quiet: %s LUFS' % lu)
    lead = st.get('lead_silence_s') or 0
    if lead > 0.5: block.append('%.2f s of silence at the start: the sound starts too late' % lead)
    elif lead > 0.12 and not is_loop: warn.append('%.2f s of silence at the start' % lead)
    if is_loop and (st.get('seam_jump', 0) > 0.08 or not 0.33 < st.get('seam_rms_ratio', 1) < 3): block.append('loop seam: jump %s / loudness ratio %s between end and start, audible click or bump' % (st.get('seam_jump'), st.get('seam_rms_ratio')))
    if not is_loop and (st.get('tail_silence_s') or 0) > 1.5: warn.append('%.1f s of silence at the end' % st['tail_silence_s'])
    return warn, block


def image_size(path):
    b = open(path, 'rb').read(65536)
    if b[:8] == b'\x89PNG\r\n\x1a\n': return struct.unpack('>II', b[16:24])
    if b[:6] in (b'GIF87a', b'GIF89a'): return struct.unpack('<HH', b[6:10])
    if b[:2] == b'\xff\xd8':
        i = 2
        while i < len(b) - 9:
            if b[i] != 0xFF: i += 1; continue
            m = b[i + 1]; ln = struct.unpack('>H', b[i + 2:i + 4])[0]
            if m in (0xC0, 0xC1, 0xC2): h, w = struct.unpack('>HH', b[i + 5:i + 9]); return w, h
            i += 2 + ln
    return None


# Sections a production brief needs (assets/brief-template.md). Each matches heading words in English or Dutch, so older Dutch briefs still pass.
BRIEF_SECTIONS = [('role', r'role|\brol\b|doel'), ('camera and reading distance', r'see|view|camera|lees|distance|afstand'), ('sizes and silhouette', r'proportion|silhouet|maat|schaal|scale'),
                  ('quality bar and gap', r'gap|\bbar\b|\blat\b|quality|kwaliteit'), ('parts', r'part|onderdel'), ('colours', r'colou?r|kleur|palet'),
                  ('motion', r'motion|beweg|anima|state|toestand'), ('effects and sound', r'effect|vfx|sound|geluid|audio'), ('budget per LOD', r'budget|\blod\b'),
                  ('build route', r'route|build|bouw'), ('never list', r'never|nooit'), ('acceptance', r'accept|klaar'), ('open questions', r'question|vra(a)?g')]


def brief_check(path, doc=False):
    """doc=True: a business document brief (--meta kind=doc or a non-asset route): no asset-template demands, only an empty-file check and the image links."""
    t = open(path, encoding='utf-8', errors='replace').read()
    heads = [h.lower() for h in re.findall(r'^#{2,4}\s+(.+)$', t, re.M)]
    imgs = re.findall(r'!\[[^\]]*\]\(([^)\s]+)\)', t)
    st = {'lines': sum(1 for x in t.splitlines() if x.strip()), 'sections': len(heads), 'images': len(imgs), 'hex': len(set(x.upper() for x in re.findall(r'#[0-9A-Fa-f]{6}\b', t)))}
    warn = []
    missing = [w for w, rx in BRIEF_SECTIONS if not any(re.search(rx, h) for h in heads)]
    if doc and not st['lines']: warn.append('empty brief')
    if missing and not doc: warn.append('brief is missing sections: %s (template: assets/brief-template.md)' % ', '.join(missing))
    if not imgs and not doc: warn.append('brief without images: add references and a size sheet')
    warn += ['image %s is not in this version' % i for i in imgs if not re.match(r'https?:', i) and not os.path.isfile(os.path.join(os.path.dirname(path), i))]
    if st['hex'] < 3 and not doc: warn.append('fewer than 3 hex colours')
    if st['lines'] < 60 and not doc: warn.append('thin brief: %d lines of text' % st['lines'])
    return st, warn


def pdf_stats(path, meta):
    st = dict(pages=None, sizes_mm=[], uniform_size=None, trimbox=None, bleedbox=None, fonts=None, images_low_ppi=None)
    warn = []
    try:
        from pypdf import PdfReader
        doc = PdfReader(path); sizes, fonts, bleeds = [], {}, []
        def obj(value): return value.get_object() if hasattr(value, 'get_object') else value
        def walk(resources, seen):
            """Fonts of a page and of the Form XObjects it draws (nested), each form once."""
            resources = obj(resources or {})
            for ref in obj(resources.get('/Font', {})).values():
                font = obj(ref); children = obj(font.get('/DescendantFonts', [font]))
                desc = [obj(obj(f).get('/FontDescriptor', {})) for f in children]
                name = str(font.get('/BaseFont', '?'))
                embedded = bool(font.get('/CharProcs')) or bool(desc and all(any(k in d for k in ('/FontFile', '/FontFile2', '/FontFile3')) for d in desc))
                fonts[name] = fonts.get(name, True) and embedded
            for ref in obj(resources.get('/XObject', {})).values():
                form = obj(ref); key = getattr(ref, 'idnum', id(form))
                if form.get('/Subtype') == '/Form' and key not in seen: seen.add(key); walk(form.get('/Resources'), seen)
        trim, bleed = [], []
        for page in doc.pages:
            box = page.mediabox; sizes.append([round(float(box.width) * 25.4 / 72, 2), round(float(box.height) * 25.4 / 72, 2)])
            trim.append('/TrimBox' in page); bleed.append('/BleedBox' in page)
            if trim[-1] and bleed[-1]:
                t, b = page.trimbox, page.bleedbox
                bleeds.append(min(float(t.left-b.left), float(t.bottom-b.bottom), float(b.right-t.right), float(b.top-t.top)) * 25.4 / 72)
            walk(page.get('/Resources', {}), set())
        unique = sorted({tuple(s) for s in sizes})
        st.update(pages=len(sizes), sizes_mm=[list(s) for s in unique], uniform_size=len(unique) <= 1,
                  trimbox=bool(trim) and all(trim), bleedbox=bool(bleed) and all(bleed), fonts=[dict(name=k, embedded=v) for k, v in sorted(fonts.items())])
        if not st['uniform_size']: warn.append('PDF has mixed page sizes')
        paper = {'A4': (210, 297), 'A5': (148, 210), 'LETTER': (216, 279)}.get(str(meta.get('paper', '')).upper())
        if meta.get('paper') and not paper: warn.append('Paper size not checked: unknown size')
        if paper and any(any(abs(a-b) > 1 for a, b in zip(sorted(s), sorted(paper))) for s in unique): warn.append('Page size differs from ' + str(meta['paper']))
        if any(not f['embedded'] for f in st['fonts']): warn.append('PDF contains fonts that are not embedded')
        if meta.get('bleed') is not None:
            if len(bleeds) != len(sizes): warn.append('Bleed not checked: TrimBox/BleedBox missing')
            if bleeds and min(bleeds) < float(meta['bleed']): warn.append('Bleed smaller than %s mm' % meta['bleed'])
        if len(sizes) > 300: warn.append('PDF has more than 300 pages; only the first 300 are rendered')
    except ImportError: warn.append('PDF size, fonts and bleed not checked (no pypdf)')
    try:
        import fitz
        with fitz.open(path) as doc:
            low = 0
            for page in doc:
                for image in page.get_images(full=True):
                    for rect in page.get_image_rects(image[0]):
                        if rect.width and rect.height and min(image[2] * 72 / rect.width, image[3] * 72 / rect.height) < 300: low += 1
            st['images_low_ppi'] = low
        if low: warn.append('%d PDF images below 300 ppi' % low)
    except ImportError: warn.append('PDF image resolution not checked (no PyMuPDF)')
    return st, warn


def provenance_blocks(meta, policy=None):
    """Validate v1 declarations; only separately resolved policy has authority."""
    if policy is not None and not isinstance(policy, TrustedPolicy):
        raise ValueError('provenance.policy_invalid')
    if 'provenance' not in meta:
        required = meta.get('require_provenance') is True or (policy is not None and policy.require_provenance)
        return ['provenance.missing'] if required else []
    record = meta['provenance']
    if not isinstance(record, dict):
        return ['provenance.invalid_record']
    block = []
    for field in ('source', 'author', 'licence'):
        value = record.get(field)
        if not isinstance(value, str) or not value.strip():
            block.append('provenance.invalid_' + field)
    if (policy is not None and policy.allowed_licences is not None
            and 'provenance.invalid_licence' not in block
            and record['licence'] not in policy.allowed_licences):
        block.append('provenance.disallowed_licence')
    files = record.get('files')
    if not isinstance(files, dict):
        block.append('provenance.invalid_files')
        return block
    seen = set()
    for name, digest in files.items():
        # Portable basenames: no paths, alternate streams, control characters,
        # Windows device names, or trailing dots/spaces that alias other files.
        safe = (isinstance(name, str) and bool(name) and name not in ('.', '..')
                and name == name.strip() and not name.endswith('.')
                and not re.search(r'[<>:"/\\|?*\x00-\x1f\x7f]', name)
                and not re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])',
                                     name.split('.')[0].rstrip(' ')))
        if not safe:
            if 'provenance.invalid_basename' not in block:
                block.append('provenance.invalid_basename')
        else:
            key = name.casefold()
            if key in seen and 'provenance.duplicate_basename' not in block:
                block.append('provenance.duplicate_basename')
            seen.add(key)
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            if 'provenance.invalid_hash' not in block:
                block.append('provenance.invalid_hash')
    return block


def provenance_hash(path, meta):
    """Measure only this basename's bytes, with bounded streaming reads."""
    name = os.path.basename(path)
    declared = meta['provenance']['files'].get(name)
    if declared is None:
        return {}, ['provenance.missing_file']
    digest = hashlib.sha256()
    try:
        with open(path, 'rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError:
        return {}, ['provenance.hash_unreadable']
    measured = digest.hexdigest()
    return {'sha256': measured, 'declared_sha256': declared}, ([] if measured == declared else ['provenance.hash_mismatch'])


def preflight(path, media, stage, meta, policy=None):
    """Share URI measurements across facts, resource checks and validator reads."""
    token = _URI_SIZES.set({})
    try:
        return _preflight(path, media, stage, meta, policy=policy)
    finally:
        _URI_SIZES.reset(token)


def _preflight(path, media, stage, meta, policy=None):
    """With a resolved policy, enforce provenance and hash the copied file.

    Legacy four-argument callers retain declaration-only validation. Submission
    supplies a resolved policy for trusted restrictions or declared provenance.
    """
    st, warn, block = {}, [], []
    validator_safe = True
    try:
        if media == 'pdf':
            st, warn = pdf_stats(path, meta)
        elif stage == 'brief' and media == 'text':
            st, warn = brief_check(path, meta.get('kind') == 'doc')
        elif media == 'model' and str(path).lower().endswith(('.glb', '.gltf')):
            model_structure(path)
            st = glb_stats(path)
            if st.get('header_only'): warn.append(st['stats_warning'])
            elif meta.get('target', 'roblox') == 'roblox':
                st['budgets'], budget_warn = roblox_budgets(path, st, meta); warn.extend(budget_warn)
            if st.get('duplicate_names'): warn.append('duplicate node names: ' + ', '.join(st['duplicate_names']))
            if not st.get('header_only') and not st.get('mesh_nodes'): block.append('no mesh in the file')
            if stage == 'rig' and not st.get('header_only') and not st.get('pivots'): warn.append('no pivot nodes (extras pf_role=pivot)')
            if stage == 'animation' and not st.get('header_only') and not st.get('clips'): warn.append('no animation clips')
            if len(st.get('clips', [])) > 1: warn.append('%d clips; one clip per state is easier to review' % len(st['clips']))
            if meta.get('budget_tris') and st.get('tris', 0) > meta['budget_tris']: block.append('tris %d > budget %d' % (st['tris'], meta['budget_tris']))
        elif media == 'audio':
            # R3I-006 begin: additive advisory facts, never warn/block candidates.
            from spectral_events import analyze_file
            st['spectral_events'] = analyze_file(path)
            audio = audio_stats(path)
            st.update(audio)
            if audio: warn, block = audio_check(path, st, meta)
            # R3I-006 end
        elif media == 'image':
            wh = image_size(path)
            if wh: st = {'width': wh[0], 'height': wh[1]}
            if wh and max(wh) < 512: warn.append('small image (%dx%d)' % wh)
    except MalformedModel as e:
        validator_safe = e.validator_safe
        block.append('model.malformed')
        warn.append('pre-flight could not read this file: %s' % e)
    except UnverifiedModel as e:
        validator_safe = False
        block.append('model.unverified')
        warn.append('pre-flight could not read this file: %s' % e)
    except ResourceError as e:
        block.append(str(e))
    except Exception as e:  # optional stats and unsupported media remain diagnostic
        warn.append('pre-flight could not read this file: %s' % e)
    # Apply after media checks so audio_check cannot overwrite these blocks.
    provenance = provenance_blocks(meta, policy)
    block.extend(provenance)
    if policy is not None and 'provenance' in meta and not provenance:
        measured, failures = provenance_hash(path, meta)
        if measured: st['provenance'] = measured
        block.extend(failures)
    result = {'stats': st, 'warn': warn, 'block': block}
    if media == 'audio':
        from stereo_check import analyze_stereo, compact_advisory
        analysis = analyze_stereo(path)
        stereo = result['stereo_cancellation'] = compact_advisory(analysis)
        result['pcm_diagnostics'] = analysis['pcm_diagnostics']
        # Incomplete/inapplicable evidence stays in its structured advisory;
        # legacy media/provenance warning lists retain their existing meaning.
        if stereo['status'] == 'ok' and stereo['regions']:
            region = stereo['regions'][0]
            warn.append('stereo cancellation advisory: %.3f-%.3f s, mono loss %.2f dB '
                        '(M=(L+R)/2)' % (region['start_s'], region['end_s'],
                                         region['metrics']['mono_loss_db']))
    if validator_safe and (not block or 'model.malformed' in block) and media == 'model' and str(path).lower().endswith(('.glb', '.gltf')):
        validator = result['validator'] = validate_gltf(path)
        if not validator['available']: warn.append('validator unavailable')
        elif validator['errors'] or validator['warnings']:
            warn.append('Khronos validator: %d errors, %d warnings' % (validator['errors'], validator['warnings']))
            if validator['errors'] and not block and os.environ.get('ASSET_REVIEW_VALIDATOR_BLOCK', '0') == '1': block.append('Khronos validator: %d errors' % validator['errors'])
    return result


def _region_diff(a, b, r):
    try:
        from PIL import Image, ImageChops, ImageStat
    except ImportError:
        return None
    A, B = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    if A.size != B.size: B = B.resize(A.size)
    W, H = A.size; box = (max(0, int(r['x'] * W)), max(0, int(r['y'] * H)), min(W, int((r['x'] + r['w']) * W)), min(H, int((r['y'] + r['h']) * H)))
    if box[2] <= box[0] or box[3] <= box[1]: return None  # outside the file: a live-page note below the screenshot
    return sum(ImageStat.Stat(ImageChops.difference(A.crop(box), B.crop(box))).mean) / 3


def lock_check(locks, old_dir, new_dir):
    """Compare every approved (locked) target of the previous version with the new files."""
    out, cache = [], {}
    for n in locks:
        t = n.get('target') or {}; f = t.get('file', ''); s = t.get('selector') or {}
        old, new = os.path.join(old_dir, f), os.path.join(new_dir, f)
        row = {'note': n.get('id'), 'file': f, 'text': n.get('text', '')[:80]}
        if not os.path.exists(new): out.append(dict(row, target=f, result='missing')); continue
        if f.lower().endswith('.pdf'): out.append(dict(row, target='page %s' % t['page'] if t.get('page') else 'file', result='not_checked')); continue
        parts = s.get('parts', []) or ([s] if s.get('node') or s.get('part_id') else [])
        if parts and f.lower().endswith(('.glb', '.gltf')):
            try:
                for p in (old, new):
                    if p not in cache: cache[p] = node_hashes(p, stable=True)
            except (ValueError, KeyError, IndexError, OSError, struct.error) as e:
                out.append(dict(row, target=str(parts), result='not_checked', reason=str(e))); continue
            for part in parts:
                nd = part.get('part_id') or (part.get('extras') or {}).get('pf_part_id') or (part.get('node') if part.get('node') in cache[old] else part.get('path')) or part.get('node')
                if not nd:
                    out.append(dict(row, target=str(part), result='not_checked', reason='ambiguous part selector; use extras.pf_part_id')); continue
                res = 'missing' if nd not in cache[new] else ('unchanged' if cache[old].get(nd) == cache[new][nd] else 'changed')
                out.append(dict(row, target=nd, result=res))
        elif sel_bbox(s):
            x, y, w, h = sel_bbox(s); r = {'x': x, 'y': y, 'w': w, 'h': h}
            d = _region_diff(old, new, r) if not f.lower().endswith(('.mp4', '.webm', '.mov')) else None
            out.append(dict(row, target='region', result='not_checked' if d is None else ('unchanged' if d < 2.0 else 'changed'), diff=None if d is None else round(d, 2)))
        else:
            same = open(old, 'rb').read() == open(new, 'rb').read() if os.path.exists(old) else False
            out.append(dict(row, target='file', result='unchanged' if same else 'changed'))
    return out


def sel_bbox(s):
    """Normalized (x, y, w, h) of any image/frame selector, or None."""
    s = s or {}
    r = s.get('rect') if s.get('type') == 'time' else None
    if r: return r['x'], r['y'], r['w'], r['h']
    t = s.get('type')
    if t in ('rect', 'stroke') and s.get('w') is not None: return s['x'], s['y'], s['w'], s['h']
    if t == 'polygon' and s.get('points'):
        xs = [p[0] for p in s['points']]; ys = [p[1] for p in s['points']]
        return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
    if t == 'point': return s['x'] - 0.03, s['y'] - 0.03, 0.06, 0.06
    return None


def scope_check(notes, old_dir, new_dir, files):
    """Measured by the tool, not claimed by the agent: what changed outside the change/reject notes of the previous review."""
    work = [n for n in notes if n.get('verdict') in ('change', 'reject')]
    out = {}
    for f in files:
        old, new = os.path.join(old_dir, f['name']), os.path.join(new_dir, f['name'])
        if f['media'] == 'pdf':
            out.setdefault('pdf', []).append({'file': f['name'], 'result': 'not_checked', 'note': 'PDF pixels not checked'})
            continue
        if not os.path.exists(old): continue
        mine = [n for n in work if (n.get('target') or {}).get('file') == f['name']]
        if f['media'] == 'image':
            try:
                from PIL import Image, ImageChops, ImageDraw
            except ImportError:
                return {'note': 'Pillow missing, image scope not measured'}
            A, B = Image.open(old).convert('RGB'), Image.open(new).convert('RGB')
            if A.size != B.size: out.update(size_changed=True); continue
            W, H = A.size
            diff = ImageChops.difference(A, B).convert('L').point(lambda v: 255 if v > 12 else 0)
            mask = Image.new('L', (W, H), 0); g = ImageDraw.Draw(mask)
            whole = False
            for n in mine:
                bb = sel_bbox((n.get('target') or {}).get('selector'))
                if bb is None: whole = True; continue
                x, y, w, h = bb; pad = 0.01
                g.rectangle([int((x - pad) * W), int((y - pad) * H), int((x + w + pad) * W), int((y + h + pad) * H)], fill=255)
            if whole: continue  # a note about the whole image allows changes anywhere
            inside = ImageChops.multiply(diff, mask).histogram()[255]
            total = diff.histogram()[255]; area_out = W * H - mask.histogram()[255]
            out.update(changed_outside_pct=round(100.0 * (total - inside) / max(1, area_out), 3), changed_inside_pct=round(100.0 * inside / max(1, W * H - area_out), 2), file=f['name'])
        elif f['media'] == 'model' and f['name'].lower().endswith(('.glb', '.gltf')):
            try: a, b = node_hashes(old, stable=True), node_hashes(new, stable=True)
            except (ValueError, KeyError, IndexError, OSError, struct.error) as e:
                out.update(file=f['name'], result='not_checked', reason=str(e)); continue
            changed = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
            allowed = {p.get('part_id') or (p.get('extras') or {}).get('pf_part_id') or (p.get('node') if p.get('node') in a else p.get('path')) or p.get('node') for n in mine for p in ((n.get('target') or {}).get('selector') or {}).get('parts', [])}
            allowed |= {((n.get('target') or {}).get('selector') or {}).get('node') for n in mine}
            if any(((n.get('target') or {}).get('selector') or {}).get('type') in (None, 'whole', 'time') and not ((n.get('target') or {}).get('selector') or {}).get('parts') for n in mine): continue
            out.update(changed_nodes=len(changed), changed_nodes_outside=[k for k in changed if k not in allowed][:40], file=f['name'])
    return out
