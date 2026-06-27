# AGENTS.md

## Repository Role

- This repository is Diego's fork of `nicobailon/pi-subagents`.
- It powers `https://github.com/diegopetrucci/the-last-harness`; treat TLH compatibility as a first-class requirement.
- Keep the fork reasonably close to upstream, but preserve deliberate TLH deltas. Do not overwrite fork-only behavior just because upstream differs.
- `origin` is the fork (`diegopetrucci/pi-subagents`); `upstream` is the original repository (`nicobailon/pi-subagents`).

## Fork Sync Policy

- Before syncing or rebasing from upstream, inspect the current fork delta with `git log upstream/main..HEAD` and the relevant file diffs.
- The preferred fork shape is `0` behind `upstream/main` and `X` ahead, where the ahead commits are only deliberate TLH/fork deltas.
- Treat stale-main reconciliation PRs or branches as reference work, not completed upstream syncs, unless the relevant upstream commits are actually in the branch ancestry.
- For final sync work, preserve the TLH deltas by rebasing them onto `upstream/main` or by starting from a fresh branch off `upstream/main` and reapplying the preserved TLH deltas there.
- Prefer small, reviewable merges or rebases that make upstream drift explicit.
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
- When a change affects TLH behavior, say exactly which checkout and branch holds the edit, and mention any TLH follow-up needed for pins or validation.
- If adding or updating fork-only behavior, add focused tests that document why the fork needs it.
