import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	return env;
}

describe("subagent extension child mode", () => {
	it("registers the pause-all shortcut in parent mode", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			let shortcutKey;
			let shortcutDescription;
			const events = { on() { return () => {}; }, emit() {} };
			const fakePi = new Proxy({
				events,
				registerTool() {},
				registerCommand() {},
				registerShortcut(key, spec) { shortcutKey = key; shortcutDescription = spec?.description; },
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
			if (shortcutKey !== "ctrl+shift+u") throw new Error("expected ctrl+shift+u shortcut, got " + String(shortcutKey));
			if (shortcutDescription !== "Pause all running subagent work") throw new Error("unexpected shortcut description: " + String(shortcutDescription));
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

	it("collapses tool detail before direct subagent tool execution", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { registeredTool = tool; },
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

	it("returns before registering parent tools, slash commands, renderers, or event handlers", () => {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			import { SUBAGENT_CHILD_ENV } from "./src/runs/shared/pi-args.ts";
			process.env[SUBAGENT_CHILD_ENV] = "1";
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
});
