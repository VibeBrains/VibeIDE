/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildGeminiAudioMessage, buildGeminiAudioStreamEnd, buildGeminiTranscribeSetup, GEMINI_TRANSCRIBE_RENEW_MS, GEMINI_TRANSCRIBE_STREAM_LIMIT_MS, geminiLiveUrl, parseGeminiLiveMessage } from '../../common/voice/vibeVoiceGeminiLive.js';
import { resolveVoiceCloudMode, resolveVoiceCloudVocabulary, VOICE_VOCABULARY_MAX_TERMS } from '../../common/voice/vibeVoiceConfiguration.js';
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
			{ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['ru-RU'], mode: 'SMART' } } },
			{ realtimeInput: { audio: { data: 'AAA=', mimeType: 'audio/pcm;rate=16000' } } },
			{ realtimeInput: { audioStreamEnd: true } },
			'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k%2By',
		]);
	});

	/**
	 * Режим и словарь — то, чем облачный текст отличается от локального: пунктуация и термины проекта.
	 */
	test('режим и словарь: дословный шлётся явно, пустой словарь поля не создаёт', () => {
		assert.deepStrictEqual([
			buildGeminiTranscribeSetup('en', { mode: 'verbatim' }),
			buildGeminiTranscribeSetup('en', { vocabulary: [] }),
			buildGeminiTranscribeSetup('en', { vocabulary: ['VibeIDE', 'jsonc'] }),
		], [
			{ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['en-US'], mode: 'VERBATIM' } } },
			{ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['en-US'], mode: 'SMART' } } },
			{ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['en-US'], mode: 'SMART', customVocabulary: ['VibeIDE', 'jsonc'] } } },
		]);
	});

	test('настройки облака: умолчание — причёсанный текст, словарь чистится и обрезается', () => {
		const many = Array.from({ length: VOICE_VOCABULARY_MAX_TERMS + 5 }, (_, i) => `term${i}`);
		assert.deepStrictEqual([
			resolveVoiceCloudMode(undefined),
			resolveVoiceCloudMode('verbatim'),
			resolveVoiceCloudMode('что-то своё'),
			resolveVoiceCloudVocabulary(['  VibeIDE  ', 'vibeide', '', 7, 'jsonc']),
			resolveVoiceCloudVocabulary('VibeIDE, jsonc'),
			resolveVoiceCloudVocabulary(many).length,
		], ['smart', 'verbatim', 'smart', ['VibeIDE', 'jsonc'], [], VOICE_VOCABULARY_MAX_TERMS]);
	});

	/** Сигнала `goAway` у этой модели вендор не обещает, поэтому замена открывается до лимита. */
	test('замена соединения назначается раньше предела потока', () => {
		assert.deepStrictEqual(
			[GEMINI_TRANSCRIBE_STREAM_LIMIT_MS, GEMINI_TRANSCRIBE_RENEW_MS < GEMINI_TRANSCRIBE_STREAM_LIMIT_MS, GEMINI_TRANSCRIBE_STREAM_LIMIT_MS - GEMINI_TRANSCRIBE_RENEW_MS],
			[600000, true, 60000],
		);
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
