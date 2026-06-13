/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Что нового» (What's New) — curated, hand-written highlights per release, shown once in a modal
 * after an update (see `browser/vibeWhatsNewContribution.ts`). Bundled as code (no I/O, no path
 * resolution across dev/installed/portable), keyed by `vibeVersion`. A version WITHOUT an entry
 * shows nothing — patch releases that need no announcement simply omit a key.
 *
 * Pure module → unit-testable. Content is Markdown (rendered via the modal's `bodyMarkdown`).
 *
 * RELEASE STEP: add an entry for the new version here when its changelog is worth surfacing.
 */

/** Markdown highlights keyed by exact `vibeVersion` (e.g. "1.1.0"). */
export const WHATS_NEW_BY_VERSION: Readonly<Record<string, string>> = {
	'1.1.0': [
		'## ✨ Свои LLM-провайдеры без пересборки',
		'',
		'Теперь провайдеров и модели можно настраивать файлом **`.vibe/providers.json`** — без пересборки IDE:',
		'',
		'- **Новые провайдеры** (OpenAI-совместимые) одним файлом: `baseURL`, заголовки, ключ через `apiKeyEnv` или `apiKeyRef` — **сам ключ в файле не хранится**.',
		'- **Патч встроенных** по совпадению `id`, **клон** через `extends`, порядок через `order`, тумблеры `active: true|false`.',
		'- **IntelliSense + диагностика** прямо в редакторе и команда «VibeIDE: Показать распознанные провайдеры» (там же — список id встроенных).',
		'',
		'Рецепты и пример — в `.vibe/providers.example.jsonc`.',
	].join('\n'),
};

/** Strip a leading `v` and surrounding whitespace from a version string. */
function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/i, '');
}

/**
 * Highlights Markdown for the given `vibeVersion`, or `undefined` when there's nothing to announce
 * for it. The contribution treats `undefined` as «don't show the modal».
 */
export function getWhatsNewForVersion(version: string | undefined): string | undefined {
	if (!version) { return undefined; }
	return WHATS_NEW_BY_VERSION[normalizeVersion(version)];
}
