"""Bounded, read-only glTF material evidence; no rendering or physical verdicts.

status describes evidence coverage, not validity. Findings have stable codes and
material/field locations; any unknown check makes coverage unsupported.
"""
import io
import json
import math
import os
import re
import struct
import warnings

from preflight import (buffer_bytes, data_uri_size, gltf_document, resource_path,
                       uri_bytes)

EPSILON = 1e-6
LIMITS = dict(bytes=32 * 1024**2, pixels=1024**2, operations=16 * 1024**2)
MAX_ROWS = 64
MAX_ROW_BYTES = 24 * 1024
CHECKS = ('pbr_fields', 'texture_roles', 'normal_prerequisites')
KNOWN = {'KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_texture_transform'}


class Budget(ValueError):
    pass


class Unsupported(ValueError):
    pass


def integer(value):
    return type(value) is int and value >= 0


def number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def retain_row(result, key, row, occurrences=1):
    """Bound persisted details independently of the analysis work budget."""
    metrics = result['metrics']
    rows = result['diagnostics'] if key == 'diagnostics' else metrics['texture_uses']
    bounded = {k: v[:256] if isinstance(v, str) else v for k, v in row.items() if k != 'occurrences'}
    if bounded != {k: v for k, v in row.items() if k != 'occurrences'}:
        metrics[key + '_text_truncated'] = metrics.get(key + '_text_truncated', 0) + occurrences
    def identity(r):
        return {k: re.sub(r'\.primitives\.\d+', '.primitives.*', v) if k == 'field' else v
                for k, v in r.items() if k != 'occurrences'}
    for saved in rows:
        if identity(saved) == identity(bounded):
            saved['occurrences'] = saved.get('occurrences', 1) + occurrences
            metrics[key + '_aggregated'] = metrics.get(key + '_aggregated', 0) + occurrences
            return
    bounded['occurrences'] = occurrences
    size = len(json.dumps(rows + [bounded], ensure_ascii=False).encode('utf-8'))
    if len(rows) >= MAX_ROWS or size > MAX_ROW_BYTES:
        metrics[key + '_omitted'] = metrics.get(key + '_omitted', 0) + occurrences
    else:
        rows.append(bounded)
        metrics[key + '_aggregated'] = metrics.get(key + '_aggregated', 0) + occurrences - 1


def compact_evidence(result):
    """Migrate old detailed reports without changing their check states."""
    metrics = dict(result['metrics'], texture_uses=[])
    compact = dict(result, metrics=metrics, diagnostics=[])
    for key, rows in (('diagnostics', result.get('diagnostics', [])),
                      ('texture_uses', result['metrics'].get('texture_uses', []))):
        metrics[key + '_aggregated'] = 0
        for row in rows:
            retain_row(compact, key, row, row.get('occurrences', 1))
    return compact


class Inspector:
    def __init__(self, path, limits):
        self.path = os.fspath(path)
        self.limits = limits
        self.result = {'schema_version': 1, 'status': 'ok',
                       'metrics': {'checks': dict.fromkeys(CHECKS, 'pass'),
                                   'bytes': 0, 'pixels': 0, 'operations': 0,
                                   'materials': 0, 'texture_uses': []},
                       'units': {'factors': 'dimensionless', 'pixels': 'px', 'bytes': 'bytes', 'operations': 'operations'},
                       'assumptions': {'epsilon': EPSILON, 'encoding': 'usage is not encoding evidence',
                                       'alpha': 'linear coverage, separate from colour RGB',
                                       'normals': 'no inferred green convention; tangents may be generated',
                                       'rgb_length_tolerance': 2 * math.sqrt(3) / 255 + EPSILON,
                                       'budgets': dict(limits),
                                       'work': 'conservative byte/allocation and operation reservations',
                                       'scope': 'syntactic and prerequisite evidence only'},
                       'diagnostics': []}
        self.cache, self.images = {}, {}

    def reserve(self, kind, amount):
        if not integer(amount) or self.result['metrics'][kind] + amount > self.limits[kind]:
            raise Budget(kind)
        self.result['metrics'][kind] += amount

    def diag(self, check, code, material=None, field='', severity='issue'):
        self.reserve('operations', 1)
        retain_row(self.result, 'diagnostics', dict(check=check, code=code, material=material,
                                                  field=field, severity=severity))
        states = self.result['metrics']['checks']
        if severity == 'unknown':
            states[check] = 'unknown'
        elif severity == 'issue' and states[check] != 'unknown':
            states[check] = 'issues'

    def item(self, table, index):
        items = self.g.get(table, [])
        if not integer(index) or index >= len(items) or not isinstance(items[index], dict):
            raise Unsupported('index.' + table)
        return items[index]

    def extensions(self, obj, check, material, field):
        ext = obj.get('extensions', {})
        if not isinstance(ext, dict):
            self.diag(check, 'extension.type', material, field + '.extensions')
            return {}
        for name, value in ext.items():
            self.reserve('operations', 1)
            if name not in KNOWN or not isinstance(value, dict):
                self.diag(check, 'extension.unknown', material, field + '.extensions.' + name, 'unknown')
        return ext

    def factor(self, obj, key, default, material, field, low=0, high=1):
        value = obj.get(key, default)
        values = value if isinstance(default, list) else [value]
        field = field + key
        if isinstance(default, list) and (not isinstance(value, list) or len(value) != len(default)):
            self.diag('pbr_fields', 'pbr.type', material, field)
        elif any(type(v) not in (int, float) for v in values):
            self.diag('pbr_fields', 'pbr.type', material, field)
        elif any(not number(v) for v in values):
            self.diag('pbr_fields', 'pbr.nonfinite', material, field)
        elif any(v < low or (high is not None and v > high) for v in values):
            self.diag('pbr_fields', 'pbr.range', material, field)

    def image_bytes(self, image):
        if image.get('extensions'):
            raise Unsupported('image.extensions')
        if 'uri' in image:
            uri = image['uri']
            if not isinstance(uri, str):
                raise Unsupported('image.uri')
            if uri.startswith('data:'):
                size = data_uri_size(uri)
                self.reserve('bytes', 2 * len(uri) + 2 * size)
            else:
                size = os.path.getsize(resource_path(self.path, uri))
                self.reserve('bytes', size)
            self.reserve('operations', size)
            return uri_bytes(self.path, uri, size=size, cache=self.cache)
        view = self.item('bufferViews', image.get('bufferView'))
        return self.view_bytes(view)

    def view_bytes(self, view):
        if view.get('extensions'):
            raise Unsupported('accessor.compressed')
        size, offset = view.get('byteLength'), view.get('byteOffset', 0)
        if not integer(size) or not integer(offset):
            raise Unsupported('bufferView.range')
        buf = self.item('buffers', view.get('buffer'))
        if not integer(buf.get('byteLength')) or offset + size > buf['byteLength']:
            raise Unsupported('bufferView.range')
        uri = buf.get('uri', '')
        extra = 2 * len(uri) + data_uri_size(uri) if uri.startswith('data:') else 0
        self.reserve('bytes', size + extra)
        self.reserve('operations', size + extra)
        raw = buffer_bytes(self.path, self.g, self.binary, view['buffer'], offset, size, self.cache)
        if len(raw) != size:
            raise Unsupported('bufferView.truncated')
        return raw

    def image(self, index):
        if index in self.images:
            return self.images[index]
        image = self.item('images', index)
        raw = self.image_bytes(image)
        profile = False
        if raw.startswith(b'\x89PNG\r\n\x1a\n'):
            # Pillow eagerly expands text/ICC metadata at open. Keep only chunks
            # this analyzer uses, before handing any bytes to the image parser.
            self.reserve('bytes', len(raw) * 4)
            safe = bytearray(raw[:8])
            offset = 8
            while offset < len(raw):
                self.reserve('operations', 1)
                if len(raw) - offset < 12:
                    raise Unsupported('image.png_truncated')
                size, kind = struct.unpack_from('>I4s', raw, offset)
                end = offset + size + 12
                if end > len(raw):
                    raise Unsupported('image.png_truncated')
                if kind in (b'acTL', b'fcTL', b'fdAT'):
                    raise Unsupported('image.format')
                profile |= kind == b'iCCP'
                if kind in (b'IHDR', b'PLTE', b'tRNS', b'IDAT', b'IEND', b'gAMA', b'sRGB'):
                    safe.extend(raw[offset:end])
                offset = end
            raw = bytes(safe)
        try:
            from PIL import Image
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as im:
                    if im.format not in ('PNG', 'JPEG') or getattr(im, 'n_frames', 1) != 1:
                        raise Unsupported('image.format')
                    pixels = im.width * im.height
                    self.reserve('pixels', pixels)
                    self.reserve('operations', pixels * 64)
                    # Reserve Pillow and NumPy payloads before load; no convert/resize.
                    self.reserve('bytes', pixels * 96)
                    if im.mode not in ('RGB', 'RGBA', 'LA', 'L'):
                        raise Unsupported('image.channels')
                    encoding = 'srgb' if 'srgb' in im.info else 'unknown'
                    if encoding == 'unknown' and number(im.info.get('gamma')) and abs(im.info['gamma'] - 1) <= EPSILON:
                        encoding = 'linear'
                    if profile or 'icc_profile' in im.info:
                        encoding = 'unknown'  # no unbounded profile interpretation
                    import numpy as np
                    im.load()
                    array = np.asarray(im).copy()
                    self.images[index] = (array, encoding, im.mode)
        except (Image.DecompressionBombWarning, Image.DecompressionBombError) as e:
            raise Budget('image.decompression') from e
        except (OSError, SyntaxError) as e:
            raise Unsupported('image.decode') from e
        return self.images[index]

    def texture(self, info, role, material, field):
        if not isinstance(info, dict):
            self.diag('texture_roles', 'texture.type', material, field)
            return None
        ext = self.extensions(info, 'texture_roles', material, field)
        transform = ext.get('KHR_texture_transform', {})
        if not isinstance(transform, dict):
            transform = {}
        for key, default in (('offset', [0, 0]), ('scale', [1, 1]), ('rotation', 0)):
            value = transform.get(key, default)
            values = value if isinstance(default, list) and isinstance(value, list) else [value]
            if ((isinstance(default, list) and (not isinstance(value, list) or len(value) != 2))
                    or any(not number(v) for v in values)):
                self.diag('texture_roles', 'texture.transform_unknown', material, field, 'unknown')
        uv = transform.get('texCoord', info.get('texCoord', 0))
        try:
            if not integer(uv):
                raise Unsupported('texture.uv_index')
            tex = self.item('textures', info.get('index'))
            if tex.get('extensions'):
                raise Unsupported('texture.extensions')
            source = tex.get('source')
            self.item('images', source)
            if 'sampler' in tex:
                sampler = self.item('samplers', tex['sampler'])
                if sampler.get('extensions'):
                    raise Unsupported('texture.sampler_extensions')
                for key, legal in {'magFilter': (9728, 9729), 'minFilter': (9728, 9729, 9984, 9985, 9986, 9987),
                                   'wrapS': (33071, 33648, 10497), 'wrapT': (33071, 33648, 10497)}.items():
                    if key in sampler and (type(sampler[key]) is not int or sampler[key] not in legal):
                        raise Unsupported('texture.sampler')
            pixels, encoding, mode = self.image(source)
        except (Unsupported, ValueError, OSError, KeyError, TypeError) as e:
            if isinstance(e, Budget):
                raise
            self.diag('texture_roles', str(e) if isinstance(e, Unsupported) else 'texture.unreadable', material, field, 'unknown')
            return None
        expected = 'srgb' if role in ('colour', 'emissive') else 'linear'
        retain_row(self.result, 'texture_uses', dict(material=material, field=field, image=source,
                                                    uv=uv, role=role, rgb=expected, alpha='linear'))
        if encoding == 'unknown':
            self.diag('texture_roles', 'texture.encoding_unknown', material, field, 'unknown')
        elif encoding != expected:
            self.diag('texture_roles', 'texture.encoding_conflict', material, field)
        return source, uv, pixels, mode

    def accessor(self, index, width, indices=False):
        a = self.item('accessors', index)
        if a.get('sparse') or a.get('extensions') or a.get('normalized'):
            raise Unsupported('accessor.encoding')
        formats = {5121: 'B', 5123: 'H', 5125: 'I'} if indices else {5126: 'f'}
        fmt = formats.get(a.get('componentType'))
        if fmt is None or a.get('type') != ('SCALAR' if indices else 'VEC' + str(width)):
            raise Unsupported('accessor.type')
        element = struct.calcsize('<' + fmt * width)
        count = a.get('count')
        if not integer(count):
            raise Unsupported('accessor.count')
        self.reserve('operations', count * width * 8)
        self.reserve('bytes', count * width * 128)
        view = self.item('bufferViews', a.get('bufferView'))
        stride, offset = view.get('byteStride', element), a.get('byteOffset', 0)
        if not integer(stride) or stride < element or not integer(offset):
            raise Unsupported('accessor.range')
        end = offset + (count - 1) * stride + element if count else offset
        if not integer(view.get('byteLength')) or end > view['byteLength']:
            raise Unsupported('accessor.range')
        raw = self.view_bytes(view)
        values = [struct.unpack_from('<' + fmt * width, raw, offset + i * stride) for i in range(count)]
        if any(not number(v) for row in values for v in row):
            raise Unsupported('accessor.nonfinite')
        return values

    def normals(self, material, info, resolved, primitives):
        scale = info.get('scale', 1)
        if not number(scale):
            self.diag('normal_prerequisites', 'normal.scale_type' if type(scale) not in (int, float) else 'normal.scale_nonfinite', material, 'normalTexture.scale')
        elif scale <= 0:
            self.diag('normal_prerequisites', 'normal.scale_negative' if scale < 0 else 'normal.scale_zero', material, 'normalTexture.scale', 'info')
        if not resolved:
            self.diag('normal_prerequisites', 'normal.texture_unknown', material, 'normalTexture', 'unknown')
            return
        _, uv, pixels, mode = resolved
        if mode not in ('RGB', 'RGBA'):
            self.diag('normal_prerequisites', 'normal.two_channel_unknown', material, 'normalTexture', 'unknown')
        else:
            import numpy as np
            self.reserve('operations', pixels.shape[0] * pixels.shape[1] * 64)
            self.reserve('bytes', pixels.shape[0] * pixels.shape[1] * 96)
            xyz = pixels[..., :3].astype(np.float64) / 127.5 - 1
            squared = np.sum(xyz * xyz, axis=2)
            tolerance = 2 * math.sqrt(3) / 255 + EPSILON
            if np.any(np.abs(np.sqrt(squared) - 1) > tolerance):
                self.diag('normal_prerequisites', 'normal.rgb_nonunit_candidate', material, 'normalTexture')
            if np.all(np.max(xyz, axis=(0, 1)) - np.min(xyz, axis=(0, 1)) <= EPSILON):
                self.diag('normal_prerequisites', 'normal.flat_candidate', material, 'normalTexture', 'info')
        for mesh, prim, p in primitives:
            field = 'meshes.%d.primitives.%d' % (mesh, prim)
            attrs = p.get('attributes', {})
            if 'TEXCOORD_%d' % uv not in attrs:
                self.diag('normal_prerequisites', 'normal.uv_missing', material, field)
                continue
            if 'NORMAL' not in attrs:
                self.diag('normal_prerequisites', 'normal.vertex_normals_missing', material, field, 'unknown')
                continue
            try:
                coords = self.accessor(attrs['TEXCOORD_%d' % uv], 2)
                normals = self.accessor(attrs['NORMAL'], 3)
                if len(coords) != len(normals):
                    raise Unsupported('normal.attribute_count')
                if not coords:
                    raise Unsupported('normal.empty_attributes')
                if any(sum(v*v for v in n) <= EPSILON**2 for n in normals):
                    self.diag('normal_prerequisites', 'normal.vertex_normal_degenerate', material, field)
                if 'TANGENT' not in attrs:
                    self.diag('normal_prerequisites', 'normal.tangents_generated_or_unknown', material, field, 'unknown')
                else:
                    tangents = self.accessor(attrs['TANGENT'], 4)
                    if len(tangents) != len(normals):
                        raise Unsupported('normal.attribute_count')
                    for t, n in zip(tangents, normals):
                        if (abs(math.sqrt(sum(v*v for v in t[:3])) - 1) > EPSILON or
                                abs(abs(t[3]) - 1) > EPSILON or
                                abs(sum(t[i]*n[i] for i in range(3))) > EPSILON):
                            self.diag('normal_prerequisites', 'normal.tangent_degenerate', material, field)
                            break
                if p.get('mode', 4) != 4 or p.get('extensions'):
                    raise Unsupported('normal.topology_unknown')
                if 'indices' in p:
                    indices = self.accessor(p['indices'], 1, indices=True)
                    self.reserve('operations', len(indices) * 16)
                    order = [row[0] for row in indices]
                else:
                    self.reserve('operations', len(coords) * 16)
                    order = range(len(coords))
                if len(order) % 3 or any(index >= len(coords) for index in order):
                    raise Unsupported('normal.indices')
                for k in range(0, len(order), 3):
                    a, b, c = (coords[order[k+j]] for j in range(3))
                    determinant = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
                    if abs(determinant) <= EPSILON:
                        self.diag('normal_prerequisites', 'normal.uv_degenerate', material, field)
                        break
            except (Unsupported, KeyError, ValueError, TypeError) as e:
                if isinstance(e, Budget):
                    raise
                self.diag('normal_prerequisites', str(e) if isinstance(e, Unsupported) else 'normal.accessor_unknown', material, field, 'unknown')

    def run(self):
        size = os.path.getsize(self.path)
        # Source bytes bound the parser work, including GLB chunk traversal.
        # This conservative reservation intentionally rejects very large BINs.
        self.reserve('operations', size)
        self.reserve('bytes', size * 32)
        if not self.path.lower().endswith('.gltf'):
            # Validate advertised chunk sizes against the physical file before
            # the shared reader can reserve a read buffer from a corrupt header.
            with open(self.path, 'rb') as stream:
                header = stream.read(12)
                if len(header) != 12:
                    raise Unsupported('document.truncated')
                magic, version, length = struct.unpack('<4sII', header)
                if magic != b'glTF' or version != 2 or length != size:
                    raise Unsupported('document.header')
                while stream.tell() < size:
                    self.reserve('operations', 1)
                    header = stream.read(8)
                    if len(header) != 8:
                        raise Unsupported('document.truncated')
                    chunk_size, _ = struct.unpack('<I4s', header)
                    if chunk_size > size - stream.tell():
                        raise Unsupported('document.truncated')
                    stream.seek(chunk_size, 1)
        self.g, self.binary = gltf_document(self.path)
        if not isinstance(self.g, dict) or self.g.get('asset', {}).get('version') != '2.0':
            raise Unsupported('document.version')
        for key in ('materials', 'textures', 'images', 'meshes', 'accessors', 'bufferViews', 'buffers', 'samplers'):
            if not isinstance(self.g.get(key, []), list):
                raise Unsupported('document.table')
            self.reserve('operations', len(self.g.get(key, [])))
        for check in CHECKS:
            self.extensions(self.g, check, None, 'document')
        for name in sorted(set(self.g.get('extensionsUsed', []) + self.g.get('extensionsRequired', []))):
            if name not in KNOWN:
                for check in CHECKS:
                    self.diag(check, 'extension.unknown', field=name, severity='unknown')
        primitives = {}
        for mi, mesh in enumerate(self.g.get('meshes', [])):
            for pi, p in enumerate(mesh.get('primitives', [])):
                self.reserve('operations', 1)
                if 'material' in p:
                    try:
                        self.item('materials', p['material'])
                    except Unsupported:
                        self.diag('pbr_fields', 'material.index_invalid', field='meshes.%d.primitives.%d.material' % (mi, pi), severity='unknown')
                primitives.setdefault(p.get('material'), []).append((mi, pi, p))
        uses = {}
        for i, material in enumerate(self.g.get('materials', [])):
            self.reserve('operations', 64)
            self.result['metrics']['materials'] += 1
            if not isinstance(material, dict):
                self.diag('pbr_fields', 'pbr.type', i, 'material')
                continue
            ext = self.extensions(material, 'pbr_fields', i, 'material')
            unlit = 'KHR_materials_unlit' in ext
            pbr = material.get('pbrMetallicRoughness', {})
            if not isinstance(pbr, dict):
                self.diag('pbr_fields', 'pbr.type', i, 'pbrMetallicRoughness')
                pbr = {}
            self.factor(pbr, 'baseColorFactor', [1, 1, 1, 1], i, 'pbrMetallicRoughness.')
            self.extensions(pbr, 'pbr_fields', i, 'pbrMetallicRoughness')
            for key in ('metallicFactor', 'roughnessFactor'):
                self.factor(pbr, key, 1, i, 'pbrMetallicRoughness.')
            self.factor(material, 'emissiveFactor', [0, 0, 0], i, '')
            self.factor(material, 'alphaCutoff', .5, i, '', high=None)
            if material.get('alphaMode', 'OPAQUE') not in ('OPAQUE', 'MASK', 'BLEND'):
                self.diag('pbr_fields', 'pbr.enum', i, 'alphaMode')
            if type(material.get('doubleSided', False)) is not bool:
                self.diag('pbr_fields', 'pbr.type', i, 'doubleSided')
            strength = ext.get('KHR_materials_emissive_strength', {})
            if isinstance(strength, dict):
                self.factor(strength, 'emissiveStrength', 1, i, 'extensions.KHR_materials_emissive_strength.', high=None)
            slots = [(pbr, 'baseColorTexture', 'colour', 'pbrMetallicRoughness.')]
            if not unlit:
                slots += [(pbr, 'metallicRoughnessTexture', 'orm', 'pbrMetallicRoughness.'),
                          (material, 'emissiveTexture', 'emissive', ''), (material, 'occlusionTexture', 'occlusion', ''),
                          (material, 'normalTexture', 'normal', '')]
            for owner, key, role, prefix in slots:
                if key not in owner:
                    continue
                info = owner[key]
                if key == 'occlusionTexture' and isinstance(info, dict):
                    self.factor(info, 'strength', 1, i, key + '.')
                resolved = self.texture(info, role, i, prefix + key)
                if resolved:
                    source = resolved[0]
                    uses.setdefault(source, []).append((i, prefix + key, role))
                    for mesh, prim, p in primitives.get(i, []):
                        attrs = p.get('attributes', {})
                        uv_key = 'TEXCOORD_%d' % resolved[1]
                        location = 'meshes.%d.primitives.%d.%s' % (mesh, prim, prefix + key)
                        if uv_key not in attrs:
                            self.diag('texture_roles', 'texture.uv_missing', i,
                                      location)
                        else:
                            try:
                                uv_accessor = self.item('accessors', attrs[uv_key])
                                if uv_accessor.get('type') != 'VEC2' or not integer(uv_accessor.get('count')):
                                    raise Unsupported('texture.uv_accessor')
                            except Unsupported:
                                self.diag('texture_roles', 'texture.uv_accessor', i, location, 'unknown')
                if role == 'normal' and isinstance(info, dict):
                    self.normals(i, info, resolved, primitives.get(i, []))
            if unlit:
                self.diag('pbr_fields', 'pbr.unlit_ignored_lighting', i, 'extensions.KHR_materials_unlit', 'info')
        for rows in uses.values():
            if any(r[2] in ('colour', 'emissive') for r in rows) and any(r[2] not in ('colour', 'emissive') for r in rows):
                for i, field, _ in rows:
                    self.diag('texture_roles', 'texture.colour_data_reuse', i, field, 'unknown')
        if 'unknown' in self.result['metrics']['checks'].values():
            self.result['status'] = 'unsupported'
        return self.result


def analyze(path, *, max_bytes=LIMITS['bytes'], max_pixels=LIMITS['pixels'], max_operations=LIMITS['operations']):
    """Inspect a confined submission; budget reservations precede payload allocation."""
    inspector = Inspector(path, dict(bytes=max_bytes, pixels=max_pixels, operations=max_operations))
    try:
        return inspector.run()
    except Exception as error:
        # Fail closed, retaining bounded findings but never a partial pass.
        inspector.result['status'] = 'budget_exceeded' if isinstance(error, Budget) else 'unsupported'
        inspector.result['metrics']['checks'] = dict.fromkeys(CHECKS, 'unknown')
        code = 'budget.exceeded' if isinstance(error, Budget) else str(error) if isinstance(error, Unsupported) else 'input.unsupported'
        retain_row(inspector.result, 'diagnostics', dict(check='material_sanity', code=code,
                                                        material=None, field='', severity='unknown'))
        return inspector.result
