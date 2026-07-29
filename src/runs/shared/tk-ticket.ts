import { spawnSync } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { TkTicketMetadata } from "../../shared/types.ts";

const TK_SHOW_PATTERN = /\btk\s+show\s+([A-Za-z0-9][A-Za-z0-9-]*)\b/;
const TK_TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1B\\))/g;
const UNSAFE_TERMINAL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const MAX_TK_TICKET_TITLE_WIDTH = 72;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface ResolveTkTicketMetadataOptions {
	cwd?: string;
	runTkShow?: (id: string, cwd?: string) => { status: number | null; stdout: string; stderr: string };
}

export function detectTkTicketId(task: string | undefined): string | undefined {
	if (!task) return undefined;
	const match = task.match(TK_SHOW_PATTERN);
	return match?.[1];
}

export function parseTkTicketTitle(output: string): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) return trimmed.slice(2).trim() || undefined;
	}
	return undefined;
}

export function sanitizeTkTicketTitle(raw: string, maxWidth = MAX_TK_TICKET_TITLE_WIDTH): string | undefined {
	const cleaned = raw
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(UNSAFE_TERMINAL_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return truncatePlainTextToWidth(cleaned, maxWidth);
}

export function normalizeTkTicketMetadata(raw: unknown, maxWidth = MAX_TK_TICKET_TITLE_WIDTH): TkTicketMetadata | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { id, title } = raw as Partial<TkTicketMetadata>;
	if (typeof id !== "string" || !TK_TICKET_ID_PATTERN.test(id)) return undefined;
	if (typeof title !== "string") return undefined;
	const sanitizedTitle = sanitizeTkTicketTitle(title, maxWidth);
	if (!sanitizedTitle) return undefined;
	return { id, title: sanitizedTitle };
}

export function resolveTkTicketMetadata(task: string | undefined, options: ResolveTkTicketMetadataOptions = {}): TkTicketMetadata | undefined {
	const id = detectTkTicketId(task);
	if (!id) return undefined;
	const result = (options.runTkShow ?? runTkShow)(id, options.cwd);
	if (result.status !== 0) return undefined;
	return normalizeTkTicketMetadata({ id, title: parseTkTicketTitle(result.stdout) ?? "" });
}

function runTkShow(id: string, cwd?: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("tk", ["show", id], {
		cwd,
		encoding: "utf-8",
		timeout: 5000,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function truncatePlainTextToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0 || visibleWidth(text) <= maxWidth) return text;
	const targetWidth = Math.max(1, maxWidth - 1);
	let width = 0;
	let result = "";
	for (const { segment } of segmenter.segment(text)) {
		const nextWidth = visibleWidth(segment);
		if (width + nextWidth > targetWidth) return `${result}…`;
		result += segment;
		width += nextWidth;
	}
	return text;
}
