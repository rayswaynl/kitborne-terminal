# Kitborne Terminal

> Kitborne Terminal Core v0.1, release candidate 2.

Kitborne Terminal is a local review tool for game assets. You, or an AI agent, submit a version of an asset for one stage (for example concept, model or in-engine). You review it in the browser, pin notes on the image or model, and approve it or send it back. The agent reads your notes from the command line, fixes them and submits the next version.

It runs on your own machine. Files stay in a folder you choose; nothing is uploaded.

## Core features

- **Versioned review per stage.** Every asset moves through a route of stages, such as `prop` (research, brief, concept, model, surface, optimize, engine, final) or `sprite`, `audio`, `vfx`, `character`, `web`, `game`. Each submit becomes a new version folder, so you can compare v1 with v2.
- **Many file types in one viewer.** Images, GLB models in a 3D view, video, audio, PDF, text and web pages (a screenshot, or the live local page).
- **Notes on the work.** Draw on the image or model, write a note, and decide per version: approve, send back with notes, or reject.
- **Checks on submit.** Basic file facts, locks on parts you already approved, scope checks and GLB statistics run when a version comes in.
- **A command line for agents and scripts.** `submit`, `next`, `wait`, `notes`, `link`, `status` and `events` let any agent or script hand in work and pick up feedback.
- **Plain files.** Everything is in `<folder>/catalog.json` and `<folder>/items/<asset>/<stage>/v###/`.

Extra features such as rendered angle stills, part recognition, voice notes and remote access are off by default. See [Optional integrations](#optional-integrations).

## Requirements

- Python 3.12 or newer
- `pip install -r requirements.txt` (numpy, Pillow, pypdf, pypdfium2)
- Optional: `pip install -r requirements-pdf-extras.txt` (PyMuPDF) for the PDF image resolution check and the bleed overlay
- A current browser
- Optional: ffmpeg/ffprobe for video and audio checks
- Optional: Node.js 24+ and `npm ci` for rendered contact sheets

Tested on Windows 11 and Linux (command line and viewer server; browser rendering on Linux not yet checked). macOS is *pending*.

## Start a local review (5 minutes)

Run these from the repository folder (the unpacked ZIP). Python 3.12 or newer must be installed; check with `py -3.12 --version`. The repository ships a synthetic example image, `examples/crate-concept.png` (made by `examples/make_example.py`).

PowerShell:

```powershell
# 0. Create and activate a virtual environment, then install the requirements.
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

# 1. Submit a first version. This creates the review folder "my-review".
python scripts/review.py submit --root my-review --asset wooden-crate --stage concept --route sprite --file examples/crate-concept.png --note "First concept"

# 2. Start the viewer. Keep this window open; Ctrl+C stops it. For steps 5 and 6, open a second PowerShell window in the same folder and activate the same environment.
python scripts/review.py serve --root my-review
```

Linux and macOS (macOS pending):

```bash
python3 -m pip install -r requirements.txt
python3 scripts/review.py submit --root my-review --asset wooden-crate --stage concept --route sprite --file examples/crate-concept.png --note "First concept"
python3 scripts/review.py serve --root my-review
```

3. Open the address that `serve` prints (by default http://127.0.0.1:4780/; pick another port with `--port`) and pick **wooden-crate**. When a viewer already runs for this folder, `submit` prints a `REVIEW_URL` with that viewer's port; when none runs, it prints the command to start one.

If PowerShell blocks `Activate.ps1` (execution policy), skip activation and prefix each `python` command with `.\.venv\Scripts\`, for example `.\.venv\Scripts\python scripts/review.py serve --root my-review`.

4. Pin a note on the image and send it back, or approve it.

5. Read your notes as the agent would:

```powershell
python scripts/review.py notes --root my-review --asset wooden-crate --stage concept
```

`notes` prints `No reviews yet.` until you have sent a verdict in the browser (step 4). To see the whole loop without a browser, run `python examples/run_demo.py`; it ends with `DEMO PASS`.

6. Submit the fixed version with `--resolves` and the note IDs shown by `notes`. The example uses `N1`; replace it with the ID of your note. The fixed version appears as v002 next to v001:

```powershell
python scripts/review.py submit --root my-review --asset wooden-crate --stage concept --file examples/crate-concept-v2.png --resolves N1 --note "Fixed"
```

## Command line

| Command | What it does |
|---|---|
| `submit --root D --asset A --stage S --file F` | Add a new version (repeat `--file` for several files) |
| `serve --root D --port P` | Run the viewer in the foreground and print its URL |
| `up --root D [--port P]` | Start the viewer in the background on the first free port from P (default 4780) and print the URL |
| `next --root D` | The one thing an agent should do now |
| `wait --root D --asset A --stage S` | Block until the review is done |
| `notes --root D` | Open notes as a task list |
| `task --root D --asset A --stage S` | Write a local `TASK.md` with notes and the resubmission command |
| `verdict --root D --asset A --stage S --verdict approved --source manual:review` | Record an exact or latest-version decision |
| `link --root D --asset A` | Link to one asset or version |
| `status` / `events --root D` | Pipeline overview and activity log |
| `archive --root D --asset A --reason "..."` | Move old work out (moved, not deleted) |

`up` also registers the folder in `~/.asset-review/projects.json` (or the file in `ASSET_REVIEW_PROJECTS`), so one viewer can switch between your review folders.

## Optional integrations

A plain `submit`, `serve` or `up` starts none of these. Each one runs only after you turn it on.

| Integration | Turn on with | Needs |
|---|---|---|
| Rendered angle stills and contact sheet for 3D files | `ASSET_REVIEW_RENDER=1` | Blender (found in the default install folder, on PATH, or `ASSET_REVIEW_BLENDER`), Node for the sheet; optional `ASSET_REVIEW_CAPPED` wrapper script |
| Part recognition on images | `submit --parts` or `ASSET_REVIEW_PARTS=1` | `ASSET_REVIEW_SEG_PYTHON` pointing to the python of a separate venv with torch + transformers |
| Remote viewing over a tailnet | `review.py remote --root D on --allow <device>` | Tailscale |
| Voice notes | install `faster-whisper` | ffmpeg; optional `ASSET_REVIEW_CUDA_DLLS` for GPU |
| Keep admin voice recordings | `ASSET_REVIEW_VOICE_ARCHIVE=<folder>` | Voice notes |
| One viewer process for every project (hub) | a file `hub.on` next to `projects.json` | none |

### Optional add-on

Kitborne Terminal Pro is an optional add-on. Core supports the complete review workflow through the viewer and CLI. Any person, agent or script can submit files and read the reviewer's notes.

The launcher looks for a local `pro/extension.py` alongside the `scripts/` directory. If present, it can register additional CLI commands and authenticated API routes, supply optional review metadata, and start its own server worker. Install add-on code only from a trusted source. Restart the viewer server after changing the installation. Viewer clients can read the `pro` boolean from `GET /api/info`.

## Known limits of this candidate

- Voice notes are transcribed as Dutch (`scripts/transcribe.py` sets `language='nl'`). English transcription is *pending*.
- Checklist ticks saved by older versions keep their Dutch item text. The viewer shows them against the English checklist, but agent task lists (`notes`, `TASK.md`) still print the Dutch text for those ticks.

## Licence

Kitborne Terminal Core is licensed under the [Apache License 2.0](LICENSE).

Third-party components keep their own licences: three.js (MIT), meshoptimizer (MIT), Draco (Apache-2.0), Basis Universal (Apache-2.0, with BSD-3-Clause for its bundled Zstandard decoder), ktx-parse (MIT), zstddec (MIT, with BSD-3-Clause for the bundled Zstandard decoder) and the Instrument Sans and JetBrains Mono fonts (SIL OFL 1.1). [NOTICE](NOTICE) lists each one with the path of its licence text.

The optional `requirements-pdf-extras.txt` installs PyMuPDF (AGPL-3.0 or commercial licence). It is not shipped in this repository and the default install does not include it.

Made by Kitborne, kitborne.com.
