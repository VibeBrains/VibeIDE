/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ISCMService, ISCMRepository } from '../../scm/common/scm.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IVibeideSCMService } from '../common/vibeideSCMTypes.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { IConvertToLLMMessageService, isLocalProvider } from './convertToLLMMessageService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { ModelSelection, OverridesOfModel, ModelSelectionOptions } from '../common/vibeideSettingsTypes.js';
import { gitCommitMessage_systemMessage, gitCommitMessage_systemMessage_local, gitCommitMessage_userMessage } from '../common/prompt/prompts.js';
import { LLMChatMessage } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ThrottledDelayer } from '../../../../base/common/async.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

interface ModelOptions {
	modelSelection: ModelSelection | null;
	modelSelectionOptions?: ModelSelectionOptions;
	overridesOfModel: OverridesOfModel;
}

export interface IGenerateCommitMessageService {
	readonly _serviceBrand: undefined;
	generateCommitMessage(): Promise<void>;
	abort(): void;
}

export const IGenerateCommitMessageService = createDecorator<IGenerateCommitMessageService>('vibeGenerateCommitMessageService');

const loadingContextKey = 'vibeSCMGenerateCommitMessageLoading';

class GenerateCommitMessageService extends Disposable implements IGenerateCommitMessageService {
	readonly _serviceBrand: undefined;
	private readonly execute = new ThrottledDelayer(300);
	private llmRequestId: string | null = null;
	private currentRequestId: string | null = null;
	private vibeSCM: IVibeideSCMService;
	private loadingContextKey: IContextKey<boolean>;

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@IConvertToLLMMessageService private readonly convertToLLMMessageService: IConvertToLLMMessageService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();
		this.loadingContextKey = this.contextKeyService.createKey(loadingContextKey, false);
		this.vibeSCM = ProxyChannel.toService<IVibeideSCMService>(mainProcessService.getChannel('vibeide-channel-scm'));
	}

	override dispose() {
		this.execute.dispose();
		super.dispose();
	}

	async generateCommitMessage() {
		this.loadingContextKey.set(true);
		this.execute.trigger(async () => {
			const requestId = generateUuid();
			this.currentRequestId = requestId;


			try {
				const { path, repo } = this.gitRepoInfo();
				const [stat, sampledDiffs, branch, log] = await Promise.all([
					this.vibeSCM.gitStat(path),
					this.vibeSCM.gitSampledDiffs(path),
					this.vibeSCM.gitBranch(path),
					this.vibeSCM.gitLog(path)
				]);

				if (!this.isCurrentRequest(requestId)) { throw new CancellationError(); }

				const modelSelection = this.vibeideSettingsService.state.modelSelectionOfFeature['SCM'] ?? null;
				// Skip "auto" - it's not a real provider
				const modelSelectionOptions = modelSelection && !(modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto')
					? this.vibeideSettingsService.state.optionsOfModelSelection['SCM'][modelSelection.providerName]?.[modelSelection.modelName]
					: undefined;
				const overridesOfModel = this.vibeideSettingsService.state.overridesOfModel;

				const modelOptions: ModelOptions = { modelSelection, modelSelectionOptions, overridesOfModel };

				const prompt = gitCommitMessage_userMessage(stat, sampledDiffs, branch, log);

				// Use local variant for local models to reduce token usage
				const isLocal = modelSelection && modelSelection.providerName !== 'auto' && isLocalProvider(modelSelection.providerName, this.vibeideSettingsService.state.settingsOfProvider);
				const systemMessage = isLocal ? gitCommitMessage_systemMessage_local : gitCommitMessage_systemMessage;

				const simpleMessages = [{ role: 'user', content: prompt } as const];
				const { messages, separateSystemMessage } = this.convertToLLMMessageService.prepareLLMSimpleMessages({
					simpleMessages,
					systemMessage,
					modelSelection: modelOptions.modelSelection,
					featureName: 'SCM',
				});

				const rawCommitMessage = await this.sendLLMMessage(messages, separateSystemMessage!, modelOptions);

				if (!this.isCurrentRequest(requestId)) { throw new CancellationError(); }

				// VibeIDE: Add agent git identity trailer for compliance audit trail
				const agentTrailer = '\n\nCo-authored-by: VibeIDE Agent <agent@vibeide.local>';
				const commitMessage = rawCommitMessage + agentTrailer;

				repo.input.setValue(commitMessage, false);
			} catch (error) {
				this.onError(error);
			} finally {
				if (this.isCurrentRequest(requestId)) {
					this.loadingContextKey.set(false);
				}
			}
		});
	}

	abort() {
		if (this.llmRequestId) {
			this.llmMessageService.abort(this.llmRequestId);
		}
		this.execute.cancel();
		this.loadingContextKey.set(false);
		this.currentRequestId = null;
	}

	private gitRepoInfo() {
		const repo = Array.from(this.scmService.repositories || []).find((r: ISCMRepository) => r.provider.contextValue.get() === 'git');
		if (!repo) { throw new Error('No git repository found'); }
		if (!repo.provider.rootUri?.fsPath) { throw new Error('No git repository root path found'); }
		return { path: repo.provider.rootUri.fsPath, repo };
	}

	/** LLM Functions */

	private sendLLMMessage(messages: LLMChatMessage[], separateSystemMessage: string, modelOptions: ModelOptions): Promise<string> {
		return new Promise((resolve, reject) => {

			this.llmRequestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: null,
				modelSelection: modelOptions.modelSelection,
				modelSelectionOptions: modelOptions.modelSelectionOptions,
				overridesOfModel: modelOptions.overridesOfModel,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					const match = params.fullText.match(/<output>([\s\S]*?)<\/output>/i);
					const commitMessage = match ? match[1].trim() : '';
					resolve(commitMessage);
				},
				onError: (error) => {
					vibeLog.error('vibeideSCM', error);
					reject(error);
				},
				onAbort: () => {
					reject(new CancellationError());
				},
				logging: { loggingName: 'VibeIDE SCM - Commit Message' },
			});
		});
	}


	/** Request Helpers */

	private isCurrentRequest(requestId: string) {
		return requestId === this.currentRequestId;
	}


	/** UI Functions */

	private onError(error: unknown) {
		if (!isCancellationError(error)) {
			vibeLog.error('vibeideSCM', error);
			this.notificationService.error(localize2('vibeFailedToGenerateCommitMessage', 'Failed to generate commit message.').value);
		}
	}
}

class GenerateCommitMessageAction extends Action2 {
	constructor() {
		super({
			id: 'vibe.generateCommitMessageAction',
			title: localize2('vibeCommitMessagePrompt', 'VibeIDE: Generate Commit Message'),
			icon: ThemeIcon.fromId('sparkle'),
			tooltip: localize2('vibeCommitMessagePromptTooltip', 'VibeIDE: Generate Commit Message'),
			f1: true,
			menu: [{
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals(loadingContextKey, false)),
				group: 'inline'
			}]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const generateCommitMessageService = accessor.get(IGenerateCommitMessageService);
		generateCommitMessageService.generateCommitMessage();
	}
}

class LoadingGenerateCommitMessageAction extends Action2 {
	constructor() {
		super({
			id: 'vibe.loadingGenerateCommitMessageAction',
			title: localize2('vibeCommitMessagePromptCancel', 'VibeIDE: Cancel Commit Message Generation'),
			icon: ThemeIcon.fromId('stop-circle'),
			tooltip: localize2('vibeCommitMessagePromptCancelTooltip', 'VibeIDE: Cancel Commit Message Generation'),
			f1: false, //Having a cancel command in the command palette is more confusing than useful.
			menu: [{
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals(loadingContextKey, true)),
				group: 'inline'
			}]
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const generateCommitMessageService = accessor.get(IGenerateCommitMessageService);
		generateCommitMessageService.abort();
	}
}

registerAction2(GenerateCommitMessageAction);
registerAction2(LoadingGenerateCommitMessageAction);
registerSingleton(IGenerateCommitMessageService, GenerateCommitMessageService, InstantiationType.Delayed);
