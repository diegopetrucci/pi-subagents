import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";

let tempDir = "";
const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;

function restoreEnv(): void {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text;
}

function writeAgent(filePath: string, name: string, description: string, prompt: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n${prompt}\n`, "utf-8");
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("agent management config parsing", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
	});

	afterEach(() => {
		restoreEnv();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("surfaces JSON parse errors for create config strings", () => {
		const result = handleCreate(
			{ config: '{"name":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("surfaces JSON parse errors for update config strings", () => {
		const result = handleUpdate(
			{ agent: "reviewer", config: '{"description":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("gets agent details only from the requested scope", () => {
		const home = path.join(tempDir, "home");
		const agentDir = path.join(tempDir, "tlh", "agent");
		const project = path.join(home, "project");
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		writeAgent(path.join(agentDir, "tlh", "agents", "subagents", "developer.md"), "developer", "TLH developer", "TLH developer prompt");
		writeAgent(path.join(project, ".pi", "agents", "developer.md"), "developer", "Project developer", "PROJECT developer prompt");
		writeJson(path.join(agentDir, "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentDirs: ["tlh/agents/subagents"],
			},
		});

		const ctx = { cwd: project, modelRegistry: { getAvailable: () => [] } };
		const userScoped = handleManagementAction("get", { agent: "developer", agentScope: "user" }, ctx);
		assert.equal(userScoped.isError, false);
		const userText = readText(userScoped);
		assert.match(userText, /Agent: developer \(user\)/);
		assert.match(userText, /TLH developer prompt/);
		assert.doesNotMatch(userText, /Project developer/);
		assert.doesNotMatch(userText, /PROJECT developer prompt/);

		const projectScoped = handleManagementAction("get", { agent: "developer", agentScope: "project" }, ctx);
		assert.equal(projectScoped.isError, false);
		const projectText = readText(projectScoped);
		assert.match(projectText, /Agent: developer \(project\)/);
		assert.match(projectText, /PROJECT developer prompt/);
		assert.doesNotMatch(projectText, /TLH developer prompt/);
	});

	it("creates, gets, updates, and deletes a packaged agent by runtime name", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "Code Analysis", description: "Fast recon", scope: "project", systemPrompt: "Inspect" } },
			ctx,
		);

		assert.equal(created.isError, false);
		assert.match(readText(created), /Created agent 'code-analysis.scout'/);
		const filePath = path.join(tempDir, ".pi", "agents", "code-analysis.scout.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.doesNotMatch(content, /^name: code-analysis\.scout$/m);

		const got = handleManagementAction("get", { agent: "code-analysis.scout" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Agent: code-analysis\.scout/);
		assert.match(readText(got), /Local name: scout/);
		assert.match(readText(got), /Package: code-analysis/);

		const updated = handleUpdate(
			{ agent: "code-analysis.scout", config: { package: "documentation" } },
			ctx,
		);
		assert.equal(updated.isError, false);
		assert.match(readText(updated), /code-analysis\.scout' to 'documentation\.scout'/);
		assert.equal(fs.existsSync(filePath), false);
		const updatedPath = path.join(tempDir, ".pi", "agents", "documentation.scout.md");
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: documentation$/m);

		const deleted = handleManagementAction("delete", { agent: "documentation.scout" }, ctx);
		assert.equal(deleted.isError, false);
		assert.equal(fs.existsSync(updatedPath), false);
	});

	it("rejects package values that cannot be normalized", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "!!!", description: "Fast recon", scope: "project" } },
			ctx,
		);

		assert.equal(created.isError, true);
		assert.match(readText(created), /config\.package is invalid/);
	});

	it("creates and updates packaged chains while preserving packaged step names", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "agents", "code-analysis.scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`, "utf-8");

		const created = handleCreate(
			{ config: { name: "Review Flow", package: "Code Analysis", description: "Review flow", scope: "project", steps: [{ agent: "code-analysis.scout", task: "Inspect" }] } },
			ctx,
		);
		assert.equal(created.isError, false);
		assert.match(readText(created), /Created chain 'code-analysis.review-flow'/);
		const filePath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.match(content, /^## code-analysis\.scout$/m);

		const updated = handleUpdate(
			{ chainName: "code-analysis.review-flow", config: { package: false } },
			ctx,
		);
		assert.equal(updated.isError, false);
		const updatedPath = path.join(tempDir, ".pi", "chains", "review-flow.chain.md");
		assert.equal(fs.existsSync(filePath), false);
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.doesNotMatch(content, /^package:/m);
	});

	it("creates agents with completion guard disabled", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", tools: "read, grep, bash, ls", completionGuard: false } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "test-runner.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^completionGuard: false$/m);

		const got = handleManagementAction("get", { agent: "test-runner" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Completion guard: false/);
	});

	it("rejects non-boolean completion guard config", () => {
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", completionGuard: "false" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config\.completionGuard must be a boolean/);
	});

	it("creates delegate with its builtin prompt defaults", () => {
		const result = handleCreate(
			{ config: { name: "delegate", description: "Delegate helper", scope: "project" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "delegate.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /systemPromptMode: append/);
		assert.match(content, /inheritProjectContext: true/);
		assert.match(content, /inheritSkills: false/);
	});
});
