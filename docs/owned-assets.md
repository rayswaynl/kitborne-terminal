# Owned package discovery

Use a task-local config and index; no shared installation change is required.
The library reads only explicitly configured manifests. It does not search drives.

```json
{"sources":[{"id":"owned","type":"packages","label":"Eigen assets","root":"/local/manifests","manifest":"packages.json"}]}
```

`manifest` is relative to the configured root and defaults to `packages.json`.
Use local absolute roots appropriate to your machine. Keep actual manifests and
personal config outside Git. Existing `folder` and `catalog` sources still work.

```json
{"schema":"asset-review/packages-1","packages":[{
  "id":"currency-fly","title":"CurrencyFly","kind":"ui",
  "sourceRoot":"/local/source","entryPoint":"CurrencyFly.luau",
  "importTree":["CurrencyFly.luau","Motion.luau"],
  "importInventory":{"requiredFiles":["CurrencyFly.luau","Motion.luau"]},
  "dependencies":[{"path":"Motion.luau","note":"Sibling ModuleScript"}],
  "usageDoc":"USAGE.md","platform":["roblox"],"tags":["coins","currency"],
  "readiness":"source-ready","status":"active","licence":"unknown",
  "notes":"Preserve sibling hierarchy; integrate in a sandbox.",
  "review":{"status":"unreviewed"}
}]}
```

Only id, title, kind and sourceRoot are required. Missing readiness defaults to
`review-only`; missing licence/approval remain `unknown`. Optional review root,
asset, stage, version and status retain their manifest evidence. Non-library route
kinds retain `sourceKind`; model/asset/kit/full map to prop, sprite to ui, materials
to texture, and other routes to tool. Existing library kinds stay unchanged.

```sh
python scripts/review.py library build --config sources.json --index LIBRARY.json
python scripts/review.py library search munten --config sources.json --index LIBRARY.json --json
python scripts/review.py library describe owned:currency-fly --config sources.json --json
```

Search includes source paths, dependencies, usage document paths, instructions,
platform, readiness and review metadata. `--excluded` includes excluded records.
The bounded Dutch aliases cover currency, text, projectiles, effects and media.

Describe re-reads the configured manifest and verifies the declared files now,
including import-tree descendants and symlink targets. Children cannot be absolute
paths, streams, traversal or escapes from sourceRoot. The JSON selection receipt
contains exact resolved paths, tree files, dependency notes, usage document path,
fresh entry SHA256, instructions and blockers. A blocked receipt is printed with
exit status 1. A missing entry, dependency or usage document is a failure.
Optional `entrySha256` is the manifest's expected entry hash. The receipt exposes
expected and actual hashes; a mismatch blocks selection as source drift requiring
curator review. Without an expected hash, entry provenance remains `unverified`.
Manifest approval never transfers automatically to changed source.
Optional `importInventory.requiredFiles` lists explicit required files below sourceRoot.
Its optional treeKeys, fileCount and bytes retain inventory evidence; a plain
array of relative required files is also supported.
Every listed member must exist as a file. Its receipt is `declared-files-verified`
only after those checks. Without that inventory, dependency completeness stays
`unverified`, even when declared dependencies and existing tree files all exist.
Neither an empty dependency list nor tree enumeration proves dependency completeness;
dynamic/runtime dependencies still require integration checks.
Directory symlinks within import trees are rejected to avoid incomplete trees;
trees are bounded to 10,000 files. No code is executed, copied or uploaded.

`sourceVerified` reports source checks only. `verified` also requires active status
and readiness of `source-ready` or `integration-needed`. `review-only`, `held` and
`unavailable` remain searchable but block selection. Neither flag means owner
approval, a licence grant, target-game integration or a runtime test. Approval is
an explicit manifest claim; the library never writes or invents a verdict.

An optional preview is `{"src":"media-source-id","rel":"preview.png"}`. It uses
an existing configured media source. Package roots never serve files over HTTP.
Code, HTML and escaped symlinks remain blocked by the media endpoint. The owner-only
describe endpoint accepts a package id only; roots/config from web requests are
never used. Set `ASSET_REVIEW_LIBRARY_SOURCES` and `ASSET_REVIEW_LIBRARY_INDEX` for
an isolated viewer to use the same task-local configuration. The library drawer
checks the source afresh and copies the verified or explicitly blocked import brief.

Generated Studio, project, task, autopilot, improvement and engine prompts require
cached library lookup and a selection receipt, or the query/candidates/reason for
no suitable existing asset. Missing config, source errors and an unavailable or
stale package index are blockers, not an empty search. Only an explicit curator
refresh builds the shared index; consuming lanes never write it. A stale non-package index is refreshed into a task-local copy (library.py fresh()); package sources keep the curator gate.
Package freshness binds parsed bytes to a stable file identity and content SHA256.
Replacement during a read is rejected; changed content is stale even if size and
mtime are preserved. Older package indexes lacking the content hash require an
explicit curator refresh. Existing media rows do not require a rescan.
For media/catalog results, record the source id/path, selected files and original
manifest/ledger provenance. The viewer copies this dated-index receipt with
dependency/approval explicitly unknown pending manual source checks. A preview
video or screenshot is never automatically labelled a runtime asset.
