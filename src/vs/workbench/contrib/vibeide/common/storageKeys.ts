/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// past values:
// 'vibe.settingsServiceStorage'
// 'vibe.settingsServiceStorageI' // 1.0.2

// 1.0.3 (VibeIDE)
export const VOID_SETTINGS_STORAGE_KEY = 'vibeide.settingsServiceStorageII';


// past values:
// 'vibe.chatThreadStorage'
// 'vibe.chatThreadStorageI' // 1.0.2

// 1.0.3 (VibeIDE)
export const THREAD_STORAGE_KEY = 'vibeide.chatThreadStorageII';

// Open chat tabs (refactor B): the working set of threads shown as in-view tabs above the chat.
// WORKSPACE-scoped so each project keeps its own open tabs (mirrors the old per-workspace editor layout).
export const OPEN_TAB_IDS_KEY = 'vibeide.chatOpenTabIds';



export const OPT_OUT_KEY = 'vibeide.app.optOutAll';
