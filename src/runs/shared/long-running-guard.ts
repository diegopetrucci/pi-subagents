import type { ResolvedControlConfig } from "../../shared/types.ts";

interface LongRunningNoticeMetrics {
	startedAt: number;
	now: number;
	turns: number;
	tokens: number;
}

type LongRunningTriggerReason = "time_threshold" | "turn_threshold" | "token_threshold";

interface FailedMutatingAttempt {
	tool: string;
	path?: string;
	error: string;
	ts: number;
}

interface MutatingFailureState {
	consecutiveFailures: number;
	lastFailureAt?: number;
	recentFailures: FailedMutatingAttempt[];
	lastMutatingPath?: string;
	repeatedPathFailures: number;
}

const MUTATING_BASH_PATTERNS = [
	/(^|[;&|()\s])rm\s+/,
	/(^|[;&|()\s])mv\s+/,
	/(^|[;&|()\s])cp\s+/,
	/(^|[;&|()\s])mkdir\s+/,
	/(^|[;&|()\s])touch\s+/,
	/(^|[;&|()\s])git\s+apply\b/,
	/(^|[;&|()\s])patch\s+/,
	/(^|[;&|()\s])sed\s+[^\n;&|]*\s-i\b/,
	/(^|[;&|()\s])perl\s+[^\n;&|]*\s-pi\b/,
	/(^|[;&|()]|\n)\s*tee\s+[^|&;]+/,
	/\b(writeFile|writeFileSync|appendFile|appendFileSync)\b/,
	/\bwrite_text\s*\(/,
	/\bopen\s*\([^)]*,\s*["'][wa]/,
];

const SHELL_COMMAND_BOUNDARIES = new Set([";", "|", "&", "(", ")", "\n"]);
const GIT_MUTATING_SUBCOMMANDS = new Set(["add", "commit", "merge", "push", "rebase"]);
const GIT_MUTATING_TAG_FLAGS = new Set(["-a", "-d", "-f", "-F", "-m", "-s", "-u", "--annotate", "--delete", "--file", "--force", "--local-user", "--message", "--sign"]);
const GIT_READ_ONLY_TAG_FLAGS = new Set(["-l", "-n", "-v", "--column", "--color", "--contains", "--format", "--help", "--ignore-case", "--list", "--merged", "--no-contains", "--no-merged", "--omit-empty", "--points-at", "--sort", "--verify"]);
const GH_MUTATING_PR_SUBCOMMANDS = new Set(["comment", "create", "edit", "merge", "review"]);
const GH_MUTATING_RELEASE_SUBCOMMANDS = new Set(["create", "delete", "delete-asset", "edit", "upload"]);
const GH_API_WRITE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

const MUTATING_FAILURE_HINTS = [
	"failed",
	"error",
	"no exact match",
	"did not match",
	"malformed",
	"rejected",
	"unable",
	"cannot",
	"could not",
];

export function resolveCurrentPath(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined {
	if (!toolName || !args) return undefined;
	const direct = ["path", "file", "filename", "target", "cwd"];
	for (const key of direct) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : undefined;
		if (!command) return undefined;
		const redirect = command.match(/(?:>|>>|tee\s+)(\S+)/);
		if (redirect?.[1]) return redirect[1];
	}
	return undefined;
}

function hasUnquotedFileRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;
		if (char !== ">") continue;
		if (command[i - 1] === "-") continue;
		const isDouble = command[i + 1] === ">";
		let cursor = i + (isDouble ? 2 : 1);
		while (cursor < command.length && /\s/.test(command[cursor]!)) cursor++;
		if (cursor >= command.length) continue;
		const targetStart = command[cursor]!;
		if (targetStart === "&" || targetStart === "|" || targetStart === ";") continue;
		if (targetStart === "(" || targetStart === ")") continue;
		return true;
	}
	return false;
}

function splitShellCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (char === "\\" && !inSingle) {
			current += char;
			if (i + 1 < command.length) current += command[++i]!;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			current += char;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			current += char;
			continue;
		}
		if (!inSingle && !inDouble && SHELL_COMMAND_BOUNDARIES.has(char)) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if ((char === "&" || char === "|") && command[i + 1] === char) i++;
			continue;
		}
		current += char;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function tokenizeShellSegment(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i]!;
		if (char === "\\" && !inSingle) {
			if (i + 1 < segment.length) {
				current += segment[++i]!;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function skipShellPrefixes(tokens: string[]): number {
	let index = 0;
	if (tokens[index] === "env") index += 1;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]!)) index += 1;
	return index;
}

function isMutatingGitTagInvocation(args: string[]): boolean {
	if (args.length === 0) return false;
	if (args.some((arg) => GIT_MUTATING_TAG_FLAGS.has(arg))) return true;
	if (args.some((arg) => GIT_READ_ONLY_TAG_FLAGS.has(arg))) return false;
	return args.some((arg) => !arg.startsWith("-"));
}

function hasGhApiWriteMethod(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		const upper = token.toUpperCase();
		if (upper === "-X" || upper === "--METHOD" || upper === "--REQUEST") {
			const method = args[i + 1]?.toUpperCase();
			if (method && GH_API_WRITE_METHODS.has(method)) return true;
			continue;
		}
		if (upper.startsWith("-X") && GH_API_WRITE_METHODS.has(upper.slice(2))) return true;
		if (upper.startsWith("--METHOD=") && GH_API_WRITE_METHODS.has(upper.slice("--METHOD=".length))) return true;
		if (upper.startsWith("--REQUEST=") && GH_API_WRITE_METHODS.has(upper.slice("--REQUEST=".length))) return true;
	}
	return false;
}

function isMutatingStructuredShellCommand(command: string): boolean {
	for (const segment of splitShellCommandSegments(command)) {
		const tokens = tokenizeShellSegment(segment);
		const commandIndex = skipShellPrefixes(tokens);
		const executable = tokens[commandIndex];
		const subcommand = tokens[commandIndex + 1];
		if (executable === "git") {
			if (subcommand && GIT_MUTATING_SUBCOMMANDS.has(subcommand)) return true;
			if (subcommand === "checkout" && tokens.slice(commandIndex + 2).includes("-b")) return true;
			if (subcommand === "switch" && tokens.slice(commandIndex + 2).includes("-c")) return true;
			if (subcommand === "tag" && isMutatingGitTagInvocation(tokens.slice(commandIndex + 2))) return true;
			continue;
		}
		if (executable === "gh") {
			if (subcommand === "pr" && GH_MUTATING_PR_SUBCOMMANDS.has(tokens[commandIndex + 2] ?? "")) return true;
			if (subcommand === "api" && hasGhApiWriteMethod(tokens.slice(commandIndex + 2))) return true;
			if (subcommand === "release" && GH_MUTATING_RELEASE_SUBCOMMANDS.has(tokens[commandIndex + 2] ?? "")) return true;
			continue;
		}
		if (executable === "npm" && (subcommand === "publish" || subcommand === "version")) return true;
	}
	return false;
}

export function isMutatingBashCommand(command: string): boolean {
	return hasUnquotedFileRedirection(command)
		|| MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command))
		|| isMutatingStructuredShellCommand(command);
}

export function isMutatingTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
	if (!toolName) return false;
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName !== "bash") return false;
	const command = typeof args?.command === "string" ? args.command : "";
	if (!command.trim()) return false;
	return isMutatingBashCommand(command);
}

export function didMutatingToolFail(text: string): boolean {
	const lowered = text.toLowerCase();
	return MUTATING_FAILURE_HINTS.some((hint) => lowered.includes(hint));
}

export function nextLongRunningTrigger(
	config: ResolvedControlConfig,
	metrics: LongRunningNoticeMetrics,
): LongRunningTriggerReason | undefined {
	if (metrics.now - metrics.startedAt >= config.activeNoticeAfterMs) return "time_threshold";
	if (config.activeNoticeAfterTurns !== undefined && metrics.turns >= config.activeNoticeAfterTurns) return "turn_threshold";
	if (config.activeNoticeAfterTokens !== undefined && metrics.tokens >= config.activeNoticeAfterTokens) return "token_threshold";
	return undefined;
}

export function resetMutatingFailureState(state: MutatingFailureState): void {
	state.consecutiveFailures = 0;
	state.lastFailureAt = undefined;
	state.recentFailures = [];
	state.lastMutatingPath = undefined;
	state.repeatedPathFailures = 0;
}

export function createMutatingFailureState(): MutatingFailureState {
	return {
		consecutiveFailures: 0,
		recentFailures: [],
		repeatedPathFailures: 0,
	};
}

export function recordMutatingFailure(
	state: MutatingFailureState,
	input: FailedMutatingAttempt,
	windowMs: number,
): void {
	if (state.lastFailureAt === undefined || input.ts - state.lastFailureAt > windowMs) {
		state.consecutiveFailures = 0;
		state.recentFailures = [];
		state.repeatedPathFailures = 0;
		state.lastMutatingPath = undefined;
	}
	state.lastFailureAt = input.ts;
	state.consecutiveFailures += 1;
	if (input.path && state.lastMutatingPath === input.path) {
		state.repeatedPathFailures += 1;
	} else if (input.path) {
		state.lastMutatingPath = input.path;
		state.repeatedPathFailures = 1;
	}
	state.recentFailures.push(input);
	if (state.recentFailures.length > 3) state.recentFailures.shift();
}

export function shouldEscalateMutatingFailures(state: MutatingFailureState, threshold: number): boolean {
	return state.consecutiveFailures >= threshold || state.repeatedPathFailures >= threshold;
}

export function summarizeRecentMutatingFailures(state: MutatingFailureState): string | undefined {
	if (state.recentFailures.length === 0) return undefined;
	return state.recentFailures
		.map((entry) => `${entry.tool}${entry.path ? `(${entry.path})` : ""}: ${entry.error}`)
		.join(" | ");
}
