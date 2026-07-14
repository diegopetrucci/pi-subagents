# HANDOVER: TLH trim phase 1 (branch `tlh-trim-phase1`)

Status snapshot written 2026-07-14 because the driving session was about to lose
model access mid-implementation. This document is the single source of truth for
resuming the work. Ticket storage (`tk`) lives outside this repo and must be
treated as disposable — the full ticket texts are embedded below.

## What we are doing and why

This fork exists solely to serve The Last Harness (TLH). Goal of this phase:
**trim the model-facing surface of pi-subagents down to what TLH actually uses**,
to (1) cut ~2,800–3,300 always-on tokens per TLH parent session and (2) reduce
bug/bypass surface. No mass runtime-code deletion in this phase — only the
model-facing contract (schema, tool descriptions, package manifest/skills).
Runtime handlers (chain execution, scheduler, worktree, clarify, RPC, etc.) stay
in the codebase; deleting them is a possible later phase.

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
  https://github.com/diegopetrucci/the-last-harness/issues/348
- **Bundled skill removed** (`pi.skills` + `skills/`), no runtime dependency.
- Investigation baseline numbers: SubagentParams 12,666 B (~3,167 tok); FULL
  description 5,953 chars (~1,488 tok); COMPACT 2,059; SAFETY 1,321; wait ~350 tok.

## State of the work

### DONE — ticket ps-owgq (schema) ✅ verified & closed

Uncommitted-at-the-time changes now committed on this branch:

- `src/extension/schemas.ts` — TLH-minimal allowlist, 19 top-level params:
  `action, agent, agentScope, artifacts, async, concurrency, context, cwd,
  fallbackModels, id, includeProgress, index, message, model, output,
  outputMode, task, tasks, timeoutMs`; `additionalProperties: false`;
  `action` enum = `list, get, models, status, interrupt, resume, doctor`;
  tasks item trimmed to `agent, task, count, cwd, output, outputMode, model,
  reads, progress`; WaitParams unchanged.
  **Serialized size: 3,093 bytes (was 12,666, −76%).**
- `src/extension/rpc.ts` — approved collateral fix (RPC internally validates
  against SubagentParams): `clarify: false` injection removed from
  `spawnParams()` (guard now rejects any `clarify`), `normalizeTargetParams`
  emits only contract params (legacy `runId` → `id`, `dir` dropped),
  `assertSubagentParams` validates params as-is (no stripping).
- `test/unit/schemas.test.ts` — updated + 3 new tests: byte-size ceiling
  (≤4,600), contract snapshot (exact allowlist + action enum +
  additionalProperties), rejection of all removed keys/action values.
- `test/unit/rpc.test.ts` — updated for the rpc.ts changes.

Verification (done independently by architect, not just developer claims):
schemas+rpc focused suites 24/24; `npm run test:unit` 1,004/1,006 — the 2
failures (`node: bad option: --experimental-transform-types` subprocess spawns
in `test/unit/tool-description.test.ts` "registers full, compact, custom, and
fallback descriptions…" and `test/unit/index-child-registration.test.ts`
"honors waitTool disabled config…") are **pre-existing on clean HEAD** with
Homebrew node 26.4.0. Do not chase them; just introduce no NEW failures.

Verified assumption: Pi validates tool args against the schema BEFORE extension
`tool_call` hooks mutate params, so TLH's hook injections never re-validate.

### NOT STARTED — remaining tickets

- **ps-kgux** (descriptions rewrite) — first dispatch was killed by SIGTERM
  (subscription ran out) with **zero file changes**. Needs a fresh dispatch.
- **ps-hzv4** (remove bundled skills) — untouched.
- **ps-qtvo** (patch-inventory rows) — untouched; must also record the rpc.ts
  collateral deviation from ps-owgq.
- **ps-p6zc** (final validation) — untouched.

## Full ticket texts (recreate in tk if storage is gone)

### ps-owgq — TLH-minimal fail-closed SubagentParams schema [CLOSED]

Rewrite SubagentParamsSchema in src/extension/schemas.ts as an explicit TLH
allowlist contract. Top-level params kept: agent, task, tasks, concurrency,
context, async, action, id, index, message, agentScope, output, outputMode,
model, fallbackModels, timeoutMs, cwd, artifacts, includeProgress. Everything
else dropped from the model-facing schema, including chain (runtime
chain/scheduler/worktree/clarify handlers stay untouched — deletion is a later
phase). Set additionalProperties: false at the root. Convert action to an enum:
list, get, models, status, interrupt, resume, doctor. Trim the tasks item shape
to: agent, task, count, cwd, output, outputMode, model, reads, progress.
Preserve keepTopLevelParameterDescriptions behavior and TypeBox metadata
(existing test/unit/schemas.test.ts protects ~kind/~optional — do NOT build the
schema via structuredClone/spread of the old one; write it explicitly).
WaitParams unchanged. fanout-child.ts reuses SubagentParams — confirm it still
registers cleanly.

Acceptance: 1) JSON.stringify(SubagentParams).length <= 4600 enforced by unit
test. 2) Unit tests prove validation rejects: worktree, clarify, share,
schedule, scheduleName, chain, chainName, config, control, dir, view, lines,
sessionDir, runId, maxRuntimeMs, toolBudget, turnBudget, acceptance, skill,
chainDir at top level, plus an arbitrary unknown key, and action values
create/update/delete/eject/disable/enable/reset/steer/append-step/schedule-list.
3) Contract snapshot test asserts exact allowlist and action enum. 4) Existing
schemas metadata tests pass. 5) npm run test:unit green (modulo the 2
pre-existing env failures).

Closing note: verified; approved deviation = rpc.ts collateral fix (see above).

### ps-kgux — Rewrite all model-facing subagent descriptions [OPEN, next]

Rewrite every model-visible description surface in coherence with the ps-owgq
contract: (1) FULL_SUBAGENT_TOOL_DESCRIPTION in src/extension/tool-description.ts
— TLH-tailored: SINGLE + PARALLEL execution modes only (no CHAIN section, no
chain template variables), context fresh/fork note, timeoutMs,
management/control limited to list/get/models/status/interrupt/resume/doctor,
async guidance including the wait tool reference (wait stays). Target roughly
2,500–3,500 chars (baseline 5,953). (2) COMPACT_SUBAGENT_TOOL_DESCRIPTION —
consistent shorter variant. (3) SUBAGENT_SAFETY_GUIDANCE — remove
mutation-action, append-step, worktree, and {chain_dir} references; keep
child-safety boundary, one-writer rule, async/wait guidance, artifacts/status
essentials. Note: SAFETY is auto-appended in all modes including custom.
(4) fanout-child tool description in src/extension/fanout-child.ts — allowed
actions wording updated to list/get/status/interrupt/resume/doctor. Keep the
full/compact/custom mode machinery, tool names, event names, config keys, the
custom-file loading and 50KB cap intact. Do not document params or actions the
schema no longer has.

Acceptance: 1) New unit test asserts none of FULL/COMPACT/SAFETY/fanout-child
constants contain forbidden capability keywords (worktree, clarify, schedule,
steer, append-step, eject, agent-mutation wording, chain_dir). 2) Descriptions
mention only params/actions in the ps-owgq schema. 3) Existing tool-description
tests updated and green. 4) npm run test:unit green (modulo the 2 pre-existing
env failures).

### ps-hzv4 — Remove bundled skills from the package [OPEN]

Delete skills/ directory (skills/pi-subagents/SKILL.md, ~64KB), remove the
pi.skills entry from package.json, remove skills/**/* from the files array,
update the README bundled-skill section (~lines 693–749) so it no longer
documents a shipped skill. Verified already: no src/ import depends on the
bundled SKILL.md; src/agents/skills.ts (agent skill discovery) is unaffected.
TLH-side cleanup (docs/commands.md hidden /skill:pi-subagents entry,
autocomplete.ts) happens separately at pin-bump time.

Acceptance: 1) no pi.skills key, no skills files entry. 2) skills/ removed.
3) npm pack --dry-run lists no skills files. 4) README updated. 5) test:unit
green (modulo the 2 pre-existing env failures).

### ps-qtvo — Patch inventory + docs rows [OPEN]

Add docs/tlh-patch-inventory.md rows (existing table format) for the new
deliberate fork deltas so they survive upstream intakes: (a) TLH-minimal
fail-closed subagent tool contract — allowlist schema, additionalProperties:
false, action enum, rewritten FULL/COMPACT/SAFETY/fanout descriptions, guarding
tests, AND the rpc.ts collateral changes (clarify injection removed; runId→id
mapping; dir target dropped); (b) bundled skill removal. Each row lists key
files and focused tests. Also grep README/docs for now-wrong tool-surface
claims (chain/worktree/clarify etc.) and fix or flag them.

### ps-p6zc — Final validation [OPEN, last]

Run npm run test:all; npm pack --dry-run manifest sanity (src/**, agents/,
README, CHANGELOG, no skills); report new serialized schema bytes and
description chars vs baselines (schema 12,666 B; FULL 5,953; COMPACT 2,059;
SAFETY 1,321) with computed savings; grep-verify no change to async
status.json writer paths (src/runs/background/*) or SUBAGENT_CHILD_ENV value
(TLH's activity tracker reads
~tmp/pi-subagents-*/async-subagent-runs/*/status.json — hard contract); confirm
slash commands subagents-doctor/models/profiles/check-profile still registered.
Summarize residual risks.

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
