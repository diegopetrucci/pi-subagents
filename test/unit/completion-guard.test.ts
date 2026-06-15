import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
	evaluateCompletionMutationGuard,
	expectsImplementationMutation,
	hasMutationToolCall,
} from "../../src/runs/shared/completion-guard.ts";
import { isMutatingBashCommand } from "../../src/runs/shared/long-running-guard.ts";
import { injectSingleOutputInstruction } from "../../src/runs/shared/single-output.ts";

function assistantToolCall(name: string, args: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args }],
	} as unknown as Message;
}

function assistantText(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

test("implementation task with no mutation triggers the completion guard", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		messages: [assistantText("Plan: update the files...")],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
	});
});

test("declared read-only builtin tools suppress implementation-word false positives", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "architect",
		task: "Produce a proposal that implements the approved fix",
		messages: [assistantText("Proposal only")],
		tools: ["read", "grep", "find", "ls"],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
	});
});

test("omitted, empty, bash, unknown, write, and MCP tool capabilities stay conservative", () => {
	const base = {
		agent: "architect",
		task: "Implement the approved source fix",
		messages: [assistantText("Validation only")],
	};

	assert.equal(evaluateCompletionMutationGuard(base).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: [] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "bash", "ls"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "custom_lookup"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "write"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "grep"], mcpDirectTools: ["github/search"] }).triggered, true);
});

test("worker with mutating-capable tools still triggers when no mutation is observed", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the test implementation",
		messages: [assistantText("I will edit it next")],
		tools: ["read", "edit"],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
	});
});

test("review-only, research, and framework output instructions do not expect mutation", () => {
	assert.equal(expectsImplementationMutation("worker", "Review only: return findings, do not edit"), false);
	assert.equal(expectsImplementationMutation("worker", "Do not edit files. Tell me how to fix the bug."), false);
	assert.equal(expectsImplementationMutation("worker", "Review the diff and suggest fixes only. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Implement this. Do not edit files outside this repo. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Investigate why this failed"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research the API behavior"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research this and patch the bug"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues; regardless of findings, apply changes directly"), true);
	assert.equal(expectsImplementationMutation("worker", "[Write to: /tmp/result.md]\n\nSummarize findings"), false);
	assert.equal(expectsImplementationMutation("worker", injectSingleOutputInstruction("Summarize findings", "/tmp/fix.md")), false);
	assert.equal(expectsImplementationMutation("worker", "Write report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Add a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Update a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Write to {chain_dir}"), false);
	assert.equal(
		expectsImplementationMutation("worker", "Do async work\nUpdate progress at: /tmp/progress.md\nThe harness will save your final response to: /tmp/out.md"),
		false,
	);
});

test("worker implementation verbs win over investigative wording", () => {
	assert.equal(expectsImplementationMutation("worker", "Investigate why the worker did not edit files and fix it"), true);
	assert.equal(expectsImplementationMutation("worker", "Research the current code path and patch the bug"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix and return findings."), true);
});

test("worker edit intent covers common docs, config, and source tasks", () => {
	assert.equal(expectsImplementationMutation("worker", "Update README to mention the native tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Remove share functionality and all Vercel references"), true);
	assert.equal(expectsImplementationMutation("worker", "Replace the registered command with a render tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Create completion-guard.ts"), true);
	assert.equal(expectsImplementationMutation("worker", "Add tests for the completion guard"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the approved fixes. Do not edit files outside this repo."), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix. Do not edit unrelated files."), true);
});

test("edit and write tool calls count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("edit", { path: "a.ts" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("write", { path: "a.ts" })]), true);
});

test("obvious mutating bash commands count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "mkdir -p src && cat > src/file.ts <<'EOF'\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF' > src/file.ts\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 -c \"from pathlib import Path; Path('x').write_text('hi')\"" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nfrom pathlib import Path\nPath('x').write_text('hi')\nPY" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node <<'JS'\nfs.writeFileSync('x', 'hi')\nJS" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node script.js > generated.txt" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'a > b'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node -e \"console.log(a > b)\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nprint('inspect only')\nPY" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF'\nfrom pathlib import Path\nPath('x').write_text('hi')\nEOF" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF'\ngh pr create --fill\nEOF" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF'\nrm -rf build\nEOF" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'rm file'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "printf \"mkdir x\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git apply patch.diff" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "patch -p0 < fix.patch" })]), true);
});

test("VCS, PR, release, and publish bash commands are classified narrowly", () => {
	for (const command of [
		"git add src/runs/shared/long-running-guard.ts",
		"git commit -m 'Teach completion guard about VCS mutations'",
		"git -C repo commit -m 'Teach completion guard about VCS mutations'",
		"git -c user.name=tlh commit -m 'Teach completion guard about VCS mutations'",
		"git push origin HEAD",
		"git merge origin/main",
		"git rebase origin/main",
		"git tag v0.26.1",
		"git checkout -b tlh-zt7e-completion-guard-vcs",
		"git switch -c tlh-zt7e-completion-guard-vcs",
		"gh pr create --fill",
		"gh -R owner/repo pr create --fill",
		"gh pr edit 123 --title 'Updated title'",
		"gh pr comment 123 --body 'done'",
		"gh pr review 123 --approve",
		"gh pr merge 123 --squash",
		"gh api repos/octo/repo/pulls --method POST -f title='Fix guard'",
		"gh --repo owner/repo api repos/octo/repo/pulls -X POST -f title='Fix guard'",
		"gh api repos/octo/repo/pulls -XPATCH -f title='Fix guard'",
		"gh api repos/octo/repo/pulls --method PUT -f title='Fix guard'",
		"gh api repos/octo/repo/pulls/123 --request DELETE",
		"gh api repos/octo/repo/pulls -f title='Fix guard'",
		"gh api repos/octo/repo/pulls -F title='Fix guard'",
		"gh api repos/octo/repo/pulls --raw-field title='Fix guard'",
		"gh api repos/octo/repo/pulls --field title='Fix guard'",
		"gh release create v0.26.1 --notes 'release notes'",
		"gh release edit v0.26.1 --draft=false",
		"gh release delete v0.26.1 --yes",
		"gh release delete-asset v0.26.1 dist.tgz --yes",
		"gh release upload v0.26.1 dist.tgz",
		"npm publish",
		"npm version patch",
	]) {
		assert.equal(isMutatingBashCommand(command), true, command);
	}

	for (const command of [
		"git status --short",
		"git diff --stat",
		"git log --oneline -5",
		"git show HEAD~1",
		"git --no-pager status --short",
		"git tag",
		"git tag -l 'v0.*'",
		"gh pr view 123 --json url",
		"gh -R owner/repo pr view 123 --json url",
		"gh api rate_limit",
		"gh api repos/octo/repo/pulls --method GET -f title='Fix guard'",
		"gh api repos/octo/repo/pulls -X GET --field title='Fix guard'",
		"gh release view v0.26.1",
		"git --help commit",
		"git --version commit",
		"gh --help pr create",
		"gh --version pr create",
		"npm view pi-subagents version",
		"npm version",
		"npm version --json",
	]) {
		assert.equal(isMutatingBashCommand(command), false, command);
	}
});

test("oracle, librarian, and web-scout advisory agents do not expect mutation regardless of task verbs", () => {
	// oracle
	assert.equal(expectsImplementationMutation("oracle", "Please fix the broken test"), false);
	assert.equal(expectsImplementationMutation("oracle", "Implement a review of this PR"), false);
	// librarian
	assert.equal(expectsImplementationMutation("librarian", "Research this and patch the bug"), false);
	// web-scout (hyphen variant)
	assert.equal(expectsImplementationMutation("web-scout", "Fix the failing search results"), false);
	// web-scout (underscore variant)
	assert.equal(expectsImplementationMutation("web_scout", "Fix the failing search results"), false);
});

test("evaluateCompletionMutationGuard returns triggered:false for oracle completing without edits", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "oracle",
		task: "Fix the failing test — provide your analysis",
		messages: [assistantText("Here is my analysis of the failure...")],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
	});
});

test("implementation task with mutation attempts does not trigger", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the failing test",
		messages: [assistantToolCall("edit", { path: "test.ts" })],
	});

	assert.equal(result.triggered, false);
});

test("implementation task completed through VCS or PR bash mutations does not trigger", () => {
	for (const command of [
		"git commit -m 'Implement approved fix'",
		"gh pr create --fill",
		"gh api repos/octo/repo/pulls -f title='Implement approved fix'",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "worker",
			task: "Implement the approved fix",
			messages: [assistantToolCall("bash", { command })],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: true,
			triggered: false,
		}, command);
	}
});


test("read-only help and version bash commands do not satisfy the completion guard", () => {
	for (const command of [
		"git --help commit",
		"git --version commit",
		"gh --help pr create",
		"gh --version pr create",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "worker",
			task: "Implement the approved fix",
			messages: [assistantToolCall("bash", { command })],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: false,
			triggered: true,
		}, command);
	}
});

test("qualified worker name does not inherit advisory exemption from package prefix", () => {
	// oracle.worker — local name is "worker", package prefix "oracle" must not trigger the advisory exemption
	assert.equal(expectsImplementationMutation("oracle.worker", "Fix the broken test"), true);
});

test("qualified editor name expects mutation", () => {
	assert.equal(expectsImplementationMutation("librarian.editor", "Implement the change"), true);
});

test("qualified scout name is still advisory", () => {
	// local name "scout" matches ADVISORY_AGENT_PATTERNS — should return false
	assert.equal(expectsImplementationMutation("code-analysis.scout", "Fix the indexer"), false);
});

test("qualified reviewer name preserves reviewer carve-out", () => {
	// code-analysis.reviewer — local name "reviewer" triggers the reviewer special-case
	assert.equal(expectsImplementationMutation("code-analysis.reviewer", "Review and fix issues"), false);
});

test("reviewer package prefix does not activate reviewer carve-out when local name is worker", () => {
	// reviewer.worker — local name is "worker", so reviewer carve-out must NOT apply
	assert.equal(expectsImplementationMutation("reviewer.worker", "Fix the bug"), true);
});
