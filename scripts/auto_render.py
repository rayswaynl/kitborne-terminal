"""Durable submit previews. One finite worker per root, one render turn per machine."""

import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

import review
import evidence_export as confinement
from ingest import checked_path, WindowsKernel
from renderq import (render_turn as machine_turn, load_fence_record as load_execution,
                     ticket_acknowledged, MAX_FENCE_BYTES)

HERE = Path(__file__).resolve().parent
# Env overrides let the test package point both at absent paths (2026-10-10: a fake child overwrote the live runtime wrapper with a PNG).
CAPPED = os.environ.get("ASSET_REVIEW_CAPPED", "")  # optional wrapper script that runs Blender BelowNormal in a memory-capped process tree
LOCAL_CAP_MB = 16384
TIMEOUT = 600
WAIT_LIMIT = 3600
MAX_PENDING = 32
MAX_RECOVERIES = 1
MAX_EXPLICIT_RETRIES = 1
MAX_EXECUTION_BYTES = MAX_FENCE_BYTES
MAX_CHILDREN = 128
MAX_PRELAUNCH_ENTRIES = 16
MIGRATION_DIR_FD = (confinement.SOURCE_DIR_FD and os.mkdir in os.supports_dir_fd
                    and os.rename in os.supports_dir_fd and os.unlink in os.supports_dir_fd)
MAX_PROC_ENTRIES = 8192
CHILD_CLEANUP_LIMIT = 10
MODELS = {".glb", ".gltf", ".blend"}

VIEWS = (
    "front", "rear", "left", "right", "three_quarter", "rear_three_quarter",
    "top", "low",
)


def generation_path(directory, generation):
    if generation is None:  # Previously published URLs remain valid.
        return Path(directory)
    if (not isinstance(generation, str) or len(generation) != 32
            or any(c not in "0123456789abcdef" for c in generation)):
        raise RuntimeError("Invalid preview generation")
    return Path(directory) / "generations" / generation


def expected_previews(models, generation=None, recipe=None):
    prefix = generation_path(".", generation).as_posix()
    prefix = "" if prefix == "." else prefix + "/"
    views = VIEWS if recipe is None else [angle[0] for angle in recipe["angles"]]
    return [dict(model=model, stills=[f"{prefix}model{i}/{view}.png" for view in views],
                 sheet=f"{prefix}model{i}/contact_sheet.png")
            for i, model in enumerate(models)]


def validate_png(path):
    from PIL import Image

    try:
        with Image.open(path) as image:
            if image.format != "PNG":
                raise ValueError("Expected PNG")
            image.verify()
        with Image.open(path) as image:
            image.load()  # verify checks chunks; load also checks the pixel stream
    except (OSError, ValueError, SyntaxError) as error:
        raise RuntimeError(f"Invalid render image {path.name}: {error}") from error


def validate_output(output, models, previews, generation=None, recipe=None):
    """Check the saved submit-angle contract, including every decoded sheet."""
    if not models or previews != expected_previews(models, generation, recipe):
        raise RuntimeError("Incomplete render preview manifest")
    for preview in previews:
        for name in [*preview["stills"], preview["sheet"]]:
            path = Path(output) / name
            if not path.resolve().is_relative_to(Path(output).resolve()):
                raise RuntimeError("Render image escapes output directory")
            validate_png(path)


def publish_directory(stage, target):
    """Install a new immutable generation, never retire a published directory."""
    if target.exists():
        raise FileExistsError("Preview generation already exists: " + str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    stage.rename(target)


def stage_attachment(root, job, relative, source):
    parent = Path(root) / relative / "renders"
    target = generation_path(parent / job["hash"], job.get("generation"))
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".preview-", dir=parent))
    try:
        shutil.copytree(source, stage, dirs_exist_ok=True)
        validate_output(stage, job["models"], expected_previews(job["models"], recipe=job.get("recipe")),
                        recipe=job.get("recipe"))
    except BaseException:
        shutil.rmtree(stage)
        raise
    return stage, target


def publish(root, job, output):
    stages = []
    generation = uuid.uuid4().hex
    candidate = dict(job, generation=generation,
                     previews=expected_previews(job["models"], generation, job.get("recipe")))
    try:
        validate_output(output, job["models"], expected_previews(job["models"], recipe=job.get("recipe")),
                        recipe=job.get("recipe"))
        for relative in job["versions"]:
            stages.append(stage_attachment(root, candidate, relative, output))
        folder = execution_folder(root, job)
        cache = folder / "published"
        cache_stage = Path(tempfile.mkdtemp(prefix=".preview-", dir=folder))
        stages.append((cache_stage, cache))
        shutil.copytree(output, cache_stage, dirs_exist_ok=True)
        validate_output(cache_stage, job["models"],
                        expected_previews(job["models"], recipe=job.get("recipe")),
                        recipe=job.get("recipe"))
        for stage, target in stages:
            publish_directory(stage, target)
        # The caller atomically replaces status.json after this returns. All
        # referenced directories now exist; failures/crashes before that single
        # commit leave unreferenced generations, never partially changed URLs.
        job.update(generation=generation, previews=candidate["previews"],
                   published_output=str(cache.relative_to(job_path(root, job["hash"]).parent)))
    finally:
        for stage, _ in stages:
            if stage.exists():
                shutil.rmtree(stage)

# Bump the revision when changing the recipe schema or renderer contract.
# Source-scene policies are explicit: .blend lighting, colour and units survive.
DEFAULT_RECIPE = {
    "revision": "v1",
    "renderer_revision": "submit-angles-v1",
    "camera": {"front": "-Y", "ortho": False},
    "angles": [
        ["front", 0, 12, 1.0], ["rear", 180, 12, 1.0],
        ["left", 90, 12, 1.0], ["right", -90, 12, 1.0],
        ["three_quarter", 35, 30, 1.0], ["rear_three_quarter", 215, 30, 1.0],
        ["top", 20, 70, 1.0], ["low", 25, 3, 1.0],
    ],
    "resolution": 384,
    "engine": {
        "name": "CYCLES", "samples": 32, "device": "GPU",
        "adaptive_sampling": True, "adaptive_threshold": 0.03,
        "denoising": True, "denoiser": "OPENIMAGEDENOISE",
        "denoising_use_gpu": True, "persistent_data": True,
    },
    "lighting": {"preserve_blend": True, "suns": [
        {"rotation": [0.7, 0, 0.5], "energy": 3},
        {"rotation": [1, 0, 3.5], "energy": 1.5},
    ]},
    "environment": {"preserve_blend": True, "color": [0.18, 0.20, 0.24, 1], "strength": 1},
    "colour_management": {
        "preserve_blend": True, "display_device": "sRGB",
        "view_transform": "AgX", "look": "None", "exposure": 0, "gamma": 1,
    },
    "output_formats": {"stills": "PNG", "sheet": "PNG"},
    "units": {"preserve_blend": True, "system": "NONE", "scale_length": 1},
}

# Materialized in the job directory so both local and remote workers read the
# same saved recipe. Keep Blender imports out of this queue module.
RECIPE_SCRIPT = '''import argparse
import json
import os
from pathlib import Path
import sys
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_angles

assert bpy.app.background, "Headless Blender required"
if os.environ.get("JOB_IN"):
    source, output = Path(os.environ["JOB_IN"]), Path(os.environ["JOB_OUT"])
    config = source / "render-input.json"
else:
    source, output, config = map(Path, sys.argv[sys.argv.index("--") + 1:])
saved = json.loads(config.read_text(encoding="utf-8"))
recipe = saved["recipe"]
results = []
for index, name in enumerate(saved["models"]):
    path = source / name
    blend = path.suffix.lower() == ".blend"
    if blend:
        bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
    scene = bpy.context.scene
    engine = recipe["engine"]
    scene.render.engine = {"WORKBENCH": "BLENDER_WORKBENCH", "EEVEE": "BLENDER_EEVEE"}.get(engine["name"], engine["name"])
    if engine["name"] == "CYCLES":
        for prop, value in {
            "use_adaptive_sampling": engine["adaptive_sampling"],
            "adaptive_threshold": engine["adaptive_threshold"],
            "use_denoising": engine["denoising"], "denoiser": engine["denoiser"],
            "denoising_use_gpu": engine["denoising_use_gpu"],
        }.items():
            setattr(scene.cycles, prop, value)
    scene.render.use_persistent_data = engine["persistent_data"]
    environment = recipe["environment"]
    if not (blend and environment["preserve_blend"]):
        scene.world = bpy.data.worlds.new("Review world")
        scene.world.use_nodes = True
        background = scene.world.node_tree.nodes["Background"]
        background.inputs[0].default_value = environment["color"]
        background.inputs[1].default_value = environment["strength"]
    lighting = recipe["lighting"]
    if not (blend and lighting["preserve_blend"]):
        for old in list(scene.objects):
            if old.type == "LIGHT":
                bpy.data.objects.remove(old, do_unlink=True)
        for spec in lighting["suns"]:
            light = bpy.data.objects.new("Review light", bpy.data.lights.new("Review light", "SUN"))
            light.rotation_euler, light.data.energy = spec["rotation"], spec["energy"]
            scene.collection.objects.link(light)
    colour = recipe["colour_management"]
    if not (blend and colour["preserve_blend"]):
        scene.display_settings.display_device = colour["display_device"]
        for prop in ("view_transform", "look", "exposure", "gamma"):
            setattr(scene.view_settings, prop, colour[prop])
    units = recipe["units"]
    if not (blend and units["preserve_blend"]):
        scene.unit_settings.system = units["system"]
        scene.unit_settings.scale_length = units["scale_length"]
    folder = output / ("model%d" % index)
    options = argparse.Namespace(
        out=folder, targets="", isolate=False, block_warn=0.02, no_sheet=True,
        views=",".join(":".join(map(str, angle)) for angle in recipe["angles"]),
        front=recipe["camera"]["front"], ortho=recipe["camera"]["ortho"],
        engine=engine["name"], samples=engine["samples"], device=engine["device"],
        res=recipe["resolution"],
    )
    review_angles.args = lambda: options
    review_angles.main()
    report = json.loads((folder / "review.json").read_text(encoding="utf-8"))
    images = [(Path("model%d" % index) / Path(view["image"]).name).as_posix() for view in report["views"]]
    results.append(dict(model=name, images=images, device=report["device"]))
output.mkdir(parents=True, exist_ok=True)
(output / "angles.json").write_text(json.dumps(dict(models=results), indent=2), encoding="utf-8")
'''


def tool_revision():
    """Fingerprint render code without probing Blender, machines or credentials."""
    digest = hashlib.sha256(RECIPE_SCRIPT.encode("utf-8"))
    for name in ("review_angles.py", "contact_sheet.cjs", "submit_render.ps1"):
        digest.update(name.encode("utf-8"))
        digest.update((HERE / name).read_bytes())
    return digest.hexdigest()


def normalize_recipe(recipe):
    """Detach caller state and canonicalize JSON containers and mapping order."""
    return json.loads(json.dumps(recipe, sort_keys=True, allow_nan=False))


def render_recipe():
    return normalize_recipe(dict(DEFAULT_RECIPE, tool_revision=tool_revision()))


def recipe_fingerprint(recipe):
    normalized = normalize_recipe(recipe)
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def job_path(root, key):
    if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        raise ValueError("Invalid render hash")
    return Path(root) / ".render-jobs" / key / "status.json"


def published_root(root, job):
    # R3C-013 snapshots and earlier R3C-031 cache URLs remain addressable.
    return job_path(root, job["hash"]).parent / job.get("published_output", "output")


def cached_directory(root, job):
    source = published_root(root, job)
    # The attempt directory is already an immutable generation namespace.
    return source if job.get("published_output") else generation_path(source, job.get("generation"))


def validate_cache(root, job):
    recipe = job.get("recipe")
    if job.get("previews") != expected_previews(job["models"], job.get("generation"), recipe):
        raise RuntimeError("Incomplete render preview manifest")
    validate_output(cached_directory(root, job), job["models"],
                    expected_previews(job["models"], recipe=recipe), recipe=recipe)


def attempt_state(job):
    attempt = job.get("attempt")
    return attempt if isinstance(attempt, dict) else {}


def ensure_attempt(job):
    if not isinstance(job.get("attempt"), dict):
        previous = job.get("attempt", 1)
        job["attempt"] = attempt_v1(job["queued"])
        if isinstance(previous, int) and previous > 1:
            job.setdefault("cache_repair_count", previous - 1)
    return job["attempt"]


def attempt_v1(queued_at):
    """Generation zero has not launched; requeues select their next generation."""
    return dict(
        version=1, owner=None, generation=0, recovery_count=0,
        explicit_retry_count=0, queued_at=queued_at, deadline=queued_at + WAIT_LIMIT,
    )

def worker_owner(token=None):
    created = review.process_creation(os.getpid())
    if created is None:
        raise RuntimeError("Render worker process identity unavailable")
    return dict(token=token or uuid.uuid4().hex, pid=os.getpid(), process_start=created)


def pending_count(folder):
    return sum(
        review.jload(str(p), {}).get("status") in ("queued", "running")
        for p in folder.glob("*/status.json")
    )


def requeue(job, counter=None):
    attempt = job["attempt"]
    if counter is not None:
        attempt[counter] += 1
    attempt["generation"] = max(1, attempt["generation"]) + 1
    attempt["owner"] = None
    job.update(status="queued", machine=None)
    for key in ("error", "log_tail", "previews", "started", "seconds", "fallback", "runner", "render_output", "published_output", "generation"):
        job.pop(key, None)


def retry_failed(root, key):
    """Explicitly queue one retry per hash; ordinary submissions still cache failure.

    This helper only queues. The CLI starts the finite worker when rendering is enabled.
    All generations share the original queued_at/deadline and crash recovery budget.
    """
    path = job_path(root, key)
    with review.FileLock(root):
        job = review.jload(str(path), None)
        if job is None:
            raise ValueError("Unknown render hash")
        if job.get("hash") != key:
            raise ValueError("cached render job hash does not match requested key")
        attempt = ensure_attempt(job)
        reason = None
        if job["status"] != "failed" or owner_alive(attempt["owner"]):
            reason = "Render job is active or already complete"
        elif attempt["explicit_retry_count"] >= MAX_EXPLICIT_RETRIES:
            reason = "Explicit render retry limit reached"
        elif time.time() >= min(attempt["deadline"], job["queued"] + WAIT_LIMIT):
            reason = "Original render cutoff reached"
        elif pending_count(path.parent.parent) >= MAX_PENDING:
            reason = "Render queue capacity reached"
        if reason:
            return dict(hash=key, status=job["status"], retried=False, reason=reason)
        if not execution_fenced(root, job):
            migrate_prelaunch_job(root, path, job)
            if not execution_fenced(root, job):
                return dict(hash=key, status=job["status"], retried=False,
                            reason="Render execution has not acknowledged quiescence")
        if attempt["generation"] == 0 and not attempt.get("execution"):
            reserve_execution(root, job, None)
        requeue(job, "explicit_retry_count")
        review.jsave(str(path), job)
        return dict(hash=key, status="queued", retried=True)


def prepare_enqueue(root, directory, names, recipe=None, target=None):
    """Read and plan the complete job without publishing files or queue state."""
    models = sorted(n for n in names if Path(n).suffix.lower() in MODELS)
    if not models:
        return None
    recipe = render_recipe() if recipe is None else normalize_recipe(recipe)
    fingerprint = recipe_fingerprint(recipe)
    inputs = (
        sorted(names)
        if any(Path(n).suffix.lower() != ".glb" for n in models)
        else models
    )
    digest = hashlib.sha256()
    for name in inputs:
        with open(Path(directory) / name, "rb") as stream:
            content = hashlib.file_digest(stream, "sha256").hexdigest()
        digest.update((Path(name).suffix.lower() + content).encode())
        if inputs != models:
            digest.update(name.encode())  # glTF references depend on filenames
    digest.update(b"\0render-recipe\0" + fingerprint.encode("ascii"))
    key = digest.hexdigest()
    path = job_path(root, key)
    job = review.jload(str(path), None)
    if job is not None and job.get("hash") != key:
        raise ValueError("cached render job hash does not match computed key")
    relative = os.path.relpath(target or directory, root)
    if job is not None:
        ensure_attempt(job)
    if job is not None and job["status"] == "done":
        try:
            validate_cache(root, job)
            for version in job["versions"]:
                validate_output(Path(root) / version / "renders" / key,
                                job["models"], job.get("previews"),
                                job.get("generation"), job.get("recipe"))
        except (RuntimeError, KeyError):
            reason = None
            if owner_alive(job["attempt"].get("owner")) or not execution_fenced(root, job):
                reason = "Cache repair requires render execution quiescence acknowledgement"
            elif time.time() >= job_deadline(job):
                reason = "Original render cutoff reached before cache repair"
            elif pending_count(path.parent.parent) >= MAX_PENDING:
                reason = "Render queue capacity reached (%d pending jobs)" % MAX_PENDING
            if reason:
                job.update(status="failed", log_tail=reason)
                job.pop("previews", None)
            else:
                # Keep the v1 owner receipt, original cutoff and retry/recovery
                # allowances. Cache repair has its own count and deduplicates
                # through this same content identity and queued state.
                requeue(job)
                job["cache_repair_count"] = job.get("cache_repair_count", 0) + 1
                job.update(source=relative, inputs=inputs, models=models)
    if job is None:
        queued_at = time.time()
        pending = pending_count(path.parent.parent)
        job = dict(
            hash=key,
            status="queued",
            queued=queued_at,
            source=relative,
            inputs=inputs,
            models=models,
            versions=[],
            machine=None,
            attempt=attempt_v1(queued_at),
            recipe=recipe,
            recipe_fingerprint=fingerprint,
        )
        if pending >= MAX_PENDING:
            job.update(
                status="failed",
                log_tail="Render queue capacity reached (%d pending jobs)"
                % MAX_PENDING,
            )
    if relative not in job["versions"]:
        job["versions"].append(relative)
    return job, relative, key, path


def enqueue(root, directory, names, recipe=None, prepared=None):
    """Publish a planned job after the immutable version is moved."""
    plan = prepared if prepared is not None else prepare_enqueue(root, directory, names, recipe)
    if plan is None:
        return None
    job, relative, key, path = plan
    job["hash"] = key
    if job["status"] == "done":
        attach(root, job, relative)
    elif (job["status"] == "queued" and job.get("cache_repair_count")
          and not job["attempt"].get("execution")):
        # Earlier synchronous completed jobs have no execution receipt. Only
        # commit this new idle generation after the immutable input is moved.
        reserve_execution(root, job, None)
    review.jsave(str(path), job)
    return dict(hash=key, status=job["status"])


def attach(root, job, relative):
    validate_cache(root, job)
    source = cached_directory(root, job)
    target = generation_path(Path(root) / relative / "renders" / job["hash"],
                             job.get("generation"))
    if target.exists():
        validate_output(target, job["models"], expected_previews(job["models"], recipe=job.get("recipe")),
                        recipe=job.get("recipe"))
        return
    stage, target = stage_attachment(root, job, relative, source)
    try:
        publish_directory(stage, target)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def owner_alive(owner):
    """Exact process creation identity prevents PID reuse from claiming a worker."""
    if not owner or not owner.get("pid"):
        return False
    if owner.get("token") and owner.get("process_start"):
        return review.pid_alive(owner["pid"], created=owner["process_start"])
    # Legacy workers have no token; preserve live holders until they exit.
    return review.pid_alive(owner["pid"], owner.get("since"))


def job_deadline(job):
    # The legacy queue timestamp remains a bound, even for migrated callers.
    return min(attempt_state(job).get("deadline", float("inf")),
               job["queued"] + WAIT_LIMIT)


def execution_folder(root, job):
    execution = job["attempt"]["execution"]
    token_hash = hashlib.sha256(execution["token"].encode()).hexdigest()
    return job_path(root, job["hash"]).parent / "attempts" / ("%d-%s" % (
        execution["generation"], token_hash))


def reserve_execution(root, job, identity):
    """Persist an idle receipt before any supervisor or renderer can launch."""
    attempt = job["attempt"]
    attempt["execution"] = dict(token=(identity or {}).get("token") or uuid.uuid4().hex,
                                generation=attempt["generation"])
    folder = execution_folder(root, job)
    folder.mkdir(parents=True, exist_ok=True)
    review.jsave(str(folder / "execution.json"), dict(
        attempt["execution"], state="idle", worker=identity))
    return folder


class render_turn(machine_turn):
    """Worker unwind cannot release the independent supervisor's machine turn.

    Durable acknowledgement-aware admission is enforced by the shared queue.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.owner_pid = os.getpid()

    def __exit__(self, *error):
        # Worker unwind cannot remove the independent supervisor's ticket.
        def release(queue, now):
            queue[:] = [t for t in queue if t["job"] != self.job
                        or t["pid"] != self.owner_pid
                        or t.get("execution") and not ticket_acknowledged(t)]
        self.edit(release)


def execution_fenced(root, job):
    attempt = attempt_state(job)
    execution = attempt.get("execution")
    if not execution:
        # Old running generations may have launched untracked children.
        return not attempt.get("generation", 0) or job.get("status") == "done"
    record = load_execution(execution_folder(root, job) / "execution.json")
    return (record.get("token") == execution["token"]
            and record.get("generation") == execution["generation"]
            and (record.get("state") == "idle" or
                 record.get("state") == "settled" and record.get("acknowledged") is True))


class MigrationDirectory(confinement.DestinationDirectory):
    """Retain directory identity through prelaunch validation and publication."""
    def __init__(self, path, root):
        super().__init__(Path(os.path.abspath(path)), Path(os.path.abspath(root)))

    def __enter__(self):
        if os.name != "nt":
            if not MIGRATION_DIR_FD:
                raise ValueError("anchored migration operations unavailable")
            return super().__enter__()
        try:
            self.pin_windows()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def pin_windows(self):
        checked_path(self.root, self.path)
        self.expected = self.path.lstat()
        self.kernel = WindowsKernel()
        for component in (*reversed(self.path.parents), self.path):
            # Share read and write, never delete: the directory cannot be
            # renamed or removed, and files inside it can be replaced.
            # Attribute-only handles bypass sharing, so an in-place reparse tag
            # is caught by check() on the held leaf handle, not prevented here.
            # Staging files are created relative to the leaf handle, never by
            # pathname; NTFS checks the directory ACL, so read access suffices.
            handle = self.kernel.open(component, directory=True, share=3, access=self.kernel.READ)
            self.locks.callback(self.kernel.close, handle)
            self.handle = handle
        self.check()

    def check(self):
        checked_path(self.root, self.path)
        if (not stat.S_ISDIR(self.expected.st_mode)
                or not confinement.same_identity(self.expected, self.path.lstat())
                or self.fd is not None and not confinement.same_identity(self.expected, os.fstat(self.fd))):
            raise ValueError("migration directory identity changed")
        if self.fd is None and self.kernel.info(self.handle).attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("migration directory acquired a reparse tag")


def pin_migration_child(parent, name, stack, create=False):
    parent.check()
    try:
        info = parent.info(name)
    except FileNotFoundError:
        if not create:
            return None
        try:
            os.mkdir(parent.entry(name), 0o700, **parent.options())
        except FileExistsError:
            pass  # The subsequent no-follow open must prove the winning object.
    else:
        if not stat.S_ISDIR(info.st_mode) or confinement.is_reparse(info):
            raise ValueError("migration child is not an ordinary directory")
    child = stack.enter_context(MigrationDirectory(parent.path / name, parent.root))
    parent.check()
    return child


def check_migration(directories):
    for directory in directories.values():
        directory.check()


def read_migration_receipt(path, directory):
    """Use the shared bounded reader on an owned, no-follow file descriptor."""
    try:
        if directory.fd is not None:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory.fd)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ValueError("migration receipt is not a regular file")
                return load_execution(os.dup(fd))
            finally:
                os.close(fd)
        handle = directory.kernel.open(path, share=3)
        try:
            if directory.kernel.info(handle).attributes & 0x10:
                raise ValueError("migration receipt is not a regular file")
            with directory.kernel.reader(handle) as stream:
                return load_execution(os.dup(stream.fileno()))
        finally:
            directory.kernel.close(handle)
    except FileNotFoundError:
        return None


def save_migration(path, data, directories):
    """Atomic metadata save through owned directories, never mutable ancestry."""
    path = Path(os.path.abspath(path))
    directory = directories[path.parent]
    check_migration(directories)
    temporary = "%s.%d.%d.tmp" % (path.name, os.getpid(), uuid.uuid4().int)
    owned = None
    if directory.fd is None:
        owned = confinement.WindowsStagingFile(directory.path / temporary, directory.handle)
        fd = owned.fd
    else:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW,
                     0o600, dir_fd=directory.fd)
    try:
        with os.fdopen(os.dup(fd), "w", encoding="utf-8", newline="\n") as stream:
            json.dump(data, stream, indent=1, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        check_migration(directories)
        if owned is not None:
            for index in range(8):
                try:
                    owned.publish(path, replace=path.name == "status.json")
                    break
                except PermissionError:
                    if index == 7:
                        raise
                    time.sleep(0.05 * (index + 1))
                    check_migration(directories)
        elif path.name == "status.json":
            os.replace(temporary, path.name, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
        else:
            confinement.link_owned_fd(fd, directory.fd, path.name)
        directory.sync()
    finally:
        if owned is not None:
            owned.close()
        else:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=directory.fd)
            except FileNotFoundError:
                pass


def migrate_prelaunch_job(root, path, job):
    """Under the root lock, fence a provably unlaunched integration-base job.

    Base generation one was allocated at enqueue. Preserve that generation and
    its budgets; a deterministic idle identity makes this migration restartable.
    """
    attempt = job.get("attempt")
    fields = set(attempt_v1(0))
    if not isinstance(attempt, dict) or set(attempt) not in (fields, fields | {"execution"}):
        return False
    if (any(type(attempt[k]) is not int or attempt[k] != value for k, value in (
            ("version", 1), ("generation", 1), ("recovery_count", 0), ("explicit_retry_count", 0)))
            or attempt["owner"] is not None or "machine" not in job or job["machine"] is not None
            or any(k in job for k in ("started", "seconds", "error", "previews", "fallback",
                                      "runner", "render_output", "published_output"))):
        return False
    numbers = (job.get("queued"), attempt["queued_at"], attempt["deadline"])
    if (any(type(n) not in (int, float) or not math.isfinite(n) for n in numbers)
            or numbers[0] != numbers[1] or numbers[2] > numbers[0] + WAIT_LIMIT):
        return False
    if job.get("status") == "queued":
        if "log_tail" in job:
            return False
    elif job.get("status") == "failed":
        reason = job.get("log_tail", "")
        if not isinstance(reason, str) or not (
                re.fullmatch(r"Render queue capacity reached \([0-9]+ pending jobs\)", reason)
                or reason in ("Finite render worker cutoff reached",
                              "Render queue wait timeout; attempt deadline expired")):
            return False
    else:
        return False
    if job.get("hash") != path.parent.name or path != job_path(root, job["hash"]):
        return False
    token = "base-prelaunch-" + hashlib.sha256(json.dumps(
        [job["hash"], job["queued"]], separators=(",", ":")).encode()).hexdigest()
    execution = dict(token=token, generation=1)
    if "execution" in attempt and attempt["execution"] != execution:
        return False
    candidate = dict(job, attempt=dict(attempt, execution=execution))
    folder = execution_folder(root, candidate)
    receipt = folder / "execution.json"
    idle = dict(execution, state="idle", worker=None)
    # Only producer metadata and this never-owned staging area can be present.
    # An output, another attempt, or an active/invalid receipt is ambiguous.
    path, folder = Path(os.path.abspath(path)), Path(os.path.abspath(folder))
    receipt = folder / "execution.json"
    try:
        with contextlib.ExitStack() as stack:
            parent = stack.enter_context(MigrationDirectory(path.parent, Path(root)))
            directories = {parent.path: parent}
            attempts = pin_migration_child(parent, "attempts", stack)
            stage = None
            if attempts is not None:
                directories[attempts.path] = attempts
                stage = pin_migration_child(attempts, folder.name, stack)
                if stage is not None:
                    directories[stage.path] = stage
            # Static proof remains mandatory; the guards outlive every write.
            checked_path(root, path)
            checked_path(root, receipt)
            for directory, allowed, temporary in (
                    (path.parent, {"status.json", "attempts"}, "status.json"),
                    (folder.parent, {folder.name}, None),
                    (folder, {"execution.json"}, "execution.json")):
                if directory.exists() and not directory.is_dir():
                    return False
                if not directory.exists():
                    continue
                for index, entry in enumerate(directory.iterdir()):
                    checked_path(root, entry)
                    metadata_tmp = temporary and re.fullmatch(
                        re.escape(temporary) + r"\.[0-9]+\.[0-9]+\.tmp", entry.name)
                    if (index >= MAX_PRELAUNCH_ENTRIES
                            or entry.name not in allowed and not metadata_tmp
                            or entry not in (folder.parent, folder) and not entry.is_file()):
                        return False
            record = read_migration_receipt(receipt, stage) if stage is not None else None
            if record is not None and (record != idle or type(record.get("generation")) is not int):
                return False
            # Missing components are created under the already-owned parent,
            # then opened without following redirection before identity commit.
            if attempts is None:
                attempts = pin_migration_child(parent, "attempts", stack, create=True)
                directories[attempts.path] = attempts
            if stage is None:
                stage = pin_migration_child(attempts, folder.name, stack, create=True)
                directories[stage.path] = stage
            check_migration(directories)
            record = read_migration_receipt(receipt, stage)
            if record is not None and (record != idle or type(record.get("generation")) is not int):
                return False
            # A crash between the two atomic saves retains a repairable identity.
            if attempt.get("execution") != execution:
                save_migration(path, candidate, directories)
                attempt["execution"] = execution
            if record is None:
                save_migration(receipt, idle, directories)
            return True
    except (OSError, ValueError):
        return False


def migrate_prelaunch_jobs(root):
    """Caller holds the root lock; ordinary fence inspection stays read-only."""
    for path in (Path(root) / ".render-jobs").glob("*/status.json"):
        job = review.jload(str(path), {})
        if not execution_fenced(root, job):
            migrate_prelaunch_job(root, path, job)


def unfenced_work(root):
    return any(not execution_fenced(root, review.jload(str(p), {}))
               for p in (Path(root) / ".render-jobs").glob("*/status.json"))


def recover_jobs(root):
    """Under the root lock, requeue one interrupted v1 attempt, never a live one."""
    for path in (Path(root) / ".render-jobs").glob("*/status.json"):
        job = review.jload(str(path), {})
        if job.get("status") not in ("running", "queued"):
            continue
        attempt = attempt_state(job)
        if job["status"] == "running":
            if attempt and owner_alive(attempt.get("owner")):
                continue
            if (not attempt or attempt.get("version") != 1
                    or not all((attempt.get("owner") or {}).get(k)
                               for k in ("token", "pid", "process_start"))):
                job.update(status="failed", log_tail="Render worker interrupted; no recoverable attempt identity.")
            elif time.time() >= job_deadline(job):
                job.update(status="failed", log_tail="Render attempt deadline expired")
            elif not execution_fenced(root, job):
                continue  # the worker exited, but its execution has not acknowledged quiescence
            elif attempt["recovery_count"] >= MAX_RECOVERIES:
                job.update(status="failed", log_tail="Render worker interrupted; automatic recovery exhausted")
            else:
                if attempt["generation"] == 0 and not attempt.get("execution"):
                    reserve_execution(root, job, attempt["owner"])
                requeue(job, "recovery_count")
        elif time.time() >= job_deadline(job):
            job.update(status="failed", log_tail="Render queue wait timeout; attempt deadline expired")
        if job["status"] == "failed":
            job.pop("previews", None)
        review.jsave(str(path), job)


def retry(root, key):
    """Compatibility wrapper for callers of the original B8 boolean helper."""
    return retry_failed(root, key)["retried"]


def start_worker(root):
    if os.environ.get("ASSET_REVIEW_RENDER") != "1":
        return
    state = Path(root) / ".render-jobs" / "worker.json"
    if not state.parent.exists():
        return
    with review.FileLock(root):
        owner = review.jload(str(state), {})
        if owner_alive(owner):
            return
        # A surviving job owner also protects the root if worker.json was lost.
        if any(j.get("status") == "running" and owner_alive(attempt_state(j).get("owner"))
               for j in (review.jload(str(p), {}) for p in state.parent.glob("*/status.json"))):
            return
        migrate_prelaunch_jobs(root)
        recover_jobs(root)
        if unfenced_work(root):
            return
        if not any(review.jload(str(p), {}).get("status") == "queued"
                   for p in state.parent.glob("*/status.json")):
            return
        token = uuid.uuid4().hex
        deadline = time.time() + WAIT_LIMIT
        with open(state.parent / "worker.log", "a", encoding="utf-8") as log:
            proc = subprocess.Popen(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    str(Path(root).resolve()),
                    "--worker-token", token,
                ],
                stdout=log,
                stderr=log,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        review.jsave(str(state), dict(token=token, pid=proc.pid, since=time.time(),
                                     process_start=review.process_creation(proc.pid), deadline=deadline))


class WindowsJob:
    """A suspended root enters a kill-on-close Job Object before it can fork."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes as w

        class BasicLimits(ctypes.Structure):
            _fields_ = [("user", ctypes.c_longlong), ("process_user", ctypes.c_longlong),
                        ("flags", w.DWORD), ("minimum", ctypes.c_size_t),
                        ("maximum", ctypes.c_size_t), ("active", w.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", w.DWORD),
                        ("scheduling", w.DWORD)]

        class Limits(ctypes.Structure):
            _fields_ = [("basic", BasicLimits), ("io", ctypes.c_ulonglong * 6),
                        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                        ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

        class Accounting(ctypes.Structure):
            _fields_ = [("times", ctypes.c_longlong * 4), ("faults", w.DWORD),
                        ("total", w.DWORD), ("active", w.DWORD), ("terminated", w.DWORD)]

        self.ctypes, self.Accounting = ctypes, Accounting
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.api.CreateJobObjectW.restype = w.HANDLE
        self.api.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.api.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        self.api.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("Cannot create render Job Object")
        limits = Limits()
        limits.basic.flags = 0x2000 | 0x8  # KILL_ON_JOB_CLOSE | ACTIVE_PROCESS
        limits.basic.active = MAX_CHILDREN
        if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise OSError("Cannot bind render Job Object lifetime")

    def assign_and_resume(self, proc):
        if not self.api.AssignProcessToJobObject(self.handle, proc._handle):
            raise OSError("Cannot contain suspended renderer")
        resume = self.ctypes.WinDLL("ntdll").NtResumeProcess
        resume.argtypes = [self.ctypes.c_void_p]
        resume.restype = self.ctypes.c_long
        if resume(proc._handle) != 0:
            raise OSError("Cannot resume contained renderer")

    def empty(self):
        info = self.Accounting()
        if not self.api.QueryInformationJobObject(self.handle, 1, self.ctypes.byref(info),
                                                 self.ctypes.sizeof(info), None):
            raise OSError("Cannot verify render Job Object quiescence")
        return info.active == 0

    def stop(self):
        if not self.api.TerminateJobObject(self.handle, 125):
            raise OSError("Cannot stop render Job Object")

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


class ProcessTree:
    """Independent supervisor owns/reaps descendants, including an exited root's."""
    def __init__(self, command):
        self.job = None
        self.proc = None
        if os.name == "nt":
            self.job = WindowsJob()
            try:
                self.proc = subprocess.Popen(command, creationflags=0x4 | 0x08000000)
                self.job.assign_and_resume(self.proc)
            except BaseException:
                try:
                    if self.proc is not None:
                        self.proc.kill()  # still suspended if assignment failed
                        self.proc.wait(timeout=CHILD_CLEANUP_LIMIT)
                finally:
                    self.job.close()
                raise
        elif sys.platform.startswith("linux"):
            import ctypes
            if os.getsid(0) != os.getpid():
                os.setsid()  # private session; never signal the caller's group
            if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
                raise OSError("Cannot establish renderer child subreaper")
            self.proc = subprocess.Popen(command)
        else:
            raise OSError("Render descendant fencing requires Linux or Windows")

    def empty(self):
        if self.job:
            self.proc.poll()
            return self.job.empty()
        for _ in range(MAX_CHILDREN + 1):
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True
            if pid == 0:
                return False
            if pid == self.proc.pid:
                self.proc.returncode = os.waitstatus_to_exitcode(status)
        return False

    def stop(self):
        if self.job:
            self.job.stop()
            return
        # This still-live supervisor pins its own session/group identity. Its
        # signal handler survives SIGTERM while descendants receive the stop.
        # Escaped/uncooperative descendants prevent a receipt rather than being
        # guessed from a dead/reused PID; the subreaper must reap *all* of them.
        if os.getsid(0) != os.getpid() or os.getpgrp() != os.getpid():
            raise RuntimeError("Render supervisor does not own its process group")
        os.killpg(os.getpid(), signal.SIGTERM)
        # procfs may hide /proc/self/task/*/children. Stat exposes only identity
        # and parentage (no argv/environ); cap the scan and kill adopted direct
        # children, including descendants which created their own session.
        with os.scandir("/proc") as entries:
            for index, entry in enumerate(entries):
                if index >= MAX_PROC_ENTRIES:
                    break
                if not entry.name.isdecimal():
                    continue
                try:
                    with open(entry.path + "/stat", "rb") as stream:
                        stat = stream.read(4096)
                    fields = stat.rsplit(b")", 1)[1].split()
                    if int(fields[1]) == os.getpid():
                        os.kill(int(entry.name), signal.SIGKILL)
                except (OSError, ValueError, IndexError):
                    pass  # no acknowledgement unless the subreaper drains all

    def close(self):
        if self.job:
            self.job.close()


def handoff_turn(record, deadline):
    """Keep the machine ticket owned by the supervisor while children run."""
    if not record.get("queue"):
        return None
    turn = render_turn("submit-angles")
    turn.path, turn.job = record["queue"]["path"], record["queue"]["job"]
    turn.execution = record["queue"]["execution"]
    def take(queue, now):
        ticket = next((t for t in queue if t["job"] == turn.job), None)
        if ticket is None:
            ticket = dict(job=turn.job, kind="submit-angles")
            queue.append(ticket)
        ticket.update(pid=os.getpid(), queued=now,
                      process_start=review.process_creation(os.getpid()), execution=turn.execution)
        return queue[0]["job"] == turn.job
    while not turn.edit(take):
        if time.monotonic() >= deadline or not owner_alive(record["worker"]):
            raise TimeoutError("Render supervisor could not acquire its machine turn")
        time.sleep(0.02)
    return turn


def return_turn(turn, worker):
    def release(queue, now):
        ticket = next((t for t in queue if t["job"] == turn.job), None)
        if (ticket is not None and ticket["pid"] == os.getpid()
                and ticket.get("process_start") == review.process_creation(os.getpid())
                and ticket_acknowledged(ticket)):
            if owner_alive(worker):
                ticket.update(pid=worker["pid"], queued=now)
            else:
                queue.remove(ticket)
    turn.edit(release)


def supervise(path):
    """Receipt is durable only after every local descendant has exited/reaped.

    Abrupt supervisor death leaves no receipt, so recovery fails closed. Remote
    interruption also leaves no acknowledgement: local exit is not remote exit.
    """
    record = load_execution(path)
    if record.get("state") != "reserved":
        return 1
    stop = [False]
    def interrupted(*_):
        stop[0] = True
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    stop_file = path.with_suffix(".stop")
    tree = None
    turn = None
    aborted = None
    deadline = time.monotonic() + max(0, record["deadline"] - time.time())
    try:
        # Never launch an expired reservation or work for an already-dead owner.
        if stop_file.exists() or time.monotonic() >= deadline or not owner_alive(record["worker"]):
            record.update(state="settled", acknowledged=True, returncode=125,
                          error="Render timeout; owned process tree stopped before launch")
            review.jsave(str(path), record)
            return 0
        if record.get("queue"):
            record["queue"]["execution"] = dict(path=str(path.resolve()),
                                                token=record["token"], generation=record["generation"])
        turn = handoff_turn(record, deadline)
        tree = ProcessTree(record["command"])
        record.update(state="active", supervisor=dict(pid=os.getpid(), process_start=review.process_creation(os.getpid())),
                      child=dict(pid=tree.proc.pid, process_start=review.process_creation(tree.proc.pid)))
        review.jsave(str(path), record)
        cleanup_end = None
        while not tree.empty():
            if (stop[0] or stop_file.exists() or time.monotonic() >= deadline
                    or not owner_alive(record["worker"])):
                aborted = "Render timeout; owned process tree stopped" if time.monotonic() >= deadline else "Render worker interrupted; owned process tree stopped"
                cleanup_end = cleanup_end or time.monotonic() + CHILD_CLEANUP_LIMIT
                tree.stop()
                if time.monotonic() >= cleanup_end:
                    raise TimeoutError("Render descendant quiescence could not be verified")
            time.sleep(0.02)
        code = tree.proc.returncode
        if code is None:
            code = tree.proc.wait(timeout=CHILD_CLEANUP_LIMIT)
        # A remote runner's success/rejection is its completion acknowledgement.
        # A timeout, killed wrapper or other error cannot cancel remote work.
        acknowledged = not record["remote"] or (aborted is None and code in (0, 3, 4, 5, 6, 127))
        record.update(state="settled", acknowledged=acknowledged,
                      returncode=125 if aborted else code, error=aborted)
        review.jsave(str(path), record)
        if acknowledged and turn is not None:
            return_turn(turn, record["worker"])
        return 0
    except BaseException as error:
        # An absent receipt is deliberately conservative, even if cleanup works.
        if tree is not None:
            try:
                tree.stop()
            except OSError:
                pass
        record.update(state="unconfirmed", acknowledged=False, error=str(error))
        review.jsave(str(path), record)
        return 1
    finally:
        try:
            if tree is not None:
                tree.close()
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)


def run_standalone(command, log, timeout, env=None):
    """Non-recoverable callers retain their direct, owned-tree timeout contract."""
    with open(log, "a", encoding="utf-8") as output:
        proc = subprocess.Popen(command, stdout=output, stderr=output, env=env,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                start_new_session=os.name != "nt")
        try:
            return proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                               capture_output=True,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=15)
            else:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            proc.wait(timeout=15)
            raise TimeoutError("Render timeout; owned process tree stopped") from None


def run_process(command, log, timeout, env=None):
    execution_path = os.path.join(os.path.dirname(os.fspath(log)), "execution.json")
    if not os.path.exists(execution_path):
        if os.path.basename(os.path.dirname(os.path.dirname(execution_path))) == "attempts":
            raise RuntimeError("Missing render execution fence; refusing launch")
        return run_standalone(command, log, timeout, env)
    path = Path(execution_path)
    record = load_execution(path)
    if not record:
        raise RuntimeError("Invalid render execution fence")
    if record and not (record.get("state") == "idle" or
                       record.get("state") == "settled" and record.get("acknowledged") is True):
        raise RuntimeError("Previous render execution is not fenced")
    path.with_suffix(".stop").unlink(missing_ok=True)
    record.update(state="reserved", acknowledged=False, command=list(map(str, command)),
                  remote=any(Path(str(arg)).name == "submit_render.ps1" for arg in command),
                  deadline=time.time() + timeout)
    if len(json.dumps(record).encode()) > MAX_EXECUTION_BYTES:
        raise ValueError("Render execution record exceeds byte limit")
    review.jsave(str(path), record)  # reserve before Popen: no crash/registration gap
    with open(log, "a", encoding="utf-8") as output:
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--supervise", str(path.resolve())],
            stdout=output, stderr=output, env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            start_new_session=os.name != "nt",
        )
        try:
            proc.wait(timeout=max(0, timeout) + CHILD_CLEANUP_LIMIT + 2)
        except BaseException:
            # Cooperative stop is acknowledged by the independent supervisor;
            # SIGKILL of this worker needs no finally block to keep the fence.
            if os.name == "nt":
                path.with_suffix(".stop").touch()  # TerminateProcess cannot deliver SIGTERM
            else:
                try:
                    proc.terminate()
                except ProcessLookupError:
                    pass
            try:
                proc.wait(timeout=CHILD_CLEANUP_LIMIT + 2)
            except subprocess.TimeoutExpired:
                pass
            raise
    receipt = load_execution(path)
    if (receipt.get("token") != record["token"] or receipt.get("generation") != record["generation"]
            or receipt.get("state") != "settled" or receipt.get("acknowledged") is not True):
        raise RuntimeError("Render descendants or remote execution remain unconfirmed")
    if receipt.get("error"):
        raise TimeoutError(receipt["error"])
    return receipt["returncode"]


def render(root, job, log, timeout=TIMEOUT, output=None):
    deadline = time.monotonic() + timeout
    attempt = attempt_state(job)

    def remaining():
        budget = deadline - time.monotonic()
        if attempt:
            budget = min(budget, attempt["deadline"] - time.time())
        if budget <= 0:
            raise TimeoutError("Original render cutoff reached")
        return budget

    timeout = remaining()
    # Legacy jobs and jobs whose implementation changed must never render under
    # today's defaults. A new submission will enqueue the current recipe key.
    recipe = job.get("recipe")
    if recipe is None or recipe_fingerprint(recipe) != job.get("recipe_fingerprint"):
        raise RuntimeError("Saved render recipe missing or fingerprint mismatch; resubmit")
    if recipe["tool_revision"] != tool_revision():
        raise RuntimeError("Saved render tool revision unavailable; resubmit")
    if recipe["revision"] != "v1" or recipe["renderer_revision"] != "submit-angles-v1":
        raise RuntimeError("Unsupported saved render recipe revision")
    if recipe["output_formats"] != {"stills": "PNG", "sheet": "PNG"}:
        raise RuntimeError("Recipe v1 supports PNG stills and contact sheets")
    execution = (attempt or {}).get("execution")
    if (execution and job.get("status") == "running"
            and execution["generation"] != attempt["generation"]):
        raise RuntimeError("Render execution generation does not match its owner")
    folder = (execution_folder(root, job) if execution and
              execution["generation"] == attempt["generation"]
              else job_path(root, job["hash"]).parent)
    output = Path(output) if output is not None else folder / "output"
    output.mkdir(parents=True, exist_ok=True)
    if output.is_relative_to(job_path(root, job["hash"]).parent):
        job["render_output"] = str(output.relative_to(job_path(root, job["hash"]).parent))
    source = Path(root) / job["source"]
    script = folder / "submit_angles.py"
    script.write_text(RECIPE_SCRIPT, encoding="utf-8")
    helper = folder / "review_angles.py"
    shutil.copyfile(HERE / helper.name, helper)
    config = folder / "render-input.json"
    review.jsave(str(config), dict(models=job["models"], recipe=recipe,
                                 recipe_fingerprint=job["recipe_fingerprint"]))
    pwsh = shutil.which("pwsh")
    if job["machine"] is None:
        blender = review.blender_exe()
        if not blender:
            raise RuntimeError("Local headless Blender missing (install Blender or set ASSET_REVIEW_BLENDER)")
        job.update(machine="local")
        command = [blender, "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(script), "--", str(source), str(output), str(config)]
        if pwsh and CAPPED and os.path.isfile(CAPPED):
            # render, not a test: the wrapper timeout follows this job's remaining budget
            cap_seconds = max(1, int(remaining()))
            command = [pwsh, "-NoProfile", "-File", str(CAPPED), "-CapMB", str(LOCAL_CAP_MB), "-AllowLong", "-MaxSeconds", str(cap_seconds), "--", *command]
        job["runner"] = "capped-belownormal" if command[0] == pwsh else "uncapped"
        code = run_process(command, log, remaining())
        if code:
            raise RuntimeError("Local headless Blender failed (exit %d)" % code)
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node missing: sharp contact sheet could not run")
    manifest = review.jload(str(output / "angles.json"), None)
    expected = expected_previews(job["models"], recipe=recipe)
    if not manifest or manifest.get("models") is None:
        raise RuntimeError("Renderer returned no angle manifest")
    previews = [dict(model=item.get("model"), stills=item.get("images"),
                     sheet=preview["sheet"])
                for item, preview in zip(manifest["models"], expected)]
    if len(manifest["models"]) != len(expected) or previews != expected:
        raise RuntimeError("Incomplete renderer angle manifest")
    for preview in previews:
        images = preview["stills"]
        for image in images:
            validate_png(output / image)
        sheet = preview["sheet"]
        code = run_process(
            [node, str(HERE / "contact_sheet.cjs"), str(output), sheet, *images],
            log,
            remaining(),
            env=dict(os.environ, UV_THREADPOOL_SIZE="12"),
        )
        if code or not (output / sheet).is_file():
            raise RuntimeError("sharp contact sheet failed (exit %d)" % code)
    validate_output(output, job["models"], previews, recipe=recipe)
    remaining()  # A late final child must not return a successful preview.
    return previews


def work(root, lifetime=WAIT_LIMIT, token=None):
    state = Path(root) / ".render-jobs" / "worker.json"
    identity = worker_owner(token)
    with review.FileLock(root):
        owner = review.jload(str(state), {})
        if token is not None:
            if any(owner.get(k) != v for k, v in identity.items()):
                return  # stale launch cannot adopt a replacement worker's lease
            migrate_prelaunch_jobs(root)
        else:
            if owner_alive(owner):
                return
            if any(j.get("status") == "running" and owner_alive(attempt_state(j).get("owner"))
                   for j in (review.jload(str(p), {}) for p in state.parent.glob("*/status.json"))):
                return
            migrate_prelaunch_jobs(root)
            recover_jobs(root)
            if unfenced_work(root):
                return
        deadline = time.time() + lifetime
        if token is not None:
            deadline = min(deadline, owner.get("deadline", deadline))
        review.jsave(str(state), dict(identity, since=time.time(), deadline=deadline))
    cutoff = time.monotonic() + max(0, deadline - time.time())

    def owns_root():
        current = review.jload(str(state), {})
        return all(current.get(k) == v for k, v in identity.items())

    def owns_job(current, job):
        return (owns_root() and current.get("status") == "running"
                and attempt_state(current).get("owner") == identity
                and attempt_state(current).get("generation") == job["attempt"]["generation"])

    while True:
        with review.FileLock(root):
            if not owns_root():
                return
            migrate_prelaunch_jobs(root)
            if unfenced_work(root):
                review.jsave(str(state), dict(pid=None))
                return
            jobs = [
                review.jload(str(p), {}) for p in state.parent.glob("*/status.json")
            ]
            queued = sorted(
                (j for j in jobs if j.get("status") == "queued"),
                key=lambda j: j["queued"],
            )
            if queued and time.monotonic() >= cutoff:
                for job in queued:
                    attempt = ensure_attempt(job)
                    attempt["deadline"] = min(job_deadline(job), deadline)
                    job.update(
                        status="failed", log_tail="Finite render worker cutoff reached"
                    )
                    review.jsave(str(job_path(root, job["hash"])), job)
                queued = []
            if not queued:
                review.jsave(str(state), dict(pid=None))
                return
            job = queued[0]
            path = job_path(root, job["hash"])
            job.update(status="running", started=time.time())
            attempt = ensure_attempt(job)
            attempt["deadline"] = min(job_deadline(job), deadline)
            attempt["generation"] = max(1, attempt["generation"])
            attempt["owner"] = identity
            folder = reserve_execution(root, job, identity)
            review.jsave(str(path), job)
        log = folder / "render.log"
        output = folder / "output"
        job["render_output"] = str(output.relative_to(path.parent))
        try:
            output.mkdir()
            remaining = min(job_deadline(job) - time.time(), cutoff - time.monotonic())
            if remaining <= 0:
                raise TimeoutError("Render queue wait timeout")
            turn = render_turn("submit-angles", wait_limit=remaining, run_limit=min(TIMEOUT, remaining))
            turn.path = os.environ.get(
                "ASSET_REVIEW_RENDER_QUEUE",
                turn.path,
            )
            with turn:
                with review.FileLock(root):
                    if not owns_job(review.jload(str(path), {}), job):
                        return
                    if isinstance(getattr(turn, "job", None), str):
                        execution_path = folder / "execution.json"
                        record = load_execution(execution_path)
                        record["queue"] = dict(path=turn.path, job=turn.job)
                        review.jsave(str(execution_path), record)
                remaining = min(job_deadline(job) - time.time(), cutoff - time.monotonic())
                if remaining <= 0:
                    raise TimeoutError("Finite render attempt cutoff reached before render")
                if remaining < TIMEOUT:
                    job["previews"] = render(root, job, log, timeout=remaining, output=output)
                else:
                    job["previews"] = render(root, job, log, output=output)
                if time.time() >= job_deadline(job) or time.monotonic() >= cutoff:
                    raise TimeoutError("Finite render attempt cutoff reached")
                if not execution_fenced(root, job):
                    raise RuntimeError("Render execution cannot publish before quiescence acknowledgement")
            validate_output(output, job["models"], job["previews"], recipe=job.get("recipe"))
            job["status"] = "done"
        except (Exception, SystemExit) as error:
            job.update(status="failed", error=str(error))
            job.pop("previews", None)
        job["seconds"] = round(time.time() - job["started"], 3)
        tail = ""
        if log.exists():
            with open(log, "rb") as stream:
                stream.seek(0, os.SEEK_END)
                stream.seek(max(0, stream.tell() - 4000))
                tail = stream.read().decode("utf-8", errors="replace")
        job["log_tail"] = (tail + "\n" + job.get("error", "")).strip()[-4000:]
        with review.FileLock(root):
            current = review.jload(str(path), {})
            if not owns_job(current, job):
                return
            job["versions"] = current["versions"]
            if job["status"] == "done" and (time.time() >= job_deadline(job)
                                             or time.monotonic() >= cutoff):
                job.update(status="failed", log_tail="Original render cutoff reached before publishing previews")
                job.pop("previews", None)
            if job["status"] == "done":
                try:
                    if not execution_fenced(root, job):
                        raise RuntimeError("Render execution cannot publish before quiescence acknowledgement")
                    publish(root, job, output)
                    if time.time() >= job_deadline(job) or time.monotonic() >= cutoff:
                        raise TimeoutError("Original render cutoff reached before publishing previews")
                except (Exception, SystemExit) as error:
                    job.update(status="failed", log_tail=str(error))
                    job.pop("previews", None)
            job["attempt"]["owner"] = None  # terminal work no longer owns an attempt
            review.jsave(str(path), job)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--supervise":
        raise SystemExit(supervise(Path(sys.argv[2])))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    parser.add_argument("--retry", metavar="HASH", help="explicitly retry one failed content hash")
    parser.add_argument("--worker-token", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.retry:
        try:
            result = retry_failed(args.root, args.retry)
        except ValueError as error:
            parser.error(str(error))
        print(json.dumps(result))
        if result["retried"]:
            start_worker(args.root)
        sys.exit(0 if result["retried"] else 1)
    work(args.root, token=args.worker_token)
