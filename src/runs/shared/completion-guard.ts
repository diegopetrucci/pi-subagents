import type { Message } from "@earendil-works/pi-ai";
import { isMutatingBashCommand } from "./long-running-guard.ts";
import { SINGLE_OUTPUT_INSTRUCTION_LINE_PATTERN } from "./single-output.ts";

const REVIEW_ONLY_PATTERNS = [
	/\breview only\b/i,
	/\bsuggest fixes only\b/i,
	/\bonly return findings\b/i,
	/\breturn findings only\b/i,
];

const REVIEWER_REQUIRED_EDIT_PATTERNS = [
	/\bmust\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\brequired\s+to\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\bregardless\s+of\s+findings\b/i,
	/\balways\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\bapply\s+(?:the\s+)?fix(?:es)?\s+directly\b/i,
	/\bmake\s+(?:the\s+)?code\s+changes\b/i,
];

const EXPLICIT_NO_EDIT_PATTERNS = [
	/\bdo not edit\b/i,
	/\bdon't edit\b/i,
	/\bdo not modify\b/i,
	/\bdo not change files\b/i,
];

const SCOPED_NO_EDIT_CONSTRAINT_PATTERNS = [
	/\bdo not edit files?\s+outside\b/i,
	/\bdo not edit\s+outside\b/i,
	/\bdo not edit\s+unrelated files?\b/i,
	/\bdo not change\s+unrelated files?\b/i,
	/\bdo not modify\s+unrelated files?\b/i,
];

const VALIDATION_ONLY_TASK_PATTERNS = [
	/\bfinal(?:[-\s]+)?validation\b/i,
	/\bvalidat(?:e|ion|ing)\b/i,
	/\bverif(?:y|ication)\b/i,
];

const CONDITIONAL_NO_SOURCE_CHANGE_PATTERNS = [
	/\bdo not make\s+(?:any\s+)?(?:source|code)\s+changes?\s+unless\b/i,
	/\bdo not (?:modify|change)\s+(?:the\s+)?(?:source|code)\s+unless\b/i,
];

const VALIDATION_CONDITIONAL_MUTATION_PATTERNS = [
	/\bunless\b[\s\S]{0,160}\b(?:validation|tests?|checks?|verif(?:y|ication)|fail(?:ed|ing|s|ure|ures)?|issues?)\b[\s\S]{0,120}\b(?:expose|exposes|exposed|find|finds|found|reveal|reveals|revealed|show|shows|showed|surface|surfaces|surfaced|fail(?:ed|ing|s|ure|ures)?|issue|issues)\b/i,
];

const NON_SOURCE_EDIT_TARGET_PATTERNS = [
	/\breadme\b/i,
	/\bdocs?\b/i,
	/\bdocumentation\b/i,
	/\bchangelog\b/i,
	/\bpackage(?:\.json)?\b/i,
	/\bmanifest\b/i,
	/\bconfig(?:uration)?\b/i,
];

const NON_SOURCE_EDIT_REQUEST_PATTERNS = [
	/\b(?:update|add|remove|replace|create|edit|modify|change|patch)\b[^\n.;:!?]{0,80}\b(?:readme|docs?|documentation|changelog|package(?:\.json)?|manifest|config(?:uration)?)\b/i,
	/(?:^|[\n.;:!?]\s*|\band\s+)(?:please\s+)?fix\b[^\n.;:!?]{0,20}\b(?:readme|docs?|documentation|changelog|package(?:\.json)?|manifest|config(?:uration)?)\b/i,
];

const NO_TOOL_INTENT_PATTERNS = [
	/\bno tools? needed\b/i,
	/\bno tools? required\b/i,
	/\bwithout using tools\b/i,
	/\bdo not use tools\b/i,
	/\bdon't use tools\b/i,
];

const READ_ONLY_DELIVERABLE_PATTERNS = [
	/\b(?:draft|write|compose|prepare|produce)\s+(?:(?:a|an|the)\s+)?(?:github\s+)?(?:issue|bug report|issue draft|issue body|proposal|plan|report|summary|findings?|analysis|recommendations?)\b/i,
	/\b(?:issue|bug report)\s+(?:draft|body|template)\b/i,
	/\b(?:return|provide|produce)\s+(?:text|markdown|answer|findings?|recommendations?)\s+only\b/i,
];

const RESEARCH_AGENT_PATTERNS = [
	/\binvestigate\b/i,
	/\bscout\b/i,
	/\bresearch(?:er)?\b/i,
	/\boracle\b/i,
	/\blibrarian\b/i,
	/\bweb[-_]?scout\b/i,
	/\bcontrarian\b/i,
];

const FIX_OR_PATCH_IMPLEMENTATION_PATTERN = /\b(?:fix|patch)\s+(?:(?:it|this|that|them|each|any|all|these|those)\b|(?:(?:a|an|the|any|all)\s+)?(?:(?:failing|failed|broken|flaky|red|cold|start|current|existing|reported|approved|known|regression|unit|integration|e2e|source|typescript|type-?script|ts|type-?check|compiler)\s+)*(?:bug|defect|issues?|problems?|failures?|regressions?|tests?|errors?|items?|typos?|code|source|implementation|component|function|module|class|method|logic|file|files|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command|lint(?:ing)?|build|ci|type-?check|type\s+checking)\b)/i;

const WORKER_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|edit|modify|refactor|delete)\b/i,
	FIX_OR_PATCH_IMPLEMENTATION_PATTERN,
	/\b(?:update|add|remove|replace|create)\b(?!\s+(?:(?:a|an|the)\s+)?(?:report|summary|findings?)(?:\b|$))/i,
	/\bapply\s+(?:the\s+)?(?:(?:suggested|proposed|recommended)\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
];

const GENERAL_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|edit|modify|refactor)\b/i,
	FIX_OR_PATCH_IMPLEMENTATION_PATTERN,
	/\bapply\s+(?:the\s+)?(?:(?:suggested|proposed|recommended)\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
	/\bcorrect\s+(?:any|all|the|these|those)\s+(?:issues?|problems?|errors?|failures?|mistakes?)\b/i,
	/\b(?:update|add|remove|replace|delete|create)\s+(?:the\s+)?(?:file|files|code|source|implementation|test|tests|component|function|module|class|method|logic|import|imports|readme|docs?|changelog|package(?:\.json)?|config|manifest|extension|prompt|command)\b/i,
];

const READ_ONLY_BUILTIN_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"get_search_content",
	"intercom",
	"contact_supervisor",
]);

interface CompletionMutationGuardInput {
	agent: string;
	task: string;
	messages: Message[];
	tools?: string[];
	mcpDirectTools?: string[];
}

interface CompletionMutationGuardResult {
	expectedMutation: boolean;
	attemptedMutation: boolean;
	triggered: boolean;
}

type TaskMutationIntent = { kind: "implementation" } | { kind: "read-only" } | { kind: "unknown" };

type ToolMutationCapability = { kind: "mutation-capable" } | { kind: "read-only" };

function stripFrameworkInstructions(task: string): string {
	return task
		.split("\n")
		.filter((line) => !/^\s*\[(?:Write to|Read from):/i.test(line))
		.filter((line) => !/^\s*\*\*Output:\*\*\s*$/i.test(line))
		.filter((line) => !SINGLE_OUTPUT_INSTRUCTION_LINE_PATTERN.test(line))
		.filter((line) => !/^\s*(?:Create and maintain progress at:|Update progress at:|This path is authoritative for this run\.|Ignore any other output filename or output path mentioned elsewhere)/i.test(line))
		.join("\n");
}

function stripScopedNoEditConstraints(task: string): string {
	let stripped = task;
	for (const pattern of SCOPED_NO_EDIT_CONSTRAINT_PATTERNS) {
		stripped = stripped.replace(pattern, " ");
	}
	return stripped;
}

function taskHasExplicitReadOnlyIntent(taskText: string): boolean {
	return REVIEW_ONLY_PATTERNS.some((pattern) => pattern.test(taskText))
		|| EXPLICIT_NO_EDIT_PATTERNS.some((pattern) => pattern.test(taskText))
		|| NO_TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(taskText));
}

function taskHasReadOnlyDeliverable(taskText: string): boolean {
	return READ_ONLY_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(taskText));
}

function toolMutationCapability(tools: string[] | undefined, mcpDirectTools: string[] | undefined): ToolMutationCapability {
	if (tools === undefined || tools.length === 0 || (mcpDirectTools?.length ?? 0) > 0) return { kind: "mutation-capable" };
	return tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool)) ? { kind: "read-only" } : { kind: "mutation-capable" };
}

function classifyTaskMutationIntent(agent: string, task: string): TaskMutationIntent {
	const taskText = stripFrameworkInstructions(task);
	const taskTextWithoutScopedConstraints = stripScopedNoEditConstraints(taskText);
	if (taskHasExplicitReadOnlyIntent(taskTextWithoutScopedConstraints)) return { kind: "read-only" };

	if (RESEARCH_AGENT_PATTERNS.some((pattern) => pattern.test(agent))) return { kind: "read-only" };
	if (/\breviewer\b/i.test(agent)) {
		return REVIEWER_REQUIRED_EDIT_PATTERNS.some((pattern) => pattern.test(taskText)) ? { kind: "implementation" } : { kind: "read-only" };
	}

	const workerIntent = agent === "worker" && WORKER_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
	if (workerIntent) return { kind: "implementation" };

	if (GENERAL_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText))) return { kind: "implementation" };
	return taskHasReadOnlyDeliverable(taskTextWithoutScopedConstraints) ? { kind: "read-only" } : { kind: "unknown" };
}

function isConditionalValidationNoSourceChangeTask(task: string): boolean {
	return VALIDATION_ONLY_TASK_PATTERNS.some((pattern) => pattern.test(task))
		&& CONDITIONAL_NO_SOURCE_CHANGE_PATTERNS.some((pattern) => pattern.test(task))
		&& VALIDATION_CONDITIONAL_MUTATION_PATTERNS.some((pattern) => pattern.test(task));
}

function hasExplicitNonSourceEditRequest(task: string): boolean {
	return NON_SOURCE_EDIT_TARGET_PATTERNS.some((pattern) => pattern.test(task))
		&& NON_SOURCE_EDIT_REQUEST_PATTERNS.some((pattern) => pattern.test(task));
}

function localAgentName(agent: string): string {
	const lastDot = agent.lastIndexOf(".");
	return lastDot === -1 ? agent : agent.slice(lastDot + 1);
}

export function expectsImplementationMutation(agent: string, task: string): boolean {
	const taskText = stripFrameworkInstructions(task);
	const taskTextWithoutScopedConstraints = stripScopedNoEditConstraints(taskText);
	if (isConditionalValidationNoSourceChangeTask(taskTextWithoutScopedConstraints)
		&& !hasExplicitNonSourceEditRequest(taskTextWithoutScopedConstraints)) return false;
	return classifyTaskMutationIntent(localAgentName(agent), task).kind === "implementation";
}

export function hasMutationToolCall(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (part.name === "edit" || part.name === "write") return true;
			if (part.name !== "bash") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (typeof args.command === "string" && isMutatingBashCommand(args.command)) return true;
		}
	}
	return false;
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const expectedMutation = toolMutationCapability(input.tools, input.mcpDirectTools).kind === "read-only"
		? false
		: expectsImplementationMutation(input.agent, input.task);
	const attemptedMutation = hasMutationToolCall(input.messages);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation,
	};
}
