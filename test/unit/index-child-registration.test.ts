import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/wait.ts";
import { promptTemplateDelegationParams } from "../../src/extension/index.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[SUBAGENT_FANOUT_CHILD_ENV];
	delete env[WAIT_TOOL_ENABLED_ENV];
	return env;
}

describe("prompt-template delegation adapter", () => {
	it("omits clarify from supported single and parallel executor requests", () => {
		const single = promptTemplateDelegationParams({
			agent: "worker",
			task: "Do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});
		const parallel = promptTemplateDelegationParams({
			agent: "",
			task: "",
			tasks: [{ agent: "worker", task: "Do work" }, { agent: "reviewer", task: "Review work" }],
			context: "fork",
			model: "openai/gpt-5",
			cwd: "/repo",
			worktree: true,
		});

		assert.equal("clarify" in single, false);
		assert.equal("clarify" in parallel, false);
		assert.deepEqual(single, {
			agent: "worker",
			task: "Do work",
			context: "fresh",
			cwd: "/repo",
			model: "openai/gpt-5",
			async: false,
		});
		assert.deepEqual(parallel, {
			tasks: [{ agent: "worker", task: "Do work" }, { agent: "reviewer", task: "Review work" }],
			context: "fork",
			cwd: "/repo",
			worktree: true,
			async: false,
		});
	});
});

describe("subagent extension child mode", () => {
	it("collapses tool detail before direct subagent tool execution", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const calls = [];
			const ctx = {
				cwd: process.cwd(),
				hasUI: true,
				ui: {
					setToolsExpanded(value) { calls.push(value); },
					setWidget() {},
					requestRender() {},
					theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } },
				},
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			await registeredTool.execute("collapse-check", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (calls[0] !== false) throw new Error("expected setToolsExpanded(false), got " + JSON.stringify(calls));
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("shows async badge for direct async single and parallel calls", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const theme = { fg(_name, text) { return text; }, bold(text) { return text; } };
			const asyncSingle = registeredTool.renderCall({ agent: "worker", async: true }, theme).text;
			const asyncParallel = registeredTool.renderCall({ tasks: [{ agent: "worker" }, { agent: "reviewer", count: 2 }], async: true }, theme).text;
			if (!asyncSingle.includes("[async]")) throw new Error("expected async single badge, got " + asyncSingle);
			if (!asyncParallel.includes("parallel (3) [async]")) throw new Error("expected async parallel badge, got " + asyncParallel);
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, env: parentToolEnv(), stdio: "pipe" },
		);
	});

	it("honors waitTool disabled config for the registered wait tool", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wait-tool-config-"));
		try {
			const configDir = path.join(agentDir, "extensions", "subagent");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ waitTool: { enabled: false } }), "utf-8");

			const script = String.raw`
				import registerSubagentExtension from "./src/extension/index.ts";
				const events = { on() { return () => {}; }, emit() {} };
				let waitTool;
				const fakePi = new Proxy({
					events,
					registerTool(tool) { if (tool.name === "wait") waitTool = tool; },
					registerCommand() {},
					registerShortcut() {},
					registerMessageRenderer() {},
					sendMessage() {},
					getSessionName() { return undefined; },
				}, {
					get(target, prop) {
						if (prop in target) return target[prop];
						return () => undefined;
					},
				});
				registerSubagentExtension(fakePi);
				if (!waitTool) throw new Error("wait tool not registered");
				const result = await waitTool.execute("wait-disabled", {}, new AbortController().signal, undefined, {});
				process.stdout.write(JSON.stringify(result.content[0].text));
			`;

			const env = parentToolEnv();
			env.PI_CODING_AGENT_DIR = agentDir;
			const output = execFileSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--import",
					"./test/support/register-loader.mjs",
					"--input-type=module",
					"--eval",
					script,
				],
				{ cwd: projectRoot, env, encoding: "utf-8" },
			);
			assert.match(JSON.parse(output) as string, /disabled/i);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("returns before registering anything for non-fanout children", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
			const calls = [];
			const fakePi = new Proxy({}, {
				get(_target, prop) {
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (calls.length > 0) {
				throw new Error("Unexpected child-mode registrations: " + calls.join(", "));
			}
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});

	it("returns before registering anything for fanout children", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			const calls = [];
			const fakePi = new Proxy({}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return (..._args) => {
						calls.push(String(prop));
						return undefined;
					};
				},
			});
			registerSubagentExtension(fakePi);
			if (calls.length > 0) {
				throw new Error("Unexpected child-mode registrations: " + calls.join(", "));
			}
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});

	it("does not double-register the child-safe subagent tool when index and fanout-child both load", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			import registerFanoutChildSubagentExtension from "./src/extension/fanout-child.ts";
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

			const registeredNames = new Set();
			const registrations = [];
			function makePi(source) {
				return {
					events: { on() { return () => {}; }, emit() {} },
					registerTool(tool) {
						if (registeredNames.has(tool.name)) {
							throw new Error("Tool " + tool.name + " conflicts with " + source);
						}
						registeredNames.add(tool.name);
						registrations.push({ source, name: tool.name });
					},
					getSessionName() { return undefined; },
				};
			}

			registerSubagentExtension(makePi("index.ts"));
			registerFanoutChildSubagentExtension(makePi("fanout-child.ts"));
			if (registrations.length !== 1 || registrations[0].name !== "subagent" || registrations[0].source !== "fanout-child.ts") {
				throw new Error("expected only fanout-child.ts to register subagent, got " + JSON.stringify(registrations));
			}
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});

	it("lets fanout children call read-only list but blocks mutating management actions", () => {
		const script = String.raw`
			import registerFanoutChildSubagentExtension from "./src/extension/fanout-child.ts";
			import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			let registeredTool;
			const fakePi = {
				events: { on() { return () => {}; }, emit() {} },
				registerTool(tool) { registeredTool = tool; },
				getSessionName() { return undefined; },
			};
			registerFanoutChildSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: { getSessionId() { return "session-test"; }, getSessionFile() { return null; } },
				modelRegistry: { getAvailable() { return []; } },
			};
			const list = await registeredTool.execute("list-check", { action: "list" }, new AbortController().signal, undefined, ctx);
			if (list.isError) throw new Error("list should be allowed: " + JSON.stringify(list.content));
			const create = await registeredTool.execute("create-check", { action: "create", config: { name: "x" } }, new AbortController().signal, undefined, ctx);
			if (!create.isError) throw new Error("create should be blocked");
			const text = create.content?.[0]?.text ?? "";
			// After ps-519q: create is no longer in SUBAGENT_ACTIONS (trimmed to 8), so it hits
			// the Unknown-action check before the child-safe fanout check. Both behaviors block
			// create; the error message changed.
			if (!text.includes("Unknown action: create")) throw new Error("unexpected create error: " + text);
		`;

		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
			],
			{ cwd: projectRoot, stdio: "pipe" },
		);
	});
});
