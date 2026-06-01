import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanupRuntimeDirs, inspectRuntimeDirs } from "../../src/extension/runtime-cleanup.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setTreeMtime(targetPath: string, mtimeMs: number): void {
	const stat = fs.statSync(targetPath);
	if (stat.isDirectory()) {
		for (const entry of fs.readdirSync(targetPath)) {
			setTreeMtime(path.join(targetPath, entry), mtimeMs);
		}
	}
	const time = new Date(mtimeMs);
	fs.utimesSync(targetPath, time, time);
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function writeRoute(nestedEventsDir: string, rootRunId: string, suffix: string): string {
	const routeDir = path.join(nestedEventsDir, `${rootRunId}-${suffix}`);
	fs.mkdirSync(path.join(routeDir, "events"), { recursive: true });
	fs.mkdirSync(path.join(routeDir, "controls"), { recursive: true });
	fs.writeFileSync(path.join(routeDir, "route.json"), JSON.stringify({ rootRunId, capabilityToken: suffix }, null, 2), "utf-8");
	return routeDir;
}

function createPaths(root: string): { asyncDir: string; nestedRunsDir: string; nestedEventsDir: string } {
	return {
		asyncDir: path.join(root, "async-subagent-runs"),
		nestedRunsDir: path.join(root, "nested-subagent-runs"),
		nestedEventsDir: path.join(root, "nested-subagent-events"),
	};
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("runtime cleanup", () => {
	it("removes stale no-status and terminal async dirs while preserving active, paused, live-pid, and needs-attention runs", () => {
		const root = tempRoot("pi-runtime-cleanup-async-");
		const now = 9 * ONE_DAY_MS;
		const paths = createPaths(root);
		try {
			const staleEmptyDir = path.join(paths.asyncDir, "stale-empty");
			fs.mkdirSync(staleEmptyDir, { recursive: true });
			setTreeMtime(staleEmptyDir, now - (2 * ONE_DAY_MS));

			const staleNoStatusDir = path.join(paths.asyncDir, "stale-no-status");
			fs.mkdirSync(staleNoStatusDir, { recursive: true });
			fs.writeFileSync(path.join(staleNoStatusDir, "events.jsonl"), "{}\n", "utf-8");
			setTreeMtime(staleNoStatusDir, now - (2 * ONE_DAY_MS));

			const recentNoStatusDir = path.join(paths.asyncDir, "recent-no-status");
			fs.mkdirSync(recentNoStatusDir, { recursive: true });
			fs.writeFileSync(path.join(recentNoStatusDir, "events.jsonl"), "{}\n", "utf-8");
			setTreeMtime(recentNoStatusDir, now - (12 * 60 * 60 * 1000));

			const staleCompleteDir = path.join(paths.asyncDir, "stale-complete");
			writeStatus(staleCompleteDir, {
				runId: "stale-complete",
				mode: "single",
				state: "complete",
				startedAt: now - (10 * ONE_DAY_MS),
				endedAt: now - (8 * ONE_DAY_MS),
			});
			setTreeMtime(staleCompleteDir, now - (8 * ONE_DAY_MS));

			const pausedDir = path.join(paths.asyncDir, "paused-run");
			writeStatus(pausedDir, {
				runId: "paused-run",
				mode: "single",
				state: "paused",
				startedAt: now - (20 * ONE_DAY_MS),
				lastUpdate: now - (20 * ONE_DAY_MS),
			});
			setTreeMtime(pausedDir, now - (20 * ONE_DAY_MS));

			const livePidDir = path.join(paths.asyncDir, "live-pid-run");
			writeStatus(livePidDir, {
				runId: "live-pid-run",
				mode: "single",
				state: "failed",
				pid: 4242,
				startedAt: now - (20 * ONE_DAY_MS),
				endedAt: now - (10 * ONE_DAY_MS),
			});
			setTreeMtime(livePidDir, now - (10 * ONE_DAY_MS));

			const needsAttentionDir = path.join(paths.asyncDir, "needs-attention-run");
			writeStatus(needsAttentionDir, {
				runId: "needs-attention-run",
				mode: "single",
				state: "failed",
				activityState: "needs_attention",
				startedAt: now - (20 * ONE_DAY_MS),
				endedAt: now - (10 * ONE_DAY_MS),
			});
			setTreeMtime(needsAttentionDir, now - (10 * ONE_DAY_MS));

			const inspected = inspectRuntimeDirs(paths, {
				now: () => now,
				kill: (pid) => {
					if (pid === 4242) return true;
					throw errno("ESRCH");
				},
			});
			assert.equal(inspected.topLevelAsyncDirs, 7);
			assert.equal(inspected.staleAsyncDirs, 3);
			assert.equal(inspected.activeOrLiveAsyncDirs, 3);

			const result = cleanupRuntimeDirs(paths, {
				now: () => now,
				kill: (pid) => {
					if (pid === 4242) return true;
					throw errno("ESRCH");
				},
			});

			assert.deepEqual(result, { removedAsyncDirs: 3, removedNestedEventDirs: 0 });
			assert.equal(fs.existsSync(staleEmptyDir), false);
			assert.equal(fs.existsSync(staleNoStatusDir), false);
			assert.equal(fs.existsSync(staleCompleteDir), false);
			assert.equal(fs.existsSync(recentNoStatusDir), true);
			assert.equal(fs.existsSync(pausedDir), true);
			assert.equal(fs.existsSync(livePidDir), true);
			assert.equal(fs.existsSync(needsAttentionDir), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("cleans stale nested event dirs only after their async runs are no longer retained, while keeping fresh unreferenced routes", () => {
		const root = tempRoot("pi-runtime-cleanup-events-");
		const now = Date.now();
		const paths = createPaths(root);
		try {
			const activeTopLevelDir = path.join(paths.asyncDir, "root-active");
			writeStatus(activeTopLevelDir, {
				runId: "root-active",
				mode: "single",
				state: "running",
				startedAt: now - (10 * ONE_DAY_MS),
				lastUpdate: now - ONE_DAY_MS,
			});
			setTreeMtime(activeTopLevelDir, now - ONE_DAY_MS);

			const retainedTerminalDir = path.join(paths.asyncDir, "root-recent");
			writeStatus(retainedTerminalDir, {
				runId: "root-recent",
				mode: "single",
				state: "complete",
				startedAt: now - (3 * ONE_DAY_MS),
				endedAt: now - (2 * ONE_DAY_MS),
			});
			setTreeMtime(retainedTerminalDir, now - (2 * ONE_DAY_MS));

			const staleTerminalDir = path.join(paths.asyncDir, "root-stale");
			writeStatus(staleTerminalDir, {
				runId: "root-stale",
				mode: "single",
				state: "failed",
				startedAt: now - (12 * ONE_DAY_MS),
				endedAt: now - (8 * ONE_DAY_MS),
			});
			setTreeMtime(staleTerminalDir, now - (8 * ONE_DAY_MS));

			const nestedLiveDir = path.join(paths.nestedRunsDir, "root-nested", "nested-child");
			writeStatus(nestedLiveDir, {
				runId: "nested-child",
				mode: "single",
				state: "paused",
				startedAt: now - (12 * ONE_DAY_MS),
				lastUpdate: now - (4 * ONE_DAY_MS),
			});
			setTreeMtime(nestedLiveDir, now - (4 * ONE_DAY_MS));

			const routeActive = writeRoute(paths.nestedEventsDir, "root-active", "route-active");
			const routeRecent = writeRoute(paths.nestedEventsDir, "root-recent", "route-recent");
			const routeNested = writeRoute(paths.nestedEventsDir, "root-nested", "route-nested");
			const routeStale = writeRoute(paths.nestedEventsDir, "root-stale", "route-stale");
			setTreeMtime(routeStale, now - (2 * ONE_DAY_MS));
			const routeFreshOrphan = writeRoute(paths.nestedEventsDir, "root-orphan-fresh", "route-orphan-fresh");
			setTreeMtime(routeFreshOrphan, now - (12 * 60 * 60 * 1000));
			const routeStaleOrphan = writeRoute(paths.nestedEventsDir, "root-orphan-stale", "route-orphan-stale");
			setTreeMtime(routeStaleOrphan, now - (2 * ONE_DAY_MS));

			const result = cleanupRuntimeDirs(paths, {
				now: () => now,
				kill: () => {
					throw errno("ESRCH");
				},
			});

			assert.deepEqual(result, { removedAsyncDirs: 1, removedNestedEventDirs: 2 });
			assert.equal(fs.existsSync(activeTopLevelDir), true);
			assert.equal(fs.existsSync(retainedTerminalDir), true);
			assert.equal(fs.existsSync(nestedLiveDir), true);
			assert.equal(fs.existsSync(staleTerminalDir), false);
			assert.equal(fs.existsSync(routeActive), true);
			assert.equal(fs.existsSync(routeRecent), true);
			assert.equal(fs.existsSync(routeNested), true);
			assert.equal(fs.existsSync(routeStale), false);
			assert.equal(fs.existsSync(routeFreshOrphan), true);
			assert.equal(fs.existsSync(routeStaleOrphan), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
