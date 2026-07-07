/**
 * Register the .js → .ts loader hook for source-loading tests.
 *
 * Usage: node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Source files use .js import extensions (TypeScript ESM convention) but files
 * on disk are .ts — the loader rewrites .js → .ts at resolve time. Keep loaded
 * sources compatible with Node's strip-types mode.
 */

import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

register(new URL("./ts-loader.mjs", import.meta.url));

// Isolate test runs onto a per-process temp root (issue #45).
//
// Integration tests import ASYNC_DIR/RESULTS_DIR/etc. from src/shared/types.ts,
// which otherwise resolve under the shared uid-scoped temp root
// ($TMPDIR/pi-subagents-uid-<uid>/) also used by live pi sessions. Writing
// fixture runs/results there pollutes live sessions (ghost notifications,
// doctor noise). Redirect via PI_SUBAGENTS_TEMP_ROOT to a fresh mkdtemp
// directory for this process, unless the caller already set an override.
// Spawned child processes (e.g. the async runner) inherit this env var and
// transparently resolve the same isolated root.
if (!process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()) {
	const isolatedRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-test-root-"),
	);
	process.env.PI_SUBAGENTS_TEMP_ROOT = isolatedRoot;

	process.on("exit", () => {
		try {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; ignore failures (e.g. already removed)
		}
	});
}
