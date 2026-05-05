/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Quality checker for early token evaluation
 * Used in speculative escalation to detect low-quality responses early
 */

export interface EarlyTokenQuality {
	score: number; // 0-1, higher is better
	shouldEscalate: boolean; // true if should escalate to better model
	reasons: string[]; // reasons for quality assessment
}

/**
 * Check quality of early tokens to decide if escalation is needed
 */
export function checkEarlyTokenQuality(
	text: string,
	reasoning: string,
	tokenCount: number
): EarlyTokenQuality {
	const reasons: string[] = [];
	let score = 1.0;

	// Need at least some tokens to evaluate
	if (tokenCount < 20) {
		return {
			score: 0.5, // Neutral until we have enough tokens
			shouldEscalate: false,
			reasons: ['Insufficient tokens for quality check'],
		};
	}

	// Check for low-quality indicators
	const lowerText = text.toLowerCase();

	// Repetitive text (hallucination indicator)
	const words = text.split(/\s+/);
	const uniqueWords = new Set(words);
	const repetitionRatio = uniqueWords.size / Math.max(words.length, 1);
	if (repetitionRatio < 0.3 && words.length > 10) {
		score -= 0.3;
		reasons.push('High repetition detected');
	}

	// Very short responses for complex questions
	if (text.length < 50 && tokenCount > 30) {
		score -= 0.2;
		reasons.push('Response too short for complexity');
	}

	// Generic/unhelpful phrases
	const genericPhrases = [
		"i'm sorry, i cannot",
		"i don't have access to",
		"i'm not able to",
		"i cannot help with",
		"as an ai",
		"i'm an ai",
	];
	if (genericPhrases.some(phrase => lowerText.includes(phrase))) {
		score -= 0.4;
		reasons.push('Generic/unhelpful response detected');
	}

	// Error messages or incomplete responses
	if (lowerText.includes('error') && lowerText.includes('occurred')) {
		score -= 0.3;
		reasons.push('Error message in response');
	}

	// Incomplete code blocks (for code tasks)
	if (text.includes('```') && (text.match(/```/g)?.length ?? 0) % 2 !== 0) {
		score -= 0.2;
		reasons.push('Incomplete code block');
	}

	// Very low confidence score
	score = Math.max(0, Math.min(1, score));

	// Escalate if score is below threshold
	const shouldEscalate = score < 0.5 && tokenCount >= 50;

	return {
		score,
		shouldEscalate,
		reasons: reasons.length > 0 ? reasons : ['Quality acceptable'],
	};
}

/**
 * Determine if a routing decision should use speculative escalation
 */
export function shouldUseSpeculativeEscalation(
	confidence: number,
	qualityTier: string | undefined
): boolean {
	// Use speculative escalation for:
	// 1. Low confidence (< 0.6)
	// 2. Escalate quality tier
	// 3. Complex tasks that might benefit from fast-first approach
	return confidence < 0.6 || qualityTier === 'escalate';
}

