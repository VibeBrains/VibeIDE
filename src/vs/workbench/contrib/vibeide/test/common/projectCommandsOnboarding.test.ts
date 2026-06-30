/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideOnboardingHint,
	markOnboardingHintShown,
	freshOnboardingHintState,
	decodeOnboardingHintState,
	OnboardingHintInput,
} from '../../common/projectCommandsOnboarding.js';

function input(overrides: Partial<OnboardingHintInput> = {}): OnboardingHintInput {
	return {
		state: freshOnboardingHintState(),
		hadSuccessfulRun: true,
		hasPinnedCommand: false,
		userHasInteractedWithPin: false,
		...overrides,
	};
}

suite('Project Commands — first-success onboarding hint', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideOnboardingHint', () => {
		test('happy path → show', () => {
			assert.deepStrictEqual(decideOnboardingHint(input()), { kind: 'show' });
		});

		test('already shown → skip:already-shown', () => {
			const r = decideOnboardingHint(input({ state: { hintShown: true } }));
			assert.strictEqual(r.kind, 'skip');
			if (r.kind === 'skip') { assert.strictEqual(r.reason, 'already-shown'); }
		});

		test('no successful run yet → skip:no-success-yet', () => {
			const r = decideOnboardingHint(input({ hadSuccessfulRun: false }));
			assert.strictEqual(r.kind, 'skip');
			if (r.kind === 'skip') { assert.strictEqual(r.reason, 'no-success-yet'); }
		});

		test('already has pinned command → skip:already-pinned', () => {
			const r = decideOnboardingHint(input({ hasPinnedCommand: true }));
			assert.strictEqual(r.kind, 'skip');
			if (r.kind === 'skip') { assert.strictEqual(r.reason, 'already-pinned'); }
		});

		test('user interacted with pin → skip:user-interacted', () => {
			const r = decideOnboardingHint(input({ userHasInteractedWithPin: true }));
			assert.strictEqual(r.kind, 'skip');
			if (r.kind === 'skip') { assert.strictEqual(r.reason, 'user-interacted'); }
		});

		test('order: already-shown wins over no-success-yet', () => {
			const r = decideOnboardingHint(input({
				state: { hintShown: true },
				hadSuccessfulRun: false,
			}));
			assert.strictEqual(r.kind, 'skip');
			if (r.kind === 'skip') { assert.strictEqual(r.reason, 'already-shown'); }
		});

		test('order: no-success-yet wins over already-pinned', () => {
			const r = decideOnboardingHint(input({
				hadSuccessfulRun: false,
				hasPinnedCommand: true,
			}));
			assert.strictEqual(r.kind, 'skip');
			if (r.kind === 'skip') { assert.strictEqual(r.reason, 'no-success-yet'); }
		});

		test('order: already-pinned wins over user-interacted', () => {
			const r = decideOnboardingHint(input({
				hasPinnedCommand: true,
				userHasInteractedWithPin: true,
			}));
			assert.strictEqual(r.kind, 'skip');
			if (r.kind === 'skip') { assert.strictEqual(r.reason, 'already-pinned'); }
		});
	});

	suite('markOnboardingHintShown / freshOnboardingHintState', () => {
		test('fresh state → hintShown=false', () => {
			assert.deepStrictEqual(freshOnboardingHintState(), { hintShown: false });
		});

		test('mark sets hintShown=true', () => {
			const next = markOnboardingHintShown(freshOnboardingHintState());
			assert.strictEqual(next.hintShown, true);
		});

		test('mark is non-mutating', () => {
			const orig = freshOnboardingHintState();
			markOnboardingHintShown(orig);
			assert.strictEqual(orig.hintShown, false);
		});

		test('mark is idempotent', () => {
			const first = markOnboardingHintShown(freshOnboardingHintState());
			const second = markOnboardingHintShown(first);
			assert.deepStrictEqual(first, second);
		});
	});

	suite('decodeOnboardingHintState', () => {
		test('valid → trusts hintShown', () => {
			assert.deepStrictEqual(decodeOnboardingHintState({ hintShown: true }), { hintShown: true });
			assert.deepStrictEqual(decodeOnboardingHintState({ hintShown: false }), { hintShown: false });
		});

		test('null / undefined / non-object → fresh state', () => {
			assert.deepStrictEqual(decodeOnboardingHintState(null), { hintShown: false });
			assert.deepStrictEqual(decodeOnboardingHintState(undefined), { hintShown: false });
			assert.deepStrictEqual(decodeOnboardingHintState('garbage'), { hintShown: false });
			assert.deepStrictEqual(decodeOnboardingHintState(42), { hintShown: false });
		});

		test('truthy non-boolean is rejected (not coerced)', () => {
			assert.deepStrictEqual(decodeOnboardingHintState({ hintShown: 'yes' }), { hintShown: false });
			assert.deepStrictEqual(decodeOnboardingHintState({ hintShown: 1 }), { hintShown: false });
		});
	});
});
