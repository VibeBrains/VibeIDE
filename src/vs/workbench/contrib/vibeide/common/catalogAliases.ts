/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Плавающие идентификаторы каталога: id, который сегодня и завтра ведёт к разным моделям.
 *
 * WHY this matters more than it looks: a model quirk is recorded against an id. When that id floats,
 * the vendor re-points it at a new snapshot and nothing announces the change — the incompatibility
 * does not fail, it quietly behaves differently. A quirk pinned to a floating id is therefore a
 * statement about whatever happens to be behind it today, and the only defence is to SEE that the id
 * floats before pinning anything to it.
 *
 * Two shapes carry this in the OpenRouter catalogue, and both are real (checked live 12.09.2026 —
 * 16 entries of the first kind, 294 of the second):
 *
 *   - an explicit alias: `alias_target: { slug }`, with the id itself marked by a leading `~`;
 *   - a dated snapshot: `canonical_slug` differing from the id, e.g. `sakana/fugu-ultra-v2`
 *     resolving to `sakana/fugu-ultra-v2-20260911`.
 *
 * Display-only, like `modality`: nothing routes on it. Its whole job is to be visible in the model
 * list next to the id, so a person pinning a quirk knows which name to pin it to.
 *
 * Pure: a catalogue entry in, a string or nothing out.
 */

/** The slug a floating id points at right now, or `undefined` when the id is fixed. */
export function floatingTargetOf(model: unknown, id: string): string | undefined {
	if (!model || typeof model !== 'object') { return undefined; }
	const entry = model as { alias_target?: unknown; canonical_slug?: unknown };
	const alias = entry.alias_target;
	if (alias && typeof alias === 'object') {
		const slug = (alias as { slug?: unknown }).slug;
		if (typeof slug === 'string' && slug.length > 0 && slug !== id) { return slug; }
	}
	const canonical = entry.canonical_slug;
	// A canonical slug equal to the id says the opposite of floating — the id IS the canonical name.
	if (typeof canonical === 'string' && canonical.length > 0 && canonical !== id) { return canonical; }
	return undefined;
}
