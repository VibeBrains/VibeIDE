/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { detectSecrets, getActivePatterns, redactSecretsInObject, SecretDetectionConfig, DEFAULT_SECRET_PATTERNS } from '../../common/secretDetection.js';
import { SECRET_CANARIES, findSecretCanaries } from './securityTestFixtures.js';

suite('Secret Detection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Жалоба пользователя 20.09.2026: `build.gradle` признан секретом (Generic Token), защитный
	 * предохранитель залип и заблокировал все запросы. Правило числилось выключенным в коде и всё равно работало.
	 */
	suite('выключенное в коде правило не работает без решения человека', () => {
		const config = (over: Partial<SecretDetectionConfig> = {}): SecretDetectionConfig => ({
			enabled: true, customPatterns: [], disabledPatternIds: [], mode: 'redact', ...over,
		});
		// Обычная строка из сборочного файла: контрольная сумма зависимости, а не секрет.
		const gradle = "implementation 'com.example:lib:1.2.3' // sha1 = 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12";

		test('generic-token молчит по умолчанию и говорит, когда его включили', () => {
			assert.deepStrictEqual({
				поУмолчанию: detectSecrets(gradle, config()).matches.map(m => m.pattern.id),
				включёнВручную: detectSecrets(gradle, config({ enabledPatternIds: ['generic-token'] })).matches.map(m => m.pattern.id),
				// Выключение сильнее включения: явный запрет не должен обходиться списком разрешённых.
				запретСильнее: detectSecrets(gradle, config({ enabledPatternIds: ['generic-token'], disabledPatternIds: ['generic-token'] })).matches.length,
			}, {
				поУмолчанию: [],
				включёнВручную: ['generic-token'],
				запретСильнее: 0,
			});
		});

		test('включённое правило судит и адреса — исключения для URL нет', () => {
			// Исключение здесь было (20.09.2026) и убрано в тот же день: «хеш в адресе — контрольная
			// сумма» верно до первого `?token=<32 знака>`, а молча пропущенный секрет дороже лишнего
			// вопроса. Ложное срабатывание снимается человеком и называет идентификатор правила.
			const on = config({ enabledPatternIds: ['generic-token'] });
			assert.deepStrictEqual({
				вURL: detectSecrets('distributionUrl=https://cdn.example.com/2fd4e1c67a2d28fced849ee1bb76e7391b93eb12/gradle.zip', on).matches.length,
				секретВURL: detectSecrets('https://api.example.com/download?token=9b74c9897bac770ffc029102a200c5de', on).matches.length,
				безURL: detectSecrets('apiToken = 9b74c9897bac770ffc029102a200c5de', on).matches.length,
				// Выключенное по умолчанию правило по-прежнему молчит: вернулось исключение, а не правило.
				поУмолчанию: detectSecrets('distributionUrl=https://cdn.example.com/2fd4e1c67a2d28fced849ee1bb76e7391b93eb12/gradle.zip', config()).matches.length,
			}, { вURL: 1, секретВURL: 1, безURL: 1, поУмолчанию: 0 });
		});

		test('правила, включённые в коде, остались на месте', () => {
			// Порядок здесь не при чём: `getActivePatterns` сортирует по приоритету. Проверяется состав.
			const active = new Set(getActivePatterns(config()).map(p => p.id));
			const shippedOn = DEFAULT_SECRET_PATTERNS.filter(p => p.enabled !== false).map(p => p.id);
			assert.deepStrictEqual({
				всеВключённыеНаМесте: shippedOn.every(id => active.has(id)),
				выключенногоНет: active.has('generic-token'),
				число: active.size,
			}, {
				всеВключённыеНаМесте: true,
				выключенногоНет: false,
				число: shippedOn.length,
			});
		});
	});

	/**
	 * An assignment rule has to tell a hard-coded string from code that merely names a credential
	 * A false hit is not harmless: the text is replaced before the model sees it, and the leak check latches a breaker
	 * Each list below is asserted whole, so a failure prints the texts that were judged wrong
	 */
	suite('правила присваивания: литерал или код', () => {
		const flagged = (texts: string[]) => texts.filter(t => detectSecrets(t).hasSecrets);
		const missed = (texts: string[]) => texts.filter(t => !detectSecrets(t).hasSecrets);

		test('Kotlin-строки из жалобы не считаются паролем и уходят в модель как есть', () => {
			const kotlin = 'private var token: DeviceToken? = null\ntoken = deviceToken';
			const result = detectSecrets(kotlin);
			assert.deepStrictEqual(
				{ совпадения: result.matches.length, текст: result.redactedText },
				{ совпадения: 0, текст: kotlin },
			);
		});

		test('код после ключевого слова — не секрет', () => {
			assert.deepStrictEqual(flagged([
				'token = getToken()',
				'token = readSecret(0);',
				'token = process.env.TOKEN',
				'token = process.env.TOKEN_V2',
				'token = config.secret2',
				'token = this.token!',
				'token = this->token2',
				'token = Config::TOKEN_V2',
				'token = tokens[0]',
				'token = deviceToken',
				'token = deviceToken!!',
				'token = device_token',
				'token = DEVICE_TOKEN',
				'token: DeviceToken?',
				'token: String',
				'token: Map<String, String> = emptyMap()',
				'token: Map<Int64, String> = emptyMap()',
				'token = null',
				'token = undefined',
				'token: /[\\p{L}\\p{N}]+/gu',
				'password = /run/secrets/db_password',
				'password:!0,range:!0',
				'apiKey: ApiKeyAuthProviderFactory',
				'apiKey = environmentVariableApiKey',
				'if (token == otherTokenValue1)',
				'token:\n  description: first',
				'#token=\nSOME_OTHER_VARIABLE=1',
			]), []);
		});

		test('заглушки и интерполяции — не секрет, даже в кавычках', () => {
			assert.deepStrictEqual(flagged([
				'password = "${TOKEN}"',
				'password = "$TOKEN"',
				'password = "{{ token }}"',
				'password = "{{token}}"',
				'password = "<your-token>"',
				'password = "%s"',
				'password = "%(token)s"',
				'password = "..."',
				'password = "********"',
				'password = "xxxxxxxx"',
				'password = "XXXX-XXXX-XXXX"',
				'password = "[[REDACTED:Password]]"',
				'token = `${secretFromVault}`',
				'DB_PASSWORD=${DB_PASSWORD_FILE}',
				'DB_PASSWORD=$DB_PASSWORD_VALUE',
				'TOKEN=$(cat_token_file)',
				'"${secret:DEPLOY_TOKEN}"',
				'apiKey = "xxxxxxxxxxxxxxxxxxxxxxxx"',
				'Authorization: Bearer xxxxxxxxxxxxxxxxxxxx',
			]), []);
		});

		test('шаблонная строка с подстановкой — выражение, а не литерал', () => {
			assert.deepStrictEqual(flagged([
				'const token = `p${++seq}-aaaaaaaaaa`;',
			]), []);
		});

		test('литерал в кавычках — секрет', () => {
			assert.deepStrictEqual(missed([
				'password = "hunter2hunter"',
				"token: 'abc12345xyz'",
				'password = "correcthorsebattery"',
				'token = `abcdefgh1234`',
				'SECRET = b"test-signing-secret"',
				"secret = 'tok\"en-with-quote'",
				'password =\n    "hunter2hunter"',
				'apiKey = "k3Jx9Qm2Lp8Zr4Tv6Yw1Ab"',
			]), []);
		});

		test('значение без кавычек — секрет только с цифрой или символом и без признаков кода', () => {
			assert.deepStrictEqual(missed([
				'password: S3cr3tPass!',
				'password=mySecretPassword123!',
				'password: Welcome2024',
				'token = Zx8_kQ#mP4vLw',
				'api_key=k3Jx9Qm2Lp8Zr4Tv6Yw1Ab',
				'connect(password=hunter2hunter);',
				// The outer match is code and rejected, the secret nested in it is still found
				'token=login(password=hunter2hunter)',
			]), []);
		});

		test('строка окружения: секрет с любым значением от восьми знаков, кроме заглушки', () => {
			assert.deepStrictEqual({
				пропущено: missed([
					'PASSWORD=correcthorsebattery',
					'export DB_PASSWORD=correcthorse',
					'  CLIENT_SECRET=correcthorse',
					'API_TOKEN=abcdefghij',
					'DB_PASSWORD="correcthorse"',
				]),
				// The match starts at the variable name, so `export` and the indent stay in the text
				замена: detectSecrets('export DB_PASSWORD=correcthorse\nPORT=8080').redactedText,
				// A lower-case name or a name that only starts with the keyword was not matched before either
				чужиеИмена: flagged(['my_password=Secret123xx', 'dbPassword=Secret123xx', 'TOKEN_LIMIT=10000000', 'FOO=correcthorse']),
			}, {
				пропущено: [],
				замена: 'export [[REDACTED:Password]]\nPORT=8080',
				чужиеИмена: [],
			});
		});

		test('предложение в кавычках — не значение', () => {
			assert.deepStrictEqual(flagged([
				'password: "Password is required"',
				"token: 'Invalid token provided'",
			]), []);
		});

		test('разбор длинных строк без переводов не растёт квадратично', () => {
			const started = Date.now();
			detectSecrets(' '.repeat(200_000) + 'x');
			detectSecrets('TOKEN_'.repeat(100_000) + '=');
			detectSecrets('token=login(a=b)'.repeat(60_000));
			assert.ok(Date.now() - started < 2_000);
		});
	});

	/**
	 * The bare 40-character rule has no keyword in front of the run, so the characters around it decide
	 * A lock file holds an `integrity` line per package, and each carries 40-character slices of a base64 hash
	 * One hit latches the `secret-leak` breaker
	 */
	suite('aws-secret-key: ключ стоит один или это кусок данных', () => {
		// 40 characters of a key's shape; the data below are built around them
		const KEY = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYab';
		const HEX = '3f9a0c7e1b2d4856a9c0e1f23b4d5c6e';
		const awsHits = (text: string) => detectSecrets(text).matches.filter(m => m.pattern.id === 'aws-secret-key').length;
		const flagged = (texts: string[]) => texts.filter(t => awsHits(t) > 0);
		const missed = (texts: string[]) => texts.filter(t => awsHits(t) === 0);

		test('хеш integrity в lock-файле — не ключ', () => {
			assert.deepStrictEqual(flagged([
				`      "integrity": "sha512-Zm9vYmFy/${KEY}/YmFyYmF6+Zm9vYmFyQm9vYmFy/Zm9vYmFyYmF6YmFyYmF6Zm9v==",`,
				`      resolution: {integrity: sha512-Zm9vYmFy/${KEY}/YmFyYmF6==}`,
				`<script src="app.js" integrity="sha384-${KEY}=" crossorigin="anonymous"></script>`,
				`"integrity": "sha256-${KEY}="`,
			]), []);
		});

		test('сорок знаков из длинного ряда base64 или идентификатора — не ключ', () => {
			assert.deepStrictEqual(flagged([
				`Zm9vYmFy/${KEY}+Zm9vYmFy`,
				`Zm9vYmFy+${KEY}/Zm9vYmFy`,
				`prefix-${KEY}-suffix`,
				`prefix_${KEY}_suffix`,
				`/node_modules/${KEY}/index.js`,
				`${KEY}==`,
			]), []);
		});

		test('адрес данных data: и участок после base64, — не ключ', () => {
			assert.deepStrictEqual(flagged([
				`<img src="data:image/png;base64,${KEY}">`,
				`background: url(data:image/svg+xml;charset=utf-8;base64,${KEY})`,
				`const payload = "base64,${KEY}";`,
				`data:text/plain,${KEY}`,
			]), []);
		});

		test('пара имя=значение, вырезанная из адреса или снимка страницы, — не ключ', () => {
			// `userKey=` and 32 hex characters are 40 characters of one run: a name with its value, never a key
			assert.deepStrictEqual(flagged([
				`{"url":"https://example.com/items?x=1&userKey=${HEX}&sort=date"}`,
				`userKey=${HEX}`,
			]), []);
		});

		test('ключ, который стоит один, находится', () => {
			assert.deepStrictEqual(missed([
				`"${KEY}"`,
				`'${KEY}'`,
				`secret = ${KEY}`,
				`secret=${KEY}`,
				`secret: ${KEY}`,
				`{"secretKey": "${KEY}", "region": "eu-west-1"}`,
				`aws_secret_key = "${KEY}"`,
				`https://example.com/sign?secret=${KEY}&expires=60`,
				`before\n${KEY}\nafter`,
				`${KEY}`,
				`(${KEY}), next`,
				`values: [1,${KEY}]`,
				`The key is ${KEY}.`,
			]), []);
		});

		test('найденный ключ уходит в заглушку целиком, соседние слова остаются', () => {
			assert.deepStrictEqual(
				detectSecrets(`secret = ${KEY}\nregion = eu-west-1`).redactedText,
				'secret = [[REDACTED:AWS Secret Key]]\nregion = eu-west-1',
			);
		});

		test('ключ с именем переменной ловится отдельным правилом, и оно не тронуто', () => {
			// A real key holds `/` and `+` and may end with `=`: the named rule allows them, the bare rule cannot
			const withSlashes = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
			const padded = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYa=';
			assert.deepStrictEqual(
				[
					`AWS_SECRET_ACCESS_KEY=${withSlashes}`,
					`aws_secret_access_key = "${padded}"`,
					`export AWS_SECRET_ACCESS_KEY=${KEY}`,
				].map(t => detectSecrets(t).matches.map(m => m.pattern.id)),
				[['aws-secret-key-named'], ['aws-secret-key-named'], ['aws-secret-key-named']],
			);
		});

		test('разбор крупного снимка с длинными рядами не растёт квадратично', () => {
			const started = Date.now();
			// The first text sends every candidate to the data-URI scan, the second to the neighbour check
			detectSecrets(('<img src="data:image/png;base64,' + KEY + '">').repeat(10_000));
			detectSecrets(('Zm9vYmFy/' + KEY + '+').repeat(20_000));
			assert.ok(Date.now() - started < 2_000);
		});
	});

	suite('detectSecrets', () => {
		test('should detect OpenAI API keys', () => {
			const text = 'My API key is sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.strictEqual(result.matches.length, 1);
			assert.strictEqual(result.matches[0].pattern.name, 'OpenAI API Key');
			assert.ok(result.redactedText.includes('[[REDACTED:OpenAI API Key]]'));
		});

		test('should detect Anthropic API keys', () => {
			const text = 'sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567abc890def123ghi456jkl789mno012pqr345stu678vwx901yz234';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'Anthropic API Key'));
		});

		test('should detect JWT tokens', () => {
			const text = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'JWT Token'));
		});

		test('should detect GitHub tokens', () => {
			const text = SECRET_CANARIES.githubPat;
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'GitHub Token'));
			// after redaction no canary must survive
			assert.strictEqual(findSecretCanaries(result.redactedText).length, 0);
		});

		test('should detect AWS access keys', () => {
			const text = 'AKIAIOSFODNN7EXAMPLE';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'AWS Access Key'));
		});

		test('should detect a high-entropy AWS secret key', () => {
			// 40-char mixed-class base64 (upper + lower + digit), high entropy.
			const text = 'secret = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYab';
			const result = detectSecrets(text);
			assert.ok(result.matches.some(m => m.pattern.name === 'AWS Secret Key'),
				'real 40-char high-entropy key must still be redacted');
		});

		test('should NOT flag a 40-char identifier as an AWS secret key', () => {
			// Regression: bare {40} rule used to redact long CamelCase class names.
			const text = 'class EvnMorfoHistologicProtoNewbornServiceAbc {}';
			const result = detectSecrets(text);
			assert.ok(!result.matches.some(m => m.pattern.name === 'AWS Secret Key'),
				'no-digit CamelCase identifier must not be treated as a secret');
		});

		test('should NOT flag a 40-char lowercase hex hash as an AWS secret key', () => {
			// SHA-1-style hex (digits + lowercase, no uppercase) is not a secret.
			const text = 'commit da39a3ee5e6b4b0d3255bfef95601890afd80709';
			const result = detectSecrets(text);
			assert.ok(!result.matches.some(m => m.pattern.name === 'AWS Secret Key'),
				'lowercase hex hash must not be treated as a secret');
		});

		test('should detect passwords in config format', () => {
			const text = 'password=mySecretPassword123!';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'Password'));
		});

		test('should detect multiple secrets', () => {
			const text = 'API key: sk-proj-abc123 and token: ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.length >= 2);
			const countByType = Array.from(result.countByType.entries());
			assert.ok(countByType.length >= 2);
		});

		test('should not detect false positives', () => {
			const text = 'This is just regular text with no secrets';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, false);
			assert.strictEqual(result.matches.length, 0);
		});

		test('should respect disabled patterns', () => {
			const config: SecretDetectionConfig = {
				enabled: true,
				customPatterns: [],
				disabledPatternIds: ['openai-key'],
				mode: 'redact',
			};
			const text = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
			const result = detectSecrets(text, config);
			// Should not detect OpenAI key if disabled
			assert.ok(!result.matches.some(m => m.pattern.id === 'openai-key'));
		});

		test('should support custom patterns', () => {
			const config: SecretDetectionConfig = {
				enabled: true,
				customPatterns: [{
					id: 'custom-secret',
					name: 'Custom Secret',
					pattern: 'SECRET-[A-Z0-9]{20}',
					enabled: true,
					priority: 90,
				}],
				disabledPatternIds: [],
				mode: 'redact',
			};
			const text = 'My secret is SECRET-ABCD1234EFGH5678IJKL';
			const result = detectSecrets(text, config);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'Custom Secret'));
		});

		test('should handle disabled detection', () => {
			const config: SecretDetectionConfig = {
				enabled: false,
				customPatterns: [],
				disabledPatternIds: [],
				mode: 'redact',
			};
			const text = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
			const result = detectSecrets(text, config);
			assert.strictEqual(result.hasSecrets, false);
			assert.strictEqual(result.redactedText, text);
		});

		test('should handle overlapping patterns (priority)', () => {
			const text = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
			const result = detectSecrets(text);
			// Should only match once, with highest priority pattern
			assert.strictEqual(result.matches.length, 1);
		});
	});

	suite('redactSecretsInObject', () => {
		test('should redact secrets in string', () => {
			const text = 'API key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz';
			const result = redactSecretsInObject(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.redacted.includes('[[REDACTED:'));
			assert.ok(!result.redacted.includes('sk-proj-abc123'));
		});

		test('should redact secrets in array', () => {
			const arr = [
				'Normal text',
				'API key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz',
				'More text',
			];
			const result = redactSecretsInObject(arr);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(Array.isArray(result.redacted));
			assert.strictEqual(result.redacted[0], 'Normal text');
			assert.ok(result.redacted[1].includes('[[REDACTED:'));
		});

		test('should redact secrets in nested object', () => {
			const obj = {
				message: 'Hello',
				config: {
					apiKey: 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz',
					other: 'value',
				},
			};
			const result = redactSecretsInObject(obj);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.redacted.config.apiKey.includes('[[REDACTED:'));
			assert.strictEqual(result.redacted.config.other, 'value');
		});

		test('should not modify non-string values', () => {
			const obj = {
				number: 123,
				boolean: true,
				null: null,
				array: [1, 2, 3],
			};
			const result = redactSecretsInObject(obj);
			assert.strictEqual(result.hasSecrets, false);
			assert.strictEqual(result.redacted.number, 123);
			assert.strictEqual(result.redacted.boolean, true);
			assert.strictEqual(result.redacted.null, null);
			assert.deepStrictEqual(result.redacted.array, [1, 2, 3]);
		});
	});

	suite('pattern coverage', () => {
		test('should have default patterns enabled', () => {
			const enabledPatterns = DEFAULT_SECRET_PATTERNS.filter(p => p.enabled);
			assert.ok(enabledPatterns.length > 0, 'Should have at least one enabled pattern');
		});

		test('should have unique pattern IDs', () => {
			const ids = DEFAULT_SECRET_PATTERNS.map(p => p.id);
			const uniqueIds = new Set(ids);
			assert.strictEqual(ids.length, uniqueIds.size, 'All pattern IDs should be unique');
		});
	});
});

