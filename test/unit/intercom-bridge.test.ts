import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import {
	applyIntercomBridgeToAgent,
	diagnoseIntercomBridge,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
	resolveIntercomBridgeMode,
	type IntercomBridgeState,
} from "../../src/intercom/intercom-bridge.ts";
import { getProjectConfigDir } from "../../src/shared/utils.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Test worker",
		systemPrompt: "Base prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
		...overrides,
	};
}

describe("resolveIntercomBridgeMode", () => {
	it("defaults unknown values to always", () => {
		assert.equal(resolveIntercomBridgeMode(undefined), "always");
		assert.equal(resolveIntercomBridgeMode("nope"), "always");
	});

	it("accepts explicit modes", () => {
		assert.equal(resolveIntercomBridgeMode("off"), "off");
		assert.equal(resolveIntercomBridgeMode("fork-only"), "fork-only");
		assert.equal(resolveIntercomBridgeMode("always"), "always");
	});
});

describe("resolveIntercomSessionTarget", () => {
	it("prefers an explicit session name", () => {
		assert.equal(resolveIntercomSessionTarget("planner", "session-12345678"), "planner");
	});

	it("uses a runtime-only subagent chat alias when unnamed", () => {
		assert.equal(resolveIntercomSessionTarget(undefined, "session-12345678"), "subagent-chat-12345678");
	});
});

describe("resolveSubagentIntercomTarget", () => {
	it("builds stable child session targets from run metadata", () => {
		assert.equal(resolveSubagentIntercomTarget("78f659a3", "worker"), "subagent-worker-78f659a3");
		assert.equal(resolveSubagentIntercomTarget("78f659a3", "senior executor", 1), "subagent-senior-executor-78f659a3-2");
	});
});

function writePiIntercomPackage(packageDir: string, packageName = "pi-intercom"): void {
	fs.mkdirSync(packageDir, { recursive: true });
	fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: packageName, pi: { extensions: ["./index.ts"] } }, null, 2));
}

function withMalformedIntercomConfig<T>(fn: (paths: { extensionDir: string; configPath: string }) => T): T {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-diagnostic-test-"));
	const extensionDir = path.join(tempDir, "pi-intercom");
	const configPath = path.join(tempDir, "config.json");
	fs.mkdirSync(extensionDir, { recursive: true });
	fs.writeFileSync(configPath, "{ enabled: nope }");
	try {
		return fn({ extensionDir, configPath });
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function withPackagedIntercom<T>(fn: (paths: { agentDir: string; cwd: string; globalNpmRoot: string; packageDir: string; legacyDir: string; configPath: string }) => T): T {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-package-test-"));
	const agentDir = path.join(tempDir, "agent");
	const cwd = path.join(tempDir, "workspace");
	const globalNpmRoot = path.join(tempDir, "global-node_modules");
	const packageDir = path.join(globalNpmRoot, "pi-intercom");
	const legacyDir = path.join(agentDir, "extensions", "pi-intercom");
	const configPath = path.join(agentDir, "intercom", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-intercom"] }, null, 2));
	writePiIntercomPackage(packageDir);
	fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
	try {
		return fn({ agentDir, cwd, globalNpmRoot, packageDir, legacyDir, configPath });
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("diagnoseIntercomBridge", () => {
	it("reports inactive and unavailable when pi-intercom is missing", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-diagnostic-test-"));
		try {
			// Point agentDir at the temp dir so the new tmp/extensions/npm fallback
			// does not accidentally discover a real pi-intercom from the user's system.
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir: path.join(tempDir, "missing-pi-intercom"),
				configPath: path.join(tempDir, "config.json"),
				agentDir: tempDir,
			});
			assert.equal(diagnostic.active, false);
			assert.equal(diagnostic.wantsIntercom, true);
			assert.equal(diagnostic.piIntercomAvailable, false);
			assert.equal(diagnostic.reason, "pi-intercom extension was not found");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("finds npm-installed pi-intercom packages without the legacy extension directory", () => {
		withPackagedIntercom(({ agentDir, cwd, globalNpmRoot, packageDir, configPath }) => {
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				cwd,
				globalNpmRoot,
				configPath,
				runtimePackageRoot: null,
				installedPackageRoot: null,
			});
			assert.equal(diagnostic.active, true);
			assert.equal(diagnostic.piIntercomAvailable, true);
			assert.equal(diagnostic.extensionDir, path.resolve(packageDir));
		});
	});

	it("treats explicit extensionDir as authoritative even when package sources exist", () => {
		withPackagedIntercom(({ agentDir, cwd, globalNpmRoot, packageDir, configPath }) => {
			const explicitDir = path.join(agentDir, "missing-explicit-pi-intercom");
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				cwd,
				globalNpmRoot,
				extensionDir: explicitDir,
				configPath,
				runtimePackageRoot: null,
				installedPackageRoot: null,
			});
			assert.equal(diagnostic.extensionDir, path.resolve(explicitDir));
			assert.equal(diagnostic.piIntercomAvailable, false);
			assert.equal(diagnostic.reason, "pi-intercom extension was not found");
			assert.notEqual(diagnostic.extensionDir, path.resolve(packageDir));
		});
	});

	it("treats the default legacy extension path as fallback-only", () => {
		withPackagedIntercom(({ agentDir, cwd, globalNpmRoot, packageDir, legacyDir, configPath }) => {
			fs.mkdirSync(legacyDir, { recursive: true });
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				cwd,
				globalNpmRoot,
				configPath,
				runtimePackageRoot: null,
				installedPackageRoot: null,
			});
			assert.equal(diagnostic.extensionDir, path.resolve(packageDir));
		});
	});

	it("prefers a runtime-adjacent pi-intercom package over the legacy extension directory", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-runtime-test-"));
		const agentDir = path.join(tempDir, "agent");
		const legacyDir = path.join(agentDir, "extensions", "pi-intercom");
		const configPath = path.join(agentDir, "intercom", "config.json");
		const runtimeRoot = path.join(tempDir, "runtime", "node_modules", "@earendil-works", "pi-coding-agent");
		const runtimeIntercomDir = path.join(tempDir, "runtime", "node_modules", "pi-intercom");
		writePiIntercomPackage(runtimeIntercomDir);
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
		try {
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				configPath,
				runtimePackageRoot: runtimeRoot,
				installedPackageRoot: null,
			});
			assert.equal(diagnostic.extensionDir, path.resolve(runtimeIntercomDir));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("finds git-installed pi-intercom packages from settings", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-git-test-"));
		const agentDir = path.join(tempDir, "agent");
		const configPath = path.join(agentDir, "intercom", "config.json");
		const packageDir = path.join(agentDir, "git", "github.com", "example", "pi-intercom");
		writePiIntercomPackage(packageDir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:https://github.com/example/pi-intercom.git#main"] }, null, 2));
		fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
		try {
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				configPath,
				runtimePackageRoot: null,
				installedPackageRoot: null,
			});
			assert.equal(diagnostic.extensionDir, path.resolve(packageDir));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("finds file-installed pi-intercom packages from project settings", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-file-test-"));
		const cwd = path.join(tempDir, "workspace", "nested");
		const projectRoot = path.join(tempDir, "workspace");
		const projectConfigDir = getProjectConfigDir(projectRoot);
		const packageDir = path.join(projectConfigDir, "packages", "pi-intercom");
		const agentDir = path.join(tempDir, "agent");
		const configPath = path.join(agentDir, "intercom", "config.json");
		fs.mkdirSync(cwd, { recursive: true });
		writePiIntercomPackage(packageDir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(path.join(projectConfigDir, "settings.json"), JSON.stringify({ packages: ["file:./packages/pi-intercom"] }, null, 2));
		fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
		try {
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				cwd,
				configPath,
				runtimePackageRoot: null,
				installedPackageRoot: null,
			});
			assert.equal(diagnostic.extensionDir, path.resolve(packageDir));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves malformed intercom config errors while matching runtime enabled behavior", () => {
		withMalformedIntercomConfig(({ extensionDir, configPath }) => {
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(diagnostic.active, true);
			assert.equal(diagnostic.intercomConfigEnabled, true);
			assert.match(diagnostic.intercomConfigError ?? "", /SyntaxError:/);
		});
	});

	it("does not report config parse errors when runtime would not read intercom config", () => {
		withMalformedIntercomConfig(({ extensionDir, configPath }) => {
			const diagnostic = diagnoseIntercomBridge({
				config: { mode: "off" },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(diagnostic.active, false);
			assert.equal(diagnostic.reason, "bridge mode is off");
			assert.equal(diagnostic.intercomConfigEnabled, undefined);
			assert.equal(diagnostic.intercomConfigError, undefined);
		});
	});
});

describe("resolveIntercomBridge", () => {
	it("activates when extension exists, config is enabled, and context matches", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const configPath = path.join(tempDir, "config.json");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "fork-only" },
				context: "fork",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(bridge.active, true);
			assert.equal(bridge.orchestratorTarget, "main");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("activates from an npm-installed pi-intercom package", () => {
		withPackagedIntercom(({ agentDir, cwd, globalNpmRoot, packageDir, configPath }) => {
			const bridge = resolveIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				cwd,
				globalNpmRoot,
				configPath,
				runtimePackageRoot: null,
				installedPackageRoot: null,
			});
			assert.equal(bridge.active, true);
			assert.equal(bridge.extensionDir, path.resolve(packageDir));
			assert.equal(bridge.orchestratorTarget, "main");
		});
	});

	it("finds user npm-installed pi-intercom packages without cwd", () => {
		withPackagedIntercom(({ agentDir, globalNpmRoot, packageDir, configPath }) => {
			const bridge = resolveIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				agentDir,
				globalNpmRoot,
				configPath,
				runtimePackageRoot: null,
				installedPackageRoot: null,
			});
			assert.equal(bridge.active, true);
			assert.equal(bridge.extensionDir, path.resolve(packageDir));
		});
	});

	it("stays inactive when intercom config is disabled", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const configPath = path.join(tempDir, "config.json");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ enabled: false }));
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(bridge.active, false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stays active when intercom config is malformed", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const configPath = path.join(tempDir, "config.json");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(configPath, "{ enabled: nope }");
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(bridge.active, true);
		} finally {
			console.warn = originalWarn;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stays inactive for fresh context when mode is fork-only", () => {
		const bridge = resolveIntercomBridge({
			config: { mode: "fork-only" },
			context: "fresh",
			orchestratorTarget: "main",
			extensionDir: "/path/that/does/not/matter",
		});
		assert.equal(bridge.active, false);
	});

	it("loads custom instructions from instructionFile", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const instructionFile = path.join(tempDir, "bridge.md");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(instructionFile, "Custom bridge for {orchestratorTarget}\nUse ask then send.");
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always", instructionFile },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
			});
			assert.equal(bridge.active, true);
			assert.match(bridge.instruction, /Custom bridge for main/);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses stronger default instructions for fork-aware coordination", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		fs.mkdirSync(extensionDir, { recursive: true });
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always" },
				context: "fork",
				orchestratorTarget: "main",
				extensionDir,
			});
			assert.equal(bridge.active, true);
			assert.match(bridge.instruction, /reference-only/i);
			assert.match(bridge.instruction, /normal assistant text/i);
			assert.match(bridge.instruction, /contact_supervisor/);
			assert.match(bridge.instruction, /need_decision/);
			assert.match(bridge.instruction, /progress_update/);
			assert.match(bridge.instruction, /focused task result/i);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("applyIntercomBridgeToAgent", () => {
	const activeBridge: IntercomBridgeState = {
		active: true,
		mode: "always",
		orchestratorTarget: "main",
		extensionDir: "/Users/test/.pi/agent/extensions/pi-intercom",
		instruction: "Intercom orchestration channel:\n- Need a decision or blocked: contact_supervisor({ reason: \"need_decision\", message: \"<question>\" })\n- Blocked/update: contact_supervisor({ reason: \"progress_update\", message: \"UPDATE: <summary>\" })",
	};

	it("injects intercom tool and prompt instructions", () => {
		const updated = applyIntercomBridgeToAgent(makeAgent({ tools: ["read", "bash"] }), activeBridge);
		assert.deepEqual(updated.tools, ["read", "bash", "intercom", "contact_supervisor"]);
		assert.match(updated.systemPrompt, /Intercom orchestration channel:/);
		assert.match(updated.systemPrompt, /contact_supervisor/);
	});

	it("is idempotent", () => {
		const first = applyIntercomBridgeToAgent(makeAgent({ tools: ["read"] }), activeBridge);
		const second = applyIntercomBridgeToAgent(first, activeBridge);
		assert.equal(second.tools?.filter((tool) => tool === "intercom").length, 1);
		assert.equal(second.tools?.filter((tool) => tool === "contact_supervisor").length, 1);
		assert.equal(second.systemPrompt, first.systemPrompt);
	});

	it("does not inject when extension sandbox excludes intercom", () => {
		const agent = makeAgent({ tools: ["read"], extensions: ["/tmp/other-extension/index.ts"] });
		const updated = applyIntercomBridgeToAgent(agent, activeBridge);
		assert.equal(updated, agent);
	});

	it("does not treat not-pi-intercom paths as allowed", () => {
		const agent = makeAgent({ tools: ["read"], extensions: ["/tmp/not-pi-intercom/index.ts"] });
		const updated = applyIntercomBridgeToAgent(agent, activeBridge);
		assert.equal(updated, agent);
	});
});
