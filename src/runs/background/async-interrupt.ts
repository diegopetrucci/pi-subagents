import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";

export const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = "SIGUSR2";
export const ASYNC_INTERRUPT_REQUEST_FILE = "interrupt-request.json";

function isSignalSafePid(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

export function interruptRequestPath(asyncDir: string): string {
	return path.join(asyncDir, ASYNC_INTERRUPT_REQUEST_FILE);
}

export function requestAsyncInterrupt(asyncDir: string, pid: number | undefined): void {
	if (process.platform !== "win32" && isSignalSafePid(pid)) {
		process.kill(pid, ASYNC_INTERRUPT_SIGNAL);
		return;
	}
	writeAtomicJson(interruptRequestPath(asyncDir), {
		requestedAt: Date.now(),
		...(isSignalSafePid(pid) ? { pid } : {}),
	});
}

export function consumeAsyncInterruptRequest(asyncDir: string): boolean {
	const requestPath = interruptRequestPath(asyncDir);
	try {
		fs.unlinkSync(requestPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
