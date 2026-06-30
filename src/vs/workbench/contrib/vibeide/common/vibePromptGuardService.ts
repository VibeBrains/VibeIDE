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
