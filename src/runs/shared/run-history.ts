import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.ts";

export type RunEntryState = "complete" | "failed" | "paused" | "detached" | "skipped";

export interface RunLifecycleMetadata {
	state?: RunEntryState;
	exitCode?: number | null;
	exitSignal?: string;
	reason?: string;
	interrupted?: boolean;
	detached?: boolean;
	detachedReason?: string;
	error?: string;
	controlEvents?: Array<{ reason?: string }>;
}

export interface RunEntry {
	agent: string;
	task: string;
	ts: number;
	status: "ok" | "error";
	duration: number;
	exit?: number;
	state?: RunEntryState;
	exitCode?: number;
	exitSignal?: string;
	reason?: string;
}

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

function getHistoryPath(): string {
	return path.join(getAgentDir(), "run-history.jsonl");
}

function deriveRunState(exitCode: number, lifecycle?: RunLifecycleMetadata): RunEntryState {
	if (lifecycle?.state) return lifecycle.state;
	if (lifecycle?.interrupted) return "paused";
	if (lifecycle?.detached) return "detached";
	if (exitCode === -1) return "skipped";
	return exitCode === 0 ? "complete" : "failed";
}

function deriveRunReason(exitCode: number, lifecycle?: RunLifecycleMetadata): string | undefined {
	if (typeof lifecycle?.reason === "string" && lifecycle.reason.trim()) return lifecycle.reason.trim();
	if (lifecycle?.interrupted) return "interrupted";
	if (lifecycle?.detached) return lifecycle.detachedReason?.trim() || "detached";
	const completionGuardReason = lifecycle?.controlEvents?.find((event) => event.reason === "completion_guard")?.reason;
	if (completionGuardReason) return completionGuardReason;
	if (exitCode === -1 && lifecycle?.error === "Skipped due to fail-fast") return "fail_fast";
	return undefined;
}

export function recordRun(agent: string, task: string, exitCode: number, durationMs: number, lifecycle?: RunLifecycleMetadata): void {
	try {
		const resolvedExitCode = typeof lifecycle?.exitCode === "number" ? lifecycle.exitCode : exitCode;
		const exitSignal = typeof lifecycle?.exitSignal === "string" && lifecycle.exitSignal.trim()
			? lifecycle.exitSignal.trim()
			: undefined;
		const reason = deriveRunReason(resolvedExitCode, lifecycle);
		const entry: RunEntry = {
			agent,
			task: task.slice(0, 200),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
			state: deriveRunState(resolvedExitCode, lifecycle),
			exitCode: resolvedExitCode,
			...(exitSignal ? { exitSignal } : {}),
			...(reason ? { reason } : {}),
		};
		const historyPath = getHistoryPath();
		fs.mkdirSync(path.dirname(historyPath), { recursive: true });
		fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}

export function loadRunsForAgent(agent: string): RunEntry[] {
	const historyPath = getHistoryPath();
	if (!fs.existsSync(historyPath)) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(historyPath, "utf-8");
	} catch {
		return [];
	}

	let lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

	if (lines.length > ROTATE_READ_THRESHOLD) {
		lines = lines.slice(-ROTATE_KEEP);
		try { fs.writeFileSync(historyPath, `${lines.join("\n")}\n`, "utf-8"); } catch {}
	}

	return lines
		.map((line) => { try { return JSON.parse(line) as RunEntry; } catch { return undefined; } })
		.filter((entry): entry is RunEntry => Boolean(entry) && entry.agent === agent)
		.reverse();
}
