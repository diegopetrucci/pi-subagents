import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../runs/shared/pi-spawn.ts";

const DEFAULT_CONFIG_DIR_NAME = ".pi";
const RUNTIME_CONFIG_DIR = Symbol("runtime-config-dir");

let cachedRuntimeConfigDirName: string | null | undefined;

export interface RuntimeConfigDirDeps {
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolveRuntimePackageRoot?: () => string | undefined;
	resolveInstalledPackageRoot?: () => string | undefined;
	useCache?: boolean;
}

function normalizeConfigDirName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function resolveConfigDirNameFromSource(source: unknown): string | undefined {
	if (!source || typeof source !== "object") return undefined;

	const direct = source as {
		CONFIG_DIR_NAME?: unknown;
		configDir?: unknown;
		piConfig?: { configDir?: unknown } | null;
	};
	return normalizeConfigDirName(direct.CONFIG_DIR_NAME)
		?? normalizeConfigDirName(direct.configDir)
		?? normalizeConfigDirName(direct.piConfig?.configDir);
}

function readConfigDirNameFromPackageRoot(packageRoot: string | undefined, deps: RuntimeConfigDirDeps): string | undefined {
	if (!packageRoot) return undefined;

	try {
		const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
		const packageJsonPath = path.join(packageRoot, "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			piConfig?: { configDir?: unknown } | null;
		};
		return resolveConfigDirNameFromSource(packageJson);
	} catch {
		return undefined;
	}
}

function safeResolvePackageRoot(resolvePackageRoot: () => string | undefined): string | undefined {
	try {
		return resolvePackageRoot();
	} catch {
		return undefined;
	}
}

export function resolveRuntimeConfigDirName(deps: RuntimeConfigDirDeps = {}): string | undefined {
	const useCache = deps.useCache ?? (
		deps.readFileSync === undefined
		&& deps.resolveRuntimePackageRoot === undefined
		&& deps.resolveInstalledPackageRoot === undefined
	);
	if (useCache && cachedRuntimeConfigDirName !== undefined) {
		return cachedRuntimeConfigDirName ?? undefined;
	}

	const resolveRuntimePackageRoot = deps.resolveRuntimePackageRoot ?? resolvePiPackageRoot;
	const resolveInstalledPackageRoot = deps.resolveInstalledPackageRoot ?? resolveInstalledPiPackageRoot;

	let value = readConfigDirNameFromPackageRoot(safeResolvePackageRoot(resolveRuntimePackageRoot), deps);
	if (value === undefined) {
		value = readConfigDirNameFromPackageRoot(safeResolvePackageRoot(resolveInstalledPackageRoot), deps);
	}

	if (useCache) cachedRuntimeConfigDirName = value ?? null;
	return value;
}

export function resolveConfigDirName(codingAgentModule: unknown = RUNTIME_CONFIG_DIR, deps: RuntimeConfigDirDeps = {}): string {
	const value = codingAgentModule === RUNTIME_CONFIG_DIR
		? resolveRuntimeConfigDirName(deps)
		: resolveConfigDirNameFromSource(codingAgentModule);
	return value ?? DEFAULT_CONFIG_DIR_NAME;
}

export function getConfigDirName(): string {
	return resolveConfigDirName();
}

export function getProjectConfigDir(projectRoot: string): string {
	return path.join(projectRoot, getConfigDirName());
}
