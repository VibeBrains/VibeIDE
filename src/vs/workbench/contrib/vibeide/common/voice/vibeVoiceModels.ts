/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — model catalog and path resolution. Pure module (no fs/node): the main
 * process does the actual disk checks and downloads; unit tests live in `test/common/voice/`.
 *
 * Models are served from our own GitHub release mirror (tag `stt-models-v1` on the product
 * repo): HuggingFace is unreliable for the primary RU audience and the upstream k2-fsa
 * archives are tar.bz2, which node cannot unpack without extra deps — the mirror repacks
 * them as zip for `vs/base/node/zip.ts`. Provenance and licenses are recorded in the
 * release notes and in docs/knowledge/voice/.
 */

import { join } from '../../../../../base/common/path.js';
import { VoiceOfflineModelPaths, VoiceProfileId, VoiceSessionModelPaths } from './vibeVoiceTypes.js';

/** Quality tier of the English offline batch model (`/watch` transcription). */
export type VoiceEnglishBatchTier = 'small' | 'medium';
export const VOICE_ENGLISH_BATCH_TIERS: readonly VoiceEnglishBatchTier[] = ['small', 'medium'];
export const VOICE_ENGLISH_BATCH_TIER_DEFAULT: VoiceEnglishBatchTier = 'small';

// Canonical org name is VibeBrains (the VibeIDETeam spelling survives only via GitHub's
// owner-rename redirect — do not rely on it, a redirect dies if the old name is re-registered).
const MIRROR_BASE_URL = 'https://github.com/VibeBrains/VibeIDE/releases/download/stt-models-v1';

/** One downloadable archive that unpacks into `<modelsRoot>/<dir>/`. */
export interface VoiceModelArchive {
	readonly id: string;
	/** Top-level directory the zip extracts to (mirrors the upstream sherpa-onnx name). */
	readonly dir: string;
	readonly url: string;
	readonly sha256: string;
	/** Zip size in bytes — download progress totals and UI labels. */
	readonly sizeBytes: number;
	/** Files (relative to `dir`) that must exist for the archive to count as installed. */
	readonly files: readonly string[];
}

const T_ONE_DIR = 'sherpa-onnx-streaming-t-one-russian-2025-09-08';
const GIGAAM_DIR = 'sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16';
const NEMO_EN_DIR = 'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8';
const NEMO_EN_CTC_SMALL_DIR = 'sherpa-onnx-nemo-ctc-en-conformer-small';
const NEMO_EN_CTC_MEDIUM_DIR = 'sherpa-onnx-nemo-ctc-en-conformer-medium';

const T_ONE_ARCHIVE: VoiceModelArchive = {
	id: 't-one-ru',
	dir: T_ONE_DIR,
	url: `${MIRROR_BASE_URL}/t-one-ru-2025-09-08.zip`,
	sha256: '3411fec69cae2d29b85361cbbdd7c7a07f055e7b809b9ab053fd4c45c818084d',
	sizeBytes: 132331875,
	files: ['model.onnx', 'tokens.txt'],
};

const GIGAAM_ARCHIVE: VoiceModelArchive = {
	id: 'gigaam-v3-ctc-ru',
	dir: GIGAAM_DIR,
	url: `${MIRROR_BASE_URL}/gigaam-v3-ctc-ru-2025-12-16.zip`,
	sha256: 'b2c2a657af9db8eb9dc18905da592d4cc6bcf7cf159021fa963885e4726243b0',
	sizeBytes: 159055125,
	files: ['model.int8.onnx', 'tokens.txt'],
};

const NEMO_EN_ARCHIVE: VoiceModelArchive = {
	id: 'nemo-fc-transducer-en',
	dir: NEMO_EN_DIR,
	url: `${MIRROR_BASE_URL}/nemo-fc-transducer-en-480ms-int8.zip`,
	sha256: '38c0df01d967860d82347107b0ae728643938f63c8cc7a1ec63cf8100ee278ad',
	sizeBytes: 102645672,
	files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
};

// English offline batch models (NeMo CTC, int8) — the `/watch` transcript fallback for
// English audio without platform subtitles. Two quality tiers the user chooses between
// (`vibeide.voice.englishBatchModel`); both use the same `nemoCtc` recognizer as GigaAM,
// so the worker is unchanged. Independent of the English DICTATION model (a streaming
// transducer) — dictation must not have to download a batch model it never uses.
const NEMO_EN_CTC_SMALL_ARCHIVE: VoiceModelArchive = {
	id: 'nemo-ctc-en-small',
	dir: NEMO_EN_CTC_SMALL_DIR,
	url: `${MIRROR_BASE_URL}/nemo-ctc-en-conformer-small-int8.zip`,
	sha256: '5dc7ae725d71a07e476c92451b19591be28c2e1997a69fddab2f0a6ba6a1d0dc',
	sizeBytes: 18964108,
	files: ['model.int8.onnx', 'tokens.txt'],
};

const NEMO_EN_CTC_MEDIUM_ARCHIVE: VoiceModelArchive = {
	id: 'nemo-ctc-en-medium',
	dir: NEMO_EN_CTC_MEDIUM_DIR,
	url: `${MIRROR_BASE_URL}/nemo-ctc-en-conformer-medium-int8.zip`,
	sha256: '8dc08cccde490ab7c01acf7d6baf541dc32a85dd8749b1f4e918f2411ef6ded6',
	sizeBytes: 38077941,
	files: ['model.int8.onnx', 'tokens.txt'],
};

const EN_CTC_ARCHIVE_BY_TIER: Record<VoiceEnglishBatchTier, VoiceModelArchive> = {
	small: NEMO_EN_CTC_SMALL_ARCHIVE,
	medium: NEMO_EN_CTC_MEDIUM_ARCHIVE,
};

/**
 * Profile → archives. RU is a hybrid: T-one streams interims, GigaAM re-decodes each
 * phrase for the final text (better WER; both lowercase, no punctuation — the sherpa
 * GigaAM export has a plain character vocabulary). EN is streaming-only.
 */
const PROFILE_ARCHIVES: Record<VoiceProfileId, readonly VoiceModelArchive[]> = {
	ru: [T_ONE_ARCHIVE, GIGAAM_ARCHIVE],
	en: [NEMO_EN_ARCHIVE],
};

export function voiceArchivesForProfile(profileId: VoiceProfileId): readonly VoiceModelArchive[] {
	return PROFILE_ARCHIVES[profileId];
}

/** All files (relative to `modelsRoot`) that must exist for the profile to be usable. */
export function voiceRequiredFilesForProfile(profileId: VoiceProfileId): string[] {
	return PROFILE_ARCHIVES[profileId].flatMap(a => a.files.map(f => join(a.dir, f)));
}

export function voiceDownloadBytesForProfile(profileId: VoiceProfileId): number {
	return PROFILE_ARCHIVES[profileId].reduce((sum, a) => sum + a.sizeBytes, 0);
}

// ── Batch (offline /watch transcription) — separate from the dictation bundle ──

/**
 * Offline archives a profile needs for BATCH transcription (`/watch`). RU reuses GigaAM
 * (already in the dictation bundle — same dir/files, never downloaded twice); EN uses the
 * chosen CTC tier, which the streaming-only dictation bundle does NOT contain.
 */
export function voiceBatchArchivesForProfile(profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): readonly VoiceModelArchive[] {
	return profileId === 'ru' ? [GIGAAM_ARCHIVE] : [EN_CTC_ARCHIVE_BY_TIER[englishTier]];
}

/** Files (relative to `modelsRoot`) that must exist for batch transcription to work. */
export function voiceBatchRequiredFilesForProfile(profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): string[] {
	return voiceBatchArchivesForProfile(profileId, englishTier).flatMap(a => a.files.map(f => join(a.dir, f)));
}

export function voiceBatchDownloadBytesForProfile(profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): number {
	return voiceBatchArchivesForProfile(profileId, englishTier).reduce((sum, a) => sum + a.sizeBytes, 0);
}

/** Absolute offline-model paths for batch decode, or undefined if the profile has none. */
export function resolveVoiceBatchOfflinePaths(modelsRoot: string, profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): VoiceOfflineModelPaths {
	if (profileId === 'ru') {
		return { kind: 'nemo-ctc', model: join(modelsRoot, GIGAAM_DIR, 'model.int8.onnx'), tokens: join(modelsRoot, GIGAAM_DIR, 'tokens.txt') };
	}
	const dir = englishTier === 'medium' ? NEMO_EN_CTC_MEDIUM_DIR : NEMO_EN_CTC_SMALL_DIR;
	return { kind: 'nemo-ctc', model: join(modelsRoot, dir, 'model.int8.onnx'), tokens: join(modelsRoot, dir, 'tokens.txt') };
}

/** Absolute model paths for a session, given the resolved models root directory. */
export function resolveVoiceSessionModelPaths(modelsRoot: string, profileId: VoiceProfileId): VoiceSessionModelPaths {
	if (profileId === 'ru') {
		return {
			streaming: {
				kind: 'tone-ctc',
				model: join(modelsRoot, T_ONE_DIR, 'model.onnx'),
				tokens: join(modelsRoot, T_ONE_DIR, 'tokens.txt'),
			},
			offline: {
				kind: 'nemo-ctc',
				model: join(modelsRoot, GIGAAM_DIR, 'model.int8.onnx'),
				tokens: join(modelsRoot, GIGAAM_DIR, 'tokens.txt'),
			},
		};
	}
	return {
		streaming: {
			kind: 'transducer',
			encoder: join(modelsRoot, NEMO_EN_DIR, 'encoder.int8.onnx'),
			decoder: join(modelsRoot, NEMO_EN_DIR, 'decoder.int8.onnx'),
			joiner: join(modelsRoot, NEMO_EN_DIR, 'joiner.int8.onnx'),
			tokens: join(modelsRoot, NEMO_EN_DIR, 'tokens.txt'),
		},
	};
}

/**
 * Map a normalized speech language (`ru-RU` / `en-US` / …) to an engine profile.
 * Russian is the primary audience; every non-Russian locale falls back to English.
 */
export function voiceProfileForSpeechLanguage(language: string | undefined): VoiceProfileId {
	return language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * Engine profile from the RAW `accessibility.voice.speechLanguage` setting value.
 * `auto` (the default) deliberately does NOT go through the upstream resolver: it maps
 * `auto` to the Electron display locale, which is `en` here even though every VibeIDE
 * string is Russian-in-source — dictation would silently default to English for the
 * Russian-first audience. `auto`/unset → `ru`; an explicit language wins.
 */
export function resolveVoiceProfile(rawSpeechLanguageConfig: unknown, resolvedLanguage?: string): VoiceProfileId {
	if (rawSpeechLanguageConfig === undefined || rawSpeechLanguageConfig === null || rawSpeechLanguageConfig === 'auto') {
		return 'ru';
	}
	return voiceProfileForSpeechLanguage(resolvedLanguage ?? String(rawSpeechLanguageConfig));
}
