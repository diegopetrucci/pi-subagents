import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	realpathSync?: (filePath: string) => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	piPackageRoot?: string;
}

interface PiSpawnCommand {
	command: string;
	args: string[];
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function resolveArgvPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const argv1 = deps.argv1 ?? process.argv[1];
	if (!argv1) return undefined;

	try {
		const argvPath = normalizePath(argv1);
		const realArgvPath = realpathSync(argvPath);
		if (!isRunnableNodeScript(realArgvPath, existsSync)) return undefined;
		return findPiPackageRootFromEntry(realArgvPath) ? realArgvPath : undefined;
	} catch {
		return undefined;
	}
}

export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argvCliScript = resolveArgvPiCliScript(deps);
	if (argvCliScript) return argvCliScript;

	try {
		const resolvePackageJson = deps.resolvePackageJson ?? (() => {
			const root = deps.piPackageRoot ?? resolvePiPackageRoot();
			if (root) return path.join(root, "package.json");
			if (deps.resolvePackageEntry) {
				const packageRoot = findPiPackageRootFromEntry(deps.resolvePackageEntry());
				if (packageRoot) return path.join(packageRoot, "package.json");
			}
			throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
		});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath = typeof binField === "string"
			? binField
			: binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath) return undefined;
		const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
		if (isRunnableNodeScript(candidate, existsSync)) {
			return candidate;
		}
	} catch {
		// CLI resolution is optional; falling back to `pi` lets PATH handle execution.
		return undefined;
	}

	return undefined;
}

export function resolveWindowsPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	return resolvePiCliScript(deps);
}

export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
	const piCliPath = resolvePiCliScript(deps);
	if (piCliPath) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [piCliPath, ...args],
		};
	}

	return { command: "pi", args };
}
