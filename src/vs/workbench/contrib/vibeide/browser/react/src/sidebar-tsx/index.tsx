/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { mountFnGenerator } from '../util/mountFnGenerator.js';
import { Sidebar } from './Sidebar.js';
import { SidebarHistory } from './SidebarHistory.js';

export const mountSidebar = mountFnGenerator(Sidebar);
export const mountSidebarHistory = mountFnGenerator(SidebarHistory);


