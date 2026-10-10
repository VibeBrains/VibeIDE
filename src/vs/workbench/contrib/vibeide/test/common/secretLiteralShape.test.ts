/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPlaceholderValue, looksLikeSecretLiteral } from '../../common/secretLiteralShape.js';

suite('Secret literal shape', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('заглушки: интерполяция, шаблон, формат, маска, след редактирования', () => {
		const standIns = [
			'${TOKEN}', '$TOKEN', '$(cat', '$deviceToken', '{{ token }}', '{{token}}', '<%= token %>', '#{token}', '{token}',
			'<your-token>', '[REDACTED]', '[[REDACTED:Password]]', '%s', '%(token)s', '%1$s', '%TOKEN%',
			'********', 'xxxxxxxx', 'XXXX-XXXX', '........', '00000000',
		];
		// Real values that merely start like a stand-in
		const real = ['$ecretPass1', '{real}secret1', 'xxxxxxx1'];
		assert.deepStrictEqual(
			{ заглушки: standIns.filter(isPlaceholderValue), настоящие: real.filter(isPlaceholderValue) },
			{ заглушки: standIns, настоящие: [] },
		);
	});

	test('без кавычек: секрет только с цифрой или символом и без признаков кода', () => {
		const bare = {
			секреты: ['S3cr3tPass!', 'hunter2hunter', 'Zx8_kQ#mP4vLw', 'abcdefgh==', 'hunter2hunter);'],
			имена: ['deviceToken', 'DeviceToken?', 'DEVICE_TOKEN', 'device_token', 'String', 'null', 'undefined', 'Correcthorse'],
			// S3cr3t.Pass99! reads as a member access: the one accepted miss of the code shapes
			код: ['getToken()', 'fetchV2Token(1)', 'process.env.TOKEN', 'config.secret2', 'this.token!', 'tokens[0]', 'Map<Int64,', 'deviceToken!!', 'S3cr3t.Pass99!'],
			путиИМаски: ['/run/secrets/name', './secrets/name', '~/.secrets/name', '!0,range:!0', '$ENV_NAME', '${NAME}'],
		};
		assert.deepStrictEqual(
			Object.fromEntries(Object.entries(bare).map(([kind, values]) => [kind, values.filter(v => looksLikeSecretLiteral(v, ''))])),
			{ секреты: ['S3cr3tPass!', 'hunter2hunter', 'Zx8_kQ#mP4vLw', 'abcdefgh==', 'hunter2hunter);'], имена: [], код: [], путиИМаски: [] },
		);
	});

	test('в кавычках: литерал, если не заглушка и не шаблонная строка с подстановкой', () => {
		assert.deepStrictEqual({
			слово: looksLikeSecretLiteral('correcthorsebattery', '"'),
			цифра: looksLikeSecretLiteral('hunter2hunter', "'"),
			заглушка: looksLikeSecretLiteral('${TOKEN}', '"'),
			маска: looksLikeSecretLiteral('********', '"'),
			шаблонСПодстановкой: looksLikeSecretLiteral('p${++seq}-aaaaaaaa', '`'),
			шаблонБезПодстановки: looksLikeSecretLiteral('abcdefgh1234', '`'),
		}, { слово: true, цифра: true, заглушка: false, маска: false, шаблонСПодстановкой: false, шаблонБезПодстановки: true });
	});
});
