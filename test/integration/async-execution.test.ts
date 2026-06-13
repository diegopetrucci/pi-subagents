/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";

interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string };
}

interface ProcessCleanupPayload {
	attempted?: boolean;
	terminated?: boolean;
	liveProcessesDetected?: boolean;
	escalatedToSigkill?: boolean;
	skippedReason?: string;
	warnings?: string[];
	signals?: string[];
}

interface AsyncResultPayload {
	success: boolean;
	state?: string;
	exitCode?: number;
	sessionId?: string;
	mode?: string;
	summary?: string;
	steps?: Array<{ status?: string; exitCode?: number; exitSignal?: string; error?: string }>;
	results: Array<{
		output?: string;
		success?: boolean;
		skipped?: boolean;
		error?: string;
		exitCode?: number;
		exitSignal?: string;
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: Array<{ success?: boolean; error?: string }>;
		processCleanup?: ProcessCleanupPayload;
	}>;
}

interface AsyncStatusPayload {
	pid?: number;
	sessionId?: string;
	activityState?: string;
	currentTool?: string;
	currentPath?: string;
	state?: string;
	totalTokens?: { total: number };
	steps?: Array<{
		skills?: string[];
		activityState?: string;
		currentTool?: string;
		status?: string;
		exitCode?: number;
		exitSignal?: string;
		error?: string;
		model?: string;
		thinking?: string;
		tokens?: { total: number };
		processCleanup?: ProcessCleanupPayload;
	}>;
}

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	executeAsyncChain(id: string, params: Record<string, unknown>): AsyncExecutionResult;
}

interface UtilsModule {
	readStatus(dir: string): { runId: string; state: string; mode: string } | null;
}

interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
	TEMP_ROOT_DIR: string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

interface AsyncInterruptModule {
	requestAsyncInterrupt(asyncDir: string, pid: number | undefined): void;
}

interface RunStatusModule {
	inspectSubagentStatus(
		params: { id?: string; runId?: string; dir?: string },
		deps?: { asyncDirRoot?: string; resultsDir?: string },
	): { content: Array<{ type?: string; text?: string }>; isError?: boolean };
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const interruptMod = await tryImport<AsyncInterruptModule>("./src/runs/background/async-interrupt.ts");
const runStatusMod = await tryImport<RunStatusModule>("./src/runs/background/run-status.ts");
const available = !!(asyncMod && utils && typesMod && interruptMod);

const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncSingle = asyncMod?.executeAsyncSingle;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const readStatus = utils?.readStatus;
const ASYNC_DIR = typesMod?.ASYNC_DIR;
const RESULTS_DIR = typesMod?.RESULTS_DIR;
const TEMP_ROOT_DIR = typesMod?.TEMP_ROOT_DIR;
const createSubagentExecutor = executorMod?.createSubagentExecutor;
const requestAsyncInterrupt = interruptMod?.requestAsyncInterrupt;
const inspectSubagentStatus = runStatusMod?.inspectSubagentStatus;

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
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

async function waitForAsyncResultFile(id: string, timeoutMs = 15_000): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

async function waitForPidFile(pidFile: string, timeoutMs = 10_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(pidFile)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for pid file: ${pidFile}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
	assert.ok(Number.isInteger(pid) && pid > 0, `expected positive pid in ${pidFile}`);
	return pid;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail(message);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function waitForFileToContain(filePath: string, needle: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf-8").includes(needle)) return;
		if (Date.now() > deadline) assert.fail(`Timed out waiting for '${needle}' in ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function cleanupPid(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
	}
}

function readLastMockPiArgs(mockPi: MockPi): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded mock pi call");
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});
	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("background runs mark supervisor reply paths as live for child intercom metadata", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_INTERCOM_SESSION_NAME",
			"PI_SUBAGENT_ORCHESTRATOR_TARGET",
			"PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH",
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const id = `async-supervisor-reply-path-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Echo supervisor metadata",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			controlIntercomTarget: "subagent-chat-parent",
			childIntercomTarget: (agent, index) => `subagent-${agent}-${id}-${index + 1}`,
		});
		assert.equal(run.isError, undefined);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(JSON.parse(payload.results[0]?.output ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: `subagent-worker-${id}-1`,
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH: "live",
			PI_SUBAGENT_RUN_ID: id,
			PI_SUBAGENT_CHILD_AGENT: "worker",
			PI_SUBAGENT_CHILD_INDEX: "0",
		});
	});

	it("async launch messages tell the parent not to sleep-poll", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const commonParams = {
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		};
		mockPi.onCall({ output: "single done" });
		const singleId = `async-handoff-single-${Date.now().toString(36)}`;
		const singleResult = executeAsyncSingle(singleId, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			...commonParams,
		});
		assert.match(singleResult.content[0]?.text ?? "", /Async: worker \[/);
		assert.match(singleResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(singleResult.content[0]?.text ?? "", /end your turn now/);
		await waitForAsyncResultFile(singleId, 10_000);

		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const parallelId = `async-handoff-parallel-${Date.now().toString(36)}`;
		const parallelResult = executeAsyncChain(parallelId, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /Async parallel:/);
		assert.match(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(parallelResult.content[0]?.text ?? "", /Pi will deliver the completion/);
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 10_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as { agent?: string; mode?: string };
		assert.equal(parallelPayload.mode, "parallel");
		assert.equal(parallelPayload.agent, "parallel:worker+reviewer");

		mockPi.onCall({ output: "chain done" });
		const chainId = `async-handoff-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do chained work" }],
			agents: [makeAgent("worker")],
			...commonParams,
		});
		assert.match(chainResult.content[0]?.text ?? "", /Async chain:/);
		assert.match(chainResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		await waitForAsyncResultFile(chainId, 10_000);
	});

	it("interrupt pauses active async parallel-group children without launching queued work", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 10000 });
		mockPi.onCall({ delay: 10000 });
		mockPi.onCall({ output: "should not start" });
		const id = `async-interrupt-parallel-${Date.now().toString(36)}`;
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const started = executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }, { agent: "writer", task: "Do three" }], concurrency: 2 }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer"), makeAgent("writer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		assert.match(started.content[0]?.text ?? "", /Async parallel:/);
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const readyDeadline = Date.now() + 10000;
		let status: AsyncStatusPayload | undefined;
		while (Date.now() < readyDeadline) {
			if (fs.existsSync(statusPath)) {
				status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
				if (mockPi.callCount() === 2 && status.pid && status.steps?.[0]?.status === "running" && status.steps?.[1]?.status === "running" && status.steps?.[2]?.status === "pending") break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(mockPi.callCount(), 2);
		assert.ok(status && "pid" in status && typeof status.pid === "number", "expected async runner pid");
		assert.deepEqual(status?.steps?.map((step) => step.status), ["running", "running", "pending"]);

		requestAsyncInterrupt!(asyncDir, (status as AsyncStatusPayload & { pid: number }).pid);
		const resultPath = await waitForAsyncResultFile(id, 10000);
		const pausedDeadline = Date.now() + 10000;
		let pausedStatus: AsyncStatusPayload | undefined;
		while (Date.now() < pausedDeadline) {
			pausedStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			if (pausedStatus.state === "paused") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(pausedStatus?.state, "paused");
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(pausedStatus?.steps?.map((step) => step.status), ["paused", "paused", "pending"]);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.state, "paused");
		assert.equal(payload.summary, "Paused after interrupt. Waiting for explicit next action.");
	});

	it("honors queued async pause requests before the first child launches", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "should not start" });
		mockPi.onCall({ output: "should also not start" });
		const id = `async-interrupt-startup-gap-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		requestAsyncInterrupt!(asyncDir, undefined);

		executeAsyncChain(id, {
			chain: [
				{ agent: "worker", task: "Do one" },
				{ agent: "reviewer", task: "Do two" },
			],
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "paused");
		assert.equal(payload.summary, "Paused after interrupt. Waiting for explicit next action.");
		assert.equal(status.state, "paused");
		assert.equal(mockPi.callCount(), 0, "queued pause should prevent the first child from launching");
		assert.deepEqual(status.steps?.map((step) => step.status), ["pending", "pending"]);
		assert.deepEqual(payload.steps?.map((step) => step.status), ["pending", "pending"]);
		assert.equal(payload.results.length, 0);
	});

	it("top-level async parallel conversion preserves output, reads, and progress", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async top-level report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});

		const result = await executor.execute(
			"async-parallel-fields",
			{
				tasks: [{ agent: "worker", task: "Do async work", output: "async-top-output.md", reads: ["input.md"], progress: true }],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.mode, "parallel");
		assert.equal(payload.sessionId, "session-123");
		assert.equal(status.sessionId, "session-123");
		const outputPath = path.join(tempDir, "async-top-output.md");
		const outputDeadline = Date.now() + 5_000;
		while (!fs.existsSync(outputPath)) {
			if (Date.now() > outputDeadline) {
				assert.fail(`Timed out waiting for saved output file: ${outputPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Async top-level report");
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.ok(taskArg.includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.ok(taskArg.includes(`The harness will save your final response to: ${outputPath}`));
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});

	it("top-level async chain suppresses progress for {task} review-only tasks", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async review" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("reviewer", { defaultProgress: true })] }),
		});

		const result = await executor.execute(
			"async-chain-read-only-progress",
			{
				chain: [{ agent: "reviewer" }],
				task: "Review-only. Do not edit files. Return findings.",
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.doesNotMatch(args.at(-1) ?? "", /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("top-level async worktree parallel resolves reads and output against the worktree cwd", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-");
		try {
			mockPi.onCall({ output: "Worktree report" });
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});

			const result = await executor.execute(
				"async-parallel-worktree-fields",
				{
					tasks: [{ agent: "worker", task: "Do worktree work", output: "report.md", reads: ["input.md"] }],
					async: true,
					clarify: false,
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			const asyncId = result.details?.asyncId;
			assert.ok(asyncId, "expected asyncId");
			const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
			const asyncDir = result.details?.asyncDir;
			const deadline = Date.now() + 30_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					const statusPath = asyncDir ? path.join(asyncDir, "status.json") : undefined;
					const eventsPath = asyncDir ? path.join(asyncDir, "events.jsonl") : undefined;
					const status = statusPath && fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf-8") : "(missing status.json)";
					const events = eventsPath && fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "(missing events.jsonl)";
					assert.fail(`Timed out waiting for async result file: ${resultPath}\nStatus: ${status}\nEvents: ${events}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const worktreeCwd = path.join(os.tmpdir(), `pi-worktree-${asyncId}-s0-0`);
			const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
			assert.ok(callFile, "expected a recorded mock pi call");
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			const taskArg = args.at(-1) ?? "";
			assert.ok(taskArg.includes(`[Read from: ${path.join(worktreeCwd, "input.md")}]`));
			assert.ok(taskArg.includes(`The harness will save your final response to: ${path.join(worktreeCwd, "report.md")}`));
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("readStatus caches by mtime (second call uses cache)", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const s1 = readStatus(dir);
			const s2 = readStatus(dir);
			assert.ok(s1);
			assert.ok(s2);
			assert.equal(s1.runId, s2.runId);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus reapplies interrupt hints when returning cached status", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-interrupt-test",
				state: "running",
				mode: "parallel",
				startedAt: Date.now(),
				steps: [
					{ agent: "a", status: "running" },
					{ agent: "b", status: "completed" },
				],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const initial = readStatus(dir) as ({ interruptRequestedAt?: number; steps?: Array<{ interruptRequestedAt?: number }> } & Record<string, unknown>) | null;
			assert.ok(initial);
			assert.equal(initial.interruptRequestedAt, undefined);
			assert.equal(initial.steps?.[0]?.interruptRequestedAt, undefined);

			requestAsyncInterrupt(dir, undefined);

			const cached = readStatus(dir) as ({ interruptRequestedAt?: number; steps?: Array<{ interruptRequestedAt?: number }> } & Record<string, unknown>) | null;
			assert.ok(cached);
			assert.equal(typeof cached.interruptRequestedAt, "number");
			assert.equal(cached.steps?.[0]?.interruptRequestedAt, cached.interruptRequestedAt);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus throws for malformed status files", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
			assert.throws(() => readStatus(dir), /Failed to parse async status file/);
		} finally {
			removeTempDir(dir);
		}
	});

	it("background runs record fallback attempts and final model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.equal(payload.results[0].modelAttempts.length, 2);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.steps[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.equal(statusPayload.steps[0]?.thinking, "low");
		assert.ok(statusPayload.totalTokens!.total > 0);
		assert.ok(statusPayload.steps[0]?.tokens!.total > 0);
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
	});

	it("background runs treat recovered child errors as successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered asynchronously"),
			],
		});
		const id = `async-recovered-child-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "Recovered asynchronously");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.status, "complete");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
	});

	it("background runs keep provider errors failed when followed only by empty assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
		assert.equal(payload.results[0]?.output, "");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.equal(statusPayload.steps?.[0]?.status, "failed");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
	});

	it("background file-only runs write full output but return only a file reference", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.match(payload.summary ?? "", /2 lines/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("background single runs treat string false as disabled output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async inline report" });
		const id = `async-string-false-output-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { output: "default-report.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "false",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "async inline report");
		assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /The harness will save your final response to:/);
	});

	it("background runs detect hidden tool failures even when the child exits 0", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background implementation runs fail when no mutation attempt occurred", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
		assert.match(String(payload.results[0].modelAttempts?.[0]?.error ?? ""), /completed without making edits/);

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.match(eventsText, /"reason":"completion_guard"/);
		assert.match(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /Status:/);
		assert.doesNotMatch(eventsText, /Interrupt:/);
	});

	it("background bash-enabled non-implementation agents can opt out of the completion guard", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "cold start test after patch" });

		const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "test-runner",
			task: "Run cold start test after patch",
			agentConfig: makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "cold start test after patch");

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("background runs resolve skills from the effective task cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
		const id = `async-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(taskCwd, "async-task-cwd-skill");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("background single runs report unavailable pi-subagents skill requests", () => {
		const id = `async-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			skills: ["pi-subagents"],
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains report unavailable pi-subagents skill requests", () => {
		const id = `async-chain-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", skill: ["pi-subagents"] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains resolve relative step cwd values against the shared cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const chainCwd = createTempDir("pi-subagent-async-chain-cwd-");
		const id = `async-chain-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(path.join(chainCwd, "packages", "app"), "async-chain-step-skill");
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app", skill: ["async-chain-step-skill"] }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: chainCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.sessionId, "session-1");
			assert.equal(status.sessionId, "session-1");
			assert.deepEqual(status.steps?.[0]?.skills, ["async-chain-step-skill"]);
		} finally {
			removeTempDir(chainCwd);
		}
	});

	it("keeps top-level current tool/path aligned with still-running parallel children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })] },
				{ delay: 900, jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
				{ delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
				{ delay: 700, jsonl: [events.assistantMessage("editor done")] },
			],
		});

		const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "reader", task: "Read" }, { agent: "editor", task: "Edit" }] }],
			agents: [makeAgent("reader"), makeAgent("editor")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		const doneDeadline = Date.now() + 10_000;
		let sawRunningTool = false;
		let invariantViolated = false;
		while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				const runningTools = (status.steps ?? [])
					.filter((step) => step.status === "running" && typeof step.currentTool === "string")
					.map((step) => step.currentTool as string);
				if (runningTools.length > 0) {
					sawRunningTool = true;
					if (!status.currentTool || !runningTools.includes(status.currentTool)) {
						invariantViolated = true;
						break;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fs.existsSync(resultPath)) {
			assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		}
		assert.equal(sawRunningTool, true, "expected at least one polling interval with a running step tool");
		assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
	});

	it("returns a tool error when the detached runner config cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("returns a tool error when an async run uses a missing cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-missing-cwd-${Date.now().toString(36)}`;
		const missingCwd = path.join(tempDir, "missing-cwd");

		const singleResult = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(singleResult.isError, true);
		assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

		const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(chainResult.isError, true);
		assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
	});

	it("returns a tool error when the async runner process cannot spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, "missing-node");
		try {
			const id = `async-spawn-fail-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
			assert.match(result.content[0]?.text ?? "", /async runner did not produce a pid/);
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("returns a tool error when an async chain cannot write its detached runner config", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-chain-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("background results surface synthesized exit 143 diagnostics with partial output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("partial async answer")],
			exitCode: 143,
		});

		const id = `async-exit-143-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const artifactsDir = path.join(tempDir, "artifacts");
		const artifactOutputPath = path.join(artifactsDir, `${id}_worker_output.md`);
		const statusPath = path.join(asyncDir, "status.json");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeJsonl: false, includeMetadata: true, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath) || !fs.existsSync(statusPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async diagnostics: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.equal(payload.results[0]?.exitCode, 143);
		assert.equal(payload.results[0]?.output, "partial async answer");
		assert.equal(payload.results[0]?.error, "Child process exited with code 143 (conventionally SIGTERM).");
		assert.equal(payload.results[0]?.exitSignal, undefined);
		assert.match(payload.summary ?? "", /Child process exited with code 143 \(conventionally SIGTERM\)\./);
		assert.match(payload.summary ?? "", /Output:\npartial async answer/);
		assert.equal(status.state, "failed");
		assert.equal(status.steps?.[0]?.exitCode, 143);
		assert.equal(status.steps?.[0]?.error, "Child process exited with code 143 (conventionally SIGTERM).");
		assert.equal(
			fs.readFileSync(artifactOutputPath, "utf-8"),
			"Child process exited with code 143 (conventionally SIGTERM).\n\nOutput:\npartial async answer",
		);
		const outputLog = fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8");
		assert.match(outputLog, /partial async answer/);
		assert.match(outputLog, /Child process exited with code 143 \(conventionally SIGTERM\)\./);
	});

	it("result-file fallback preserves per-child exit codes from normal parallel async runs", { skip: !isAsyncAvailable() || !inspectSubagentStatus ? "jiti or run-status not available" : undefined }, async () => {
		mockPi.onCall({ output: "parallel worker done" });
		mockPi.onCall({ stderr: "parallel child failed", exitCode: 17 });

		const id = `async-result-fallback-exitcodes-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }], concurrency: 1 }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.deepEqual(payload.results.map((result) => result.exitCode), [0, 17]);
		assert.deepEqual(payload.steps?.map((step) => step.exitCode), [0, 17]);

		const fallback = inspectSubagentStatus!({ id }, {
			asyncDirRoot: path.join(tempDir, "missing-runs"),
			resultsDir: RESULTS_DIR,
		});
		assert.equal(fallback.isError, undefined);
		const fallbackText = fallback.content[0]?.text ?? "";
		assert.match(fallbackText, /State: failed/);
		assert.match(fallbackText, /1\. worker complete/);
		assert.match(fallbackText, /    Exit code: 0/);
		assert.match(fallbackText, /2\. reviewer failed, error: parallel child failed/);
		assert.match(fallbackText, /    Exit code: 17/);
	});

	it("background stderr takes precedence over synthesized child-exit diagnostics", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("partial async answer")],
			stderr: "explicit async stderr",
			exitCode: 143,
		});

		const id = `async-exit-143-stderr-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.results[0]?.error, "explicit async stderr");
		assert.doesNotMatch(payload.summary ?? "", /conventionally SIGTERM/);
	});

	it("background forced drain after final assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("cleans up run-owned background processes before reporting terminal async completion", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "process-group cleanup is POSIX-only" : undefined }, async () => {
		const id = `async-process-cleanup-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const pidFile = path.join(tempDir, "child-complete.pid");
		const statusPath = path.join(asyncDir, "status.json");
		const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
		mockPi.onCall({
			jsonl: [events.assistantMessage("async cleanup complete")],
			spawnBackgroundChild: { pidFile, keepAliveMs: 60_000 },
		});

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const childPid = await waitForPidFile(pidFile);
		const resultPath = await waitForAsyncResultFile(id);
		await waitForCondition(() => !isPidAlive(childPid), 5_000, `expected background child ${childPid} to be cleaned up`);

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const logText = fs.readFileSync(logPath, "utf-8");
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.processCleanup?.attempted, true);
		assert.equal(payload.results[0]?.processCleanup?.liveProcessesDetected, true);
		assert.equal(payload.results[0]?.processCleanup?.terminated, true);
		assert.match(logText, /## Process cleanup/);
		assert.match(logText, /Cleaned up process group/);
		assert.equal(status.steps?.[0]?.processCleanup?.attempted, true);
		assert.equal(status.steps?.[0]?.processCleanup?.liveProcessesDetected, true);
		assert.equal(status.steps?.[0]?.processCleanup?.terminated, true);
	});

	it("skips process-group cleanup for soft-paused async runs", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "process-group cleanup is POSIX-only" : undefined }, async () => {
		const id = `async-process-cleanup-paused-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const pidFile = path.join(tempDir, "child-paused.pid");
		const statusPath = path.join(asyncDir, "status.json");
		const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
		mockPi.onCall({
			delay: 20_000,
			spawnBackgroundChild: { pidFile, keepAliveMs: 60_000 },
		});

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const childPid = await waitForPidFile(pidFile);
		let runnerPid = 0;
		try {
			await waitForCondition(() => {
				if (!fs.existsSync(statusPath)) return false;
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { pid?: number; state?: string };
				runnerPid = typeof status.pid === "number" ? status.pid : 0;
				return status.state === "running" && runnerPid > 0;
			}, 5_000, `expected running async status at ${statusPath}`);
			process.kill(runnerPid, "SIGUSR2");

			const resultPath = await waitForAsyncResultFile(id);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			const logText = fs.readFileSync(logPath, "utf-8");
			assert.equal(payload.state, "paused");
			assert.equal(status.state, "paused");
			assert.equal(payload.results[0]?.processCleanup?.skippedReason, "soft_pause");
			assert.equal(status.steps?.[0]?.processCleanup?.skippedReason, "soft_pause");
			assert.equal(isPidAlive(childPid), true, "background child should stay alive for a paused run");
			assert.match(logText, /Process cleanup skipped for soft-paused run/);
		} finally {
			cleanupPid(childPid);
		}
	});

	it("soft-pauses every active parallel child without cleaning owned process groups", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "process-group cleanup is POSIX-only" : undefined }, async () => {
		const id = `async-process-cleanup-parallel-paused-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const pidFiles = [path.join(tempDir, "child-parallel-a.pid"), path.join(tempDir, "child-parallel-b.pid")];
		const statusPath = path.join(asyncDir, "status.json");
		const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
		for (const pidFile of pidFiles) {
			mockPi.onCall({
				delay: 10_000,
				spawnBackgroundChild: { pidFile, keepAliveMs: 60_000 },
			});
		}

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const childPids = await Promise.all(pidFiles.map((pidFile) => waitForPidFile(pidFile)));
		let runnerPid = 0;
		try {
			await waitForCondition(() => {
				if (!fs.existsSync(statusPath)) return false;
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { pid?: number; state?: string; steps?: Array<{ status?: string }> };
				runnerPid = typeof status.pid === "number" ? status.pid : 0;
				return status.state === "running"
					&& runnerPid > 0
					&& Array.isArray(status.steps)
					&& status.steps.filter((step) => step.status === "running").length === 2;
			}, 5_000, `expected two running parallel steps at ${statusPath}`);
			process.kill(runnerPid, "SIGUSR2");

			const resultPath = await waitForAsyncResultFile(id, 15_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			const logText = fs.readFileSync(logPath, "utf-8");
			assert.equal(payload.state, "paused");
			assert.equal(status.state, "paused");
			assert.equal(payload.results.length, 2);
			for (const result of payload.results) {
				assert.equal(result.processCleanup?.skippedReason, "soft_pause");
			}
			assert.equal(status.steps?.length, 2);
			for (const step of status.steps ?? []) {
				assert.equal(step.processCleanup?.skippedReason, "soft_pause");
			}
			for (const childPid of childPids) {
				assert.equal(isPidAlive(childPid), true, `background child ${childPid} should stay alive for a paused run`);
			}
			assert.match(logText, /Process cleanup skipped for soft-paused run/);
		} finally {
			for (const childPid of childPids) cleanupPid(childPid);
		}
	});

	it("does not start queued parallel children after a soft pause", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "process-group cleanup is POSIX-only" : undefined }, async () => {
		const id = `async-process-cleanup-parallel-queued-paused-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const pidFiles = [
			path.join(tempDir, "child-parallel-queued-a.pid"),
			path.join(tempDir, "child-parallel-queued-b.pid"),
			path.join(tempDir, "child-parallel-queued-c.pid"),
		];
		const statusPath = path.join(asyncDir, "status.json");
		for (const pidFile of pidFiles.slice(0, 2)) {
			mockPi.onCall({
				delay: 10_000,
				spawnBackgroundChild: { pidFile, keepAliveMs: 60_000 },
			});
		}
		mockPi.onCall({
			delay: 10_000,
			spawnBackgroundChild: { pidFile: pidFiles[2]!, keepAliveMs: 60_000 },
		});

		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "worker-a", task: "Do one" },
					{ agent: "worker-b", task: "Do two" },
					{ agent: "worker-c", task: "Do three" },
				],
				concurrency: 2,
			}],
			resultMode: "parallel",
			agents: [makeAgent("worker-a"), makeAgent("worker-b"), makeAgent("worker-c")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const childPids = await Promise.all(pidFiles.slice(0, 2).map((pidFile) => waitForPidFile(pidFile)));
		let runnerPid = 0;
		try {
			await waitForCondition(() => {
				if (!fs.existsSync(statusPath)) return false;
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { pid?: number; state?: string; steps?: Array<{ status?: string }> };
				runnerPid = typeof status.pid === "number" ? status.pid : 0;
				return status.state === "running"
					&& runnerPid > 0
					&& Array.isArray(status.steps)
					&& status.steps.filter((step) => step.status === "running").length === 2
					&& status.steps[2]?.status === "pending";
			}, 5_000, `expected queued parallel child at ${statusPath}`);
			process.kill(runnerPid, "SIGUSR2");

			const resultPath = await waitForAsyncResultFile(id, 15_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.state, "paused");
			assert.equal(status.state, "paused");
			assert.equal(mockPi.callCount(), 2, "queued child should never spawn a pi process after pause");
			assert.equal(fs.existsSync(pidFiles[2]!), false, "queued child should never start its background process");
			assert.equal(payload.results.length, 3);
			assert.equal(payload.results[2]?.skipped, true);
			assert.equal(payload.results[2]?.processCleanup, undefined);
			assert.equal(status.steps?.[2]?.status, "pending");
			assert.equal(status.steps?.[2]?.processCleanup, undefined);
			for (const [index, childPid] of childPids.entries()) {
				assert.equal(isPidAlive(childPid), true, `background child ${index + 1} (${childPid}) should stay alive for a paused run`);
			}
		} finally {
			for (const childPid of childPids) cleanupPid(childPid);
			if (fs.existsSync(pidFiles[2]!)) cleanupPid(Number(fs.readFileSync(pidFiles[2]!, "utf-8").trim()));
		}
	});

	it("ignores soft-pause signals after terminal child cleanup has started", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "process-group cleanup is POSIX-only" : undefined }, async () => {
		const id = `async-process-cleanup-race-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const pidFile = path.join(tempDir, "child-cleanup-race.pid");
		const statusPath = path.join(asyncDir, "status.json");
		const outputPath = path.join(asyncDir, "output-0.log");
		mockPi.onCall({
			jsonl: [events.assistantMessage("async cleanup complete")],
			spawnBackgroundChild: { pidFile, keepAliveMs: 60_000, ignoreSigterm: true, inheritStdio: true },
		});

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const childPid = await waitForPidFile(pidFile);
		let runnerPid = 0;
		try {
			await waitForCondition(() => {
				if (!fs.existsSync(statusPath)) return false;
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { pid?: number; state?: string };
				runnerPid = typeof status.pid === "number" ? status.pid : 0;
				return status.state === "running" && runnerPid > 0;
			}, 5_000, `expected running async status at ${statusPath}`);
			await waitForFileToContain(outputPath, "async cleanup complete", 5_000);
			let interruptDelivered = false;
			const interruptDeadline = Date.now() + 1_000;
			while (!interruptDelivered && Date.now() < interruptDeadline) {
				try {
					process.kill(runnerPid, "SIGUSR2");
					interruptDelivered = true;
				} catch (error) {
					if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			assert.equal(interruptDelivered, true, `expected runner ${runnerPid} to stay alive long enough to receive SIGUSR2 during cleanup`);

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			await waitForCondition(() => !isPidAlive(childPid), 5_000, `expected background child ${childPid} to be cleaned up`);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.state, "complete");
			assert.equal(status.state, "complete");
			assert.equal(payload.results[0]?.processCleanup?.attempted, true);
			assert.equal(payload.results[0]?.processCleanup?.terminated, true);
			assert.equal(payload.results[0]?.processCleanup?.skippedReason, undefined);
		} finally {
			cleanupPid(childPid);
		}
	});

	it("background runs emit active-long-running control events from child turns", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "active_long_running" && status.steps?.[0]?.activityState === "active_long_running") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed active_long_running");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		assert.ok(statusDuringEvent, "expected status.json to expose active_long_running while the run is still active");
		assert.equal(statusDuringEvent.activityState, "active_long_running");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs escalate repeated mutating tool failures", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		assert.ok(statusDuringEvent, "expected status.json to expose needs_attention while the run is still active");
		assert.equal(statusDuringEvent.activityState, "needs_attention");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs stream child events and live output while active", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});
});
