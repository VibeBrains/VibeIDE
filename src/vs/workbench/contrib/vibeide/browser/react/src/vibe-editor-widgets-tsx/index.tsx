/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { VibeCommandBarMain } from './VibeCommandBar.js'
import { VibeSelectionHelperMain } from './VibeSelectionHelper.js'

export const mountVibeCommandBar = mountFnGenerator(VibeCommandBarMain)

export const mountVibeSelectionHelper = mountFnGenerator(VibeSelectionHelperMain)

