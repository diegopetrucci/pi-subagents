import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { handlePauseAllShortcut } from "../../src/extension/pause-all-shortcut.ts";
import { ASYNC_INTERRUPT_REQUEST_FILE, ASYNC_INTERRUPT_SIGNAL, getAsyncInterruptSignal } from "../../src/runs/background/async-interrupt.ts";
import { ASYNC_DIR, type SubagentState } from "../../src/shared/types.ts";
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

function assertAsyncInterruptRequested(asyncDir: string, pid: number, kills: Array<{ pid: number; signal: NodeJS.Signals }>): void {
	const requestPath = path.join(asyncDir, ASYNC_INTERRUPT_REQUEST_FILE);
	assert.equal(fs.existsSync(requestPath), true);
	const payload = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as { pid?: number; requestedAt?: number };
	assert.equal(payload.pid, pid);
	assert.equal(typeof payload.requestedAt, "number");
	if (process.platform === "win32") {
		assert.equal(ASYNC_INTERRUPT_SIGNAL, undefined);
		assert.deepEqual(kills, []);
		return;
	}
	assert.ok(ASYNC_INTERRUPT_SIGNAL);
	assert.deepEqual(kills, [{ pid, signal: ASYNC_INTERRUPT_SIGNAL }]);
}

describe("pause-all shortcut handler", () => {
	it("only exposes the async interrupt signal on POSIX platforms", () => {
		assert.equal(getAsyncInterruptSignal("win32"), undefined);
		assert.equal(getAsyncInterruptSignal("linux"), "SIGUSR2");
	});

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
		assertAsyncInterruptRequested(asyncDir, 4242, kills);
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
		assertAsyncInterruptRequested(asyncDir, 31337, kills);
	});

	it("skips disk-discovered running async work after reload clears in-memory jobs", () => {
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

		assert.equal(result.level, "warning");
		assert.equal(result.message, "No running subagent work could be paused. Skipped 1 disk-only running run for PID-ownership safety; use status/doctor to reconcile before interrupting.");
		assert.deepEqual(kills, []);
	});

	it("still pauses tracked async work when disk-discovered running status files are also present", () => {
		const state = createState();
		const trackedAsyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-all-shortcut-tracked-"));
		cleanupPaths.add(trackedAsyncDir);
		writeAsyncStatus(trackedAsyncDir, 4242);
		state.asyncJobs.set("tracked-run", {
			asyncId: "tracked-run",
			asyncDir: trackedAsyncDir,
			status: "running",
			mode: "single",
			agents: ["worker"],
		} as never);
		const discoveredAsyncDir = createAsyncRunDir("pause-all-shortcut-discovered-");
		writeAsyncStatus(discoveredAsyncDir, 5150);

		const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
			kills.push({ pid, signal: signal as NodeJS.Signals });
			return true;
		}) as typeof process.kill;

		const result = handlePauseAllShortcut(state, {
			hasUI: false,
		} as never);

		assert.equal(result.level, "warning");
		assert.equal(result.message, "Pause requested for 1 subagent run (1 async). Skipped 1 disk-only running run for PID-ownership safety; use status/doctor to reconcile before interrupting.");
		assertAsyncInterruptRequested(trackedAsyncDir, 4242, kills);
	});

	it("skips async runs with zero, negative, or unsafe status pids without signaling", () => {
		const cases = [
			{
				pid: 0,
				source: "tracked",
				prefix: "pause-all-shortcut-zero-",
				expectedMessage: "No running subagent work could be paused. Skipped 1 tracked async run without a safe interrupt-capable pid; use status/doctor to reconcile.",
			},
			{
				pid: -7,
				source: "tracked",
				prefix: "pause-all-shortcut-negative-",
				expectedMessage: "No running subagent work could be paused. Skipped 1 tracked async run without a safe interrupt-capable pid; use status/doctor to reconcile.",
			},
			{
				pid: Number.MAX_SAFE_INTEGER + 1,
				source: "discovered",
				prefix: "pause-all-shortcut-unsafe-",
				expectedMessage: "No running subagent work could be paused. Skipped 1 disk-only running run for PID-ownership safety; use status/doctor to reconcile before interrupting.",
			},
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
			assert.equal(result.message, testCase.expectedMessage);
			assert.deepEqual(kills, []);
		}
	});

	it("surfaces stale-run guidance when signaling a tracked async run fails with ESRCH", () => {
		const state = createState();
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pause-all-shortcut-stale-"));
		cleanupPaths.add(asyncDir);
		writeAsyncStatus(asyncDir, 4242);
		state.asyncJobs.set("stale-run", {
			asyncId: "stale-run",
			asyncDir,
			status: "running",
			mode: "single",
			agents: ["worker"],
		} as never);

		mutableProcess.kill = (() => {
			const error = new Error("missing") as NodeJS.ErrnoException;
			error.code = "ESRCH";
			throw error;
		}) as typeof process.kill;

		const result = handlePauseAllShortcut(state, {
			hasUI: false,
		} as never);

		assert.equal(result.level, "warning");
		assert.match(result.message, /^Failed to request a pause for running subagent work\. 1 interrupt request failure observed\./);
		assert.match(result.message, /Async run stale-run appears stale because PID 4242 no longer exists\./);
		assert.match(result.message, /Use subagent\(\{ action: "status", id: "stale-run" \}\) or subagent\(\{ action: "doctor" \}\) to reconcile before interrupting again\./);
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
