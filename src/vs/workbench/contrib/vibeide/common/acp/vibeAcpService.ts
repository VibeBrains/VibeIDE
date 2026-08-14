/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Контракт ACP со стороны рабочего стола: тот же разговор с внешним агентом, но из окна.
 *
 * Живёт в `common/`, а реализация — в `electron-browser/`: она ходит в main-процесс через
 * `IMainProcessService`, который в общем слое запрещён. Потребители при этом зависят от
 * межсредового модуля, а не от десктопного.
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVibeAcpMain } from './acpTypes.js';

export const IVibeAcpService = createDecorator<IVibeAcpService>('vibeAcpService');

export interface IVibeAcpService extends IVibeAcpMain {
	readonly _serviceBrand: undefined;
}
