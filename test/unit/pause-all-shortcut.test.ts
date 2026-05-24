import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { handlePauseAllShortcut } from "../../src/extension/pause-all-shortcut.ts";
import { ASYNC_DIR, type SubagentState } from "../../src/shared/types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const mutableProcess = process as typeof process & { kill: typeof process.kill };
const originalKill = process.kill;
const cleanupPaths = new Set<string>();

afterEach(() => {
	mutableProcess.kill = originalKill;
	for (const target of cleanupPaths) {
		fs.rmSync(target, { recursive: true, force: true });
	}
	cleanupPaths.clear();
});

function createState(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule() { return false; },
			clear() {},
		},
	};
}

function writeAsyncStatus(asyncDir: string, pid: number, state: "queued" | "running" = "running"): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: path.basename(asyncDir),
		mode: "single",
		state,
		startedAt: Date.now(),
		pid,
	}));
}

function createAsyncRunDir(prefix: string): string {
	fs.mkdirSync(ASYNC_DIR, { recursive: true });
	const asyncDir = fs.mkdtempSync(path.join(ASYNC_DIR, prefix));
	cleanupPaths.add(asyncDir);
	return asyncDir;
}

describe("pause-all shortcut handler", () => {
	it("requests pause for all running foreground and async subagent work", () => {
		const state = createState();
		let foregroundInterrupts = 0;
		state.foregroundControls.set("fg-run", {
			runId: "fg-run",
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			interrupt: () => {
				foregroundInterrupts++;
				return true;
			},
		});

		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-all-shortcut-"));
		cleanupPaths.add(asyncDir);
		writeAsyncStatus(asyncDir, 4242);
		state.asyncJobs.set("async-run", {
			asyncId: "async-run",
			asyncDir,
			status: "running",
			mode: "single",
			agents: ["worker"],
		} as never);

		const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
			kills.push({ pid, signal: signal as NodeJS.Signals });
			return true;
		}) as typeof process.kill;

		const notifications: Array<{ message: string; level: string }> = [];
		let renderRequests = 0;
		const result = handlePauseAllShortcut(state, {
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				requestRender() {
					renderRequests++;
				},
			},
		} as never);

		assert.equal(result.level, "info");
		assert.equal(result.message, "Pause requested for 2 subagent runs (1 foreground, 1 async).",
		);
		assert.equal(foregroundInterrupts, 1);
		assert.deepEqual(kills, [{ pid: 4242, signal: ASYNC_INTERRUPT_SIGNAL }]);
		assert.deepEqual(notifications, [{ message: result.message, level: "info" }]);
		assert.equal(renderRequests, 1);
	});

	it("pauses async work that is still tracked as queued while status.json is already running", () => {
		const state = createState();
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-all-shortcut-queued-"));
		cleanupPaths.add(asyncDir);
		writeAsyncStatus(asyncDir, 31337);
		state.asyncJobs.set("queued-run", {
			asyncId: "queued-run",
			asyncDir,
			status: "queued",
			mode: "single",
			agents: ["worker"],
		} as never);
		const pendingAsyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-all-shortcut-pending-"));
		cleanupPaths.add(pendingAsyncDir);
		state.asyncJobs.set("still-queued", {
			asyncId: "still-queued",
			asyncDir: pendingAsyncDir,
			status: "queued",
			mode: "single",
			agents: ["planner"],
		} as never);

		const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
			kills.push({ pid, signal: signal as NodeJS.Signals });
			return true;
		}) as typeof process.kill;

		const result = handlePauseAllShortcut(state, {
			hasUI: false,
		} as never);

		assert.equal(result.level, "info");
		assert.equal(result.message, "Pause requested for 1 subagent run (1 async).",
		);
		assert.deepEqual(kills, [{ pid: 31337, signal: ASYNC_INTERRUPT_SIGNAL }]);
	});

	it("discovers running async work from ASYNC_DIR after reload clears in-memory jobs", () => {
		const state = createState();
		const asyncDir = createAsyncRunDir("pause-all-shortcut-reload-");
		writeAsyncStatus(asyncDir, 5150);

		const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
			kills.push({ pid, signal: signal as NodeJS.Signals });
			return true;
		}) as typeof process.kill;

		const result = handlePauseAllShortcut(state, {
			hasUI: false,
		} as never);

		assert.equal(result.level, "info");
		assert.equal(result.message, "Pause requested for 1 subagent run (1 async).",
		);
		assert.deepEqual(kills, [{ pid: 5150, signal: ASYNC_INTERRUPT_SIGNAL }]);
	});

	it("skips async runs with zero, negative, or unsafe status pids without signaling", () => {
		const cases = [
			{ pid: 0, source: "tracked", prefix: "pause-all-shortcut-zero-" },
			{ pid: -7, source: "tracked", prefix: "pause-all-shortcut-negative-" },
			{ pid: Number.MAX_SAFE_INTEGER + 1, source: "discovered", prefix: "pause-all-shortcut-unsafe-" },
		] as const;

		for (const testCase of cases) {
			const state = createState();
			const asyncDir = testCase.source === "discovered"
				? createAsyncRunDir(testCase.prefix)
				: fs.mkdtempSync(path.join(os.tmpdir(), testCase.prefix));
			if (testCase.source === "tracked") cleanupPaths.add(asyncDir);
			writeAsyncStatus(asyncDir, testCase.pid);
			if (testCase.source === "tracked") {
				state.asyncJobs.set(path.basename(asyncDir), {
					asyncId: path.basename(asyncDir),
					asyncDir,
					status: "running",
					mode: "single",
					agents: ["worker"],
				} as never);
			}

			const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
			mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
				kills.push({ pid, signal: signal as NodeJS.Signals });
				return true;
			}) as typeof process.kill;

			const result = handlePauseAllShortcut(state, {
				hasUI: false,
			} as never);

			assert.equal(result.level, "warning");
			assert.equal(result.message, "No running subagent work exposed an interrupt path to pause.");
			assert.deepEqual(kills, []);
		}
	});

	it("warns when no running subagent work can be paused", () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const result = handlePauseAllShortcut(createState(), {
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				requestRender() {},
			},
		} as never);

		assert.equal(result.level, "warning");
		assert.equal(result.message, "No running subagent work to pause.");
		assert.deepEqual(notifications, [{ message: "No running subagent work to pause.", level: "warning" }]);
	});
});
