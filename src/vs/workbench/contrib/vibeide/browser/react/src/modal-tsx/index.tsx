/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js';
import { VibeModalContainer } from './VibeModalContainer.js';

// `_registerServices` (called inside the mount) is idempotent as of Z.12.2,
// so this can use the standard generator without causing duplicate global
// listeners. The Z.12.2 NoRegister variant is removed.
export const mountVibeModalRoot = mountFnGenerator(VibeModalContainer);
