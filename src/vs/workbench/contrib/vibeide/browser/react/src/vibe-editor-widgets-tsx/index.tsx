/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { mountFnGenerator } from '../util/mountFnGenerator.js';
import { VibeCommandBarMain } from './VibeCommandBar.js';
import { VibeSelectionHelperMain } from './VibeSelectionHelper.js';

export const mountVibeCommandBar = mountFnGenerator(VibeCommandBarMain);

export const mountVibeSelectionHelper = mountFnGenerator(VibeSelectionHelperMain);

