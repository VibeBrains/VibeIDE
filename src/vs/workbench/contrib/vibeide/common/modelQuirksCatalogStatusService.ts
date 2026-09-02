/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Mirrors `ModelQuirksCatalogStatus` in electron-main/modelQuirks/modelQuirksService.ts.
 * Duplicated here (not imported) because workbench-layer code can't reach into
 * electron-main packages directly — same convention as modelsDevCatalogStatusService.ts.
 *
 *  - `exeAdjacent` — `model-quirks.json` dropped next to VibeIDE.exe (MAX priority).
 *  - `cdn`         — fetched from raw.githubusercontent + cached in userData.
 *  - `bundled`     — shipped TS constant inside the install.
 *  - `empty`       — nothing loaded (provider defaults everywhere).
 */
export interface ModelQuirksCatalogStatus {
	readonly source: 'exeAdjacent' | 'cdn' | 'bundled' | 'empty';
	readonly activeDate: string;
	readonly latestAvailableDate: string;
	readonly staleExeAdjacent: boolean;
	readonly exeAdjacentPath: string | null;
}

export interface IModelQuirksCatalogStatusServiceIPC {
	getStatus(): Promise<ModelQuirksCatalogStatus>;
	refresh(): Promise<boolean>;
	/**
	 * Is this model's reasoning bound to it, so a switch away silently drops it?
	 *
	 * Answered from the quirks catalogue, which lives in the main process. Exposed as its own
	 * question rather than «give me the whole quirk entry» on purpose: the browser layer has no
	 * business with sampling presets and tool-call formats, and a narrow question cannot grow into
	 * a second, diverging copy of the quirks logic on this side of the IPC.
	 */
	isReasoningBoundToModel(modelId: string, providerName?: string): Promise<boolean>;
}

export interface IModelQuirksCatalogStatusService extends IModelQuirksCatalogStatusServiceIPC {
	readonly _serviceBrand: undefined;
}

export const IModelQuirksCatalogStatusService =
	createDecorator<IModelQuirksCatalogStatusService>('modelQuirksCatalogStatusService');

// Реализация — `electron-browser/modelQuirksCatalogStatusService.ts`: она держит `IMainProcessService`,
// запрещённый в `common/**` (native-only). Здесь только контракт — потребители из `browser/` не
// должны зависеть от desktop-слоя.
