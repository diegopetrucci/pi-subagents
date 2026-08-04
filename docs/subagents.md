# TLH subagents guide

This guide is the practical reference for supported subagent behavior in this
TLH fork. A **parent** session delegates a focused task to one or more
**children**. Children have their own session, tools, transcript, and result;
the parent remains responsible for orchestration, decisions, and final edits.

For exhaustive API, configuration, frontmatter, artifact, and compatibility
details, see the [README.md reference](../README.md). This guide intentionally
focuses on the supported TLH contract and useful day-to-day choices.

## Choose the run shape

There are two independent choices:

- **Single or parallel** answers “how many children are in this delegation?”
- **Foreground or async** answers “does the parent wait for the run?”

A run can therefore be, for example, a foreground single run, an async single
run, a foreground parallel run, or an async parallel run.

| Decision | Choose this when | What the parent gets |
| --- | --- | --- |
| Single | One focused question or edit. | One child result. |
| Parallel | Independent questions can run together. | Grouped results. |
| Foreground | Parent needs the result now. | Stream + sync result. |
| Async | Parent can continue. | Run id + notification. |
| Fresh | Clean task context. | No parent branch. |
| Fork | Need parent state. | Branch from parent leaf. |

Use the following quick rule:

1. Pick **single** for a decision, implementation, or review with one owner.
2. Pick **parallel** for independent read-only audits or independent questions.
3. Pick **foreground** when the next parent step depends on the result.
4. Pick **async** when the parent has useful independent work, and use
   `wait` rather than sleeping or polling when it must block.
5. Pick **fresh** for an independent reviewer; pick **fork** when inherited
   discussion or files are necessary.

## Parent and child model

The parent launches a child session with an agent name and task. The child
executes that task with the tools and context allowed by its agent definition,
then reports a result. The child is not a second parent: ordinary children do
not get the `subagent` tool and must not start their own orchestration.

A child may receive the child-safe `subagent` tool only when the parent
explicitly assigned fan-out to an agent whose tools include `subagent`. Nested
fan-out is still bounded by the inherited `maxSubagentDepth` guard. A child
should escalate an unapproved decision to the parent rather than silently
inventing a workflow.

Keep the parent as the decision authority. In particular, a child result is an
input to the parent’s review; it is not permission to widen the task, rewrite
unrelated files, or launch follow-up workers unless the parent asked for that.

## Context: fresh versus fork

`context: "fresh"` starts a clean child session. Give the task all facts and
paths the child needs. This is usually the safest context for an independent
scout or reviewer because it reduces accidental dependence on parent
conversation.

`context: "fork"` branches the child from the parent’s current persisted leaf.
It is useful when the parent has already established a plan, constraints, or
conversation-specific facts. Fork filtering removes parent-only orchestration
history while preserving ordinary useful context. Forking fails if the parent
session is not persisted, the current leaf is unavailable, or the branch
cannot be created; it does not silently fall back to fresh.

An explicit context applies to every child in that invocation. If context is
omitted, each agent’s `defaultContext` is used; an agent without a default
runs fresh. In this fork, the packaged `planner`, `worker`, and `oracle`
default to fork, but pass the context explicitly when that distinction matters.

## Select an agent

First inspect the live set of executable agents:

```text
subagent({ action: "list" })
```

Use the returned name exactly. Useful builtin roles include:

| Agent | Best fit |
| --- | --- |
| `scout` | Fast codebase recon and a map of relevant files. |
| `researcher` | Web or documentation research when web access is installed. |
| `planner` | A concrete plan without editing the checkout. |
| `worker` | Approved implementation work; normally the one writer. |
| `reviewer` | Review, validation, and small fixes when explicitly assigned. |
| `context-builder` | A stronger context and handoff package before planning. |
| `oracle` | A second opinion that challenges a direction without editing. |
| `delegate` | A general child close to the parent’s delegation style. |

Agent discovery includes builtin, package, user, and project definitions. A
higher-precedence user or project definition can override a builtin; project
names win collisions. Use `list`, `get`, and `models` to inspect what is
actually loaded rather than assuming that a file or model is available.

```text
subagent({ action: "get", agent: "reviewer" })
subagent({ action: "models", agent: "reviewer" })
```

A per-run `model` can override the agent’s primary model. `fallbackModels` can
provide ordered alternatives for provider, quota, authentication, timeout, or
availability failures. Ordinary task failures do not trigger model fallback.

## Launching work

Execution omits `action`. Use one of these two shapes, never both:

```ts
// One child, foreground by default.
subagent({
  agent: "scout",
  task: "Map the authentication flow and list relevant files.",
  context: "fresh",
})
```

```ts
// Independent children, in parallel, detached from the parent.
subagent({
  tasks: [
    { agent: "scout", task: "Audit the API boundary." },
    { agent: "reviewer", task: "Check the existing tests for gaps." },
  ],
  concurrency: 2,
  async: true,
})
```

For a single child, `task` may be omitted only when the selected agent is
self-contained. Parallel task items support their own `agent`, `task`,
`count`, `output`, `outputMode`, `reads`, `progress`, and `model` fields.
Keep parallel tasks independent unless they only read a stable handoff.

## Lifecycle, status, and transcripts

### Foreground lifecycle

A foreground run normally streams child progress while the parent tool call
remains active, then returns the completed result synchronously. The expanded
result shows live detail while it runs. A blocking `contact_supervisor` request
can instead durably pause a foreground run while it awaits parent guidance; no
child process runs while it is paused. A paused foreground run remains
addressable by run id: resume it unchanged or with guidance, or interrupt it.
Foreground children are **not live-steerable**: `steer` is not a way to send
guidance to an active foreground child.

### Async lifecycle

An async run starts in the background and returns a run id. The child can keep
working after the parent turn continues. Status normally moves through queued
or running to complete, failed, paused, or cancelled; a paused run has no
child process running while it awaits a durable continuation.

Inspect all active work or one run:

```text
subagent({ action: "status" })
subagent({ action: "status", id: "run-123" })
```

For a read-only runtime diagnosis, use:

```text
subagent({ action: "doctor" })
```

Status identifies the mode, state, progress, child steps, timestamps, output,
session, and artifact paths. A prefix is accepted when it resolves to one run;
use a longer id if it is ambiguous. `/subagents-fleet` shows the active fleet
and supplies transcript-oriented commands. A known async run also has a
transcript/log path in its status and artifacts; use that path when you need
the complete conversation rather than the bounded notification preview.

Async lifecycle artifacts are machine-readable and should be preferred over
scraping terminal text:

```text
<asyncDir>/status.json
<asyncDir>/events.jsonl
<asyncDir>/output-<index>.log
<asyncDir>/subagent-log-<runId>.md
```

`status.json` powers status and the widget. `events.jsonl` records lifecycle,
step, control, and child events. The retained session file is the durable
transcript used for inspection and later continuation. Full result details,
artifacts, and session references remain available even when a notification or
foreground card is shortened.

### Waiting and notifications

Use `wait` only when the parent has no useful work left in the current turn or
must keep a non-interactive run alive until children finish:

```text
wait({ id: "run-123", timeoutMs: 600000 })
wait({ all: true })
```

- `wait({ id })` waits for one run.
- `wait({ all: true })` waits for all runs active when the wait begins.
- `wait({})` returns on the first completion or attention event.
- `wait({ timeoutMs })` limits how long the parent waits; it does **not** stop
  the child. The run remains detached and can be checked again.
- A run needing attention also wakes `wait`, so a blocked child does not hold
  the parent indefinitely.

Async completion notifications are delivered only to the owning parent
session. Successful completions may be briefly grouped; failed and paused
results are surfaced promptly. If a notification is missing, inspect status,
the async directory, or the session instead of starting duplicate work.

## Control and supervisor coordination

The supported control actions are `status`, `interrupt`, `resume`, and `steer`.
They target a run id; pass `index` to choose one child in a multi-child run.

### `steer`: live async guidance

`steer` is the native guidance channel for a **live, owned, compatible async
child**. It queues **best-effort guidance** in that child’s inbox without
treating the message as a pause or a terminal revival. Delivery can be rejected
for a non-running or terminal target, a target owned by another parent, or an
otherwise incompatible child:

```text
subagent({
  action: "steer",
  id: "run-123",
  message: "Keep the scope to the parser and report before editing.",
})
```

Do not claim that this controls foreground work. Foreground children are not
live-steerable. A steer request is also not a substitute for a supervisor
decision or a durable resume.

### `resume`: continue or revive

`resume` has three deliberately different meanings:

1. **Durably paused awaiting a supervisor:** omit `message` to continue
   unchanged, or provide a nonempty message to continue with guidance. No child
   process runs while paused.
2. **Live async child:** provide a nonempty message to queue a follow-up in its
   native inbox. This is a follow-up, not a pause or process restart.
3. **Terminal async child:** provide a nonempty message to start a new async
   child process from the saved session. For parallel runs, pass `index` to
   select the child.

```text
subagent({ action: "resume", id: "run-123" })
subagent({
  action: "resume",
  id: "run-123",
  message: "Follow up on the failing test and report the smallest fix.",
})
```

A live or terminal resume requires a nonempty message. Resuming a terminal
child revives from its saved session; it does not restart the old operating
system process.

### `interrupt`: stop or cancel

`interrupt` requests a soft stop for running work. It can also cancel a
durably paused child before continuation starts:

```text
subagent({ action: "interrupt", id: "run-123" })
```

Inspect status after an interrupt to confirm whether cleanup completed. Do not
confuse a `wait` timeout with an interrupt: waiting out only stops the parent
from waiting.

### `contact_supervisor`: child to parent

A child uses the native supervisor tool when it needs the parent to decide
rather than guess:

```text
contact_supervisor({
  reason: "need_decision",
  message: "The two candidate APIs conflict. Which contract is approved?",
})
```

- `need_decision` and `interview_request` are blocking. The child pauses
  durably, no child process keeps running, and the parent must resume or cancel
  it explicitly.
- `progress_update` is non-blocking and should be reserved for a meaningful
  discovery that changes the plan.
- Routine “done” handoffs are not needed; the normal result and notification
  path handles completion.

The parent checks status, then uses guided or unchanged `resume`, or
`interrupt`. Requests belong to the exact parent session that launched the
child; another session in the same checkout will not receive them.

## Outputs, artifacts, and execution ceilings

### Output ownership

Output behavior is explicit and authoritative:

- `output: "reports/scout.md"` saves the child’s output to that path.
- `output: false` disables the agent’s default output file.
- A per-run or per-task `output` override wins over the agent frontmatter
  default. Do not put a competing path in the task and expect it to win.
- `outputMode: "inline"` (the default) returns the saved output inline.
- `outputMode: "file-only"` returns a compact file reference and requires an
  output path. Failed runs and output-save errors still include debugging text.
- Parallel children must use distinct output paths; collisions are rejected.

Relative output paths resolve under the configured run output base; by default,
that is the owning session’s `subagent-artifacts/outputs/{runId}/` (or the
user-scoped temporary artifact root when no parent session is available).
Absolute output paths are used as written and therefore land at the absolute
location they name. The returned path is the authority—read it when the parent
needs the full artifact instead of relying on a truncated result card.

### Debug artifacts and sessions

Artifacts are enabled by default unless `artifacts: false` is requested. The
owning parent session stores diagnostic artifacts under its
`subagent-artifacts/` directory when available. Async runs additionally expose
an `asyncDir` containing status, events, live output logs, and a Markdown
subagent log. Child session files are retained for transcript inspection and
fork/resume behavior.

Keep generated outputs and logs out of the source tree unless the task
explicitly requests a repository artifact. If an output is meant to be a
review handoff, use a unique path and tell the parent exactly where it lives.

### Timeouts and ceilings

`timeoutMs` is a destructive run deadline for foreground and async execution:
when it expires, the child is cancelled. It is not a soft limit on how long
`wait` may block.

An agent’s `maxExecutionTimeMs` is a hard ceiling on its cumulative active
execution lineage. The effective limit is the stricter of the caller timeout
and the agent ceiling. A larger caller timeout cannot loosen the ceiling, and
wall time while a child is durably paused does not count. Resume segments share
the same active-runtime accounting.

Other guards remain intentional:

- Top-level parallel runs default to at most 8 tasks and concurrency 4; config
  or the per-call `concurrency` can tighten or adjust these within the supported
  surface.
- The global simultaneous-task cap defaults to 20.
- `maxSubagentDepth` bounds nested fan-out, and a child cannot relax an
  inherited stricter depth.
- These concurrency and depth guards remain in force. The retired cumulative
  spawn quota is **not** enforced; `maxSubagentSpawnsPerSession` and
  `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` are ignored.

If a child reaches a depth or concurrency guard, reduce fan-out or have the
parent perform the next step directly. Do not work around a guard by silently
creating a different workflow.

## Safe one-writer orchestration

Parallel execution is safe only when the tasks are independent. The simplest
rule is **one writer per checkout and working directory**:

- Let one `worker` own implementation edits.
- Run `scout`, `oracle`, and `reviewer` in fresh, read-only mode when possible.
- Give parallel children separate output files and non-overlapping write scope.
- Have the parent reconcile review findings and apply edits in one sequence.
- Do not launch two workers that may edit the same file, generate the same
  artifact, or update the same progress file.
- Treat child summaries as proposals until the parent verifies changed files,
  tests, and residual risks.

If multiple independent implementations are genuinely required, isolate their
working state through an explicitly supported runtime setup and review each
result before merging. Do not assume that ordinary parallel tasks serialize
writes for you.

## Practical orchestration recipes

### Plan, implement, review

Use one writer and fresh reviewers:

```text
1. Ask planner for a plan; it must not edit.
2. Ask worker to implement only the approved plan.
3. Run fresh reviewer and scout children in parallel against the diff.
4. Have the parent apply only justified fixes.
5. Run the narrowest validation again and report changed files and risks.
```

A compact request for the first step is:

```text
Use planner to turn the approved task into a concrete plan. Do not edit files.
```

### Parallel read-only audit

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Map the data flow; do not edit." },
    { agent: "reviewer", task: "Check edge cases and tests; do not edit." },
  ],
  context: "fresh",
})
```

Use foreground when the parent needs both reports immediately. Add `async:
true` when the parent can continue independently, then call `wait({ all:
true })` when it must collect both.

### Background work with attention handling

```text
1. Launch one bounded worker with async: true and a clear output path.
2. Continue independent parent work.
3. Call wait({ id: "..." }) when the result is needed.
4. If wait reports attention, inspect status.
5. Steer a live async child, resume a paused child, or interrupt it.
6. Read the saved output/session before deciding the next step.
```

### Decision loop

```text
1. Ask oracle for a diagnosis and a recommended direction.
2. Approve one direction in the parent session.
3. Ask worker to implement exactly that direction.
4. If worker encounters an unapproved choice, let it use contact_supervisor.
5. Resume with the parent’s answer or cancel; do not let the child guess.
```

## Supported TLH boundaries

### Supported

- Single-agent and top-level parallel delegation through `subagent`.
- Foreground and async/background execution.
- Explicit `fresh` and `fork` context selection.
- Agent discovery and read-only inspection through `list`, `get`, and
  `models`.
- Async lifecycle inspection and control through `status`, `wait`, `steer`,
  `resume`, and `interrupt`.
- Native child-to-parent `contact_supervisor` coordination.
- Narrow diagnostics: `/subagents-doctor`, `/subagents-fleet`, and
  `/subagent-cost`.
- Authoritative output overrides, saved sessions, transcripts, and lifecycle
  artifacts.

### Unsupported or intentionally removed

- Broad workflow slash commands, slash-command chains, and scheduling.
- Saved-chain discovery, creation, editing, execution, clarify UI,
  append-step follow-ups, and root-attachment follow-ups.
- Treating historical `.chain.md` or `.chain.json` files as launchable TLH
  workflows. Existing user files are left untouched.
- Live steering of foreground children.
- The retired cumulative spawn-quota settings; they are ignored rather than
  used as a hidden limit.

`pi-intercom` is optional compatibility plumbing, not a prerequisite for the
native supervisor channel. For exact schemas, configuration, historical
compatibility, and runtime details, use the [README.md reference](../README.md).

## Troubleshooting checklist

| Symptom | First action |
| --- | --- |
| Agent missing or disabled | Run `list`; use an executable name. |
| Foreground pause | `contact_supervisor`: resume/interrupt by id; no steer. |
| Async notification missing | Check owner, status, and artifacts. |
| Status id is ambiguous | Use a longer id or child `index`. |
| Run needs attention | Inspect status; steer, resume, or interrupt. |
| Supervisor request is stuck | Resume with the answer or cancel. |
| Fork fails | Persist the parent, or choose fresh. |
| Output missing or collides | Use a unique path and verify settings. |
| Run timed out | Check `timeoutMs` and `maxExecutionTimeMs`. |
| Fan-out is blocked | Reduce tasks, concurrency, or depth. |
| Coordination is misconfigured | Run `/subagents-doctor` in owner session. |

When reporting a run, include the run id, changed files (if any), output or
transcript paths, checks run, and residual risks. That makes a bounded result
useful without copying every internal status field into the conversation.
