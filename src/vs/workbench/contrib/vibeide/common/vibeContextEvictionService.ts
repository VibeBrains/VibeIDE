/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface ContextItem {
	id: string;
	filePath?: string;
	symbolName?: string;
	tokenCount: number;
	isPinned: boolean;
	source: 'smart-picker' | 'manual' | 'pinned' | 'explicit-mention';
}

export const IVibeContextEvictionService = createDecorator<IVibeContextEvictionService>('vibeContextEvictionService');

export interface IVibeContextEvictionService {
	readonly _serviceBrand: undefined;

	/** Track a context item */
	addItem(item: ContextItem): void;

	/** Remove an item from context (user-initiated) */
	evict(itemId: string): void;

	/** Get all current context items */
	getItems(): ContextItem[];

	/** Get total token count */
	getTotalTokens(): number;

	/** Auto-compress: summarize oldest non-pinned items when approaching limit */
	autoCompress(targetTokens: number): { evicted: ContextItem[]; saved: number };

	readonly onContextChanged: Event<void>;
}

/**
 * VibeIDE Context Eviction Control.
 * 'Remove from context' button per file in Context Window Visualizer.
 * Auto-compression when approaching limit.
 */
class VibeContextEvictionService extends Disposable implements IVibeContextEvictionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onContextChanged = this._register(new Emitter<void>());
	readonly onContextChanged = this._onContextChanged.event;

	private _items = new Map<string, ContextItem>();

	constructor(
	) {
		super();
	}

	addItem(item: ContextItem): void {
		this._items.set(item.id, item);
		this._onContextChanged.fire();
	}

	evict(itemId: string): void {
		const item = this._items.get(itemId);
		if (item && !item.isPinned) {
			this._items.delete(itemId);
			vibeLog.debug('ContextEviction', `Evicted: ${item.filePath || item.symbolName}`);
			this._onContextChanged.fire();
		} else if (item?.isPinned) {
			vibeLog.warn('ContextEviction', `Cannot evict pinned item: ${item.filePath}`);
		}
	}

	getItems(): ContextItem[] {
		return Array.from(this._items.values());
	}

	getTotalTokens(): number {
		return Array.from(this._items.values()).reduce((s, i) => s + i.tokenCount, 0);
	}

	autoCompress(targetTokens: number): { evicted: ContextItem[]; saved: number } {
		const current = this.getTotalTokens();
		if (current <= targetTokens) { return { evicted: [], saved: 0 }; }

		// Evict oldest, smallest, non-pinned items first
		const evictable = Array.from(this._items.values())
			.filter(i => !i.isPinned && i.source !== 'explicit-mention')
			.sort((a, b) => a.tokenCount - b.tokenCount);

		const evicted: ContextItem[] = [];
		let saved = 0;

		for (const item of evictable) {
			if (current - saved <= targetTokens) { break; }
			this._items.delete(item.id);
			evicted.push(item);
			saved += item.tokenCount;
		}

		if (evicted.length > 0) {
			vibeLog.info('ContextEviction', `Auto-compressed: evicted ${evicted.length} items, saved ${saved} tokens`);
			this._onContextChanged.fire();
		}

		return { evicted, saved };
	}
}

registerSingleton(IVibeContextEvictionService, VibeContextEvictionService, InstantiationType.Eager);
