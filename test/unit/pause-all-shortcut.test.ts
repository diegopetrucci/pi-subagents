import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it } from "node:test";
import { handlePauseAllShortcut } from "../../src/extension/pause-all-shortcut.ts";
import { INTERRUPT_SIGNAL, interruptRequestPath } from "../../src/runs/background/control-channel.ts";
import { ASYNC_DIR, type SubagentState } from "../../src/shared/types.ts";

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
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

const cleanupPaths = new Set<string>();
const require = createRequire(import.meta.url);
const builtinFs = require("node:fs") as typeof fs;
const mutableProcess = process as typeof process & { kill: typeof process.kill };
const originalKill = process.kill;
const originalReaddirSync = builtinFs.readdirSync;

function stubPortableInterruptKill(): Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> {
	const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
	mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
		kills.push({ pid, signal });
		if (signal === 0) return true;
		if (process.platform === "win32") {
			const error = new Error("kill ENOSYS") as NodeJS.ErrnoException;
			error.code = "ENOSYS";
			throw error;
		}
		return true;
	}) as typeof process.kill;
	return kills;
}

function assertPortableInterruptRequested(
	asyncDir: string,
	pid: number,
	kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }>,
): void {
	assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
	assert.ok(kills.some((entry) => entry.pid === pid && entry.signal === 0));
	assert.ok(kills.some((entry) => entry.pid === pid && entry.signal === INTERRUPT_SIGNAL));
}

afterEach(() => {
	mutableProcess.kill = originalKill;
	builtinFs.readdirSync = originalReaddirSync;
	syncBuiltinESMExports();
	for (const target of cleanupPaths) fs.rmSync(target, { recursive: true, force: true });
	cleanupPaths.clear();
});

describe("pause-all shortcut handler", () => {
	it("requests pause for running foreground and async work", () => {
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
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "async-run",
			mode: "single",
			state: "running",
			startedAt: Date.now(),
			pid: 4242,
		}), "utf-8");
		state.asyncJobs.set("async-run", {
			asyncId: "async-run",
			asyncDir,
			status: "running",
			mode: "single",
			agents: ["worker"],
		});

		const kills = stubPortableInterruptKill();
		builtinFs.readdirSync = ((target: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding | null; withFileTypes?: boolean; recursive?: boolean } | null) => {
			if (target === ASYNC_DIR) return [];
			return originalReaddirSync(target, options as never);
		}) as typeof fs.readdirSync;
		syncBuiltinESMExports();

		const result = handlePauseAllShortcut(state, { hasUI: false } as never);
		assert.match(result.message, /^Pause requested for 2 subagent runs \(1 foreground, 1 async\)\./);
		assert.ok(result.level === "info" || result.level === "warning");
		assert.equal(foregroundInterrupts, 1);
		assertPortableInterruptRequested(asyncDir, 4242, kills);
	});

	it("requests pause for disk-only running async work after reload even when cwd differs", () => {
		const state = createState();
		state.currentSessionId = "current-session";
		fs.mkdirSync(ASYNC_DIR, { recursive: true });
		const asyncDir = fs.mkdtempSync(path.join(ASYNC_DIR, "pause-all-disk-only-"));
		cleanupPaths.add(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "disk-only-async-run",
			sessionId: "current-session",
			mode: "single",
			state: "running",
			cwd: path.join(os.tmpdir(), "task-specific-agent-cwd"),
			startedAt: Date.now(),
			pid: 5252,
		}), "utf-8");

		const kills = stubPortableInterruptKill();
		builtinFs.readdirSync = ((target: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding | null; withFileTypes?: boolean; recursive?: boolean } | null) => {
			const entries = originalReaddirSync(target, options as never);
			if (target === ASYNC_DIR && Array.isArray(entries)) return entries.filter((entry) => entry.name === path.basename(asyncDir));
			return entries;
		}) as typeof fs.readdirSync;
		syncBuiltinESMExports();

		const result = handlePauseAllShortcut(state, { hasUI: false } as never);
		assert.equal(result.level, "info");
		assert.match(result.message, /^Pause requested for 1 subagent run \(1 async\)\.$/);
		assertPortableInterruptRequested(asyncDir, 5252, kills);
	});

	it("ignores disk-only running async work from another session", () => {
		const state = createState();
		state.currentSessionId = "current-session";
		fs.mkdirSync(ASYNC_DIR, { recursive: true });
		const asyncDir = fs.mkdtempSync(path.join(ASYNC_DIR, "pause-all-other-session-"));
		cleanupPaths.add(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "other-session-async-run",
			sessionId: "other-session",
			mode: "single",
			state: "running",
			cwd: path.join(os.tmpdir(), "other-project"),
			startedAt: Date.now(),
			pid: 6262,
		}), "utf-8");

		const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
		mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
			kills.push({ pid, signal });
			return true;
		}) as typeof process.kill;
		builtinFs.readdirSync = ((target: fs.PathLike, options?: BufferEncoding | { encoding?: BufferEncoding | null; withFileTypes?: boolean; recursive?: boolean } | null) => {
			const entries = originalReaddirSync(target, options as never);
			if (target === ASYNC_DIR && Array.isArray(entries)) return entries.filter((entry) => entry.name === path.basename(asyncDir));
			return entries;
		}) as typeof fs.readdirSync;
		syncBuiltinESMExports();

		const result = handlePauseAllShortcut(state, { hasUI: false } as never);
		assert.equal(result.level, "warning");
		assert.equal(result.message, "No running subagent work to pause.");
		assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
		assert.deepEqual(kills, []);
	});
});
