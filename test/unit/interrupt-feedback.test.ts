import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
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

function createExecutor(state = createState()) {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] as any[] }),
		allowMutatingManagementActions: true,
	});
}

function ctx(root: string) {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function writeAsyncStatus(asyncDir: string, pid: number): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId: path.basename(asyncDir),
		mode: "single",
		state: "running",
		startedAt: Date.now(),
		pid,
	}), "utf-8");
}

function createDiskAsyncRunDir(prefix: string): string {
	fs.mkdirSync(ASYNC_DIR, { recursive: true });
	const asyncDir = fs.mkdtempSync(path.join(ASYNC_DIR, prefix));
	cleanupPaths.add(asyncDir);
	return asyncDir;
}

function text(result: { content?: Array<{ text?: string }> }): string {
	return result.content?.[0]?.text ?? "";
}

describe("async interrupt feedback", () => {
	it("refuses to signal disk-only async runs and explains how to reconcile them", async () => {
		const state = createState();
		const asyncDir = createDiskAsyncRunDir("interrupt-feedback-disk-");
		writeAsyncStatus(asyncDir, 5150);
		const runId = path.basename(asyncDir);
		const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
		mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
			kills.push({ pid, signal });
			return true;
		}) as typeof process.kill;

		const result = await createExecutor(state).execute("interrupt-disk-only", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx(os.tmpdir()));

		assert.equal(result.isError, true);
		assert.match(text(result), new RegExp(`Async run ${runId} is only disk-discovered right now`));
		assert.match(text(result), /PID-ownership safety/);
		assert.match(text(result), new RegExp(`subagent\\(\\{ action: "status", id: "${runId}" \\}\\)`));
		assert.match(text(result), /subagent\(\{ action: "doctor" \}\)/);
		assert.deepEqual(kills, []);
	});

	it("suggests stale-run reconciliation when async signaling fails with ESRCH", async () => {
		const state = createState();
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "interrupt-feedback-stale-"));
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

		const result = await createExecutor(state).execute("interrupt-stale", { action: "interrupt", id: "stale-run" }, new AbortController().signal, undefined, ctx(os.tmpdir()));

		assert.equal(result.isError, true);
		assert.match(text(result), /Async run stale-run appears stale because PID 4242 no longer exists\./);
		assert.match(text(result), /subagent\(\{ action: "status", id: "stale-run" \}\)/);
		assert.match(text(result), /subagent\(\{ action: "doctor" \}\) to reconcile before interrupting again\./);
	});

	it("explains when a tracked async run lacks a safe interrupt-capable pid", async () => {
		const state = createState();
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "interrupt-feedback-unsafe-"));
		cleanupPaths.add(asyncDir);
		writeAsyncStatus(asyncDir, 0);
		state.asyncJobs.set("unsafe-run", {
			asyncId: "unsafe-run",
			asyncDir,
			status: "running",
			mode: "single",
			agents: ["worker"],
		} as never);

		const result = await createExecutor(state).execute("interrupt-unsafe", { action: "interrupt", id: "unsafe-run" }, new AbortController().signal, undefined, ctx(os.tmpdir()));

		assert.equal(result.isError, true);
		assert.match(text(result), /Async run unsafe-run is marked running but does not expose a safe interrupt-capable pid\./);
		assert.match(text(result), /subagent\(\{ action: "status", id: "unsafe-run" \}\)/);
		assert.match(text(result), /subagent\(\{ action: "doctor" \}\) to reconcile before interrupting\./);
	});
});
