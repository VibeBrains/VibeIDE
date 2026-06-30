/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';

export interface MemoryEntry {
	timestamp: number;
	sessionId: string;
	type: 'decision' | 'context' | 'error' | 'preference';
	content: string;
	importance: 'high' | 'medium' | 'low';
}

export const IVibeMemoryDecayService = createDecorator<IVibeMemoryDecayService>('vibeMemoryDecayService');

export interface IVibeMemoryDecayService {
	readonly _serviceBrand: undefined;

	/** Add a memory entry from current session */
	addMemory(entry: Omit<MemoryEntry, 'timestamp'>): void;

	/** Get relevant memories for current context */
	getRelevantMemories(query: string, limit?: number): MemoryEntry[];

	/** Persist memories to .vibe/context.md */
	persist(): Promise<void>;

	/** Load memories from .vibe/context.md */
	load(): Promise<void>;
}

/**
 * VibeIDE Memory Decay: Session Brain / Project Brain.
 * Summarizes conversation turns and preserves key decisions.
 * Auto-writes to .vibe/context.md after each session.
 */
class VibeMemoryDecayService extends Disposable implements IVibeMemoryDecayService {
	declare readonly _serviceBrand: undefined;

	private _memories: MemoryEntry[] = [];
	private _sessionId: string;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._sessionId = `session-${Date.now()}`;
		this.load().catch(() => { });
	}

	addMemory(entry: Omit<MemoryEntry, 'timestamp'>): void {
		this._memories.push({ ...entry, timestamp: Date.now() });
		// Keep last 200 memories (decay older ones)
		if (this._memories.length > 200) {
			// Remove low-importance old memories first
			this._memories = this._memories
				.filter((m, i) => m.importance !== 'low' || i > this._memories.length - 100)
				.slice(-200);
		}
		vibeLog.debug('Memory', `Added ${entry.type}: ${entry.content.slice(0, 60)}`);
	}

	getRelevantMemories(query: string, limit: number = 5): MemoryEntry[] {
		const queryTokens = query.toLowerCase().split(/\W+/).filter(t => t.length > 2);
		return this._memories
			.map(m => ({
				memory: m,
				score: queryTokens.filter(t => m.content.toLowerCase().includes(t)).length
					+ (m.importance === 'high' ? 3 : m.importance === 'medium' ? 1 : 0),
			}))
			.filter(r => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(r => r.memory);
	}

	async persist(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const contextUri = joinPath(folders[0].uri, '.vibe', 'context.md');
		const highImportance = this._memories.filter(m => m.importance === 'high');

		const content = [
			`# Project Brain — .vibe/context.md`,
			`<!-- Auto-updated by VibeIDE agent — sessionId: ${this._sessionId} -->`,
			`<!-- Last updated: ${new Date().toISOString()} -->`,
			``,
			`## Key Decisions`,
			...highImportance.filter(m => m.type === 'decision').map(m =>
				`- ${new Date(m.timestamp).toISOString().split('T')[0]}: ${m.content}`
			),
			``,
			`## Context`,
			...highImportance.filter(m => m.type === 'context').map(m =>
				`- ${m.content}`
			),
			``,
			`## Preferences`,
			...highImportance.filter(m => m.type === 'preference').map(m =>
				`- ${m.content}`
			),
		].join('\n');

		try {
			await this._fileService.writeFile(contextUri, VSBuffer.fromString(content));
			vibeLog.info('Memory', 'Persisted to .vibe/context.md');
		} catch (e) {
			vibeLog.warn('Memory', 'Failed to persist:', e);
		}
	}

	async load(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const contextUri = joinPath(folders[0].uri, '.vibe', 'context.md');
		try {
			const content = await this._fileService.readFile(contextUri);
			// Parse existing context.md entries as memories
			const lines = content.value.toString().split('\n');
			let type: MemoryEntry['type'] = 'context';
			for (const line of lines) {
				if (line.startsWith('## Key Decisions')) { type = 'decision'; }
				else if (line.startsWith('## Preferences')) { type = 'preference'; }
				else if (line.startsWith('## ')) { type = 'context'; }
				else if (line.startsWith('- ') && line.length > 4) {
					this._memories.push({
						timestamp: Date.now(),
						sessionId: 'loaded',
						type,
						content: line.slice(2),
						importance: 'high',
					});
				}
			}
			vibeLog.debug('Memory', `Loaded ${this._memories.length} memories from .vibe/context.md`);
		} catch {
			// File doesn't exist yet — OK
		}
	}
}

registerSingleton(IVibeMemoryDecayService, VibeMemoryDecayService, InstantiationType.Delayed);
