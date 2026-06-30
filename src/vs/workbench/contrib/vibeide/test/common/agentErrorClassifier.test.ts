/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	classifyAgentError,
	buildToast,
	classifyAndBuildToast,
} from '../../common/agentErrorClassifier.js';

suite('Agent error classifier (294)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('classifyAgentError', () => {
		test('user source → cancelled', () => {
			assert.strictEqual(classifyAgentError({ source: 'user' }), 'cancelled');
		});

		test('ipc source → ipc-error', () => {
			assert.strictEqual(classifyAgentError({ source: 'ipc' }), 'ipc-error');
		});

		test('tool source → tool-failure', () => {
			assert.strictEqual(classifyAgentError({ source: 'tool' }), 'tool-failure');
		});

		test('stream source → stream-broken', () => {
			assert.strictEqual(classifyAgentError({ source: 'stream' }), 'stream-broken');
		});

		test('provider 4xx → provider-4xx (quota statuses excluded)', () => {
			assert.strictEqual(classifyAgentError({ source: 'provider', httpStatus: 401 }), 'provider-4xx');
			// 402/429 are quota/rate-limit — their own class since the openCodeGo Go incident.
			assert.strictEqual(classifyAgentError({ source: 'provider', httpStatus: 429 }), 'provider-quota');
			assert.strictEqual(classifyAgentError({ source: 'provider', httpStatus: 402 }), 'provider-quota');
		});

		test('provider 5xx → provider-5xx', () => {
			assert.strictEqual(classifyAgentError({ source: 'provider', httpStatus: 502 }), 'provider-5xx');
			assert.strictEqual(classifyAgentError({ source: 'provider', httpStatus: 503 }), 'provider-5xx');
		});

		test('errorCode ETIMEDOUT → timeout', () => {
			assert.strictEqual(classifyAgentError({ source: 'provider', errorCode: 'ETIMEDOUT' }), 'timeout');
		});

		test('errorCode ECONNABORTED → timeout', () => {
			assert.strictEqual(classifyAgentError({ source: 'provider', errorCode: 'ECONNABORTED' }), 'timeout');
		});

		test('error message containing "timed out" → timeout', () => {
			assert.strictEqual(classifyAgentError({ source: 'unknown', errorMessage: 'Request timed out' }), 'timeout');
		});

		test('"aborted by user" message → cancelled', () => {
			assert.strictEqual(classifyAgentError({ source: 'unknown', errorMessage: 'aborted by user' }), 'cancelled');
		});

		test('fallback → unknown', () => {
			assert.strictEqual(classifyAgentError({ source: 'unknown' }), 'unknown');
			assert.strictEqual(classifyAgentError({ source: 'provider' }), 'unknown');
		});
	});

	suite('buildToast', () => {
		test('provider-4xx → error severity, has switch-model action', () => {
			const toast = buildToast('provider-4xx', { source: 'provider', httpStatus: 400 });
			assert.strictEqual(toast.severity, 'error');
			assert.ok(toast.actions.includes('switch-model'));
		});

		test('provider-5xx → retry first action', () => {
			const toast = buildToast('provider-5xx', { source: 'provider', httpStatus: 502 });
			assert.strictEqual(toast.actions[0], 'retry');
		});

		test('cancelled → info severity, dismiss only', () => {
			const toast = buildToast('cancelled', { source: 'user' });
			assert.strictEqual(toast.severity, 'info');
			assert.deepStrictEqual(toast.actions, ['dismiss']);
		});

		test('ipc-error → no retry (reload required)', () => {
			const toast = buildToast('ipc-error', { source: 'ipc' });
			assert.ok(!toast.actions.includes('retry'));
		});

		test('requestId is appended to body when provided', () => {
			const toast = buildToast('provider-5xx', { source: 'provider', httpStatus: 502, requestId: 'req-abc' });
			assert.match(toast.body, /req-abc/);
		});

		test('alreadyInChat propagated as duplicateOfChat', () => {
			const toast = buildToast('provider-5xx', { source: 'provider', httpStatus: 502, alreadyInChat: true });
			assert.strictEqual(toast.duplicateOfChat, true);
		});

		test('unknown class falls back to error severity + open-log', () => {
			const toast = buildToast('unknown', { source: 'unknown' });
			assert.strictEqual(toast.severity, 'error');
			assert.ok(toast.actions.includes('open-log'));
		});
	});

	suite('classifyAndBuildToast', () => {
		test('end-to-end provider 502', () => {
			const r = classifyAndBuildToast({ source: 'provider', httpStatus: 502, requestId: 'r1' });
			assert.strictEqual(r.cls, 'provider-5xx');
			assert.match(r.toast.body, /r1/);
		});

		test('end-to-end timeout via errorCode', () => {
			const r = classifyAndBuildToast({ source: 'provider', errorCode: 'ETIMEDOUT' });
			assert.strictEqual(r.cls, 'timeout');
			assert.match(r.toast.headline, /таймаут/i);
		});

		test('402 quota → provider-quota class with provider message in body', () => {
			const r = classifyAndBuildToast({ source: 'provider', httpStatus: 402, errorMessage: 'Monthly usage limit reached. Resets in 5 days.' });
			assert.strictEqual(r.cls, 'provider-quota');
			assert.match(r.toast.headline, /Лимит провайдера/);
			assert.match(r.toast.body, /Monthly usage limit reached/);
			assert.ok(r.toast.actions.includes('switch-model'));
		});

		test('429 → provider-quota, not provider-4xx', () => {
			const r = classifyAndBuildToast({ source: 'provider', httpStatus: 429 });
			assert.strictEqual(r.cls, 'provider-quota');
		});

		test('plain 400 keeps provider-4xx and shows provider message', () => {
			const r = classifyAndBuildToast({ source: 'provider', httpStatus: 400, errorMessage: 'unknown field temperature_x' });
			assert.strictEqual(r.cls, 'provider-4xx');
			assert.match(r.toast.body, /unknown field temperature_x/);
		});
	});
});
