/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { detectSecrets, redactSecretsInObject, SecretDetectionConfig, DEFAULT_SECRET_PATTERNS } from '../../common/secretDetection.js';

suite('Secret Detection', () => {

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
			const text = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'GitHub Token'));
		});

		test('should detect AWS access keys', () => {
			const text = 'AKIAIOSFODNN7EXAMPLE';
			const result = detectSecrets(text);
			assert.strictEqual(result.hasSecrets, true);
			assert.ok(result.matches.some(m => m.pattern.name === 'AWS Access Key'));
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

