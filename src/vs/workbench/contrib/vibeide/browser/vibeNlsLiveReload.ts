/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeNlsLiveReload — dev-only watcher that hot-reloads VibeIDE NLS bundles
 * when their on-disk JSON changes. Wires `IFileService.watch` to the pure
 * `decideNlsLiveReload` helper (common/nlsLiveReloadHash.ts) so the rest of
 * the UI can subscribe to either reload-keys (selective subtree remount) or
 * full-reload events.
 *
 * Production builds skip the registration entirely — see
 * `isDevEnvironment()` below.
 *
 * (roadmap §L513 — IFileService.watch + bootstrap-esm hook).
 */

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService, FileChangesEvent, FileChangeType } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { language as platformLanguage } from '../../../../base/common/platform.js';
import {
	decideNlsLiveReload,
	buildNlsBundleSnapshot,
	fnv1a32,
	type NlsBundleSnapshot,
	type NlsReloadVerdict,
} from '../common/nlsLiveReloadHash.js';

export const IVibeNlsLiveReloadService = createDecorator<IVibeNlsLiveReloadService>('vibeNlsLiveReloadService');

export interface IVibeNlsLiveReloadService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeBundle: Event<NlsReloadVerdict>;
	/** Last verdict produced by the watcher (or `null` until the first event). */
	readonly lastVerdict: NlsReloadVerdict | null;
}

class VibeNlsLiveReloadService extends Disposable implements IVibeNlsLiveReloadService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeBundle = this._register(new Emitter<NlsReloadVerdict>());
	readonly onDidChangeBundle = this._onDidChangeBundle.event;

	private readonly _watcher = this._register(new MutableDisposable());
	private _snapshot: NlsBundleSnapshot | null = null;
	private _verdict: NlsReloadVerdict | null = null;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
	) {
		super();
		if (!isDevEnvironment(environmentService)) {
			this._log.trace('[VibeNlsLiveReload] Skipping watcher: not a dev environment.');
			return;
		}
		this._installWatcher();
	}

	get lastVerdict(): NlsReloadVerdict | null { return this._verdict; }

	private _installWatcher(): void {
		const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : null;
		if (!cwd) { return; }
		const localeTag = normaliseLocale(platformLanguage);
		const uri = URI.joinPath(URI.file(cwd), 'out', `vibeide.nls.${localeTag}.json`);

		// Eagerly read the initial snapshot so the very first change has a baseline.
		this._refreshSnapshot(uri, localeTag).catch(err => {
			this._log.trace(`[VibeNlsLiveReload] Initial snapshot failed (likely missing bundle): ${err && err.message}`);
		});

		const watcher = this._fileService.watch(uri);
		this._watcher.value = this._register(this._fileService.onDidFilesChange((e: FileChangesEvent) => {
			if (!e.contains(uri, FileChangeType.UPDATED, FileChangeType.ADDED)) { return; }
			this._refreshSnapshot(uri, localeTag).catch(err => {
				this._log.warn(`[VibeNlsLiveReload] Refresh failed: ${err && err.message}`);
			});
		}));
		// Attach watcher disposable so unloading the service clears the file watch.
		this._register(watcher);
		this._log.info(`[VibeNlsLiveReload] Watching ${uri.toString()}`);
	}

	private async _refreshSnapshot(uri: URI, localeTag: string): Promise<void> {
		let raw: Record<string, string>;
		try {
			const file = await this._fileService.readFile(uri);
			raw = JSON.parse(file.value.toString());
		} catch (err) {
			this._log.trace(`[VibeNlsLiveReload] Could not read bundle: ${err && (err as Error).message}`);
			return;
		}
		const entries = new Map<string, string>();
		for (const k of Object.keys(raw)) {
			const v = raw[k];
			if (typeof v === 'string') { entries.set(k, v); }
		}
		const next = buildNlsBundleSnapshot(localeTag, entries, fnv1a32);
		const verdict = decideNlsLiveReload({ previous: this._snapshot, current: next });
		this._snapshot = next;
		this._verdict = verdict;
		if (verdict.kind !== 'no-op') {
			this._log.info(`[VibeNlsLiveReload] Verdict: ${verdict.kind}`);
			this._onDidChangeBundle.fire(verdict);
		}
	}
}

function normaliseLocale(s: string): string {
	return s.trim().toLowerCase().replace(/_/g, '-');
}

function isDevEnvironment(env: IEnvironmentService): boolean {
	// IEnvironmentService.isBuilt is `true` in production; dev-mode workbench
	// has it `false`. The VIBEIDE_NLS_HMR env var force-enables for explicit
	// opt-in (e.g. running a packaged build with translators reviewing live).
	try {
		const force = typeof process !== 'undefined' && process.env && process.env.VIBEIDE_NLS_HMR === '1';
		if (force) { return true; }
	} catch { /* ignore */ }
	return env && env.isBuilt === false;
}

registerSingleton(IVibeNlsLiveReloadService, VibeNlsLiveReloadService, InstantiationType.Delayed);
