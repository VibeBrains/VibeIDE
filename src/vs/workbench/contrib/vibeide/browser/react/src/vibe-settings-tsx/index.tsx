/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { mountFnGenerator } from '../util/mountFnGenerator.js';
import { Settings } from './Settings.js';
import { VibeProjectCommandForm } from './VibeProjectCommandForm.js';

export const mountVibeSettings = mountFnGenerator(Settings);
export const mountVibeProjectCommandForm = mountFnGenerator(VibeProjectCommandForm);


