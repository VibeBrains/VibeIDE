/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vibeLog } from './vibeLog.js';

/**
 * Secret detection and redaction utilities
 * Detects common secret patterns (API keys, tokens, passwords) and provides redaction functionality
 */

export interface SecretPattern {
	/** Unique identifier for this pattern */
	id: string;
	/** Human-readable name (e.g., "OpenAI API Key") */
	name: string;
	/** Regex pattern to detect secrets */
	pattern: RegExp;
	/** Whether this pattern is enabled */
	enabled: boolean;
	/** Priority (higher = checked first) */
	priority: number;
	/**
	 * Optional post-match guard. The regex pre-filters by shape; `validate`
	 * rejects shape-matching-but-not-actually-a-secret candidates (e.g. a 40-char
	 * CamelCase class name matching the bare AWS-key length rule). Receives the
	 * matched text; return false to discard the match. No `validate` = accept all
	 * regex matches (previous behavior).
	 */
	validate?: (candidate: string) => boolean;
}

/** Shannon entropy in bits/char — low for words/identifiers, high for random keys. */
function shannonEntropy(s: string): number {
	if (!s) { return 0; }
	const freq = new Map<string, number>();
	for (const ch of s) { freq.set(ch, (freq.get(ch) ?? 0) + 1); }
	let h = 0;
	for (const count of freq.values()) {
		const p = count / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

/**
 * AWS secret access keys are 40-char base64 with high entropy and mixed
 * character classes. The bare `{40}` length rule also matches long CamelCase
 * identifiers (class/namespace names) and 40-char hex hashes, falsely redacting
 * innocent code (observed: PHP controller names rendered as [[REDACTED:AWS
 * Secret Key]]). Require all three character classes AND high entropy: kills
 * no-digit identifiers and lowercase-hex hashes while keeping real keys.
 */
function looksLikeAwsSecret(s: string): boolean {
	return /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && shannonEntropy(s) >= 3.5;
}

export interface SecretMatch {
	/** Pattern that matched */
	pattern: SecretPattern;
	/** The matched text */
	matchedText: string;
	/** Start position in original text */
	start: number;
	/** End position in original text */
	end: number;
	/** Redacted placeholder */
	placeholder: string;
}

export interface SecretDetectionResult {
	/** Whether any secrets were detected */
	hasSecrets: boolean;
	/** All matches found */
	matches: SecretMatch[];
	/** Redacted text */
	redactedText: string;
	/** Count of secrets by type */
	countByType: Map<string, number>;
}

/**
 * Default secret patterns covering common API keys, tokens, and passwords
 */
export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
	// OpenAI API keys (sk-...)
	{
		id: 'openai-key',
		name: 'OpenAI API Key',
		// Project keys (sk-proj-…, hyphenated body) and legacy keys (sk-… 20+ alnum).
		// Negative lookahead keeps Anthropic keys (sk-ant-…) for their dedicated rule.
		pattern: /\b(sk-proj-[a-zA-Z0-9_-]{4,}|sk-(?!ant-)[a-zA-Z0-9]{20,})\b/gi,
		enabled: true,
		priority: 100,
	},
	// Anthropic API keys (sk-ant-...)
	{
		id: 'anthropic-key',
		name: 'Anthropic API Key',
		pattern: /\b(sk-ant-[a-zA-Z0-9_-]{95,})\b/gi,
		enabled: true,
		priority: 100,
	},
	// Generic API keys (various formats)
	{
		id: 'generic-api-key',
		name: 'Generic API Key',
		pattern: /\b(api[_-]?key|apikey)\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
		enabled: true,
		priority: 90,
	},
	// JWT tokens
	{
		id: 'jwt-token',
		name: 'JWT Token',
		pattern: /\b(eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g,
		enabled: true,
		priority: 95,
	},
	// Bearer tokens
	{
		id: 'bearer-token',
		name: 'Bearer Token',
		pattern: /\b(bearer\s+)([a-zA-Z0-9_-]{20,})\b/gi,
		enabled: true,
		priority: 90,
	},
	// AWS access keys
	{
		id: 'aws-access-key',
		name: 'AWS Access Key',
		pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
		enabled: true,
		priority: 100,
	},
	// AWS secret keys (exclude '/' to avoid false positives on path segments, e.g. prof/vibeide/browser/convertTo)
	{
		id: 'aws-secret-key',
		name: 'AWS Secret Key',
		pattern: /\b([a-zA-Z0-9+=]{40})\b/g,
		enabled: true,
		priority: 85,
		validate: looksLikeAwsSecret,
	},
	// GitHub tokens
	{
		id: 'github-token',
		name: 'GitHub Token',
		pattern: /\b(ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|ghu_[a-zA-Z0-9]{36,}|ghs_[a-zA-Z0-9]{36,}|ghr_[a-zA-Z0-9]{36,})\b/g,
		enabled: true,
		priority: 100,
	},
	// GitLab tokens
	{
		id: 'gitlab-token',
		name: 'GitLab Token',
		pattern: /\b(glpat-[a-zA-Z0-9_-]{20,})\b/gi,
		enabled: true,
		priority: 95,
	},
	// Google API keys
	{
		id: 'google-api-key',
		name: 'Google API Key',
		pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
		enabled: true,
		priority: 100,
	},
	// Stripe keys
	{
		id: 'stripe-key',
		name: 'Stripe API Key',
		pattern: /\b(sk_live_[a-zA-Z0-9]{24,}|pk_live_[a-zA-Z0-9]{24,})\b/g,
		enabled: true,
		priority: 100,
	},
	// Password patterns (common in config files)
	{
		id: 'password-pattern',
		name: 'Password',
		pattern: /\b(password|passwd|pwd|secret|token)\s*[=:]\s*['"]?([a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]{8,})['"]?/gi,
		enabled: true,
		priority: 80,
	},
	// Private keys (RSA, EC, etc.)
	{
		id: 'private-key',
		name: 'Private Key',
		pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE KEY-----[\s\S]*?-----END\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE KEY-----/gi,
		enabled: true,
		priority: 100,
	},
	// Generic tokens (long alphanumeric strings)
	{
		id: 'generic-token',
		name: 'Generic Token',
		pattern: /\b([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/g,
		enabled: false, // Disabled by default - too many false positives
		priority: 50,
	},
];

/**
 * Configuration for secret detection
 */
export interface SecretDetectionConfig {
	/** Whether secret detection is enabled */
	enabled: boolean;
	/** Custom patterns to add */
	customPatterns: Array<{
		id: string;
		name: string;
		pattern: string; // Regex pattern as string
		enabled: boolean;
		priority: number;
	}>;
	/** Pattern IDs to disable */
	disabledPatternIds: string[];
	/** Strictness mode: 'block' blocks sending, 'redact' allows with redaction */
	mode: 'block' | 'redact';
}

const DEFAULT_CONFIG: SecretDetectionConfig = {
	enabled: true,
	customPatterns: [],
	disabledPatternIds: [],
	mode: 'redact',
};

/**
 * Gets all active patterns (defaults + custom, filtered by enabled/disabled)
 */
export function getActivePatterns(config: SecretDetectionConfig = DEFAULT_CONFIG): SecretPattern[] {
	if (!config.enabled) {
		return [];
	}

	const patterns: SecretPattern[] = [];

	// Add default patterns (excluding disabled ones)
	for (const pattern of DEFAULT_SECRET_PATTERNS) {
		if (!config.disabledPatternIds.includes(pattern.id)) {
			patterns.push(pattern);
		}
	}

	// Add custom patterns
	for (const custom of config.customPatterns) {
		if (custom.enabled) {
			try {
				patterns.push({
					id: custom.id,
					name: custom.name,
					pattern: new RegExp(custom.pattern, 'gi'),
					enabled: true,
					priority: custom.priority,
				});
			} catch (e) {
				vibeLog.warn('secretDetection', `Invalid regex pattern for custom secret pattern ${custom.id}:`, e);
			}
		}
	}

	// Sort by priority (higher first)
	return patterns.sort((a, b) => b.priority - a.priority);
}

/**
 * Detects secrets in text and returns matches
 */
export function detectSecrets(
	text: string,
	config: SecretDetectionConfig = DEFAULT_CONFIG
): SecretDetectionResult {
	const patterns = getActivePatterns(config);
	const matches: SecretMatch[] = [];
	const countByType = new Map<string, number>();

	if (!text || patterns.length === 0) {
		return {
			hasSecrets: false,
			matches: [],
			redactedText: text,
			countByType: new Map(),
		};
	}

	// Find all matches
	for (const pattern of patterns) {
		const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
		let match: RegExpExecArray | null;

		// Reset regex state
		regex.lastIndex = 0;

		while ((match = regex.exec(text)) !== null) {
			const matchedText = match[0];
			const start = match.index;
			const end = start + matchedText.length;

			// Post-match guard: discard shape-matching-but-not-a-secret candidates
			// (e.g. a 40-char identifier hitting the bare AWS-key length rule). Done
			// before overlap handling so a rejected candidate neither lands nor evicts
			// a legitimately-matched lower-priority secret. The zero-length-bump below
			// still runs because we only skip the push, not the loop iteration.
			const accepted = !pattern.validate || pattern.validate(matchedText);

			// Check for overlaps with existing matches (prefer higher priority)
			const overlaps = matches.some(
				(m) => !(end <= m.start || start >= m.end) && m.pattern.priority >= pattern.priority
			);

			if (accepted && !overlaps) {
				// Remove overlapping lower-priority matches
				for (let i = matches.length - 1; i >= 0; i--) {
					const existing = matches[i];
					if (!(end <= existing.start || start >= existing.end) && existing.pattern.priority < pattern.priority) {
						matches.splice(i, 1);
					}
				}

				const placeholder = `[[REDACTED:${pattern.name}]]`;
				matches.push({
					pattern,
					matchedText,
					start,
					end,
					placeholder,
				});

				const count = countByType.get(pattern.name) || 0;
				countByType.set(pattern.name, count + 1);
			}

			// Prevent infinite loops on zero-length matches
			if (match[0].length === 0) {
				regex.lastIndex++;
			}
		}
	}

	// Sort matches by position
	matches.sort((a, b) => a.start - b.start);

	// Build redacted text
	let redactedText = text;
	// Process from end to start to preserve indices
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		redactedText = redactedText.slice(0, match.start) + match.placeholder + redactedText.slice(match.end);
	}

	return {
		hasSecrets: matches.length > 0,
		matches,
		redactedText,
		countByType,
	};
}

/**
 * Redacts secrets in an object (recursively)
 */
export function redactSecretsInObject<T = unknown>(
	obj: T,
	config: SecretDetectionConfig = DEFAULT_CONFIG
): { redacted: T; hasSecrets: boolean; matches: SecretMatch[] } {
	if (typeof obj === 'string') {
		const result = detectSecrets(obj, config);
		return {
			redacted: result.redactedText as T,
			hasSecrets: result.hasSecrets,
			matches: result.matches,
		};
	}

	if (Array.isArray(obj)) {
		let hasSecrets = false;
		const allMatches: SecretMatch[] = [];
		const redacted = obj.map((item) => {
			const result = redactSecretsInObject(item, config);
			if (result.hasSecrets) {
				hasSecrets = true;
				allMatches.push(...result.matches);
			}
			return result.redacted;
		});
		return { redacted: redacted as T, hasSecrets, matches: allMatches };
	}

	if (obj && typeof obj === 'object') {
		let hasSecrets = false;
		const allMatches: SecretMatch[] = [];
		const redacted: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(obj)) {
			const result = redactSecretsInObject(value, config);
			if (result.hasSecrets) {
				hasSecrets = true;
				allMatches.push(...result.matches);
			}
			redacted[key] = result.redacted;
		}

		return { redacted: redacted as T, hasSecrets, matches: allMatches };
	}

	return { redacted: obj, hasSecrets: false, matches: [] };
}

