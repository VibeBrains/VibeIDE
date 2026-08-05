/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Binds the build-time documentation bundle to the pure search core.
 *
 * Deliberately a module with a lazy cache rather than a service: there is no state to own, no
 * disposal, and nothing to inject — the bundle is a constant compiled into the build. Splitting
 * ~120 KB into sections costs a few milliseconds, so it is done once on first use and reused;
 * a service wrapper around that would be ceremony without a reader.
 */

import { DocsSearchHit, DocsSection, formatHits, searchDocs, splitIntoSections } from './docsSearch.js';
import { VIBE_DOCS_BUNDLE } from './vibeDocsBundle.generated.js';

let cachedSections: DocsSection[] | undefined;

/** All indexed sections of the shipped documentation. Built once, then reused. */
export function getDocsSections(): readonly DocsSection[] {
	if (!cachedSections) {
		cachedSections = VIBE_DOCS_BUNDLE.flatMap(entry => splitIntoSections(entry.file, entry.contents));
	}
	return cachedSections;
}

/** Files present in the bundle — used to tell "no match" apart from "nothing was indexed". */
export function getDocsFiles(): readonly string[] {
	return VIBE_DOCS_BUNDLE.map(e => e.file);
}

/** Searches the shipped documentation. */
export function searchVibeDocs(query: string, limit?: number): DocsSearchHit[] {
	return searchDocs(getDocsSections(), query, limit);
}

/**
 * Search result rendered for a model or the UI. Returns an explicit "nothing found" line instead
 * of an empty string: a silent empty answer reads as "the tool is broken", and the agent then
 * goes looking on the internet — exactly the behaviour this feature exists to stop.
 */
export function searchVibeDocsFormatted(query: string, limit?: number): string {
	const hits = searchVibeDocs(query, limit);
	if (!hits.length) {
		return `По запросу «${query}» в документации VibeIDE ничего не найдено (просмотрено файлов: ${getDocsFiles().length}). Переформулируй запрос или спроси пользователя — не выдумывай ответ.`;
	}
	return formatHits(hits);
}

/** Full text of one bundled file, for reading a section in context after a search. */
export function readVibeDocsFile(file: string): string | undefined {
	return VIBE_DOCS_BUNDLE.find(e => e.file === file)?.contents;
}
