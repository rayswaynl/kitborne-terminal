"""Render a repeatable multi-angle review of a saved .blend without saving it.

blender --background --factory-startup FILE.blend --python-exit-code 1
        --python review_angles.py -- --out DIR --targets COLLECTION_OR_OBJECT[,...]
        [--views all|front,rear,...|name:az:el[:dist[:persp|ortho]]]
        [--front -Y] [--engine WORKBENCH|EEVEE|CYCLES] [--res 768] [--ortho] [--isolate]

Pass --targets. Without it, every renderable mesh is treated as the asset,
including other LODs, collision proxies and stage objects that happen to be
visible, which skews camera fitting and the obstruction check. Cameras are
fitted to the targets' evaluated bounds.

The obstruction check is a heuristic: it casts rays to up to ~240 sampled
target vertices and reports the fraction hidden by non-target renderable
objects (stage ground, backdrops, scale figures). It can miss obstructions
between samples; always inspect the images. Low views (< 10 degrees elevation)
use perspective unless a view spec forces ortho, because an orthographic frame
can start rays below the ground.

Writes PNGs, a contact sheet and review.json into --out. Scene changes (camera,
engine, visibility) stay in memory; the .blend is never saved.
"""

import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

VIEWS = {
    "front": (0, 12, 1.0),
    "rear": (180, 12, 1.0),
    "left": (90, 12, 1.0),
    "right": (-90, 12, 1.0),
    "three_quarter": (35, 30, 1.0),
    "rear_three_quarter": (215, 30, 1.0),
    "top": (20, 70, 1.0),
    "low": (25, 3, 1.0),
    "distance": (30, 20, 3.5),
}
FRONTS = {"-Y": 0, "+X": 90, "+Y": 180, "-X": -90}


def args():
    import argparse

    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--targets", default="")
    p.add_argument("--views", default="all")
    p.add_argument("--front", default="-Y", choices=sorted(FRONTS))
    p.add_argument("--engine", default="WORKBENCH")
    p.add_argument("--res", type=int, default=768)
    p.add_argument("--samples", type=int, default=16)
    p.add_argument(
        "--device",
        default="GPU",
        help="Cycles device: GPU (OptiX, then CUDA, else CPU) or CPU",
    )
    p.add_argument("--ortho", action="store_true", help="orthographic except low views")
    p.add_argument(
        "--isolate", action="store_true", help="hide non-target objects from render"
    )
    p.add_argument(
        "--block-warn",
        type=float,
        default=0.02,
        help="warn above this hidden-sample fraction",
    )
    p.add_argument(
        "--no-sheet",
        action="store_true",
        help="caller builds the contact sheet with sharp",
    )
    return p.parse_args(argv)


def resolve_targets(names):
    scene = bpy.context.scene
    if not names:
        return [
            o
            for o in scene.objects
            if o.type == "MESH" and not o.hide_render and o.visible_get()
        ]
    found = []
    for name in names:
        if name in bpy.data.collections:
            found += [
                o for o in bpy.data.collections[name].all_objects if o.type == "MESH"
            ]
        elif name in bpy.data.objects:
            found.append(bpy.data.objects[name])
        else:
            raise SystemExit(f"Unknown target: {name}")
    return list(dict.fromkeys(found))


def sample_points(objects, depsgraph, limit=240):
    """Return (all world vertices for bounds, an evenly spread ray-test sample)."""
    every, pts = [], []
    for o in objects:
        ev = o.evaluated_get(depsgraph)
        mesh = ev.to_mesh()
        world = [ev.matrix_world @ v.co for v in mesh.vertices]
        step = max(1, len(world) // max(1, limit // len(objects)))
        every += world
        pts += world[::step]
        ev.to_mesh_clear()
    return every, pts


def blocked(scene, depsgraph, origin, point, targets):
    direction = point - origin
    length = direction.length
    direction.normalize()
    start, travelled = origin.copy(), 0.0
    for _ in range(16):
        hit, loc, _, _, obj, _ = scene.ray_cast(
            depsgraph, start, direction, distance=length - travelled - 1e-3
        )
        if not hit:
            return None
        original = obj.original if hasattr(obj, "original") else obj
        if original in targets:
            return None
        if not original.hide_render:
            return original.name
        travelled += (loc - start).length + 1e-3
        start = loc + direction * 1e-3
    return None


def cycles_device(want):
    """Return 'GPU' after enabling OptiX (else CUDA) devices, or 'CPU' when asked or none exist.
    --factory-startup ignores user preferences, so the device must be chosen here."""
    if want.upper() != "GPU":
        return "CPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
        except TypeError:
            continue
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            print(f"CYCLES device {kind}: {', '.join(d.name for d in gpus)}")
            return "GPU"
    print("CYCLES device CPU (no OptiX/CUDA device found)")
    return "CPU"


def main():
    a = args()
    assert bpy.app.background, "Run in a background Blender process"
    source, dirty = bpy.data.filepath, bpy.data.is_dirty
    scene = bpy.context.scene
    # The engine enum can be incomplete in background mode; try the assignment.
    engine = {"WORKBENCH": "BLENDER_WORKBENCH", "EEVEE": "BLENDER_EEVEE"}.get(
        a.engine.upper(), a.engine.upper()
    )
    try:
        scene.render.engine = engine
    except TypeError as exc:
        raise SystemExit(f"Render engine {engine} unavailable: {exc}")
    if engine == "BLENDER_WORKBENCH":
        shading = scene.display.shading
        shading.light, shading.color_type = "STUDIO", "TEXTURE"
    if hasattr(scene, "cycles") and engine == "CYCLES":
        scene.cycles.samples = a.samples
        scene.cycles.device = cycles_device(a.device)
    scene.render.resolution_x = scene.render.resolution_y = a.res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    targets = resolve_targets([t for t in a.targets.split(",") if t])
    assert targets, "No target meshes found"
    if not a.targets:
        print(
            "WARNING no --targets: every renderable mesh counts as the asset; other LODs/collision/stage may be included"
        )
    target_set = set(targets)
    if a.isolate:
        for o in scene.objects:
            if o.type == "MESH" and o not in target_set:
                o.hide_render = True
    depsgraph = bpy.context.evaluated_depsgraph_get()
    every, pts = sample_points(targets, depsgraph)
    lo = Vector([min(p[i] for p in every) for i in range(3)])
    hi = Vector([max(p[i] for p in every) for i in range(3)])
    centre, radius = (lo + hi) / 2, max((hi - lo).length / 2, 1e-3)
    cam_data = bpy.data.cameras.new("REVIEW_CAM")
    cam = bpy.data.objects.new("REVIEW_CAM", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.clip_start, cam_data.clip_end = radius * 0.01, radius * 200
    specs = []
    items = []
    for item in a.views.split(","):
        items += list(VIEWS) if item == "all" else [item]
    for item in items:
        parts = item.split(":")
        if len(parts) == 1:
            if parts[0] not in VIEWS:
                raise SystemExit(
                    f"Unknown view {parts[0]}; use one of {sorted(VIEWS)} or name:az:el[:dist[:persp|ortho]]"
                )
            az, el, dist = VIEWS[parts[0]]
            proj = None
        else:
            az, el = float(parts[1]), float(parts[2])
            dist = float(parts[3]) if len(parts) > 3 else 1.0
            proj = parts[4] if len(parts) > 4 else None
        specs.append((parts[0], az, el, dist, proj))
    a.out.mkdir(parents=True, exist_ok=True)
    results = []
    for name, az, el, dist, proj in specs:
        notes = []
        if proj is None:
            proj = "ortho" if a.ortho else "persp"
            if proj == "ortho" and el < 10:
                proj = "persp"
                notes.append("low view switched to perspective")
        theta, phi = math.radians(az + FRONTS[a.front]), math.radians(el)
        direction = Vector(
            (
                math.sin(theta) * math.cos(phi),
                -math.cos(theta) * math.cos(phi),
                math.sin(phi),
            )
        )
        cam_data.type = "ORTHO" if proj == "ortho" else "PERSP"
        fit = radius / math.sin(cam_data.angle / 2) * 1.08
        cam.location = centre + direction * fit * dist
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam_data.ortho_scale = radius * 2.1 * dist
        bpy.context.view_layer.update()
        forward = (centre - cam.location).normalized()
        hits = {}
        for p in pts:
            origin = (
                cam.location
                if proj == "persp"
                else p - forward * (p - cam.location).dot(forward)
            )
            blocker = blocked(scene, depsgraph, origin, p, target_set)
            if blocker:
                hits[blocker] = hits.get(blocker, 0) + 1
        frac = sum(hits.values()) / len(pts)
        if frac > a.block_warn:
            notes.append(
                f"WARNING {frac:.0%} of sample points hidden by non-target objects"
            )
        path = a.out / f"{name}.png"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        results.append(
            {
                "view": name,
                "azimuth": az,
                "elevation": el,
                "projection": proj,
                "image": str(path),
                "camera": [round(v, 3) for v in cam.location],
                "blocked_fraction": round(frac, 3),
                "blockers": dict(sorted(hits.items(), key=lambda kv: -kv[1])[:4]),
                "notes": notes,
            }
        )
    sheet = (
        None
        if a.no_sheet
        else contact_sheet(
            [r["image"] for r in results], a.out / "contact_sheet.png", a.res
        )
    )
    report = {
        "source": source,
        "source_was_dirty": dirty,
        "blender": bpy.app.version_string,
        "engine": engine,
        "device": scene.cycles.device if engine == "CYCLES" else None,
        "targets": [o.name for o in targets],
        "bounds_min": list(lo),
        "bounds_max": list(hi),
        "contact_sheet": sheet,
        "views": results,
        "saved_source": False,
        "scope": "Blender render of the saved file; not an exported-file or engine capture",
    }
    (a.out / "review.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    for r in results:
        print(
            f"{r['view']:>20} {r['projection']:5} blocked={r['blocked_fraction']:.2f} {'; '.join(r['notes'])}"
        )


def contact_sheet(paths, out, res):
    try:
        import numpy as np
    except ImportError:
        return None
    cols = min(3, len(paths))
    rows = math.ceil(len(paths) / cols)
    grid = np.ones((rows * res, cols * res, 4), dtype=np.float32)
    for i, p in enumerate(paths):
        img = bpy.data.images.load(p)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(
            img.size[1], img.size[0], 4
        )
        r, c = divmod(i, cols)
        grid[(rows - 1 - r) * res : (rows - r) * res, c * res : (c + 1) * res] = px[
            :res, :res
        ]
        bpy.data.images.remove(img)
    sheet = bpy.data.images.new("review_sheet", cols * res, rows * res, alpha=True)
    sheet.pixels.foreach_set(grid.ravel())
    sheet.filepath_raw, sheet.file_format = str(out), "PNG"
    sheet.save()
    return str(out)


if __name__ == "__main__":
    main()
