/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Theme contribution + command palette UX; vibeide.* commands register in core (vibeCommands).
 *
 *  i18n: this file lives under extensions/, so per the L515 split decision
 *  (docs/references-v1/l10n-vs-nls-decision.md) any future user-facing strings
 *  added here MUST use vscode.l10n.t() with a package.json:l10n bundle path —
 *  NOT nls.localize(). Theme contributions in package.json keep using the
 *  built-in `%key%` placeholders backed by package.nls.json (VS Code core).
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** @param {import('vscode').ExtensionContext} _context */
function activate(_context) { }

function deactivate() { }

module.exports = { activate, deactivate };
