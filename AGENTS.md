# AGENTS.md

## Repository Role

- This repository is Diego's fork of `nicobailon/pi-subagents`.
- It exists to serve The Last Harness (`tlh`) and is bundled/pinned by TLH automation; treat TLH compatibility as a first-class requirement.
- Preserve end-user usage docs, but do not position this fork as a general standalone distribution target outside TLH unless the user explicitly asks for that change.
- Keep the fork reasonably close to upstream, but preserve deliberate TLH deltas. Do not overwrite fork-only behavior just because upstream differs.
- `origin` is the fork (`diegopetrucci/pi-subagents`); `upstream` is the original repository (`nicobailon/pi-subagents`).

## Fork Sync Policy

- `docs/UPSTREAM-SYNC.md` is the full playbook and source of truth for how this fork integrates upstream changes; consult it before doing any sync work. This section is a summary, not a replacement.
- The fork uses a non-rebase, intake-based model: upstream changes are adopted per **release/tag or coherent feature cluster** (never per-commit), each via an explicit **merge PR** or **squash-import PR** into the fork's `main`. The fork's history is never repeatedly rebased onto `upstream/main`.
- Before starting an intake, inspect the current fork delta with `git log upstream/main..HEAD` and the relevant file diffs to scope what the intake covers.
- Every intake gets exactly one entry/line in the exception-only ledger at `docs/upstream-ledger.jsonl`, recording the upstream ref covered, the integration PR, adoption status, and any explicit exceptions (rejected/excluded commits or behaviors). Routine, uneventful adoption still gets an entry/line with `status = "adopted"`.
- Deliberate fork-only behavior that must survive every intake is tracked in the TLH patch inventory at `docs/tlh-patch-inventory.md` (one row per delta, including key files and tests); walk this table after every merge/squash-import PR to confirm nothing was silently overwritten.
- `git cherry` / `git patch-id`, including the output of `scripts/upstream-report.*`, are signal only for gauging what upstream commits look already-applied. The git DAG plus `docs/upstream-ledger.jsonl` are authoritative; never treat a patch-id match (or mismatch) as proof of adoption.
- Individual `git cherry-pick`s from upstream are reserved for urgent, isolated hotfixes between scheduled intakes, and every such cherry-pick must get its own ledger entry/line in `docs/upstream-ledger.jsonl` explaining the urgency.
- Preserve TLH-specific tags and release pins such as `tlh-v*` unless the user explicitly asks to remove or rewrite them.
- When comparing GitHub state, use the `gh` CLI.
- If upstream changes touch child process spawning, async run state, configured profile roots, packaged agents, or model fallback behavior, check the TLH fork behavior carefully before accepting the change.

## Important Local Delta

- Child subagents must spawn with the resolved parent/private Pi runtime when available, not blindly through ambient `PATH`.
- The key implementation is `src/runs/shared/pi-spawn.ts`.
- The focused coverage is `test/unit/pi-spawn.test.ts`.
- This matters because TLH can run Pi from its private runtime under `~/.the-last-harness/runtime/bin/pi`; child subagents must not accidentally fall through to a global Homebrew/runtime Pi.

## Development

- Use `python3`, not `python`.
- This is a Node ESM package with TypeScript source loaded directly by Node test commands.
- Run focused unit coverage with:

```bash
npm run test:unit
```

- Run the full local suite with:

```bash
npm run test:all
```

- For narrow changes, run the closest affected test file first, then broaden to `npm run test:unit` or `npm run test:all` depending on risk.
- Keep generated/profile/runtime state out of commits. Be especially careful around async-run status files and any local Pi/TLH runtime directories.

## Working Rules

- Do not revert or rewrite user changes unless explicitly asked.
- Keep changes scoped to the behavior requested; avoid unrelated upstream cleanup while preserving fork syncability.
- Commit and push relevant `.gnosis/entries.jsonl` updates with the related code/docs change, but keep ticket, session, and other generated state out of commits.
- When a change affects TLH behavior, say exactly which checkout and branch holds the edit, and mention any TLH follow-up needed for pins or validation.
- If adding or updating fork-only behavior, add focused tests that document why the fork needs it.
