import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { loadRunsForAgent, recordRun } from "../../src/runs/shared/run-history.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

describe("run history lifecycle metadata", () => {
	let tempDir: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = createTempDir("pi-subagents-run-history-");
		agentDir = path.join(tempDir, "agent");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		removeTempDir(tempDir);
	});

	it("retains ok/error status while recording paused lifecycle metadata", () => {
		recordRun("worker", "Implement fix", 0, 42, { interrupted: true });

		const [entry] = loadRunsForAgent("worker");
		assert.ok(entry, "expected a run history entry");
		assert.equal(entry.status, "ok");
		assert.equal(entry.state, "paused");
		assert.equal(entry.exitCode, 0);
		assert.equal(entry.reason, "interrupted");
		assert.equal(entry.exit, undefined);
	});

	it("records failure exit metadata and completion-guard reasons when available", () => {
		recordRun("worker", "Implement fix", 143, 84, {
			exitSignal: "SIGTERM",
			controlEvents: [{ reason: "completion_guard" }],
		});

		const [entry] = loadRunsForAgent("worker");
		assert.ok(entry, "expected a run history entry");
		assert.equal(entry.status, "error");
		assert.equal(entry.exit, 143);
		assert.equal(entry.state, "failed");
		assert.equal(entry.exitCode, 143);
		assert.equal(entry.exitSignal, "SIGTERM");
		assert.equal(entry.reason, "completion_guard");
	});
});
