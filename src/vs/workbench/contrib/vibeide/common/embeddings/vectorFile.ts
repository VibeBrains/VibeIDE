/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Vectors of the repo index: their size, their identity and their file on disk — pure, no I/O
 *
 * A project of ten thousand files is some sixty thousand fragments: 768 numbers each, kept in the index's JSON,
 * Would cost hundreds of megabytes on disk and in memory. So a vector is cut to `EMBEDDING_DIMS` — both default models
 * are trained so that the head of a vector is a vector of its own (Matryoshka) — and kept as Float32 in a binary file
 */

/** Numbers kept per vector */
export const EMBEDDING_DIMS = 256;
/** Fragments of one file that get a vector: enough to find the file, without the long tail of a huge one */
export const MAX_EMBEDDED_CHUNKS_PER_FILE = 8;

/** The head of a vector, scaled back to unit length so cosine stays a dot product */
export function truncateVector(vector: readonly number[], dims: number = EMBEDDING_DIMS): Float32Array {
	const out = new Float32Array(Math.min(dims, vector.length));
	let norm = 0;
	for (let i = 0; i < out.length; i++) {
		out[i] = vector[i];
		norm += vector[i] * vector[i];
	}
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < out.length; i++) {
			out[i] /= norm;
		}
	}
	return out;
}

/** Cosine of two unit vectors of equal length; 0 when they cannot be compared */
export function unitCosine(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length || a.length === 0) {
		return 0;
	}
	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
	}
	return dot;
}

/**
 * What the vectors of a file were made from: a cheap fingerprint of the texts, so a changed file is re-embedded
 * And an unchanged one is not — the index replaces entries on every save
 */
export function textsStamp(texts: readonly string[]): string {
	let hash = 0x811c9dc5;
	for (const text of texts) {
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		hash ^= 0x1f;
		hash = Math.imul(hash, 0x01000193);
	}
	return `${texts.length}:${(hash >>> 0).toString(16)}`;
}

export interface FileVectors {
	readonly stamp: string;
	/** One per embedded fragment, in fragment order */
	readonly vectors: readonly Float32Array[];
}

export interface VectorFile {
	/** The model that made every vector here; a file of another model is thrown away whole */
	readonly modelId: string;
	readonly dims: number;
	readonly files: ReadonlyMap<string, FileVectors>;
}

const MAGIC = 'VIBEVEC1';

/** Layout: magic, header length, JSON header (model, dims, per file: path, stamp, count), then every vector as Float32 */
export function encodeVectorFile(file: VectorFile): Uint8Array {
	const entries = [...file.files.entries()];
	const header = new TextEncoder().encode(JSON.stringify({
		modelId: file.modelId,
		dims: file.dims,
		files: entries.map(([path, vectors]) => [path, vectors.stamp, vectors.vectors.length]),
	}));
	const vectorCount = entries.reduce((sum, [, vectors]) => sum + vectors.vectors.length, 0);
	const headerStart = MAGIC.length + 4;
	// Float32 data must start on a multiple of 4 bytes
	const dataStart = Math.ceil((headerStart + header.length) / 4) * 4;
	const out = new Uint8Array(dataStart + vectorCount * file.dims * 4);
	out.set(new TextEncoder().encode(MAGIC), 0);
	new DataView(out.buffer).setUint32(MAGIC.length, header.length, true);
	out.set(header, headerStart);
	const data = new Float32Array(out.buffer, dataStart, vectorCount * file.dims);
	let offset = 0;
	for (const [, vectors] of entries) {
		for (const vector of vectors.vectors) {
			data.set(vector.subarray(0, file.dims), offset);
			offset += file.dims;
		}
	}
	return out;
}

/** The file back, or undefined for anything that is not one — a broken file means re-embedding, not a crash */
export function decodeVectorFile(bytes: Uint8Array): VectorFile | undefined {
	try {
		if (new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
			return undefined;
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const headerLength = view.getUint32(MAGIC.length, true);
		const headerStart = MAGIC.length + 4;
		const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength))) as {
			modelId: string; dims: number; files: Array<[string, string, number]>;
		};
		const dataStart = Math.ceil((headerStart + headerLength) / 4) * 4;
		const vectorCount = header.files.reduce((sum, [, , count]) => sum + count, 0);
		if (bytes.byteLength < dataStart + vectorCount * header.dims * 4) {
			return undefined;
		}
		// Copied out of the read buffer: a view into it would keep the whole file alive and break on an unaligned offset
		const data = new Float32Array(bytes.slice(dataStart, dataStart + vectorCount * header.dims * 4).buffer);
		const files = new Map<string, FileVectors>();
		let offset = 0;
		for (const [path, stamp, count] of header.files) {
			const vectors: Float32Array[] = [];
			for (let i = 0; i < count; i++) {
				vectors.push(data.slice(offset, offset + header.dims));
				offset += header.dims;
			}
			files.set(path, { stamp, vectors });
		}
		return { modelId: header.modelId, dims: header.dims, files };
	} catch {
		return undefined;
	}
}
