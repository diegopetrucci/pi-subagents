interface ForegroundPauseMessageInput {
	headline: string;
	runId: string;
	resume: { kind: "single" } | { kind: "indexed"; index: number; example?: boolean };
	redispatch: string;
}

export function formatForegroundPauseMessage(input: ForegroundPauseMessageInput): string {
	const resumeLine = input.resume.kind === "single"
		? `Resume: subagent({ action: "resume", id: "${input.runId}", message: "..." })`
		: input.resume.example
			? `Resume a paused child by index, e.g. subagent({ action: "resume", id: "${input.runId}", index: ${input.resume.index}, message: "..." })`
			: `Resume the paused child: subagent({ action: "resume", id: "${input.runId}", index: ${input.resume.index}, message: "..." })`;
	return [
		input.headline,
		"Pause succeeded; this foreground run is paused and waiting for your explicit next action, not a dispatch error.",
		"Note: doctor/status may show no active run after a foreground pause because the child process has stopped.",
		"Next actions:",
		`- ${resumeLine}`,
		`- Replace/re-dispatch: ${input.redispatch}`,
		"- Stop: leave the run paused if no follow-up is needed.",
	].join("\n");
}
