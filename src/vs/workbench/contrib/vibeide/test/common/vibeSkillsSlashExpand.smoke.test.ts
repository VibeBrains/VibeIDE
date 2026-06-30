/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Smoke: end-to-end «selected skill → message contains instructions → agent follows»
 *
 * Tests the service-layer contract without requiring a Playwright / browser harness:
 *   1. parseSkillMarkdown   → VibeSkillEntry  (skill is loadable)
 *   2. buildSkillExpansion  → expanded string  (message contains skill instructions)
 *   3. Expansion prefix / structure contract   (agent sees canonical "Follow this …" header)
 *
 * The "agent follows" assertion is covered at the contract level: if the expansion string
 * is injected verbatim into the chat message, the LLM receives the full SKILL body — which
 * is the only prerequisite for the agent to follow it.  Full browser-level verification
 * requires a live model and is tracked separately.
 */

import * as assert from 'assert';
import { parseSkillMarkdown } from '../../common/vibeSkillsLibraryService.js';
import { buildSkillExpansion } from '../../common/vibeSlashCommandService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEMO_SKILL_MD = `---
name: demo-review
description: Performs a structured code review following project conventions.
vibeVersion: 1.0.0
tags: [review, code-quality]
---

# Demo Review Skill

## Instructions

When invoked, always:
1. List potential bugs.
2. Check naming conventions.
3. Suggest improvements.

**End of instructions.**
`;

const MINIMAL_SKILL_MD = `---
name: minimal-skill
description: A minimal skill with no extra fields.
vibeVersion: 1.0.0
---
Do the thing.
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Agent Skills — end-to-end smoke (select → message → agent instructions)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// -----------------------------------------------------------------------
	// Step 1: skill is loadable (parseSkillMarkdown contract)
	// -----------------------------------------------------------------------

	test('step 1 — parseSkillMarkdown produces a valid VibeSkillEntry', () => {
		const entry = parseSkillMarkdown(DEMO_SKILL_MD, '.vibe/skills/demo-review/SKILL.md', 'fallback');
		assert.ok(entry, 'parseSkillMarkdown must return a non-null entry for a valid SKILL.md');
		assert.strictEqual(entry!.skillId, 'demo-review');
		assert.strictEqual(entry!.vibeVersion, '1.0.0');
		assert.ok(entry!.body.includes('List potential bugs'), 'body must contain skill instructions');
		assert.ok(entry!.body.includes('End of instructions'), 'body must contain full instruction text');
	});

	// -----------------------------------------------------------------------
	// Step 2: message contains instructions (buildSkillExpansion contract)
	// -----------------------------------------------------------------------

	test('step 2 — buildSkillExpansion wraps skill body in canonical agent header', () => {
		const entry = parseSkillMarkdown(DEMO_SKILL_MD, '.vibe/skills/demo-review/SKILL.md', 'demo-review')!;
		const expanded = buildSkillExpansion(entry);

		assert.ok(
			expanded.startsWith('Follow this project Agent Skill (from .vibe/skills/demo-review/SKILL.md):'),
			'expanded message must start with canonical "Follow this project Agent Skill" header'
		);
		assert.ok(
			expanded.includes(entry.body),
			'expanded message must contain the full skill body verbatim'
		);
		assert.ok(
			expanded.includes('List potential bugs'),
			'expanded message must include skill instructions text'
		);
	});

	test('step 2 — buildSkillExpansion appends user args when provided', () => {
		const entry = parseSkillMarkdown(DEMO_SKILL_MD, '.vibe/skills/demo-review/SKILL.md', 'demo-review')!;
		const expanded = buildSkillExpansion(entry, 'focus on the auth module');

		assert.ok(expanded.includes('Additional context from user:'), 'must include user args section header');
		assert.ok(expanded.includes('focus on the auth module'), 'must include user-supplied args text');
	});

	test('step 2 — buildSkillExpansion omits args section when no args supplied', () => {
		const entry = parseSkillMarkdown(DEMO_SKILL_MD, '.vibe/skills/demo-review/SKILL.md', 'demo-review')!;
		const expanded = buildSkillExpansion(entry);

		assert.ok(!expanded.includes('Additional context from user:'), 'must not include args section when args are absent');
	});

	// -----------------------------------------------------------------------
	// Step 3: agent follows — structural contract assertions
	// -----------------------------------------------------------------------

	test('step 3 — expanded message structure is agent-actionable (has imperative header + non-empty body)', () => {
		const entry = parseSkillMarkdown(DEMO_SKILL_MD, '.vibe/skills/demo-review/SKILL.md', 'demo-review')!;
		const expanded = buildSkillExpansion(entry);

		// The agent must see a clear imperative ("Follow this…") so it knows to obey the skill.
		assert.match(expanded, /^Follow this project Agent Skill/, 'must open with imperative directive for the agent');

		// Body must be substantial (not empty / whitespace-only).
		const bodyPart = expanded.split(/\n\n/).slice(1).join('\n\n').trim();
		assert.ok(bodyPart.length > 20, 'skill body in expanded message must be non-trivial');
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------

	test('edge — minimal skill (no tags / version) expands correctly', () => {
		const entry = parseSkillMarkdown(MINIMAL_SKILL_MD, '.vibe/skills/minimal-skill/SKILL.md', 'minimal-skill')!;
		assert.ok(entry, 'minimal skill must parse');
		const expanded = buildSkillExpansion(entry);
		assert.ok(expanded.includes('Do the thing.'), 'minimal skill body must appear in expansion');
	});

	test('edge — skill body injected into /skill:<id> slash command produces non-null expansion', () => {
		// Simulate the slash-command pipeline: user types /skill:demo-review
		// The service calls: getSkill('demo-review') → buildSkillExpansion(skill) → sanitize
		// We test the pre-sanitize string (sanitizer is tested separately; clean text passes through).
		const entry = parseSkillMarkdown(DEMO_SKILL_MD, '.vibe/skills/demo-review/SKILL.md', 'demo-review')!;
		const msg = buildSkillExpansion(entry);

		assert.ok(msg !== null && msg.length > 0, '/skill: expansion must produce a non-empty string');
		// In the actual service this is passed to _sanitizeExpanded — for clean skill content it must
		// come through unchanged (no injection patterns, no zero-width chars).
		// We assert length is preserved (no aggressive stripping of legitimate skill content).
		assert.ok(msg.length >= entry.body.length, 'expansion must not be shorter than the raw skill body');
	});
});
