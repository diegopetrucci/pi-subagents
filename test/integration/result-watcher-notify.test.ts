import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(sessionId: string): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for watcher-to-notify delivery");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("result watcher to native notify", () => {
	it("delivers terminal result types only to the exact owner without result intercom", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-notify-"));
		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const emitted: Array<{ event: string; data: unknown }> = [];
		const sent: Array<{ message: { customType?: string; content?: string; display?: boolean }; options: { triggerTurn?: boolean } }> = [];
		const events = {
			on(event: string, handler: (payload: unknown) => void) {
				const handlers = listeners.get(event) ?? new Set();
				handlers.add(handler);
				listeners.set(event, handlers);
				return () => handlers.delete(handler);
			},
			emit(event: string, data: unknown) {
				emitted.push({ event, data });
				for (const handler of listeners.get(event) ?? []) handler(data);
			},
		};
		const pi = {
			events,
			on(_event: string, _handler: (...args: unknown[]) => void) {},
			sendMessage(message: { customType?: string; content?: string; display?: boolean }, options: { triggerTurn?: boolean }) {
				sent.push({ message, options });
			},
		};
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		const writeResult = (name: string, data: Record<string, unknown>) => {
			fs.writeFileSync(path.join(resultsDir, name), JSON.stringify(data), "utf-8");
		};

		const singleSession = path.join(resultsDir, "single-session.jsonl");
		const childSession = path.join(resultsDir, "child-9-session.jsonl");
		const pausedChildSession = path.join(resultsDir, "paused-child-session.jsonl");
		fs.writeFileSync(singleSession, "session\n", "utf-8");
		fs.writeFileSync(childSession, "session\n", "utf-8");
		fs.writeFileSync(pausedChildSession, "session\n", "utf-8");
		try {
			writeResult("01-completed.json", {
				id: "completed-event",
				runId: "completed-run",
				agent: "single-worker",
				success: true,
				state: "complete",
				summary: "single done",
				sessionFile: singleSession,
				shareUrl: "https://share/completed-run",
				results: [{ agent: "single-worker", output: "single done", success: true }],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("02-mixed-failed.json", {
				id: "mixed-failed-event",
				runId: "mixed-failed-run",
				agent: "parallel:a+b",
				success: true,
				state: "complete",
				summary: "mixed outer summary",
				results: [
					...Array.from({ length: 8 }, (_, index) => ({ agent: `ok-${index}`, output: `ok-${index} done`, success: true })),
					{ agent: "late-failure", output: "late failure output", error: "late failure", success: false, sessionFile: childSession },
				],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("03-paused.json", {
				id: "paused",
				agent: "chain:a+b",
				success: false,
				state: "paused",
				summary: "Paused after interrupt.",
				results: [
					{ agent: "a", output: "a done", success: true, exitCode: 0 },
					{ agent: "b", output: "b done", success: true, exitCode: 0 },
					{ agent: "c", output: "c done", success: true, exitCode: 0 },
					{ agent: "d", output: "d done", success: true, exitCode: 0 },
					{ agent: "e", output: "Paused after interrupt.", success: false, exitCode: 0, interrupted: true, sessionFile: pausedChildSession },
				],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("04-missing-session.json", {
				id: "missing-session-event",
				runId: "missing-session-run",
				agent: "missing-session-worker",
				success: true,
				summary: "missing session done",
				sessionFile: path.join(resultsDir, "missing-session.jsonl"),
				sessionId: "session-owner",
			});
			writeResult("05-foreign.json", {
				id: "foreign",
				agent: "foreign-worker",
				success: true,
				summary: "must not deliver",
				sessionId: "session-other",
			});

			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 4);
		} finally {
			watcher.stopResultWatcher();
		}

		assert.equal(sent.length, 4);
		assert.deepEqual(sent.map((entry) => entry.options), [
			{ triggerTurn: true },
			{ triggerTurn: true },
			{ triggerTurn: true },
			{ triggerTurn: true },
		]);
		assert.equal(sent.every((entry) => entry.message.customType === "subagent-notify" && entry.message.display === true), true);
		const contents = sent.map((entry) => entry.message.content ?? "");
		assert.equal(contents.some((content) => /^Background task completed: \*\*single-worker\*\*/.test(content)
			&& /Async id: completed-event/.test(content)
			&& /Revive: subagent\({ action: "resume", id: "completed-event", message: "\.\.\." }\)/.test(content)
			&& /Session: https:\/\/share\/completed-run$/.test(content)), true);
		assert.equal(contents.some((content) => /^Background task failed: \*\*parallel:a\+b\*\*/.test(content) && /Children: 8 completed, 1 failed/.test(content) && /9\/9\. late-failure — failed/.test(content) && /Revive child: subagent\({ action: "resume", id: "mixed-failed-event", index: 8, message: "\.\.\." }\)/.test(content)), true);
		assert.equal(contents.some((content) => /^Background task paused: \*\*chain:a\+b\*\*/.test(content) && /Async id: paused/.test(content) && /Revive child: subagent\({ action: "resume", id: "paused", index: 4, message: "\.\.\." }\)/.test(content)), true);
		assert.equal(contents.some((content) => /^Background task completed: \*\*missing-session-worker\*\*/.test(content) && /Async id: missing-session-event/.test(content) && !/subagent\({ action: "resume"/.test(content)), true);
		assert.equal(contents.some((content) => content.includes("must not deliver")), false);
		assert.equal(contents.some((content) => content.includes("stale-owner-target")), false);
		assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 4);
		assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"
			&& typeof entry.data === "object"
			&& entry.data !== null
			&& "id" in entry.data
			&& "runId" in entry.data
			&& (entry.data as { id?: unknown }).id === "completed-event"
			&& (entry.data as { runId?: unknown }).runId === "completed-run"
			&& (entry.data as { shareUrl?: unknown }).shareUrl === "https://share/completed-run"), true);
		assert.equal(listeners.has("subagent:result-intercom"), false);
		assert.equal(emitted.some((entry) => entry.event === "subagent:result-intercom"), false);
		assert.equal(fs.existsSync(path.join(resultsDir, "05-foreign.json")), true);
		fs.rmSync(resultsDir, { recursive: true, force: true });
	});

	it("delivers an exact all-completed-child stale repair immediately while success remains batchable", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stale-notify-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "stale-completed-children");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "stale-completed-children",
			sessionId: "session-owner",
			mode: "parallel",
			state: "running",
			pid: 424242,
			startedAt: 1_000,
			lastUpdate: 1_500,
			steps: [
				{ agent: "alpha", status: "complete", startedAt: 1_000, endedAt: 1_200, exitCode: 0 },
				{ agent: "beta", status: "complete", startedAt: 1_000, endedAt: 1_300, exitCode: 0 },
			],
		}, null, 2), "utf-8");

		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const sent: Array<{ message: { content?: string }; options: { triggerTurn?: boolean } }> = [];
		const pi = {
			events: {
				on(event: string, handler: (payload: unknown) => void) {
					const handlers = listeners.get(event) ?? new Set();
					handlers.add(handler);
					listeners.set(event, handlers);
					return () => handlers.delete(handler);
				},
				emit(event: string, data: unknown) {
					for (const handler of listeners.get(event) ?? []) handler(data);
				},
			},
			on(_event: string, _handler: (...args: unknown[]) => void) {},
			sendMessage(message: { content?: string }, options: { triggerTurn?: boolean }) {
				sent.push({ message, options });
			},
		};
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, {
			batchConfig: { enabled: true, debounceMs: 1_000, maxWaitMs: 2_000, stragglerDebounceMs: 1_000, stragglerMaxWaitMs: 2_000, stragglerWindowMs: 2_000 },
		});
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);

		try {
			const successPath = path.join(resultsDir, "01-batched-success.json");
			fs.writeFileSync(successPath, JSON.stringify({
				id: "batched-success",
				agent: "ordinary-worker",
				success: true,
				state: "complete",
				summary: "ordinary success",
				sessionId: "session-owner",
			}), "utf-8");
			watcher.primeExistingResults();
			await waitUntil(() => !fs.existsSync(successPath));
			assert.equal(sent.length, 0, "the successful completion should still be held by batching");

			const repaired = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => {
					const error = new Error("missing") as NodeJS.ErrnoException;
					error.code = "ESRCH";
					throw error;
				},
				now: () => 2_000,
			});
			assert.equal(repaired.repaired, true);
			const repairedPath = path.join(resultsDir, "stale-completed-children.json");
			const repairedResult = JSON.parse(fs.readFileSync(repairedPath, "utf-8"));
			assert.deepEqual(repairedResult.results.map((child: { success?: boolean }) => child.success), [true, true]);
			assert.equal(repairedResult.success, false);
			assert.equal(repairedResult.state, "failed");
			assert.equal(repairedResult.summary, "Async runner process 424242 exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.");

			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 2);
			assert.match(sent[0]!.message.content ?? "", /^Background task completed: \*\*ordinary-worker\*\*/);
			const failure = sent[1]!.message.content ?? "";
			assert.match(failure, /^Background task failed: \*\*alpha\*\*/);
			assert.ok(failure.indexOf(repairedResult.summary) < failure.indexOf("Children: 2 completed"));
			assert.deepEqual(sent.map((entry) => entry.options), [{ triggerTurn: true }, { triggerTurn: true }]);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
