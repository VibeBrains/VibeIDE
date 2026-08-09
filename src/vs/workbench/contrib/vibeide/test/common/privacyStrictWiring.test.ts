/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VIBEIDE_PRIVACY_STRICT } from '../../common/outboundAllowlist.js';
import { decideFIMProvider, type FIMProvider } from '../../common/fimProviderRouter.js';

/**
 * Regression suite for the privacy switch wiring.
 *
 * The FIM gate used to read `globalSettings.privacyMode` — a field that exists in no type, no
 * settings registration and no writer. It was therefore always undefined, the gate never fired,
 * and `vibeide.privacy.strict` silently let tab-completion keep calling cloud providers while
 * its own description promised the opposite. The decision logic itself was fine; only the value
 * feeding it was wrong, which is why the existing router tests stayed green.
 */
suite('privacy.strict wiring', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const cloudOnly: FIMProvider[] = [
		{ id: 'anthropic', kind: 'cloud', available: true, hasCoderModel: false },
		{ id: 'openAI', kind: 'cloud', available: true, hasCoderModel: false },
	];

	const withLocal: FIMProvider[] = [
		{ id: 'ollama', kind: 'local-ollama', available: true, hasCoderModel: true },
		{ id: 'anthropic', kind: 'cloud', available: true, hasCoderModel: false },
	];

	test('the settings id is a single shared constant, not a re-typed literal', () => {
		// Re-typing the key at each call site is exactly how the gate drifted onto a
		// non-existent field. Consumers must import this constant.
		assert.strictEqual(VIBEIDE_PRIVACY_STRICT, 'vibeide.privacy.strict');
	});

	test('strict on + only cloud providers → completion is refused, not sent to the cloud', () => {
		const decision = decideFIMProvider({
			pinnedModelId: '',
			privacyStrict: true,
			providers: cloudOnly,
			chatDefaultProviderId: 'anthropic',
		});
		assert.strictEqual(decision.kind, 'no-provider-available');
	});

	test('strict on + local provider present → the local one serves it', () => {
		const decision = decideFIMProvider({
			pinnedModelId: '',
			privacyStrict: true,
			providers: withLocal,
			chatDefaultProviderId: 'anthropic',
		});
		assert.deepStrictEqual(
			{ kind: decision.kind, providerId: 'providerId' in decision ? decision.providerId : undefined },
			{ kind: 'local-coder', providerId: 'ollama' },
		);
	});

	test('the undefined value the old code produced reads as OFF — the bug in one line', () => {
		// `!!(settings as { privacyMode?: boolean }).privacyMode` on an object without the field.
		const legacyFlag = !!({} as { privacyMode?: boolean }).privacyMode;
		assert.strictEqual(legacyFlag, false);

		const asItBehaved = decideFIMProvider({
			pinnedModelId: '',
			privacyStrict: legacyFlag,
			providers: cloudOnly,
			chatDefaultProviderId: 'anthropic',
		});
		// Strict mode was on in settings, yet a cloud provider was chosen.
		assert.notStrictEqual(asItBehaved.kind, 'no-provider-available');
	});
});
