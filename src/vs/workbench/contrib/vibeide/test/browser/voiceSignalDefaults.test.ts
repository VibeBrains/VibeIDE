/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { registerAccessibilityConfiguration } from '../../../accessibility/browser/accessibilityConfiguration.js';

suite('Voice input — start and stop sounds', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The dictation sounds play through the accessibility signals of VS Code (speechAccessibilitySignal.ts)
	// With `sound: 'auto'` they would be heard only with a screen reader attached
	// A merge of a newer VS Code base that flips the default must fail here, not go unnoticed in the field
	test('both signals are on by default for everyone, not only with a screen reader', () => {
		registerAccessibilityConfiguration();
		const properties = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		assert.deepStrictEqual({
			started: properties['accessibility.signals.voiceRecordingStarted']?.default,
			stopped: properties['accessibility.signals.voiceRecordingStopped']?.default,
			volume: properties['accessibility.signalOptions.volume']?.default,
		}, {
			started: { sound: 'on' },
			stopped: { sound: 'on' },
			volume: 70,
		});
	});
});
