/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { groupSkillsByDomain, shouldGroupSkills, SKILL_DOMAIN_OTHER, SKILL_GROUPING_MIN_SKILLS } from '../../common/skillDomains.js';

/**
 * Grouping the skill catalogue by domain.
 *
 * The list is read by a person hunting for one skill among dozens, so what matters is that the
 * order never surprises them and that nothing disappears between the headers.
 */
suite('skill domains', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const skills = [
		{ skillId: 'deploy-staging', tags: ['ops', 'ci'] },
		{ skillId: 'review-pr', tags: ['review'] },
		{ skillId: 'grill', tags: ['review'] },
		{ skillId: 'party' },
		{ skillId: 'incident-review', tags: ['ops'] },
		{ skillId: 'teach', tags: [''] },
	];

	test('first tag is the domain, groups and skills sorted, untagged last', () => {
		assert.deepStrictEqual(
			groupSkillsByDomain(skills).map(g => [g.domain, g.skills.map(s => s.skillId)]),
			[
				['ops', ['deploy-staging', 'incident-review']],
				['review', ['grill', 'review-pr']],
				[SKILL_DOMAIN_OTHER, ['party', 'teach']],
			],
		);
	});

	/** A skill with no usable tag must land in a named group, not vanish between headers. */
	test('nothing is lost — every skill appears exactly once', () => {
		const grouped = groupSkillsByDomain(skills).flatMap(g => g.skills.map(s => s.skillId));
		assert.strictEqual(grouped.length, skills.length);
		assert.deepStrictEqual([...grouped].sort(), skills.map(s => s.skillId).sort());
	});

	test('case and padding in a tag do not split one domain in two', () => {
		assert.deepStrictEqual(
			groupSkillsByDomain([
				{ skillId: 'a', tags: ['Ops'] },
				{ skillId: 'b', tags: ['  ops  '] },
			]).map(g => g.domain),
			['ops'],
		);
	});

	/** One group is a header over the whole list — noise, not structure. */
	test('grouping switches on only when it helps', () => {
		const many = Array.from({ length: SKILL_GROUPING_MIN_SKILLS }, (_, i) => ({ skillId: `s${i}`, tags: [i % 2 ? 'a' : 'b'] }));
		assert.strictEqual(shouldGroupSkills(groupSkillsByDomain(many), many.length), true);
		const few = many.slice(0, SKILL_GROUPING_MIN_SKILLS - 1);
		assert.strictEqual(shouldGroupSkills(groupSkillsByDomain(few), few.length), false);
		const oneDomain = many.map(s => ({ ...s, tags: ['a'] }));
		assert.strictEqual(shouldGroupSkills(groupSkillsByDomain(oneDomain), oneDomain.length), false);
	});
});
