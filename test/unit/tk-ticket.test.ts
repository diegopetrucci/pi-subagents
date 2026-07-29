import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectTkTicketId, normalizeTkTicketMetadata, parseTkTicketTitle, resolveTkTicketMetadata, sanitizeTkTicketTitle } from "../../src/runs/shared/tk-ticket.ts";

describe("tk ticket helpers", () => {
	it("detects explicit tk show commands from delegated tasks", () => {
		assert.equal(detectTkTicketId("First run `tk show psr-raw4` and follow it."), "psr-raw4");
		assert.equal(detectTkTicketId("No ticket here."), undefined);
	});

	it("parses and sanitizes terminal-safe ticket titles", () => {
		assert.equal(parseTkTicketTitle("---\nid: psr-raw4\n---\n# Show active tk title\n"), "Show active tk title");
		assert.equal(sanitizeTkTicketTitle("\u001b[31mActive\u001b[0m\n\u0007\u009b ticket title"), "Active ticket title");
		assert.equal(sanitizeTkTicketTitle("x".repeat(100)), `${"x".repeat(71)}…`);
	});

	it("normalizes runtime tk ticket metadata", () => {
		assert.deepEqual(normalizeTkTicketMetadata({ id: "psr-raw4", title: "Unsafe\u009b title" }), { id: "psr-raw4", title: "Unsafe title" });
		assert.equal(normalizeTkTicketMetadata({ id: "bad id", title: "Unsafe title" }), undefined);
		assert.equal(normalizeTkTicketMetadata({ id: "psr-raw4", title: "\u009b\u0007" }), undefined);
	});

	it("resolves metadata only when tk show succeeds with a title", () => {
		assert.deepEqual(resolveTkTicketMetadata("Run `tk show psr-raw4` first.", {
			runTkShow: () => ({ status: 0, stdout: "# Show active tk title\n", stderr: "" }),
		}), { id: "psr-raw4", title: "Show active tk title" });
		assert.equal(resolveTkTicketMetadata("Run `tk show psr-missing` first.", {
			runTkShow: () => ({ status: 1, stdout: "", stderr: "missing" }),
		}), undefined);
	});
});
