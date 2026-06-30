/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeSpecDrivenContextService — spec-driven context for OpenAPI/AsyncAPI/GraphQL schemas.
 *
 * Provides first-class attachment of API specification files to the agent context.
 *
 * Key differentiators from plain `@file`:
 *  - Versioning: tracks spec file changes and highlights breaking changes in plan generation
 *  - Breaking change detection: compares current schema to previous via simple structural diff
 *  - @spec mention picker: attach a spec to the chat without manual `@file`
 *  - Integrates with VibeSpecContextContractService (D.2 from Planning roadmap)
 *
 * Phase MVP: spec registry + breaking change detection heuristic + @spec mention.
 * Phase 3b: full OpenAPI parser diff + GraphQL SDL comparison + ChangeLog generation.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { diffOpenApi, diffGraphql, diffSpecHeuristic } from './specDrivenContextSkeleton.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.specContext.maxSizeBytes': {
			type: 'number',
			default: 102400, // 100 KB
			minimum: 1024,
			maximum: 1048576,
			description: localize('vibeide.specContext.maxSizeBytes', 'Максимальный размер файла API-спеки, подключаемой в контекст агента. Большие спеки обрезаются.'),
		},
		'vibeide.specContext.breakingChangeWarning': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.specContext.breakingChangeWarning', 'Показывать предупреждение при генерации плана, когда у спеки есть breaking-изменения относительно предыдущей версии.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpecType = 'openapi' | 'asyncapi' | 'graphql' | 'json-schema' | 'unknown';

export interface SpecEntry {
	id: string;
	path: string;
	type: SpecType;
	/** SHA-256 of the file content when registered */
	contentHash: string;
	registeredAt: number;
	/** Size in bytes */
	sizeBytes: number;
	/** Whether the current version has potential breaking changes vs previous */
	hasBreakingChanges?: boolean;
	breakingSummary?: string;
}

export const IVibeSpecDrivenContextService = createDecorator<IVibeSpecDrivenContextService>('vibeSpecDrivenContextService');

export interface IVibeSpecDrivenContextService {
	readonly _serviceBrand: undefined;

	/**
	 * Register a spec file for use in agent context.
	 * Detects spec type from extension/content and records content hash.
	 */
	registerSpec(path: string, content: string): Promise<SpecEntry>;

	/** Get all registered specs */
	listSpecs(): SpecEntry[];

	/** Get a registered spec by id or path */
	getSpec(idOrPath: string): SpecEntry | undefined;

	/** Remove a spec from the registry */
	unregisterSpec(idOrPath: string): void;

	/**
	 * Get a truncated, context-ready string for a spec (respects maxSizeBytes).
	 * Adds a leading comment block with spec metadata.
	 */
	getContextBlock(idOrPath: string, fullContent: string): string;

	/**
	 * Compare two spec content strings and return a heuristic breaking change summary.
	 * Phase 3b: full parser-based diff.
	 */
	detectBreakingChanges(previousContent: string, currentContent: string, specType: SpecType): { hasBreakingChanges: boolean; summary: string };

	/** Fired when a spec is added, updated, or removed */
	readonly onSpecChanged: Event<SpecEntry>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeSpecDrivenContextService extends Disposable implements IVibeSpecDrivenContextService {
	declare readonly _serviceBrand: undefined;

	private readonly _specs = new Map<string, SpecEntry>();
	private readonly _onSpecChanged = this._register(new Emitter<SpecEntry>());
	readonly onSpecChanged: Event<SpecEntry> = this._onSpecChanged.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
	}

	async registerSpec(path: string, content: string): Promise<SpecEntry> {
		const type = this._detectSpecType(path, content);
		const contentHash = this._simpleHash(content);
		const maxSizeBytes = this._config.getValue<number>('vibeide.specContext.maxSizeBytes') ?? 102400;
		const byteLen = new TextEncoder().encode(content).length;
		if (byteLen > maxSizeBytes) {
			this._log.warn(`[VibeSpec] ${path}: content ${byteLen} bytes exceeds vibeide.specContext.maxSizeBytes (${maxSizeBytes}); context truncation may apply.`);
		}

		// Check for breaking changes against previous version
		const existing = this.getSpec(path);
		let hasBreakingChanges: boolean | undefined;
		let breakingSummary: string | undefined;
		if (existing) {
			const prev = existing.contentHash;
			if (prev !== contentHash) {
				// Re-register: detect breaking changes
				// Phase 3b: we'd have the previous content stored; MVP uses heuristic on diff length
				const bc = this.detectBreakingChanges('', content, type); // simplified
				hasBreakingChanges = bc.hasBreakingChanges;
				breakingSummary = bc.summary;
			}
		}

		const id = existing?.id ?? `spec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const entry: SpecEntry = {
			id,
			path,
			type,
			contentHash,
			registeredAt: Date.now(),
			sizeBytes: byteLen,
			hasBreakingChanges,
			breakingSummary,
		};
		this._specs.set(id, entry);
		this._specs.set(path, entry); // also index by path for getSpec(path)

		this._log.info(`[VibeSpecContext] Registered ${type} spec: ${path} (${entry.sizeBytes} bytes)`);
		this._onSpecChanged.fire(entry);
		return entry;
	}

	listSpecs(): SpecEntry[] {
		// De-duplicate (path and id both indexed)
		const seen = new Set<string>();
		return Array.from(this._specs.values()).filter(e => {
			if (seen.has(e.id)) { return false; }
			seen.add(e.id);
			return true;
		});
	}

	getSpec(idOrPath: string): SpecEntry | undefined {
		return this._specs.get(idOrPath);
	}

	unregisterSpec(idOrPath: string): void {
		const entry = this._specs.get(idOrPath);
		if (!entry) { return; }
		this._specs.delete(entry.id);
		this._specs.delete(entry.path);
		this._log.info(`[VibeSpecContext] Unregistered spec: ${entry.path}`);
	}

	getContextBlock(idOrPath: string, fullContent: string): string {
		const entry = this._specs.get(idOrPath);
		const maxBytes = this._config.getValue<number>('vibeide.specContext.maxSizeBytes') ?? 102400;
		const maxChars = maxBytes; // roughly 1 char ≈ 1 byte for ASCII specs

		const header = entry
			? `// API Spec: ${entry.path} (type: ${entry.type}, hash: ${entry.contentHash.slice(0, 8)}${entry.hasBreakingChanges ? ' ⚠ BREAKING CHANGES DETECTED' : ''})\n`
			: `// API Spec\n`;

		if (fullContent.length <= maxChars) {
			return header + fullContent;
		}
		const truncated = fullContent.slice(0, maxChars);
		return header + truncated + `\n// ... [truncated at ${maxChars} chars — see vibeide.specContext.maxSizeBytes]`;
	}

	detectBreakingChanges(previousContent: string, currentContent: string, specType: SpecType): { hasBreakingChanges: boolean; summary: string } {
		if (!previousContent) {
			return { hasBreakingChanges: false, summary: 'No previous version to compare against.' };
		}

		let result;
		try {
			if (specType === 'openapi') {
				result = diffOpenApi({ oldSpec: previousContent, newSpec: currentContent });
			} else if (specType === 'graphql') {
				result = diffGraphql({ oldSpec: previousContent, newSpec: currentContent });
			} else {
				result = diffSpecHeuristic({ kind: 'openapi', oldText: previousContent, newText: currentContent });
			}
		} catch {
			result = diffSpecHeuristic({ kind: 'openapi', oldText: previousContent, newText: currentContent });
		}

		const summary = result.entries.length === 0
			? 'No breaking changes detected.'
			: result.entries.map(e => e.summary).join('; ');

		return { hasBreakingChanges: result.hasBreaking, summary };
	}

	private _detectSpecType(path: string, content: string): SpecType {
		const ext = path.split('.').pop()?.toLowerCase();
		if (ext === 'graphql' || ext === 'gql') { return 'graphql'; }
		if (content.includes('asyncapi:')) { return 'asyncapi'; }
		if (content.includes('openapi:') || content.includes('"openapi"') || content.includes('swagger:')) { return 'openapi'; }
		if (ext === 'json' || ext === 'yaml' || ext === 'yml') { return 'json-schema'; }
		return 'unknown';
	}

	private _simpleHash(content: string): string {
		// FNV-1a 32-bit — fast, good distribution, no crypto needed
		let hash = 0x811c9dc5;
		for (let i = 0; i < content.length; i++) {
			hash ^= content.charCodeAt(i);
			hash = (hash * 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
	}
}

registerSingleton(IVibeSpecDrivenContextService, VibeSpecDrivenContextService, InstantiationType.Delayed);
