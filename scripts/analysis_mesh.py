"""Read-only bounded glTF 2 mesh input and tight world-space bounds.

API: load_mesh(path, limits=Limits(), scene=None) returns an immutable MeshInput.
Its repeatable iter_vertices() yields referenced world points, once per primitive
instance; iter_triangles() yields Triangle records in authored index order (also
under mirrored transforms). Bounds use actual referenced points, never accessor
min/max or transformed local boxes. Each iterator pass is bounded by the admitted
vertex/triangle counts and reserved operation estimate; no disk reads occur on
iteration. MeshError carries unsupported or budget_exceeded for API callers.

Supported: FLOAT/VEC3 POSITION, unsigned byte/short/int SCALAR indices, packed or
explicit aligned strides, TRIANGLES, affine column-major matrices or unit xyzw
quaternion TRS, including nested, nonuniform, mirrored and zero scales. Only the
selected scene is traversed (default scene, otherwise scene 0). A node must have
one path in that scene. Sparse, compressed, skin, morph and required extension
data are refused. Authored static transforms are used; animation is not sampled.

Bytes include input, conservative metadata/decoded storage and resource copies;
counts and work are reserved before geometry reads/allocations. Limits can only
lower hard ceilings. Preflight provides resource confinement and bounded reads.
No units are inferred or converted; optional length_unit labels caller evidence.
CLI: python scripts/analysis_mesh.py asset.glb [--scene 0] [--length-unit m]
Analyzed inputs emit the analysis v1 JSON envelope; failure metrics have no bounds.
"""

import argparse
from dataclasses import dataclass, fields
import json
import math
import os
import stat
import struct

if __package__:
    from . import preflight as pf
else:
    import preflight as pf


@dataclass(frozen=True)
class Limits:
    max_bytes: int = 128 * 1024**2
    max_vertices: int = 200_000
    max_triangles: int = 200_000
    max_operations: int = 50_000_000


class MeshError(ValueError):
    def __init__(self, message, status="unsupported"):
        super().__init__(message)
        self.status = status


def _require(condition, message):
    if not condition:
        raise MeshError(message)


def _integer(value, label):
    _require(type(value) is int and value >= 0, label + " must be a nonnegative integer")
    return value


class _Budget:
    def __init__(self, limits):
        _require(isinstance(limits, Limits), "limits must be Limits")
        self.limits = limits
        self.used = dict(bytes=0, vertices=0, triangles=0, operations=0)
        for field in fields(limits):
            value = _integer(getattr(limits, field.name), field.name)
            _require(value <= getattr(Limits(), field.name), "limits exceed hard ceiling")

    def reserve(self, **amounts):
        for key, amount in amounts.items():
            if self.used[key] + amount > getattr(self.limits, "max_" + key):
                raise MeshError(key + " budget exceeded", "budget_exceeded")
        for key, amount in amounts.items():
            self.used[key] += amount

    def reserve_chunk(self):
        self.reserve(operations=1)

    def reserve_json(self, size):
        self.reserve(bytes=size * 64, operations=size)


def _object(value):
    _require(isinstance(value, dict), "expected object")
    return value


def _list(value):
    _require(isinstance(value, list), "expected array")
    return value


def _item(values, index):
    index = _integer(index, "reference")
    _require(index < len(values), "reference out of range")
    return _object(values[index])


def _vector(value, size):
    _require(isinstance(value, (list, tuple)) and len(value) == size, "invalid transform vector")
    _require(all(type(x) in (int, float) and math.isfinite(x) for x in value),
             "nonfinite or invalid transform/position")
    return tuple(float(x) for x in value)


_IDENTITY = ((1., 0., 0., 0.), (0., 1., 0., 0.), (0., 0., 1., 0.), (0., 0., 0., 1.))


def _local(node):
    if "matrix" in node:
        _require(not any(k in node for k in ("translation", "rotation", "scale")), "matrix with TRS")
        m = _vector(node["matrix"], 16)
        result = tuple(tuple(m[c * 4 + r] for c in range(4)) for r in range(4))
        _require(result[3] == (0., 0., 0., 1.), "non-affine matrix")
        return result
    t = _vector(node.get("translation", [0, 0, 0]), 3)
    s = _vector(node.get("scale", [1, 1, 1]), 3)
    x, y, z, w = _vector(node.get("rotation", [0, 0, 0, 1]), 4)
    _require(abs(math.hypot(x, y, z, w) - 1) <= 1e-6, "rotation must be a unit quaternion")
    r = ((1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)),
         (2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)),
         (2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)))
    return tuple(tuple(r[i][j]*s[j] for j in range(3)) + (t[i],) for i in range(3)) + (_IDENTITY[3],)


def _multiply(a, b):
    m = tuple(tuple(sum(a[r][k]*b[k][c] for k in range(4)) for c in range(4)) for r in range(4))
    _require(all(math.isfinite(x) for row in m for x in row), "nonfinite world transform")
    return m


def _point(matrix, point):
    p = tuple(sum(matrix[r][c]*point[c] for c in range(3)) + matrix[r][3] for r in range(3))
    _require(all(math.isfinite(x) for x in p), "nonfinite world position")
    return p


@dataclass(frozen=True)
class _Primitive:
    positions: tuple
    indices: tuple
    referenced: tuple


@dataclass(frozen=True)
class MeshInstance:
    node: int
    mesh: int
    primitive: int
    world_matrix: tuple
    geometry: _Primitive


@dataclass(frozen=True)
class Triangle:
    node: int
    mesh: int
    primitive: int
    vertices: tuple


@dataclass(frozen=True)
class MeshInput:
    instances: tuple
    scene: int
    vertex_count: int
    triangle_count: int
    operations_reserved: int
    bytes_reserved: int

    def iter_vertices(self):
        for instance in self.instances:
            for index in instance.geometry.referenced:
                yield _point(instance.world_matrix, instance.geometry.positions[index])

    def iter_triangles(self):
        for instance in self.instances:
            g = instance.geometry
            for offset in range(0, len(g.indices), 3):
                yield Triangle(instance.node, instance.mesh, instance.primitive,
                               tuple(_point(instance.world_matrix, g.positions[g.indices[offset+k]])
                                     for k in range(3)))


@dataclass(frozen=True)
class _Layout:
    buffer: int
    offset: int
    span: int
    stride: int
    count: int
    format: str


def _document(path, budget):
    info = os.stat(path)
    _require(stat.S_ISREG(info.st_mode), "input must be a regular file")
    budget.reserve(bytes=info.st_size)
    # Older analysis adapters expose only reserve(); preflight opts into explicit
    # admission hooks so chunk/JSON ceilings do not depend on generic accounting.
    reserve_chunk = getattr(budget, "reserve_chunk", lambda: budget.reserve(operations=1))
    reserve_json = getattr(budget, "reserve_json", lambda size: budget.reserve(bytes=size * 64, operations=size))
    json_size = info.st_size
    if str(path).lower().endswith(".glb"):
        # Preflight's parser is reused only after chunk traversal itself is bounded.
        with open(path, "rb") as stream:
            magic, version, length = struct.unpack("<4sII", stream.read(12))
            _require(magic == b"glTF" and version == 2 and length == info.st_size, "invalid GLB header")
            offset, seen, json_size = 12, set(), 0
            while offset < length:
                reserve_chunk()
                _require(offset + 8 <= length, "truncated GLB chunk")
                size, kind = struct.unpack("<I4s", stream.read(8))
                _require(size % 4 == 0 and offset + 8 + size <= length, "invalid GLB chunk length")
                if kind in (b"JSON", b"BIN\0"):
                    _require(kind not in seen, "duplicate GLB chunk")
                    seen.add(kind)
                if offset == 12:
                    _require(kind == b"JSON", "GLB must start with JSON")
                if kind == b"JSON":
                    json_size = size
                stream.seek(size, 1)
                offset += 8 + size
            _require(json_size > 0, "missing GLB JSON")
    else:
        _require(str(path).lower().endswith(".gltf"), "expected .gltf or .glb")
    # Reserve conservative JSON container overhead and parsing work before parsing.
    reserve_json(json_size)
    g, binary = pf.gltf_document(path)
    _require(_object(g).get("asset", {}).get("version") == "2.0", "expected glTF 2.0")
    budget.reserve(bytes=pf.resource_workload_bytes(path, g) - info.st_size)
    return g, binary


def _layout(g, binary, path, index, position, budget):
    a = _item(_list(g.get("accessors", [])), index)
    _require("sparse" not in a and not a.get("extensions"), "sparse/extended accessor unsupported")
    _require(a.get("normalized", False) is False, "normalized accessor unsupported")
    component = a.get("componentType")
    _require(type(component) is int and ((position and component == 5126 and a.get("type") == "VEC3")
             or (not position and component in (5121, 5123, 5125) and a.get("type") == "SCALAR")),
             "unsupported accessor layout")
    count = _integer(a.get("count"), "accessor count")
    cap = budget.limits.max_vertices if position else budget.limits.max_triangles * 3
    if count > cap:
        raise MeshError("accessor count budget exceeded", "budget_exceeded")
    view = _item(_list(g.get("bufferViews", [])), a.get("bufferView"))
    _require(not view.get("extensions"), "compressed/extended bufferView unsupported")
    buffer_index = _integer(view.get("buffer", 0), "buffer")
    buffer = _item(_list(g.get("buffers", [])), buffer_index)
    _require(not buffer.get("extensions"), "compressed/extended buffer unsupported")
    length = _integer(buffer.get("byteLength"), "buffer length")
    view_offset = _integer(view.get("byteOffset", 0), "bufferView offset")
    view_length = _integer(view.get("byteLength"), "bufferView length")
    offset = _integer(a.get("byteOffset", 0), "accessor offset")
    fmt = "<3f" if position else "<" + pf.COMP[component]
    element, alignment = struct.calcsize(fmt), 4 if position else struct.calcsize(fmt)
    stride = _integer(view.get("byteStride", element), "stride")
    _require(stride >= element and stride % alignment == 0 and
             ("byteStride" not in view or 4 <= stride <= 252), "invalid accessor stride")
    _require(offset % alignment == 0 and (view_offset + offset) % alignment == 0, "unaligned accessor")
    span = (count-1)*stride + element if count else 0
    _require(offset + span <= view_length and view_offset + view_length <= length,
             "accessor overflow beyond bufferView/buffer")
    uri = buffer.get("uri")
    if uri:
        available = pf.data_uri_size(uri) if uri.startswith("data:") else os.path.getsize(pf.resource_path(path, uri))
    else:
        _require(buffer_index == 0 and binary is not None, "missing buffer")
        available = binary[1]
    _require(length <= available, "declared buffer exceeds resource")
    return _Layout(buffer_index, view_offset + offset, span, stride, count, fmt)


def _load(path, limits, scene):
    budget = _Budget(limits)
    g, binary = _document(path, budget)
    _require(not g.get("extensionsRequired"), "required extensions unsupported")
    _require(not g.get("skins"), "skinned data unsupported")
    nodes, scenes, meshes = (_list(g.get(k, [])) for k in ("nodes", "scenes", "meshes"))
    scene = g.get("scene", 0) if scene is None else scene
    roots = _list(_item(scenes, scene).get("nodes", []))
    budget.reserve(bytes=len(nodes)*1024, operations=len(nodes) + len(roots))
    visited, instances, plans, layouts = set(), [], {}, {}

    def layout(index, position):
        key = (index, position)
        if key not in layouts:
            budget.reserve(bytes=512, operations=32)
            layouts[key] = _layout(g, binary, path, index, position, budget)
        return layouts[key]

    # Iterative DFS visits children in authored order without recursion/depth risk.
    stack = [(index, _IDENTITY) for index in reversed(roots)]
    while stack:
        budget.reserve(operations=256)
        index, parent = stack.pop()
        node = _item(nodes, index)
        _require(index not in visited, "cycle or repeated node path in selected scene")
        visited.add(index)
        _require("skin" not in node and not node.get("weights") and not node.get("extensions"),
                 "skin/morph/extended node unsupported")
        world = _multiply(parent, _local(node))
        children = _list(node.get("children", []))
        budget.reserve(bytes=len(children)*128, operations=len(children))
        stack.extend((child, world) for child in reversed(children))
        if "mesh" not in node:
            continue
        mesh_index = node["mesh"]
        mesh = _item(meshes, mesh_index)
        _require(not mesh.get("weights") and not mesh.get("extensions"), "morph/extended mesh unsupported")
        primitives = _list(mesh.get("primitives", []))
        budget.reserve(operations=len(primitives))
        for primitive_index, primitive in enumerate(primitives):
            key = (mesh_index, primitive_index)
            if key not in plans:
                primitive = _object(primitive)
                _require(type(primitive.get("mode", 4)) is int and primitive.get("mode", 4) == 4,
                         "only TRIANGLES mode supported")
                _require(not primitive.get("targets") and not primitive.get("extensions"),
                         "morph/compressed/extended primitive unsupported")
                attributes = _object(primitive.get("attributes"))
                _require(not any(k.startswith(("JOINTS_", "WEIGHTS_")) for k in attributes), "skinned attributes unsupported")
                positions = layout(attributes.get("POSITION"), True)
                indices = layout(primitive["indices"], False) if "indices" in primitive else None
                count = indices.count if indices else positions.count
                _require(count % 3 == 0, "incomplete triangle list")
                # Includes unpack tuples, index integers, referenced-index set,
                # sorting scratch and the final immutable index/reference tuples.
                budget.reserve(bytes=positions.count*160 + count*192 + 512,
                               operations=positions.count*8 + count*4)
                plans[key] = (positions, indices, count)
            positions, indices, count = plans[key]
            budget.reserve(vertices=positions.count, triangles=count//3, bytes=1024,
                           operations=positions.count*100 + count*40)
            instances.append((index, mesh_index, primitive_index, world, key))

    # All counts, layouts and per-instance work are admitted before decoding.
    decoded, cache, embedded = {}, {}, set()

    def decode(spec):
        if spec not in decoded:
            budget.reserve(bytes=spec.span, operations=spec.span)
            uri = g["buffers"][spec.buffer].get("uri", "")
            if uri.startswith("data:") and uri not in embedded:
                budget.reserve(bytes=2*len(uri) + pf.data_uri_size(uri), operations=len(uri))
                embedded.add(uri)
            raw = pf.buffer_bytes(path, g, binary, spec.buffer, spec.offset, spec.span, cache=cache)
            _require(len(raw) == spec.span, "truncated accessor data")
            decoded[spec] = tuple(struct.unpack_from(spec.format, raw, i*spec.stride) for i in range(spec.count))
        return decoded[spec]

    geometries = {}
    for key, (positions, indices, count) in plans.items():
        points = decode(positions)
        _require(all(math.isfinite(x) for point in points for x in point), "nonfinite POSITION")
        order = tuple(v[0] for v in decode(indices)) if indices else tuple(range(count))
        _require(all(i < len(points) for i in order), "index outside POSITION accessor")
        geometries[key] = _Primitive(points, order, tuple(sorted(set(order))))
    result = MeshInput(tuple(MeshInstance(n, m, p, world, geometries[key])
                             for n, m, p, world, key in instances), scene,
                       budget.used["vertices"], budget.used["triangles"],
                       budget.used["operations"], budget.used["bytes"])
    # No iterator can later expose fabricated nonfinite world points.
    for _ in result.iter_vertices():
        pass
    return result


def load_mesh(path, *, limits=Limits(), scene=None):
    """Load an immutable snapshot or raise MeshError; never mutate the asset."""
    try:
        return _load(path, limits, scene)
    except MeshError:
        raise
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError,
            OverflowError, RecursionError, struct.error) as error:
        status = "budget_exceeded" if "limit" in str(error) else "unsupported"
        raise MeshError("invalid or unavailable mesh input: " + str(error), status) from error


def analyze(path, *, limits=Limits(), scene=None, length_unit=None):
    """Return the analysis v1 envelope. Unknown units remain null."""
    result = {"schema_version": 1, "status": "unsupported", "metrics": {},
              "units": {"length": None},
              "assumptions": {"scene": "selected/default scene, otherwise scene 0",
                              "pose": "authored static transforms; animations not sampled",
                              "bounds": "referenced triangle vertices in world space",
                              "units": "caller supplied label; no inference or conversion",
                              "supported_layouts": ["FLOAT VEC3 POSITION", "unsigned SCALAR indices", "TRIANGLES"]},
              "diagnostics": []}
    try:
        _require(length_unit is None or (isinstance(length_unit, str) and 0 < len(length_unit) <= 64),
                 "length_unit must be an explicit short label")
        result["units"]["length"] = length_unit
        mesh = load_mesh(path, limits=limits, scene=scene)
        low, high = None, None
        for point in mesh.iter_vertices():
            if low is None:
                low, high = list(point), list(point)
            else:
                low = [min(a, b) for a, b in zip(low, point)]
                high = [max(a, b) for a, b in zip(high, point)]
        result.update(status="ok", metrics={"world_aabb": {"min": low, "max": high} if low is not None else None,
                      "scene": mesh.scene, "primitive_instances": len(mesh.instances),
                      "vertices": mesh.vertex_count, "triangles": mesh.triangle_count,
                      "bytes_reserved": mesh.bytes_reserved, "operations_reserved": mesh.operations_reserved})
    except MeshError as error:
        result.update(status=error.status, diagnostics=[str(error)])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--scene", type=int)
    parser.add_argument("--length-unit")
    for field in fields(Limits):
        parser.add_argument("--" + field.name.replace("_", "-"), type=int, default=getattr(Limits(), field.name))
    args = parser.parse_args()
    limits = Limits(**{field.name: getattr(args, field.name) for field in fields(Limits)})
    result = analyze(args.path, limits=limits, scene=args.scene, length_unit=args.length_unit)
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
