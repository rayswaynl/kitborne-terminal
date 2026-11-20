# <asset> playtest v<NNN>: <feature> acceptance test

Route `feature` tests a technical system against pass/fail criteria. It is not a fun test; fun findings belong to the game that uses the feature.

Proof level: **<local / Studio runtime / device / live>** in <place or build id>. Say what it is not (for example: not a phone, not live).

## Test setup

- System under test: <the settings that matter, copied from the prototype/design>.
- Sessions, each from a clean start: <session 1: what the tester does, speed, duration>; <session 2>; <session 3>.
- Tester: <scripted player or person>, measuring with <probe, sample rate>.

## Acceptance criteria

Take each threshold from the design or prototype. Mark it "proposed" when nobody set it yet.

| # | Criterion | Threshold | <Session 1> | <Session 2> | <Session 3> | Result |
|---|---|---|---|---|---|---|
| A1 | <observable failure, e.g. ground missing on screen> | <0> | <value> | <value> | <value> | **PASS / FAIL / Not measurable here** |
| A2 | <distance, time or rate> | <>= / <= number + unit> | <value> | <value> | <value> | **...** |
| A3 | <performance on the target device> | <max ms on the target device> | <value> | <value> | <value> | **Not measurable here**: <why, and where it gets proven> |

Every "Not measurable here" names the stage or device that proves it (usually QA).

## Evidence

- <clip.mp4>: test label burned in (session settings, measured values, running timer). One clip or log per criterion.
- Raw data: <path to RESULT.md / logs>. Note any capture failure and which metrics stay valid.

## Limits

- <what this setup cannot prove, e.g. phone, multiplayer, live servers>.
- <sampling gaps, e.g. 10 Hz probes miss gaps shorter than 100 ms>.

## Outside this test

- <content or fun observations for the game that uses the feature; not part of the verdict>.
