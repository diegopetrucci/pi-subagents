import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ASYNC_DIR, INTERCOM_DETACH_REQUEST_EVENT, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

interface ExecutorResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		mode?: string;
		runId?: string;
		results?: Array<{
			agent?: string;
			finalOutput?: string;
			outputMode?: string;
			savedOutputPath?: string;
			outputSaveError?: string;
			truncation?: { truncated?: boolean };
			attemptedModels?: string[];
			modelFallbackNotice?: string;
		}>;
		asyncId?: string;
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<ExecutorResult>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!executorMod?.createSubagentExecutor;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function createRecordingEventBus(options: { acknowledgeResults?: boolean } = {}) {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const bus = {
		emitted,
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			emitted.push({ channel, payload });
			for (const handler of listeners.get(channel) ?? []) {
				handler(payload);
			}
			if (options.acknowledgeResults && channel === "subagent:result-intercom") {
				const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
				if (typeof requestId === "string") {
					setImmediate(() => bus.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
				}
			}
		},
	};
	return bus;
}

describe("intercom result delivery cutover", { skip: !available ? "executor not importable" : undefined }, () => {
	let tempDir: string;
	let homeDir: string;
	let mockPi: MockPi;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	before(() => {
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		homeDir = createTempDir("pi-subagent-intercom-home-");
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		mockPi = createMockPi();
		mockPi.install();
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true });
		fs.writeFileSync(path.join(os.homedir(), ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
	});

	after(() => {
		mockPi.uninstall();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		removeTempDir(homeDir);
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagent-intercom-result-");
		mockPi.reset();
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
		fs.mkdirSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true });
		fs.writeFileSync(path.join(os.homedir(), ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	async function readMockCallArgs(index: number): Promise<string[]> {
		const deadline = Date.now() + 10_000;
		let callFile: string | undefined;
		while (!callFile) {
			callFile = fs.readdirSync(mockPi.dir)
				.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
				.sort()[index];
			if (callFile || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(callFile, `expected mock pi call at index ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!fs.existsSync(filePath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for file: ${filePath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	async function waitForAsyncState(runId: string, expected: string, timeoutMs = 10_000): Promise<void> {
		const statusPath = path.join(ASYNC_DIR, runId, "status.json");
		const deadline = Date.now() + timeoutMs;
		while (true) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { state?: string };
				if (status.state === expected) return;
			}
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async state '${expected}' for ${runId}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	async function waitForAsyncStatusPredicate(
		runId: string,
		predicate: (status: { state?: string; sessionFile?: string; steps?: Array<{ status?: string; sessionFile?: string; acceptance?: { status?: string } }> }) => boolean,
		label: string,
		timeoutMs = 10_000,
	): Promise<void> {
		const statusPath = path.join(ASYNC_DIR, runId, "status.json");
		const deadline = Date.now() + timeoutMs;
		while (true) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { state?: string; sessionFile?: string; steps?: Array<{ status?: string; sessionFile?: string; acceptance?: { status?: string } }> };
				if (predicate(status)) return;
			}
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status predicate '${label}' for ${runId}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

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
		git(repoDir, ["config", "user.name", "Intercom Result Tests"]);
		fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
		git(repoDir, ["add", "tracked.txt"]);
		git(repoDir, ["commit", "-m", "initial commit"]);
		return repoDir;
	}

	async function waitFor(predicate: () => boolean, failure: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) assert.fail(failure);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	function makeExecutor(options: { bridgeMode?: "always" | "off"; agents?: ReturnType<typeof makeAgent>[]; acknowledgeResults?: boolean; kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean; worktreeBaseDir?: string } = {}) {
		const events = createRecordingEventBus({ acknowledgeResults: options.acknowledgeResults ?? true });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: {
				schedule: () => false,
				clear: () => {},
			},
		};
		const executor = createSubagentExecutor!({
			pi: {
				events,
				getSessionName: () => "orchestrator",
				setSessionName: () => {},
			},
			state,
			config: {
				intercomBridge: { mode: options.bridgeMode ?? "always" },
				...(options.worktreeBaseDir ? { worktreeBaseDir: options.worktreeBaseDir } : {}),
			},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: options.agents ?? [makeAgent("worker")] }),
			kill: options.kill,
		});
		return { executor, events, state };
	}

	it("single foreground runs return one native grouped result and emit no result event", async () => {
		mockPi.onCall({ output: "Full child output from worker" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-intercom",
			{ agent: "worker", task: "Summarize feature status" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /^subagent results/m);
		assert.match(result.content[0]?.text ?? "", /Mode: single/);
		assert.match(result.content[0]?.text ?? "", /Status: completed/);
		assert.match(result.content[0]?.text ?? "", /Children: 1 completed/);
		assert.match(result.content[0]?.text ?? "", /1\. worker — completed/);
		assert.match(result.content[0]?.text ?? "", /Summary:\nFull child output from worker/);
		assert.equal((result.content[0]?.text ?? "").match(/Full child output from worker/g)?.length ?? 0, 1);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Delivered .* via intercom/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Run intercom target:/);
		assert.equal(result.details?.results?.[0]?.finalOutput, "Full child output from worker");
	});

	it("bridge-off single runs still use the native grouped result with no listener dependence", async () => {
		mockPi.onCall({ output: "Legacy foreground output" });
		const { executor, events } = makeExecutor({ bridgeMode: "off" });

		const result = await executor.execute(
			"single-no-intercom",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Mode: single/);
		assert.match(result.content[0]?.text ?? "", /Summary:\nLegacy foreground output/);
	});

	it("native foreground results do not wait for acknowledgement listeners", async () => {
		mockPi.onCall({ output: "Unacknowledged foreground output" });
		const { executor, events } = makeExecutor({ acknowledgeResults: false });

		const result = await executor.execute(
			"single-no-ack",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Summary:\nUnacknowledged foreground output/);
	});

	it("native foreground results do not depend on installed intercom package files", async () => {
		fs.rmSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom"), { recursive: true, force: true });
		fs.rmSync(path.join(os.homedir(), ".pi", "agent", "intercom"), { recursive: true, force: true });
		mockPi.onCall({ output: "No package foreground output" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-no-package",
			{ agent: "worker", task: "Summarize feature" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Summary:\nNo package foreground output/);
	});

	it("native foreground summaries honor maxOutput truncation without discarding full structured output", async () => {
		mockPi.onCall({ output: "first visible line\nsecond hidden line\nthird hidden line" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-truncated",
			{ agent: "worker", task: "Summarize lines", maxOutput: { lines: 1, bytes: 100 } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /first visible line/);
		assert.doesNotMatch(text, /second hidden line/);
		assert.equal(result.details?.results?.[0]?.finalOutput, "first visible line\nsecond hidden line\nthird hidden line");
		assert.equal(result.details?.results?.[0]?.truncation?.truncated, true);
	});

	it("native foreground summaries preserve file-only references even when maxOutput is smaller", async () => {
		mockPi.onCall({ output: "full saved native output\nwith hidden details" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-file-only",
			{
				agent: "worker",
				task: "Write report",
				output: "native-file-only.md",
				outputMode: "file-only",
				maxOutput: { lines: 1, bytes: 10 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Summary:\nOutput saved to:/);
		assert.match(text, /native-file-only\.md/);
		assert.doesNotMatch(text, /full saved native output/);
		assert.doesNotMatch(text, /\[TRUNCATED:/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /^Output saved to:/);
		assert.equal(result.details?.results?.[0]?.outputMode, "file-only");
	});

	it("failed file-only foreground runs return truncated native error context without leaking full output", async () => {
		mockPi.onCall({ output: "single visible partial\nsingle hidden partial\nsingle final hidden", stderr: "single terminal failure", exitCode: 1 });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-failed",
			{
				agent: "worker",
				task: "Summarize failure",
				output: "failed-file-only.md",
				outputMode: "file-only",
				maxOutput: { lines: 1, bytes: 100 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Mode: single/);
		assert.match(text, /Status: failed/);
		assert.match(text, /Children: 1 failed/);
		assert.match(text, /1\. worker — failed/);
		assert.match(text, /single terminal failure/);
		assert.match(text, /Output:\n\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /single visible partial/);
		assert.doesNotMatch(text, /single hidden partial/);
		assert.equal(result.details?.results?.[0]?.outputMode, "file-only");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, undefined);
		assert.equal(result.details?.results?.[0]?.finalOutput, "single visible partial\nsingle hidden partial\nsingle final hidden");
	});

	it("file-only output-save failures return truncated output plus an actionable save error", async () => {
		const blockedParent = path.join(tempDir, "not-a-directory");
		fs.writeFileSync(blockedParent, "blocking file", "utf-8");
		const requestedOutput = path.join(blockedParent, "report.md");
		mockPi.onCall({ output: "save visible line\nsave hidden line\nsave final hidden" });
		const { executor, events } = makeExecutor();

		const result = await executor.execute(
			"single-file-save-failed",
			{
				agent: "worker",
				task: "Write report",
				output: requestedOutput,
				outputMode: "file-only",
				maxOutput: { lines: 1, bytes: 100 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Status: completed/);
		assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /save visible line/);
		assert.doesNotMatch(text, /save hidden line/);
		assert.match(text, /Output file error:/);
		assert.match(text, new RegExp(requestedOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, /(?:EEXIST|ENOTDIR|not a directory|file already exists)/i);
		assert.equal(result.details?.results?.[0]?.savedOutputPath, undefined);
		assert.ok(result.details?.results?.[0]?.outputSaveError);
		assert.equal(result.details?.results?.[0]?.finalOutput, "save visible line\nsave hidden line\nsave final hidden");
	});

	it("parallel native summaries retain save errors without leaking output beyond maxOutput", async () => {
		const blockedParent = path.join(tempDir, "parallel-not-a-directory");
		fs.writeFileSync(blockedParent, "blocking file", "utf-8");
		const requestedOutput = path.join(blockedParent, "report.md");
		mockPi.onCall({ output: "parallel visible line\nparallel hidden line\nparallel final hidden" });
		const { executor } = makeExecutor();

		const result = await executor.execute(
			"parallel-file-save-failed",
			{
				tasks: [{
					agent: "worker",
					task: "Write parallel report",
					output: requestedOutput,
					outputMode: "file-only",
				}],
				maxOutput: { lines: 1, bytes: 100 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Status: completed/);
		assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /parallel visible line/);
		assert.doesNotMatch(text, /parallel hidden line/);
		assert.match(text, /Output file error:/);
		const saveError = result.details?.results?.[0]?.outputSaveError;
		assert.ok(saveError);
		assert.match(saveError, new RegExp(blockedParent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, new RegExp(saveError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(result.details?.results?.[0]?.finalOutput, "parallel visible line\nparallel hidden line\nparallel final hidden");
	});

	it("chain native summaries retain save errors without leaking output beyond maxOutput", async () => {
		const blockedParent = path.join(tempDir, "chain-not-a-directory");
		fs.writeFileSync(blockedParent, "blocking file", "utf-8");
		const requestedOutput = path.join(blockedParent, "report.md");
		mockPi.onCall({ output: "chain visible line\nchain hidden line\nchain final hidden" });
		const { executor } = makeExecutor();

		const result = await executor.execute(
			"chain-file-save-failed",
			{
				chain: [{
					agent: "worker",
					task: "Write chain report",
					output: requestedOutput,
					outputMode: "file-only",
				}],
				maxOutput: { lines: 1, bytes: 100 },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Status: completed/);
		assert.match(text, /\[TRUNCATED: showing first 1 of 3 lines/);
		assert.match(text, /chain visible line/);
		assert.doesNotMatch(text, /chain hidden line/);
		assert.match(text, /Output file error:/);
		const saveError = result.details?.results?.[0]?.outputSaveError;
		assert.ok(saveError);
		assert.match(saveError, new RegExp(blockedParent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, new RegExp(saveError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(result.details?.results?.[0]?.finalOutput, "chain visible line\nchain hidden line\nchain final hidden");
	});

	it("paused foreground runs stay actionable and emit no grouped result event", async () => {
		mockPi.onCall({ delay: 10_000 });
		const { executor, events, state } = makeExecutor({ agents: [makeAgent("slow")] });

		const runPromise = executor.execute(
			"single-pause",
			{ agent: "slow", task: "Wait for interrupt" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const readyDeadline = Date.now() + 5_000;
		while (Date.now() < readyDeadline) {
			if (mockPi.callCount() === 1 && typeof ([...state.foregroundControls.values()][0] as { interrupt?: unknown } | undefined)?.interrupt === "function") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(mockPi.callCount(), 1);

		const interruptResult = await executor.execute(
			"single-pause-interrupt",
			{ action: "interrupt" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(interruptResult.content[0]?.text ?? "", /Interrupt requested for foreground run/);

		const result = await runPromise;
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /^Foreground run [a-z0-9-]+ paused after interrupt \(slow\)\./);
		assert.match(result.content[0]?.text ?? "", /Pause succeeded; this foreground run is paused and waiting for your explicit next action/);
		assert.match(result.content[0]?.text ?? "", /Resume: subagent\(\{ action: "resume", id: "[a-z0-9-]+", message: "\.\.\." \}\)/);
	});

	it("top-level parallel runs return one grouped native result containing all children", async () => {
		mockPi.onCall({ output: "Parallel child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Mode: parallel/);
		assert.match(result.content[0]?.text ?? "", /Children: 2 completed/);
		assert.match(result.content[0]?.text ?? "", /1\. a — completed/);
		assert.match(result.content[0]?.text ?? "", /2\. b — completed/);
		assert.match(result.content[0]?.text ?? "", /Summary:\nParallel child output/);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === "Parallel child output"), true);
	});

	it("top-level parallel native worktree results capture patch artifacts before cleanup", async () => {
		const repoDir = createRepo("pi-intercom-native-worktree-");
		const worktreeBaseDir = path.join(tempDir, "worktrees");
		mockPi.onCall({ output: "Parallel worktree child output", delay: 500 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a")], worktreeBaseDir });
		const runId = "parallel-native-worktree";

		try {
			const runPromise = executor.execute(
				runId,
				{ tasks: [{ agent: "a", task: "worktree-edit" }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);
			await waitFor(() => fs.existsSync(worktreeBaseDir) && fs.readdirSync(worktreeBaseDir).length > 0, `Timed out waiting for worktree base dir: ${worktreeBaseDir}`);
			const worktreeDir = path.join(worktreeBaseDir, fs.readdirSync(worktreeBaseDir)[0]!);
			fs.writeFileSync(path.join(worktreeDir, "tracked.txt"), "updated from worktree\n", "utf-8");
			fs.writeFileSync(path.join(worktreeDir, "new-file.ts"), "export const worktree = true;\n", "utf-8");

			const result = await runPromise;
			const text = result.content[0]?.text ?? "";
			assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
			assert.match(text, /Mode: parallel/);
			assert.match(text, /=== Worktree Changes ===/);
			assert.equal(text.match(/=== Worktree Changes ===/g)?.length ?? 0, 1);
			assert.equal(text.match(/Full patches:/g)?.length ?? 0, 1);
			const patchesDir = text.match(/Full patches: (.+)$/m)?.[1];
			assert.ok(patchesDir, "expected native result to reference patch artifacts");
			assert.ok(fs.existsSync(patchesDir), `expected patches dir to exist: ${patchesDir}`);
			const patchFiles = fs.readdirSync(patchesDir).filter((name) => name.endsWith(".patch"));
			assert.equal(patchFiles.length, 1);
			const patch = fs.readFileSync(path.join(patchesDir, patchFiles[0]!), "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.match(patch, /new-file\.ts/);
			assert.equal(fs.existsSync(worktreeDir), false, `worktree should be cleaned up: ${worktreeDir}`);
			assert.equal(fs.existsSync(worktreeBaseDir) ? fs.readdirSync(worktreeBaseDir).length : 0, 0);
			assert.equal(git(repoDir, ["branch", "--list", "pi-parallel-*"]).trim(), "");
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	it("chain runs return one grouped native result containing all executed children", async () => {
		mockPi.onCall({ output: "Chain child output" });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b"), makeAgent("c")] });

		const result = await executor.execute(
			"chain-intercom",
			{
				chain: [
					{ agent: "a", task: "step-a" },
					{ parallel: [{ agent: "b", task: "step-b" }, { agent: "c", task: "step-c" }] },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Mode: chain/);
		assert.match(result.content[0]?.text ?? "", /Chain steps: 2/);
		assert.match(result.content[0]?.text ?? "", /Children: 3 completed/);
		assert.match(result.content[0]?.text ?? "", /1\. a — completed/);
		assert.match(result.content[0]?.text ?? "", /2\. b — completed/);
		assert.match(result.content[0]?.text ?? "", /3\. c — completed/);
		assert.equal(result.details?.results?.every((entry) => entry.finalOutput === "Chain child output"), true);
	});

	it("chain native grouping preserves fallback notices after a retry", async () => {
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
		mockPi.onCall({ output: "Recovered chain step" });
		const { executor } = makeExecutor({ agents: [makeAgent("a", { model: "openai/gpt-5-mini" })] });

		const result = await executor.execute(
			"chain-fallback-notice",
			{
				chain: [{
					agent: "a",
					task: "step-a",
					fallbackModels: ["anthropic/claude-sonnet-4"],
					modelFallbackNotice: "Quota fallback engaged",
				}],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Mode: chain/);
		assert.match(result.content[0]?.text ?? "", /Summary:\nNotice: Quota fallback engaged\n\nRecovered chain step/);
		assert.deepEqual(result.details?.results?.[0]?.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.details?.results?.[0]?.modelFallbackNotice, "Quota fallback engaged");
		assert.equal(mockPi.callCount(), 2);
	});

	it("post-child dynamic collect-schema failures keep one failed native chain result", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		const { executor, events } = makeExecutor({ agents: [makeAgent("scout"), makeAgent("reviewer")] });

		const result = await executor.execute(
			"chain-dynamic-collect-schema-native-failure",
			{
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews", outputSchema: { type: "object" } },
						concurrency: 1,
					},
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Mode: chain/);
		assert.match(text, /Status: failed/);
		assert.match(text, /Children: 3 completed/);
		assert.match(text, /Error:\nCollected output validation failed/);
		assert.equal(text.match(/Collected output validation failed/g)?.length ?? 0, 1);
		assert.doesNotMatch(text, /=== Dynamic Item/);
		assert.doesNotMatch(text, /✅ Chain completed:/);
		assert.equal(result.details?.results?.length, 3);
		assert.deepEqual(result.details?.results?.map((entry) => entry.finalOutput), ["targets", "review-a", "review-b"]);
	});

	it("post-child dynamic aggregate acceptance failures keep one failed native chain result", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		const { executor, events } = makeExecutor({ agents: [makeAgent("scout"), makeAgent("reviewer")] });

		const result = await executor.execute(
			"chain-dynamic-aggregate-acceptance-native-failure",
			{
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						acceptance: { level: "verified", verify: [{ id: "dynamic-group-verify", command: "node -e \"process.exit(7)\"" }] },
						concurrency: 1,
					},
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Status: failed/);
		assert.match(text, /Children: 3 completed/);
		assert.match(text, /Error:\nAcceptance verification 'dynamic-group-verify' failed\./);
		assert.equal(text.match(/dynamic-group-verify/g)?.length ?? 0, 1);
		assert.equal(result.details?.results?.length, 3);
		assert.deepEqual(result.details?.results?.map((entry) => entry.finalOutput), ["targets", "review-a", "review-b"]);
	});

	it("failed chain foreground runs return native error context and preserve isError", async () => {
		mockPi.onCall({ output: "chain partial output", stderr: "chain terminal failure", exitCode: 1 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"chain-failed",
			{ chain: [{ agent: "a", task: "first failing step" }, { agent: "b", task: "must not run" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(text, /Mode: chain/);
		assert.match(text, /Status: failed/);
		assert.match(text, /Children: 1 failed/);
		assert.match(text, /1\. a — failed/);
		assert.match(text, /chain terminal failure/);
		assert.match(text, /Output:\n.*chain partial output/s);
		assert.equal(mockPi.callCount(), 1);
	});

	it("detached chain runs do not emit grouped completion receipts", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });
		let detachEmitted = false;

		const result = await executor.execute(
			"chain-detached-intercom",
			{
				chain: [
					{ agent: "a", task: "ask supervisor" },
					{ agent: "b", task: "must not run" },
				],
			},
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-detached" });
			},
			makeMinimalCtx(tempDir),
		);

		assert.equal(detachEmitted, true);
		assert.match(result.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /resume/);
		assert.equal(bus.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.equal(mockPi.callCount(), 1);
	});

	it("resume action sends a follow-up to a live async child when the target is registered", async () => {
		const runId = `resume-live-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 100,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({
				kill: (pid, signal) => {
					kills.push({ pid, signal });
					return true;
				},
			});

			const result = await executor.execute(
				"resume-live",
				{ action: "resume", id: runId, message: "Can you clarify the last change?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Interrupted live async child, then delivered follow-up/);
			assert.deepEqual(kills, [
				{ pid: process.pid, signal: 0 },
				{ pid: process.pid, signal: process.platform === "win32" ? "SIGBREAK" : "SIGUSR2" },
			]);
			const payload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload as { to?: string; message?: string } | undefined;
			assert.equal(payload?.to, `subagent-worker-${runId}-1`);
			assert.match(payload?.message ?? "", /Can you clarify the last change\?/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action can attach a live async child as the first step of a new chain", async () => {
		const sourceRunId = `resume-chain-root-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		const sourceSession = path.join(tempDir, "source-child.jsonl");
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(sourceSession, "", "utf-8");
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 100,
				lastUpdate: 100,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "running", sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			fs.writeFileSync(sourceResultPath, JSON.stringify({
				id: sourceRunId,
				agent: "worker",
				mode: "single",
				success: true,
				state: "complete",
				summary: "root output",
				results: [{ agent: "worker", output: "root output", success: true, sessionFile: sourceSession }],
			}, null, 2), "utf-8");
			const { executor, events } = makeExecutor({ agents: [makeAgent("worker"), makeAgent("reviewer")] });

			const result = await executor.execute(
				"resume-chain-root",
				{
					action: "resume",
					id: sourceRunId,
					chain: [{ agent: "reviewer", task: "Review this root result: {previous}" }],
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Attached async subagent/);
			const startedEvent = events.emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT)?.payload as { agent?: string; agents?: string[]; chain?: string[]; chainStepCount?: number } | undefined;
			assert.equal(startedEvent?.agent, "worker");
			assert.deepEqual(startedEvent?.agents, ["worker", "reviewer"]);
			assert.deepEqual(startedEvent?.chain, ["worker", "reviewer"]);
			assert.equal(startedEvent?.chainStepCount, 2);
			const attachedId = result.details?.asyncId;
			assert.ok(attachedId, "expected attached chain async id");
			assert.match(result.details?.asyncDir ?? "", new RegExp(`${attachedId}$`));
			const statusPath = path.join(result.details!.asyncDir!, "status.json");
			await waitForFile(statusPath);
			const attachedStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { mode?: string; chainStepCount?: number; steps?: Array<{ agent?: string; label?: string; status?: string }> };
			assert.equal(attachedStatus.mode, "chain");
			assert.equal(attachedStatus.chainStepCount, 2);
			assert.deepEqual(attachedStatus.steps?.map((step) => step.agent), ["worker", "reviewer"]);
			assert.match(attachedStatus.steps?.[0]?.label ?? "", /Attached resume-chain-root-/);
			await waitForFile(path.join(RESULTS_DIR, `${attachedId}.json`));
		} finally {
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
			fs.rmSync(sourceResultPath, { force: true });
		}
	});

	it("resume action can attach a completed async result without reviving from a session", async () => {
		const sourceRunId = `resume-chain-complete-root-${Date.now()}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		try {
			fs.mkdirSync(sourceAsyncDir, { recursive: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(path.join(sourceAsyncDir, "status.json"), JSON.stringify({
				runId: sourceRunId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			fs.writeFileSync(sourceResultPath, JSON.stringify({
				id: sourceRunId,
				agent: "worker",
				mode: "single",
				success: true,
				state: "complete",
				summary: "completed root output",
				results: [{ agent: "worker", output: "completed root output", success: true }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("worker"), makeAgent("reviewer")] });

			const reviveOnly = await executor.execute(
				"resume-chain-complete-root-revive-only",
				{ action: "resume", id: sourceRunId, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(reviveOnly.isError, true);
			assert.match(reviveOnly.content[0]?.text ?? "", /does not have a persisted session file/);

			const attached = await executor.execute(
				"resume-chain-complete-root",
				{
					action: "resume",
					id: sourceRunId,
					chain: [{ agent: "reviewer", task: "Review this completed root result: {previous}" }],
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(attached.isError, undefined);
			assert.match(attached.content[0]?.text ?? "", /Attached async subagent/);
			assert.ok(attached.details?.asyncId, "expected attached chain async id");
			await waitForFile(path.join(RESULTS_DIR, `${attached.details.asyncId}.json`));
		} finally {
			fs.rmSync(sourceAsyncDir, { recursive: true, force: true });
			fs.rmSync(sourceResultPath, { force: true });
		}
	});

	it("resume action revives completed async runs with the current session model when the child is unconfigured", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-inherit-model-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session-inherit-model.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor();

			const result = await executor.execute(
				"resume-revive-inherit-model",
				{ action: "resume", id: runId, message: "What changed?" },
				new AbortController().signal,
				undefined,
				{
					...makeMinimalCtx(tempDir),
					model: { provider: "github-copilot", id: "gpt-5-mini" },
				},
			);

			assert.equal(result.isError, undefined);
			const args = await readMockCallArgs(0);
			const modelIndex = args.indexOf("--model");
			assert.notEqual(modelIndex, -1);
			assert.equal(args[modelIndex + 1], "github-copilot/gpt-5-mini");
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps an explicit model override authoritative when reviving a completed async run", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-explicit-model-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session-explicit-model.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("worker", { model: "openai/gpt-4o" })] });

			const result = await executor.execute(
				"resume-revive-explicit-model",
				{ action: "resume", id: runId, message: "What changed?", model: "anthropic/claude-sonnet-4" },
				new AbortController().signal,
				undefined,
				{
					...makeMinimalCtx(tempDir),
					model: { provider: "github-copilot", id: "gpt-5-mini" },
				},
			);

			assert.equal(result.isError, undefined);
			const args = await readMockCallArgs(0);
			const modelIndex = args.indexOf("--model");
			assert.notEqual(modelIndex, -1);
			assert.equal(args[modelIndex + 1], "anthropic/claude-sonnet-4");
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives completed multi-child async runs by index", async () => {
		mockPi.onCall({ output: "revived async child b" });
		const runId = `resume-revive-multi-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const firstSession = path.join(tempDir, "child-a.jsonl");
		const secondSession = path.join(tempDir, "child-b.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "parallel",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

			const result = await executor.execute(
				"resume-revive-multi",
				{ action: "resume", id: runId, index: 1, message: "What did b find?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Agent: b/);
			assert.match(result.content[0]?.text ?? "", new RegExp(secondSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			const args = await readMockCallArgs(0);
			assert.equal(args[args.indexOf("--session") + 1], secondSession);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives paused async acceptance with paused-ledger provenance and monotonic overrides", async () => {
		mockPi.onCall({ delay: 10_000, output: "paused before acceptance" });
		mockPi.onCall({
			output: [
				"resume complete",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [
						{ id: "criterion-1", status: "satisfied", evidence: "Implemented the requested fix after resume." },
						{ id: "criterion-2", status: "satisfied", evidence: "Included the requested resume note." },
					],
					changedFiles: ["src/example.ts"],
					testsAddedOrUpdated: ["test/integration/intercom-result-delivery.test.ts"],
					commandsRun: [{ command: "npm test -- --runInBand", result: "passed", summary: "mocked" }],
					validationOutput: [],
					residualRisks: ["none"],
					noStagedFiles: true,
					diffSummary: "resumed fix only",
					reviewFindings: ["no blockers"],
					manualNotes: "Resume note included.",
				}),
				"```",
			].join("\n"),
		});
		const { executor } = makeExecutor({ bridgeMode: "off" });
		const started = await executor.execute(
			"resume-paused-acceptance-start",
			{
				agent: "worker",
				task: "Implement the paused acceptance fix",
				async: true,
				acceptance: {
					level: "checked",
					criteria: [{ id: "criterion-1", must: "Implement the requested change without widening scope" }],
					stopRules: ["Do not widen scope"],
				},
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const asyncId = started.details?.asyncId;
		assert.ok(asyncId, "expected async id");
		const pausedResumeWaitMs = process.platform === "win32" ? 30_000 : 15_000;
		await waitForAsyncStatusPredicate(
			asyncId,
			(status) => status.state === "running" && status.steps?.[0]?.status === "running" && !!(status.steps[0]?.sessionFile ?? status.sessionFile),
			"running child session",
			pausedResumeWaitMs,
		);

		const interrupted = await executor.execute(
			"resume-paused-acceptance-interrupt",
			{ action: "interrupt", id: asyncId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(interrupted.isError, undefined);
		await waitForAsyncStatusPredicate(
			asyncId,
			(status) => status.state === "paused"
				&& status.steps?.[0]?.status === "paused"
				&& status.steps[0]?.acceptance?.status === "skipped"
				&& !!(status.steps[0]?.sessionFile ?? status.sessionFile),
			"paused skipped acceptance ledger",
			pausedResumeWaitMs,
		);
		// Resume immediately after the first paused status write, before the
		// results payload lands: the paused status itself must already carry the
		// skipped acceptance ledger so the revival keeps the original contract.
		const resumed = await executor.execute(
			"resume-paused-acceptance-resume",
			{
				action: "resume",
				id: asyncId,
				message: "Finish the fix and include the resume note.",
				acceptance: {
					level: "attested",
					criteria: [{ id: "criterion-2", must: "Include the requested resume note" }],
					evidence: ["manual-notes"],
				},
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(
			resumed.isError,
			undefined,
			`resume returned isError; text=${JSON.stringify(resumed.content?.[0]?.text)} details=${JSON.stringify(resumed.details)}`,
		);
		const revivedId = resumed.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		await waitForFile(path.join(RESULTS_DIR, `${asyncId}.json`), pausedResumeWaitMs);
		const pausedPayload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${asyncId}.json`), "utf-8")) as {
			results?: Array<{ acceptance?: { status?: string; effectiveAcceptance?: { explicit?: boolean; level?: string; stopRules?: string[] } } }>;
		};
		assert.equal(pausedPayload.results?.[0]?.acceptance?.status, "skipped");
		assert.equal(pausedPayload.results?.[0]?.acceptance?.effectiveAcceptance?.explicit, true);
		assert.equal(pausedPayload.results?.[0]?.acceptance?.effectiveAcceptance?.level, "checked");
		await waitForFile(path.join(RESULTS_DIR, `${revivedId}.json`), pausedResumeWaitMs);
		const revivedPayload = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${revivedId}.json`), "utf-8")) as {
			results?: Array<{ acceptance?: { status?: string; effectiveAcceptance?: { level?: string; explicit?: boolean; criteria?: Array<{ id?: string }>; evidence?: string[]; stopRules?: string[] } } }>;
		};
		const revivedAcceptance = revivedPayload.results?.[0]?.acceptance?.effectiveAcceptance;
		assert.equal(revivedPayload.results?.[0]?.acceptance?.status, "checked");
		assert.equal(revivedAcceptance?.level, "checked");
		assert.equal(revivedAcceptance?.explicit, true);
		assert.deepEqual(revivedAcceptance?.criteria?.map((criterion) => criterion.id), ["criterion-1", "criterion-2"]);
		assert.equal(revivedAcceptance?.evidence?.includes("changed-files"), true);
		assert.equal(revivedAcceptance?.evidence?.includes("manual-notes"), true);
		assert.deepEqual(revivedAcceptance?.stopRules, ["Do not widen scope"]);
	});

	it("resume action revives completed async runs with concise status receipts", async () => {
		mockPi.onCall({ output: "revived answer" });
		const runId = `resume-revive-${Date.now()}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "child-session.jsonl");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor } = makeExecutor();

			const result = await executor.execute(
				"resume-revive",
				{ action: "resume", id: runId, message: "What changed?" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Revived async subagent from/);
			assert.match(result.content[0]?.text ?? "", /Status if needed: subagent\(\{ action: "status"/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /call wait\(\)/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /Follow:/);
			const revivedId = result.details?.asyncId;
			assert.ok(revivedId, "expected revived async id");
			const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action revives a completed foreground child by index", async () => {
		mockPi.onCall({ output: "first child done" });
		mockPi.onCall({ output: "second child done" });
		mockPi.onCall({ output: "revived foreground answer" });
		const { executor } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a"), makeAgent("b")] });

		const original = await executor.execute(
			"foreground-resume-original",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const revived = await executor.execute(
			"foreground-resume",
			{ action: "resume", id: runId, index: 1, message: "Follow up with b" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(revived.isError, undefined);
		assert.match(revived.content[0]?.text ?? "", /Revived foreground subagent from/);
		assert.match(revived.content[0]?.text ?? "", /Agent: b/);
		const reviveArgs = await readMockCallArgs(2);
		const selectedSession = original.details?.results?.[1]?.sessionFile;
		assert.ok(selectedSession, "expected selected child session file");
		assert.equal(reviveArgs[reviveArgs.indexOf("--session") + 1], selectedSession);
		const revivedId = revived.details?.asyncId;
		assert.ok(revivedId, "expected revived async id");
		const resultPath = path.join(RESULTS_DIR, `${revivedId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for revived result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	});

	it("status recovers remembered detached foreground output after child exit", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 50, jsonl: [events.assistantMessage("final recovered answer")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-status-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached-status" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /Detached for intercom coordination/);

		const deadline = Date.now() + 5000;
		let statusText = "";
		while (Date.now() < deadline) {
			const status = await executor.execute(
				"foreground-detached-status",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			statusText = status.content[0]?.text ?? "";
			if (/final recovered answer/.test(statusText)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.doesNotMatch(statusText, /Async run not found/);
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /a completed/);
		assert.match(statusText, /final recovered answer/);

		const transcript = await executor.execute(
			"foreground-detached-transcript",
			{ action: "status", id: runId, view: "transcript" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const transcriptText = transcript.content[0]?.text ?? "";
		assert.doesNotMatch(transcriptText, /Async run not found/);
		assert.match(transcriptText, /final recovered answer/);
	});

	it("status recovers remembered detached chain output after child exit", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 50, jsonl: [events.assistantMessage("chain recovered answer")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("b")] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-chain-status-original",
			{ chain: [{ agent: "a", task: "ask supervisor" }, { agent: "b", task: "must not run" }] },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "chain-detached-status" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.equal(mockPi.callCount(), 1);

		const deadline = Date.now() + 5000;
		let statusText = "";
		while (Date.now() < deadline) {
			const status = await executor.execute(
				"foreground-detached-chain-status",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			statusText = status.content[0]?.text ?? "";
			if (/chain recovered answer/.test(statusText)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.doesNotMatch(statusText, /Async run not found/);
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /a completed/);
		assert.match(statusText, /chain recovered answer/);

		const transcript = await executor.execute(
			"foreground-detached-chain-transcript",
			{ action: "status", id: runId, index: 0, view: "transcript" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(transcript.content[0]?.text ?? "", /chain recovered answer/);
	});

	it("status recovers a later detached serial chain child under its original index", async () => {
		mockPi.onCall({ output: "first step done" });
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 200, jsonl: [events.assistantMessage("second recovered answer")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b", { systemPrompt: "Intercom orchestration channel:" }), makeAgent("c")] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-later-detached-chain-status-original",
			{ chain: [{ agent: "a", task: "first" }, { agent: "b", task: "ask supervisor" }, { agent: "c", task: "must not run" }] },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "later-chain-detached-status" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");
		assert.match(original.content[0]?.text ?? "", /Chain detached for intercom coordination/);
		assert.equal(mockPi.callCount(), 2);

		const deadline = Date.now() + 5000;
		let statusText = "";
		while (Date.now() < deadline) {
			const status = await executor.execute(
				"foreground-later-detached-chain-status",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			statusText = status.content[0]?.text ?? "";
			if (/second recovered answer/.test(statusText)) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.doesNotMatch(statusText, /Async run not found/);
		assert.match(statusText, /State: remembered foreground/);
		assert.match(statusText, /a completed/);
		assert.match(statusText, /b completed/);
		assert.match(statusText, /second recovered answer/);

		const transcript = await executor.execute(
			"foreground-later-detached-chain-transcript",
			{ action: "status", id: runId, index: 1, view: "transcript" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(transcript.content[0]?.text ?? "", /second recovered answer/);
	});

	it("resume action rejects detached foreground children that may still be live", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const { executor, events: bus } = makeExecutor({ agents: [makeAgent("a", { systemPrompt: "Intercom orchestration channel:" })] });
		let detachEmitted = false;
		const original = await executor.execute(
			"foreground-detached-original",
			{ agent: "a", task: "ask supervisor" },
			new AbortController().signal,
			(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
				if (detachEmitted) return;
				if (!update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "single-detached" });
			},
			makeMinimalCtx(tempDir),
		);
		assert.equal(detachEmitted, true);
		const runId = original.details?.runId;
		assert.ok(runId, "expected foreground run id");

		const resumed = await executor.execute(
			"foreground-detached-resume",
			{ action: "resume", id: runId, message: "Follow up" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumed.isError, true);
		assert.match(resumed.content[0]?.text ?? "", /detached for intercom coordination/);
		assert.match(resumed.content[0]?.text ?? "", /Reply to the supervisor request first/);
		assert.doesNotMatch(resumed.content[0]?.text ?? "", /revive only/);
	});

	it("resume action keeps exact foreground validation errors over async prefix matches", async () => {
		const base = `exact-invalid-${Date.now()}`;
		const asyncSession = path.join(tempDir, "async-exact-prefix.jsonl");
		fs.writeFileSync(asyncSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, `${base}-async`);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: `${base}-async`,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(base, {
				runId: base,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed" }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-foreground",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Foreground run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action keeps exact async validation errors over foreground prefix matches", async () => {
		const base = `exact-invalid-async-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-exact-prefix.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		const asyncDir = path.join(ASYNC_DIR, base);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: base,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete" }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"resume-exact-invalid-async",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Async run '.+' child 0 does not have a persisted session file/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports async ambiguity even when foreground has one prefix match", async () => {
		const base = `namespace-ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground-prefix.jsonl");
		const firstAsyncSession = path.join(tempDir, "async-a.jsonl");
		const secondAsyncSession = path.join(tempDir, "async-b.jsonl");
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(firstAsyncSession, "", "utf-8");
		fs.writeFileSync(secondAsyncSession, "", "utf-8");
		const firstAsyncDir = path.join(ASYNC_DIR, `${base}-async-a`);
		const secondAsyncDir = path.join(ASYNC_DIR, `${base}-async-b`);
		try {
			for (const [asyncDir, runId, sessionFile] of [[firstAsyncDir, `${base}-async-a`, firstAsyncSession], [secondAsyncDir, `${base}-async-b`, secondAsyncSession]] as const) {
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
					runId,
					mode: "single",
					state: "complete",
					startedAt: 100,
					lastUpdate: 200,
					cwd: tempDir,
					steps: [{ agent: "a", status: "complete", sessionFile }],
				}, null, 2), "utf-8");
			}
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(`${base}-foreground`, {
				runId: `${base}-foreground`,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-async-prefix-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Ambiguous subagent run id prefix/);
		} finally {
			fs.rmSync(firstAsyncDir, { recursive: true, force: true });
			fs.rmSync(secondAsyncDir, { recursive: true, force: true });
		}
	});

	it("resume action reports ambiguous ids across remembered foreground and async runs", async () => {
		const base = `ambiguous-${Date.now()}`;
		const foregroundSession = path.join(tempDir, "foreground.jsonl");
		const asyncSession = path.join(tempDir, "async.jsonl");
		const asyncId = `${base}-async`;
		const foregroundId = `${base}-foreground`;
		const asyncDir = path.join(ASYNC_DIR, asyncId);
		fs.writeFileSync(foregroundSession, "", "utf-8");
		fs.writeFileSync(asyncSession, "", "utf-8");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: asyncId,
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				steps: [{ agent: "a", status: "complete", sessionFile: asyncSession }],
			}, null, 2), "utf-8");
			const { executor, state } = makeExecutor({ bridgeMode: "off", agents: [makeAgent("a")] });
			state.foregroundRuns.set(foregroundId, {
				runId: foregroundId,
				mode: "single",
				cwd: tempDir,
				updatedAt: Date.now(),
				children: [{ agent: "a", index: 0, status: "completed", sessionFile: foregroundSession }],
			});

			const result = await executor.execute(
				"ambiguous-resume",
				{ action: "resume", id: base, message: "Follow up" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /ambiguous between foreground run/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("mixed foreground outcomes produce failed native grouped status and counts", async () => {
		mockPi.onCall({ matchArgIncludes: "task-a", output: "Parallel child success", exitCode: 0 });
		mockPi.onCall({ matchArgIncludes: "task-b", output: "Parallel child failure", stderr: "Parallel child failure", exitCode: 1 });
		const { executor, events } = makeExecutor({ agents: [makeAgent("a"), makeAgent("b")] });

		const result = await executor.execute(
			"parallel-mixed-intercom",
			{ tasks: [{ agent: "a", task: "task-a" }, { agent: "b", task: "task-b" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(events.emitted.some((entry) => entry.channel === "subagent:result-intercom"), false);
		assert.match(result.content[0]?.text ?? "", /Status: failed/);
		assert.match(result.content[0]?.text ?? "", /Children: 1 completed, 1 failed/);
		assert.match(result.content[0]?.text ?? "", /1\. a — completed/);
		assert.match(result.content[0]?.text ?? "", /2\. b — failed/);
		assert.match(result.content[0]?.text ?? "", /Parallel child failure/);
	});
});
