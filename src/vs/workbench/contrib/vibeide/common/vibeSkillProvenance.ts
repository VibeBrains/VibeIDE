/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Откуда взялся скилл: пришёл с релизом, правлен вами или принесён со стороны.
 *
 * WHY it matters more for skills than for any other file in `.vibe`: a skill is the one thing there
 * that routinely arrives from strangers — the format is shared, and someone else's skill works here
 * as-is, and hostile skills are a documented supply chain rather than a hypothesis: 386 malicious
 * skills on ClawHub posing as exchange integrations and stealing keys, wallets and SSH credentials
 * (Infosecurity Magazine, 2026-02-03), and the ClawHavoc campaign with more than 1184 infected
 * skills (arXiv 2604.02837, April 2026). A figure that circulated with a 2026-09-08 digest —
 * 17 800 add-ons across 6.7 million installs (aiagentstore.ai) — has no primary source behind it
 * and is deliberately not relied on here. «Откуда это у меня» is the question a user cannot answer
 * by reading the file, because a hostile skill reads like a helpful one.
 *
 * Pure and free of I/O: both facts it needs are already computed elsewhere — the set's manifest
 * knows which paths it ships, and `isUntouchedPastRevision` knows whether a copy matches any
 * revision the set ever published.
 */

import { localize } from '../../../../nls.js';

export type SkillOrigin =
	/** Приехал с релизом и не тронут. */
	| 'shipped'
	/** Приехал с релизом, но содержимое не совпадает ни с одной известной набору ревизией. */
	| 'shipped-edited'
	/** Набор такого пути не знает: написан здесь или принесён со стороны. */
	| 'foreign';

export interface SkillProvenance {
	readonly origin: SkillOrigin;
	/** Короткая фраза для интерфейса — уже на русском, готова к показу. */
	readonly label: string;
}

/**
 * Путь скилла в системе координат НАБОРА.
 *
 * The library reports a workspace-relative path (`.vibe/skills/foo/SKILL.md`), while the manifest
 * ships paths relative to `.vibe` itself (`skills/foo/SKILL.md`). Comparing the two without this
 * would classify every seeded skill as foreign — the failure would look like «все скиллы чужие»,
 * which reads as a scare rather than as a bug.
 *
 * Returns `undefined` for a path that is not under `.vibe/skills/` at all — a global skill from
 * outside the workspace, which the set by definition does not ship.
 */
export function setRelativeSkillPath(relativePath: string): string | undefined {
	const normalised = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
	const marker = '.vibe/';
	const at = normalised.startsWith(marker) ? 0 : normalised.indexOf(`/${marker}`);
	if (at < 0) {
		return undefined;
	}
	const tail = normalised.slice(at === 0 ? marker.length : at + 1 + marker.length);
	return tail.startsWith('skills/') ? tail : undefined;
}

/**
 * Классификация по двум уже известным фактам.
 *
 * `isUntouched` is only meaningful when the set knows the path; the caller need not compute it
 * otherwise, and passing `false` for an unknown path does not change the answer.
 */
export function classifySkillProvenance(knownToSet: boolean, isUntouched: boolean): SkillProvenance {
	const origin: SkillOrigin = !knownToSet ? 'foreign' : isUntouched ? 'shipped' : 'shipped-edited';
	return { origin, label: skillOriginLabel(origin) };
}

/** The words for an origin, ready to show. */
export function skillOriginLabel(origin: SkillOrigin): string {
	switch (origin) {
		// Deliberately not called «чужой»: a skill the user wrote themselves lands here too, and
		// calling their own work foreign teaches them to ignore the label.
		case 'foreign': return localize('vibeide.skills.origin.foreign', "не из релиза — свой или со стороны");
		case 'shipped': return localize('vibeide.skills.origin.shipped', "из релиза");
		case 'shipped-edited': return localize('vibeide.skills.origin.shippedEdited', "из релиза, изменён");
	}
}
