/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export interface PromptGuardResult {
	isSafe: boolean;
	warnings: string[];
	sanitized: string;
}

// Prompt injection patterns — common in adversarial repos
const INJECTION_PATTERNS = [
	/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i,
	/disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i,
	/forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i,
	/\[SYSTEM\s*:/i,
	/<\|system\|>/i,
	/###\s*SYSTEM\s*###/i,
	/you\s+are\s+now\s+(a\s+)?different/i,
	/new\s+instructions?\s*:/i,
	/override\s+(all\s+)?(previous|prior)\s+(instructions?|rules?)/i,
];

// Zero-width chars: U+200B, U+200C, U+200D, U+FEFF, U+00AD
const ZERO_WIDTH_PATTERN = /\u200B|\u200C|\u200D|\uFEFF|\u00AD/g;

// Unicode Bidi override chars: U+202A-U+202E, U+2066-U+2069, U+200E, U+200F
const BIDI_OVERRIDE_PATTERN = /[‪-‮⁦-⁩‎‏]/g;

/**
 * Unicode Tag block (U+E0000-U+E007F) — invisible characters that carry a full ASCII alphabet.
 *
 * WHY separately from the zero-width set: a tag run renders as nothing at all, so a whole
 * paragraph of instructions survives a human review of a SKILL.md or an MCP manifest. This is the
 * vector reported in embracethered.com/blog/posts/2026/scary-agent-skills (2026-09).
 */
const TAG_CHARACTER_PATTERN = /[\u{E0000}-\u{E007F}]/gu;

/**
 * The ONE legitimate use of tag characters: emoji subdivision flags, e.g. 🏴󠁧󠁢󠁳󠁣󠁴󠁿 — a U+1F3F4 base,
 * up to six tag letters and the U+E007F terminator. Stripping the block blindly would mangle them,
 * so these sequences are carried across the strip untouched.
 */
const EMOJI_TAG_SEQUENCE_PATTERN = /\u{1F3F4}[\u{E0020}-\u{E007E}]{1,6}\u{E007F}/gu;

/**
 * A run longer than this is reported as deliberate rather than incidental.
 *
 * The threshold is the one the `aid` scanner uses: below it the finding is dominated by false
 * positives from sparse emoji, above it a run is long enough to spell an instruction.
 */
const TAG_RUN_CRITICAL_LENGTH = 10;

/** Longest run of consecutive tag characters, used to tell a stray codepoint from a payload. */
function longestTagRun(content: string): number {
	let longest = 0;
	let current = 0;
	for (const character of content) {
		const codePoint = character.codePointAt(0)!;
		if (codePoint >= 0xE0000 && codePoint <= 0xE007F) {
			current++;
			longest = Math.max(longest, current);
		} else {
			current = 0;
		}
	}
	return longest;
}

// Invisible CSS (display:none / visibility:hidden / opacity:0 / font-size:0)
const INVISIBLE_CSS_PATTERN = /<[^>]+style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0)[^"']*["'][^>]*>/gi;

/**
 * Pure helper. No DI, no logging. Returns the same `PromptGuardResult` shape as the
 * service method but is testable directly.
 */
export function sanitizePromptText(content: string, filePath: string): PromptGuardResult {
	const warnings: string[] = [];
	let sanitized = content;

	for (const pattern of INJECTION_PATTERNS) {
		if (pattern.test(content)) {
			warnings.push(`Potential prompt injection detected in ${filePath}: matches pattern ${pattern.source.substring(0, 40)}...`);
		}
	}

	const zeroWidthMatches = content.match(ZERO_WIDTH_PATTERN);
	if (zeroWidthMatches && zeroWidthMatches.length > 0) {
		sanitized = sanitized.replace(ZERO_WIDTH_PATTERN, '');
		warnings.push(`Context poisoning: ${zeroWidthMatches.length} zero-width characters removed from ${filePath}`);
	}

	const bidiMatches = content.match(BIDI_OVERRIDE_PATTERN);
	if (bidiMatches && bidiMatches.length > 0) {
		sanitized = sanitized.replace(BIDI_OVERRIDE_PATTERN, '');
		warnings.push(`Context poisoning: ${bidiMatches.length} Unicode Bidi override characters removed from ${filePath}`);
	}

	const tagMatches = sanitized.match(TAG_CHARACTER_PATTERN);
	if (tagMatches && tagMatches.length > 0) {
		const preservedFlags: string[] = [];
		// Park the legitimate flag sequences behind a marker that cannot itself be a tag character,
		// strip what is left, then put them back.
		const parked = sanitized.replace(EMOJI_TAG_SEQUENCE_PATTERN, match => {
			preservedFlags.push(match);
			return `\u0000${preservedFlags.length - 1}\u0000`;
		});
		const stripped = parked.replace(TAG_CHARACTER_PATTERN, '');
		const removedCount = tagMatches.length - preservedFlags.reduce((sum, flag) => sum + [...flag].length - 1, 0);
		if (removedCount > 0) {
			sanitized = stripped.replace(/\u0000(\d+)\u0000/g, (_, index: string) => preservedFlags[Number(index)]);
			const run = longestTagRun(content);
			warnings.push(run > TAG_RUN_CRITICAL_LENGTH
				? `Context poisoning: ${removedCount} invisible Unicode Tag characters removed from ${filePath} — a run of ${run} spells hidden instructions`
				: `Context poisoning: ${removedCount} invisible Unicode Tag characters removed from ${filePath}`);
		}
	}

	if (/\.(html?|svg|xml)$/i.test(filePath)) {
		const invisibleMatches = content.match(INVISIBLE_CSS_PATTERN);
		if (invisibleMatches && invisibleMatches.length > 0) {
			warnings.push(`Invisible CSS elements detected in ${filePath}: ${invisibleMatches.length} elements that may hide content from humans`);
		}
	}

	return {
		isSafe: warnings.filter(w => w.includes('prompt injection')).length === 0,
		warnings,
		sanitized,
	};
}

export const IVibePromptGuardService = createDecorator<IVibePromptGuardService>('vibePromptGuardService');

export interface IVibePromptGuardService {
	readonly _serviceBrand: undefined;

	/**
	 * Sanitize file content before including in LLM context.
	 * Detects prompt injection patterns and context poisoning.
	 */
	sanitizeFileContent(content: string, filePath: string): PromptGuardResult;

	/** Check if file is from an external/untrusted repository */
	isExternalRepo(workspacePath: string): boolean;
}

/**
 * VibeIDE Prompt Guard: basic sanitization of file content before LLM context.
 *
 * Detects:
 * 1. Prompt injection patterns (IGNORE PREVIOUS INSTRUCTIONS, etc.)
 * 2. Context poisoning (zero-width chars, Unicode Bidi overrides)
 * 3. Invisible CSS in HTML files
 */
class VibePromptGuardService extends Disposable implements IVibePromptGuardService {
	declare readonly _serviceBrand: undefined;

	constructor(
	) {
		super();
	}

	sanitizeFileContent(content: string, filePath: string): PromptGuardResult {
		const result = sanitizePromptText(content, filePath);
		if (result.warnings.length > 0) {
			vibeLog.warn('PromptGuard', `${result.warnings.length} issue(s) in ${filePath}:\n${result.warnings.join('\n')}`);
		}
		return result;
	}

	isExternalRepo(workspacePath: string): boolean {
		// Heuristic: if workspace was recently cloned and has no git history from trusted sources
		// For Phase 1: always return false (trust all workspaces) — Phase 2 will add git remote analysis
		return false;
	}
}

registerSingleton(IVibePromptGuardService, VibePromptGuardService, InstantiationType.Eager);
