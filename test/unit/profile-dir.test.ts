import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { clearSkillCache, discoverAvailableSkills, resolveSkills } from "../../src/agents/skills.ts";
import { recordRun } from "../../src/runs/shared/run-history.ts";
import { getLegacyGlobalAgentsDir, getPiAgentDir } from "../../src/shared/profile.ts";

const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;

function restoreEnv(): void {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	clearSkillCache();
}

function writeAgent(filePath: string, name: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n${name} prompt\n`);
}

function writeSkill(filePath: string, description: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\ndescription: ${description}\n---\n${description} body\n`);
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

describe("PI_CODING_AGENT_DIR profile isolation", () => {
	afterEach(restoreEnv);

	it("roots user agents, chains, and settings in PI_CODING_AGENT_DIR and ignores legacy ~/.agents", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-profile-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh profile", "agent");
		const project = path.join(home, "work", "project");
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		writeAgent(path.join(home, ".agents", "legacy.md"), "legacy-leak");
		writeAgent(path.join(home, ".pi", "agent", "agents", "fallback.md"), "fallback-profile-leak");
		writeAgent(path.join(agentDir, "agents", "custom.md"), "custom-profile-agent");

		assert.equal(getPiAgentDir(), agentDir);
		assert.equal(getLegacyGlobalAgentsDir(), undefined);

		const runtimeAgents = discoverAgents(project, "both").agents.map((agent) => agent.name);
		assert.ok(runtimeAgents.includes("custom-profile-agent"));
		assert.ok(!runtimeAgents.includes("legacy-leak"));
		assert.ok(!runtimeAgents.includes("fallback-profile-leak"));

		const all = discoverAgentsAll(project);
		assert.equal(all.userDir, path.join(agentDir, "agents"));
		assert.equal(all.userChainDir, path.join(agentDir, "chains"));
		assert.equal(all.userSettingsPath, path.join(agentDir, "settings.json"));

		recordRun("custom-profile-agent", "task", 0, 10);
		assert.ok(fs.existsSync(path.join(agentDir, "run-history.jsonl")));
		assert.equal(fs.existsSync(path.join(home, ".pi", "agent", "run-history.jsonl")), false);
	});

	it("loads configured user agent dirs relative to PI_CODING_AGENT_DIR", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-extra-dirs-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const project = path.join(home, "project");
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		writeAgent(path.join(agentDir, "tlh", "agents", "subagents", "developer.md"), "developer");
		writeJson(path.join(agentDir, "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentDirs: ["tlh/agents/subagents"],
			},
		});

		const runtimeAgents = discoverAgents(project, "both").agents.map((agent) => agent.name);
		assert.deepEqual(runtimeAgents, ["developer"]);

		const all = discoverAgentsAll(project);
		assert.deepEqual(all.user.map((agent) => agent.name), ["developer"]);
	});

	it("lets user-owned profile agents override configured agent dirs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-extra-dir-priority-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const project = path.join(home, "project");
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		writeAgent(path.join(agentDir, "tlh", "agents", "subagents", "developer.md"), "developer");
		writeAgent(path.join(agentDir, "agents", "developer.md"), "developer");
		writeJson(path.join(agentDir, "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentDirs: ["tlh/agents/subagents"],
			},
		});

		const [developer] = discoverAgents(project, "both").agents.filter((agent) => agent.name === "developer");
		assert.equal(developer.filePath, path.join(agentDir, "agents", "developer.md"));
	});

	it("loads user skills from PI_CODING_AGENT_DIR and ignores legacy ~/.agents skills", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-skills-profile-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const project = home;
		fs.mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		clearSkillCache();

		writeSkill(path.join(home, ".agents", "skills", "legacy-skill", "SKILL.md"), "legacy skill");
		writeSkill(path.join(home, ".pi", "agent", "skills", "fallback-skill", "SKILL.md"), "fallback skill");
		writeSkill(path.join(agentDir, "skills", "profile-skill", "SKILL.md"), "profile skill");

		const available = discoverAvailableSkills(project).map((skill) => skill.name);
		assert.ok(available.includes("profile-skill"));
		assert.ok(!available.includes("legacy-skill"));
		assert.ok(!available.includes("fallback-skill"));

		const resolved = resolveSkills(["profile-skill", "legacy-skill", "fallback-skill"], project);
		assert.deepEqual(resolved.resolved.map((skill) => skill.name), ["profile-skill"]);
		assert.deepEqual(resolved.missing, ["legacy-skill", "fallback-skill"]);
	});
});
