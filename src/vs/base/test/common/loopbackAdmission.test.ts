/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';
import { isLoopbackHost, isRemoteLoopback, secretEquals } from '../../common/loopbackAdmission.js';

suite('loopbackAdmission', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('loopback host names pass with or without a port; foreign ones do not', () => {
		assert.deepStrictEqual(
			['localhost', 'localhost:7391', '127.0.0.1:80', '[::1]:7391', '::1', 'LOCALHOST:1',
				'evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', '', undefined]
				.map(h => isLoopbackHost(h as string)),
			[true, true, true, true, true, true, false, false, false, false, false],
		);
	});

	test('a rebinding page is caught by the Host header alone', () => {
		// The socket really is local in this scenario — the header is the only evidence that the
		// request was addressed to somebody else's domain.
		assert.strictEqual(isRemoteLoopback('127.0.0.1'), true);
		assert.strictEqual(isLoopbackHost('attacker.example.com'), false);
	});

	test('a dual-stack listener reports IPv4 clients as ::ffff:127.0.0.1 — still local', () => {
		assert.deepStrictEqual(
			['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53', '10.0.0.2', '192.168.0.1', undefined]
				.map(a => isRemoteLoopback(a as string)),
			[true, true, true, true, false, false, false],
		);
	});

	test('secretEquals answers correctly wherever the difference sits', () => {
		assert.deepStrictEqual(
			[secretEquals('abc', 'abc'), secretEquals('abc', 'abd'), secretEquals('abc', 'zbc'), secretEquals('abc', 'ab'), secretEquals('', '')],
			[true, false, false, false, true],
		);
	});
});
