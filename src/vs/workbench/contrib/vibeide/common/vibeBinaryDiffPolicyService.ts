/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeBinaryDiffPolicyService — policy for binary/non-text files in diff preview.
 *
 * Prevents the diff UI from trying to display binary content as text, which breaks
 * rendering and can leak garbage bytes. Integrates with:
 *  - VibeDiffPreviewService (diff confidence, chunk preview)
 *  - Large file policy (>200KB warning in read_file)
 *  - imageQA vision pipeline (images shown as thumbnails, not raw bytes)
 *
 * Behaviour:
 *  - BINARY files: show "⊘ Binary file — N bytes (extension)" label; no content shown
 *  - LARGE text files (≥ sizeLimitBytes): show first `previewLines` lines + truncation notice
 *  - IMAGE files: pass through to vision pipeline if imageQA enabled; else binary treatment
 *  - VIDEO/AUDIO: always binary treatment (no vision pipeline)
 *
 * Configuration keys: vibeide.diffPreview.binaryPolicy.*
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.diffPreview.binaryPolicy.sizeLimitBytes': {
			type: 'number',
			default: 204800, // 200 KB (matches Large file policy)
			minimum: 10240,
			maximum: 10485760,
			description: localize('vibeide.diffPreview.binaryPolicy.sizeLimitBytes', 'Файлы больше указанного размера (в байтах) отображаются обрезанными в diff preview. Бинарные файлы показываются как плейсхолдер независимо от этой настройки.'),
		},
		'vibeide.diffPreview.binaryPolicy.previewLines': {
			type: 'number',
			default: 100,
			minimum: 10,
			maximum: 1000,
			description: localize('vibeide.diffPreview.binaryPolicy.previewLines', 'Сколько строк показывать из больших текстовых файлов в diff preview перед уведомлением об обрезке.'),
		},
		'vibeide.diffPreview.binaryPolicy.imageVisionPassthrough': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.diffPreview.binaryPolicy.imageVisionPassthrough', 'Разрешить передачу изображений в vision-пайплайн (imageQA) в diff preview вместо обработки как сырого бинарника.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type BinaryDiffTreatment = 'text' | 'truncated_text' | 'binary_omit' | 'image_vision';

export interface BinaryDiffDecision {
	treatment: BinaryDiffTreatment;
	/** Human-readable label to show in place of / alongside content */
	label: string;
	/** True if the caller should NOT try to render raw content */
	omitContent: boolean;
}

// Known binary/non-text extensions — not exhaustive; byte-sniffing is the primary method.
const BINARY_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tga',
	'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv',
	'mp3', 'ogg', 'wav', 'flac', 'aac', 'm4a',
	'pdf', 'docx', 'xlsx', 'pptx', 'odt',
	'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
	'exe', 'dll', 'so', 'dylib', 'bin', 'wasm',
	'ttf', 'otf', 'woff', 'woff2',
	'sqlite', 'db',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'svg']);

export const IVibeBinaryDiffPolicyService = createDecorator<IVibeBinaryDiffPolicyService>('vibeBinaryDiffPolicyService');

export interface IVibeBinaryDiffPolicyService {
	readonly _serviceBrand: undefined;

	/**
	 * Decide how to handle a file in diff preview.
	 * @param path File path (used for extension heuristic)
	 * @param sizeBytes File size in bytes
	 * @param firstBytes Optional first 512 bytes of file content (for byte-sniffing)
	 */
	decideForFile(path: string, sizeBytes: number, firstBytes?: Uint8Array): BinaryDiffDecision;

	/**
	 * Truncate text content to the configured preview limit.
	 * Returns the truncated content + a notice line.
	 */
	truncateForPreview(content: string): { truncated: string; notice: string; wasTruncated: boolean };

	/** Whether the binary diff policy considers a file binary by extension */
	isBinaryExtension(path: string): boolean;
}

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeBinaryDiffPolicyService extends Disposable implements IVibeBinaryDiffPolicyService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
	}

	isBinaryExtension(path: string): boolean {
		const ext = this._ext(path);
		return BINARY_EXTENSIONS.has(ext);
	}

	decideForFile(path: string, sizeBytes: number, firstBytes?: Uint8Array): BinaryDiffDecision {
		const ext = this._ext(path);
		const sizeLimitBytes = this._config.getValue<number>('vibeide.diffPreview.binaryPolicy.sizeLimitBytes') ?? 204800;
		const visionPassthrough = this._config.getValue<boolean>('vibeide.diffPreview.binaryPolicy.imageVisionPassthrough') ?? true;

		// Byte-sniff: if first bytes contain null bytes → binary
		const hasBinaryBytes = firstBytes ? this._hasBinaryBytes(firstBytes) : false;

		if (IMAGE_EXTENSIONS.has(ext)) {
			if (visionPassthrough) {
				return { treatment: 'image_vision', label: localize('vibeide.binaryDiff.label.imageVision', "🖼 Image ({0})", this._fmtSize(sizeBytes)), omitContent: false };
			}
			return { treatment: 'binary_omit', label: localize('vibeide.binaryDiff.label.imageOmit', "⊘ Image file — {0} (.{1})", this._fmtSize(sizeBytes), ext), omitContent: true };
		}

		if (BINARY_EXTENSIONS.has(ext) || hasBinaryBytes) {
			return { treatment: 'binary_omit', label: localize('vibeide.binaryDiff.label.binaryOmit', "⊘ Binary file — {0} (.{1})", this._fmtSize(sizeBytes), ext || 'bin'), omitContent: true };
		}

		if (sizeBytes > sizeLimitBytes) {
			return {
				treatment: 'truncated_text',
				label: localize('vibeide.binaryDiff.label.largeFile', "⚠ Large file ({0}) — showing first lines only", this._fmtSize(sizeBytes)),
				omitContent: false,
			};
		}

		return { treatment: 'text', label: '', omitContent: false };
	}

	truncateForPreview(content: string): { truncated: string; notice: string; wasTruncated: boolean } {
		const previewLines = this._config.getValue<number>('vibeide.diffPreview.binaryPolicy.previewLines') ?? 100;
		const lines = content.split('\n');
		if (lines.length <= previewLines) {
			return { truncated: content, notice: '', wasTruncated: false };
		}
		const truncated = lines.slice(0, previewLines).join('\n');
		const notice = `\n// ... ${lines.length - previewLines} more lines not shown (Large file policy) ...`;
		return { truncated, notice, wasTruncated: true };
	}

	private _ext(path: string): string {
		const dot = path.lastIndexOf('.');
		return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
	}

	private _hasBinaryBytes(bytes: Uint8Array): boolean {
		// Detect null bytes in the first 512 bytes — strong binary indicator
		const limit = Math.min(bytes.length, 512);
		for (let i = 0; i < limit; i++) {
			if (bytes[i] === 0) { return true; }
		}
		return false;
	}

	private _fmtSize(bytes: number): string {
		if (bytes < 1024) { return `${bytes} B`; }
		if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
}

registerSingleton(IVibeBinaryDiffPolicyService, VibeBinaryDiffPolicyService, InstantiationType.Delayed);
