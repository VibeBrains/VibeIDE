/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { WORKTREE_DIR } from '../common/worktreeNaming.js';

/**
 * VibeIDE default-setting overrides — changes the DEFAULT value of upstream settings (an explicit
 * user/workspace setting still wins). Cross-platform mechanism (desktop + web): the configuration
 * registry's default-overrides bucket. `product.json.configurationDefaults` only applies to the
 * web build, so it's not used here.
 *
 * - `editor.wordWrap: 'on'` — users overwhelmingly turn word wrap ON; ship it on by default.
 * - `workbench.experimental.modernUI: true` — the refreshed workbench styling (floating side bars
 *   with rounded corners, reworked tabs, pane headers and title bar). Upstream keeps it behind an
 *   experiment it rolls out through its own A/B service, which this fork does not talk to — so
 *   without an explicit default nobody here would ever see it.
 * - `files.watcherExclude` gains the agent worktrees folder: each worktree is a full checkout of the project, often
 *   with a copy of its dependencies, and watching it would multiply the watcher load per running role.
 *   Object defaults merge with upstream's, so its own exclusions stay. No leading `**`, as upstream advises:
 *   that pattern turns into a regular expression slow enough to matter in large workspaces
 * - `editor.scrollbar.verticalScrollbarSize` and `horizontalScrollbarSize: 8` — upstream draws the editor bar 7px wide
 *   and 6px high; `vibeScroll.css` paints a thumb inside that lane with a transparent border on each side, so the lane
 *   has to be 8px for the thumb to come out 4px like in the side panels. The lane is also where the overview ruler
 *   (marks of errors, changes and matches) is drawn, it follows the same size and stays readable
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([
	{ overrides: { 'editor.wordWrap': 'on' } },
	{ overrides: { 'workbench.experimental.modernUI': true } },
	{ overrides: { 'files.watcherExclude': { [`${WORKTREE_DIR}/**`]: true, [`*/${WORKTREE_DIR}/**`]: true } } },
	{ overrides: { 'editor.scrollbar.verticalScrollbarSize': 8, 'editor.scrollbar.horizontalScrollbarSize': 8 } },
]);
