"""One headless process per version; reuse review_angles fitting and occlusion checks."""

import json
import os
from pathlib import Path
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_angles


def main():
    assert bpy.app.background, "Headless Blender required"
    if os.environ.get("JOB_IN"):
        source, output = Path(os.environ["JOB_IN"]), Path(os.environ["JOB_OUT"])
        config = source / "render-input.json"
    else:
        source, output, config = map(Path, sys.argv[sys.argv.index("--") + 1 :])
    models = json.loads(config.read_text(encoding="utf-8"))["models"]
    results = []
    for index, name in enumerate(models):
        path = source / name
        if path.suffix.lower() == ".blend":
            bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False)
        else:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.gltf(filepath=str(path))
        scene = bpy.context.scene
        scene.render.engine = "CYCLES"
        scene.cycles.use_adaptive_sampling = True
        scene.cycles.adaptive_threshold = 0.03
        scene.cycles.use_denoising = True
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
        scene.cycles.denoising_use_gpu = True
        scene.render.use_persistent_data = True
        if path.suffix.lower() != ".blend":
            world = bpy.data.worlds.new("Review world")
            scene.world = world
            world.use_nodes = True
            world.node_tree.nodes["Background"].inputs[0].default_value = (
                0.18,
                0.20,
                0.24,
                1,
            )
            for rotation, energy in (((0.7, 0, 0.5), 3), ((1, 0, 3.5), 1.5)):
                light = bpy.data.objects.new(
                    "Review light", bpy.data.lights.new("Review light", "SUN")
                )
                light.rotation_euler, light.data.energy = rotation, energy
                scene.collection.objects.link(light)
        folder = output / ("model%d" % index)
        sys.argv = [
            "blender",
            "--",
            "--out",
            str(folder),
            "--engine",
            "CYCLES",
            "--device",
            "GPU",
            "--samples",
            "32",
            "--res",
            "384",
            "--views",
            "front,rear,left,right,three_quarter,rear_three_quarter,top,low",
            "--no-sheet",
        ]
        review_angles.main()
        report = json.loads((folder / "review.json").read_text(encoding="utf-8"))
        images = [
            str(Path("model%d" % index) / Path(view["image"]).name).replace("\\", "/")
            for view in report["views"]
        ]
        results.append(dict(model=name, images=images, device=report["device"]))
    output.mkdir(parents=True, exist_ok=True)
    (output / "angles.json").write_text(
        json.dumps(dict(models=results), indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
