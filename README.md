<p>
  <img src="https://raw.githubusercontent.com/diegopetrucci/pi-subagents/main/banner.png" alt="pi-subagents" width="1100">
</p>

# pi-subagents

`pi-subagents` lets Pi delegate work to focused child agents. Use it for code review, scouting, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

## TLH fork distribution note

This forked package exists to serve The Last Harness (`tlh`). TLH automation bundles and pins this package for reproducible installs, and that TLH-managed path is the supported distribution target for this fork. The install and usage docs below still describe how the package works for end users, but this fork is not maintained as a general standalone distribution target outside TLH.

[![npm version](https://img.shields.io/npm/v/%40diegopetrucci%2Fpi-subagents?style=for-the-badge)](https://www.npmjs.com/package/@diegopetrucci/pi-subagents)

https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1

## Installation

```bash
pi install npm:@diegopetrucci/pi-subagents@0.31.8
```

For tlh automation, use this exact pinned install target to keep installs reproducible. Outside TLH, treat this forked package as TLH-owned distribution plumbing rather than a separately supported release channel.

That is the only required step. You can add optional pieces later.

## Try this first

You do not need to create agents, write config, or learn slash commands. After installing, ask Pi for delegation in plain language:

```text
Use reviewer to review this diff.
```

```text
Ask oracle for a second opinion on my current plan.
```

```text
Use scout to understand this code based on our discussion then ask me clarification questions.
```

```text
Run parallel reviewers: one for correctness, one for tests, and one for unnecessary complexity.
```

That is enough to start.

## What happens

Pi is the parent session. A subagent is a focused child Pi session with its own job.

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Foreground runs stream in the conversation. Background runs keep working and can be checked later.

Installing the extension does not start an automatic reviewer in the background. It gives Pi a delegation tool. If you want every implementation reviewed, say that in your prompt or put it in your project instructions:

```text
When you finish implementing, run a reviewer subagent before summarizing.
```

## Good first prompts

These cover most day-to-day use:

```text
Ask oracle for a second opinion on my current plan. Challenge assumptions and tell me what I might be missing.
```

```text
Use oracle to help solve this hard bug. Have it inspect the code and propose the best next move before we edit anything.
```

```text
Run parallel reviewers on this diff. I want one focused on correctness, one on tests, and one on unnecessary complexity.
```

```text
Have worker implement this approved plan. Afterward, run parallel reviewers, summarize their feedback, and apply the fixes that make sense.
```

```text
Run a review loop on this change until reviewers stop finding fixes worth doing, with a max of 3 rounds.
```

```text
Use scout to understand the auth flow, then have planner turn that into an implementation plan.
```

Those are ordinary Pi requests. Pi decides whether to call `subagent`, which agent to use, and whether a chain or parallel run makes sense.

## Common workflows

| Want | Ask naturally |
|------|---------------|
| Get a second opinion | “Ask oracle to review this plan and challenge assumptions.” |
| Solve a hard problem | “Use oracle to investigate this bug before we edit.” |
| Review a diff | “Use reviewer to review this diff.” |
| Run parallel reviewers | “Run reviewers for correctness, tests, and cleanup.” |
| Implement then review | “Implement this, then review it.” |
| Review until clean | “Run a review loop on this change with a max of 3 rounds.” |
| Execute a plan carefully | “Have worker implement this approved plan, then run reviewers and apply the feedback.” |
| Scout before planning | “Use scout to inspect the auth flow before planning.” |
| Run in the background | “Run this in the background.” |
| Browse agents | “Show me the available subagents.” |
| Use a saved workflow | “Run the review chain on this branch.” |
| See running work | “Show active async runs.” or “Show the subagent fleet.” |
| Check setup | “Check whether subagents are configured correctly.” |

The extension ships with builtin agents you can use immediately.

## Builtin agents in plain English

| Agent | Use it when you want... |
|-------|--------------------------|
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks, and where another agent should start. |
| `researcher` | Web/docs research with sources: official docs, specs, benchmarks, recent changes, and a concise research brief. |
| `planner` | A concrete implementation plan from existing context. It should read and plan, not edit code. |
| `worker` | Implementation work, including approved oracle handoffs. It edits files, validates, and escalates unapproved decisions instead of guessing. |
| `reviewer` | Code review and small fixes. It checks the implementation against the task/plan, tests, edge cases, and simplicity. |
| `context-builder` | A stronger setup pass before planning: gathers code context and writes handoff material such as `context.md` and `meta-prompt.md`. |
| `oracle` | A second opinion before acting. It challenges assumptions, catches drift, and recommends the safest next move without editing. |
| `delegate` | A lightweight general delegate when you want a child agent that behaves close to the parent session. |

A simple rule of thumb: use `scout` before you understand the code, `researcher` before you trust external facts, `planner` before a bigger change, `worker` to implement, `reviewer` to check, and `oracle` when the decision itself feels risky.

## Changing an agent's model

Builtin agents inherit your current Pi default model by default. This keeps new installs from depending on a provider you may not have configured. If you want every subagent without its own model to use a different default, set `subagents.defaultModel`. If you want a role to use a specific model, set an override instead of copying the bundled agent file.

```json
{
  "defaultModel": "deepseek-v4-pro",
  "subagents": {
    "defaultModel": "deepseek-v4-flash",
    "agentOverrides": {
      "oracle": {
        "model": "deepseek-v4-pro"
      }
    }
  }
}
```

For one run, pass the override through the `subagent(...)` tool:

```ts
subagent({
  agent: "reviewer",
  model: "anthropic/claude-sonnet-4:high",
  task: "Review this diff"
})
```

For a persistent override, edit settings. This example pins the reviewer everywhere, adds a backup model for provider failures, and keeps the other builtins on your normal default model:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Use `~/.pi/agent/settings.json` for a user override or the project config settings file (`.pi/settings.json` in standard Pi) for a project override. `subagents.defaultModel` applies to builtin, package, user, and project agents that do not set `model` in frontmatter. Per-run model overrides and `agentOverrides.<name>.model` still win, and explicit agent frontmatter still wins over the global default. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable a builtin. Matching user and project agents also receive override fields that their frontmatter leaves unset, so a shared project config agent can keep the persona while local settings choose the model.

If your provider rejects model IDs with thinking suffixes, set `subagents.disableThinking: true` in user or project settings. That clears bundled builtin thinking defaults in one place; an explicit higher-precedence `agentOverrides.<name>.thinking` value can opt a role back in.

To inspect what `pi-subagents` has actually loaded right now, use:

```text
/subagents-models
/subagents-models reviewer
```

That reports the live runtime mapping, which can differ from settings on disk until you reload Pi.

You do not have to spell a model exactly. Model ids are matched fuzzily against the registry, so provider separator variations (`anthropic/claude-sonnet-4`, `anthropic:claude-sonnet-4`, or `anthropic.claude-sonnet-4`), id separator variations (`claude-haiku-4.5` vs `claude-haiku-4-5`), case differences (`Claude-Sonnet-4` vs `claude-sonnet-4`), and optional trailing date stamps (`claude-haiku-4-5-20251001` or `claude-haiku-4-5-2025-10-01` vs `claude-haiku-4-5`) all resolve to the same model. Exact `provider/id` matches still win, and a qualified provider query never silently switches providers — it only matches within the named provider. Ambiguous bare ids that exist under multiple providers still require a provider prefix or the current session's provider to disambiguate.

To keep subagents inside a budget or compliance profile, enforce a model scope. Put `subagents.modelScope` in user or project settings (project overrides user):

```json
{
  "subagents": {
    "modelScope": {
      "enforce": true,
      "allow": ["anthropic/*", "openai/gpt-5-*"]
    }
  }
}
```

`allow` is a list of glob patterns matched against the resolved `provider/id` (only `*` is special, case-insensitive). A resolved model that matches none of the patterns is rejected. Models you pass explicitly — the tool-call `model`, `--model`, or a runtime-only clarify pick — error and abort the run. Models that come from agent frontmatter, `subagents.defaultModel`, or the inherited parent session model only warn, so existing configurations keep working while you tighten the scope. `enforce: true` requires a non-empty `allow` list; otherwise the config is rejected at load time.

## Where running subagents show up

Foreground runs stream progress in the conversation while they run.

Background runs keep working after control returns to you. Inspect active runs with `subagent({ action: "status" })`, or a specific run with `subagent({ action: "status", id: "..." })`. For a read-only fleet view across active foreground and background work, use `/subagents-fleet` or `subagent({ action: "status", view: "fleet" })`. To inspect what a background child is saying without hunting through artifact directories, tail its live transcript with `subagent({ action: "status", id: "...", view: "transcript" })`; add `index` for a specific child in a parallel or chain run.

They also show a compact async widget and send completion notifications. Parallel background runs show per-agent progress instead of fake chain steps. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. When a child is explicitly allowed to fan out with `tools: subagent`, its nested runs appear under that parent child in the main status tree instead of being hidden inside the child process.

You can also ask naturally:

```text
Show me the current async runs.
```

Async runs also write machine-readable lifecycle artifacts for observability and workflow gates. For a top-level async run, `details.asyncDir` points at a directory containing `status.json`, `events.jsonl`, `output-<index>.log`, and `subagent-log-<runId>.md`; the final summary is written to Pi's subagent results directory as `<runId>.json`. Nested async runs use the same shape under the nested async root and are discoverable through status projections that read the nested-run registry. These files are append/update artifacts only; interactive foreground behavior is unchanged.

The stable v1 status/result fields are `lifecycleArtifactVersion`, `runId`/`id`, `sessionId`, `mode`, `state`, `startedAt`, `lastUpdate`, `endedAt`, `durationMs`, `cwd`, `asyncDir`, `sessionFile`, `outputFile`, `workflowGraph`, `steps`, `results`, `totalTokens`, `totalCost`, `model`/`attemptedModels`/`modelAttempts`, `toolCount`, `turnCount`, and nested `children` when a child is allowed to launch subagents. `events.jsonl` records lifecycle transitions such as `subagent.run.started`, `subagent.step.started`, `subagent.step.completed`/`failed`/`paused`, control attention events, nested interrupt failures, and `subagent.run.completed`; run boundary events include the lifecycle artifact version. Consumers should read these JSON files instead of scraping terminal output; unknown fields and event types should be ignored for forward compatibility.

Other Pi extensions can use the versioned in-process event-bus RPC instead of scraping slash output or calling internal modules. Listen for `subagents:rpc:v1:ready`, send requests on `subagents:rpc:v1:request`, and read replies from `subagents:rpc:v1:reply:<requestId>`.

```typescript
const requestId = crypto.randomUUID();
pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
  // { version: 1, requestId, success: true, data } or
  // { version: 1, requestId, success: false, error: { code, message } }
});
pi.events.emit("subagents:rpc:v1:request", {
  version: 1,
  requestId,
  method: "spawn",
  params: { agent: "reviewer", task: "Review the current diff", context: "fresh" }
});
```

The v1 methods are `ping`, `status`, `spawn`, `interrupt`, and `stop`. `status` and `interrupt` reuse the normal control actions. `spawn` is async-only: omit `async` or set `async: true`, do not pass `clarify` (the closed TLH schema rejects it), and do not pass management `action` values. Legacy control callers may still send `runId`; RPC maps it to `id` before validation. It goes through the same executor as the `subagent` tool, so agent discovery, validation, session attribution, spawn limits, child-safety depth, artifacts, and async status all behave the same. `stop` targets running async runs through the existing timeout control channel.

`pi.events` is in-process only. It does not reach separate Pi processes or child subagents; use the native supervisor channel (`contact_supervisor` child→parent, `subagent_supervisor` parent→child reply, `steer` for live guidance) as the primary cross-process coordination path, and the file lifecycle artifacts for cross-process observability. `pi-intercom` is optional and no longer required.

If something feels misconfigured, run:

```text
/subagents-doctor
```

or ask:

```text
Check whether subagents and intercom are set up correctly.
```

Background run state (async configs, results, chain runs, and artifacts) lives under a per-user scoped directory in the OS temp dir by default. Set `PI_SUBAGENTS_TEMP_ROOT` to an absolute path to redirect that root elsewhere, e.g. to keep test or CI runs from sharing state with a live session.

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
planner → worker → fresh reviewers → worker
```

Use the workflow recipes described later in this README when you want the same orchestration shape repeatedly.

Packaged `planner`, `worker`, and `oracle` default to forked context when a launch omits `context`; pass `context: "fresh"` when you intentionally want a fresh child run.

Child-safety boundaries are enforced at runtime. Forked child context filtering removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results. By default, children do not register the `subagent` tool and receive boundary instructions that they are not the parent orchestrator and must not propose or run subagents. The explicit exception is an agent whose resolved builtin `tools` includes `subagent`; that child gets a child-safe `subagent` tool for the fanout work the parent assigned, still bounded by `maxSubagentDepth`.

## Repeatable workflow recipes

`pi-subagents` no longer bundles direct workflow slash shortcuts. For repeatable orchestration, ask naturally or use the `subagent(...)` tool with patterns such as:

- parallel review
- review loop
- parallel research
- parallel context build
- parallel handoff plan
- gather context then plan
- parallel cleanup

## Native supervisor coordination

Child agents can talk back to the parent Pi session without installing `pi-intercom`. `pi-subagents` provides three native coordination legs:

- **`contact_supervisor`** (child→parent): the child requests a blocking decision, structured interview, or progress update from the supervising parent session.
- **`subagent_supervisor({ action: "reply" })`** (parent→child reply): the parent answers a pending request written by the child.
- **`steer`** (parent→child guidance): the parent sends mid-run guidance to a live async child without interrupting it — `subagent({ action: "steer", id, message })`. This is the native parent→child channel that complements `contact_supervisor`.

`pi-intercom` is not required. If no external `pi-intercom` tool owns the `intercom` name, the native channel also exposes `intercom` as a compatibility fallback for scripts that use that name.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through intercom.
```

```text
Ask oracle to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child can use one dedicated coordination tool:

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` for blocking decisions or clarification, `reason: "interview_request"` for structured input, and `reason: "progress_update"` for short non-blocking updates when a discovery changes the plan. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

The parent replies with `subagent_supervisor({ action: "reply", replyTo, message })` or checks pending requests with `subagent_supervisor({ action: "pending" })`. Supervisor messages are scoped to the exact Pi session id that spawned the child. A second Pi session in the same repository does not receive those requests.

Child-side routine completion handoffs are still not expected. If a child appears stalled, needs-attention notices can show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If messages do not show up, run:

```text
/subagents-doctor
```

For normal use, you do not need to configure anything. Advanced users can tune the bridge with `intercomBridge` in the configuration section below.

At this point, you know enough to use the plugin. The rest of this README is reference material for exact command syntax, custom agents, saved chains, worktrees, and configuration.

## Optional pi-permission-system integration

[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
adds a second policy layer — `allow` / `ask` / `deny` — on top of
pi-subagents' visibility-based tool restrictions.

The two compose independently:

| Layer | What it controls | Who provides it |
|-------|-----------------|-----------------|
| Visibility | Which tools are registered before the session starts | pi-subagents (`tools:` frontmatter key) |
| Policy  | Runtime allow/ask/deny decisions on every tool call, bash command, MCP operation | pi-permission-system (`permission:` frontmatter key) |

### Installing

```bash
pi install npm:@gotgenes/pi-permission-system
```

No configuration is required for the integration — it is automatic when both
extensions are installed. pi-subagents passes the parent session identity
to child processes via the `PI_SUBAGENT_PARENT_SESSION` environment variable,
which the permission system uses to forward `ask` prompts from headless
subagent processes back to the parent session's UI.

### Per-agent permission frontmatter

Agent files can include a `permission:` block alongside the standard `tools:`
key. The permission system reads it independently:

```yaml
---
name: worker
tools: bash,read,write,edit
permission:
  "*": ask
  read: allow
  bash:
    "*": ask
    "git *": allow
    "npm test": allow
---
```

In this example the subagent extension restricts visibility to four tools,
and the permission system then applies `ask`/`allow` policy within that
visible set. Both keys coexist without collision.

### Checking the integration

Run `/subagents-doctor` to check the permission system status.
If `ask` prompts from children are not reaching the parent UI, verify both
extensions are installed:

```bash
pi list
```

### How it works

At session start, the interactive (root) session records its own identity in
`PI_SUBAGENT_PARENT_SESSION`. When pi-subagents launches a child, it passes the
launching session's identity to that child explicitly, falling back to the
inherited environment variable. When the permission system inside a child
encounters an `ask` permission, it reads this variable to locate the parent
session and forwards the confirmation request there.

This resolves an interactive prompt only when the parent it points at is the
interactive session — i.e. for the direct children of the root session. A
nested child's parent is itself a headless subagent process with no UI to
surface the prompt, so `ask` policies are best placed on agents that run as
direct children of the interactive session.

## Slash commands

`pi-subagents` keeps only narrow diagnostic/status slash commands:

| Command | Description |
|---------|-------------|
| `/subagents-doctor` | Show read-only setup diagnostics |
| `/subagents-models [agent]` | Show the runtime-loaded builtin model mapping, optionally filtered to one builtin |
| `/subagents-profiles` | List saved subagent profiles from `~/.pi/agent/profiles/pi-subagents/` |
| `/subagents-check-profile <name>` | Check a saved profile against the current registry and live model probes |
| `/subagent-cost` | Show parent and subagent child usage cost for this session |

Launch workflows through natural language or the `subagent(...)` tool API instead of direct workflow slash commands.

Profiles are stored under `~/.pi/agent/profiles/pi-subagents/`. Provider model catalogs, when created by other tooling, are cached under `~/.pi/agent/profiles/pi-subagents/providers/`.

Background runs are detached. If the parent agent has other independent work, it should keep working. When it has nothing useful to do until a background result arrives, it should call the `wait` tool instead of running sleep or status-polling loops. `wait()` returns when the next active run finishes or needs attention and keeps the turn alive for normal notification delivery; use `wait({ all: true })` to drain every active run, `wait({ id })` for one run, and `wait({ timeoutMs })` to cap the block.

`wait` is what lets a background-launching skill keep moving in a single turn, including non-interactive `pi -p` invocations where there is no subsequent turn to receive a completion notification. Ending the turn to wait for a completion only works in an interactive session where the user will prompt the agent again; in a run-to-completion skill or a non-interactive run, use `wait` so the still-running children are not abandoned.

The `oracle` and `worker` builtins are designed for an explicit decision loop. A typical pattern is to ask `oracle` for diagnosis and a recommended execution prompt, then only run `worker` after the main agent approves that direction.

## Clarify and launch UI (runtime-only, not exposed to TLH model calls)

The clarify UI remains in the runtime for direct/manual integrations, but the closed TLH model-facing `subagent` contract does not expose a `clarify` parameter. Tool calls launched through TLH go directly to execution.

Common clarify keys:

- `Enter` runs in the foreground, or in the background if background is toggled on
- `Esc` cancels or backs out
- `↑↓` moves between steps or tasks
- `e` edits the task/template
- `m` selects a model
- `t` selects thinking level
- `s` selects skills
- `b` toggles background execution
- `w` edits output/write behavior where supported
- `r` edits reads where supported
- `p` toggles progress tracking where supported
Picker screens use `↑↓`, `Enter`, `Esc`, and type-to-filter. The full-screen editor supports word wrapping, paste, `Esc` to save, and `Ctrl+C` to discard.

## Agents and chains (runtime/reference; chain inputs are not exposed to TLH model calls)

Agents are markdown files with YAML frontmatter and a system prompt body. They define the specialist that will run in the child Pi process.

Agent locations, lowest to highest priority:

| Scope | Path |
|-------|------|
| Builtin | `~/.pi/agent/extensions/subagent/agents/` |
| Installed package | `package.json` `pi-subagents.agents` or `pi.subagents.agents` |
| User | `~/.pi/agent/agents/**/*.md` |
| Project | Project config `agents/**/*.md` (`.pi/agents/**/*.md` in standard Pi) |

Project discovery also reads legacy `.agents/**/*.md` files. Nested subdirectories are discovered recursively. `.chain.md` files do not define agents. Installed Pi packages can expose agent directories from either `{"pi-subagents":{"agents":["./agents"]}}` or `{"pi":{"subagents":{"agents":["./agents"]}}}` in their package manifest. Package agents load above builtins and below user/project agents. If both `.agents/` and the project config agents directory define the same parsed runtime agent name, the project config directory wins. Use `agentScope: "user" | "project" | "both"` to control discovery; `both` is the default and project definitions win runtime-name collisions.

Builtin agents load at the lowest priority, so a user or project agent with the same name overrides them. They do not pin a provider model; they inherit your current Pi default model unless you set `subagents.defaultModel` or `subagents.agentOverrides.<name>.model`. `oracle` is an advisory reviewer that critiques direction and proposes an execution prompt without editing files. `worker` is the implementation agent for normal tasks and approved oracle handoffs.

The `researcher` builtin uses `web_search`, `fetch_content`, and `get_search_content`; those require [pi-web-access](https://github.com/nicobailon/pi-web-access):

```bash
pi install npm:pi-web-access
```

### Builtin overrides

You can override selected builtin fields without copying the whole agent. Overrides live in settings:

- User: `~/.pi/agent/settings.json`
- Project: project config settings file (`.pi/settings.json` in standard Pi)

Example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "inheritProjectContext": false
      }
    }
  }
}
```

Supported override fields are `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`. Use `defaultContext: false` in builtin overrides to clear an inherited context default. Project overrides beat user overrides.

Set `subagents.defaultModel` to give all subagents without an explicit model their own default model, separate from the parent session model. Per-agent model overrides and agent frontmatter still win.

Set `disabled: true` to hide a builtin from runtime discovery and agent-facing `subagent({ action: "list" })` output. For bulk control, set `subagents.disableBuiltins: true` in settings. To toggle a single agent, edit the `disabled` override field directly in settings — the model-facing action set does not include mutating management actions.

Set `subagents.disableThinking: true` to clear bundled builtin thinking defaults globally for providers that do not support `:low`, `:medium`, `:high`, or similar model suffixes. A higher-precedence per-agent `thinking` override can opt one builtin back in.

### Prompt assembly

Subagents are designed to be narrow by default. Custom agents start with a clean system prompt and only the context you intentionally give them. They do not automatically inherit Pi’s whole base prompt, project instruction files, or discovered skills catalog.

Use these fields when an agent should see more:

| Field | Effect |
|-------|--------|
| `systemPromptMode: append` | Append the agent prompt to Pi’s normal base prompt. |
| `inheritProjectContext: true` | Keep inherited project instructions from files like `AGENTS.md` and `CLAUDE.md`. |
| `inheritSkills: true` | Let the child see Pi’s discovered skills catalog. |
| `defaultContext: fork` | Use forked session context when a launch omits `context`; explicit `context: "fresh"` still wins. |

Builtin agents opt into project instruction inheritance by default so they follow repo-specific rules out of the box. `delegate` also uses append mode because its job is orchestration inside the parent workflow.

### Agent frontmatter

A typical agent looks like this:

```yaml
---
name: scout
# Optional: registers this as code-analysis.scout while preserving name: scout
package: code-analysis
description: Fast codebase recon
tools: read, grep, find, ls, bash, mcp:chrome-devtools
extensions:
subagentOnlyExtensions: ./tools/child-only-search.ts
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: safe-bash, chrome-devtools
output: context.md
defaultReads: context.md
defaultProgress: true
completionGuard: false
interactive: true
maxSubagentDepth: 1
---

Your system prompt goes here.
```

Important fields:

| Field | Notes |
|-------|-------|
| `package` | Optional package identifier. A file with `name: scout` and `package: code-analysis` registers as `code-analysis.scout`; serialization keeps `name` and `package` separate. |
| `tools` | Builtin tool allowlist. `mcp:` entries select direct MCP tools when `pi-mcp-adapter` is installed. |
| `extensions` | Omitted means normal extensions; empty means no extensions; comma-separated values allowlist specific extensions. |
| `subagentOnlyExtensions` | Comma-separated extension paths loaded only in spawned child sessions for this agent. Tools registered there are unavailable to the main agent unless also installed through normal Pi extension configuration. |
| `model` | Default model. Bare ids prefer the current provider when possible, then unique registry matches. |
| `fallbackModels` | Ordered backup models for provider/model failures such as quota, auth, timeout, or unavailable model. Ordinary task failures do not trigger fallback. |
| `thinking` | Appended as a `:level` suffix at runtime unless a suffix is already present. |
| `systemPromptMode` | `replace` by default; `append` keeps Pi’s base prompt. |
| `inheritProjectContext` | Keeps or strips inherited project instruction blocks. |
| `inheritSkills` | Keeps or strips Pi’s discovered skills catalog. |
| `defaultContext` | Optional `fresh` or `fork` launch context default for this agent. |
| `skills` | Adds specific skills to the child’s available skill list, regardless of `inheritSkills`. |
| `output` | Default single-agent output file. |
| `defaultReads` | Files to read before running in chain/parallel behavior. |
| `defaultProgress` | Maintain `progress.md`. |
| `completionGuard` | Set `false` only for non-implementation agents that may mention implementation words while using mutation-capable tools such as `bash`. |
| `interactive` | Parsed for compatibility but not enforced in v1. |
| `maxSubagentDepth` | Tightens nested delegation for this agent's children. |
| `memory` | Opt-in role-specific persistent memory. `memory: { scope: "project" \| "user", path: "<name>" }` injects the first lines of a `MEMORY.md` from a dedicated `agent-memory/` directory into the child system prompt. Agents with write tools (`edit`/`write`/`bash`) get a read-write block; read-only agents get a read-only fallback. Project scope resolves under `<project>/.pi/agent-memory/`, user scope under `~/.pi/agent/agent-memory/`. Paths are validated against traversal and symlink escape. |

### Per-agent persistent memory

A recurring custom agent can opt into a durable, role-specific memory scope with the `memory` frontmatter field. This is independent of Pi's own parent/session/project memory system and writes nothing to it; memory lives under a dedicated `agent-memory/` namespace so the two never collide.

```yaml
memory:
  scope: project
  path: security-reviewer
```

On each run, the first 200 lines of `MEMORY.md` in the resolved memory directory are injected into the child system prompt so the agent can recall accumulated role notes such as threat-model entries, release gotchas, or verified commands. Agents that have write tools (`edit`, `write`, or `bash`, or no `tools` allowlist at all) are told they may append concise dated entries to the file. Agents without write tools receive a read-only memory block and are not instructed to edit it, so a read-only reviewer can still recall prior notes without being granted write capability. The memory directory is never created eagerly; the agent's own `write` tool creates it (and `MEMORY.md`) on the first persist. Memory paths are validated against `.`/`..` traversal and symlink escape, and an unsafe or unresolvable scope is silently skipped rather than breaking the run.

Project-scoped memory resolves under `<project>/.pi/agent-memory/<path>` and travels with the repo. User-scoped memory resolves under `~/.pi/agent/agent-memory/<path>` and is shared across projects for that agent.

### Tool and extension selection

If `tools` is omitted, `pi-subagents` does not pass `--tools`, so the child gets Pi’s normal builtin tools. If `tools` is present, regular tool names become an explicit allowlist. `mcp:` entries are split out and forwarded as direct MCP selections. Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than builtin tool names. Agents that declare only known read-only builtin tools skip the implementation completion guard, but `bash`, unknown tools, and MCP tools stay mutation-capable. Use `completionGuard: false` for bash-enabled validators or advisors that should never be judged as implementation agents.

Examples:

- `tools` omitted and `extensions` omitted: normal builtins and normal extensions.
- `tools: mcp:chrome-devtools`: normal builtins plus direct Chrome DevTools MCP tools.
- `tools: read, bash, mcp:chrome-devtools`: only `read` and `bash` as builtins, plus direct Chrome DevTools MCP tools.
- `tools: subagent, read`: a child-safe `subagent` tool is available inside that child so it can run explicitly assigned nested fanout.

Direct MCP tools require [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Subagents only receive direct MCP tools when `mcp:` entries are listed in their frontmatter; global `directTools: true` in `mcp.json` is not enough by itself. The generic `mcp` proxy tool can still be used for discovery when available. The adapter caches tool metadata at startup, so after connecting a new MCP server for the first time, restart Pi before relying on direct tools. An `mcp:` entry named `subagent` does not authorize nested fanout; only the builtin `subagent` tool name does.

`extensions` controls child extension loading:

```yaml
# Omitted: all normal extensions load

# Empty: no extensions
extensions:

# Allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

When `extensions` is present, it takes precedence over extension paths implied by `tools` entries.

Use `subagentOnlyExtensions` when a custom extension tool should exist only inside child sessions. It is scoped by agent config: every run of that agent receives those extension paths, while other agents do not unless they declare the same field. The current model does not have a separate named-subagent audience inside one agent definition.

## Chain files

Chains are reusable workflows stored separately from agent files. Use `.chain.md` for simple sequential saved chains. Use `.chain.json` when a chain needs dynamic fanout.

| Scope | Path |
|-------|------|
| Installed package | `package.json` `pi-subagents.chains` or `pi.subagents.chains` |
| User | `~/.pi/agent/chains/**/*.chain.md`, `~/.pi/agent/chains/**/*.chain.json` |
| Project | Project config `chains/**/*.chain.md`, `chains/**/*.chain.json` (`.pi/chains/...` in standard Pi) |

Nested subdirectories are discovered recursively. Installed Pi packages can expose chain directories from either `{"pi-subagents":{"chains":["./chains"]}}` or `{"pi":{"subagents":{"chains":["./chains"]}}}` in their package manifest. Package chains load below user/project chains. If both `.chain.md` and `.chain.json` define the same parsed runtime chain name in the same scope, `.chain.json` wins. If user and project scopes define the same parsed runtime chain name, the project chain wins. Chains support the same optional `package` frontmatter as agents; `name: review-flow` plus `package: code-analysis` runs as `code-analysis.review-flow`.

Example:

```md
---
name: scout-planner
description: Gather context then plan implementation
---

## scout
phase: Context
label: Map auth flow
as: context
output: context.md

Analyze the codebase for {task}

## planner
phase: Planning
label: Implementation plan
reads: context.md
model: anthropic/claude-sonnet-4-5:high
progress: true

Create an implementation plan based on {outputs.context}
```

Each `.chain.md` `## agent-name` section is a step. Config lines such as `phase`, `label`, `as`, `outputSchema`, `output`, `outputMode`, `reads`, `model`, `skills`, and `progress` go immediately after the header. A blank line separates config from task text. In saved `.chain.md` files, `outputSchema` is a path to a JSON Schema file; internal handler inputs and `.chain.json` files can pass the schema object inline.

For `output`, `reads`, `skills`, and `progress`, chain behavior is three-state: omitted inherits from the agent, a value overrides, and `false` disables.

Use `phase` to group related work in status output, `label` for a readable step name, and `as` to store a successful step or parallel task result for later `{outputs.name}` references. Duplicate `as` names, invalid identifiers, and unknown output references fail before child execution.

Retained internal chain handlers support dynamic fanout through chain data shaped like `{ chain: [...] }` or saved `.chain.json` files. This runtime capability is not exposed by the registered TLH schema and cannot be invoked through TLH natural-language or model-facing `subagent` tool calls. Dynamic fanout expands an array from a prior structured named output, runs one child template per item, and stores the ordered collection under `collect.as`. The source must be structured output; prose is never parsed. `expand.maxItems` is required, over-limit arrays fail, nested fanout and arbitrary expressions are not supported, and `.chain.md` has no dynamic syntax in this release.

```json
{
  "name": "dynamic-review",
  "description": "Find review targets, fan out reviewers, then synthesize.",
  "chain": [
    {
      "agent": "scout",
      "task": "Return {\"items\":[{\"path\":\"...\",\"reason\":\"...\"}]} via structured_output.",
      "as": "targets",
      "outputSchema": { "type": "object" }
    },
    {
      "expand": {
        "from": { "output": "targets", "path": "/items" },
        "item": "target",
        "key": "/path",
        "maxItems": 12
      },
      "parallel": {
        "agent": "reviewer",
        "label": "Review {target.path}",
        "task": "Review {target.path}. Reason: {target.reason}",
        "outputSchema": { "type": "object" }
      },
      "collect": { "as": "reviews" },
      "concurrency": 4
    },
    {
      "agent": "worker",
      "task": "Synthesize fixes from {outputs.reviews}"
    }
  ]
}
```

Simple `.chain.md` and dynamic `.chain.json` files remain supported as retained runtime chain data and can be authored by writing those files directly. Internal management and execution handlers still understand chain creation and saved-chain execution, but the registered TLH schema exposes neither the mutating `create` action nor chain inputs. Consequently, saved chains are not invocable through TLH natural-language or model-facing `subagent` tool calls.

## Chain variables

Task templates support:

| Variable | Description |
|----------|-------------|
| `{task}` | Original task from the first step. |
| `{previous}` | Output from the prior step, or aggregated output from a parallel step. |
| `{chain_dir}` | Path to the chain artifact directory. |
| `{outputs.name}` | Text value from a prior step or completed parallel task with `as: "name"`. |

Parallel outputs are aggregated with clear separators before being passed to the next step:

```text
=== Parallel Task 1 (worker) ===
...

=== Parallel Task 2 (worker) ===
...
```

## Skills

Skills are `SKILL.md` files made available to an agent. The prompt includes skill metadata and the file location; the agent reads the full skill file only when the task matches.

Discovery uses project-first precedence:

1. Project config `skills/{name}/SKILL.md` (`.pi/skills/{name}/SKILL.md` in standard Pi)
2. Project packages and project settings packages via `package.json -> pi.skills`
3. Current task cwd package via `package.json -> pi.skills`
4. Project config `settings.json -> skills`
5. `~/.pi/agent/skills/{name}/SKILL.md`
6. User packages and user settings packages via `package.json -> pi.skills`
7. `~/.pi/agent/settings.json -> skills`

Use agent defaults, override them at runtime, or disable them:

```ts
{ agent: "scout", task: "..." }
{ agent: "scout", task: "...", skill: "tmux, safe-bash" }
{ agent: "scout", task: "...", skill: false }
```

For chains, `skill` at the top level is additive. A step-level `skill` overrides that step; `false` disables skills for that step.

Available skills use this shape:

```xml
The following configured skills are available to this subagent.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>safe-bash</name>
    <description>Run shell commands safely.</description>
    <location>/absolute/path/to/safe-bash/SKILL.md</location>
  </skill>
</available_skills>
```

If an agent has an explicit `tools` allowlist and resolved skills, `read` is added for that child run so the listed skill files can be loaded on demand.

Missing skills do not fail execution. The result summary shows a warning.

### TLH package note

This TLH fork does not bundle a parent `pi-subagents` skill. Use this README, the builtin agent prompts, and your project instructions for orchestration guidance instead.

## Programmatic tool usage

These are the parameters the model passes when it calls the TLH-facing `subagent` tool. Chain execution, clarify UI, and worktrees are retained runtime-only code not exposed to TLH model calls. Scheduling and mutating management actions are rejected by the executor for all callers (see `### scheduledRuns` below).

### Execution examples

```ts
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "scout", task: "find TODOs", output: false }
{ agent: "scout", task: "write a large report", output: "reports/scout.md", outputMode: "file-only" }
{ agent: "worker", task: "continue this thread", context: "fork" }
{ agent: "reviewer", task: "review the current diff", model: "anthropic/claude-sonnet-4", fallbackModels: ["openai/gpt-5-mini"] }

// Parallel
{ tasks: [{ agent: "scout", task: "audit frontend" }, { agent: "reviewer", task: "audit backend" }] }
{ tasks: [{ agent: "scout", task: "audit auth", count: 3 }] }
{ tasks: [{ agent: "scout", task: "summarize API risks", output: "reports/api-risks.md", outputMode: "file-only" }, { agent: "reviewer", task: "check tests", reads: ["reports/api-risks.md"], progress: true, model: "openai/gpt-5-mini" }], concurrency: 2, context: "fork", async: true }
```

### Supported actions

The closed TLH action set is read-only management plus async control:

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "scout" }
{ action: "get", agent: "code-analysis.scout" }
{ action: "models" }
{ action: "models", agent: "reviewer" }
{ action: "status" }
{ action: "status", id: "run-123" }
{ action: "interrupt", id: "run-123" }
{ action: "resume", id: "run-123", message: "follow up on the failing test", index: 0 }
{ action: "steer", id: "run-123", message: "focus on the auth module", index?: 0 }
{ action: "doctor" }
```

`list` returns agent-oriented information only. TLH model calls do not expose mutating actions such as create/update/delete/eject/enable/disable/reset, and they do not expose chain inspection or editing.

### Parameter reference

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | string | - | Agent name for SINGLE mode, or target for `action: "get"`. |
| `task` | string | - | Task string for SINGLE mode; optional for self-contained agents. |
| `tasks` | array | - | PARALLEL mode only. Each task object is fail-closed and supports exactly `agent`, `task`, `count`, `output`, `outputMode`, `reads`, `progress`, and `model`. |
| `concurrency` | number | config or `4` | Top-level parallel concurrency. |
| `context` | `fresh \| fork` | per-agent default or `fresh` | Explicit `fresh` or `fork` overrides every child. When omitted, each requested agent uses its own `defaultContext`; otherwise fresh is used. |
| `async` | boolean | false | Background execution. |
| `action` | string | - | `list`, `get`, `models`, `status`, `interrupt`, `resume`, `steer`, or `doctor`. Omit for execution mode. |
| `id` | string | - | Run id or prefix for `status`, `interrupt`, `resume`, or `steer`. |
| `index` | number | - | Zero-based child index for a targeted `resume` or `steer`. |
| `message` | string | - | Follow-up message for `action: "resume"`, or mid-run guidance for `action: "steer"`. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope for `list`. Project wins on collisions. |
| `output` | `string \| false` | agent default | Override SINGLE-mode output file. Relative paths resolve against `cwd`. |
| `outputMode` | `"inline" \| "file-only"` | `inline` | Return saved output inline or as a concise saved-file reference. `file-only` requires `output` to be a path. |
| `model` | string | agent default | Override the primary model for SINGLE mode or an individual parallel task. |
| `fallbackModels` | string[] | agent default | Extra SINGLE-mode fallback models to try after the primary model. |
| `timeoutMs` | number | none | Optional run-level max runtime in milliseconds for foreground and async/background runs. |
| `cwd` | string | runtime cwd | Override working directory. |
| `artifacts` | boolean | true | Write debug artifacts. |
| `includeProgress` | boolean | false | Include full progress in the result. |

`context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. When the inherited transcript contains signed Anthropic `thinking` / `redacted_thinking` blocks, `pi-subagents` strips those provider-private blocks from the forked child session and forces the child run's thinking level to `off` so Anthropic does not reject modified signatures after branching or compaction. Forking never silently downgrades to `fresh`. In multi-agent runs that omit `context`, each agent/task follows its own `defaultContext`, so a fresh-default scout can run fresh beside a fork-default worker. Pass explicit `context: "fork"` or `context: "fresh"` when you intentionally want one context for every child.

`timeoutMs` applies to foreground and async/background runs. It is a destructive deadline that cancels the child run when reached, not a soft wait limit. For long-running async/background work, launch with `async: true` and check progress with `subagent({ action: "status" })`; use `resume` for follow-up instead of setting a timeout.

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging.

Status and control actions:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "interrupt", id: "<run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "follow-up question" })
subagent({ action: "resume", id: "<run-id>", index: 1, message: "follow-up for child 2" })
subagent({ action: "steer", id: "<run-id>", message: "guidance for the live async child" })
subagent({ action: "doctor" })
```

`status` resolves exact foreground ids, top-level async ids, and nested run ids before falling back to prefix matching. `resume` sends the follow-up directly when an async child is still reachable over intercom. After completion, it revives the child by starting a new async child from the stored child session file. Multi-child async runs can be revived by passing `index` to choose the child. Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.

## Worktree isolation (runtime-only, not exposed to TLH model calls)

Parallel agents can clobber each other if they edit the same checkout. `worktree: true` gives each parallel child its own git worktree branched from `HEAD`.

```ts
{ tasks: [
  { agent: "worker", task: "Implement auth", count: 2 },
  { agent: "worker", task: "Implement API" }
], worktree: true }

{ chain: [
  { agent: "scout", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A from {previous}" },
    { agent: "worker", task: "Implement feature B from {previous}" }
  ], worktree: true },
  { agent: "reviewer", task: "Review all changes from {previous}" }
]}
```

Requirements:

- run inside a git repo
- working tree must be clean
- `node_modules/` is symlinked into each worktree when present
- task-level `cwd` overrides must be omitted or match the shared cwd
- configured `worktreeSetupHook` must return valid JSON before timeout

By default, worktrees are created under the system temp directory. Set `worktreeBaseDir` in config, or `PI_SUBAGENTS_WORKTREE_DIR` when config is unset, to put them under a stable trusted directory. Missing base directories are created automatically.

After a worktree parallel step completes, per-agent diff stats are appended to the output and full patch files are written to artifacts. Worktrees and temp branches are cleaned up in `finally` blocks.

## Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`. Several settings below tune retained runtime-only features that are intentionally outside the closed TLH model-call contract.

### `toolDescriptionMode`

```json
{ "toolDescriptionMode": "compact" }
```

Controls the parent-facing `subagent` tool description registered at startup. `full` is the default. `compact` keeps the execution modes, async/wait guidance, child-safety boundary, management/action split, one-writer review guidance, and artifact/status essentials with less prompt bloat.

`custom` reads `subagent-tool-description.md` from the project config directory, then from `~/.pi/agent/subagent-tool-description.md`. Missing, empty, unreadable, or oversized custom files fall back to the full description. Custom templates may use `{{fullDescription}}`, `{{compactDescription}}`, `{{safetyGuidance}}`, `{{agentDir}}`, and `{{projectConfigDir}}`; the safety guidance is always present so custom prose cannot remove the runtime guardrails. Restart Pi after changing the mode or custom file.

### `asyncByDefault`

```json
{ "asyncByDefault": true }
```

Makes top-level calls use background execution when the request does not explicitly set `async`. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.

### `waitTool`

```json
{ "waitTool": { "enabled": false } }
```

Keeps the `wait` tool registered but makes it return immediately instead of blocking on active async runs. Use this in interactive sessions where background completions should arrive as notifications while the main conversation stays steerable. The default is enabled. You can also set `"waitTool": false`; set `PI_SUBAGENT_WAIT_TOOL_ENABLED=false` (or `0`, `off`, `disabled`) to override config for one process. Invalid `waitTool` config or env values fail instead of being coerced.

### `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 single, parallel, and chain runs into background mode and bypasses clarify UI by forcing `clarify: false`. Nested calls keep their own inherited settings.

### `globalConcurrencyLimit`

```json
{ "globalConcurrencyLimit": 20 }
```

Caps simultaneously running subagent tasks within a single run across top-level parallel tasks, inline chain parallel groups, and dynamic fanout groups. The default is `20`; invalid values are clamped to `1`. Per-step `concurrency` and `parallel.concurrency` still apply, so effective concurrency is the lower of the local cap and the available global slots.

### `maxSubagentSpawnsPerSession`

```json
{ "maxSubagentSpawnsPerSession": 40 }
```

Caps the total number of child subagent launches allowed during one parent session, including single runs, parallel task counts, static chain steps, and bounded dynamic fanout children. Set `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` to override the config for a process. The default is `40`; `0` blocks new subagent launches for that session.

### `scheduledRuns`

> **Scheduling is disabled in the TLH fork.** The scheduled-run manager is not wired at extension startup; `schedule`, `schedule-list`, `schedule-status`, and `schedule-cancel` actions are rejected by the executor with an `Unknown action` error for all callers. The runtime module (`scheduled-runs.ts`) is retained until phase-3 deletion. The `scheduledRuns` config key is inert.

### `parallel`

```json
{
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  }
}
```

`maxTasks` defaults to `8`; `concurrency` defaults to `4`. Per-call `concurrency` takes precedence.

### `defaultSessionDir`

```json
{ "defaultSessionDir": "~/.pi/agent/sessions/subagent/" }
```

Session directory precedence is: `params.sessionDir`, then `config.defaultSessionDir`, then a directory derived from the parent session. Sessions are always enabled.

### `singleRunOutputBaseDir`

```json
{ "singleRunOutputBaseDir": "~/.pi/subagent-outputs" }
```

Routes relative `output` paths for single-agent runs under this directory. Absolute per-call or agent output paths are still used as-is. When unset, relative single-run outputs go under the run's output artifact directory instead of the project root.

### `maxSubagentDepth`

```json
{ "maxSubagentDepth": 1 }
```

Controls nested delegation when no inherited `PI_SUBAGENT_MAX_DEPTH` is already in effect. Per-agent `maxSubagentDepth` can tighten the limit for that agent’s child runs, but cannot relax an inherited stricter limit. This applies even to children that explicitly declare `tools: subagent`; at the cap, execution fanout is blocked instead of silently hiding nested work.

### `PI_SUBAGENT_PI_BINARY`

```bash
export PI_SUBAGENT_PI_BINARY=/path/to/pi-or-wrapper
```

Overrides the command used to launch child Pi processes. Package wrappers can set this to their own `pi`/agent binary so subagents inherit wrapper flags, environment setup, and bundled resources without relying on `PATH` ordering. Empty or whitespace-only values are ignored.

### `intercomBridge`

```json
{
  "intercomBridge": {
    "mode": "always",
    "instructionFile": "./intercom-bridge.md"
  }
}
```

Controls whether subagents receive runtime intercom coordination instructions and whether `intercom` and `contact_supervisor` are auto-added to their tool allowlist when needed.

Fields:

- `mode`: default `always`; use `fork-only` to inject only for forked runs, or `off` to disable the bridge.
- `instructionFile`: optional Markdown template replacing the default bridge instructions. `{orchestratorTarget}` is interpolated. Relative paths resolve from `~/.pi/agent/extensions/subagent/`.

Bridge activation requires a targetable current parent session id, which `pi-subagents` passes to children automatically. It no longer depends on an external `pi-intercom` installation or per-agent extension allowlists.

The default injected guidance tells children to use `contact_supervisor` with `reason: "need_decision"` when blocked or needing a decision, `reason: "progress_update"` only for meaningful blocked/progress updates, generic `intercom` as fallback plumbing, and avoid routine completion handoffs.

### `worktreeBaseDir`

```json
{ "worktreeBaseDir": "/Users/matt/code/.worktrees/pi-subagents" }
```

Sets the base directory for `worktree: true` runs. Relative paths resolve from the repository root, `~/...` expands to your home directory, and `PI_SUBAGENTS_WORKTREE_DIR` is used when config is unset. The default remains the system temp directory.

### `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

The hook runs once per created worktree. Paths must be absolute, `~/...`, or repo-relative; bare command names are rejected.

stdin is a JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`. stdout must be one JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` must be relative to the worktree root. They are removed before diff capture so helper files do not pollute patches. Tracked files are never excluded; marking a tracked path as synthetic fails setup. Default timeout is `30000` ms.

### `completionBatch`

```json
{
  "completionBatch": {
    "enabled": true,
    "debounceMs": 150,
    "maxWaitMs": 1000,
    "stragglerDebounceMs": 75,
    "stragglerMaxWaitMs": 400,
    "stragglerWindowMs": 2000
  }
}
```

Controls smart batching of async-completion notifications. When several background subagents finish within a short window, their successful completions are held briefly and delivered as a single grouped message instead of separate notifications. A hard `maxWaitMs` cap (measured from the first completion in a group) guarantees nothing is held indefinitely, and late-finishing siblings that arrive within `stragglerWindowMs` of a group emit join a shorter straggler group governed by `stragglerDebounceMs` and `stragglerMaxWaitMs`.

Failed and paused completions bypass batching and fire immediately, flushing any held successes first, so failure and needs-attention signals are never delayed. Set `enabled` to `false` to restore the original one-notification-per-completion behavior. Changes apply on the next session start.

## Files, logs, and observability

Each chain run creates a user-scoped temp directory like:

```text
<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/
```

It may contain files such as `context.md`, `plan.md`, `progress.md`, and `parallel-{stepIndex}/.../output.md`. Directories older than 24 hours are cleaned up on extension startup.

Debug artifacts live under `{sessionDir}/subagent-artifacts/`, `.pi-subagents/artifacts/` for project-scoped runs, or a user-scoped temp artifact directory. Single-run relative `output` files are saved under `{artifactsDir}/outputs/{runId}/` unless `singleRunOutputBaseDir` is configured. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, and fallback attempt outcomes.

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts with `--session <branched-session-file>` produced from the parent’s current leaf. That is a real session fork, not an injected summary.

Async completions notify only the originating session. The result watcher emits only the internal `subagent:async-complete` event for the exact owning session, threading normalized child status/summary plus safe artifact/session references into the native notification path. The extension consumes that event to render one concise completion notice and wake one parent turn. Model-visible completion text has bounded child details, summaries, nested depth/entries, and final message size with explicit omission markers; the structured internal completion event remains intact for status, wait, and other consumers. Successful sibling completions are held briefly and delivered as a single grouped message when they finish within a short window (see `completionBatch`); failed and paused completions always fire immediately.

Async runs write:

```text
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
```

`status.json` powers the widget and `subagent({ action: "status" })` output. `events.jsonl` contains wrapper events plus child Pi JSON events annotated with run and step metadata, including `subagent.steer.requested` when live async steering is queued. Nested fanout status is stored as compact sidecar event/registry metadata and merged into parent status views and result/intercom payloads; full recursive status snapshots are not embedded in parent result files. `output-<n>.log` is a live human-readable tail. Fallback information is persisted so background runs are debuggable after completion.

## Acceptance Gates

Every run resolves an effective acceptance policy. Callers may omit `acceptance` for the inferred default, or set it on single runs, top-level parallel task items, chain steps, static parallel tasks, and dynamic fanout templates.

```ts
{
  agent: "worker",
  task: "Implement the fix",
  acceptance: {
    level: "verified",
    criteria: ["Patch the bug without widening scope"],
    evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
    verify: [{ id: "focused", command: "npm test", timeoutMs: 120000 }]
  }
}
```

Accepted levels are `auto`, `none`, `attested`, `checked`, `verified`, and `reviewed`. `acceptance: "auto"` is the default. Read-only reviewer/scout tasks infer lightweight attestation, normal writer tasks infer checked evidence, and async/risky/dynamic writer contexts infer a reviewed gate. To disable gates, prefer `{ level: "none", reason: "..." }`.

Acceptance provenance is stored separately from child prose:

- `claimed`: child finished but did not provide structured evidence.
- `attested`: child returned a structured acceptance report.
- `checked`: runtime structural checks passed, such as required evidence and no staged files.
- `verified`: configured runtime verification commands passed. Child-reported command success does not count.
- `reviewed`: an independent reviewer result is present.
- `rejected`: attestation, structural checks, verification, or review failed.

For `attested` or stricter levels, the child prompt includes a standardized acceptance section and asks for a fenced `acceptance-report` JSON block. Explicit failed gates fail the run. Inferred gates are persisted for observability without breaking older calls that omit `acceptance`.

## Live progress

Foreground runs show compact live progress for single, chain, and parallel modes: current tool, recent output, token counts, aggregate cost, duration, activity freshness, current-tool duration, and chain graph metadata when available.

Press Pi's configured expand key (`Ctrl+O` by default) to expand the full streaming view with complete output per step.

Sequential chains show a flow line like `done scout → running planner`. Chains with parallel steps show per-step cards instead. Chain status uses `label` and `phase` metadata when present, while falling back to agent names for older chains.

## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ agent: "scout", task: "...", share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.

## Recursion guard

Subagents can call `subagent` only when their resolved builtin tools explicitly include `subagent`. That is meant for delegated fanout agents, not ordinary worker/reviewer children. A depth guard prevents unbounded nesting.

By default, nesting is limited to two levels: main session → subagent → sub-subagent. Deeper calls are blocked with guidance to complete the current task directly. Nested runs appear in the parent status widget and `status` output as a tree, and `status`, `interrupt`, and `resume` can target a nested run by its id.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=3
export PI_SUBAGENT_MAX_DEPTH=1
export PI_SUBAGENT_MAX_DEPTH=0
```

`PI_SUBAGENT_DEPTH` is internal and propagated automatically. Do not set it manually.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`

The async result watcher emits `subagent:async-complete` for completion ownership and no longer sends async completion payloads over `subagent:result-intercom`; `src/extension/index.ts` registers the notification handler that consumes the native completion event. Control/attention events are surfaced as visible parent notices and persisted for async runs. Native supervisor requests are delivered only to the exact parent session that spawned the child.

## Prompt-template integration (runtime-only, not exposed to TLH model calls)

`pi-subagents` works standalone through natural language, the `subagent` tool, and the slash commands listed near the top of this README. If you use [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model), you can also wrap subagent delegation in your own reusable prompt templates.

Create a prompt in `.pi/prompts/` or `~/.pi/agent/prompts/`:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

Then run it through the native adapter:

For more reusable workflows on top of subagents, install `pi-prompt-template-model` separately and copy the examples you want into `~/.pi/agent/prompts/`. This TLH fork does not register the removed prompt-workflow slash shortcuts, so keep prompt-template usage to the direct adapter surface.

The adapter delegates to the named subagent, applies `model`, `skill`, `cwd`, `worktree`, and fork/fresh context metadata, and supports runtime overrides such as `--subagent reviewer`, `--fork`, `--fresh`, `--worktree`, and `--bg`. Compare-style prompt features from the separate prompt-template package remain outside the built-in adapter.

## Runtime files

The main runtime files are:

| File | Purpose |
|------|---------|
| `src/extension/index.ts` | Extension registration, tool registration, message/render wiring. |
| `src/agents/agents.ts` | Agent and chain discovery, frontmatter parsing. |
| `src/runs/foreground/subagent-executor.ts` | Main execution routing for single, parallel, chain, management, status, interrupt, and doctor actions. |
| `src/runs/foreground/execution.ts` | Core foreground `runSync` handling. |
| `src/runs/background/subagent-runner.ts` | Detached async runner. |
| `src/runs/background/async-execution.ts` | Background launch support. |
| `src/runs/background/async-status.ts` | Status discovery and formatting for async runs. |
| `src/runs/foreground/chain-execution.ts` / `src/agents/chain-serializer.ts` | Chain orchestration and `.chain.md` parsing. |
| `src/shared/settings.ts` | Chain behavior, instructions, and config helpers. |
| `src/runs/shared/worktree.ts` | Git worktree isolation. |
| `src/intercom/intercom-bridge.ts` | Runtime intercom bridge instructions and diagnostics. |
| `src/extension/schemas.ts` / `src/shared/types.ts` | Tool schemas, shared types, and event constants. |
| `test/unit/` / `test/integration/` / `test/e2e/` | Unit, loader-based integration, and real-session E2E tests. |
