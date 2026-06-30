/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';

export const IMemoriesService = createDecorator<IMemoriesService>('memoriesService');

export interface MemoryEntry {
	/** Unique identifier for this memory */
	id: string;
	/** Type of memory: decision, preference, recentFile, or context */
	type: 'decision' | 'preference' | 'recentFile' | 'context';
	/** Key (for decisions/preferences) or file path (for recentFile) */
	key: string;
	/** Value or description */
	value: string;
	/** Timestamp when memory was created/updated */
	timestamp: number;
	/** Optional tags for relevance matching */
	tags?: string[];
	/** Optional file URI for recentFile type */
	uri?: string;
}

export interface ProjectMemories {
	/** Decisions made in this project (key-value pairs) */
	decisions: Map<string, MemoryEntry>;
	/** User preferences for this project (key-value pairs) */
	preferences: Map<string, MemoryEntry>;
	/** Recently accessed files (with timestamps) */
	recentFiles: MemoryEntry[];
	/** Project context notes */
	context: MemoryEntry[];
	/** Last updated timestamp */
	lastUpdated: number;
}

export interface RelevantMemory {
	entry: MemoryEntry;
	relevanceScore: number;
	reason: string;
}

export interface IMemoriesService {
	readonly _serviceBrand: undefined;

	/**
	 * Add or update a memory entry
	 */
	addMemory(type: MemoryEntry['type'], key: string, value: string, tags?: string[], uri?: URI): Promise<void>;

	/**
	 * Get all memories for current project
	 */
	getAllMemories(): Promise<ProjectMemories>;

	/**
	 * Get relevant memories for a query (with relevance scoring)
	 */
	getRelevantMemories(query: string, maxResults?: number): Promise<RelevantMemory[]>;

	/**
	 * Clear all memories for current project
	 */
	clearMemories(): Promise<void>;

	/**
	 * Remove a specific memory by ID
	 */
	removeMemory(id: string): Promise<void>;

	/**
	 * Check if memories are enabled
	 */
	isEnabled(): boolean;
}

/**
 * Maximum size for memories storage per project (50KB)
 */
const MAX_MEMORIES_SIZE_BYTES = 50 * 1024;

/**
 * Maximum number of recent files to keep
 */
const MAX_RECENT_FILES = 50;

/**
 * Maximum number of context entries
 */
const MAX_CONTEXT_ENTRIES = 20;

class MemoriesService extends Disposable implements IMemoriesService {
	declare readonly _serviceBrand: undefined;

	private readonly storageKey = 'vibeide.memories';
	private _memories: ProjectMemories | undefined;
	private _loadPromise: Promise<ProjectMemories> | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
	) {
		super();
	}

	isEnabled(): boolean {
		// Check if memories are enabled in settings (default: true)
		const globalSettings = this.settingsService.state.globalSettings;
		return globalSettings.enableMemories !== false; // Default to true if not set
	}

	private async _loadMemories(): Promise<ProjectMemories> {
		if (this._memories) {
			return this._memories;
		}

		if (this._loadPromise) {
			return this._loadPromise;
		}

		this._loadPromise = (async () => {
			if (!this.isEnabled()) {
				return this._getEmptyMemories();
			}

			const workspace = this.workspaceContextService.getWorkspace();
			if (!workspace.id) {
				return this._getEmptyMemories();
			}

			try {
				const stored = this.storageService.get(this.storageKey, StorageScope.WORKSPACE, '');
				if (!stored) {
					this._memories = this._getEmptyMemories();
					return this._memories;
				}

				const parsed = JSON.parse(stored);
				// Deserialize Maps from JSON
				this._memories = {
					decisions: new Map(parsed.decisions || []),
					preferences: new Map(parsed.preferences || []),
					recentFiles: parsed.recentFiles || [],
					context: parsed.context || [],
					lastUpdated: parsed.lastUpdated || Date.now(),
				};

				// Validate and clean up memories
				this._enforceSizeLimits();
				return this._memories;
			} catch (error) {
				vibeLog.warn('memories', '[MemoriesService] Failed to load memories:', error);
				this._memories = this._getEmptyMemories();
				return this._memories;
			}
		})();

		const result = await this._loadPromise;
		this._loadPromise = undefined;
		return result;
	}

	private _getEmptyMemories(): ProjectMemories {
		return {
			decisions: new Map(),
			preferences: new Map(),
			recentFiles: [],
			context: [],
			lastUpdated: Date.now(),
		};
	}

	private async _saveMemories(): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		const workspace = this.workspaceContextService.getWorkspace();
		if (!workspace.id) {
			return;
		}

		if (!this._memories) {
			return;
		}

		try {
			// Enforce size limits before saving
			this._enforceSizeLimits();

			// Serialize Maps to arrays for JSON
			const serializable = {
				decisions: Array.from(this._memories.decisions.entries()),
				preferences: Array.from(this._memories.preferences.entries()),
				recentFiles: this._memories.recentFiles,
				context: this._memories.context,
				lastUpdated: this._memories.lastUpdated,
			};

			const serialized = JSON.stringify(serializable);
			const sizeBytes = new Blob([serialized]).size;

			// If still too large after cleanup, remove oldest entries
			if (sizeBytes > MAX_MEMORIES_SIZE_BYTES) {
				this._compressMemories();
			}

			// Re-serialize after compression
			const finalSerializable = {
				decisions: Array.from(this._memories.decisions.entries()),
				preferences: Array.from(this._memories.preferences.entries()),
				recentFiles: this._memories.recentFiles,
				context: this._memories.context,
				lastUpdated: this._memories.lastUpdated,
			};

			this.storageService.store(
				this.storageKey,
				JSON.stringify(finalSerializable),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (error) {
			vibeLog.warn('memories', '[MemoriesService] Failed to save memories:', error);
		}
	}

	private _enforceSizeLimits(): void {
		if (!this._memories) { return; }

		// Limit recent files (keep most recent)
		if (this._memories.recentFiles.length > MAX_RECENT_FILES) {
			this._memories.recentFiles.sort((a, b) => b.timestamp - a.timestamp);
			this._memories.recentFiles = this._memories.recentFiles.slice(0, MAX_RECENT_FILES);
		}

		// Limit context entries (keep most recent)
		if (this._memories.context.length > MAX_CONTEXT_ENTRIES) {
			this._memories.context.sort((a, b) => b.timestamp - a.timestamp);
			this._memories.context = this._memories.context.slice(0, MAX_CONTEXT_ENTRIES);
		}
	}

	private _compressMemories(): void {
		if (!this._memories) { return; }

		// Remove oldest context entries first
		if (this._memories.context.length > MAX_CONTEXT_ENTRIES / 2) {
			this._memories.context.sort((a, b) => b.timestamp - a.timestamp);
			this._memories.context = this._memories.context.slice(0, Math.floor(MAX_CONTEXT_ENTRIES / 2));
		}

		// Remove oldest recent files
		if (this._memories.recentFiles.length > MAX_RECENT_FILES / 2) {
			this._memories.recentFiles.sort((a, b) => b.timestamp - a.timestamp);
			this._memories.recentFiles = this._memories.recentFiles.slice(0, Math.floor(MAX_RECENT_FILES / 2));
		}

		// Remove oldest decisions (keep most important ones - those with tags are more important)
		const decisionsArray = Array.from(this._memories.decisions.entries());
		if (decisionsArray.length > 20) {
			decisionsArray.sort((a, b) => {
				const aHasTags = (a[1].tags?.length || 0) > 0;
				const bHasTags = (b[1].tags?.length || 0) > 0;
				if (aHasTags !== bHasTags) {
					return aHasTags ? -1 : 1; // Tagged entries first
				}
				return b[1].timestamp - a[1].timestamp; // Then by recency
			});
			this._memories.decisions = new Map(decisionsArray.slice(0, 20));
		}

		// Remove oldest preferences
		const preferencesArray = Array.from(this._memories.preferences.entries());
		if (preferencesArray.length > 20) {
			preferencesArray.sort((a, b) => b[1].timestamp - a[1].timestamp);
			this._memories.preferences = new Map(preferencesArray.slice(0, 20));
		}
	}

	async addMemory(
		type: MemoryEntry['type'],
		key: string,
		value: string,
		tags?: string[],
		uri?: URI
	): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		const memories = await this._loadMemories();
		const id = `${type}:${key}:${Date.now()}`;
		const entry: MemoryEntry = {
			id,
			type,
			key,
			value,
			timestamp: Date.now(),
			tags,
			uri: uri?.toString(),
		};

		switch (type) {
			case 'decision':
				memories.decisions.set(key, entry);
				break;
			case 'preference':
				memories.preferences.set(key, entry);
				break;
			case 'recentFile':
				// Remove existing entry if present (update)
				memories.recentFiles = memories.recentFiles.filter(e => e.key !== key);
				// Add to front (most recent)
				memories.recentFiles.unshift(entry);
				break;
			case 'context':
				memories.context.unshift(entry);
				break;
		}

		memories.lastUpdated = Date.now();
		await this._saveMemories();
	}

	async getAllMemories(): Promise<ProjectMemories> {
		if (!this.isEnabled()) {
			return this._getEmptyMemories();
		}
		return await this._loadMemories();
	}

	async getRelevantMemories(query: string, maxResults: number = 10): Promise<RelevantMemory[]> {
		if (!this.isEnabled()) {
			return [];
		}

		const memories = await this._loadMemories();
		const queryLower = query.toLowerCase();
		const queryTokens = new Set(queryLower.split(/\s+/).filter(Boolean));

		const scored: RelevantMemory[] = [];

		// Score decisions (high priority)
		for (const entry of memories.decisions.values()) {
			const score = this._scoreRelevance(entry, queryLower, queryTokens);
			if (score > 0) {
				scored.push({
					entry,
					relevanceScore: score * 1.5, // Boost decisions
					reason: 'decision',
				});
			}
		}

		// Score preferences (medium priority)
		for (const entry of memories.preferences.values()) {
			const score = this._scoreRelevance(entry, queryLower, queryTokens);
			if (score > 0) {
				scored.push({
					entry,
					relevanceScore: score * 1.2, // Boost preferences
					reason: 'preference',
				});
			}
		}

		// Score recent files (lower priority, but recency matters)
		for (const entry of memories.recentFiles) {
			const score = this._scoreRelevance(entry, queryLower, queryTokens);
			if (score > 0) {
				// Add recency boost (files accessed in last 24h get boost)
				const ageHours = (Date.now() - entry.timestamp) / (1000 * 60 * 60);
				const recencyBoost = ageHours < 24 ? 1.3 : ageHours < 168 ? 1.1 : 1.0;
				scored.push({
					entry,
					relevanceScore: score * recencyBoost,
					reason: 'recent file',
				});
			}
		}

		// Score context entries
		for (const entry of memories.context) {
			const score = this._scoreRelevance(entry, queryLower, queryTokens);
			if (score > 0) {
				scored.push({
					entry,
					relevanceScore: score,
					reason: 'context',
				});
			}
		}

		// Sort by relevance score and return top results
		scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
		return scored.slice(0, maxResults);
	}

	private _scoreRelevance(entry: MemoryEntry, queryLower: string, queryTokens: Set<string>): number {
		let score = 0;

		// Exact key match (highest score)
		if (entry.key.toLowerCase().includes(queryLower)) {
			score += 10;
		}

		// Value contains query
		if (entry.value.toLowerCase().includes(queryLower)) {
			score += 5;
		}

		// Token overlap in key
		const keyTokens = new Set(entry.key.toLowerCase().split(/\s+/).filter(Boolean));
		let tokenMatches = 0;
		for (const token of queryTokens) {
			if (keyTokens.has(token)) {
				tokenMatches++;
			}
		}
		score += tokenMatches * 2;

		// Token overlap in value
		const valueTokens = new Set(entry.value.toLowerCase().split(/\s+/).filter(Boolean));
		tokenMatches = 0;
		for (const token of queryTokens) {
			if (valueTokens.has(token)) {
				tokenMatches++;
			}
		}
		score += tokenMatches;

		// Tag matches (boost)
		if (entry.tags) {
			for (const tag of entry.tags) {
				if (queryLower.includes(tag.toLowerCase()) || tag.toLowerCase().includes(queryLower)) {
					score += 3;
				}
			}
		}

		// Recency boost (more recent = slightly higher score)
		const ageDays = (Date.now() - entry.timestamp) / (1000 * 60 * 60 * 24);
		const recencyFactor = Math.max(0.5, 1.0 - ageDays / 30); // Decay over 30 days
		score *= recencyFactor;

		return score;
	}

	async clearMemories(): Promise<void> {
		this._memories = this._getEmptyMemories();
		await this._saveMemories();
	}

	async removeMemory(id: string): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		const memories = await this._loadMemories();

		// Remove from decisions
		for (const [key, entry] of memories.decisions.entries()) {
			if (entry.id === id) {
				memories.decisions.delete(key);
				break;
			}
		}

		// Remove from preferences
		for (const [key, entry] of memories.preferences.entries()) {
			if (entry.id === id) {
				memories.preferences.delete(key);
				break;
			}
		}

		// Remove from recent files
		memories.recentFiles = memories.recentFiles.filter(e => e.id !== id);

		// Remove from context
		memories.context = memories.context.filter(e => e.id !== id);

		await this._saveMemories();
	}
}

registerSingleton(IMemoriesService, MemoriesService, InstantiationType.Delayed);

