/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The progress stream of an Ollama model download read line by line — pure
 *
 * The download is streamed: without it Ollama sends no headers until the model is on disk,
 * and a fetch in Node gives up waiting for headers after five minutes — a slow line never finishes
 */

export interface PullProgress {
	/** Bytes on disk of all layers seen so far */
	readonly completed: number;
	/** Bytes of all layers seen so far */
	readonly total: number;
	readonly done: boolean;
	readonly error?: string;
}

/** What the main process reports to the window while a model downloads */
export type PullProgressEvent = PullProgress & { readonly model: string };

/**
 * Folds one line of the stream into the progress so far
 *
 * Each layer reports its own `digest`, `total` and `completed`; the sum over layers is what the person waits for
 */
export function foldPullLine(layers: Map<string, { completed: number; total: number }>, line: string): PullProgress | undefined {
	const trimmed = line.trim();
	if (!trimmed) {
		return undefined;
	}
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof record['error'] === 'string') {
		return { ...sum(layers), done: true, error: record['error'] };
	}
	const digest = record['digest'];
	const total = record['total'];
	if (typeof digest === 'string' && typeof total === 'number') {
		const completed = typeof record['completed'] === 'number' ? record['completed'] : 0;
		layers.set(digest, { completed, total });
	}
	return { ...sum(layers), done: record['status'] === 'success' };
}

function sum(layers: Map<string, { completed: number; total: number }>): { completed: number; total: number } {
	let completed = 0;
	let total = 0;
	for (const layer of layers.values()) {
		completed += layer.completed;
		total += layer.total;
	}
	return { completed, total };
}
