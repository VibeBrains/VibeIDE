/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGeneratorNoRegister } from '../util/mountFnGeneratorNoRegister.js';
import { VibeModalContainer } from './VibeModalContainer.js';

// We use the `NoRegister` variant — VibeModal portal mounts at workbench
// level which fires AFTER the chat sidebar mount has already wired services.
// Re-running `_registerServices` would double-subscribe every onDidChange*
// emitter and starve the renderer on heavy chat events (root cause of the
// «freezes after first prompt» regression that motivated Z.12).
export const mountVibeModalRoot = mountFnGeneratorNoRegister(VibeModalContainer);
