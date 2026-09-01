/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';

/**
 * Category every VibeIDE command is filed under in the command palette.
 *
 * The palette renders `<category>: <title>`, so a title must NOT repeat the prefix — that is how
 * «VibeIDE: VibeIDE: Показать токен HTTP API» happened. One shared constant instead of a literal
 * per call site (and three local copies) keeps the grouping from drifting apart word by word.
 */
export const VIBE_COMMAND_CATEGORY: ILocalizedString = localize2('vibeide.commandCategory', 'VibeIDE');

/** Diagnostics commands sit in their own group so troubleshooting is not mixed into daily work. */
export const VIBE_DIAGNOSTICS_COMMAND_CATEGORY: ILocalizedString = localize2('vibeide.diagnosticsCommandCategory', 'VibeIDE Diagnostics');

/**
 * Groups that are deliberately separate in the palette.
 *
 * They are here rather than inline for the same reason as the main one: a second copy of the
 * string is a second chance to write it differently, and the palette groups by exact text.
 */
export const VIBE_CLOUD_COMMAND_CATEGORY: ILocalizedString = localize2('vibeide.cloudCommandCategory', 'VibeIDE Cloud');

/** Developer-only commands: kept out of the daily group so they do not clutter it. */
export const VIBE_DEV_COMMAND_CATEGORY: ILocalizedString = localize2('vibeide.devCommandCategory', 'VibeIDE Dev');
