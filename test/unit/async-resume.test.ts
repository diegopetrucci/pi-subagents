import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";

function writeJson(filePath: string, value: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("async resume lookup", () => {
	it("resolves a completed single-child run from persisted status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-abc", "status.json"), {
				runId: "run-abc",
				mode: "single",
				state: "complete",
				startedAt: 100,
				endedAt: 200,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const target = resolveAsyncResumeTarget({ id: "run-a" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });

			assert.equal(target.kind, "revive");
			assert.equal(target.runId, "run-abc");
			assert.equal(target.agent, "worker");
			assert.equal(target.sessionFile, sessionFile);
			assert.equal(target.cwd, root);
			assert.equal(target.intercomTarget, "subagent-worker-run-abc-1");
			assert.equal(target.continuationAcceptance, undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reuses skipped paused acceptance when reviving a paused child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-paused", "status.json"), {
				runId: "run-paused",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{
					agent: "worker",
					status: "paused",
					sessionFile,
					acceptance: {
						status: "skipped",
						effectiveAcceptance: {
							level: "checked",
							explicit: true,
							inferredReason: ["async write-capable or risky run"],
							criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope", evidence: ["changed-files"], severity: "required" }],
							evidence: ["changed-files", "commands-run", "no-staged-files"],
							verify: [{ id: "tests", command: "npm test" }],
							stopRules: ["Do not widen scope"],
						},
						inferredReason: ["async write-capable or risky run"],
						criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope", evidence: ["changed-files"], severity: "required" }],
						runtimeChecks: [{ id: "paused", status: "not-applicable", message: "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion." }],
						verifyRuns: [],
					},
				}],
			});

			const target = resolveAsyncResumeTarget({ id: "run-paused" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.state, "paused");
			assert.deepEqual(target.continuationAcceptance, {
				level: "checked",
				explicit: true,
				inferredReason: ["async write-capable or risky run"],
				criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope", evidence: ["changed-files"], severity: "required" }],
				evidence: ["changed-files", "commands-run", "no-staged-files"],
				verify: [{ id: "tests", command: "npm test" }],
				stopRules: ["Do not widen scope"],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows a paused child to revive without replay when its persisted session file is absent", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-missing-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "missing.jsonl");
			writeJson(path.join(asyncRoot, "run-paused-missing-session", "status.json"), {
				runId: "run-paused-missing-session",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{
					agent: "worker",
					status: "paused",
					sessionFile,
					acceptance: {
						status: "skipped",
						effectiveAcceptance: {
							level: "checked",
							explicit: true,
							criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope", evidence: ["changed-files"], severity: "required" }],
							evidence: ["changed-files", "commands-run", "no-staged-files"],
							stopRules: ["Do not widen scope"],
						},
						criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope", evidence: ["changed-files"], severity: "required" }],
						runtimeChecks: [{ id: "paused", status: "not-applicable", message: "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion." }],
						verifyRuns: [],
					},
				}],
			});

			const target = resolveAsyncResumeTarget({ id: "run-paused-missing-session" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.state, "paused");
			assert.equal(target.sessionFile, undefined);
			assert.deepEqual(target.continuationAcceptance, {
				level: "checked",
				explicit: true,
				criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope", evidence: ["changed-files"], severity: "required" }],
				evidence: ["changed-files", "commands-run", "no-staged-files"],
				stopRules: ["Do not widen scope"],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a paused child has no persisted acceptance ledger yet", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-window-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-paused-window", "status.json"), {
				runId: "run-paused-window",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{ agent: "worker", status: "paused", sessionFile }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-paused-window" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/skipped acceptance ledger has not been persisted yet/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous run id prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-aa", "status.json"), {
				runId: "run-aa",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "scout", status: "running" }],
			});
			writeJson(path.join(asyncRoot, "run-ab", "status.json"), {
				runId: "run-ab",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-a" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Ambiguous async run id prefix 'run-a' matched: run-aa, run-ab/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects path-like ids and directories outside the async root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paths-"));
		try {
			const asyncRoot = path.join(root, "runs");
			assert.throws(
				() => resolveAsyncResumeTarget({ id: "../run" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/id must be an async run id or prefix, not a path/,
			);
			assert.throws(
				() => resolveAsyncResumeTarget({ dir: path.join(root, "outside") }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Async run directory must be inside/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps terminal follow-up resumes strict when the persisted session file is absent", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-terminal-missing-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "missing.jsonl");
			writeJson(path.join(asyncRoot, "run-terminal-missing-session", "status.json"), {
				runId: "run-terminal-missing-session",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				sessionFile,
				steps: [{ agent: "worker", status: "complete", sessionFile }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-terminal-missing-session" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/session file does not exist/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps completed children strict when an overall paused run has a missing session file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-terminal-missing-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const completedSessionFile = path.join(root, "missing-completed.jsonl");
			const pausedSessionFile = path.join(root, "missing-paused.jsonl");
			writeJson(path.join(asyncRoot, "run-paused-terminal-missing-session", "status.json"), {
				runId: "run-paused-terminal-missing-session",
				mode: "parallel",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "worker-a", status: "complete", sessionFile: completedSessionFile },
					{ agent: "worker-b", status: "paused", sessionFile: pausedSessionFile, acceptance: { status: "skipped", effectiveAcceptance: { level: "checked" } } },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-paused-terminal-missing-session", index: 0 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/session file does not exist/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects non-jsonl session files before reviving", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.txt");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-session", "status.json"), {
				runId: "run-session",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-session" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/session file must be a \.jsonl file/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed result metadata before using session fields", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-result-"));
		try {
			const resultsDir = path.join(root, "results");
			writeJson(path.join(resultsDir, "run-result.json"), {
				id: "run-result",
				agent: "worker",
				success: true,
				state: "complete",
				results: [{ agent: "worker", sessionFile: { path: "session.jsonl" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-result" }, { asyncDirRoot: path.join(root, "runs"), resultsDir }),
				/results\[0\].sessionFile must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed status session ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-session-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-session-id", "status.json"), {
				runId: "run-session-id",
				sessionId: { value: "session" },
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-session-id" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/sessionId must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a live intercom target for a running child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-live-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-live", "status.json"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running" }],
			});

			const target = resolveAsyncResumeTarget({ id: "run-live" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });

			assert.equal(target.kind, "live");
			assert.equal(target.intercomTarget, "subagent-scout-run-live-1");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("revives a completed child by index while a sibling async child is still running", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-partial-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "done.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-partial", "status.json"), {
				runId: "run-partial",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "done", status: "complete", sessionFile },
					{ agent: "active", status: "running" },
				],
			});

			const target = resolveAsyncResumeTarget({ id: "run-partial", index: 0 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "done");
			assert.equal(target.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects pending indexed children in still-running async runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-pending-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "pending.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-pending", "status.json"), {
				runId: "run-pending",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "active", status: "running" },
					{ agent: "later", status: "pending", sessionFile },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-pending", index: 1 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/pending and has not started yet/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves a completed multi-child run when an index and per-child session file are available", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-multi-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-multi", "status.json"), {
				runId: "run-multi",
				mode: "chain",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-multi" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Provide index to choose one/,
			);
			const target = resolveAsyncResumeTarget({ id: "run-multi", index: 1 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "b");
			assert.equal(target.index, 1);
			assert.equal(target.sessionFile, secondSession);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("frames the revived follow-up with original run context", () => {
		const task = buildRevivedAsyncTask({
			kind: "revive",
			runId: "run-old",
			state: "complete",
			agent: "worker",
			index: 0,
			intercomTarget: "subagent-worker-run-old-1",
			sessionFile: "/tmp/session.jsonl",
		}, "What changed?");

		assert.match(task, /Original run: run-old/);
		assert.doesNotMatch(task, /async subagent conversation/);
		assert.match(task, /Original agent: worker/);
		assert.match(task, /Original session file: \/tmp\/session\.jsonl/);
		assert.match(task, /Follow-up:\nWhat changed\?/);
	});
});
