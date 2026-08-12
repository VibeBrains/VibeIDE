/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	admitRequest,
	isLoopbackHost,
	isRemoteLoopback,
	parseRunRequest,
	secretEquals,
} from '../../common/httpApi/vibeHttpApiTypes.js';

const TOKEN = 'a'.repeat(43);

function admit(over: Partial<Parameters<typeof admitRequest>[0]>) {
	return admitRequest({
		hostHeader: 'localhost:7391',
		authorization: `Bearer ${TOKEN}`,
		remoteAddress: '127.0.0.1',
		expectedToken: TOKEN,
		...over,
	});
}

suite('vibeHttpApi — admission', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a well-formed local request with the right token is admitted', () => {
		assert.deepStrictEqual(admit({}), { ok: true });
	});

	test('no token configured → refuses even a perfect request', () => {
		// The server should not be running at all in this state; the check is belt and braces.
		assert.deepStrictEqual(admit({ expectedToken: undefined }), {
			ok: false, status: 503, reason: 'HTTP API не настроен: нет токена',
		});
	});

	test('a non-loopback peer is refused before the token is even looked at', () => {
		// Order matters: an attacker on the network must not learn whether their token guess landed.
		assert.deepStrictEqual(admit({ remoteAddress: '192.168.1.14', authorization: 'Bearer wrong' }), {
			ok: false, status: 403, reason: 'Запросы принимаются только с этого компьютера',
		});
	});

	test('DNS rebinding: loopback peer but a foreign Host is refused', () => {
		// This is exactly what a malicious web page achieves — the socket really is local, the
		// browser really does attach the site's credentials, and only the Host header betrays it.
		assert.deepStrictEqual(admit({ hostHeader: 'evil.example.com' }), {
			ok: false, status: 403, reason: 'Недопустимый заголовок Host',
		});
	});

	test('missing, malformed and wrong tokens are all 401', () => {
		assert.deepStrictEqual(
			[undefined, 'Token ' + TOKEN, 'Bearer ', `Bearer ${'b'.repeat(43)}`, `Bearer ${TOKEN}x`]
				.map(authorization => admit({ authorization })),
			[
				{ ok: false, status: 401, reason: 'Требуется заголовок Authorization: Bearer <токен>' },
				{ ok: false, status: 401, reason: 'Требуется заголовок Authorization: Bearer <токен>' },
				{ ok: false, status: 401, reason: 'Неверный токен' },
				{ ok: false, status: 401, reason: 'Неверный токен' },
				{ ok: false, status: 401, reason: 'Неверный токен' },
			],
		);
	});

	test('the Bearer prefix is case-insensitive, the token is not', () => {
		assert.deepStrictEqual(
			[admit({ authorization: `bearer ${TOKEN}` }).ok, admit({ authorization: `BEARER ${TOKEN}` }).ok, admit({ authorization: `Bearer ${TOKEN.toUpperCase()}` }).ok],
			[true, true, false],
		);
	});
});

suite('vibeHttpApi — host and peer recognition', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('loopback host names are accepted with or without a port, foreign ones are not', () => {
		assert.deepStrictEqual(
			['localhost', 'localhost:7391', '127.0.0.1:80', '[::1]:7391', '::1', 'LOCALHOST:1',
				'evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', '', undefined]
				.map(h => isLoopbackHost(h as string)),
			[true, true, true, true, true, true, false, false, false, false, false],
		);
	});

	test('a dual-stack listener reports IPv4 clients as ::ffff:127.0.0.1 — that is still local', () => {
		assert.deepStrictEqual(
			['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53', '10.0.0.2', '192.168.0.1', undefined]
				.map(a => isRemoteLoopback(a as string)),
			[true, true, true, true, false, false, false],
		);
	});

	test('secretEquals answers correctly regardless of where the difference is', () => {
		assert.deepStrictEqual(
			[secretEquals('abc', 'abc'), secretEquals('abc', 'abd'), secretEquals('abc', 'zbc'), secretEquals('abc', 'ab'), secretEquals('', '')],
			[true, false, false, false, true],
		);
	});
});

suite('vibeHttpApi — request parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a valid body is parsed and the task is trimmed', () => {
		assert.deepStrictEqual(
			parseRunRequest('{"task":"  собери проект  ","sessionId":"t1","wait":true}'),
			{ ok: true, value: { task: 'собери проект', sessionId: 't1', wait: true } },
		);
	});

	test('optional fields stay absent rather than becoming undefined keys', () => {
		assert.deepStrictEqual(parseRunRequest('{"task":"go"}'), { ok: true, value: { task: 'go' } });
	});

	test('every malformed body is refused with a reason, never thrown', () => {
		assert.deepStrictEqual(
			['not json', '[]', '"str"', '{}', '{"task":""}', '{"task":"   "}', '{"task":5}',
				'{"task":"go","sessionId":""}', '{"task":"go","wait":"yes"}']
				.map(b => parseRunRequest(b)),
			[
				{ ok: false, reason: 'Тело запроса — не JSON' },
				{ ok: false, reason: 'Тело запроса — не объект' },
				{ ok: false, reason: 'Тело запроса — не объект' },
				{ ok: false, reason: 'Поле task обязательно и не может быть пустым' },
				{ ok: false, reason: 'Поле task обязательно и не может быть пустым' },
				{ ok: false, reason: 'Поле task обязательно и не может быть пустым' },
				{ ok: false, reason: 'Поле task обязательно и не может быть пустым' },
				{ ok: false, reason: 'Поле sessionId, если указано, — непустая строка' },
				{ ok: false, reason: 'Поле wait, если указано, — булево' },
			],
		);
	});
});
