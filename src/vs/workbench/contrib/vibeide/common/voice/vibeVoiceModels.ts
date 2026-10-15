/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — model catalog and path resolution. Pure module (no fs/node): the main
 * process does the actual disk checks and downloads; unit tests live in `test/common/voice/`.
 *
 * The catalogue itself is not here: addresses, sizes, checksums and which model makes which profile
 * live in the shared `.vibe` set (`.vibe-defaults/voice/sttModels.jsonc`), embedded in the build by
 * `scripts/gen-stt-models.ts` and read by `sttModelsCatalog.ts`. A second copy in the code drifts silently.
 *
 * Models are served from our own GitHub release mirror (tag `stt-models-v1` on the product
 * repo): HuggingFace is unreliable for the primary RU audience and the upstream k2-fsa
 * archives are tar.bz2, which node cannot unpack without extra deps — the mirror repacks
 * them as zip for `vs/base/node/zip.ts`. Provenance and licenses are recorded in the set's
 * file and in docs/knowledge/voice/.
 */

import { join } from '../../../../../base/common/path.js';
import { SttBatchKey, SttModelArchive, SttModelsCatalog, SttOfflineModel, parseSttModelsCatalog } from './sttModelsCatalog.js';
import { STT_MODELS_JSONC } from './sttModels.generated.js';
import { VoiceOfflineModelPaths, VoiceProfileId, VoiceSessionModelPaths, VoiceStreamingModelPaths } from './vibeVoiceTypes.js';

/** Quality tier of the English offline batch model (`/watch` transcription). */
export type VoiceEnglishBatchTier = 'small' | 'medium';
export const VOICE_ENGLISH_BATCH_TIERS: readonly VoiceEnglishBatchTier[] = ['small', 'medium'];
export const VOICE_ENGLISH_BATCH_TIER_DEFAULT: VoiceEnglishBatchTier = 'small';

/** One downloadable archive that unpacks into `<modelsRoot>/<dir>/`. */
export type VoiceModelArchive = SttModelArchive;

let shipped: SttModelsCatalog | undefined;

/**
 * The catalogue of the build, read on first use.
 * Not at load: this module is imported by the settings registration, and a bad catalogue must not take that
 * down — the build already refuses one (`gen-stt-models.ts`), so the throw below means a broken build.
 */
function catalog(): SttModelsCatalog {
	if (!shipped) {
		const parsed = parseSttModelsCatalog(STT_MODELS_JSONC);
		if (!parsed.catalog) {
			throw new Error(`The speech model catalogue of the build cannot be read: ${parsed.problems.join('; ')}`);
		}
		shipped = parsed.catalog;
	}
	return shipped;
}

function archiveById(id: string): SttModelArchive {
	// Checked when the catalogue is read: a model names an archive that exists
	return catalog().archives.find(archive => archive.id === id)!;
}

/** The batch model of a profile: Russian has one, English one per quality tier. */
function batchModel(profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): SttOfflineModel {
	const key: SttBatchKey = profileId === 'ru' ? 'ru' : `en-${englishTier}`;
	return catalog().batch[key];
}

function filesOf(archive: SttModelArchive): string[] {
	return archive.files.map(file => join(archive.dir, file));
}

function offlinePathsOf(modelsRoot: string, model: SttOfflineModel): VoiceOfflineModelPaths {
	const dir = archiveById(model.archive).dir;
	return { kind: model.kind, model: join(modelsRoot, dir, model.model), tokens: join(modelsRoot, dir, model.tokens) };
}

/**
 * Profile → archives, streaming model first. RU is a hybrid: T-one streams interims, GigaAM re-decodes each
 * phrase for the final text (better WER; both lowercase, no punctuation — the sherpa
 * GigaAM export has a plain character vocabulary). EN is streaming-only.
 */
export function voiceArchivesForProfile(profileId: VoiceProfileId): readonly VoiceModelArchive[] {
	const profile = catalog().profiles[profileId];
	const ids = [profile.streaming.archive, ...(profile.final ? [profile.final.archive] : [])];
	return [...new Set(ids)].map(archiveById);
}

/** All files (relative to `modelsRoot`) that must exist for the profile to be usable. */
export function voiceRequiredFilesForProfile(profileId: VoiceProfileId): string[] {
	return voiceArchivesForProfile(profileId).flatMap(filesOf);
}

export function voiceDownloadBytesForProfile(profileId: VoiceProfileId): number {
	return voiceArchivesForProfile(profileId).reduce((sum, a) => sum + a.sizeBytes, 0);
}

// ── Batch (offline /watch transcription) — separate from the dictation bundle ──

/**
 * Offline archives a profile needs for BATCH transcription (`/watch`). RU reuses GigaAM
 * (already in the dictation bundle — same dir/files, never downloaded twice); EN uses the
 * chosen CTC tier, which the streaming-only dictation bundle does NOT contain.
 */
export function voiceBatchArchivesForProfile(profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): readonly VoiceModelArchive[] {
	return [archiveById(batchModel(profileId, englishTier).archive)];
}

/** Files (relative to `modelsRoot`) that must exist for batch transcription to work. */
export function voiceBatchRequiredFilesForProfile(profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): string[] {
	return voiceBatchArchivesForProfile(profileId, englishTier).flatMap(filesOf);
}

export function voiceBatchDownloadBytesForProfile(profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): number {
	return voiceBatchArchivesForProfile(profileId, englishTier).reduce((sum, a) => sum + a.sizeBytes, 0);
}

/** Absolute offline-model paths for batch decode. */
export function resolveVoiceBatchOfflinePaths(modelsRoot: string, profileId: VoiceProfileId, englishTier: VoiceEnglishBatchTier): VoiceOfflineModelPaths {
	return offlinePathsOf(modelsRoot, batchModel(profileId, englishTier));
}

/** Absolute model paths for a session, given the resolved models root directory. */
export function resolveVoiceSessionModelPaths(modelsRoot: string, profileId: VoiceProfileId): VoiceSessionModelPaths {
	const { streaming, final } = catalog().profiles[profileId];
	const dir = archiveById(streaming.archive).dir;
	const at = (file: string) => join(modelsRoot, dir, file);
	const streamingPaths: VoiceStreamingModelPaths = streaming.kind === 'tone-ctc'
		? { kind: 'tone-ctc', model: at(streaming.model), tokens: at(streaming.tokens) }
		: { kind: 'transducer', encoder: at(streaming.encoder), decoder: at(streaming.decoder), joiner: at(streaming.joiner), tokens: at(streaming.tokens) };
	return { streaming: streamingPaths, ...(final ? { offline: offlinePathsOf(modelsRoot, final) } : {}) };
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
