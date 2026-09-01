/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Grouping the skill catalogue by domain — the decision half, no UI.
 *
 * A flat list works while there are ten skills and stops working at thirty: the person scrolls
 * looking for «that one about deploys» and reads every description on the way. Skills already carry
 * `tags` in their metadata — parsed since the format shipped and, until now, read by nothing but
 * search. The first tag is the domain; the rest stay searchable.
 *
 * No new field on purpose. Inventing `domain` next to `tags` would give two half-used ways to say
 * the same thing, and every skill already written would have neither.
 */

/** Skills that named no tag. Named explicitly so they do not silently vanish under a group header. */
export const SKILL_DOMAIN_OTHER = '__other__';

export interface SkillLike {
	readonly skillId: string;
	readonly tags?: readonly string[];
}

export interface SkillDomainGroup<T> {
	readonly domain: string;
	/** What to show as the separator label. */
	readonly label: string;
	readonly skills: readonly T[];
}

/** Human label for a domain id. Unknown domains show their own name — the tag is already a word. */
export function skillDomainLabel(domain: string): string {
	return domain === SKILL_DOMAIN_OTHER
		? localize('vibeide.skills.domainOther', 'Без раздела')
		: domain;
}

/**
 * Group skills by their first tag, alphabetically, with the untagged group last.
 *
 * Order is fixed rather than «by size» or «by recency»: a list that reshuffles itself between
 * openings costs more than it saves — muscle memory stops working, and the person re-reads what
 * they already knew. Untagged goes last because it is a leftover, not a category.
 */
export function groupSkillsByDomain<T extends SkillLike>(skills: readonly T[]): SkillDomainGroup<T>[] {
	const byDomain = new Map<string, T[]>();
	for (const skill of skills) {
		const domain = skill.tags?.find(tag => tag.trim().length > 0)?.trim().toLowerCase() ?? SKILL_DOMAIN_OTHER;
		const bucket = byDomain.get(domain);
		if (bucket) { bucket.push(skill); } else { byDomain.set(domain, [skill]); }
	}
	const domains = [...byDomain.keys()]
		.filter(d => d !== SKILL_DOMAIN_OTHER)
		.sort((a, b) => a.localeCompare(b));
	if (byDomain.has(SKILL_DOMAIN_OTHER)) { domains.push(SKILL_DOMAIN_OTHER); }
	return domains.map(domain => ({
		domain,
		label: skillDomainLabel(domain),
		skills: byDomain.get(domain)!.slice().sort((a, b) => a.skillId.localeCompare(b.skillId)),
	}));
}

/**
 * Are there enough groups for grouping to help?
 *
 * One group is not a grouping — it is a header above the whole list, pure noise. Below this many
 * skills the flat list is still readable, and separators only add rows to scroll past.
 */
export const SKILL_GROUPING_MIN_SKILLS = 8;

export function shouldGroupSkills(groups: readonly SkillDomainGroup<unknown>[], totalSkills: number): boolean {
	return groups.length > 1 && totalSkills >= SKILL_GROUPING_MIN_SKILLS;
}
