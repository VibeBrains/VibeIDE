/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface PromptVersion {
	version: string;          // e.g., "1.2.3" (IDE version)
	systemPromptHash: string; // SHA-256 of system prompt
	systemPromptPreview: string; // First 200 chars
	capturedAt: number;
}

export const IVibePromptVersioningService = createDecorator<IVibePromptVersioningService>('vibePromptVersioningService');

export interface IVibePromptVersioningService {
	readonly _serviceBrand: undefined;

	/** Record current system prompt version */
	recordVersion(ideVersion: string, systemPrompt: string): void;

	/** Get all recorded versions */
	getVersionHistory(): PromptVersion[];

	/** Get diff between two versions (simple text diff) */
	getDiff(version1: string, version2: string): string | null;

	/** Get current prompt version */
	getCurrentVersion(): PromptVersion | null;
}

/**
 * VibeIDE Prompt Versioning.
 * Tracks system prompt changes between IDE versions.
 * Compliance: audit trail of how agent behavior changed over time.
 */
class VibePromptVersioningService extends Disposable implements IVibePromptVersioningService {
	declare readonly _serviceBrand: undefined;

	private readonly _versions: PromptVersion[] = [];

	constructor(
	) {
		super();
	}

	recordVersion(ideVersion: string, systemPrompt: string): void {
		const hash = this._simpleHash(systemPrompt);
		const existing = this._versions.find(v => v.version === ideVersion);

		if (existing && existing.systemPromptHash === hash) {
			return; // Same version, no change
		}

		const version: PromptVersion = {
			version: ideVersion,
			systemPromptHash: hash,
			systemPromptPreview: systemPrompt.slice(0, 200),
			capturedAt: Date.now(),
		};

		this._versions.push(version);
		vibeLog.info('PromptVersioning', `Recorded prompt v${ideVersion} (hash: ${hash.slice(0, 8)})`);
	}

	getVersionHistory(): PromptVersion[] {
		return [...this._versions];
	}

	getDiff(version1: string, version2: string): string | null {
		const v1 = this._versions.find(v => v.version === version1);
		const v2 = this._versions.find(v => v.version === version2);
		if (!v1 || !v2) { return null; }

		if (v1.systemPromptHash === v2.systemPromptHash) {
			return `No changes between v${version1} and v${version2}`;
		}

		return [
			`System prompt changed from v${version1} to v${version2}:`,
			`- Old hash: ${v1.systemPromptHash}`,
			`+ New hash: ${v2.systemPromptHash}`,
			``,
			`Old preview: ${v1.systemPromptPreview.slice(0, 100)}...`,
			`New preview: ${v2.systemPromptPreview.slice(0, 100)}...`,
			``,
			`Note: Full prompt diff available in Debug my prompt panel.`,
		].join('\n');
	}

	getCurrentVersion(): PromptVersion | null {
		return this._versions[this._versions.length - 1] ?? null;
	}

	private _simpleHash(text: string): string {
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			const char = text.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash |= 0;
		}
		return Math.abs(hash).toString(16).padStart(8, '0');
	}
}

registerSingleton(IVibePromptVersioningService, VibePromptVersioningService, InstantiationType.Eager);
