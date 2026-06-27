/**
 * Integration tests for chain execution (sequential and parallel steps).
 *
 * Uses the local createMockPi() harness to simulate subagent processes.
 * Tests the full chain pipeline: template resolution → spawn → output capture
 * → {previous} passing.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgent,
	makeMinimalCtx,
	tryImport,
	events,
} from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT } from "../../src/shared/types.ts";
import { loadRunsForAgent } from "../../src/runs/shared/run-history.ts";

const mockPi: MockPi = createMockPi();
mockPi.install();
after(() => {
	mockPi.uninstall();
});

interface TestSequentialStep {
	agent: string;
	task?: string;
	model?: string;
	fallbackModels?: string[];
	modelFallbackNotice?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
}

interface TestParallelTask {
	agent: string;
	task?: string;
	model?: string;
	fallbackModels?: string[];
	modelFallbackNotice?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
}

type TestChainStep = TestSequentialStep | {
	parallel: TestParallelTask[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
};

interface ChainResultItem {
	agent: string;
	exitCode: number;
	finalOutput?: string;
	task?: string;
	detached?: boolean;
	attemptedModels?: string[];
	modelFallbackNotice?: string;
	skills?: string[];
}

interface ChainExecutionResult {
	isError?: boolean;
	content: Array<{ text: string }>;
	details: {
		results: ChainResultItem[];
		chainAgents?: string[];
		totalSteps?: number;
	};
}

interface ChainExecutionModule {
	executeChain(params: Record<string, unknown>): Promise<ChainExecutionResult>;
}

const chainMod = await tryImport<ChainExecutionModule>("./src/runs/foreground/chain-execution.ts");
const available = !!chainMod;
const executeChain = chainMod?.executeChain;

async function withAgentDir<T>(tempDir: string, fn: () => Promise<T>): Promise<T> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
	try {
		return await fn();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

describe("chain execution — sequential", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let artifactsDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		artifactsDir = path.join(tempDir, "artifacts");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function writePackageSkill(packageRoot: string, skillName: string): void {
		const skillDir = path.join(packageRoot, "skills", skillName);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
			"utf-8",
		);
	}

	it("runs a 2-step chain", async () => {
		mockPi.onCall({ output: "Analysis complete: found 3 issues" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].agent, "analyst");
		assert.equal(result.details.results[1].agent, "reporter");
	});

	it("passes file-only saved-output references through {previous}", async () => {
		mockPi.onCall({ output: "full chain output\nwith details" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "analyst", task: "Analyze", output: "analysis.md", outputMode: "file-only" },
					{ agent: "reporter" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full chain output/);
		const secondTaskArg = readCallArgs(1).at(-1) ?? "";
		assert.match(secondTaskArg, /Output saved to:/);
		assert.match(secondTaskArg, /2 lines/);
		assert.doesNotMatch(secondTaskArg, /full chain output/);
	});

	it("retries chain steps with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "provider unavailable",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Step 1 recovered" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [
			makeAgent("step1", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }),
			makeAgent("step2"),
		];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.deepEqual(result.details.results[0].attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(mockPi.callCount(), 3);
	});

	it("uses per-execution fallback models and notices on chain steps", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "429 quota exceeded" }], errorMessage: "429 quota exceeded" },
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Step recovered" });
		const agents = [makeAgent("step1", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step", fallbackModels: ["github-copilot/gpt-5-mini"], modelFallbackNotice: "Chain fallback" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results[0].attemptedModels, ["openai/gpt-5-mini", "github-copilot/gpt-5-mini"]);
		assert.equal(result.details.results[0].modelFallbackNotice, "Chain fallback");
		assert.match(result.content[0].text, /Notice \(step1\): Chain fallback/);
	});

	it("includes fallback notices in failed chain summaries", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "429 quota exceeded" }], errorMessage: "429 quota exceeded" },
			}],
			exitCode: 1,
		});
		mockPi.onCall({ exitCode: 1, stderr: "Still failed" });
		const agents = [makeAgent("step1", { model: "openai/gpt-5-mini" })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step", fallbackModels: ["github-copilot/gpt-5-mini"], modelFallbackNotice: "Chain fallback" }],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail after fallback attempt fails");
		assert.equal(result.details.results[0].modelFallbackNotice, "Chain fallback");
		assert.match(result.content[0].text, /❌ Chain failed/);
		assert.match(result.content[0].text, /Notice \(step1\): Chain fallback/);
	});

	it("prefers the parent session provider for ambiguous bare chain step models", async () => {
		mockPi.onCall({ output: "Step 1 ran" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [makeAgent("step1", { model: "gpt-5-mini" }), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "github-copilot" },
						modelRegistry: {
							getAvailable: () => [
								{ provider: "openai", id: "gpt-5-mini" },
								{ provider: "github-copilot", id: "gpt-5-mini" },
							],
						},
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.details.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("inherits the current session model for unconfigured chain steps", async () => {
		mockPi.onCall({ output: "Step 1 ran" });
		const agents = [makeAgent("step1")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }],
				agents,
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "github-copilot", id: "gpt-5-mini" },
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.details.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("suppresses progress for {task} chain templates when the top-level task is review-only", async () => {
		mockPi.onCall({ output: "Review done" });
		const agents = [makeAgent("reviewer", { defaultProgress: true })];

		await executeChain(
			makeChainParams(
				[{ agent: "reviewer" }],
				agents,
				{ task: "Review-only. Do not edit files. Return findings." },
			),
		);

		const taskArg = readCallArgs(0).at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("passes {previous} between steps (step 2 receives step 1 output)", async () => {
		mockPi.onCall({ output: "Step 1 unique output: MARKER_ABC_123" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Produce output" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const step2Task = result.details.results[1].task;
		assert.ok(
			step2Task.includes("MARKER_ABC_123"),
			`step 2 task should contain step 1 output via {previous}: ${step2Task.slice(0, 200)}`,
		);
	});

	it("substitutes {task} in templates", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Review {task} carefully" }],
				agents,
				{ task: "the authentication module" },
			),
		);

		assert.ok(!result.isError);
		const workerTask = result.details.results[0].task;
		assert.ok(
			workerTask.includes("the authentication module"),
			`should substitute {task}: ${workerTask.slice(0, 200)}`,
		);
	});

	it("creates and uses chain_dir", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Write to {chain_dir}" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const summary = result.content[0].text;
		assert.ok(summary.includes("✅ Chain completed:"), `missing completion marker: ${summary}`);
		assert.ok(summary.includes("📁 Artifacts:"), `missing artifacts marker: ${summary}`);
	});

	it("stops chain on step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Agent crashed" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do first thing" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail");
		assert.equal(result.details.results.length, 1, "only step1 should have run");
		assert.equal(result.details.results[0].exitCode, 1);
	});

	it("runs a 3-step chain end-to-end", async () => {
		mockPi.onCall({ output: "Step output" });
		const agents = [makeAgent("scout"), makeAgent("planner"), makeAgent("executor")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Survey the codebase" },
					{ agent: "planner" },
					{ agent: "executor" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		assert.ok(result.details.results.every((r) => r.exitCode === 0));
	});

	it("returns error for unknown agent in chain", async () => {
		const agents = [makeAgent("scout")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "scout", task: "Start" }, { agent: "nonexistent" }],
				agents,
			),
		);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("Unknown agent"));
	});

	it("resolves relative step cwd values against the chain cwd for skills", async () => {
		mockPi.onCall({ output: "ok" });
		const chainCwd = path.join(tempDir, "worktree");
		const stepPackageDir = path.join(chainCwd, "packages", "app");
		writePackageSkill(stepPackageDir, "chain-step-skill");
		const agents = [makeAgent("analyst", { skills: ["chain-step-skill"] })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze", cwd: "packages/app" }],
				agents,
				{ cwd: chainCwd },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results[0]?.skills, ["chain-step-skill"]);
	});

	it("pauses a sequential chain after interrupt without advancing to the next step", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = [makeAgent("worker"), makeAgent("reviewer")];
		const foregroundControl = { runId: "seq-interrupt", mode: "chain", startedAt: Date.now(), updatedAt: Date.now() };
		const runId = "chain-seq-pause";

		await withAgentDir(tempDir, async () => {
			const runPromise = executeChain(
				makeChainParams(
					[{ agent: "worker", task: "Do work" }, { agent: "reviewer", task: "Must not run" }],
					agents,
					{ foregroundControl, runId },
				),
			);

			const readyDeadline = Date.now() + 5000;
			while (Date.now() < readyDeadline) {
				if (mockPi.callCount() === 1 && typeof foregroundControl.interrupt === "function") break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(mockPi.callCount(), 1);
			assert.equal(typeof foregroundControl.interrupt, "function");
			assert.equal(foregroundControl.interrupt?.(), true);

			const result = await runPromise;
			const text = result.content[0]?.text ?? "";
			assert.equal(result.isError, undefined);
			assert.match(text, new RegExp(`^Foreground chain run ${runId} paused after interrupt at step 1 \\(worker\\)\\.`));
			assert.match(text, /Pause succeeded; this foreground run is paused and waiting for your explicit next action, not a dispatch error\./);
			assert.match(text, /Note: doctor\/status may show no active run after a foreground pause because the child process has stopped\./);
			assert.match(text, new RegExp(`Resume the paused child: subagent\\(\\{ action: "resume", id: "${runId}", index: 0, message: "\\.\\.\\." \\}\\)`));
			assert.match(text, /Replace\/re-dispatch: subagent\(\{ chain: \[\.\.\.\] \}\)/);
			assert.match(text, /Stop: leave the run paused if no follow-up is needed\./);
			assert.equal(result.details.results.length, 1);
			assert.equal((result.details.results[0] as { interrupted?: boolean }).interrupted, true);
			assert.equal(mockPi.callCount(), 1);
			const [entry] = loadRunsForAgent("worker");
			assert.ok(entry, "expected a run history entry");
			assert.equal(entry.status, "ok");
			assert.equal(entry.state, "paused");
			assert.equal(entry.exitCode, 0);
			assert.equal(entry.reason, "interrupted");
		});
	});

	it("tracks chain metadata (chainAgents, totalSteps)", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "Start" }, { agent: "b" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.chainAgents, ["a", "b"]);
		assert.equal(result.details.totalSteps, 2);
	});

	it("uses custom chainDir when provided", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];
		const customChainDir = path.join(tempDir, "my-chain");

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Use {chain_dir}" }],
				agents,
				{ chainDir: customChainDir },
			),
		);

		assert.ok(!result.isError);
		assert.ok(fs.existsSync(customChainDir), "custom chainDir should exist");
	});

	it("tightens child recursion depth per agent without relaxing the inherited chain max", async () => {
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		const originalMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		try {
			mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
			const agents = [makeAgent("worker", { maxSubagentDepth: 1 })];

			const result = await executeChain(
				makeChainParams(
					[{ agent: "worker", task: "Inspect env" }],
					agents,
					{ maxSubagentDepth: 3 },
				),
			);

			assert.ok(!result.isError);
			assert.deepEqual(JSON.parse(result.details.results[0].finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
			if (originalMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = originalMaxDepth;
		}
	});
});

describe("chain execution — parallel steps", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(tempDir, "artifacts"),
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	it("runs parallel tasks within a chain step", async () => {
		mockPi.onCall({ output: "Parallel task done" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review auth module" },
							{ agent: "reviewer-b", task: "Review data layer" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
	});

	it("uses per-execution fallback models and notices in parallel chain tasks", async () => {
		mockPi.onCall({
			jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "provider unavailable" }], errorMessage: "provider unavailable" } }],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Parallel recovered" });
		mockPi.onCall({ output: "Second task" });
		const agents = [
			makeAgent("reviewer-a", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }),
			makeAgent("reviewer-b"),
		];

		const result = await executeChain(
			makeChainParams(
				[{
					parallel: [
						{ agent: "reviewer-a", task: "Review auth", fallbackModels: ["github-copilot/gpt-5-mini"], modelFallbackNotice: "Parallel chain fallback" },
						{ agent: "reviewer-b", task: "Review data" },
					],
					concurrency: 1,
				}],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results[0].attemptedModels, ["openai/gpt-5-mini", "github-copilot/gpt-5-mini"]);
		assert.equal(result.details.results[0].modelFallbackNotice, "Parallel chain fallback");
		assert.match(result.content[0].text, /Notice \(reviewer-a\): Parallel chain fallback/);
	});

	it("aggregates parallel outputs for next sequential step", async () => {
		mockPi.onCall({ output: "Review findings here" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review security" },
							{ agent: "reviewer-b", task: "Review performance" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		const synthTask = result.details.results[2].task;
		assert.ok(
			synthTask.includes("=== Parallel Task 1 (reviewer-a) ==="),
			"synthesizer should include reviewer-a output block",
		);
		assert.ok(
			synthTask.includes("=== Parallel Task 2 (reviewer-b) ==="),
			"synthesizer should include reviewer-b output block",
		);
	});

	it("aggregates file-only parallel outputs as file references for the next step", async () => {
		mockPi.onCall({ output: "full parallel chain output\nwith details" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review A", output: "a.md", outputMode: "file-only" },
							{ agent: "reviewer-b", task: "Review B", output: "b.md", outputMode: "file-only" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full parallel chain output/);
		assert.doesNotMatch(result.details.results[1]?.finalOutput ?? "", /full parallel chain output/);
		const synthTaskArg = readCallArgs(2).at(-1) ?? "";
		assert.match(synthTaskArg, /Output saved to:/);
		assert.match(synthTaskArg, /2 lines/);
		assert.doesNotMatch(synthTaskArg, /full parallel chain output/);
	});

	it("rejects chain parallel file-only output without spawning siblings", async () => {
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[{
					parallel: [
						{ agent: "reviewer-a", task: "Review A", outputMode: "file-only" },
						{ agent: "reviewer-b", task: "Review B", output: "b.md" },
					],
				}],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("pauses every running child in a parallel chain step without launching queued work", async () => {
		mockPi.onCall({ delay: 10000 });
		mockPi.onCall({ delay: 10000 });
		mockPi.onCall({ output: "should not start" });
		const agents = [makeAgent("a"), makeAgent("b"), makeAgent("c")];
		const foregroundControl = { runId: "parallel-interrupt", mode: "chain", startedAt: Date.now(), updatedAt: Date.now() };
		const runId = "chain-parallel-pause";

		await withAgentDir(tempDir, async () => {
			const runPromise = executeChain(
				makeChainParams(
					[{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
							{ agent: "c", task: "Task C" },
						],
						concurrency: 2,
					}],
					agents,
					{ foregroundControl, runId },
				),
			);

			const readyDeadline = Date.now() + 5000;
			while (Date.now() < readyDeadline) {
				if (mockPi.callCount() === 2 && (foregroundControl as { activeInterrupts?: Map<number, () => boolean> }).activeInterrupts?.size === 2) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(mockPi.callCount(), 2);
			assert.equal((foregroundControl as { activeInterrupts?: Map<number, () => boolean> }).activeInterrupts?.size, 2);
			assert.equal(foregroundControl.interrupt?.(), true);

			const result = await runPromise;
			const text = result.content[0]?.text ?? "";
			assert.equal(result.isError, undefined);
			assert.match(text, new RegExp(`^Foreground chain run ${runId} paused after interrupt at step 1 \\((a|b)\\)\\.`));
			assert.match(text, /Pause succeeded; this foreground run is paused and waiting for your explicit next action, not a dispatch error\./);
			assert.match(text, /Note: doctor\/status may show no active run after a foreground pause because the child process has stopped\./);
			assert.match(text, new RegExp(`Resume a paused child by index, e\\.g\\. subagent\\(\\{ action: "resume", id: "${runId}", index: [01], message: "\\.\\.\\." \\}\\)`));
			assert.match(text, /Replace\/re-dispatch: subagent\(\{ chain: \[\.\.\.\] \}\)/);
			assert.match(text, /Stop: leave the run paused if no follow-up is needed\./);
			assert.equal(mockPi.callCount(), 2);
			assert.equal(result.details.results.every((entry) => (entry as { interrupted?: boolean }).interrupted === true), true);
			const history = ["a", "b", "c"].flatMap((agent) => loadRunsForAgent(agent));
			assert.equal(history.length, 2);
			assert.equal(loadRunsForAgent("c").length, 0);
			assert.equal(history.every((entry) => entry.status === "ok"), true);
			assert.equal(history.every((entry) => entry.state === "paused"), true);
			assert.equal(history.every((entry) => entry.exitCode === 0), true);
			assert.equal(history.every((entry) => entry.reason === "interrupted"), true);
		});
	});

	it("detaches parallel chain children cleanly on intercom handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after handoff")] },
			],
		});
		mockPi.onCall({ output: "Other task done" });
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }),
		];
		const intercomEvents = createEventBus();
		let detachEmitted = false;

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Send handoff" },
							{ agent: "b", task: "Keep working" },
						],
					},
				],
				agents,
				{
					intercomEvents,
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }> } }) {
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "intercom")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-parallel-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(detachEmitted, true);
		assert.equal(result.details.results.some((entry) => entry.detached === true && entry.exitCode === 0), true);
	});

	it("stops a sequential chain when a child detaches for intercom coordination", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b"),
		];
		const intercomEvents = createEventBus();
		let detachEmitted = false;

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "a", task: "Ask supervisor" },
					{ agent: "b", task: "Must not run yet" },
				],
				agents,
				{
					intercomEvents,
					onUpdate(update: { details?: { progress?: Array<{ currentTool?: string }> } }) {
						if (detachEmitted) return;
						if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
						detachEmitted = true;
						intercomEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-sequential-detach" });
					},
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(detachEmitted, true);
		assert.equal(mockPi.callCount(), 1);
	});

	it("passes foreground blocker results through parallel chain outputs under the correct child", async () => {
		const blockerText = "BLOCKED: Need a schema decision from the supervisor before continuing.";
		mockPi.onCall({
			steps: [{
				jsonl: [
					events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a schema decision" }),
					events.toolResult("contact_supervisor", "Blocking supervisor replies are unavailable in this child session. Return the blocker in your final result instead.", true),
					events.toolEnd("contact_supervisor"),
					events.assistantMessage(blockerText),
				],
			}],
		});
		mockPi.onCall({ output: "Worker B completed normally." });
		mockPi.onCall({ output: "Reporter summary." });
		const agents = [
			makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }),
			makeAgent("b"),
			makeAgent("reporter"),
		];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Need a schema decision" },
							{ agent: "b", task: "Complete the current work" },
						],
						concurrency: 1,
					},
					{ agent: "reporter", task: "Summarize blocker routing:\n{previous}" },
				],
				agents,
			),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.results[0]?.finalOutput, blockerText);
		const reporterTask = readCallArgs(2).at(-1) ?? "";
		assert.ok(reporterTask.includes(`=== Parallel Task 1 (a) ===\n${blockerText}`));
		assert.ok(reporterTask.includes("=== Parallel Task 2 (b) ===\nWorker B completed normally."));
		assert.ok(!reporterTask.includes(`=== Parallel Task 2 (b) ===\n${blockerText}`));
	});

	it("chain parallel steps pass foreground supervisor metadata to every child", async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_INTERCOM_SESSION_NAME",
			"PI_SUBAGENT_ORCHESTRATOR_TARGET",
			"PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH",
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const agents = [makeAgent("a"), makeAgent("b")];
		const runId = "chain-supervisor-metadata";

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
						],
					},
				],
				agents,
				{
					runId,
					orchestratorIntercomTarget: "subagent-chat-parent",
					childIntercomTarget: (agent: string, index: number) => `subagent-${agent}-${runId}-${index + 1}`,
				},
			),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(JSON.parse(result.details.results[0]?.finalOutput ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: "subagent-a-chain-supervisor-metadata-1",
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH: "unavailable",
			PI_SUBAGENT_RUN_ID: runId,
			PI_SUBAGENT_CHILD_AGENT: "a",
			PI_SUBAGENT_CHILD_INDEX: "0",
		});
		assert.deepEqual(JSON.parse(result.details.results[1]?.finalOutput ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: "subagent-b-chain-supervisor-metadata-2",
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH: "unavailable",
			PI_SUBAGENT_RUN_ID: runId,
			PI_SUBAGENT_CHILD_AGENT: "b",
			PI_SUBAGENT_CHILD_INDEX: "1",
		});
	});

	it("fails chain on parallel step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Parallel task failed" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail when parallel step fails");
	});

	it("rejects worktree parallel steps that set a different task cwd", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];
		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B", cwd: path.join(tempDir, "other") },
						],
						worktree: true,
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should reject conflicting task cwd under worktree");
		assert.match(result.content[0]?.text ?? "", /worktree isolation uses the shared cwd/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(b\) sets cwd/i);
	});

	it("sequential → parallel → sequential (mixed chain)", async () => {
		mockPi.onCall({ output: "Step complete" });
		const agents = [makeAgent("scout"), makeAgent("rev-a"), makeAgent("rev-b"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Initial scan" },
					{
						parallel: [
							{ agent: "rev-a", task: "Deep review A" },
							{ agent: "rev-b", task: "Deep review B" },
						],
					},
					{ agent: "writer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 4);
		assert.equal(result.details.totalSteps, 3);
	});
});
