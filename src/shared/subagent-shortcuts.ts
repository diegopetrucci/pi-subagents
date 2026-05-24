import { keyText } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const DEFAULT_LIVE_DETAIL_SHORTCUT = Key.ctrl("o");

export const SUBAGENT_PAUSE_ALL_SHORTCUT = Key.ctrlShift("u");

export function formatShortcutDisplay(key: string): string {
	return key
		.split("/")
		.map((binding) => binding
			.split("+")
			.map((part) => part.length === 1 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
			.join("+"))
		.join("/");
}

export function liveDetailShortcutDisplay(): string {
	const configured = keyText("app.tools.expand");
	return formatShortcutDisplay(configured || DEFAULT_LIVE_DETAIL_SHORTCUT);
}

export function pauseAllShortcutDisplay(): string {
	return formatShortcutDisplay(SUBAGENT_PAUSE_ALL_SHORTCUT);
}

export function subagentRunningHintText(): string {
	return `Press ${liveDetailShortcutDisplay()} for live detail · ${pauseAllShortcutDisplay()} pauses all`;
}
