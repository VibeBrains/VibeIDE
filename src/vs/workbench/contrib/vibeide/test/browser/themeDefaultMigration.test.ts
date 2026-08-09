/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { planThemeMigration } from '../../browser/vibeThemeDefaultMigration.js';

suite('VibeIDE default theme migration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('decides per settings state', () => {
		assert.deepStrictEqual(
			{
				onOldDefault: planThemeMigration('vibe-neon', undefined),
				onOldDefaultWithPairedDark: planThemeMigration('vibe-neon', 'vibe-neon'),
				onOldDefaultWithOtherDark: planThemeMigration('vibe-neon', 'Dark Modern'),
				chosenNoGlowVariant: planThemeMigration('vibe-neon-noglow', undefined),
				chosenMarketplaceTheme: planThemeMigration('One Dark Pro', undefined),
				chosenLightTheme: planThemeMigration('Light Modern', undefined),
				alreadyMigrated: planThemeMigration('vibe-midnight', 'vibe-midnight'),
				neverWroteTheSetting: planThemeMigration(undefined, undefined),
				// A lone preferredDark must not move on its own: it pairs with the active theme
				// for auto-switching, and rewriting half the pair breaks it silently.
				onlyPreferredDarkOnOldDefault: planThemeMigration('Light Modern', 'vibe-neon'),
			},
			{
				onOldDefault: ['workbench.colorTheme'],
				onOldDefaultWithPairedDark: ['workbench.colorTheme', 'workbench.preferredDarkColorTheme'],
				onOldDefaultWithOtherDark: ['workbench.colorTheme'],
				chosenNoGlowVariant: [],
				chosenMarketplaceTheme: [],
				chosenLightTheme: [],
				alreadyMigrated: [],
				neverWroteTheSetting: [],
				onlyPreferredDarkOnOldDefault: [],
			},
		);
	});
});
