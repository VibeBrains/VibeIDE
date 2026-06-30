/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { scanProviderConfig, ConfigGuardFinding } from '../common/vibeConfigGuard.js';
import { providerNames, ProviderName, VibeideStatefulModelInfo } from '../common/vibeideSettingsTypes.js';
import { IVibeideSettingsService, VibeProviderActiveOverrides, ModelOption, DynProviderTransportConfig, DynamicProviderSeed } from '../common/vibeideSettingsService.js';
import { setExternalProviders, ExternalProviderDescriptor, VibeideStaticModelInfo } from '../common/modelCapabilities.js';
import { IRemoteCatalogService, DynamicKeyValidation } from '../common/remoteCatalogService.js';
import { parseProvidersFile, mergeProviderEntry, VibeProviderEntry, VibeProviderModelEntry } from '../common/vibeProvidersFile.js';
import { parseEnvFile } from '../common/vibeEnvFile.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

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
	// extraBody → additionalOpenAIPayload: the AI-SDK path spreads this verbatim into the request
	// body (sendViaAISdk → openAICompatExtraBody → transformRequestBody). Carries provider quirks
	// like Moonshot `thinking: { type: "enabled" }`.
	if (m.extraBody && typeof m.extraBody === 'object') { c.additionalOpenAIPayload = { ...m.extraBody }; }
	// reasoning → reasoningCapabilities. An `effort` list maps to an effort_slider, which the
	// openai-compatible reasoning hook turns into `reasoning_effort` on the wire; reasoning_content
	// is parsed back via the openai-compat output settings. Default to the highest effort (thinking
	// models like K2.7 are meant to think). `thinkTags` (rare) routes inline <think> parsing.
	if (m.reasoning && typeof m.reasoning === 'object') {
		const r = m.reasoning;
		const rc: Record<string, unknown> = { supportsReasoning: true, canTurnOffReasoning: r.canTurnOff ?? true, canIOReasoning: true };
		if (r.effort && r.effort.length > 0) {
			const def = r.effort.includes('high') ? 'high' : r.effort[r.effort.length - 1];
			rc.reasoningSlider = { type: 'effort_slider', values: [...r.effort], default: def };
		}
		if (r.thinkTags) { rc.openSourceThinkTags = [r.thinkTags[0], r.thinkTags[1]]; }
		c.reasoningCapabilities = rc;
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

/**
 * One active dynamic provider, flattened for the «Проверка провайдеров» diagnostics modal.
 * "Active" = resolvable key (gui / .vibe/.env / apiKeyRef) OR an OS-env key name (`apiKeyEnv`,
 * resolved in electron-main at send time and therefore invisible to the renderer).
 */
export interface ProviderDiagnosticsTarget {
	readonly id: string;
	readonly displayName: string;
	readonly baseURL?: string;
	readonly protocol?: string;
	readonly keySource: 'gui' | 'env' | 'ref' | 'none';
	/** OS env var name (main-only). Present => key is resolved server-side; renderer can't probe with it. */
	readonly apiKeyEnv?: string;
	/** Renderer-visible key for probing (undefined for OS-env-only providers). */
	readonly apiKey?: string;
	/** Custom models URL when `models.fetch` is a string. */
	readonly modelsUrl?: string;
	/** `false` => static-only (no catalog probe). */
	readonly modelsFetch: boolean;
}

/**
 * Order of DYNAMIC providers in the model picker (built-ins keep their hard-coded order — these are
 * appended after them). `order` ascending; entries WITHOUT `order` sink to the end; any tie (equal
 * `order`, or both missing it) breaks by display name (`name || id`). Pure → unit-testable.
 */
function compareDynamicProviders(a: ResolvedProviderEntry, b: ResolvedProviderEntry): number {
	const ao = a.entry.order, bo = b.entry.order;
	const aHas = typeof ao === 'number', bHas = typeof bo === 'number';
	if (aHas && bHas && ao !== bo) { return ao! - bo!; }
	if (aHas !== bHas) { return aHas ? -1 : 1; } // an explicit order always precedes "no order"
	return (a.entry.name || a.id).localeCompare(b.entry.name || b.id);
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
	/** Config Guard findings from the last load of `.vibe/providers.json` (empty if disabled/clean). */
	getLastGuardFindings(): readonly ConfigGuardFinding[];
	/** Active dynamic providers (resolvable key or OS-env key), flattened for the diagnostics modal. */
	getDiagnosticsTargets(): ProviderDiagnosticsTarget[];
}

const EMPTY_STATE: VibeDynamicProvidersState = { fileExists: false, providers: [], warnings: [] };

class VibeDynamicProvidersService extends Disposable implements IVibeDynamicProvidersService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _state: VibeDynamicProvidersState = EMPTY_STATE;
	private readonly _builtinIds: ReadonlySet<string> = new Set<string>(providerNames as readonly string[]);
	/** Parsed `.vibe/.env` (local secrets source for `apiKeyEnv`). Refreshed on every reload. */
	private _envFileVars: Record<string, string> = {};
	/** Bumped on every state change so a slow async catalog fetch can detect it raced a newer reload. */
	private _reloadGen = 0;
	/** JSON of the last-seen UI-typed dynamic keys — lets us reload ONLY when they actually change,
	 *  so our own applyProviderActiveOverrides (which also fires onDidChangeState) can't loop. */
	private _lastSeenUiKeys = '';
	/** JSON of the last-seen per-model hide toggles — a change re-applies the overlay (re-gates the
	 *  picker) WITHOUT a full reload/re-probe (the key didn't change, only which models are enabled). */
	private _lastSeenHidden = '';
	/** Last key-validation results, cached so a hide-toggle re-apply doesn't re-probe the network. */
	private _lastValidation: Map<string, DynamicKeyValidation> | undefined = undefined;
	/** Config Guard finding signature of the last reload — dedupes the user notification across re-reads. */
	private _lastGuardSig = '';
	/** Config Guard findings from the last reload — surfaced by the diagnostic command. */
	private _lastGuardFindings: readonly ConfigGuardFinding[] = [];

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IRemoteCatalogService private readonly _remoteCatalogService: IRemoteCatalogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		void this.reload();
		// A window opened DIRECTLY on a folder fires no onDidChangeWorkspaceFolders, and the service
		// can construct before workspace folders are populated — both leave the initial reload() empty
		// (file silently "not found"). Reload once the workbench is restored, when folders[0] is
		// guaranteed present, so the model picker actually receives the dynamic providers at startup.
		this._lifecycleService.when(LifecyclePhase.Restored).then(() => { void this.reload(); });
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => { void this.reload(); }));
		this._register(this._fileService.onDidFilesChange(e => {
			const uri = this._fileUri();
			const envUri = this._envFileUri();
			if ((uri && e.affects(uri)) || (envUri && e.affects(envUri))) {
				vibeLog.debug('DynProviders', 'providers.json / .vibe/.env changed on disk — reloading');
				void this.reload();
			}
		}));
		// A key typed into a dynamic provider's Settings card lands in settingsService state; reload to
		// re-resolve + reseed. Guarded by a snapshot so our OWN overlay writes (which also fire this
		// event but don't touch dynamicProviderApiKeys) don't cause an infinite reload loop.
		this._lastSeenUiKeys = JSON.stringify(this._settingsService.state.dynamicProviderApiKeys ?? {});
		this._lastSeenHidden = JSON.stringify(this._settingsService.state.dynamicModelHidden ?? {});
		this._register(this._settingsService.onDidChangeState(() => {
			const curKeys = JSON.stringify(this._settingsService.state.dynamicProviderApiKeys ?? {});
			if (curKeys !== this._lastSeenUiKeys) {
				// Key changed → full reload (re-resolve + re-probe validity).
				this._lastSeenUiKeys = curKeys;
				this._lastSeenHidden = JSON.stringify(this._settingsService.state.dynamicModelHidden ?? {});
				void this.reload();
				return;
			}
			const curHidden = JSON.stringify(this._settingsService.state.dynamicModelHidden ?? {});
			if (curHidden !== this._lastSeenHidden) {
				// Only a model hide-toggle changed → re-apply the overlay (re-gate picker), no re-probe.
				this._lastSeenHidden = curHidden;
				this._reapplyOverlay();
			}
		}));
	}

	/** Rebuild + re-apply the overlay from the current resolved providers using the cached validation
	 *  results — used when only hide-toggles changed (no need to re-read the file or re-probe keys). */
	private _reapplyOverlay(): void {
		if (this._state.providers.length === 0) { return; }
		this._buildAndApply(this._state.providers, this._lastValidation);
	}

	getState(): VibeDynamicProvidersState {
		return this._state;
	}

	getLastGuardFindings(): readonly ConfigGuardFinding[] {
		return this._lastGuardFindings;
	}

	private _fileUri(): URI | undefined {
		const folder = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.vibe', 'providers.json') : undefined;
	}

	private _envFileUri(): URI | undefined {
		const folder = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.vibe', '.env') : undefined;
	}

	/** Read + parse `.vibe/.env`. Absent file is the normal case → empty map. */
	private async _readEnvFile(): Promise<Record<string, string>> {
		const envUri = this._envFileUri();
		if (!envUri) { return {}; }
		try {
			const buf = await this._fileService.readFile(envUri);
			return parseEnvFile(buf.value.toString());
		} catch {
			return {};
		}
	}

	async reload(): Promise<void> {
		const uri = this._fileUri();
		if (!uri) {
			vibeLog.debug('DynProviders', 'no workspace folder — no providers.json');
			this._setState(EMPTY_STATE);
			return;
		}

		// Local secrets source for apiKeyEnv (sibling of providers.json). Loaded before resolution
		// so transport can prefer it over the OS environment.
		this._envFileVars = await this._readEnvFile();

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
		// Config Guard: static-scan the user-authored entries for unsafe endpoints / hardcoded secrets.
		const guard = this._runConfigGuard(parsed.providers);
		const effectiveProviders = guard.blockedIds.size > 0 ? providers.filter(p => !guard.blockedIds.has(p.id)) : providers;
		const allWarnings = [...warnings, ...guard.lines];
		vibeLog.warn('DynProviders', `providers.json loaded: ${effectiveProviders.length} provider(s), ${allWarnings.length} warning(s)`);
		for (const p of effectiveProviders) {
			vibeLog.debug('DynProviders', `  • ${p.id} [${p.kind}${p.extendsBuiltin ? `:${p.extendsBuiltin}` : ''}] active=${p.entry.active !== false}`);
		}
		for (const w of allWarnings) { vibeLog.warn('DynProviders', `  ⚠ ${w}`); }
		this._setState({ fileExists: true, providers: effectiveProviders, warnings: allWarnings });
	}

	/**
	 * Run the Config Guard over the parsed provider entries. Returns warning lines (surfaced in state
	 * + log) and, in `block` mode, the ids of providers with a CRITICAL finding to drop from transport.
	 * A clean scan resets the notification dedupe so a later regression notifies again.
	 */
	private _runConfigGuard(entries: readonly VibeProviderEntry[]): { blockedIds: Set<string>; lines: string[] } {
		const blockedIds = new Set<string>();
		if (this._configurationService.getValue<boolean>('vibeide.configGuard.enabled') === false) { this._lastGuardFindings = []; return { blockedIds, lines: [] }; }
		const findings = scanProviderConfig(entries);
		this._lastGuardFindings = findings;
		if (findings.length === 0) { this._lastGuardSig = ''; return { blockedIds, lines: [] }; }
		const block = this._configurationService.getValue<string>('vibeide.configGuard.mode') === 'block';
		const lines: string[] = [];
		for (const f of findings) {
			lines.push(`Config Guard [${f.severity}] ${f.message}`);
			if (block && f.severity === 'critical') { blockedIds.add(f.subject); }
		}
		this._notifyGuard(findings, block);
		return { blockedIds, lines };
	}

	/** One consolidated, deduped warning notification per distinct set of findings. */
	private _notifyGuard(findings: readonly ConfigGuardFinding[], block: boolean): void {
		const sig = findings.map(f => `${f.ruleId}:${f.subject}`).sort().join('|');
		if (sig === this._lastGuardSig) { return; }
		this._lastGuardSig = sig;
		const crit = findings.filter(f => f.severity === 'critical').length;
		const verb = block && crit > 0 ? 'заблокировал' : 'обнаружил';
		this._notificationService.warn(`Config Guard ${verb} проблемы безопасности в .vibe/providers.json: ${findings.length} (критичных: ${crit}). Подробности — в логе VibeIDE.`);
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
		const gen = ++this._reloadGen;
		// Apply IMMEDIATELY with the file's static model list (no network) so the picker is populated at
		// once and built-in disables take effect without waiting — preserves Phase 1 behavior / no regress.
		this._buildAndApply(state.providers, undefined);
		this._onDidChange.fire();
		// Then enrich asynchronously: fetch <baseURL>/v1/models for connected providers and re-apply with
		// the live catalog (models no longer have to be hardcoded in the file). Stale fetches are dropped.
		void this._enrichWithCatalog(state.providers, gen);
	}

	/** Browser-visible key for a dynamic provider: apiKeyRef (secure settings) → .vibe/.env. A key only
	 *  in an OS env var isn't visible to the renderer (PRODUCT invariant 12) — electron-main still
	 *  resolves apiKeyEnv from process.env at send time; here it just doesn't count for UI gating. */
	private _resolveBrowserKey(p: ResolvedProviderEntry): string | undefined {
		// Precedence: key typed into the Settings card (UI) → apiKeyRef (another provider's secure key)
		// → .vibe/.env. The UI key wins because it's the most explicit, per-provider user action.
		const uiKey = (this._settingsService.state.dynamicProviderApiKeys ?? {})[p.id];
		const refKey = p.entry.apiKeyRef
			? (this._settingsService.state.settingsOfProvider as Record<string, { apiKey?: string } | undefined>)[p.entry.apiKeyRef]?.apiKey
			: undefined;
		const envFileKey = p.entry.apiKeyEnv ? this._envFileVars[p.entry.apiKeyEnv] : undefined;
		return (uiKey?.trim() ? uiKey : undefined) || refKey || envFileKey || undefined;
	}

	/** Which source the resolved key came from (same precedence as `_resolveBrowserKey`), for the card. */
	private _resolveKeySource(p: ResolvedProviderEntry): 'gui' | 'env' | 'ref' | 'none' {
		const uiKey = (this._settingsService.state.dynamicProviderApiKeys ?? {})[p.id];
		if (uiKey?.trim()) { return 'gui'; }
		const refKey = p.entry.apiKeyRef
			? (this._settingsService.state.settingsOfProvider as Record<string, { apiKey?: string } | undefined>)[p.entry.apiKeyRef]?.apiKey
			: undefined;
		if (refKey?.trim()) { return 'ref'; }
		const envFileKey = p.entry.apiKeyEnv ? this._envFileVars[p.entry.apiKeyEnv] : undefined;
		if (envFileKey?.trim()) { return 'env'; }
		return 'none';
	}

	getDiagnosticsTargets(): ProviderDiagnosticsTarget[] {
		const out: ProviderDiagnosticsTarget[] = [];
		for (const p of this._state.providers) {
			// Overrides only patch a built-in (the built-in is diagnosed under its own entry); skip them.
			if (p.kind === 'override') { continue; }
			if (p.entry.active === false) { continue; }
			const keySource = this._resolveKeySource(p);
			const hasOsEnv = !!p.entry.apiKeyEnv;
			// "Active" = key resolvable in the renderer OR an OS-env key resolved in main.
			if (keySource === 'none' && !hasOsEnv) { continue; }
			const fetchSpec = p.entry.models?.fetch;
			out.push({
				id: p.id,
				displayName: p.entry.name || p.id,
				baseURL: p.entry.baseURL,
				protocol: p.entry.protocol,
				keySource,
				apiKeyEnv: p.entry.apiKeyEnv,
				apiKey: this._resolveBrowserKey(p),
				modelsUrl: typeof fetchSpec === 'string' ? fetchSpec : undefined,
				modelsFetch: fetchSpec !== false,
			});
		}
		return out;
	}

	/**
	 * Fetch the live model catalog (<baseURL>/v1/models) for every connected dynamic provider and
	 * re-apply the overlay so the picker shows catalog models instead of only the file's static list.
	 * Only connected (resolvable browser key) providers are fetched — keeps a keyless provider out of
	 * the catalog's negative cache. Bails if a newer reload superseded this run.
	 */
	private async _enrichWithCatalog(providers: readonly ResolvedProviderEntry[], gen: number): Promise<void> {
		// `models.fetch: false` = static only, no probe. `true` / custom URL / omitted (default) → probe the
		// models endpoint to BOTH validate the key (401/403 = invalid) and fetch the live model list.
		const connected = providers.filter(p =>
			p.kind !== 'override' && p.entry.active !== false && !!p.entry.baseURL
			&& p.entry.models?.fetch !== false && !!this._resolveBrowserKey(p));
		if (connected.length === 0) { return; }

		const validationByProvider = new Map<string, DynamicKeyValidation>();
		await Promise.all(connected.map(async p => {
			const fetchSpec = p.entry.models?.fetch;
			const modelsUrl = typeof fetchSpec === 'string' ? fetchSpec : undefined;
			const res = await this._remoteCatalogService.fetchDynamicWithStatus(p.entry.baseURL!, this._resolveBrowserKey(p), modelsUrl);
			validationByProvider.set(p.id, res);
		}));

		// A reload (file/.env change, workspace switch) since we started owns the overlay now — drop ours.
		if (gen !== this._reloadGen) { return; }
		// Cache so a later hide-toggle can re-apply without re-probing. Always re-apply (even on
		// all-invalid) so keyStatus flips pending → valid/invalid and a bad key's models leave the picker.
		this._lastValidation = validationByProvider;
		this._buildAndApply(providers, validationByProvider);
	}

	/**
	 * Build the settings overlay (built-in disable-toggles + dynamic transport + selectable models) and
	 * push it to the settings service. Only `override` entries (id matches a built-in) affect built-in
	 * lists; `active:false` on the provider disables it whole, otherwise each model with `active:false`
	 * is hidden. When `catalogByProvider` carries a provider's models, those are the selectable set (file
	 * `static` of the same id overlays caps); otherwise the file's static list is used.
	 */
	private _buildAndApply(providers: readonly ResolvedProviderEntry[], validationByProvider: ReadonlyMap<string, DynamicKeyValidation> | undefined): void {
		const disabledProviders = new Set<string>();
		const disabledModels = new Map<string, ReadonlySet<string>>();
		const dynamicModelOptions: ModelOption[] = [];
		// Registry descriptors: each active dynamic provider is registered as openai-compatible so its
		// models resolve caps through the SAME name-recognition as built-ins (no per-model caps here).
		const descriptors: ExternalProviderDescriptor[] = [];
		const transportConfigs: Record<string, DynProviderTransportConfig> = {};
		const dynamicProviderSettings: Record<string, DynamicProviderSeed> = {};

		// First pass: built-in patches (disable toggles) are order-independent; collect the active
		// dynamic providers to sort before they contribute selectable models.
		const activeDynamic: ResolvedProviderEntry[] = [];
		for (const p of providers) {
			if (p.kind === 'override') {
				// Patch of a built-in: active:false disables it; otherwise hide its active:false models.
				if (p.entry.active === false) { disabledProviders.add(p.id); continue; }
				const off = (p.entry.models?.static ?? []).filter(m => m.active === false).map(m => m.id);
				if (off.length > 0) { disabledModels.set(p.id, new Set(off)); }
				continue;
			}
			// definition / extends-builtin: a NEW selectable provider.
			if (p.entry.active === false) { continue; }
			activeDynamic.push(p);
		}

		// Sort by `order` (then name) so the picker reflects the user's intended provider order.
		activeDynamic.sort(compareDynamicProviders);

		for (const p of activeDynamic) {
			const resolvedKey = this._resolveBrowserKey(p);

			// Transport overlay — built regardless of UI key (apiKeyEnv may resolve in main at send time),
			// only needs a baseURL. extends-builtin without baseURL inherits downstream (follow-up).
			if (p.entry.baseURL) {
				const fetchSpec = p.entry.models?.fetch;
				transportConfigs[p.id] = {
					baseURL: p.entry.baseURL,
					...(resolvedKey ? { apiKey: resolvedKey } : {}),
					...(p.entry.apiKeyEnv ? { apiKeyEnv: p.entry.apiKeyEnv } : {}),
					...(p.entry.headers ? { headers: { ...p.entry.headers } } : {}),
					...(typeof fetchSpec === 'string' ? { modelsUrl: fetchSpec } : {}),
				};
			}

			// Models are gated on a WORKING key, not mere presence (PRODUCT invariants 4, 8, 10):
			//  • no key            → keyStatus 'none', no models
			//  • fetch:false       → keyStatus 'unverified' (no probe), show file static list
			//  • fetch:true probed → 'valid' (catalog/static), 'invalid' (401/403 → NO models),
			//                        'error' (network → NO models), 'pending' (sync pass, probe not done)
			const keySource = this._resolveKeySource(p);
			const isStaticOnly = p.entry.models?.fetch === false;
			const label = p.entry.name || p.id;
			const seedModels: VibeideStatefulModelInfo[] = [];
			const staticById = new Map<string, VibeProviderModelEntry>();
			for (const m of (p.entry.models?.static ?? [])) {
				if (m.active !== false) { staticById.set(m.id, m); }
			}

			// Register this provider as openai-compatible; file `static` caps become per-model overrides on
			// the recognized baseline (vision/reasoning/tool-format come from the knowledge base by name).
			const modelCapOverrides: { [id: string]: Partial<VibeideStaticModelInfo> } = {};
			for (const m of (p.entry.models?.static ?? [])) { modelCapOverrides[m.id] = modelEntryToCaps(m); }
			descriptors.push({ id: p.id, source: 'file', ...(Object.keys(modelCapOverrides).length ? { modelCapOverrides } : {}) });

			const hiddenOverrides = (this._settingsService.state.dynamicModelHidden ?? {})[p.id];
			const pushModel = (id: string, name: string, fileNote?: 'override' | 'manual') => {
				// Default: file `static` models (fileNote set) are shown; catalog-only models (no fileNote)
				// are hidden until the user enables them in «Модели». An explicit user toggle wins.
				const hidden = hiddenOverrides?.[id] ?? !fileNote;
				if (!hidden) {
					dynamicModelOptions.push({ name: `${name} (${label})`, selection: { providerName: p.id as ProviderName, modelName: id }, ...(fileNote ? { fileNote } : {}) });
				}
				seedModels.push({ modelName: id, type: 'autodetected', isHidden: hidden, ...(fileNote ? { fileNote } : {}) });
			};
			const pushStatic = () => { for (const m of staticById.values()) { pushModel(m.id, m.name || m.id, 'manual'); } };

			let keyStatus: DynamicProviderSeed['keyStatus'];
			if (!resolvedKey) {
				keyStatus = 'none';
			} else if (isStaticOnly) {
				keyStatus = 'unverified';
				pushStatic();
			} else {
				const v = validationByProvider?.get(p.id);
				if (!v) {
					keyStatus = 'pending'; // sync pass — probe not done yet, offer nothing until validated
				} else if (v.status === 'ok') {
					keyStatus = 'valid';
					if (v.models.length > 0) {
						// Catalog is the source of truth; a same-id static entry marks it as a file override.
						for (const cm of v.models) {
							const st = staticById.get(cm.id);
							pushModel(cm.id, st?.name || cm.name || cm.id, st ? 'override' : undefined);
						}
						for (const m of staticById.values()) {
							if (!v.models.some(cm => cm.id === m.id)) { pushModel(m.id, m.name || m.id, 'manual'); }
						}
					} else {
						pushStatic(); // valid key but empty catalog → fall back to the file's curated list
					}
				} else {
					keyStatus = v.status === 'unauthorized' ? 'invalid' : 'error'; // NO models for a bad/unreachable key
				}
			}

			// First-class seed for the Settings UI. `apiKey` = the UI-typed key only (editable field value).
			// `_didFillInProviderSettings` is true only when models are actually offered (valid / static).
			const uiKey = (this._settingsService.state.dynamicProviderApiKeys ?? {})[p.id] ?? '';
			dynamicProviderSettings[p.id] = {
				apiKey: uiKey,
				endpoint: p.entry.baseURL ?? '',
				...(p.entry.headers ? { headersJSON: JSON.stringify(p.entry.headers) } : {}),
				models: seedModels,
				_didFillInProviderSettings: keyStatus === 'valid' || keyStatus === 'unverified',
				keyStatus,
				keySource,
				// Carried to electron-main (via settingsOfProvider) so the send-path registers this provider
				// in its own caps registry — same `modelCapOverrides` as the renderer-side descriptor.
				...(Object.keys(modelCapOverrides).length ? { modelCapOverrides } : {}),
			};
		}
		// Register all active dynamic providers in the unified caps registry (replace-all each apply).
		setExternalProviders(descriptors);
		const hasTransport = Object.keys(transportConfigs).length > 0;
		const hasSeed = Object.keys(dynamicProviderSettings).length > 0;
		const overrides: VibeProviderActiveOverrides | undefined =
			(disabledProviders.size > 0 || disabledModels.size > 0 || dynamicModelOptions.length > 0 || hasTransport || hasSeed)
				? { disabledProviders, disabledModels, dynamicModelOptions, ...(hasTransport ? { transportConfigs } : {}), ...(hasSeed ? { dynamicProviderSettings } : {}) }
				: undefined;
		this._settingsService.applyProviderActiveOverrides(overrides);
	}
}

// Eager: must run at startup so disabled built-ins are hidden from the model picker immediately.
registerSingleton(IVibeDynamicProvidersService, VibeDynamicProvidersService, InstantiationType.Eager);

/**
 * Force the service to instantiate after restore. A bare Eager singleton with no consumers wasn't
 * being created at startup (observed: the model picker never received the dynamic providers until
 * the diagnostic command did an explicit accessor.get + reload). Injecting it here at AfterRestored —
 * workspace folders ready — guarantees the initial reload() + overlay injection happen on launch.
 */
class VibeDynamicProvidersStartupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeDynamicProvidersStartup';
	constructor(@IVibeDynamicProvidersService dynProviders: IVibeDynamicProvidersService) {
		super();
		void dynProviders; // injection alone forces instantiation (and the service's initial reload)
	}
}
registerWorkbenchContribution2(VibeDynamicProvidersStartupContribution.ID, VibeDynamicProvidersStartupContribution, WorkbenchPhase.AfterRestored);
