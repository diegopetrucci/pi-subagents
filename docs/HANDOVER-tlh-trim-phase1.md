# HANDOVER: TLH trim phase 1 (branch `tlh-trim-phase1`)

Status snapshot written 2026-07-14 because the driving session was about to lose
model access mid-implementation. This temporary handover preserves the
investigation trail and ticket remap needed to finish the branch safely.
`tk`/`.tickets` state is disposable; durable facts must ultimately move into the
repo docs/inventory tracked by `ps-k4lv`, after which this file should be
removed.

## What we are doing and why

This fork exists solely to serve The Last Harness (TLH). Goal of this phase:
**trim the model-facing surface of pi-subagents down to what TLH actually uses**,
to (1) cut ~2,800–3,300 always-on tokens per TLH parent session and (2) reduce
bug/bypass surface. No mass runtime-code deletion in this phase — only the
model-facing contract (schema, tool descriptions, package metadata/skills, and
docs). Runtime handlers (chain execution, scheduler, worktree, clarify, RPC,
etc.) stay in the codebase; deleting them is a possible later phase.

Decisions made by Diego (recorded in `.gnosis/entries.jsonl`):

- **Tokens first, maintainability second** when they conflict.
- **Fail-closed static trim** (not a config-gated profile, not a schema filter):
  rewrite `SubagentParamsSchema` as an explicit allowlist with
  `additionalProperties: false` and a closed `action` enum. A contrarian review
  (artifact: `.pi-subagents/artifacts/c3b78dc9_contrarian_0_output.md`, also
  `/tmp/tlh-trim-investigation/`) proved: Pi accepts unknown top-level params
  (so hiding params without fail-closed root is cosmetic), TLH's safety guard
  does NOT block worktree/clarify/share today, a schema filter would strip
  TypeBox metadata, and the config escape hatch was dead weight.
- **Chain mode dropped** from the model-facing contract (biggest schema cost:
  4,546 of 12,666 bytes). The TLH architect sequences steps itself.
- **`wait` tool stays** — TLH issue filed to actually adopt it:
  <https://github.com/diegopetrucci/the-last-harness/issues/348>
- **Bundled skill removed** (`pi.skills` + `skills/`), no runtime dependency.
- Investigation baseline numbers: SubagentParams 12,666 B (~3,167 tok); FULL
  description 5,953 chars (~1,488 tok); COMPACT 2,059; SAFETY 1,321; wait ~350 tok.

## Corrected implementation state

### Completed work already on branch

- **Historical ticket `ps-owgq` is done and verified**, but its original
  acceptance statement was too optimistic: the root schema is fail-closed, RPC
  collateral was applied, and the major size reduction landed, **but** the
  nested `tasks[]` item schema still allows extra keys and the root `agent`
  field still carries stale prose.
- Landed changes remain:
  - `src/extension/schemas.ts` — 19-key TLH allowlist at the root;
    `additionalProperties: false`; `action` enum = `list, get, models, status,
    interrupt, resume, doctor`; serialized size **3,093 bytes** (was 12,666,
    −76%).
  - `src/extension/rpc.ts` — approved collateral fix because RPC validates
    against `SubagentParams`: removed `clarify: false` injection, kept legacy
    `runId` → `id` compatibility, dropped `dir`, and validates params as-is.
  - `test/unit/schemas.test.ts` and `test/unit/rpc.test.ts` — focused coverage
    for the root allowlist/rpc behavior.
- Verified assumption: Pi validates tool args against the schema **before**
  extension `tool_call` hooks mutate params, so TLH hook injections never
  re-validate.

### Newly discovered/open corrective work

These are the corrections that must drive the remaining implementation tickets:

- **Nested fail-closed gap:** `tasks[]` must be closed at the object boundary,
  with exactly the approved eight keys and no `cwd`. This is now tracked by
  **`ps-k4jr`**.
- **Stale schema prose:** the root `agent` description still overstates
  unsupported behavior. Also tracked by **`ps-k4jr`**.
- **Description/list inconsistency:** model-visible descriptions and `action=list`
  output still describe or proactively suggest capabilities that the trimmed TLH
  contract no longer exposes. This is now tracked by **`ps-4n0j`**.
- **Package metadata/skill cleanup:** the bundled skill removal also includes the
  package description correction; that is now tracked by **`ps-9z7r`**.
- **Durable docs/inventory + handover removal:** README/inventory reconciliation
  and deleting this temporary handover are now tracked by **`ps-k4lv`**.
- **Final validation:** broadened branch validation is now tracked by
  **`ps-wydp`** and must use Node 24-compatible execution (or exact CI
  equivalent), rather than chasing unrelated Node 26 harness failures.

## Current ticket tree (source of truth as of 2026-07-14)

```text
ps-47w3  Persist the corrected TLH trim phase-1 implementation plan
├─ ps-k4jr  Close the TLH subagent schema at every exposed object boundary
├─ ps-9z7r  Remove the bundled subagent skill from the TLH package
│  └─ also correct package description to match TLH single/parallel contract
├─ ps-4n0j  Rewrite TLH tool descriptions and trim list/fanout model output
│  └─ depends on ps-k4jr
├─ ps-k4lv  Reconcile TLH trim documentation and fork-delta inventory
│  └─ depends on ps-k4jr + ps-4n0j + ps-9z7r
└─ ps-wydp  Run final validation for TLH trim phase 1
   └─ depends on ps-k4jr + ps-4n0j + ps-9z7r + ps-k4lv
```

### Current ticket texts / intent snapshot

#### ps-k4jr — Close the TLH subagent schema at every exposed object boundary [OPEN]

- Make `tasks[]` fail closed with `additionalProperties: false`.
- Restrict each task object to exactly: `agent, task, count, output,
  outputMode, reads, progress, model`.
- Correct stale schema prose for the `agent` field so it only describes
  supported single execution / `action=get` usage.
- Preserve the approved 19-key root allowlist, seven actions, RPC `runId` → `id`
  compatibility, and retained runtime handlers.
- Acceptance: nested unknown/removed keys rejected by tests; schema/RPC focused
  tests pass; existing schema-size ceiling still holds.

#### ps-9z7r — Remove the bundled subagent skill from the TLH package [OPEN]

- Delete `skills/pi-subagents/SKILL.md`, remove `skills` from npm files, remove
  `pi.skills`, and correct the package description so the manifest no longer
  advertises removed chain/clarify behavior.
- Acceptance: no skill entry/files remain; package-manifest tests assert the
  absence without reading a deleted file; `npm pack --dry-run --json` contains
  no `skills/` path; focused package tests pass.

#### ps-4n0j — Rewrite TLH tool descriptions and trim list/fanout model output [OPEN]

- Replace FULL/COMPACT/SAFETY/fanout-child prose with the approved TLH-minimal
  contract.
- Make `action=list` return agent-oriented information only, omitting chain
  sections/diagnostics and proactive skill suggestions that the trimmed schema
  cannot use.
- Keep runtime execution handlers intact; this is output trimming, not handler
  deletion.
- Acceptance: descriptions advertise only supported params/actions; forbidden
  capability vocabulary is absent; FULL is 2500–3500 chars; fanout wording
  matches all seven actions including `models`; focused description/list tests
  enforce vocabulary, bounds, and output shape.

#### ps-k4lv — Reconcile TLH trim documentation and fork-delta inventory [OPEN]

- Update README model-facing examples/reference/RPC text to match the closed TLH
  contract, remove bundled-skill guidance, and clearly label retained
  non-exposed runtime capabilities where needed.
- Add durable patch-inventory coverage for the schema/description/package delta
  and RPC collateral.
- **Remove this temporary handover once its durable facts are captured.**
- Acceptance: README/docs no longer instruct TLH model callers to use removed
  inputs/actions; RPC docs state `clarify` is rejected; bundled-skill references
  are gone; `docs/tlh-patch-inventory.md` records the fork delta; doc/package
  reference tests pass.

#### ps-wydp — Run final validation for TLH trim phase 1 [OPEN]

- Validate the complete branch after all implementation tickets.
- Use Node 24-compatible execution for the full suite (or PR CI if no local
  Node 24 runtime is available); do **not** broaden scope to unrelated Node 26
  harness repair.
- Also confirm: no `skills/` path in `npm pack --dry-run --json`; schema and
  description size bounds; all six retained slash commands registered; no
  `PI_SUBAGENT_CHILD`/`PI_SUBAGENT_FANOUT_CHILD` environment leak;
  `git diff --check`
  clean; no unintended generated state.

## Superseded historical ticket IDs (preserve as evidence only)

These IDs appeared in the earlier handoff and may still show up in notes or
artifacts, but they are **not** the active tree anymore:

- `ps-kgux` → superseded by `ps-4n0j`
- `ps-hzv4` → superseded by `ps-9z7r`
- `ps-qtvo` → folded into `ps-k4lv`
- `ps-p6zc` → superseded by `ps-wydp`

Keep the historical mapping because prior investigation artifacts and branch
notes may still cite the vanished IDs.

## Historical evidence worth preserving

- Prior focused verification by the architect (before the corrective tickets
  were split out): schemas+rpc focused suites 24/24; `npm run test:unit`
  1,004/1,006 with the 2 **pre-existing** Homebrew Node 26.4.0 subprocess
  failures in `test/unit/tool-description.test.ts` and
  `test/unit/index-child-registration.test.ts` (`node: bad option:
  --experimental-transform-types`).
- That earlier verification is still useful background, but **current acceptance
  should follow the newer ticket expectations above**, especially the Node
  24-compatible final-validation requirement and the nested `tasks[]` closure
  fix that was missing from the earlier schema acceptance.

## Follow-ups outside this repo (do NOT do here)

1. **TLH pin bump** after this branch merges + publishes: update
   @diegopetrucci/pi-subagents pin; update TLH safety tests that exercise
   chain mode (chain is no longer in the model-facing schema); remove hidden
   `/skill:pi-subagents` from docs/commands.md + autocomplete.ts.
2. **TLH wait adoption**: issue #348 (already filed).
3. Optional TLH defense-in-depth: guard currently doesn't block
   worktree/clarify/share params — now mitigated by fail-closed schema, but a
   guard-side check would be belt-and-braces.
4. pi-intercom merge: investigated, deliberately deferred (keep separate).

## Residual risks / notes for the resumer

- The fork's own orchestration (this repo's dev sessions using TLH) still works
  because slash commands and internal callers bypass the model-facing schema;
  but any model-driven call using chain/worktree/etc. now fails validation —
  that is intended.
- rpc.ts: if future RPC-internal injected fields are added, they must be part
  of the contract or spawn will fail validation.
- Version bump/publish intentionally not done — Diego decides release timing.
- Investigation artifacts (token measurements, contrarian review, scout
  reports) are in /tmp/tlh-trim-investigation/ and .pi-subagents/artifacts/
  (not committed; /tmp may be gone — the numbers that matter are inline above).
