import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";
import { clearSkillCache, discoverAvailableSkills, resolveSkills } from "../../src/agents/skills.ts";
import { recordRun } from "../../src/runs/shared/run-history.ts";
import { getProjectConfigDir } from "../../src/shared/config-dir.ts";
import { getLegacyGlobalAgentsDir, getPiAgentDir } from "../../src/shared/profile.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtraAgentDirs = process.env[EXTRA_AGENT_DIRS_ENV];

function restoreEnv(): void {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	if (originalExtraAgentDirs === undefined) delete process.env[EXTRA_AGENT_DIRS_ENV];
	else process.env[EXTRA_AGENT_DIRS_ENV] = originalExtraAgentDirs;
	clearSkillCache();
}

function setTestHome(home: string): void {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
}

function writeAgent(filePath: string, name: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n${name} prompt\n`);
}

function writeSkill(filePath: string, description: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\ndescription: ${description}\n---\n${description} body\n`);
}

function writeChain(filePath: string, name: string, agent: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n\n## ${agent}\n\n${name} task\n`);
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
		setTestHome(home);
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
		setTestHome(home);
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

	it("discovers package-provided agent-dir bundles while keeping explicit user agents ahead of them", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-dir-package-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const project = path.join(home, "project");
		fs.mkdirSync(project, { recursive: true });
		setTestHome(home);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		writeJson(path.join(agentDir, "package.json"), {
			pi: {
				subagents: {
					agents: ["bundled/agents"],
					chains: ["bundled/chains"],
				},
			},
		});
		writeAgent(path.join(agentDir, "bundled", "agents", "developer.md"), "developer");
		writeChain(path.join(agentDir, "bundled", "chains", "review.chain.md"), "review", "developer");
		writeAgent(path.join(agentDir, "agents", "developer.md"), "developer");

		const runtimeAgent = discoverAgents(project, "both").agents.find((agent) => agent.name === "developer");
		assert.equal(runtimeAgent?.source, "user");
		assert.equal(runtimeAgent?.filePath, path.join(agentDir, "agents", "developer.md"));

		const all = discoverAgentsAll(project);
		assert.equal(all.package.find((agent) => agent.name === "developer")?.source, "package");
		assert.ok(all.chains.find((chain) => chain.name === "review" && chain.source === "package"));
	});

	it("keeps the current project package bundle visible in user scope without pulling project-installed package roots", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-package-user-scope-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const project = path.join(home, "project");
		fs.mkdirSync(project, { recursive: true });
		setTestHome(home);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		writeJson(path.join(project, "package.json"), {
			"pi-subagents": {
				agents: ["package-agents"],
			},
		});
		writeAgent(path.join(project, "package-agents", "project-package-agent.md"), "project-package-agent");

		const settingsPackageRoot = path.join(project, "vendor", "settings-package");
		writeJson(path.join(settingsPackageRoot, "package.json"), {
			"pi-subagents": {
				agents: ["agents"],
			},
		});
		writeAgent(path.join(settingsPackageRoot, "agents", "settings-package-agent.md"), "settings-package-agent");
		writeJson(path.join(getProjectConfigDir(project), "settings.json"), { packages: ["file:../vendor/settings-package"] });

		const installedPackageRoot = path.join(getProjectConfigDir(project), "npm", "node_modules", "installed-subagents");
		writeJson(path.join(installedPackageRoot, "package.json"), {
			"pi-subagents": {
				agents: ["agents"],
			},
		});
		writeAgent(path.join(installedPackageRoot, "agents", "installed-package-agent.md"), "installed-package-agent");

		const runtimeAgents = discoverAgents(project, "user").agents;
		assert.equal(runtimeAgents.find((agent) => agent.name === "project-package-agent")?.source, "package");
		assert.equal(runtimeAgents.some((agent) => agent.name === "settings-package-agent"), false);
		assert.equal(runtimeAgents.some((agent) => agent.name === "installed-package-agent"), false);
	});

	it("prefers configured user agent dirs over PI_SUBAGENT_EXTRA_AGENT_DIRS", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-configured-dir-priority-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const extraDir = path.join(root, "extra", "agents");
		const configuredDir = path.join(agentDir, "tlh", "agents", "subagents");
		const project = path.join(home, "project");
		fs.mkdirSync(project, { recursive: true });
		setTestHome(home);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env[EXTRA_AGENT_DIRS_ENV] = extraDir;

		writeAgent(path.join(extraDir, "developer.md"), "developer");
		writeAgent(path.join(configuredDir, "developer.md"), "developer");
		writeJson(path.join(agentDir, "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentDirs: ["tlh/agents/subagents"],
			},
		});

		const [developer] = discoverAgents(project, "both").agents.filter((agent) => agent.name === "developer");
		assert.equal(developer.filePath, path.join(configuredDir, "developer.md"));
	});

	it("lets user-owned profile agents override configured and extra agent dirs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-extra-dir-priority-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const extraDir = path.join(root, "extra", "agents");
		const project = path.join(home, "project");
		fs.mkdirSync(project, { recursive: true });
		setTestHome(home);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env[EXTRA_AGENT_DIRS_ENV] = extraDir;

		writeAgent(path.join(extraDir, "developer.md"), "developer");
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

	it("uses the runtime project config dir for project agent discovery", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-config-dir-"));
		const home = path.join(root, "home");
		const project = path.join(home, "workspace", "app");
		const nested = path.join(project, "src", "feature");
		fs.mkdirSync(nested, { recursive: true });
		setTestHome(home);

		writeAgent(path.join(project, ".agents", "legacy.md"), "legacy");
		writeAgent(path.join(getProjectConfigDir(project), "agents", "canonical.md"), "canonical");

		const discovered = discoverAgentsAll(nested);
		assert.equal(discovered.projectDir, path.join(getProjectConfigDir(project), "agents"));
		assert.ok(discovered.project.some((agent) => agent.name === "legacy"));
		assert.ok(discovered.project.some((agent) => agent.name === "canonical"));
	});

	it("loads user skills from PI_CODING_AGENT_DIR and ignores legacy ~/.agents skills", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-skills-profile-"));
		const home = path.join(root, "home");
		const agentDir = path.join(root, "tlh", "agent");
		const project = home;
		fs.mkdirSync(project, { recursive: true });
		setTestHome(home);
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
