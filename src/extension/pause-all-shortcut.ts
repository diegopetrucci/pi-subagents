import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestInterruptAllRunningSubagentRuns } from "../runs/foreground/subagent-executor.ts";
import type { SubagentState } from "../shared/types.ts";

export interface PauseAllShortcutResult {
	level: "info" | "warning";
	message: string;
}

function formatRunCount(total: number, foreground: number, async: number): string {
	const parts: string[] = [];
	if (foreground > 0) parts.push(`${foreground} foreground`);
	if (async > 0) parts.push(`${async} async`);
	return `Pause requested for ${total} subagent run${total === 1 ? "" : "s"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function formatPauseAllNotes(summary: ReturnType<typeof requestInterruptAllRunningSubagentRuns>): string[] {
	const notes: string[] = [];
	if (summary.skippedDiskAsyncRunIds.length > 0) {
		notes.push(`Skipped ${formatCount(summary.skippedDiskAsyncRunIds.length, "disk-only running run")} for PID-ownership safety; use status/doctor to reconcile before interrupting.`);
	}
	if (summary.skippedTrackedAsyncRunIds.length > 0) {
		notes.push(`Skipped ${formatCount(summary.skippedTrackedAsyncRunIds.length, "tracked async run")} without a safe interrupt-capable pid; use status/doctor to reconcile.`);
	}
	if (summary.skippedForegroundRunIds.length > 0) {
		notes.push(`Skipped ${formatCount(summary.skippedForegroundRunIds.length, "foreground run")} without an active child step.`);
	}
	if (summary.errors.length > 0) {
		notes.push(`${formatCount(summary.errors.length, "interrupt request failure")} observed. ${summary.errors[0]}`);
	}
	return notes;
}

export function handlePauseAllShortcut(state: SubagentState, ctx: ExtensionContext): PauseAllShortcutResult {
	const summary = requestInterruptAllRunningSubagentRuns(state);
	const interruptedTotal = summary.foregroundRunIds.length + summary.asyncRunIds.length;
	const skippedTotal = summary.skippedForegroundRunIds.length + summary.skippedTrackedAsyncRunIds.length + summary.skippedDiskAsyncRunIds.length;
	const failedTotal = summary.errors.length;
	const notes = formatPauseAllNotes(summary);

	let result: PauseAllShortcutResult;
	if (interruptedTotal === 0) {
		result = {
			level: "warning",
			message: failedTotal > 0
				? `Failed to request a pause for running subagent work. ${notes.join(" ")}`
				: skippedTotal > 0
					? `No running subagent work could be paused. ${notes.join(" ")}`
					: "No running subagent work to pause.",
		};
	} else {
		result = {
			level: notes.length > 0 ? "warning" : "info",
			message: `${formatRunCount(interruptedTotal, summary.foregroundRunIds.length, summary.asyncRunIds.length)}${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`,
		};
	}

	if (ctx.hasUI) {
		ctx.ui.notify(result.message, result.level);
		ctx.ui.requestRender?.();
	}
	return result;
}
