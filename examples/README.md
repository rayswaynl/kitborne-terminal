# Demo: review a crate from first version to approval

This demo walks you through one full review round with a synthetic wooden crate:

1. An agent submits v1 of the crate concept. It has a flaw: the front corners have no metal brackets.
2. You point at the flaw in the viewer, write a note and send the crate back.
3. The agent reads your note and submits v2 with the brackets.
4. You approve v2.

You play both parts here: you type the agent's commands yourself and do the review in the browser.

The two images come from `make_example.py` (NumPy and Pillow, no outside assets):

| File | Version |
|---|---|
| `crate-concept.png` | v1, no corner brackets |
| `crate-concept-v2.png` | v2, metal brackets on all four front corners |

Run `python examples/make_example.py` to draw them again.

## Before you start

Install the requirements once, from the repository folder:

```powershell
python -m pip install -r requirements.txt
```

On macOS and Linux, use `python3` wherever this page says `python`. The full browser review was tested on Windows 11. Linux has command-line and viewer server coverage. macOS is pending.

You need two terminals, both in the repository folder: one keeps the viewer running, the other runs the agent's commands.

## 1. Make a review folder and start the viewer

In terminal 1:

```powershell
mkdir my-review
python scripts/review.py serve --root my-review --port 4790
```

It prints `ASSET_REVIEW http://127.0.0.1:4790  root=...`. Leave it running; Ctrl+C stops it. If port 4790 is taken, pick another one.

## 2. Submit v1 (agent)

In terminal 2:

```powershell
python scripts/review.py submit --root my-review --asset wooden-crate --stage concept --route sprite --file examples/crate-concept.png --note "First concept"
```

The output starts with `SUBMITTED wooden-crate/concept v001` and has a line `REVIEW_URL http://127.0.0.1:4790/...`.

## 3. Point at the flaw and send it back (you)

1. Open the `REVIEW_URL` in your browser.
2. Click the top-left corner of the front face, just below the lid (about 21% from the left and 35% from the top of the image). A note box opens at that spot.
3. Type `Add metal corner brackets here, and on the other three front corners.` and click **Post**.
4. Click **Request changes**. You can undo for a few seconds.

You can also click **Change** first and write what should change without pointing at anything.

## 4. Read the notes (agent)

```powershell
python scripts/review.py notes --root my-review --asset wooden-crate --stage concept
```

You see the verdict and your note with its ID:

```text
## wooden-crate / concept v001: changes
   - [ ] N1 #1 (change, med) point at x21% y35% :: Add metal corner brackets here, and on the other three front corners.
```

The position tells the agent where you clicked; your exact numbers can differ.

## 5. Submit v2 with the fix (agent)

`--resolves` tells the reviewer which notes this version fixes, and `--response` says how:

```powershell
python scripts/review.py submit --root my-review --asset wooden-crate --stage concept --file examples/crate-concept-v2.png --note "Added metal corner brackets" --resolves N1 --response "N1=added L-shaped brackets on all four front corners"
```

The output starts with `SUBMITTED wooden-crate/concept v002` and prints a new `REVIEW_URL`.

## 6. Approve v2 (you)

Open the new `REVIEW_URL` in a new browser tab. Check the brackets. Under **Is this fixed?** you see your note with the agent's response; answer **Yes**, then click **Approve**. Approve also counts open questions as fixed.

The agent can wait for your decision and read it:

```powershell
python scripts/review.py wait --root my-review --asset wooden-crate --stage concept
```

It prints `REVIEWED wooden-crate/concept v002: approved`.

Everything from this round is in `my-review/catalog.json` and `my-review/items/wooden-crate/concept/v001` and `v002`. Delete the `my-review` folder to start over.

## Run it without a browser

`run_demo.py` does the same round from the command line and uses `review.py verdict` for the reviewer steps. Use it as a quick check that your install works:

```powershell
python examples/run_demo.py
```

It ends with `DEMO PASS: wooden-crate/concept has 2 versions, status approved`. It works in a new temporary folder with its own project list and removes it afterwards. Add `--keep` to keep that folder, or `--root <folder>` to use your own folder.
