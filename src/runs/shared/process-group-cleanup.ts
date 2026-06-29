import type { ChildProcessCleanupResult, ChildProcessCleanupSkippedReason } from "../../shared/types.ts";

const PROCESS_GROUP_TERM_GRACE_MS = 3000;
const PROCESS_GROUP_POLL_MS = 100;
const PROCESS_GROUP_KILL_SETTLE_MS = 500;

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface CleanupOwnedProcessGroupDeps {
	kill?: KillFn;
	sleep?: (ms: number) => Promise<void>;
	waitMs?: number;
	pollMs?: number;
	killSettleMs?: number;
}

function isMissingProcessError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isPermissionError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "EPERM";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function probeProcessGroup(processGroupId: number, kill: KillFn): boolean {
	try {
		kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		if (isPermissionError(error)) return true;
		return true;
	}
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals, kill: KillFn): { sent: boolean; warning?: string } {
	try {
		return { sent: kill(-processGroupId, signal) };
	} catch (error) {
		if (isMissingProcessError(error)) return { sent: false };
		const message = error instanceof Error ? error.message : String(error);
		return { sent: false, warning: `Failed to send ${signal} to process group ${processGroupId}: ${message}` };
	}
}

async function waitForProcessGroupExit(processGroupId: number, deps: CleanupOwnedProcessGroupDeps = {}): Promise<boolean> {
	const kill = deps.kill ?? process.kill.bind(process);
	const waitMs = deps.waitMs ?? PROCESS_GROUP_TERM_GRACE_MS;
	const pollMs = deps.pollMs ?? PROCESS_GROUP_POLL_MS;
	const wait = deps.sleep ?? sleep;
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (!probeProcessGroup(processGroupId, kill)) return true;
		await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
	return !probeProcessGroup(processGroupId, kill);
}

export function supportsOwnedProcessGroupCleanup(platform = process.platform): boolean {
	return platform !== "win32";
}

export function skipOwnedProcessGroupCleanup(
	reason: ChildProcessCleanupSkippedReason,
	processGroupId?: number,
	supported = supportsOwnedProcessGroupCleanup(),
): ChildProcessCleanupResult {
	return {
		supported,
		attempted: false,
		terminated: false,
		...(processGroupId ? { processGroupId } : {}),
		skippedReason: reason,
	};
}

export async function cleanupOwnedProcessGroup(
	processGroupId: number,
	deps: CleanupOwnedProcessGroupDeps = {},
): Promise<ChildProcessCleanupResult> {
	const kill = deps.kill ?? process.kill.bind(process);
	const waitMs = deps.waitMs ?? PROCESS_GROUP_TERM_GRACE_MS;
	const killSettleMs = deps.killSettleMs ?? PROCESS_GROUP_KILL_SETTLE_MS;
	const warnings: string[] = [];
	const liveProcessesDetected = probeProcessGroup(processGroupId, kill);
	if (!liveProcessesDetected) {
		return {
			supported: true,
			attempted: true,
			processGroupId,
			liveProcessesDetected: false,
			terminated: true,
		};
	}

	const term = signalProcessGroup(processGroupId, "SIGTERM", kill);
	if (term.warning) warnings.push(term.warning);
	const termExited = term.sent ? await waitForProcessGroupExit(processGroupId, { ...deps, kill, waitMs }) : !probeProcessGroup(processGroupId, kill);
	if (termExited) {
		return {
			supported: true,
			attempted: true,
			processGroupId,
			liveProcessesDetected: true,
			terminated: true,
			...(term.sent ? { signals: ["SIGTERM"] as const } : {}),
			...(warnings.length ? { warnings } : {}),
		};
	}

	warnings.push(`Process group ${processGroupId} was still alive ${waitMs}ms after SIGTERM; escalating to SIGKILL.`);
	const killResult = signalProcessGroup(processGroupId, "SIGKILL", kill);
	if (killResult.warning) warnings.push(killResult.warning);
	if (killResult.sent) await (deps.sleep ?? sleep)(killSettleMs);
	const terminated = !probeProcessGroup(processGroupId, kill);
	if (!terminated) warnings.push(`Process group ${processGroupId} still appears alive after SIGKILL.`);
	return {
		supported: true,
		attempted: true,
		processGroupId,
		liveProcessesDetected: true,
		terminated,
		escalatedToSigkill: true,
		signals: killResult.sent ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
		warnings,
	};
}

export function formatOwnedProcessGroupCleanup(cleanup: ChildProcessCleanupResult): string {
	if (cleanup.skippedReason === "soft_pause") return "Process cleanup skipped for soft-paused run.";
	if (cleanup.skippedReason === "unsupported_platform") return "Process cleanup unavailable on this platform.";
	if (cleanup.skippedReason === "process_group_unavailable") return "Process cleanup unavailable because no owned child process group was tracked.";
	const processGroup = cleanup.processGroupId ? `process group ${cleanup.processGroupId}` : "owned child process group";
	if (cleanup.terminated && cleanup.liveProcessesDetected === false) return `${processGroup} had no live processes to clean up.`;
	if (cleanup.terminated && cleanup.escalatedToSigkill) return `Cleaned up ${processGroup} after escalating from SIGTERM to SIGKILL.`;
	if (cleanup.terminated) return `Cleaned up ${processGroup} with SIGTERM.`;
	if (cleanup.escalatedToSigkill) return `Best-effort cleanup escalated to SIGKILL, but ${processGroup} may still have live processes.`;
	return `Best-effort cleanup could not confirm that ${processGroup} exited.`;
}
