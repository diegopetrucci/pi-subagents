import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { AsyncStatus } from "../../shared/types.ts";

const POSIX_ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = "SIGUSR2";
export const ASYNC_INTERRUPT_SIGNAL = getAsyncInterruptSignal();
export const ASYNC_INTERRUPT_REQUEST_FILE = "interrupt-request.json";

interface AsyncInterruptRequest {
	requestedAt: number;
	pid?: number;
}

function isSignalSafePid(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function mergeRequestedAt(...values: Array<number | undefined>): number | undefined {
	let merged: number | undefined;
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		merged = merged === undefined ? value : Math.max(merged, value);
	}
	return merged;
}

export function getAsyncInterruptSignal(platform: NodeJS.Platform = process.platform): NodeJS.Signals | undefined {
	return platform === "win32" ? undefined : POSIX_ASYNC_INTERRUPT_SIGNAL;
}

export function interruptRequestPath(asyncDir: string): string {
	return path.join(asyncDir, ASYNC_INTERRUPT_REQUEST_FILE);
}

export function readAsyncInterruptRequest(asyncDir: string): AsyncInterruptRequest | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(interruptRequestPath(asyncDir), "utf-8")) as Partial<AsyncInterruptRequest>;
		if (typeof parsed.requestedAt !== "number" || !Number.isFinite(parsed.requestedAt)) return undefined;
		return {
			requestedAt: parsed.requestedAt,
			...(isSignalSafePid(parsed.pid) ? { pid: parsed.pid } : {}),
		};
	} catch {
		return undefined;
	}
}

export function clearAsyncInterruptRequest(asyncDir: string): boolean {
	const requestPath = interruptRequestPath(asyncDir);
	try {
		fs.unlinkSync(requestPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function applyAsyncInterruptRequestHint<T extends AsyncStatus | null>(asyncDir: string, status: T): T {
	if (!status || status.state !== "running") return status;
	const request = readAsyncInterruptRequest(asyncDir);
	if (!request) return status;
	const interruptRequestedAt = mergeRequestedAt(status.interruptRequestedAt, request.requestedAt);
	let changed = interruptRequestedAt !== status.interruptRequestedAt;
	const steps = status.steps?.map((step) => {
		if (step.status !== "running") return step;
		const stepInterruptRequestedAt = mergeRequestedAt(step.interruptRequestedAt, interruptRequestedAt);
		if (stepInterruptRequestedAt === step.interruptRequestedAt) return step;
		changed = true;
		return { ...step, ...(stepInterruptRequestedAt !== undefined ? { interruptRequestedAt: stepInterruptRequestedAt } : {}) };
	});
	if (!changed) return status;
	return {
		...status,
		...(interruptRequestedAt !== undefined ? { interruptRequestedAt } : {}),
		...(steps ? { steps } : {}),
	} as T;
}

export function requestAsyncInterrupt(asyncDir: string, pid: number | undefined): number {
	const signal = getAsyncInterruptSignal();
	const requestedAt = Date.now();
	writeAtomicJson(interruptRequestPath(asyncDir), {
		requestedAt,
		...(isSignalSafePid(pid) ? { pid } : {}),
	});
	if (signal && isSignalSafePid(pid)) {
		try {
			process.kill(pid, signal);
		} catch (error) {
			clearAsyncInterruptRequest(asyncDir);
			throw error;
		}
	}
	return requestedAt;
}

export function consumeAsyncInterruptRequest(asyncDir: string): boolean {
	return clearAsyncInterruptRequest(asyncDir);
}
