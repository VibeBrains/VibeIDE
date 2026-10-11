/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPlaceholderValue, looksLikeSecretLiteral, standsAloneAsToken } from '../../common/secretLiteralShape.js';

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

	test('ряд знаков: один стоит сам, другой вырезан из длинного ряда или из данных', () => {
		const run = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYab';
		const texts = {
			// Quotes, blanks, brackets, `=` and `:` in front, a comma or a full stop behind
			один: [run, `"${run}"`, `secret = ${run}`, `secret=${run}`, `key: ${run}`, `(${run}),`, `x ${run}.`, `[1,${run}]`, `a\n${run}\nb`],
			// A word, a digit, `+`, `/`, `_` or `-` on either side, or `=` behind
			// The run goes on, or it is a name with its value
			изДлинногоРяда: [`a${run}`, `${run}a`, `/${run}/`, `x+${run}`, `${run}+x`, `x_${run}`, `${run}_x`, `sha512-${run}`, `${run}-1`, `${run}=`, `${run}=1`],
			// A payload that starts right after the head of a data URI or a `base64,` section
			изДанных: [`data:image/png;base64,${run}`, `url(data:image/svg+xml;charset=utf-8;base64,${run})`, `;base64,${run}"`, `data:text/plain,${run}`],
		};
		assert.deepStrictEqual(
			Object.fromEntries(Object.entries(texts).map(([kind, list]) => [kind, list.filter(t => standsAloneAsToken(t, t.indexOf(run), t.indexOf(run) + run.length))])),
			{ один: texts.один, изДлинногоРяда: [], изДанных: [] },
		);
	});

	test('ряд знаков: край текста не ломает суждение', () => {
		assert.deepStrictEqual(
			{
				началоИКонец: standsAloneAsToken('0123456789', 0, 10),
				пустойТекст: standsAloneAsToken('', 0, 0),
				// A head farther than the look-behind from the run is not seen, and a comma alone is not a head
				далёкаяГолова: standsAloneAsToken('data:image/png;base64,' + 'x'.repeat(200) + ',0123456789', 223, 233),
				запятаяБезГоловы: standsAloneAsToken('a,0123456789', 2, 12),
			},
			{ началоИКонец: true, пустойТекст: true, далёкаяГолова: true, запятаяБезГоловы: true },
		);
	});
});
