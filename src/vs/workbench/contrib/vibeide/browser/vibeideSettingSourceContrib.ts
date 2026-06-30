/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeIDE Settings Source Location Contribution
 *
 * Wires `settingSourceLocation.ts` pure helpers into the workbench:
 *  1. `VibeSettingSourceRegistry` — static in-process registry where callers
 *     stamp a setting key with its source file + line (called at
 *     `registerConfiguration` time from vibeide config modules).
 *  2. `vibeide.settings.goToSource` command — given a setting key, resolves
 *     its stamp via `buildGoToTarget` and opens the file in the editor with
 *     `IEditorService.openEditor` at the stamped line.
 *
 * (roadmap §L512 — IEditorService.openEditor runtime hookup + stamp injection)
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	SettingMetadataStamp,
	buildGoToTarget,
	buildSettingMetadataStamp,
	indexStampsBySettingKey,
	resolveSettingSource,
} from '../common/settingSourceLocation.js';

// ── Static registry ────────────────────────────────────────────────────────────

/**
 * In-process registry for vibeide setting source stamps.
 * Call `VibeSettingSourceRegistry.stamp(...)` from any module that registers
 * vibeide configuration, ideally immediately after `registerConfiguration`.
 */
class VibeSettingSourceRegistryImpl {
	private readonly _stamps: SettingMetadataStamp[] = [];
	private _index: ReadonlyMap<string, SettingMetadataStamp> | undefined;

	/** Register a source stamp for one setting key. */
	stamp(params: { settingKey: string; filePath: string; lineNumber: number; localizeKey: string }): void {
		const result = buildSettingMetadataStamp(params);
		if (!result.ok) { return; } // silently ignore malformed stamps in production
		this._stamps.push(result.value);
		this._index = undefined; // invalidate cached index
	}

	/** Resolve the source location for a setting key. Returns `null` if unstamped. */
	resolve(settingKey: string): import('../common/settingSourceLocation.js').SourceLocation | null {
		if (!this._index) {
			const r = indexStampsBySettingKey(this._stamps);
			this._index = r.ok ? r.value : new Map();
		}
		return resolveSettingSource(settingKey, this._index);
	}

	/** Exposed for tests. */
	get size(): number { return this._stamps.length; }
}

export const VibeSettingSourceRegistry = new VibeSettingSourceRegistryImpl();

// ── Command ────────────────────────────────────────────────────────────────────

registerAction2(class GoToSettingSource extends Action2 {
	constructor() {
		super({
			id: 'vibeide.settings.goToSource',
			title: { value: 'VibeIDE: Go to Setting Source', original: 'VibeIDE: Go to Setting Source' },
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, settingKey: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const log = accessor.get(ILogService);

		const loc = VibeSettingSourceRegistry.resolve(settingKey);
		if (!loc) {
			log.warn(`[VibeSettingSource] No stamp found for setting key: ${settingKey}`);
			return;
		}

		const target = buildGoToTarget(loc);
		const filePath = target.filePath;

		await editorService.openEditor({
			resource: URI.file(filePath),
			options: {
				selection: {
					startLineNumber: target.startLine0 + 1,
					startColumn: target.startCol0 + 1,
					endLineNumber: target.endLine0 + 1,
					endColumn: target.endCol0 + 1,
				},
				revealIfOpened: true,
				pinned: false,
			},
		});

		log.trace(`[VibeSettingSource] Opened ${filePath}:${target.startLine0 + 1} for setting=${settingKey}`);
	}
});
