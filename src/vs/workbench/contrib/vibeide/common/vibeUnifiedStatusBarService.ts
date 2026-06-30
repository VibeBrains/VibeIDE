/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Unified VibeIDE status-bar registry (roadmap §K.1 L896).
 *
 * Consuming contributions call `registerRow({ id, label, tooltip, severity, counter? })`
 * and dispose the returned handle when done. The `VibeUnifiedStatusBarContribution`
 * in browser/ subscribes to `onDidChange` and re-renders the single `$(vibeide-logo) VibeIDE`
 * status-bar entry via `buildUnifiedStatusBarSnapshot`.
 *
 * Pure aggregation logic lives in `common/statusBarRowAggregator.ts`.
 */

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { StatusRowDescriptor, UnifiedStatusBarSnapshot, buildUnifiedStatusBarSnapshot } from './statusBarRowAggregator.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.statusBar.unifiedOnly': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.statusBar.unifiedOnly', 'Свернуть VibeIDE-индикаторы в одну запись status-bar c popup-меню вместо набора отдельных entries. Уменьшает захламление; функциональность доступна через popup (клик → quick-pick). По умолчанию выключено.'),
		},
	},
});

export { StatusRowDescriptor, UnifiedStatusBarSnapshot };

export interface IVibeUnifiedStatusBarService {
	readonly _serviceBrand: undefined;

	/** Register a status row. Dispose the returned handle to remove it. */
	registerRow(descriptor: StatusRowDescriptor): IDisposable;

	/** Update fields of an existing row by id. No-op if the id is not registered. */
	updateRow(id: string, patch: Partial<Omit<StatusRowDescriptor, 'id'>>): void;

	/** Current aggregated snapshot. */
	getSnapshot(): UnifiedStatusBarSnapshot;

	/** Fired when any row is added, removed, or updated. */
	readonly onDidChange: Event<void>;
}

export const IVibeUnifiedStatusBarService = createDecorator<IVibeUnifiedStatusBarService>('vibeUnifiedStatusBarService');

class VibeUnifiedStatusBarService extends Disposable implements IVibeUnifiedStatusBarService {
	declare readonly _serviceBrand: undefined;

	private readonly _rows = new Map<string, StatusRowDescriptor>();
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	registerRow(descriptor: StatusRowDescriptor): IDisposable {
		this._rows.set(descriptor.id, descriptor);
		this._onDidChange.fire();
		return toDisposable(() => {
			if (this._rows.has(descriptor.id)) {
				this._rows.delete(descriptor.id);
				this._onDidChange.fire();
			}
		});
	}

	updateRow(id: string, patch: Partial<Omit<StatusRowDescriptor, 'id'>>): void {
		const existing = this._rows.get(id);
		if (!existing) {
			return;
		}
		this._rows.set(id, { ...existing, ...patch });
		this._onDidChange.fire();
	}

	getSnapshot(): UnifiedStatusBarSnapshot {
		return buildUnifiedStatusBarSnapshot([...this._rows.values()]);
	}
}

registerSingleton(IVibeUnifiedStatusBarService, VibeUnifiedStatusBarService, InstantiationType.Delayed);
