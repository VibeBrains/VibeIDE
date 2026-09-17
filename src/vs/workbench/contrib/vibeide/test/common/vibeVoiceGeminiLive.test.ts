/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildGeminiAudioMessage, buildGeminiAudioStreamEnd, buildGeminiTranscribeSetup, geminiLiveUrl, parseGeminiLiveMessage } from '../../common/voice/vibeVoiceGeminiLive.js';
import { resolveVoiceEngine } from '../../common/voice/vibeVoiceConfiguration.js';

/**
 * Облачная диктовка: сообщения Gemini Live Transcribe и выбор движка.
 */
suite('vibeVoiceGeminiLive — облачная диктовка', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('сообщения клиента: настройка сессии по профилю, звук, конец потока, адрес', () => {
		assert.deepStrictEqual([
			buildGeminiTranscribeSetup('ru'),
			buildGeminiAudioMessage('AAA='),
			buildGeminiAudioStreamEnd(),
			geminiLiveUrl('k+y'),
		], [
			{ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['ru-RU'] } } },
			{ realtimeInput: { audio: { data: 'AAA=', mimeType: 'audio/pcm;rate=16000' } } },
			{ realtimeInput: { audioStreamEnd: true } },
			'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k%2By',
		]);
	});

	test('сообщения сервера: готовность, промежуточный и финальный текст, goAway, ошибка, мусор', () => {
		assert.deepStrictEqual([
			parseGeminiLiveMessage('{"setupComplete":{}}'),
			parseGeminiLiveMessage('{"serverContent":{"interimInputTranscription":{"text":"при"}}}'),
			parseGeminiLiveMessage('{"serverContent":{"inputTranscription":{"text":"привет"}}}'),
			parseGeminiLiveMessage('{"goAway":{"timeLeft":"10s"}}'),
			parseGeminiLiveMessage('{"error":{"message":"API key not valid"}}'),
			parseGeminiLiveMessage('не json'),
			parseGeminiLiveMessage('{"serverContent":{"inputTranscription":{"text":""}}}'),
		], [
			{ setupComplete: true },
			{ interim: 'при' },
			{ final: 'привет' },
			{ goAway: true },
			{ error: 'API key not valid' },
			{ error: 'unreadable message' },
			{},
		]);
	});

	test('движок: по умолчанию локальный, облачный только явным значением', () => {
		assert.deepStrictEqual([resolveVoiceEngine(undefined), resolveVoiceEngine('gemini'), resolveVoiceEngine('cloud'), resolveVoiceEngine('local')], ['local', 'gemini', 'local', 'local']);
	});
});
