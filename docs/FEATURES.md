# pi-subagents — Feature Overview

`pi-subagents` (`@diegopetrucci/pi-subagents`) is a Pi extension that lets a parent Pi session delegate work to focused child Pi sessions ("subagents"). This document describes the extension's main features as a standalone product.

## Core delegation

- **`subagent` tool (single mode)** — Run one child agent with a task (`{ agent: "reviewer", task: "..." }`). The child is a real headless Pi process with its own system prompt, tools, and model; the result comes back to the parent's tool call.
- **Parallel mode** — Run multiple children concurrently via a `tasks` array, with per-task `count` (fan-out copies), `output`, `reads`, `progress`, and `model`, plus a `concurrency` cap.
- **Background (async) runs** — `async: true` detaches the run; the parent keeps working and gets a completion notification. Inspectable via `status`, controllable via `interrupt`/`resume`/`steer`.
- **Natural-language delegation** — No config needed; you just ask Pi "use reviewer to review this diff" and it calls the tool.

## Builtin agents

Eight ready-to-use roles:

| Agent | Role |
|-------|------|
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks. |
| `researcher` | Web/docs research with sources (requires pi-web-access). |
| `planner` | Concrete implementation plans from existing context; reads, never edits. |
| `worker` | Implementation work; edits files, validates, escalates unapproved decisions. |
| `reviewer` | Code review and small fixes against the task/plan. |
| `context-builder` | Stronger setup pass before planning; writes handoff material such as `context.md`. |
| `oracle` | Read-only second opinion; challenges assumptions before acting. |
| `delegate` | Lightweight general delegate that behaves close to the parent session. |

## Custom agents & configuration

- **Agent definition files** — Markdown + YAML frontmatter, discovered from builtin → installed-package → user (`~/.pi/agent/agents/`) → project (`.pi/agents/`) scopes; higher scopes override by name.
- **Rich frontmatter** — `tools` allowlist (including `mcp:` direct MCP tools), `extensions` / `subagentOnlyExtensions`, `model`, `fallbackModels`, `thinking`, `systemPromptMode` (replace/append), `inheritProjectContext`, `inheritSkills`, `skills`, `output`, `defaultContext`, `acceptanceRole`, `maxSubagentDepth`, `maxExecutionTimeMs`, `package` namespacing, and more.
- **Builtin overrides in settings** — `subagents.agentOverrides.<name>` changes model, tools, prompt, timeouts, or disables a builtin without copying the agent file; project settings beat user settings.
- **Model management** — `subagents.defaultModel` for all agents without explicit models; fuzzy model-id matching (separator/case/date-stamp variants); `fallbackModels` for provider failures; `subagents.modelScope` glob allowlist to enforce budget/compliance boundaries; `subagents.disableThinking` for providers that reject `:high`-style suffixes; `action: "models"` to inspect the live mapping.
- **Per-agent persistent memory** — `memory: { scope, path }` injects a role-specific `MEMORY.md` (from `.pi/agent-memory/` or `~/.pi/agent/agent-memory/`) into the child prompt; writable agents can append dated notes, read-only agents get read-only recall. Path-traversal/symlink-safe.

## Context & isolation

- **Fresh vs forked context** — Children run isolated by default (`fresh`) or can fork the parent's session transcript (`context: "fork"`), a real session branch, not a summary. Per-agent `defaultContext`; fork fails fast rather than silently downgrading. Signed Anthropic thinking blocks are stripped safely on fork.
- **Git worktree isolation** — `worktree: true` gives each parallel child its own worktree branched from `HEAD`, with `node_modules` symlinking, per-agent diff stats, full patch artifacts, setup hooks (`worktreeSetupHook`), and automatic cleanup.
- **Child-safety boundaries** — Children don't get the `subagent` tool unless explicitly allowlisted; forked context is filtered to remove parent-only orchestration artifacts; boundary instructions tell children they're not orchestrators.
- **Recursion/depth guard** — Nesting capped (default: main → child → grandchild) via `PI_SUBAGENT_MAX_DEPTH`, config, or per-agent frontmatter (tighten-only).
- **Execution time ceilings** — Per-agent `maxExecutionTimeMs` hard ceilings that are cumulative across resume segments (paused wall-time excluded); caller `timeoutMs` can tighten but never loosen.

## Supervisor coordination (parent ↔ child)

- **`contact_supervisor` (child→parent)** — Children escalate blocking decisions (`need_decision`), structured interviews (`interview_request`), or non-blocking `progress_update`s to the exact parent session that spawned them. Blocking requests durably pause the child (no process left running).
- **`resume` (three modes)** — Continue a durably paused run (unchanged or with guidance), queue a follow-up message into a live async child's inbox, or *revive* a completed/failed child into a new process from its saved session.
- **`steer`** — Send mid-run guidance to a live async child without pausing it.
- **`interrupt`** — Cancel a paused or live run/child; `index` targets specific children in multi-child runs.
- **Native channel, no dependency** — All of this works without `pi-intercom`; a compatibility `intercom` fallback exists for legacy scripts. `subagent_supervisor` inspects pending paused requests.

## Observability

- **Status & fleet views** — `action: "status"` (all, by id, nested tree), `/subagents-fleet` for a read-only view across foreground + background work, live transcript tailing (`view: "transcript"`).
- **Live foreground progress** — Current tool, recent output, tokens, cost, duration; `Ctrl+Shift+D` toggles full detail.
- **Machine-readable lifecycle artifacts** — Async runs write `status.json`, `events.jsonl`, `output-<n>.log`, and a markdown log under a per-user temp root (redirectable via `PI_SUBAGENTS_TEMP_ROOT`); versioned stable v1 field/event contract for workflow gates and external consumers.
- **Debug artifacts** — Per-task input/output/session/metadata files under the parent session's `subagent-artifacts/`, including model fallback attempt records.
- **`wait` tool** — Blocks the turn until the next background run completes or needs attention (event-driven, with polling fallback); supports `all`, `id`, `timeoutMs`. Essential for non-interactive `pi -p` runs. Can be disabled per config/env.
- **Completion batching** — Near-simultaneous successful background completions are grouped into one notification (`completionBatch` tunables); failures/pauses always fire immediately.
- **Diagnostics** — `/subagents-doctor` and `action: "doctor"` for setup checks; `/subagent-cost` for parent + child usage cost.

## Output & result handling

- **Output files** — Per-run `output` paths (agent default or per-call); `outputMode: "file-only"` returns a compact pointer instead of inline content for large reports; `singleRunOutputBaseDir` routing.
- **Bounded foreground cards** — Completion text hard-capped (8,000 chars, ≤8 children, failures prioritized) with explicit truncation markers; full data always available in the structured `details` payload and artifacts.
- **Acceptance gates** — Every run resolves an acceptance policy (`auto`/`none`/`attested`/`checked`/`verified`); children can return structured `acceptance-report` JSON, the runtime can run `verify` commands itself (child self-reports don't count), and provenance (`claimed` → `verified`/`rejected`/`skipped`) is persisted. Explicit `reviewed` requests are rejected in this fork.

## Integration surfaces

- **Event-bus RPC (v1)** — Other Pi extensions can `ping`/`status`/`spawn`/`interrupt`/`stop` via `subagents:rpc:v1:*` events instead of scraping output; same executor, validation, and safety as the tool.
- **pi-permission-system integration** — Automatic when both installed: per-agent `permission:` frontmatter adds allow/ask/deny policy on top of tool visibility; child `ask` prompts forward to the parent UI via `PI_SUBAGENT_PARENT_SESSION`.
- **pi-mcp-adapter** — `mcp:` frontmatter entries give children direct MCP tools.
- **Skills** — Per-agent `skill` lists (or runtime override/disable) with project-first discovery; `read` auto-added so children can load skill files.
- **Prompt-template adapter** — Works with pi-prompt-template-model to wrap delegation in reusable prompts with `--subagent`, `--fork`, `--worktree`, `--bg` overrides.
- **Session sharing** — Opt-in `share: true` exports the child session to HTML and uploads to a secret Gist via `gh`.
- **Private-runtime child spawning** — Children spawn with the resolved parent/private Pi runtime (or `PI_SUBAGENT_PI_BINARY` override) rather than whatever `pi` is on `PATH` — critical when Pi runs from a bundled/private runtime.

## Runtime tuning (`config.json`)

`asyncByDefault`, `forceTopLevelAsync`, `globalConcurrencyLimit` (default 20), `parallel.maxTasks`/`concurrency`, `toolDescriptionMode` (full/compact/custom), `defaultSessionDir`, `intercomBridge` mode/instructions, worktree base dir + setup hooks, wait-tool toggle.

## Deliberately unsupported

Saved-chain workflows (`.chain.md`/`.chain.json` discovery, execution, clarify UI) are intentionally removed as user-facing surfaces; only internal chain-shaped compatibility for the grouped async runner and historical artifacts remains, non-destructively. Existing user chain files and historical artifacts are left untouched.
