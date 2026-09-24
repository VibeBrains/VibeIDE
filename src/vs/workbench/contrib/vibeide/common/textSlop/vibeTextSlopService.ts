/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The text-slop detector as the product uses it: the catalogue shipped in the build, with the project's
 * `.vibe/slop.json` applied.
 *
 * The project file is read on every check, so an edit applies from the next check and nothing has to watch it.
 * The checks run in a web worker under a time budget — the implementation is `browser/vibeTextSlopService.ts`:
 * a project pattern can backtrack for hours, and a regex cannot be interrupted on the thread it runs on.
 * Depends on platform services only: `ToolsService` injects it, and a Vibe service here would reopen the
 * dependency cycle the design-context service warns about.
 */

import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { SlopFinding, SlopReport } from './textSlop.js';

export const SLOP_PROJECT_FILE = '.vibe/slop.json';

/** How long one check may run before its worker is stopped — see `checkWithinBudget` */
export const SLOP_CHECK_TIMEOUT_KEY = 'vibeide.textSlop.checkTimeoutMs';
export const SLOP_CHECK_TIMEOUT_DEFAULT_MS = 20_000;

export interface TextSlopCheck {
	readonly report: SlopReport;
	readonly warnings: readonly string[];
}

export const IVibeTextSlopService = createDecorator<IVibeTextSlopService>('vibeTextSlopService');

export interface IVibeTextSlopService {
	readonly _serviceBrand: undefined;
	/** A text checked against the project's catalogue, any line endings; undefined when the build carries none or the check could not finish */
	check(text: string, folder?: URI): Promise<TextSlopCheck | undefined>;
	/**
	 * The findings of every text of a page, by text: list and template rules only, the project's rules applied
	 * Undefined when there is no catalogue or the check could not finish — the page rule then stays silent rather than guess
	 */
	pageFindings(texts: readonly string[], folder?: URI): Promise<ReadonlyMap<string, readonly SlopFinding[]> | undefined>;
}
