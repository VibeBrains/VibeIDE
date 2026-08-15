/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

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
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([
	{ overrides: { 'editor.wordWrap': 'on' } },
	{ overrides: { 'workbench.experimental.modernUI': true } },
]);
