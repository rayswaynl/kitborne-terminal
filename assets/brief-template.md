# <Asset> · <faction> — production brief

One paragraph: what this version of the brief is, which notes it answers, which locks it keeps.

## 1. Role and player fantasy

- **What:** unit type, faction, which building and tier make it.
- **Why it matters:** its place in the game loop.
- **How it is used:** who controls it, who sees it.
- **Fantasy:** one sentence the art must make true.
- **It is not:** the nearest wrong reading.

## 2. Where the player sees it

| View | Camera | Size on a phone | Must read | May drop |
|---|---|---|---|---|
| War map | | | | |
| Battle, far | | | | |
| Battle, near | | | | |

What the read test shows today (embed <asset>_read_test.png from scripts/ortho_sheet.py).

## 3. Proportions and silhouette

| Measure | Value | Rule |
|---|---|---|
| Length / height / width | measured, metres and studs | keep or change |

Embed <asset>_proportions.png. Shape rules as a short list. Say which numbers are measured and which are targets.

## 4. Quality gap to the bar

Embed a side-by-side of the bar (owner-chosen target) and the current state. Numbered gaps, each one observable, each one a later check.

## 5. Parts list

| pf_part | pf_label | Group | Moves | LOD |
|---|---|---|---|---|
| machine name | Dutch viewer label | pf_group | pivot or no | 0, 1, 2 |

## 6. Colours

| Role | Hex | Where | Share |
|---|---|---|---|
| | #RRGGBB | | |

Material rule in one line.

## 7. Motion and states

| State | What moves | Rule |
|---|---|---|
| | | timing from the style bible; mark guesses as *proposal* |

## 8. Effects and sound hooks

Attachment names, VFX colours and textures, light budget, and a sound table (name, loop or one shot, note).

## 9. Budget per level of detail

| LOD | Where | Distance | Triangles | Instances | Keeps | Drops |
|---|---|---|---|---|---|---|

Measured today versus target, in separate lines.

## 10. Build route

Engine route, hierarchy, pivots (measured), what the server and the client do, collision.

## 11. Never

## 12. Acceptance per stage

- [ ] **Concept:**
- [ ] **Turnaround:**
- [ ] **Blockout:**
- [ ] **Model:**
- [ ] **Colour:**
- [ ] **Rig:**
- [ ] **Animation:**
- [ ] **VFX and audio:**
- [ ] **Optimize:**
- [ ] **In-engine:**

## 13. Open questions for the owner

1. **Q1:** question, then "Recommended: ..."

## 14. Sources and references

Style bible, concept, measurement source, and the bar image as the last embed.
