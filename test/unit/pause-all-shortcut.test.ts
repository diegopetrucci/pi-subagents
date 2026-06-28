import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { handlePauseAllShortcut } from "../../src/extension/pause-all-shortcut.ts";
import { interruptRequestPath } from "../../src/runs/background/control-channel.ts";
import type { SubagentState } from "../../src/shared/types.ts";

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
const mutableProcess = process as typeof process & { kill: typeof process.kill };
const originalKill = process.kill;

afterEach(() => {
	mutableProcess.kill = originalKill;
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

		const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
		mutableProcess.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
			kills.push({ pid, signal });
			return true;
		}) as typeof process.kill;

		const result = handlePauseAllShortcut(state, { hasUI: false } as never);
		assert.match(result.message, /^Pause requested for 2 subagent runs \(1 foreground, 1 async\)\./);
		assert.ok(result.level === "info" || result.level === "warning");
		assert.equal(foregroundInterrupts, 1);
		assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
		if (process.platform === "win32") {
			assert.equal(kills.length, 0);
		} else {
			assert.ok(kills.length >= 1);
			assert.ok(kills.some((entry) => entry.pid === 4242));
		}
	});
});
