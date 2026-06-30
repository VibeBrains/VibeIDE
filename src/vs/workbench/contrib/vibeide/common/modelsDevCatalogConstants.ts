/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

/** Discriminator for the catalog snapshot source — see ModelsDevCatalogStatus. */
export type ModelsDevCatalogSource = 'exeDir' | 'bundled' | 'userData';

/**
 * Human-readable description of a snapshot source — used in toast/modal copy
 * to tell the user WHERE the active catalog came from. Was duplicated in two
 * contribution files; centralized so a future label tweak is a one-line edit.
 *
 * The wording is intentional: emphasizes user-curated paths (exeDir) as the
 * "you placed this" source vs auto-cached Roaming snapshot.
 */
export const labelOfSource = (source: ModelsDevCatalogSource): string => {
	switch (source) {
		case 'exeDir': return 'снимок, который вы положили рядом с VibeIDE.exe';
		case 'bundled': return 'встроенный снимок (из ресурсов установки)';
		case 'userData': return 'кэшированный снимок из пользовательских данных';
	}
};
