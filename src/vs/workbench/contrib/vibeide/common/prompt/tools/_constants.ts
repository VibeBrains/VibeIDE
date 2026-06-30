/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Leaf constants shared between tool definitions and the wider prompt builder.
// Lives here (and is re-exported from prompts.ts) so per-tool modules don't have
// to import from prompts.ts itself, which would form a cycle through tools/index.ts.

export const MAX_TERMINAL_INACTIVE_TIME = 8; // seconds
export const MAX_TERMINAL_BG_COMMAND_TIME = 5;

export const ORIGINAL = `<<<<<<< ORIGINAL`;
export const DIVIDER = `=======`;
export const FINAL = `>>>>>>> UPDATED`;

export const tripleTick: readonly [string, string] = ['```', '```'];

export const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`;
