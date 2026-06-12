/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reads & resolves `.vibe/providers.json` into a runtime view: which providers are DEFINED
 * (new openai-compatible ids), which PATCH a built-in (same id), and which EXTEND a built-in
 * (new id based on a built-in). `extends` against another FILE entry is fully merged here; the
 * built-in base for `extends`/override is applied downstream at transport/catalog wiring (2b).
 *
 * Heavily logged on purpose (see vibeLog 'DynProviders'): every load reports the file path,
 * parse outcome (+reason), counts, each resolution, and all non-fatal warnings — so a broken file
 * is diagnosable from the log AND from the «VibeIDE: Показать распознанные провайдеры» command.
 */

import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { providerNames } from '../common/vibeideSettingsTypes.js';
import { IVibeideSettingsService, VibeProviderActiveOverrides, ModelOption, DynProviderTransportConfig } from '../common/vibeideSettingsService.js';
import { setDynamicProviderModelCaps, VibeideStaticModelInfo } from '../common/modelCapabilities.js';
import { parseProvidersFile, mergeProviderEntry, VibeProviderEntry, VibeProviderModelEntry } from '../common/vibeProvidersFile.js';

const TOOL_FORMAT_MAP: Record<string, 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined> = {
	openai: 'openai-style', anthropic: 'anthropic-style', gemini: 'gemini-style', none: undefined,
};
const SYS_MSG_MAP: Record<string, 'system-role' | 'developer-role' | 'separated'> = {
	system: 'system-role', developer: 'developer-role', separated: 'separated',
};

/** Map a `.vibe/providers.json` model entry to VibeIDE's internal capability shape (Phase 1 fields;
 *  reasoning/FIM left to defaults for now). */
function modelEntryToCaps(m: VibeProviderModelEntry): Partial<VibeideStaticModelInfo> {
	const c: Record<string, unknown> = {};
	if (typeof m.contextWindow === 'number') { c.contextWindow = m.contextWindow; }
	if (typeof m.maxOutputTokens === 'number') { c.reservedOutputTokenSpace = m.maxOutputTokens; }
	if (m.toolFormat) { c.specialToolFormat = TOOL_FORMAT_MAP[m.toolFormat]; }
	if (typeof m.vision === 'boolean') { c.supportsVision = m.vision; }
	if (m.systemMessage === false) { c.supportsSystemMessage = false; }
	else if (m.systemMessage) { c.supportsSystemMessage = SYS_MSG_MAP[m.systemMessage]; }
	if (m.cost) {
		c.cost = {
			input: m.cost.input ?? 0, output: m.cost.output ?? 0,
			...(m.cost.cacheRead !== undefined ? { cache_read: m.cost.cacheRead } : {}),
			...(m.cost.cacheWrite !== undefined ? { cache_write: m.cost.cacheWrite } : {}),
		};
	}
	return c as Partial<VibeideStaticModelInfo>;
}

/** How a file entry relates to the built-in provider set. */
export type ResolvedProviderKind =
	| 'definition'        // brand-new provider (id not a built-in, no extends-of-built-in)
	| 'override'          // patches a built-in (id matches a built-in)
	| 'extends-builtin';  // new provider cloned from a built-in (extends: <built-in id>)

export interface ResolvedProviderEntry {
	readonly id: string;
	readonly kind: ResolvedProviderKind;
	/** For `extends-builtin`: the built-in id the base is cloned from (merged downstream). */
	readonly extendsBuiltin?: string;
	/** The entry with any FILE-entry `extends` already merged in. */
	readonly entry: VibeProviderEntry;
}

export interface VibeDynamicProvidersState {
	readonly fileExists: boolean;
	/** Top-level parse failure reason (e.g. bad JSON). `undefined` when the file parsed (or is absent). */
	readonly parseError?: string;
	readonly providers: readonly ResolvedProviderEntry[];
	readonly warnings: readonly string[];
}

export const IVibeDynamicProvidersService = createDecorator<IVibeDynamicProvidersService>('vibeDynamicProvidersService');

export interface IVibeDynamicProvidersService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Current resolved snapshot (synchronous; refreshed on file changes + workspace switch). */
	getState(): VibeDynamicProvidersState;
	/** Force a re-read from disk. */
	reload(): Promise<void>;
}

const EMPTY_STATE: VibeDynamicProvidersState = { fileExists: false, providers: [], warnings: [] };

class VibeDynamicProvidersService extends Disposable implements IVibeDynamicProvidersService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _state: VibeDynamicProvidersState = EMPTY_STATE;
	private readonly _builtinIds: ReadonlySet<string> = new Set<string>(providerNames as readonly string[]);

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
	) {
		super();
		void this.reload();
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => { void this.reload(); }));
		this._register(this._fileService.onDidFilesChange(e => {
			const uri = this._fileUri();
			if (uri && e.affects(uri)) {
				vibeLog.debug('DynProviders', 'providers.json changed on disk — reloading');
				void this.reload();
			}
		}));
	}

	getState(): VibeDynamicProvidersState {
		return this._state;
	}

	private _fileUri(): URI | undefined {
		const folder = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.vibe', 'providers.json') : undefined;
	}

	async reload(): Promise<void> {
		const uri = this._fileUri();
		if (!uri) {
			vibeLog.debug('DynProviders', 'no workspace folder — no providers.json');
			this._setState(EMPTY_STATE);
			return;
		}

		let raw: string | undefined;
		try {
			const buf = await this._fileService.readFile(uri);
			raw = buf.value.toString();
		} catch {
			vibeLog.debug('DynProviders', `no providers.json at ${uri.fsPath}`);
			this._setState(EMPTY_STATE);
			return;
		}

		const parsed = parseProvidersFile(raw);
		if (!parsed.ok) {
			vibeLog.warn('DynProviders', `providers.json parse failed: ${parsed.error}`);
			this._setState({ fileExists: true, parseError: parsed.error, providers: [], warnings: [`Файл не распознан: ${parsed.error}`] });
			return;
		}

		const { providers, warnings } = this._resolve(parsed.providers, [...parsed.warnings]);
		vibeLog.warn('DynProviders', `providers.json loaded: ${providers.length} provider(s), ${warnings.length} warning(s)`);
		for (const p of providers) {
			vibeLog.debug('DynProviders', `  • ${p.id} [${p.kind}${p.extendsBuiltin ? `:${p.extendsBuiltin}` : ''}] active=${p.entry.active !== false}`);
		}
		for (const w of warnings) { vibeLog.warn('DynProviders', `  ⚠ ${w}`); }
		this._setState({ fileExists: true, providers, warnings });
	}

	private _resolve(entries: readonly VibeProviderEntry[], warnings: string[]): { providers: ResolvedProviderEntry[]; warnings: string[] } {
		const byId = new Map<string, VibeProviderEntry>(entries.map(e => [e.id, e]));

		// Resolve a FILE-entry `extends` chain (built-in extends is deferred to downstream wiring).
		const resolveFileExtends = (entry: VibeProviderEntry, stack: Set<string>): VibeProviderEntry => {
			const ext = entry.extends;
			if (!ext || this._builtinIds.has(ext)) { return entry; }
			if (stack.has(entry.id)) { warnings.push(`Циклический extends на «${entry.id}» — оставлен как есть`); return entry; }
			const base = byId.get(ext);
			if (!base) { warnings.push(`extends: «${ext}» у «${entry.id}» не найден (ни built-in, ни в файле)`); const { extends: _drop, ...rest } = entry; return rest as VibeProviderEntry; }
			stack.add(entry.id);
			const resolvedBase = resolveFileExtends(base, stack);
			stack.delete(entry.id);
			return mergeProviderEntry(resolvedBase, entry);
		};

		const providers: ResolvedProviderEntry[] = entries.map(entry => {
			const resolved = resolveFileExtends(entry, new Set<string>());
			let kind: ResolvedProviderKind;
			let extendsBuiltin: string | undefined;
			if (entry.extends && this._builtinIds.has(entry.extends)) {
				kind = 'extends-builtin';
				extendsBuiltin = entry.extends;
			} else if (this._builtinIds.has(entry.id)) {
				kind = 'override';
			} else {
				kind = 'definition';
				if (!resolved.baseURL && !resolved.extends) {
					warnings.push(`«${entry.id}»: новый провайдер без baseURL — он не сможет отправлять запросы`);
				}
			}
			return { id: entry.id, kind, extendsBuiltin, entry: resolved };
		});

		return { providers, warnings };
	}

	private _setState(state: VibeDynamicProvidersState): void {
		this._state = state;
		this._applyOverridesToSettings(state.providers);
		this._onDidChange.fire();
	}

	/**
	 * Push the built-in disable-toggles to the settings service so the model picker hides them.
	 * Only `override` entries (id matches a built-in) affect built-in lists; `active:false` on the
	 * provider disables it whole, otherwise each model with `active:false` is hidden.
	 */
	private _applyOverridesToSettings(providers: readonly ResolvedProviderEntry[]): void {
		const disabledProviders = new Set<string>();
		const disabledModels = new Map<string, ReadonlySet<string>>();
		const dynamicModelOptions: ModelOption[] = [];
		const capsMap = new Map<string, Map<string, Partial<VibeideStaticModelInfo>>>();
		const transportConfigs: Record<string, DynProviderTransportConfig> = {};
		for (const p of providers) {
			if (p.kind === 'override') {
				// Patch of a built-in: active:false disables it; otherwise hide its active:false models.
				if (p.entry.active === false) { disabledProviders.add(p.id); continue; }
				const off = (p.entry.models?.static ?? []).filter(m => m.active === false).map(m => m.id);
				if (off.length > 0) { disabledModels.set(p.id, new Set(off)); }
				continue;
			}
			// definition / extends-builtin: a NEW selectable provider. Phase 1 contributes its static
			// models (catalog auto-fetch for dynamic providers is a follow-up). providerName = file id.
			if (p.entry.active === false) { continue; }
			const label = p.entry.name || p.id;
			const modelCaps = new Map<string, Partial<VibeideStaticModelInfo>>();
			for (const m of (p.entry.models?.static ?? [])) {
				if (m.active === false) { continue; }
				dynamicModelOptions.push({ name: `${m.name || m.id} (${label})`, selection: { providerName: p.id as any, modelName: m.id } });
				modelCaps.set(m.id, modelEntryToCaps(m));
			}
			if (modelCaps.size > 0) { capsMap.set(p.id, modelCaps); }

			// Transport: only providers with an explicit baseURL are routable. extends-builtin without a
			// baseURL inherits the built-in endpoint downstream — a follow-up; skip routing for now.
			if (p.entry.baseURL) {
				// apiKeyRef resolves here (renderer has settingsOfProvider); apiKeyEnv name is passed
				// through and resolved in electron-main where process.env is reliable.
				const refKey = p.entry.apiKeyRef
					? (this._settingsService.state.settingsOfProvider as Record<string, { apiKey?: string } | undefined>)[p.entry.apiKeyRef]?.apiKey
					: undefined;
				transportConfigs[p.id] = {
					baseURL: p.entry.baseURL,
					...(refKey ? { apiKey: refKey } : {}),
					...(p.entry.apiKeyEnv ? { apiKeyEnv: p.entry.apiKeyEnv } : {}),
					...(p.entry.headers ? { headers: { ...p.entry.headers } } : {}),
				};
			}
		}
		setDynamicProviderModelCaps(capsMap.size > 0 ? capsMap : undefined);
		const hasTransport = Object.keys(transportConfigs).length > 0;
		const overrides: VibeProviderActiveOverrides | undefined =
			(disabledProviders.size > 0 || disabledModels.size > 0 || dynamicModelOptions.length > 0 || hasTransport)
				? { disabledProviders, disabledModels, dynamicModelOptions, ...(hasTransport ? { transportConfigs } : {}) }
				: undefined;
		this._settingsService.applyProviderActiveOverrides(overrides);
	}
}

// Eager: must run at startup so disabled built-ins are hidden from the model picker immediately.
registerSingleton(IVibeDynamicProvidersService, VibeDynamicProvidersService, InstantiationType.Eager);
