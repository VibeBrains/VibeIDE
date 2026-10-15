/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — the catalogue of speech-recognition models as the shared `.vibe` set ships it
 * (`.vibe-defaults/voice/sttModels.jsonc`), read and checked.
 *
 * Addresses, sizes and checksums live in the set, not in constants of each product: a copy of the list drifts
 * silently, and a model whose checksum differs from the archive is not downloaded at all — a person sees
 * «archive damaged» instead of dictation.
 *
 * No imports and only syntax that Node can strip: `scripts/gen-stt-models.ts` reads the file with this very code,
 * so the build and the running IDE judge the catalogue by one set of rules.
 */

/** A zip with one top-level folder `dir`, unpacked into `<models>/<dir>/`. */
export interface SttModelArchive {
	readonly id: string;
	/** Top-level folder the zip unpacks to (the upstream sherpa-onnx name). */
	readonly dir: string;
	readonly url: string;
	/** Checksum of the zip: an archive with another one is not unpacked. */
	readonly sha256: string;
	/** Size of the zip in bytes: the consent to download and the progress are measured in it. */
	readonly sizeBytes: number;
	/** Files inside `dir` without which the archive does not count as installed. */
	readonly files: readonly string[];
	/** Absent when the mirror does not record it and the archive carries no text: a guess is not written here. */
	readonly license?: string;
	readonly source?: string;
}

/** Streaming model: prints a draft while the person speaks. File names are inside the folder of its archive. */
export type SttStreamingModel =
	| { readonly kind: 'tone-ctc'; readonly archive: string; readonly model: string; readonly tokens: string }
	| { readonly kind: 'transducer'; readonly archive: string; readonly encoder: string; readonly decoder: string; readonly joiner: string; readonly tokens: string };

/** Model that decodes a finished phrase again, or a recording as a whole. */
export interface SttOfflineModel {
	readonly kind: 'nemo-ctc';
	readonly archive: string;
	readonly model: string;
	readonly tokens: string;
}

/** What dictation in one language is made of. */
export interface SttProfile {
	readonly streaming: SttStreamingModel;
	readonly final?: SttOfflineModel;
}

export type SttProfileKey = 'ru' | 'en';
export type SttBatchKey = 'ru' | 'en-small' | 'en-medium';

export interface SttModelsCatalog {
	readonly version: 1;
	readonly sampleRate: number;
	readonly archives: readonly SttModelArchive[];
	readonly profiles: Readonly<Record<SttProfileKey, SttProfile>>;
	/** Models for a finished recording (`/watch`): dictation does not need them. */
	readonly batch: Readonly<Record<SttBatchKey, SttOfflineModel>>;
}

export interface ParsedSttModelsCatalog {
	/** Absent when there are problems. */
	readonly catalog?: SttModelsCatalog;
	readonly problems: readonly string[];
}

const PROFILE_KEYS: readonly SttProfileKey[] = ['ru', 'en'];
const BATCH_KEYS: readonly SttBatchKey[] = ['ru', 'en-small', 'en-medium'];
const SHA256 = /^[0-9a-f]{64}$/;

/** Comments and trailing commas out, strings untouched: enough JSONC for a data file of the set. */
export function stripJsonc(text: string): string {
	return text
		.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match: string, quoted: string | undefined) => quoted ?? '')
		.replace(/,(\s*[}\]])/g, '$1');
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads and checks the catalogue. Everything the product relies on is checked here, so a bad edit in the set stops
 * the build instead of showing up as a download that cannot finish: unique archives, a checksum and a size on each,
 * and every model file named by a profile is among the files of the archive it points at.
 */
export function parseSttModelsCatalog(jsonc: string): ParsedSttModelsCatalog {
	let raw: unknown;
	try {
		raw = JSON.parse(stripJsonc(jsonc));
	} catch (error) {
		return { problems: [`does not parse: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!isObject(raw)) {
		return { problems: ['the root is not an object'] };
	}
	const problems: string[] = [];
	if (raw['version'] !== 1) {
		problems.push(`version ${String(raw['version'])} — this code reads version 1`);
	}
	if (typeof raw['sampleRate'] !== 'number' || !(raw['sampleRate'] > 0)) {
		problems.push('sampleRate is not a positive number');
	}

	const archives: SttModelArchive[] = [];
	const ids = new Set<string>();
	const rawArchives = raw['archives'];
	if (!Array.isArray(rawArchives) || rawArchives.length === 0) {
		problems.push('archives: a non-empty list is expected');
	} else {
		rawArchives.forEach((entry: unknown, index: number) => {
			if (!isObject(entry)) {
				problems.push(`archives[${index}]: not an object`);
				return;
			}
			const id = text(entry['id']);
			const where = `archives[${index}]${id ? ` «${id}»` : ''}`;
			const dir = text(entry['dir']);
			const url = text(entry['url']);
			const sha256 = text(entry['sha256']);
			const sizeBytes = entry['sizeBytes'];
			const files = entry['files'];
			// A second archive under a taken id is not kept: the first one is what the references mean
			const taken = id !== undefined && ids.has(id);
			if (!id) { problems.push(`${where}: no id`); }
			else if (taken) { problems.push(`${where}: the id is taken`); }
			else { ids.add(id); }
			if (!dir || dir.includes('/') || dir.includes('\\')) { problems.push(`${where}: dir is a folder name`); }
			if (!url || !url.startsWith('https://')) { problems.push(`${where}: url is not https`); }
			if (!sha256 || !SHA256.test(sha256)) { problems.push(`${where}: sha256 is not 64 lowercase hex digits`); }
			if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0) { problems.push(`${where}: sizeBytes is not a positive integer`); }
			if (!Array.isArray(files) || files.length === 0 || files.some(file => !text(file))) { problems.push(`${where}: files is a non-empty list of names`); }
			if (id && !taken && dir && url && sha256 && typeof sizeBytes === 'number' && Array.isArray(files)) {
				const license = text(entry['license']);
				const source = text(entry['source']);
				archives.push({ id, dir, url, sha256, sizeBytes, files: files.filter((file): file is string => typeof file === 'string'), ...(license ? { license } : {}), ...(source ? { source } : {}) });
			}
		});
	}
	const archiveOf = new Map(archives.map(archive => [archive.id, archive]));

	/** The files of `model` must be named in the archive it points at */
	const checkModel = (where: string, model: Json, fileFields: readonly string[]): boolean => {
		const archive = text(model['archive']) ? archiveOf.get(model['archive'] as string) : undefined;
		if (!archive) {
			problems.push(`${where}: archive «${String(model['archive'])}» is not in archives`);
			return false;
		}
		let ok = true;
		for (const field of fileFields) {
			const file = text(model[field]);
			if (!file || !archive.files.includes(file)) {
				problems.push(`${where}: ${field} «${String(model[field])}» is not among the files of «${archive.id}»`);
				ok = false;
			}
		}
		return ok;
	};
	const offlineOf = (where: string, value: unknown): SttOfflineModel | undefined => {
		if (!isObject(value) || value['kind'] !== 'nemo-ctc') {
			problems.push(`${where}: kind «nemo-ctc» is expected`);
			return undefined;
		}
		return checkModel(where, value, ['model', 'tokens']) ? value as unknown as SttOfflineModel : undefined;
	};

	const profiles: Partial<Record<SttProfileKey, SttProfile>> = {};
	const rawProfiles = raw['profiles'];
	for (const key of PROFILE_KEYS) {
		const entry = isObject(rawProfiles) ? rawProfiles[key] : undefined;
		const where = `profiles.${key}`;
		if (!isObject(entry) || !isObject(entry['streaming'])) {
			problems.push(`${where}: a profile with a streaming model is expected`);
			continue;
		}
		const streaming = entry['streaming'];
		const streamingOk = streaming['kind'] === 'tone-ctc'
			? checkModel(`${where}.streaming`, streaming, ['model', 'tokens'])
			: streaming['kind'] === 'transducer'
				? checkModel(`${where}.streaming`, streaming, ['encoder', 'decoder', 'joiner', 'tokens'])
				: (problems.push(`${where}.streaming: kind «tone-ctc» or «transducer» is expected`), false);
		const final = entry['final'] === undefined ? undefined : offlineOf(`${where}.final`, entry['final']);
		if (streamingOk && (entry['final'] === undefined || final)) {
			profiles[key] = { streaming: streaming as unknown as SttStreamingModel, ...(final ? { final } : {}) };
		}
	}

	const batch: Partial<Record<SttBatchKey, SttOfflineModel>> = {};
	const rawBatch = raw['batch'];
	for (const key of BATCH_KEYS) {
		const model = offlineOf(`batch.${key}`, isObject(rawBatch) ? rawBatch[key] : undefined);
		if (model) {
			batch[key] = model;
		}
	}

	if (problems.length > 0) {
		return { problems };
	}
	return {
		catalog: {
			version: 1,
			sampleRate: raw['sampleRate'] as number,
			archives,
			profiles: profiles as Record<SttProfileKey, SttProfile>,
			batch: batch as Record<SttBatchKey, SttOfflineModel>,
		},
		problems: [],
	};
}
