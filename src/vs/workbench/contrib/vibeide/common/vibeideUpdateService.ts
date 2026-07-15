/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { VibeideCheckUpdateResponse } from './vibeideUpdateServiceTypes.js';



export interface IVibeideUpdateService {
	readonly _serviceBrand: undefined;
	check: (explicit: boolean) => Promise<VibeideCheckUpdateResponse>;
	/** Download release asset to temp, verify SHA-256, then reveal in system file manager. */
	downloadVerifiedReleaseAsset: (assetUrl: string, expectedSha256Hex: string, fileName: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}


export const IVibeideUpdateService = createDecorator<IVibeideUpdateService>('VibeideUpdateService');


// Реализация — `electron-browser/vibeideUpdateService.ts`: она держит `IMainProcessService`,
// запрещённый и в `common/**`, и в `browser/**`. Контракт обязан остаться здесь: его используют ОБЕ
// стороны канала — `browser/vibeideUpdateActions.ts` инжектит декоратор, а
// `electron-main/vibeideUpdateMainService.ts` реализует тот же интерфейс на стороне main.
