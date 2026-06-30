/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseSkillMarkdown, orderedTransitiveDependencySkillIds, serializeSkillMarkdown } from '../../common/vibeSkillsLibraryService.js';

suite('Agent Skills — parseSkillMarkdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('parses YAML frontmatter with vibeVersion', () => {
		const raw = `---
name: demo-skill
description: Used when testing skill parsing.
vibeVersion: 1.0.0
---

# Demo

Body line.
`;
		const p = parseSkillMarkdown(raw, '.vibe/skills/demo/SKILL.md', 'fallback');
		assert.ok(p);
		assert.strictEqual(p!.skillId, 'demo-skill');
		assert.strictEqual(p!.vibeVersion, '1.0.0');
		assert.ok(p!.body.includes('Body line.'));
	});

	test('returns null when name/description missing in YAML block', () => {
		const raw = `---
vibeVersion: 1
---

# X
`;
		const p = parseSkillMarkdown(raw, 'SKILL.md', 'x');
		assert.strictEqual(p, null);
	});

	test('parses optional precheck from YAML', () => {
		const raw = `---
name: hook-demo
description: Demo precheck field.
vibeVersion: 1.0.0
precheck: scripts/check-env.sh
---

# Demo
`;
		const p = parseSkillMarkdown(raw, '.vibe/skills/hook-demo/SKILL.md', 'hook-demo');
		assert.ok(p);
		assert.strictEqual(p!.precheck, 'scripts/check-env.sh');
	});

	test('parses depends list from YAML', () => {
		const raw = `---
name: child
description: Child skill.
vibeVersion: 1.0.0
depends:
  - base-a
  - base-b
---

# Child
x
`;
		const p = parseSkillMarkdown(raw, '.vibe/skills/child/SKILL.md', 'child');
		assert.ok(p);
		assert.deepStrictEqual(p!.depends, ['base-a', 'base-b']);
	});

	test('orderedTransitiveDependencySkillIds returns deps before skill chain', () => {
		const baseA = parseSkillMarkdown(`---
name: base-a
description: A
vibeVersion: 1.0.0
---
# A
`, 'a/SKILL.md', 'base-a')!;
		const baseB = parseSkillMarkdown(`---
name: base-b
description: B
vibeVersion: 1.0.0
depends:
  - base-a
---
# B
`, 'b/SKILL.md', 'base-b')!;
		const child = parseSkillMarkdown(`---
name: child
description: C
vibeVersion: 1.0.0
depends:
  - base-b
---
# C
`, 'c/SKILL.md', 'child')!;
		const order = orderedTransitiveDependencySkillIds('child', [child, baseB, baseA]);
		assert.deepStrictEqual(order, ['base-a', 'base-b']);
	});

	test('serializeSkillMarkdown round-trip preserves id, description, and body via parseSkillMarkdown', () => {
		const body = '## Do\n\nThings.\n';
		const md = serializeSkillMarkdown({ name: 'rt-skill', description: 'Round trip test.', body, vibeVersion: '1.0.0' });
		const parsed = parseSkillMarkdown(md, '.vibe/skills/rt-skill/SKILL.md', 'rt-skill');
		assert.ok(parsed);
		assert.strictEqual(parsed!.skillId, 'rt-skill');
		assert.strictEqual(parsed!.description, 'Round trip test.');
		assert.strictEqual(parsed!.vibeVersion, '1.0.0');
		assert.ok(parsed!.body.includes('Things.'));
	});
});
