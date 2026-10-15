/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { parseSttModelsCatalog } from '../../../common/voice/sttModelsCatalog.js';
import { STT_MODELS_JSONC } from '../../../common/voice/sttModels.generated.js';
import { VOICE_ENGLISH_BATCH_TIERS } from '../../../common/voice/vibeVoiceModels.js';
import { VOICE_PROFILE_IDS, VOICE_SAMPLE_RATE } from '../../../common/voice/vibeVoiceTypes.js';

const SHA = 'a'.repeat(64);

/** The smallest catalogue that is valid: one streaming model, one batch model, every key the product reads */
function minimal(change: (catalog: Record<string, any>) => void = () => { }): string {
	const archive = (id: string, files: string[]) => ({ id, dir: `dir-${id}`, url: `https://example.org/${id}.zip`, sha256: SHA, sizeBytes: 1024 * 1024 * 5, files });
	// A new object each time: a test changes one model, not every place that names the same one
	const offline = () => ({ kind: 'nemo-ctc', archive: 'ctc', model: 'm.onnx', tokens: 't.txt' });
	const catalog: Record<string, any> = {
		version: 1,
		sampleRate: 16000,
		archives: [archive('tone', ['model.onnx', 'tokens.txt']), archive('ctc', ['m.onnx', 't.txt']), archive('rnnt', ['e.onnx', 'd.onnx', 'j.onnx', 't.txt'])],
		profiles: {
			ru: { streaming: { kind: 'tone-ctc', archive: 'tone', model: 'model.onnx', tokens: 'tokens.txt' }, final: offline() },
			en: { streaming: { kind: 'transducer', archive: 'rnnt', encoder: 'e.onnx', decoder: 'd.onnx', joiner: 'j.onnx', tokens: 't.txt' } },
		},
		batch: { ru: offline(), 'en-small': offline(), 'en-medium': offline() },
	};
	change(catalog);
	return JSON.stringify(catalog);
}

const problemsOf = (change: (catalog: Record<string, any>) => void) => parseSttModelsCatalog(minimal(change)).problems;

suite('Voice input — catalogue of the shared set is read and checked', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the catalogue of the build is valid, speaks the audio contract and covers every profile and every English tier', () => {
		const parsed = parseSttModelsCatalog(STT_MODELS_JSONC);
		assert.deepStrictEqual({
			problems: parsed.problems,
			sampleRate: parsed.catalog?.sampleRate,
			profiles: Object.keys(parsed.catalog?.profiles ?? {}).sort(),
			batch: Object.keys(parsed.catalog?.batch ?? {}).sort(),
		}, {
			problems: [],
			sampleRate: VOICE_SAMPLE_RATE,
			profiles: [...VOICE_PROFILE_IDS].sort(),
			batch: ['en-medium', 'en-small', 'ru'],
		});
		assert.deepStrictEqual(VOICE_ENGLISH_BATCH_TIERS.map(tier => parsed.catalog?.batch[`en-${tier}`] !== undefined), [true, true]);
	});

	test('a minimal catalogue parses as it is written', () => {
		const parsed = parseSttModelsCatalog(minimal());
		assert.deepStrictEqual({ problems: parsed.problems, archives: parsed.catalog?.archives.map(a => a.id), final: parsed.catalog?.profiles.ru.final?.archive, enFinal: parsed.catalog?.profiles.en.final }, {
			problems: [],
			archives: ['tone', 'ctc', 'rnnt'],
			final: 'ctc',
			enFinal: undefined,
		});
	});

	test('comments, trailing commas and a double slash inside a string do not get in the way', () => {
		const text = `// header\n{ /* inline */ "version": 1, "sampleRate": 16000,\n"archives": [], "profiles": {}, "batch": {}, }`;
		const withUrl = minimal().replace('https://example.org/tone.zip', 'https://example.org//tone.zip');
		const parsed = parseSttModelsCatalog(`// the set's header comment\n${withUrl.replace('"version":1,', '"version":1, /* note */')}`);
		assert.deepStrictEqual({ url: parsed.catalog?.archives[0].url, problems: parsed.problems, emptyIsRefused: parseSttModelsCatalog(text).problems.length > 0 }, {
			url: 'https://example.org//tone.zip',
			problems: [],
			emptyIsRefused: true,
		});
	});

	test('a catalogue the product cannot use names what is wrong', () => {
		assert.deepStrictEqual({
			notJson: parseSttModelsCatalog('{ not json').problems.length,
			version: problemsOf(c => { c.version = 2; }),
			sha: problemsOf(c => { c.archives[0].sha256 = 'abc'; }),
			url: problemsOf(c => { c.archives[0].url = 'http://example.org/a.zip'; }),
			size: problemsOf(c => { c.archives[0].sizeBytes = 0; }),
			dir: problemsOf(c => { c.archives[0].dir = 'a/b'; }),
			twin: problemsOf(c => { c.archives[1].id = 'tone'; }),
			profile: problemsOf(c => { delete c.profiles.en; }),
			batch: problemsOf(c => { delete c.batch['en-medium']; }),
		}, {
			notJson: 1,
			version: ['version 2 — this code reads version 1'],
			sha: ['archives[0] «tone»: sha256 is not 64 lowercase hex digits'],
			url: ['archives[0] «tone»: url is not https'],
			size: ['archives[0] «tone»: sizeBytes is not a positive integer'],
			dir: ['archives[0] «tone»: dir is a folder name'],
			twin: ['archives[1] «tone»: the id is taken', 'profiles.ru.final: archive «ctc» is not in archives', 'batch.ru: archive «ctc» is not in archives', 'batch.en-small: archive «ctc» is not in archives', 'batch.en-medium: archive «ctc» is not in archives'],
			profile: ['profiles.en: a profile with a streaming model is expected'],
			batch: ['batch.en-medium: kind «nemo-ctc» is expected'],
		});
	});

	test('a model must point at an archive that holds its files: a download that cannot work is refused at the build', () => {
		assert.deepStrictEqual({
			missingArchive: problemsOf(c => { c.profiles.ru.streaming.archive = 'nowhere'; }),
			missingFile: problemsOf(c => { c.profiles.ru.streaming.model = 'other.onnx'; }),
			missingJoiner: problemsOf(c => { c.profiles.en.streaming.joiner = 'x.onnx'; }),
			finalFile: problemsOf(c => { c.profiles.ru.final.tokens = 'nope.txt'; }),
			unknownKind: problemsOf(c => { c.profiles.ru.streaming.kind = 'whisper'; }),
		}, {
			missingArchive: ['profiles.ru.streaming: archive «nowhere» is not in archives'],
			missingFile: ['profiles.ru.streaming: model «other.onnx» is not among the files of «tone»'],
			missingJoiner: ['profiles.en.streaming: joiner «x.onnx» is not among the files of «rnnt»'],
			finalFile: ['profiles.ru.final: tokens «nope.txt» is not among the files of «ctc»'],
			unknownKind: ['profiles.ru.streaming: kind «tone-ctc» or «transducer» is expected'],
		});
	});
});
