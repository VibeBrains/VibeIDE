/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { deriveConfidenceColor } from './editRiskConfidenceMap.js';
export type DiffConfidence = 'green' | 'yellow' | 'red';
export type DiffAction = 'apply' | 'reject' | 'edit';

export interface DiffChunk {
	id: string;
	filePath: string;
	originalLines: string[];
	newLines: string[];
	lineStart: number;
	confidence: DiffConfidence;
	annotation?: string; // One-sentence agent rationale
	isBinary?: boolean;
	complexityRisk?: 'low' | 'medium' | 'high';
}

export interface DiffPreview {
	id: string;
	chunks: DiffChunk[];
	totalFiles: number;
	totalInsertions: number;
	totalDeletions: number;
	complexityIndicator: {
		filesChanged: number;
		hasCriticalZones: boolean; // auth, db, config
		criticalFiles: string[];
	};
	agentRationale?: string; // Overall rationale for the entire diff
}

export const IVibeDiffPreviewService = createDecorator<IVibeDiffPreviewService>('vibeDiffPreviewService');

export interface IVibeDiffPreviewService {
	readonly _serviceBrand: undefined;

	/** Create a diff preview before applying */
	createPreview(changes: Array<{ filePath: string; originalContent: string; newContent: string }>): DiffPreview;

	/** Calculate confidence score for a diff chunk */
	calculateConfidence(chunk: Pick<DiffChunk, 'filePath' | 'originalLines' | 'newLines'>): DiffConfidence;

	/** Check if file is a critical zone (auth, db, config) */
	isCriticalZone(filePath: string): boolean;

	/** Get complexity indicator for the full diff */
	getComplexityIndicator(preview: DiffPreview): string;
}

const CRITICAL_PATTERNS = [
	/auth/i, /password/i, /credential/i, /secret/i, /token/i,
	/migration/i, /schema/i, /database/i, /\.sql$/i,
	/config/i, /settings/i, /env/i, /\.env/,
	/security/i, /crypto/i, /encrypt/i, /decrypt/i,
	/permission/i, /role/i, /access/i,
];

// Keywords that trigger 🔴 confidence
const RED_KEYWORDS = [
	'password', 'secret', 'token', 'api_key', 'auth', 'credential',
	'delete from', 'drop table', 'truncate', 'rm -rf', 'sudo',
	'eval(', 'exec(', '__import__',
];

/**
 * VibeIDE Diff Preview Service.
 * Generates structured diff with confidence scores, annotations, complexity indicator.
 * Powers: Diff preview panel, Apply/Reject/Edit workflow.
 */
class VibeDiffPreviewService extends Disposable implements IVibeDiffPreviewService {
	declare readonly _serviceBrand: undefined;

	createPreview(changes: Array<{ filePath: string; originalContent: string; newContent: string }>): DiffPreview {
		const chunks: DiffChunk[] = [];
		let totalInsertions = 0;
		let totalDeletions = 0;
		const criticalFiles: string[] = [];

		for (const change of changes) {
			const isBinary = this._isBinaryFile(change.filePath);
			const originalLines = change.originalContent.split('\n');
			const newLines = change.newContent.split('\n');

			const chunk: DiffChunk = {
				id: `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				filePath: change.filePath,
				originalLines,
				newLines,
				lineStart: 1,
				confidence: isBinary ? 'red' : this.calculateConfidence({ filePath: change.filePath, originalLines, newLines }),
				isBinary,
				complexityRisk: this.isCriticalZone(change.filePath) ? 'high' : 'low',
			};

			chunks.push(chunk);
			totalInsertions += newLines.length;
			totalDeletions += originalLines.length;
			if (this.isCriticalZone(change.filePath)) { criticalFiles.push(change.filePath); }
		}

		return {
			id: `preview-${Date.now()}`,
			chunks,
			totalFiles: changes.length,
			totalInsertions,
			totalDeletions,
			complexityIndicator: {
				filesChanged: changes.length,
				hasCriticalZones: criticalFiles.length > 0,
				criticalFiles,
			},
		};
	}

	calculateConfidence(chunk: Pick<DiffChunk, 'filePath' | 'originalLines' | 'newLines'>): DiffConfidence {
		// Adopt pure helper `deriveConfidenceColor` (roadmap §989) — single
		// source of truth across diff preview, edit-risk scoring, and the
		// LLM-as-judge pipeline. Decision order: heuristic flags > risk score
		// > judge advisory; judge cannot upgrade to green.
		const allNewContent = chunk.newLines.join('\n').toLowerCase();
		const filePath = chunk.filePath.toLowerCase();

		const heuristicFlags: Array<'auth' | 'password' | 'delete' | 'crypto' | 'env'> = [];
		if (RED_KEYWORDS.some(k => allNewContent.includes(k))) {
			if (/auth|credential/.test(allNewContent)) { heuristicFlags.push('auth'); }
			if (/password|secret|token|api_key/.test(allNewContent)) { heuristicFlags.push('password'); }
			if (/delete from|drop table|truncate|rm -rf/.test(allNewContent)) { heuristicFlags.push('delete'); }
			if (/eval\(|exec\(|__import__/.test(allNewContent)) { heuristicFlags.push('crypto'); }
			if (heuristicFlags.length === 0) { heuristicFlags.push('auth'); } // fallback if regex sliced differently
		}
		if (this.isCriticalZone(filePath)) {
			if (/auth|secret|password|credential|token|access/.test(filePath)) { heuristicFlags.push('auth'); }
			else if (/env/.test(filePath)) { heuristicFlags.push('env'); }
			else if (/crypto|encrypt|decrypt|security/.test(filePath)) { heuristicFlags.push('crypto'); }
		}

		const deletionRatio = chunk.originalLines.length > 0
			? (chunk.originalLines.length - chunk.newLines.length) / chunk.originalLines.length
			: 0;
		const sizeFactor = chunk.originalLines.length > 50 || chunk.newLines.length > 50 ? 0.5 : 0.2;
		const riskScore = deletionRatio > 0.7 ? Math.min(0.95, 0.85 + deletionRatio * 0.1) : sizeFactor;

		return deriveConfidenceColor({ riskScore, heuristicFlags });
	}

	isCriticalZone(filePath: string): boolean {
		return CRITICAL_PATTERNS.some(p => p.test(filePath));
	}

	getComplexityIndicator(preview: DiffPreview): string {
		const { filesChanged, hasCriticalZones, criticalFiles } = preview.complexityIndicator;
		const parts = [`${filesChanged} file(s) changed`];
		if (hasCriticalZones) {
			parts.push(`⚠️ Critical zones: ${criticalFiles.slice(0, 3).join(', ')}`);
		}
		const redChunks = preview.chunks.filter(c => c.confidence === 'red').length;
		if (redChunks > 0) {
			parts.push(`🔴 ${redChunks} high-risk chunk(s)`);
		}
		return parts.join(' | ');
	}

	private _isBinaryFile(filePath: string): boolean {
		return /\.(png|jpg|jpeg|gif|webp|ico|svg|ttf|woff|woff2|eot|pdf|zip|tar|gz|bin|exe|dll|so|dylib)$/i.test(filePath);
	}
}

registerSingleton(IVibeDiffPreviewService, VibeDiffPreviewService, InstantiationType.Eager);
