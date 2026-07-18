/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resolveVoiceBatchOfflinePaths, resolveVoiceProfile, resolveVoiceSessionModelPaths, voiceArchivesForProfile, voiceBatchArchivesForProfile, voiceBatchDownloadBytesForProfile, voiceBatchRequiredFilesForProfile, voiceDownloadBytesForProfile, voiceProfileForSpeechLanguage, voiceRequiredFilesForProfile, VOICE_ENGLISH_BATCH_TIERS } from '../../../common/voice/vibeVoiceModels.js';
import { VOICE_PROFILE_IDS } from '../../../common/voice/vibeVoiceTypes.js';
import { clampVoiceEndpointSilenceMs, clampVoiceKeepAliveSec, resolveVoiceEnglishBatchTier, resolveVoiceThreads, VOICE_ENDPOINT_SILENCE_DEFAULT_MS, VOICE_KEEP_ALIVE_DEFAULT_SEC } from '../../../common/voice/vibeVoiceConfiguration.js';

suite('Voice input — model catalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('catalog integrity: every archive (dictation + batch) has mirror url, sha256 and size', () => {
		const archives = VOICE_PROFILE_IDS.flatMap(p => [
			...voiceArchivesForProfile(p),
			...VOICE_ENGLISH_BATCH_TIERS.flatMap(t => voiceBatchArchivesForProfile(p, t)),
		]);
		for (const archive of archives) {
			assert.ok(/^https:\/\/github\.com\/VibeBrains\/VibeIDE\/releases\/download\/stt-models-v1\/[\w.-]+\.zip$/.test(archive.url), `url of ${archive.id}: ${archive.url}`);
			assert.ok(/^[0-9a-f]{64}$/.test(archive.sha256), `sha256 of ${archive.id}`);
			assert.ok(archive.sizeBytes > 1024 * 1024, `size of ${archive.id}`);
			assert.ok(archive.files.length > 0 && archive.files.includes('tokens.txt'), `files of ${archive.id}`);
		}
	});

	test('batch model: ru reuses gigaam, en picks the configured tier', () => {
		assert.deepStrictEqual(resolveVoiceBatchOfflinePaths('/root', 'ru', 'small'), {
			kind: 'nemo-ctc',
			model: '/root/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/model.int8.onnx',
			tokens: '/root/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/tokens.txt',
		});
		assert.deepStrictEqual(
			[resolveVoiceBatchOfflinePaths('/root', 'en', 'small').model, resolveVoiceBatchOfflinePaths('/root', 'en', 'medium').model],
			['/root/sherpa-onnx-nemo-ctc-en-conformer-small/model.int8.onnx', '/root/sherpa-onnx-nemo-ctc-en-conformer-medium/model.int8.onnx'],
		);
		// ru batch reuses a file already in the dictation bundle → no extra download.
		assert.deepStrictEqual(voiceBatchRequiredFilesForProfile('ru', 'small'), [
			'sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/model.int8.onnx',
			'sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/tokens.txt',
		]);
		assert.ok(voiceRequiredFilesForProfile('ru').includes(voiceBatchRequiredFilesForProfile('ru', 'small')[0]));
		// en batch files are NOT part of the streaming dictation bundle.
		const enBatch = voiceBatchRequiredFilesForProfile('en', 'medium')[0];
		assert.ok(!voiceRequiredFilesForProfile('en').includes(enBatch), 'en batch model must be independent of dictation');
		assert.ok(voiceBatchDownloadBytesForProfile('en', 'small') < voiceBatchDownloadBytesForProfile('en', 'medium'));
	});

	test('englishBatchModel config normalizes to a known tier (default small)', () => {
		assert.deepStrictEqual(
			[resolveVoiceEnglishBatchTier('small'), resolveVoiceEnglishBatchTier('medium'), resolveVoiceEnglishBatchTier('large'), resolveVoiceEnglishBatchTier(undefined), resolveVoiceEnglishBatchTier(42)],
			['small', 'medium', 'small', 'small', 'small'],
		);
	});

	test('ru profile is the hybrid: streaming t-one + offline gigaam', () => {
		const paths = resolveVoiceSessionModelPaths('/root', 'ru');
		assert.deepStrictEqual(paths, {
			streaming: {
				kind: 'tone-ctc',
				model: '/root/sherpa-onnx-streaming-t-one-russian-2025-09-08/model.onnx',
				tokens: '/root/sherpa-onnx-streaming-t-one-russian-2025-09-08/tokens.txt',
			},
			offline: {
				kind: 'nemo-ctc',
				model: '/root/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/model.int8.onnx',
				tokens: '/root/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/tokens.txt',
			},
		});
	});

	test('en profile is streaming-only transducer', () => {
		const paths = resolveVoiceSessionModelPaths('/root', 'en');
		assert.strictEqual(paths.streaming.kind, 'transducer');
		assert.strictEqual(paths.offline, undefined);
	});

	test('required files cover exactly the resolved model paths', () => {
		assert.deepStrictEqual(voiceRequiredFilesForProfile('ru'), [
			'sherpa-onnx-streaming-t-one-russian-2025-09-08/model.onnx',
			'sherpa-onnx-streaming-t-one-russian-2025-09-08/tokens.txt',
			'sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/model.int8.onnx',
			'sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/tokens.txt',
		]);
		assert.deepStrictEqual(voiceRequiredFilesForProfile('en'), [
			'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8/encoder.int8.onnx',
			'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8/decoder.int8.onnx',
			'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8/joiner.int8.onnx',
			'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8/tokens.txt',
		]);
	});

	test('download bytes aggregate the profile archives', () => {
		const ru = voiceArchivesForProfile('ru').reduce((sum, a) => sum + a.sizeBytes, 0);
		assert.strictEqual(voiceDownloadBytesForProfile('ru'), ru);
	});

	test('speech language → profile: ru-* is russian, everything else english', () => {
		assert.deepStrictEqual(
			['ru-RU', 'ru', 'RU-ru', 'en-US', 'de-DE', undefined, ''].map(voiceProfileForSpeechLanguage),
			['ru', 'ru', 'ru', 'en', 'en', 'en', 'en'],
		);
	});

	test('raw config → profile: auto/unset means russian (russian-first product), explicit wins', () => {
		assert.deepStrictEqual(
			[
				resolveVoiceProfile(undefined),
				resolveVoiceProfile(null),
				resolveVoiceProfile('auto'),
				resolveVoiceProfile('en-US'),
				resolveVoiceProfile('ru-RU'),
				resolveVoiceProfile('de-DE'),
				resolveVoiceProfile('en-US', 'ru-RU'), // resolved session language wins over raw
			],
			['ru', 'ru', 'ru', 'en', 'ru', 'en', 'ru'],
		);
	});
});

suite('Voice input — configuration clamps', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('threads: 0 = auto (half the cores), clamped to 1..8', () => {
		assert.deepStrictEqual(
			[resolveVoiceThreads(0, 8), resolveVoiceThreads(0, 1), resolveVoiceThreads(0, 32), resolveVoiceThreads(3, 8), resolveVoiceThreads(99, 4)],
			[4, 1, 8, 3, 8],
		);
	});

	test('endpoint silence and keep-alive fall back to defaults on garbage', () => {
		assert.deepStrictEqual(
			[clampVoiceEndpointSilenceMs(NaN), clampVoiceEndpointSilenceMs(1), clampVoiceEndpointSilenceMs(99999), clampVoiceKeepAliveSec(NaN), clampVoiceKeepAliveSec(-5), clampVoiceKeepAliveSec(99999)],
			[VOICE_ENDPOINT_SILENCE_DEFAULT_MS, 300, 5000, VOICE_KEEP_ALIVE_DEFAULT_SEC, 0, 3600],
		);
	});
});
