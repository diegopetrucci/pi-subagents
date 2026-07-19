import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
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

		try {
			writeResult("01-completed.json", {
				id: "completed",
				agent: "single-worker",
				success: true,
				state: "complete",
				summary: "single done",
				results: [{ agent: "single-worker", output: "single done", success: true }],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("02-mixed-failed.json", {
				id: "mixed-failed",
				agent: "parallel:a+b",
				success: true,
				state: "complete",
				summary: "mixed outer summary",
				results: [
					{ agent: "a", output: "a done", success: true, artifactPaths: { outputPath: "/tmp/a-output.md" } },
					{ agent: "b", output: "b output", error: "b failed", success: false },
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
					{ agent: "a", output: "a done", success: true },
					{ agent: "b", output: "Paused after interrupt.", success: false },
				],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("04-foreign.json", {
				id: "foreign",
				agent: "foreign-worker",
				success: true,
				summary: "must not deliver",
				sessionId: "session-other",
			});

			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 3);
		} finally {
			watcher.stopResultWatcher();
		}

		assert.equal(sent.length, 3);
		assert.deepEqual(sent.map((entry) => entry.options), [
			{ triggerTurn: true },
			{ triggerTurn: true },
			{ triggerTurn: true },
		]);
		assert.equal(sent.every((entry) => entry.message.customType === "subagent-notify" && entry.message.display === true), true);
		const contents = sent.map((entry) => entry.message.content ?? "");
		assert.equal(contents.some((content) => /^Background task completed: \*\*single-worker\*\*/.test(content)), true);
		assert.equal(contents.some((content) => /^Background task failed: \*\*parallel:a\+b\*\*/.test(content) && /Children: 1 completed, 1 failed/.test(content)), true);
		assert.equal(contents.some((content) => /^Background task paused: \*\*chain:a\+b\*\*/.test(content)), true);
		assert.equal(contents.some((content) => content.includes("must not deliver")), false);
		assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 3);
		assert.equal(listeners.has("subagent:result-intercom"), false);
		assert.equal(emitted.some((entry) => entry.event === "subagent:result-intercom"), false);
		assert.equal(fs.existsSync(path.join(resultsDir, "04-foreign.json")), true);
		fs.rmSync(resultsDir, { recursive: true, force: true });
	});
});
