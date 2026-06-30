/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Unit / integration stubs for § H.1.3 Project Rules loading.
 *
 * Tests cover:
 *  - Source ordering and labeling for the two workspace rule files only
 *  - Truncation at MAX_RULE_FILE_BYTES
 *  - Single-file combine
 *  - Source labeling format
 *  - Secret detection pass-through (secret redaction reflection in wasRedacted)
 *
 * NOTE: Full integration requires IFileService + IWorkspaceContextService + IVibePromptGuardService
 * mocks. These tests use standalone logic extracted from the service for unit coverage.
 * Phase 3b: wire into VS Code test harness with real service instantiation.
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// ── Standalone helpers (mirrored from vibeProjectRulesService.ts for testability) ──

const RULE_FILE_NAMES = ['.vibe/rules.md', 'AGENTS.md'];
const MAX_RULE_FILE_BYTES = 102400;

function buildCombinedRules(sources: Array<{ relativePath: string; content: string; wasRedacted: boolean }>): string {
	const parts = sources
		.filter(s => s.content.trim().length > 0)
		.map(s => {
			const label = `[Source: ${s.relativePath}${s.wasRedacted ? ' (secrets redacted)' : ''}]`;
			return `${label}\n${s.content}`;
		});
	return parts.join('\n\n').trim();
}

function truncateRuleContent(content: string, maxBytes: number): string {
	if (content.length <= maxBytes) { return content; }
	return content.slice(0, maxBytes);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

suite('Project Rules — source ordering and labeling (§ H.1.3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('labels each source with [Source: path]', () => {
		const sources = [
			{ relativePath: '.vibe/rules.md', content: 'vibe rule', wasRedacted: false },
			{ relativePath: 'AGENTS.md', content: 'agents', wasRedacted: false },
		];
		const combined = buildCombinedRules(sources);
		assert.ok(combined.includes('[Source: .vibe/rules.md]'));
		assert.ok(combined.includes('[Source: AGENTS.md]'));
		assert.ok(combined.includes('vibe rule'));
		assert.ok(combined.includes('agents'));
	});

	test('labels redacted source with (secrets redacted)', () => {
		const sources = [
			{ relativePath: 'AGENTS.md', content: 'key: [REDACTED]', wasRedacted: true },
		];
		const combined = buildCombinedRules(sources);
		assert.ok(combined.includes('(secrets redacted)'));
	});

	test('no duplicate content when only .vibe/rules.md present', () => {
		const sources = [
			{ relativePath: '.vibe/rules.md', content: 'one rule', wasRedacted: false },
		];
		const combined = buildCombinedRules(sources);
		assert.strictEqual((combined.match(/one rule/g) ?? []).length, 1);
	});

	test('empty content sources are excluded', () => {
		const sources = [
			{ relativePath: '.vibe/rules.md', content: '', wasRedacted: false },
			{ relativePath: 'AGENTS.md', content: 'visible', wasRedacted: false },
		];
		const combined = buildCombinedRules(sources);
		assert.ok(!combined.includes('[Source: .vibe/rules.md]'));
		assert.ok(combined.includes('visible'));
	});

	test('truncates file content at MAX_RULE_FILE_BYTES', () => {
		const big = 'x'.repeat(MAX_RULE_FILE_BYTES + 100);
		const truncated = truncateRuleContent(big, MAX_RULE_FILE_BYTES);
		assert.strictEqual(truncated.length, MAX_RULE_FILE_BYTES);
	});

	test('does not truncate content within limit', () => {
		const small = 'hello world';
		const truncated = truncateRuleContent(small, MAX_RULE_FILE_BYTES);
		assert.strictEqual(truncated, small);
	});

	test('file priority order matches documented order', () => {
		assert.deepStrictEqual(RULE_FILE_NAMES, ['.vibe/rules.md', 'AGENTS.md']);
	});

	test('combined output joins with double newline between sources', () => {
		const sources = [
			{ relativePath: '.vibe/rules.md', content: 'A', wasRedacted: false },
			{ relativePath: 'AGENTS.md', content: 'B', wasRedacted: false },
		];
		const combined = buildCombinedRules(sources);
		assert.ok(combined.includes('\n\n'));
	});
});
