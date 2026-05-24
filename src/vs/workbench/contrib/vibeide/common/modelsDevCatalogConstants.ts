/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared constants for the models.dev catalog pipeline. Imported by both
 * main-process (`electron-main/llmMessage/modelsDevCatalog.ts` — fetch +
 * snapshot loader) and renderer (`browser/modelsDevCatalogStatusContribution.ts`
 * — toast/modal UI). Single source of truth so a future endpoint or
 * filename change is a one-line edit.
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** Filename users place in any of the resolved candidate paths. */
export const LOCAL_SNAPSHOT_FILENAME = 'models.dev.json';
