import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify, {
	MAX_COMPLETION_MESSAGE_CHARS,
	buildCompletionDetails,
	formatGroupedCompletion,
	formatSingleCompletion,
	type RegisterSubagentNotifyOptions,
	type SubagentNotifyDetails,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

function createPi(currentSessionId = "session-1", registerOptions: RegisterSubagentNotifyOptions = {}) {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};

	// Formatting-focused tests run with batching disabled so single completions
	// emit synchronously. Batching behavior is covered by the dedicated suite below.
	registerSubagentNotify(pi as never, { currentSessionId }, { batchConfig: { enabled: false }, ...registerOptions });

	return { events, sent };
}

function createBatchingPi(clock: ReturnType<typeof createFakeClock>, currentSessionId = "session-a") {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const state = { currentSessionId };
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	registerSubagentNotify(pi as never, state, {
		batchConfig: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 },
		timers: clock.api,
		now: clock.now,
	});
	return { events, sent, state };
}

interface FakeJob {
	id: number;
	fireAt: number;
	handler: () => void;
}

function createFakeClock() {
	let now = 0;
	let nextId = 1;
	const jobs = new Map<number, FakeJob>();
	const api = {
		setTimeout(handler: () => void, delayMs: number): unknown {
			const id = nextId++;
			jobs.set(id, { id, fireAt: now + delayMs, handler });
			return id;
		},
		clearTimeout(handle: unknown): void {
			if (typeof handle === "number") jobs.delete(handle);
		},
	};
	return {
		api,
		now: () => now,
		advance(ms: number): void {
			now += ms;
			const due = [...jobs.values()].filter((job) => job.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
			for (const job of due) {
				if (!jobs.has(job.id)) continue;
				jobs.delete(job.id);
				job.handler();
			}
		},
	};
}

function completionResult(overrides: Record<string, unknown> = {}) {
	return {
		id: `notify-${Math.random().toString(36).slice(2)}`,
		agent: "worker",
		success: true,
		summary: "Done",
		exitCode: 0,
		timestamp: 123,
		sessionId: "session-a",
		...overrides,
	};
}

describe("registerSubagentNotify", () => {
	it("uses a fallback summary when a background completion is empty", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-empty-1",
			agent: "worker",
			success: true,
			summary: "",
			exitCode: 0,
			timestamp: 123,
			sessionId: "session-1",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\n(no output)",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("preserves non-empty completion summaries", () => {
		const { events, sent } = createPi();
		const summary = "  Done streaming\nAll clear  ";

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-summary-1",
			agent: "worker",
			success: true,
			summary,
			exitCode: 0,
			timestamp: 456,
			taskIndex: 1,
			totalTasks: 3,
			sessionId: "session-1",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: `Background task completed: **worker** (2/3)\n\n${summary}`,
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("preserves session paths in notification content", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-path-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 456,
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
		});

		assert.deepEqual(sent, [{
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl",
				display: true,
			},
			options: { triggerTurn: true },
		}]);
	});

	it("labels paused completions as paused even without an exit code", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-paused-1",
			agent: "worker",
			success: false,
			state: "paused",
			summary: "Paused after interrupt. Waiting for explicit next action.",
			timestamp: 789,
			sessionId: "session-1",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task paused: **worker**\n\nPaused after interrupt. Waiting for explicit next action.",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("formats normalized child results into one native completion notice", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-grouped-1",
			agent: "parallel:a+b",
			success: false,
			state: "failed",
			summary: "Combined summary",
			timestamp: 100,
			sessionId: "session-1",
			results: [
				{ agent: "a", status: "completed", summary: "Result from a", sessionPath: "/tmp/a-session.jsonl", artifactPath: "/tmp/a-output.md" },
				{ agent: "b", status: "failed", summary: "B failed\n\nOutput:\nResult from b", children: [{ agent: "nested-b", state: "failed" }] },
			],
		});

		assert.equal(sent.length, 1);
		const content = (sent[0]!.message as { content: string }).content;
		assert.match(content, /^Background task failed: \*\*parallel:a\+b\*\*/);
		assert.match(content, /Children: 1 completed, 1 failed/);
		assert.match(content, /1\. a — completed\nResult from a\nOutput artifact: \/tmp\/a-output\.md\nSession: \/tmp\/a-session\.jsonl/);
		assert.match(content, /2\. b — failed\nB failed\n\nOutput:\nResult from b\nNested subagents:\n   ↳ nested-b — failed/);
		assert.deepEqual(sent[0]!.options, { triggerTurn: true });
	});

	it("bounds oversized grouped completion content while retaining status and safe references", () => {
		const { events, sent } = createPi();
		const deepNested = [{
			agent: "nested-root",
			state: "complete",
			children: [{
				agent: "nested-level-2",
				state: "complete",
				children: [{ agent: "nested-too-deep", state: "complete" }],
			}],
		}, ...Array.from({ length: 10 }, (_, index) => ({ agent: `nested-sibling-${index}`, state: "complete" }))];
		const results = Array.from({ length: 10 }, (_, index) => ({
			agent: `worker-${index}`,
			status: index === 9 ? "failed" : "completed",
			summary: `${index}: ${"x".repeat(4_000)}`,
			...(index === 0 ? {
				artifactPath: "/safe/artifacts/worker-0.md",
				sessionPath: "/safe/sessions/worker-0.jsonl",
				intercomTarget: "stale-target-must-not-appear",
				children: deepNested,
			} : {}),
		}));

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-oversized-1",
			agent: "parallel:oversized",
			success: true,
			summary: "outer",
			timestamp: 100,
			sessionId: "session-1",
			intercomTarget: "stale-owner-target-must-not-appear",
			results,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]!.options, { triggerTurn: true });
		const content = (sent[0]!.message as { content: string }).content;
		assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);
		assert.match(content, /^Background task failed: \*\*parallel:oversized\*\*/);
		assert.match(content, /Children: 9 completed, 1 failed/);
		assert.match(content, /… \[2 child results omitted\]/);
		assert.match(content, /… \[summary truncated\]/);
		assert.match(content, /Output artifact: \/safe\/artifacts\/worker-0\.md/);
		assert.match(content, /Session: \/safe\/sessions\/worker-0\.jsonl/);
		assert.match(content, /… \[nested depth limit reached\]/);
		assert.match(content, /… \[additional nested entries omitted\]/);
		assert.match(content, /… \[completion message truncated\]$/);
		assert.doesNotMatch(content, /stale-target/);
	});

	it("ignores completions for other or missing session ids", () => {
		const { events, sent } = createPi("session-owner");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-other-session",
			agent: "worker",
			success: true,
			summary: "Other done",
			timestamp: 100,
			sessionId: "session-other",
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-sessionless",
			agent: "worker",
			success: true,
			summary: "Legacy cwd-scoped done",
			timestamp: 101,
			cwd: "/repo",
		});

		assert.deepEqual(sent, []);
	});

	it("emits failed completions immediately even while successes are held", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "ok-1", agent: "ok-1", summary: "ok-1 done" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "fail-1", agent: "fail-1", success: false, summary: "boom", exitCode: 1 }));

		// The failure must arrive immediately, and the held success must be
		// flushed ahead of it rather than waiting on the debounce timer.
		assert.equal(sent.length, 2);
		assert.match((sent[0]!.message as { content: string }).content, /Background task completed: \*\*ok-1\*\*/);
		assert.match((sent[1]!.message as { content: string }).content, /Background task failed: \*\*fail-1\*\*/);

		// No deferred emission should arrive later.
		clock.advance(1000);
		assert.equal(sent.length, 2);
	});

	it("treats an outer-success grouped result with a failed child as an immediate failure", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock);
		const groupedFailure = completionResult({
			id: "grouped-child-failure-1",
			agent: "parallel:a+b",
			success: true,
			summary: "Combined summary",
			results: [
				{ agent: "a", status: "completed", summary: "a done" },
				{ agent: "b", status: "failed", summary: "b failed" },
			],
		});

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "held-before-grouped-failure", agent: "held", summary: "held done" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, groupedFailure);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, groupedFailure);

		assert.equal(sent.length, 2);
		assert.match((sent[0]!.message as { content: string }).content, /^Background task completed: \*\*held\*\*/);
		const failureContent = (sent[1]!.message as { content: string }).content;
		assert.match(failureContent, /^Background task failed: \*\*parallel:a\+b\*\*/);
		assert.match(failureContent, /Children: 1 completed, 1 failed/);
		assert.deepEqual(sent.map((entry) => entry.options), [
			{ triggerTurn: true },
			{ triggerTurn: true },
		]);

		clock.advance(1000);
		assert.equal(sent.length, 2, "the grouped failed run must notify exactly once");
	});

	it("groups sibling successes into a single notification after the debounce window", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-2", agent: "beta", summary: "beta done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-3", agent: "gamma", summary: "gamma done", sessionId: "session-a" }));
		assert.equal(sent.length, 0);

		clock.advance(150);
		assert.equal(sent.length, 1);
		const content = (sent[0]!.message as { content: string }).content;
		assert.match(content, /^Background tasks completed \(3\): \*\*alpha\*\*, \*\*beta\*\*, \*\*gamma\*\*/);
		assert.match(content, /1\. alpha\nalpha done/);
		assert.match(content, /3\. gamma\ngamma done/);
		assert.deepEqual(sent[0]!.options, { triggerTurn: true });
	});

	it("drops a deferred success batch when its owning session is no longer current", () => {
		const clock = createFakeClock();
		const { events, sent, state } = createBatchingPi(clock, "session-a");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({
			id: "stale-owner-success",
			agent: "session-a-worker",
			summary: "session A done",
			sessionId: "session-a",
		}));
		assert.equal(sent.length, 0);

		state.currentSessionId = "session-b";
		clock.advance(150);

		assert.equal(sent.length, 0, "a stale owner batch must neither send nor trigger a turn in the new session");
	});

	it("ignores successes from other sessions instead of grouping them", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock, "session-a");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "s-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "s-2", agent: "beta", summary: "beta done", sessionId: "session-b" }));
		clock.advance(150);

		assert.equal(sent.length, 1);
		assert.match((sent[0]!.message as { content: string }).content, /^Background task completed: \*\*alpha\*\*/);
		assert.doesNotMatch((sent[0]!.message as { content: string }).content, /beta done/);
	});

	it("does not let another session failure flush held successes", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock, "session-a");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "held-a-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "fail-b-1", agent: "beta", success: false, summary: "boom", exitCode: 1, sessionId: "session-b" }));
		assert.equal(sent.length, 0);

		clock.advance(150);
		assert.equal(sent.length, 1);
		assert.match((sent[0]!.message as { content: string }).content, /^Background task completed: \*\*alpha\*\*/);
		assert.doesNotMatch((sent[0]!.message as { content: string }).content, /boom/);
	});
});

describe("completion formatting helpers", () => {
	it("formatSingleCompletion mirrors the in-handler single message shape", () => {
		const content = formatSingleCompletion({
			agent: "worker",
			status: "completed",
			taskInfo: " (2/3)",
			resultPreview: "Done",
			sessionLabel: "Session file",
			sessionValue: "/tmp/session.jsonl",
		});
		assert.equal(content, "Background task completed: **worker** (2/3)\n\nDone\n\nSession file: /tmp/session.jsonl");
	});

	it("formatGroupedCompletion lists each agent with its summary and session", () => {
		const content = formatGroupedCompletion([
			{ agent: "alpha", status: "completed", resultPreview: "alpha done" },
			{ agent: "beta", status: "completed", taskInfo: " (1/2)", resultPreview: "", sessionLabel: "Session", sessionValue: "https://share/abc" },
		]);
		assert.equal(
			content,
			"Background tasks completed (2): **alpha**, **beta** (1/2)\n\n"
			+ "1. alpha\nalpha done\n\n"
			+ "2. beta (1/2)\n(no output)\nSession: https://share/abc",
		);
	});

	it("buildCompletionDetails derives paused status from state and summary", () => {
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, state: "paused", summary: "Paused after interrupt.", timestamp: 1 }).status, "paused");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, summary: "boom", exitCode: 1, timestamp: 1 }).status, "failed");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: true, summary: "ok", exitCode: 0, timestamp: 1 }).status, "completed");
	});

	it("buildCompletionDetails prioritizes normalized grouped terminal statuses", () => {
		const base = { id: "grouped", agent: "parallel", success: true, summary: "outer", timestamp: 1 };
		assert.equal(buildCompletionDetails({ ...base, results: [
			{ agent: "a", status: "paused", summary: "paused" },
			{ agent: "b", status: "failed", summary: "failed" },
		] }).status, "failed");
		assert.equal(buildCompletionDetails({ ...base, results: [
			{ agent: "a", status: "completed", summary: "done" },
			{ agent: "b", status: "paused", summary: "paused" },
		] }).status, "paused");
		assert.equal(buildCompletionDetails({ ...base, results: [
			{ agent: "a", status: "completed", summary: "done" },
			{ agent: "b", status: "detached", summary: "detached" },
		] }).status, "completed");
		assert.equal(buildCompletionDetails({ ...base, results: [
			{ agent: "a", status: "detached", summary: "detached" },
		] }).status, "failed");
	});

	it("buildCompletionDetails falls back to the unknown agent label", () => {
		const details: SubagentNotifyDetails = buildCompletionDetails({ id: "x", agent: null, success: true, summary: "ok", timestamp: 1 });
		assert.equal(details.agent, "unknown");
		assert.equal(details.status, "completed");
	});
});
