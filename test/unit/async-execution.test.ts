import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerSteps, resolveAsyncRunnerLogPaths, spawnDetachedAsyncRunnerProcess } from "../../src/runs/background/async-execution.ts";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail(message);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function retryUntil<T>(operation: () => T, message: string, timeoutMs = 3000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() <= deadline) {
		try {
			return operation();
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	assert.fail(`${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

describe("async runner execution", () => {
	it("places detached runner stdio logs in the async run directory", () => {
		const asyncDir = path.join("tmp", "async-run");
		assert.deepEqual(resolveAsyncRunnerLogPaths({ asyncDir }), {
			stdoutPath: path.join(asyncDir, "runner.stdout.log"),
			stderrPath: path.join(asyncDir, "runner.stderr.log"),
		});
	});

	it("omits runner log paths when asyncDir is unavailable", () => {
		assert.equal(resolveAsyncRunnerLogPaths({}), undefined);
	});

	it("forces thinking off for sanitized fork sessions when building async runner steps", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-thinking-off-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
			const forkResolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-123",
			}, "fork", {
				openSession: () => ({
					createBranchedSession: () => {
						const childSessionFile = path.join(root, "fork.jsonl");
						fs.writeFileSync(childSessionFile, [
							'{"type":"session","version":1,"id":"child","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}',
							'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-04-16T00:00:01.000Z","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-5","content":[{"type":"thinking","thinking":"private","thinkingSignature":"sig-1"},{"type":"text","text":"visible"}]}}',
						].join("\n") + "\n", "utf-8");
						return childSessionFile;
					},
				}),
			});
			const sessionFile = forkResolver.sessionFileForIndex(0);
			assert.ok(sessionFile);

			const result = buildAsyncRunnerSteps("run-1", {
				chain: [{ agent: "worker", task: "Inspect" }],
				agents: [{
					name: "worker",
					description: "Worker",
					model: "anthropic/claude-sonnet-4-5",
					thinking: "high",
					systemPrompt: "Do work",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
					source: "project",
					filePath: path.join(root, "worker.md"),
				}],
				ctx: { pi: {} as never, cwd: root, currentSessionId: "parent-session" },
				sessionFilesByFlatIndex: [sessionFile],
				maxSubagentDepth: 0,
				asyncDir: path.join(root, "async"),
				validateOutputBindings: false,
			});

			assert.ok("steps" in result);
			if (!("steps" in result)) return;
			assert.equal(result.steps[0]?.model, "anthropic/claude-sonnet-4-5");
			assert.equal(result.steps[0]?.thinking, "off");
			assert.deepEqual(result.steps[0]?.modelCandidates, ["anthropic/claude-sonnet-4-5"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preallocates dynamic fork session files and forces thinking off for async dynamic templates", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-dynamic-thinking-off-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
			let childCount = 0;
			const forkResolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-dynamic",
			}, "fork", {
				openSession: () => ({
					createBranchedSession: () => {
						childCount++;
						const childSessionFile = path.join(root, `fork-${childCount}.jsonl`);
						fs.writeFileSync(childSessionFile, [
							'{"type":"session","version":1,"id":"child","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}',
							'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-04-16T00:00:01.000Z","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-5","content":[{"type":"thinking","thinking":"private","signature":"sig-1"},{"type":"text","text":"visible"}]}}',
						].join("\n") + "\n", "utf-8");
						return childSessionFile;
					},
				}),
			});
			const dynamicSessionFiles = [forkResolver.sessionFileForIndex(1), forkResolver.sessionFileForIndex(2)];
			const laterSessionFile = forkResolver.sessionFileForIndex(3);
			assert.ok(dynamicSessionFiles[0]);
			assert.ok(dynamicSessionFiles[1]);
			assert.ok(laterSessionFile);

			const agentBase = {
				description: "Agent",
				systemPrompt: "Do work",
				systemPromptMode: "replace" as const,
				inheritProjectContext: false,
				inheritSkills: false,
				source: "project" as const,
			};
			const result = buildAsyncRunnerSteps("run-1", {
				chain: [
					{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target" },
						parallel: { agent: "reviewer", task: "Review {target.path}" },
						collect: { as: "reviews" },
					},
					{ agent: "consumer", task: "Use {outputs.reviews}" },
				],
				agents: [
					{ ...agentBase, name: "producer", filePath: path.join(root, "producer.md") },
					{ ...agentBase, name: "reviewer", filePath: path.join(root, "reviewer.md"), model: "anthropic/claude-sonnet-4-5:high", thinking: "high" },
					{ ...agentBase, name: "consumer", filePath: path.join(root, "consumer.md") },
				],
				ctx: { pi: {} as never, cwd: root, currentSessionId: "parent-session" },
				sessionFilesByFlatIndex: [undefined, ...dynamicSessionFiles, laterSessionFile],
				dynamicFanoutMaxItems: 2,
				maxSubagentDepth: 0,
				asyncDir: path.join(root, "async"),
			});

			assert.ok("steps" in result);
			if (!("steps" in result)) return;
			const dynamicGroup = result.steps[1];
			assert.ok(dynamicGroup && "expand" in dynamicGroup && "parallel" in dynamicGroup && !Array.isArray(dynamicGroup.parallel));
			if (!(dynamicGroup && "expand" in dynamicGroup && "parallel" in dynamicGroup && !Array.isArray(dynamicGroup.parallel))) return;
			assert.deepEqual(dynamicGroup.sessionFiles, dynamicSessionFiles);
			assert.equal(dynamicGroup.parallel.sessionFile, dynamicSessionFiles[0]);
			assert.equal(dynamicGroup.parallel.model, "anthropic/claude-sonnet-4-5");
			assert.equal(dynamicGroup.parallel.thinking, "off");
			assert.deepEqual(dynamicGroup.parallel.modelCandidates, ["anthropic/claude-sonnet-4-5"]);
			assert.ok(!("parallel" in result.steps[2]!));
			assert.equal(result.steps[2]?.sessionFile, laterSessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("captures detached runner stdout and stderr to async-dir logs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-runner-logs-"));
		try {
			const asyncDir = path.join(root, "async-run");
			const markerPath = path.join(root, "done.txt");
			const result = spawnDetachedAsyncRunnerProcess(
				process.execPath,
				["-e", `
					const fs = require("node:fs");
					process.stdout.write("runner stdout line\\n");
					process.stderr.write("runner stderr line\\n");
					setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, "done"), 10);
				`],
				root,
				{ asyncDir },
			);

			assert.equal(result.error, undefined);
			assert.equal(typeof result.pid, "number");
			await waitFor(() => fs.existsSync(markerPath), "detached runner did not finish");

			const logPaths = resolveAsyncRunnerLogPaths({ asyncDir });
			assert.ok(logPaths);
			await waitFor(
				() => fs.existsSync(logPaths.stdoutPath) && fs.readFileSync(logPaths.stdoutPath, "utf-8").includes("runner stdout line"),
				"stdout log did not capture detached runner output",
			);
			await waitFor(
				() => fs.existsSync(logPaths.stderrPath) && fs.readFileSync(logPaths.stderrPath, "utf-8").includes("runner stderr line"),
				"stderr log did not capture detached runner output",
			);

			// The parent closes its fd copies immediately after spawn. After the short-lived
			// detached runner exits, these append/rename operations verify there are no
			// lingering handles preventing normal cleanup on platforms with strict locks.
			await retryUntil(() => {
				fs.appendFileSync(logPaths.stdoutPath, "parent append after spawn\\n", "utf-8");
				fs.appendFileSync(logPaths.stderrPath, "parent append after spawn\\n", "utf-8");
				const stdoutRenamed = `${logPaths.stdoutPath}.renamed`;
				const stderrRenamed = `${logPaths.stderrPath}.renamed`;
				fs.renameSync(logPaths.stdoutPath, stdoutRenamed);
				fs.renameSync(logPaths.stderrPath, stderrRenamed);
				fs.renameSync(stdoutRenamed, logPaths.stdoutPath);
				fs.renameSync(stderrRenamed, logPaths.stderrPath);
			}, "runner log files were not releasable after detached spawn");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
