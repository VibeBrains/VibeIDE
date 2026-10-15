/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { describeVoiceError, voiceErrorJournalText, voiceMicSettingsUri, VOICE_ENGINE_TIMEOUT_MESSAGE } from '../../../common/voice/vibeVoiceErrors.js';

const CYRILLIC = /[а-яё]/i;

suite('Voice input — error wording', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('denied microphone: the path to the system page is named per platform, the action opens it where it exists', () => {
		const mac = describeVoiceError({ type: 'mic', name: 'NotAllowedError' }, 'mac');
		const win = describeVoiceError({ type: 'mic', name: 'SecurityError' }, 'windows');
		const other = describeVoiceError({ type: 'mic', name: 'NotAllowedError' }, 'other');
		assert.deepStrictEqual({
			kinds: [mac.kind, win.kind, other.kind],
			macAction: mac.action,
			winAction: win.action,
			otherAction: other.action,
			macHint: mac.message.includes('Системные настройки → Конфиденциальность и безопасность → Микрофон'),
			winHint: win.message.includes('Параметры → Конфиденциальность → Микрофон'),
			macUri: voiceMicSettingsUri('mac'),
			winUri: voiceMicSettingsUri('windows'),
			otherUri: voiceMicSettingsUri('other'),
		}, {
			kinds: ['micDenied', 'micDenied', 'micDenied'],
			macAction: 'openMicSettings',
			winAction: 'openMicSettings',
			otherAction: 'none',
			macHint: true,
			winHint: true,
			macUri: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
			winUri: 'ms-settings:privacy-microphone',
			otherUri: undefined,
		});
	});

	test('other microphone failures keep their own kind and offer a retry', () => {
		const names = ['NotFoundError', 'NotReadableError', 'AbortError', 'TypeError'];
		assert.deepStrictEqual(names.map(name => {
			const info = describeVoiceError({ type: 'mic', name, message: 'boom' }, 'mac');
			return [info.kind, info.action, info.journal];
		}), [
			['micNotFound', 'retry', true],
			['micBusy', 'retry', true],
			['micBusy', 'retry', true],
			['micFailed', 'retry', true],
		]);
	});

	test('engine messages: missing models offer the download, a dead or hung process offers a retry', () => {
		const cases = [
			'Voice models for profile \'ru\' are not installed',
			'Error: Voice models for profile \'en\' are not installed',
			'Archive stt-ru did not contain the expected files',
			'crash',
			'exit',
			VOICE_ENGINE_TIMEOUT_MESSAGE,
		];
		assert.deepStrictEqual(cases.map(message => {
			const info = describeVoiceError({ type: 'engine', message }, 'mac');
			return [info.kind, info.action];
		}), [
			['modelsMissing', 'downloadModels'],
			['modelsMissing', 'downloadModels'],
			['modelsMissing', 'downloadModels'],
			['engineCrashed', 'retry'],
			['engineCrashed', 'retry'],
			['engineTimeout', 'retry'],
		]);
	});

	test('an unknown engine message is wrapped in Russian and cut; a Russian one passes as it is', () => {
		const wrapped = describeVoiceError({ type: 'engine', message: `Error: ${'x'.repeat(500)}` }, 'mac');
		const russian = describeVoiceError({ type: 'engine', message: 'Облачное распознавание: нет ключа Gemini' }, 'mac');
		assert.deepStrictEqual({
			wrappedKind: wrapped.kind,
			wrappedStart: wrapped.message.startsWith('Сбой распознавания речи: xxx'),
			wrappedLength: wrapped.message.length < 260,
			russianMessage: russian.message,
		}, {
			wrappedKind: 'engineFailed',
			wrappedStart: true,
			wrappedLength: true,
			russianMessage: 'Облачное распознавание: нет ключа Gemini',
		});
	});

	test('download failure keeps the reason and offers the retry of the download', () => {
		const info = describeVoiceError({ type: 'download', message: 'Error: getaddrinfo ENOTFOUND github.com' }, 'mac');
		assert.deepStrictEqual({ kind: info.kind, action: info.action, message: info.message, severity: info.severity }, {
			kind: 'downloadFailed',
			action: 'retryDownload',
			message: 'Не удалось скачать модели голосового ввода: getaddrinfo ENOTFOUND github.com',
			severity: 'error',
		});
	});

	test('nothing recognized is an expected outcome: info, a retry, no journal line', () => {
		const info = describeVoiceError({ type: 'noSpeech' }, 'mac');
		assert.deepStrictEqual({ kind: info.kind, severity: info.severity, action: info.action, journal: info.journal, message: info.message }, {
			kind: 'noSpeech',
			severity: 'info',
			action: 'retry',
			journal: false,
			message: 'Не расслышал. Говорите ближе к микрофону и повторите.',
		});
	});

	test('every wording is Russian and journal text puts a sentence on a line', () => {
		const failures = [
			describeVoiceError({ type: 'mic', name: 'NotAllowedError' }, 'mac'),
			describeVoiceError({ type: 'mic', name: 'NotFoundError' }, 'mac'),
			describeVoiceError({ type: 'engine', message: 'crash' }, 'mac'),
			describeVoiceError({ type: 'engine', message: 'segfault' }, 'mac'),
			describeVoiceError({ type: 'download', message: 'timeout' }, 'mac'),
			describeVoiceError({ type: 'noSpeech' }, 'mac'),
		];
		assert.deepStrictEqual({
			allRussian: failures.every(f => CYRILLIC.test(f.message)),
			journal: voiceErrorJournalText(describeVoiceError({ type: 'mic', name: 'NotFoundError' }, 'mac')),
		}, {
			allRussian: true,
			journal: 'ГОЛОСОВОЙ ВВОД: Микрофон не найден.\nПодключите устройство ввода звука и повторите.',
		});
	});
});
