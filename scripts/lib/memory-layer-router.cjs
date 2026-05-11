/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CJS port of `common/memoryLayerRouter.ts` for `vibe doctor --memory`.

'use strict';

const SHORT_TERM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Route a memory write to the correct layer.
 * @param {{ key: string, layer?: string, hasWorkspaceContext: boolean, ttlMs?: number }} input
 * @param {number} now
 */
function routeMemoryWrite(input, now) {
	if (input.layer === 'explicit') {
		return { layer: 'explicit', reason: 'caller-specified' };
	}
	if (input.hasWorkspaceContext && (input.ttlMs === undefined || input.ttlMs > SHORT_TERM_TTL_MS)) {
		return { layer: 'long-term', reason: 'workspace-scoped-durable' };
	}
	if (!input.hasWorkspaceContext) {
		return { layer: 'explicit', reason: 'no-workspace-context' };
	}
	return { layer: 'short-term', reason: 'short-ttl-requested' };
}

/**
 * Audit memory records for cross-layer invariant violations.
 * @param {Array<{key: string, layer: string, hasWorkspaceContext?: boolean}>} records
 * @returns {Array<{kind: string, key: string, detail: string}>}
 */
function auditMemoryLayers(records) {
	const warnings = [];
	const keyLayerMap = new Map();

	for (const record of records) {
		const { key, layer } = record;
		if (!key || !layer) continue;

		if (keyLayerMap.has(key)) {
			const existingLayer = keyLayerMap.get(key);
			if (existingLayer !== layer) {
				warnings.push({ kind: 'duplicate-across-layers', key, detail: `found in ${existingLayer} and ${layer}` });
			}
		} else {
			keyLayerMap.set(key, layer);
		}

		if (layer === 'long-term' && record.hasWorkspaceContext === false) {
			warnings.push({ kind: 'long-term-without-workspace', key, detail: 'long-term entry lacks workspace context' });
		}
		if (layer === 'short-term' && record.hasWorkspaceContext === true) {
			warnings.push({ kind: 'short-term-with-workspace', key, detail: 'short-term entry has workspace context (should be long-term)' });
		}
	}
	return warnings;
}

module.exports = { routeMemoryWrite, auditMemoryLayers, SHORT_TERM_TTL_MS };
