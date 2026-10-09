/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The source of vectors for meaning search: the repo index, the semantic search command and similar-plan search ask here
 *
 * Also registered as the workbench's embedding provider (`IAiEmbeddingVectorService`): in VS Code that slot is filled by
 * Copilot, here nobody filled it, so the hybrid search the index has carried since May never got a single vector
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts` — it reaches the main process, which a browser module may not
 */

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAiEmbeddingVectorService } from '../../../services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import {
	DEFAULT_OLLAMA_EMBEDDING_MODEL,
	DEFAULT_OLLAMA_ENDPOINT,
	DEFAULT_OPENAI_EMBEDDING_MODEL,
	EMBEDDINGS_MODEL_SETTING,
	EMBEDDINGS_PROVIDER_SETTING,
	embeddingModelId,
	EmbeddingSourceConfig,
	EmbeddingSourceState,
	IVibeEmbeddingsService,
	OPENAI_BASE_URL,
} from '../common/embeddings/embeddingSource.js';
import { IOllamaInstallerService } from '../common/ollamaInstallerService.js';
import { PullProgressEvent } from '../common/embeddings/ollamaPull.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { vibeLog } from '../common/vibeLog.js';

/** Fragments per request: big enough to amortise the round trip, small enough to finish well inside a timeout */
const BATCH = 32;
/** How often an unready source is looked at again — Ollama started after the IDE is picked up without a restart */
const REPROBE_MS = 60_000;
/** «Не сейчас» to the download offer, per model, so the offer does not return every minute */
const DECLINED_PULL_KEY = 'vibeide.embeddings.declinedPull';
const MEGABYTE = 1024 * 1024;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.embeddings',
	title: localize('vibeide.embeddings.title', "VibeIDE: поиск по смыслу"),
	type: 'object',
	properties: {
		[EMBEDDINGS_PROVIDER_SETTING]: {
			type: 'string',
			default: 'ollama',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('vibeide.embeddings.provider', "Откуда брать векторы для поиска по смыслу. `ollama` — локальная Ollama, код не покидает машину. `off` — только поиск по словам (BM25). Id настроенного провайдера (`openAI` или провайдер из `.vibe/providers`) — его OpenAI-совместимый `/embeddings`: **код фрагментами уходит этому провайдеру**, без сети источник не работает."),
		},
		[EMBEDDINGS_MODEL_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('vibeide.embeddings.model', "Модель векторов. Пусто — по источнику: `embeddinggemma` для Ollama, `text-embedding-3-small` для OpenAI; для другого провайдера модель нужно указать. Смена модели пересчитывает векторы индекса в фоне."),
		},
	},
});

class VibeEmbeddingsService extends Disposable implements IVibeEmbeddingsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _state: EmbeddingSourceState = { ready: false, modelId: '' };
	private _config: EmbeddingSourceConfig | undefined;
	private readonly _registration = this._register(new MutableDisposable());
	private readonly _reprobe = this._register(new RunOnceScheduler(() => void this._refresh(), REPROBE_MS));
	private readonly _refreshSoon = this._register(new RunOnceScheduler(() => void this._refresh(), 500));
	private _offeredPull = false;
	private _lastSourceSettingsKey = '';

	constructor(
		@IMainProcessService private readonly _mainProcess: IMainProcessService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
		@IOllamaInstallerService private readonly _ollama: IOllamaInstallerService,
		@IAiEmbeddingVectorService private readonly _workbenchEmbeddings: IAiEmbeddingVectorService,
		@INotificationService private readonly _notifications: INotificationService,
		@IProgressService private readonly _progress: IProgressService,
		@IStorageService private readonly _storage: IStorageService,
		@ISecretDetectionService private readonly _secrets: ISecretDetectionService,
	) {
		super();
		this._register(this._configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(EMBEDDINGS_PROVIDER_SETTING) || e.affectsConfiguration(EMBEDDINGS_MODEL_SETTING)) {
				this._refreshSoon.schedule();
			}
		}));
		// The settings state fires on every change of any provider or model, often several times a second:
		// The source is looked at again only when what it is built from changed
		this._register(this._settings.onDidChangeState(() => {
			const key = this._sourceSettingsKey();
			if (key !== this._lastSourceSettingsKey) {
				this._lastSourceSettingsKey = key;
				this._refreshSoon.schedule();
			}
		}));
		this._lastSourceSettingsKey = this._sourceSettingsKey();
		void this._refresh();
	}

	get state(): EmbeddingSourceState {
		return this._state;
	}

	async embed(texts: readonly string[], token: CancellationToken): Promise<number[][]> {
		const config = this._config;
		if (!this._state.ready || !config) {
			throw new Error(this._state.reason ?? 'источник векторов не готов');
		}
		const channel = this._mainProcess.getChannel('vibe-channel-embeddings');
		const inputs = texts.map(text => this._redactSecrets(text));
		const out: number[][] = [];
		for (let i = 0; i < inputs.length; i += BATCH) {
			if (token.isCancellationRequested) {
				throw new Error('отменено');
			}
			out.push(...await channel.call<number[][]>('embed', { config, inputs: inputs.slice(i, i + BATCH) }));
		}
		return out;
	}

	/** Secrets never leave as embedding input: a cloud source would receive them, a local one would keep them in vectors */
	private _redactSecrets(text: string): string {
		if (!this._secrets.getConfig().enabled) {
			return text;
		}
		const result = this._secrets.detectSecrets(text);
		return result.hasSecrets ? result.redactedText : text;
	}

	private _setState(state: EmbeddingSourceState, config: EmbeddingSourceConfig | undefined): void {
		const changed = state.ready !== this._state.ready || state.modelId !== this._state.modelId || state.reason !== this._state.reason;
		this._state = state;
		this._config = config;
		if (state.ready) {
			this._registration.value ??= this._workbenchEmbeddings.registerAiEmbeddingVectorProvider(state.modelId, {
				provideAiEmbeddingVector: (strings, token) => this.embed(strings, token),
			});
			this._reprobe.cancel();
		} else {
			this._registration.clear();
			this._reprobe.schedule();
		}
		if (changed) {
			vibeLog.info('embeddings', state.ready ? `источник векторов: ${state.modelId}` : `источник векторов не готов: ${state.reason ?? ''}`);
			this._onDidChangeState.fire();
		}
	}

	private async _refresh(): Promise<void> {
		const provider = (this._configuration.getValue<string>(EMBEDDINGS_PROVIDER_SETTING) ?? 'ollama').trim();
		const model = (this._configuration.getValue<string>(EMBEDDINGS_MODEL_SETTING) ?? '').trim();
		if (provider === 'off') {
			this._setState({ ready: false, modelId: '', reason: localize('vibeide.embeddings.off', "поиск по смыслу выключен настройкой") }, undefined);
			this._reprobe.cancel();
			return;
		}
		if (provider === 'ollama') {
			await this._refreshOllama(model || DEFAULT_OLLAMA_EMBEDDING_MODEL);
			return;
		}
		this._refreshCloud(provider, model);
	}

	/** What the source is built from in the provider settings: the Ollama endpoint, or the chosen provider's transport */
	private _sourceSettingsKey(): string {
		const provider = (this._configuration.getValue<string>(EMBEDDINGS_PROVIDER_SETTING) ?? 'ollama').trim();
		const settings = this._settings.state.settingsOfProvider as unknown as Record<string, { endpoint?: string; apiKey?: string } | undefined>;
		if (provider === 'ollama') {
			return settings['ollama']?.endpoint ?? '';
		}
		if (provider === 'openAI') {
			return settings['openAI']?.apiKey ?? '';
		}
		return JSON.stringify(this._settings.getDynamicTransportConfigs()[provider] ?? null);
	}

	private async _refreshOllama(model: string): Promise<void> {
		const settings = this._settings.state.settingsOfProvider as unknown as Record<string, { endpoint?: string } | undefined>;
		const endpoint = settings['ollama']?.endpoint?.trim() || DEFAULT_OLLAMA_ENDPOINT;
		const config: EmbeddingSourceConfig = { kind: 'ollama', endpoint, model };
		const probe = await this._ollama.probe().catch(() => ({ running: false }));
		if (!probe.running) {
			this._setState({ ready: false, modelId: '', reason: localize('vibeide.embeddings.noOllama', "Ollama не запущена — поиск идёт по словам") }, undefined);
			return;
		}
		const models = await this._ollama.listModels();
		// Ollama names a pulled model with its tag: `embeddinggemma:latest`
		const present = models.some(entry => entry.name === model || entry.name.split(':')[0] === model);
		if (!present) {
			this._setState({ ready: false, modelId: '', reason: localize('vibeide.embeddings.noModel', "в Ollama нет модели {0}", model) }, undefined);
			this._offerPull(endpoint, model);
			return;
		}
		this._setState({ ready: true, modelId: embeddingModelId(config) }, config);
	}

	private _refreshCloud(provider: string, model: string): void {
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			this._setState({ ready: false, modelId: '', reason: localize('vibeide.embeddings.offline', "нет сети, а источник векторов облачный") }, undefined);
			return;
		}
		let config: EmbeddingSourceConfig | undefined;
		if (provider === 'openAI') {
			const apiKey = (this._settings.state.settingsOfProvider as unknown as Record<string, { apiKey?: string } | undefined>)['openAI']?.apiKey?.trim();
			config = apiKey ? { kind: 'openai', baseURL: OPENAI_BASE_URL, apiKey, model: model || DEFAULT_OPENAI_EMBEDDING_MODEL } : undefined;
		} else {
			const transport = this._settings.getDynamicTransportConfigs()[provider];
			config = transport && model
				? { kind: 'openai', baseURL: transport.baseURL, apiKey: transport.apiKey, apiKeyEnv: transport.apiKeyEnv, headers: transport.headers, model }
				: undefined;
		}
		if (!config) {
			this._setState({
				ready: false, modelId: '',
				reason: localize('vibeide.embeddings.noProvider', "провайдер {0} не настроен, без ключа или без модели векторов", provider),
			}, undefined);
			return;
		}
		this._setState({ ready: true, modelId: embeddingModelId(config) }, config);
	}

	/** Once per session, and never again for a model the person declined; stays until answered */
	private _offerPull(endpoint: string, model: string): void {
		if (this._offeredPull || this._storage.get(DECLINED_PULL_KEY, StorageScope.APPLICATION) === model) {
			return;
		}
		this._offeredPull = true;
		this._notifications.prompt(Severity.Info,
			localize('vibeide.embeddings.pullOffer', "Поиск по смыслу работает через Ollama, а модели векторов {0} в ней нет. Скачать её (несколько сотен МБ)? До этого поиск идёт по словам.", model),
			[
				{ label: localize('vibeide.embeddings.pull', "Скачать"), run: () => void this._pull(endpoint, model) },
				{ label: localize('vibeide.embeddings.notNow', "Не сейчас"), run: () => this._storage.store(DECLINED_PULL_KEY, model, StorageScope.APPLICATION, StorageTarget.USER) },
			],
			// Sticky: it comes at startup, behind other toasts, and a hidden plain toast expires before it is ever seen
			{ sticky: true },
		);
	}

	private async _pull(endpoint: string, model: string): Promise<void> {
		const channel = this._mainProcess.getChannel('vibe-channel-embeddings');
		try {
			await this._progress.withProgress(
				{ location: ProgressLocation.Notification, title: localize('vibeide.embeddings.pulling', "Скачиваю модель векторов {0}…", model) },
				async progress => {
					let reported = 0;
					const listener = channel.listen<PullProgressEvent>('onPullProgress')(event => {
						if (event.model !== model || event.total <= 0) {
							return;
						}
						const percent = Math.floor(event.completed * 100 / event.total);
						progress.report({
							message: localize('vibeide.embeddings.pullProgress', "{0} из {1} МБ", Math.round(event.completed / MEGABYTE), Math.round(event.total / MEGABYTE)),
							increment: Math.max(0, percent - reported),
						});
						reported = Math.max(reported, percent);
					});
					try {
						await channel.call('pull', { endpoint, model });
					} finally {
						listener.dispose();
					}
				},
			);
			await this._refresh();
		} catch (error) {
			this._notifications.error(localize('vibeide.embeddings.pullFailed', "Модель {0} не скачалась: {1}", model, error instanceof Error ? error.message : String(error)));
		}
	}
}

registerSingleton(IVibeEmbeddingsService, VibeEmbeddingsService, InstantiationType.Delayed);
