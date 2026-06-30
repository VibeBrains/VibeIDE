/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Phase-1 bag-of-hashes embedding (256-dim, L2-normalized). Same algorithm for codebase RAG and local plan similarity.
 */
export function vibeSimpleTextEmbedding(text: string): number[] {
	const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
	const vector = new Array(256).fill(0);
	for (const token of tokens) {
		let hash = 5381;
		for (let i = 0; i < token.length; i++) {
			hash = ((hash << 5) + hash) + token.charCodeAt(i);
			hash |= 0;
		}
		const idx = Math.abs(hash) % 256;
		vector[idx] += 1;
	}
	const mag = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
	return mag > 0 ? vector.map(v => v / mag) : vector;
}

export function vibeCosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) {
		return 0;
	}
	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
	}
	return dot;
}
