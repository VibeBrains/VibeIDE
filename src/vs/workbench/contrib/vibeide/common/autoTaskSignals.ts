/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TaskContext, TaskType } from './modelRouter.js';
import * as ru from './taskSignalsRu.js';

/**
 * What «Авто» reads out of a chat message before it routes: the kind of task and the signals the router scores by
 *
 * The signals come from keyword tables, one in English (below) and one in Russian (`taskSignalsRu.ts`) for every signal
 * A message in either language, or a mix of both, gives the same signals for the same request
 * Pure, so it is tested without the chat: the chat service only passes the message and the attachments in
 */

/** What the message carries besides text */
export interface MessageAttachments {
	readonly hasImages: boolean;
	readonly hasPDFs: boolean;
}

/** The text every table is matched against: lower-cased and trimmed, with `ё` folded into `е` */
function normalize(message: string): string {
	return message.toLowerCase().trim().replace(/ё/g, 'е');
}

// ── Task type ────────────────────────────────────────────────────────────────────────────────────

/** Patterns of a question about the whole codebase, as the type detector reads them */
const CODEBASE_TYPE_PATTERNS: readonly RegExp[] = [
	// Direct codebase/repo references
	/\b(codebase|code base|repository|repo|project)\b/,
	// Questions about structure/architecture
	/\b(architecture|structure|organization|layout)\b.*\b(project|codebase|repo|code)\b/,
	/\b(project|codebase|repo|code)\b.*\b(architecture|structure|organization|layout)\b/,
	// "What is" questions about the project
	/^what\s+(is|does|are)\s+(my|this|the)\s+(codebase|repo|project|code|app|application)/,
	/^what\s+(is|does|are)\s+(my|this|the)\s+\w+\s+(codebase|repo|project)/,
	// "How many" questions (endpoints, files, routes, etc.)
	/\bhow\s+many\s+(endpoint|api|route|file|function|class|component|module|service|controller)\b/i,
	// Summary/explanation requests
	/^(summarize|explain|describe|overview|analyze|break down)\s+(my|this|the)\s+(codebase|repo|project|code)/,
	// Questions about features/capabilities
	/\b(what|which|how)\s+(feature|capability|functionality|endpoint|api|route)\s+(does|has|supports?)\s+(my|this|the)\s+(codebase|repo|project|app)/i,
	// Questions about dependencies/tech stack
	/\b(what|which)\s+(technology|framework|library|dependency|package|stack)\s+(does|uses?|has)\s+(my|this|the)\s+(codebase|repo|project|app)/i,
];

/** Patterns that read a question as «complex» in the context builder, a narrower set than the type patterns above */
const CODEBASE_CONTEXT_PATTERNS: readonly RegExp[] = [
	/\b(codebase|code base|repository|repo|project)\b/,
	/\b(architecture|structure|organization|layout)\b.*\b(project|codebase|repo|code)\b/,
	/^what\s+(is|does|are)\s+(my|this|the)\s+(codebase|repo|project|code|app|application)/,
	/\bhow\s+many\s+(endpoint|endpoints|api|apis|route|routes|file|files|function|functions|class|classes|component|components|module|modules|service|services|controller|controllers)\b/i,
	/^(summarize|explain|describe|overview|analyze)\s+(my|this|the)\s+(codebase|repo|project|code)/,
];

const CODEBASE_TYPE_INDICATORS = [
	'codebase', 'code base', 'repository', 'repo', 'project structure', 'architecture',
	'endpoint', 'endpoints', 'api', 'apis', 'route', 'routes',
	'file structure', 'code organization', 'project layout',
];
const CODEBASE_CONTEXT_INDICATORS = [
	'codebase', 'code base', 'repository', 'repo', 'project structure', 'architecture',
	'endpoint', 'endpoints', 'api', 'apis', 'route', 'routes',
];

const CODEBASE_TYPE_STARTERS = [
	'what is', 'what does', 'what are', 'what do',
	'how many', 'how does', 'how do',
	'summarize', 'explain', 'describe', 'overview', 'analyze',
	'which', 'where',
];
const CODEBASE_CONTEXT_STARTERS = ['what is', 'what does', 'how many', 'summarize', 'explain', 'describe', 'overview'];

/** The question as the type detector reads it: any of the patterns, or an indicator with a question word in front */
function isCodebaseQuestionForType(lower: string): boolean {
	const matchesPattern = CODEBASE_TYPE_PATTERNS.some(pattern => pattern.test(lower));
	const hasIndicator = CODEBASE_TYPE_INDICATORS.some(indicator => lower.includes(indicator));
	const startsWithQuestion = CODEBASE_TYPE_STARTERS.some(starter => lower.startsWith(starter));
	return matchesPattern || (hasIndicator && startsWithQuestion) || ru.ruCodebaseQuestionForType(lower);
}

/** The question as the context builder reads it: it makes the request «complex» and asks for a large context */
function isCodebaseQuestionForContext(lower: string): boolean {
	const matchesPattern = CODEBASE_CONTEXT_PATTERNS.some(pattern => pattern.test(lower));
	const hasIndicator = CODEBASE_CONTEXT_INDICATORS.some(indicator => lower.includes(indicator));
	const startsWithQuestion = CODEBASE_CONTEXT_STARTERS.some(starter => lower.startsWith(starter));
	return matchesPattern || (hasIndicator && startsWithQuestion) || ru.ruCodebaseQuestionForContext(lower);
}

// Implementation/action tasks: tasks that require creating or modifying code, which need good code generation models
const IMPLEMENTATION_PATTERNS: readonly RegExp[] = [
	// Direct implementation requests
	/^(implement|create|add|build|make|set up|configure)\s+(a|an|the|my|this)?\s*\w+/,
	// Action verbs followed by code-related nouns
	/\b(implement|create|add|build|make|set up|configure|write|generate|develop)\s+(function|class|method|component|feature|endpoint|api|route|service|module|system|feature|functionality)\b/i,
	// "Implement X" or "Create X" patterns
	/\b(implement|create|add|build|make)\s+[a-z]+\s+(that|which|to|for)/i,
];

const IMPLEMENTATION_KEYWORDS = [
	// Action verbs
	'write code', 'generate code', 'create function', 'implement class', 'fix bug',
	'refactor code', 'optimize code', 'debug', 'syntax error', 'compile error',
	'add function', 'create method', 'implement function',
	// Implementation-specific
	'create a', 'implement a', 'add a', 'build a', 'make a',
	'create new', 'implement new', 'add new', 'build new',
	'set up', 'set up a', 'configure', 'configure a',
	'develop', 'develop a', 'build out',
];

const WEB_SEARCH_KEYWORDS = ['search the web', 'search online', 'look up online', 'google', 'duckduckgo', 'web search', 'search internet'];

/**
 * The task type from the message and what it carries
 * Conservative: a specific type only where the request is clear
 */
function detectTaskType(userMessage: string, lower: string, attachments: MessageAttachments): TaskType {
	if (attachments.hasPDFs) {
		return 'pdf';
	}
	if (attachments.hasImages) {
		return 'vision';
	}
	// A question about the whole codebase is a code task whose scoring then favours a large context and reasoning
	if (isCodebaseQuestionForType(lower)) {
		return 'code';
	}
	const hasCodeBlock = /```[\s\S]+?```/.test(userMessage) || /`[^`\n]{10,}`/.test(userMessage);
	const hasImplementationPattern = IMPLEMENTATION_PATTERNS.some(pattern => pattern.test(lower)) || ru.ruImplementationTask(lower);
	const hasImplementationKeyword = IMPLEMENTATION_KEYWORDS.some(keyword => lower.includes(keyword));
	if (hasCodeBlock || hasImplementationPattern || hasImplementationKeyword) {
		return 'code';
	}
	if (WEB_SEARCH_KEYWORDS.some(keyword => lower.includes(keyword)) || ru.ruWebSearch(lower)) {
		return 'web_search';
	}
	// Plain chat, which prefers quality models; complexity is read separately into the context flags
	return 'chat';
}

/** Does the message hold code: a block, inline code, a declaration, an import */
function detectCodeInMessage(message: string): boolean {
	const codePatterns = [
		/```[\s\S]*?```/, // Code blocks
		/`[^`]+`/, // Inline code
		/function\s+\w+/, // Function declarations
		/class\s+\w+/, // Class declarations
		/import\s+.*from/, // Import statements
		/const\s+\w+\s*=/, // Const declarations
		/let\s+\w+\s*=/, // Let declarations
	];
	return codePatterns.some(pattern => pattern.test(message));
}

// ── The kinds of work a message can be about ─────────────────────────────────────────────────────

const DEBUGGING_KEYWORDS = [
	'fix error', 'debug', 'why is this failing', 'error message', 'exception', 'stack trace',
	'why doesn\'t this work', 'not working', 'broken', 'crash', 'bug', 'fix bug',
	'troubleshoot', 'issue', 'problem', 'failing', 'failed', 'error', 'errors',
];
const DEBUGGING_PATTERNS: readonly RegExp[] = [
	/error\s+(message|occurred|happened|in|at)/i,
	/exception\s+(thrown|occurred|in|at)/i,
	/stack\s+trace/i,
	/why\s+(is|does|isn\'t|doesn\'t).*work/i,
	/why\s+(is|does).*fail/i,
];

function detectDebuggingTask(lower: string, hasCode: boolean): boolean {
	return DEBUGGING_KEYWORDS.some(keyword => lower.includes(keyword))
		|| DEBUGGING_PATTERNS.some(pattern => pattern.test(lower))
		|| (hasCode && (lower.includes('error') || lower.includes('exception')))
		|| ru.ruDebuggingTask(lower);
}

const REVIEW_KEYWORDS = [
	'review', 'refactor', 'improve code', 'code quality', 'best practices', 'clean up',
	'is this good code', 'how can i improve', 'refactor this', 'code review',
	'optimize', 'make it better', 'improve this', 'suggest improvements',
];
const REVIEW_PATTERNS: readonly RegExp[] = [
	/review\s+(this|my|the)\s+(code|function|class|method)/i,
	/refactor\s+(this|my|the)/i,
	/how\s+(can|to)\s+(improve|refactor|optimize)/i,
	/is\s+(this|my|the)\s+(code|implementation)\s+(good|correct|proper)/i,
];

function detectCodeReviewTask(lower: string): boolean {
	return REVIEW_KEYWORDS.some(keyword => lower.includes(keyword))
		|| REVIEW_PATTERNS.some(pattern => pattern.test(lower))
		|| ru.ruCodeReviewTask(lower);
}

const TESTING_KEYWORDS = [
	'write test', 'add test', 'test coverage', 'unit test', 'integration test',
	'test for', 'how to test', 'create test', 'testing', 'test case', 'test suite',
	'write tests', 'add tests', 'test this', 'test the',
];
const TESTING_PATTERNS: readonly RegExp[] = [
	/write\s+(a|an|the|unit|integration)\s+test/i,
	/add\s+(a|an|unit|integration)\s+test/i,
	/create\s+(a|an|unit|integration)\s+test/i,
	/test\s+(for|this|the|coverage)/i,
];

function detectTestingTask(lower: string): boolean {
	return TESTING_KEYWORDS.some(keyword => lower.includes(keyword))
		|| TESTING_PATTERNS.some(pattern => pattern.test(lower))
		|| ru.ruTestingTask(lower);
}

const DOCUMENTATION_KEYWORDS = [
	'write doc', 'documentation', 'comment', 'explain code', 'readme', 'api doc',
	'document this', 'add comments', 'write readme', 'document', 'docs',
	'comment', 'comments', 'javadoc', 'jsdoc', 'docstring',
];
const DOCUMENTATION_PATTERNS: readonly RegExp[] = [
	/write\s+(documentation|doc|readme|comments)/i,
	/add\s+(documentation|doc|comments|comment)/i,
	/document\s+(this|my|the)/i,
	/explain\s+(this|my|the)\s+(code|function|class)/i,
];

function detectDocumentationTask(lower: string): boolean {
	return DOCUMENTATION_KEYWORDS.some(keyword => lower.includes(keyword))
		|| DOCUMENTATION_PATTERNS.some(pattern => pattern.test(lower))
		|| ru.ruDocumentationTask(lower);
}

const PERFORMANCE_KEYWORDS = [
	'optimize', 'performance', 'speed up', 'make faster', 'bottleneck', 'profiling',
	'how to optimize', 'performance issue', 'slow', 'faster', 'speed', 'efficiency',
	'optimization', 'improve performance', 'performance problem',
];
const PERFORMANCE_PATTERNS: readonly RegExp[] = [
	/optimize\s+(this|my|the|for)/i,
	/performance\s+(issue|problem|optimization|improvement)/i,
	/how\s+to\s+(optimize|improve\s+performance|speed\s+up)/i,
	/make\s+(this|it|the)\s+faster/i,
];

function detectPerformanceTask(lower: string): boolean {
	return PERFORMANCE_KEYWORDS.some(keyword => lower.includes(keyword))
		|| PERFORMANCE_PATTERNS.some(pattern => pattern.test(lower))
		|| ru.ruPerformanceTask(lower);
}

const SECURITY_KEYWORDS = [
	'security', 'vulnerability', 'secure', 'authentication', 'authorization', 'encryption',
	'is this secure', 'security issue', 'vulnerable', 'vulnerabilities', 'secure this',
	'security best practices', 'security review', 'security audit', 'xss', 'csrf', 'sql injection',
];
const SECURITY_PATTERNS: readonly RegExp[] = [
	/security\s+(issue|problem|vulnerability|review|audit)/i,
	/is\s+(this|my|the)\s+secure/i,
	/how\s+to\s+secure/i,
	/make\s+(this|it|the)\s+secure/i,
];

function detectSecurityTask(lower: string): boolean {
	return SECURITY_KEYWORDS.some(keyword => lower.includes(keyword))
		|| SECURITY_PATTERNS.some(pattern => pattern.test(lower))
		|| ru.ruSecurityTask(lower);
}

const MATH_KEYWORDS = [
	'calculate', 'math', 'algorithm', 'formula', 'compute', 'statistics',
	'calculation', 'mathematical', 'equation', 'solve', 'numerical', 'arithmetic',
];
const MATH_PATTERNS: readonly RegExp[] = [
	/calculate\s+(this|the|a|an)/i,
	/solve\s+(this|the|a|an|for)/i,
	/math\s+(problem|question|calculation)/i,
	/formula\s+(for|to|of)/i,
];

function detectMathTask(lower: string): boolean {
	return MATH_KEYWORDS.some(keyword => lower.includes(keyword))
		|| MATH_PATTERNS.some(pattern => pattern.test(lower))
		|| ru.ruMathTask(lower);
}

const MULTI_LANGUAGE_KEYWORDS = [
	'translate code', 'convert to', 'port to', 'rewrite in', 'convert from',
	'multiple languages', 'different language', 'language conversion',
];
const MULTI_LANGUAGE_PATTERNS: readonly RegExp[] = [
	/translate\s+(code|this|from|to)/i,
	/convert\s+(code|this|from|to)/i,
	/port\s+(to|from)/i,
	/rewrite\s+in/i,
];

function detectMultiLanguageTask(lower: string): boolean {
	return MULTI_LANGUAGE_KEYWORDS.some(keyword => lower.includes(keyword))
		|| MULTI_LANGUAGE_PATTERNS.some(pattern => pattern.test(lower))
		|| ru.ruMultiLanguageTask(lower);
}

// ── A simple question, and a task of several steps ───────────────────────────────────────────────

/** Words that make a request no simple question */
const COMPLEX_WORK_WORDS = ['codebase', 'repository', 'architecture', 'analyze', 'refactor', 'implement', 'debug', 'error', 'fix', 'review'];

/** A message shorter than this, opening like a question, is a simple one */
const SIMPLE_QUESTION_MAX_LENGTH = 200;

const SIMPLE_QUESTION_STARTERS = [
	'what is', 'what does', 'what are', 'what do',
	'how do i', 'how to', 'how does', 'how can',
	'explain', 'tell me', 'describe',
	'when', 'where', 'why', 'who',
	'can you', 'could you', 'would you',
];
const SIMPLE_QUESTION_PATTERNS: readonly RegExp[] = [
	/^what\s+(is|does|are|do)\s+/,
	/^how\s+(do|does|can|to)\s+/,
	/^explain\s+/,
	/^tell\s+me\s+/,
	/^describe\s+/,
];

function detectSimpleQuestion(message: string, lower: string): boolean {
	if (COMPLEX_WORK_WORDS.some(word => lower.includes(word)) || ru.ruComplexWorkWords(lower)) {
		return false;
	}
	if (message.length < SIMPLE_QUESTION_MAX_LENGTH) {
		const isQuestion = SIMPLE_QUESTION_STARTERS.some(starter => lower.startsWith(starter)) || ru.ruSimpleQuestionStarter(lower);
		const matchesPattern = SIMPLE_QUESTION_PATTERNS.some(pattern => pattern.test(lower));
		return isQuestion || matchesPattern;
	}
	return false;
}

const ACTION_VERBS = ['implement', 'create', 'add', 'build', 'make', 'set up', 'configure', 'write', 'generate', 'develop', 'fix', 'update', 'modify'];
const MULTI_STEP_KEYWORDS = ['then', 'after that', 'next', 'also', 'additionally', 'furthermore', 'step', 'steps'];

/** Several distinct actions in one request, several «and» between them, or a word of sequence */
function detectMultiStepTask(lower: string): boolean {
	const verbCount = ACTION_VERBS.filter(verb => lower.includes(verb)).length + ru.ruActionVerbCount(lower);
	const conjunctionCount = (lower.match(/\sand\s/g) || []).length + ru.ruConjunctionCount(lower);
	const hasMultiStepKeywords = MULTI_STEP_KEYWORDS.some(keyword => lower.includes(keyword)) || ru.ruMultiStepKeyword(lower);
	return verbCount >= 2 || conjunctionCount >= 2 || hasMultiStepKeywords;
}

// ── The reasoning a question asks for ────────────────────────────────────────────────────────────

const REASONING_KEYWORDS = [
	'explain why', 'analyze', 'compare and contrast', 'evaluate', 'critique', 'reasoning', 'logical', 'deduce', 'infer',
	'conclusion', 'argument', 'thesis', 'hypothesis', 'theoretical', 'conceptual',
];
const COMPLEX_ANALYSIS_KEYWORDS = ['complex', 'sophisticated', 'nuanced', 'detailed analysis', 'deep understanding', 'comprehensive', 'thorough'];

/** A message longer than this is a long one */
const LONG_MESSAGE_MIN_LENGTH = 500;

/** Tokens a codebase question is estimated to need: a whole-repository question reads many files */
const CODEBASE_QUESTION_CONTEXT_TOKENS = 20000;
/** The floor of the estimate for a complex or long request that is no codebase question */
const COMPLEX_REQUEST_MIN_CONTEXT_TOKENS = 8000;

/**
 * The task context «Авто» routes a message by, and whether the message is a question about the whole codebase
 * One builder serves the choice and the error fallback: a ranking from a thinner context picks other models
 */
export function buildAutoTaskContext(userMessage: string, attachments: MessageAttachments): { context: TaskContext; isCodebaseQuestion: boolean } {
	const lower = normalize(userMessage);
	const taskType = detectTaskType(userMessage, lower, attachments);
	const hasCode = detectCodeInMessage(userMessage);

	const isCodebaseQuestion = isCodebaseQuestionForContext(lower);
	const requiresComplexReasoning = isCodebaseQuestion
		|| REASONING_KEYWORDS.some(keyword => lower.includes(keyword))
		|| COMPLEX_ANALYSIS_KEYWORDS.some(keyword => lower.includes(keyword))
		|| ru.ruRequiresComplexReasoning(lower);
	const isLongMessage = userMessage.length > LONG_MESSAGE_MIN_LENGTH;

	// Codebase questions often read many files, so they are estimated higher; other complex or long requests get a floor
	let contextSize: number | undefined;
	if (isCodebaseQuestion) {
		contextSize = CODEBASE_QUESTION_CONTEXT_TOKENS;
	} else if (requiresComplexReasoning || isLongMessage) {
		contextSize = Math.max(COMPLEX_REQUEST_MIN_CONTEXT_TOKENS, Math.ceil(userMessage.length / 2));
	}

	const isSimpleQuestion = detectSimpleQuestion(userMessage, lower);
	const isMultiStepTask = detectMultiStepTask(lower);

	// Low latency is preferred for simple questions and for plain chat that asks nothing demanding
	// Never for code or vision
	const preferLowLatency = isSimpleQuestion
		|| (!requiresComplexReasoning && !attachments.hasImages && !attachments.hasPDFs && !isLongMessage
			&& !isMultiStepTask && !isCodebaseQuestion && taskType === 'chat');

	const context: TaskContext = {
		taskType,
		hasImages: attachments.hasImages,
		hasPDFs: attachments.hasPDFs,
		hasCode,
		contextSize,
		requiresPrivacy: false, // Images and PDFs always use auto selection: remote models are allowed
		preferLowLatency,
		preferLowCost: false,
		userOverride: null,
		requiresComplexReasoning,
		isLongMessage,
		isDebuggingTask: detectDebuggingTask(lower, hasCode),
		isCodeReviewTask: detectCodeReviewTask(lower),
		isTestingTask: detectTestingTask(lower),
		isDocumentationTask: detectDocumentationTask(lower),
		isPerformanceTask: detectPerformanceTask(lower),
		isSecurityTask: detectSecurityTask(lower),
		isSimpleQuestion,
		isMathTask: detectMathTask(lower),
		isMultiLanguageTask: detectMultiLanguageTask(lower),
		isMultiStepTask,
	};
	return { context, isCodebaseQuestion };
}
