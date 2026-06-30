/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeCrowdinWebhookPayload,
	formatCrowdinPrTitle,
	formatCrowdinPrBody,
	verifyCrowdinSignature,
	CrowdinTranslationsUpdatedPayload,
} from '../../common/crowdinWebhookPayload.js';

const valid = (overrides: Record<string, unknown> = {}): unknown => ({
	event: 'translation.updated',
	project: 'vibeide',
	targetLanguageId: 'ru',
	stringsCount: 5,
	...overrides,
});

const HEX64 = 'a'.repeat(64);

suite('Crowdin webhook payload decoder + PR composer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeCrowdinWebhookPayload', () => {
		test('happy path translation.updated', () => {
			const r = decodeCrowdinWebhookPayload(valid());
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.event, 'translation.updated');
				assert.strictEqual(r.value.targetLanguageId, 'ru');
				assert.strictEqual(r.value.stringsCount, 5);
			}
		});

		test('all 3 events accepted', () => {
			for (const event of ['translation.updated', 'file.translated', 'project.built']) {
				const r = decodeCrowdinWebhookPayload(valid({ event }));
				assert.strictEqual(r.ok, true, `event ${event}`);
			}
		});

		test('rejects unknown event', () => {
			const r = decodeCrowdinWebhookPayload(valid({ event: 'evil' }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects missing project', () => {
			const r = decodeCrowdinWebhookPayload(valid({ project: '' }));
			assert.strictEqual(r.ok, false);
		});

		test('locale fallback through targetLanguageId / languageId / locale', () => {
			const a = decodeCrowdinWebhookPayload({
				event: 'project.built',
				project: 'p',
				languageId: 'de',
				stringsCount: 3,
			});
			assert.strictEqual(a.ok, true);
			if (a.ok) { assert.strictEqual(a.value.targetLanguageId, 'de'); }

			const b = decodeCrowdinWebhookPayload({
				event: 'project.built',
				project: 'p',
				locale: 'fr',
				stringsCount: 3,
			});
			assert.strictEqual(b.ok, true);
			if (b.ok) { assert.strictEqual(b.value.targetLanguageId, 'fr'); }
		});

		test('locale lowercased', () => {
			const r = decodeCrowdinWebhookPayload(valid({ targetLanguageId: 'RU-BY' }));
			if (r.ok) { assert.strictEqual(r.value.targetLanguageId, 'ru-by'); }
		});

		test('rejects malformed locale', () => {
			const r = decodeCrowdinWebhookPayload(valid({ targetLanguageId: 'not_a_locale!' }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects negative stringsCount', () => {
			const r = decodeCrowdinWebhookPayload(valid({ stringsCount: -1 }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects non-integer stringsCount', () => {
			const r = decodeCrowdinWebhookPayload(valid({ stringsCount: 5.5 }));
			assert.strictEqual(r.ok, false);
		});

		test('count fallback through stringsCount / wordsCount / translatedCount', () => {
			const r = decodeCrowdinWebhookPayload({
				event: 'translation.updated',
				project: 'p',
				targetLanguageId: 'ru',
				translatedCount: 10,
			});
			if (r.ok) { assert.strictEqual(r.value.stringsCount, 10); }
		});

		test('buildId optional', () => {
			const r = decodeCrowdinWebhookPayload(valid({ buildId: 'b-42' }));
			if (r.ok) { assert.strictEqual(r.value.buildId, 'b-42'); }
		});

		test('url optional', () => {
			const r = decodeCrowdinWebhookPayload(valid({ url: 'https://crowdin.com/x' }));
			if (r.ok) { assert.strictEqual(r.value.url, 'https://crowdin.com/x'); }
		});

		test('rejects null root', () => {
			assert.strictEqual(decodeCrowdinWebhookPayload(null).ok, false);
		});
	});

	const baseValid: CrowdinTranslationsUpdatedPayload = {
		event: 'translation.updated',
		project: 'vibeide',
		targetLanguageId: 'ru',
		stringsCount: 5,
	};

	suite('formatCrowdinPrTitle', () => {
		test('plural format', () => {
			const t = formatCrowdinPrTitle(baseValid);
			assert.strictEqual(t, 'i18n: sync ru translations from Crowdin (5 strings)');
		});

		test('singular noun for 1', () => {
			const t = formatCrowdinPrTitle({ ...baseValid, stringsCount: 1 });
			assert.ok(t.includes('(1 string)'));
		});

		test('zero handled', () => {
			const t = formatCrowdinPrTitle({ ...baseValid, stringsCount: 0 });
			assert.ok(t.includes('(0 strings)'));
		});

		test('locale embedded verbatim', () => {
			const t = formatCrowdinPrTitle({ ...baseValid, targetLanguageId: 'ru-by' });
			assert.ok(t.includes('sync ru-by'));
		});
	});

	suite('formatCrowdinPrBody', () => {
		test('renders all required fields', () => {
			const md = formatCrowdinPrBody(baseValid);
			assert.ok(md.includes('## Crowdin sync'));
			assert.ok(md.includes('vibeide'));
			assert.ok(md.includes('ru'));
			assert.ok(md.includes('**5**'));
		});

		test('omits buildId / url when absent', () => {
			const md = formatCrowdinPrBody(baseValid);
			assert.ok(!md.includes('Build id'));
			assert.ok(!md.includes('Crowdin: '));
		});

		test('includes buildId / url when present', () => {
			const md = formatCrowdinPrBody({
				...baseValid,
				buildId: 'b-1',
				url: 'https://crowdin.com/x',
			});
			assert.ok(md.includes('Build id'));
			assert.ok(md.includes('https://crowdin.com/x'));
		});

		test('agent footer present', () => {
			const md = formatCrowdinPrBody(baseValid);
			assert.ok(md.includes('Auto-generated'));
		});
	});

	suite('verifyCrowdinSignature', () => {
		test('happy path matching hex', () => {
			const r = verifyCrowdinSignature(HEX64, HEX64);
			assert.strictEqual(r.ok, true);
		});

		test('strips sha256= prefix', () => {
			const r = verifyCrowdinSignature(`sha256=${HEX64}`, HEX64);
			assert.strictEqual(r.ok, true);
		});

		test('case-insensitive', () => {
			const r = verifyCrowdinSignature(HEX64.toUpperCase(), HEX64);
			assert.strictEqual(r.ok, true);
		});

		test('mismatch detected', () => {
			const r = verifyCrowdinSignature(HEX64, 'b'.repeat(64));
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'mismatch'); }
		});

		test('missing → missing-signature', () => {
			const r = verifyCrowdinSignature(undefined, HEX64);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'missing-signature'); }
		});

		test('malformed (non-hex) → malformed-signature', () => {
			const r = verifyCrowdinSignature('not-hex', HEX64);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'malformed-signature'); }
		});

		test('malformed (wrong length) → malformed-signature', () => {
			const r = verifyCrowdinSignature('a'.repeat(63), HEX64);
			assert.strictEqual(r.ok, false);
		});
	});
});
