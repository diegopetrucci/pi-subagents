import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

type SubagentExecutionContext = "fresh" | "fork";
const FORK_SESSIONS_WITH_THINKING_DISABLED = new Set<string>();

interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir?(): string;
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

interface ForkContextResolverOptions {
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
}

interface JsonRecord {
	[key: string]: unknown;
}

function toSessionKey(sessionFile: string): string {
	return path.resolve(sessionFile);
}

function isAnthropicMessage(message: JsonRecord): boolean {
	const metadata = [message.provider, message.api, message.model]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.toLowerCase());
	return metadata.some((value) => value.includes("anthropic") || value.includes("claude"));
}

function isUnsafeThinkingBlock(block: unknown, message: JsonRecord): boolean {
	if (!block || typeof block !== "object" || Array.isArray(block)) return false;
	const content = block as JsonRecord;
	// Anthropic redacted thinking blocks are not safe to continue in forked transcripts.
	if (content.type === "redacted_thinking") return true;
	if (content.type !== "thinking" || !isAnthropicMessage(message)) return false;
	return typeof content.thinkingSignature === "string" || typeof content.signature === "string" || content.redacted === true;
}

function sanitizeMessageContent(message: JsonRecord): { content: unknown; sanitized: boolean } {
	const content = message.content;
	if (!Array.isArray(content)) return { content, sanitized: false };
	let sanitized = false;
	const filtered = content.filter((block) => {
		if (!isUnsafeThinkingBlock(block, message)) return true;
		sanitized = true;
		return false;
	});
	if (!sanitized) return { content, sanitized: false };
	return {
		content: filtered.length > 0 ? filtered : [{ type: "text", text: "" }],
		sanitized: true,
	};
}

function sanitizeForkedSessionTranscript(sessionFile: string): boolean {
	const source = fs.readFileSync(sessionFile, "utf-8");
	const hadTrailingNewline = source.endsWith("\n");
	const rawLines = source.split("\n");
	if (hadTrailingNewline) rawLines.pop();
	let sanitized = false;
	const nextLines = rawLines.map((line, index) => {
		if (!line.trim()) return line;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid forked session JSONL at line ${index + 1}: ${cause}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return line;
		const record = parsed as JsonRecord;
		if (record.type !== "message") return line;
		const message = record.message;
		if (!message || typeof message !== "object" || Array.isArray(message)) return line;
		const nextMessage = { ...(message as JsonRecord) };
		const nextContent = sanitizeMessageContent(nextMessage);
		if (!nextContent.sanitized) return line;
		nextMessage.content = nextContent.content;
		sanitized = true;
		return JSON.stringify({ ...record, message: nextMessage });
	});
	if (sanitized) {
		fs.writeFileSync(sessionFile, `${nextLines.join("\n")}${hadTrailingNewline || nextLines.length > 0 ? "\n" : ""}`, "utf-8");
	}
	return sanitized;
}

export function shouldForceThinkingOffForSession(sessionFile: string | undefined): boolean {
	return Boolean(sessionFile && FORK_SESSIONS_WITH_THINKING_DISABLED.has(toSessionKey(sessionFile)));
}

export function resolveForkSessionThinking(sessionFile: string | undefined, thinking: string | undefined): string | undefined {
	return shouldForceThinkingOffForSession(sessionFile) ? "off" : thinking;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
	options: ForkContextResolverOptions = {},
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return {
			sessionFileForIndex: () => undefined,
		};
	}

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Forked subagent context requires a persisted parent session.");
	}

	const leafId = sessionManager.getLeafId();
	if (!leafId) {
		throw new Error("Forked subagent context requires a current leaf to fork from.");
	}

	const openSession = options.openSession
		?? sessionManager.openSession
		?? ((file: string, dir?: string) => SessionManager.open(file, dir));
	const sessionDir = sessionManager.getSessionDir?.();
	const cachedSessionFiles = new Map<number, string>();

	return {
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				if (!fs.existsSync(parentSessionFile)) {
					throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
				}
				const sourceManager = openSession(parentSessionFile, sessionDir);
				const sessionFile = sourceManager.createBranchedSession(leafId);
				if (!sessionFile) {
					throw new Error("Session manager did not return a forked session file.");
				}
				if (!fs.existsSync(sessionFile)) {
					throw new Error(`Session manager returned a forked session file that does not exist: ${sessionFile}`);
				}
				if (sanitizeForkedSessionTranscript(sessionFile)) {
					FORK_SESSIONS_WITH_THINKING_DISABLED.add(toSessionKey(sessionFile));
				}
				cachedSessionFiles.set(index, sessionFile);
				return sessionFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
			}
		},
	};
}
