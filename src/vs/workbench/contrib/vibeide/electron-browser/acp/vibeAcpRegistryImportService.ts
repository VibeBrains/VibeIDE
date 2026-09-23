/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IVibeAcpRegistryImportService` (contract — `../../common/acp/vibeAcpRegistryImport.ts`).
 *
 * The person decides everything here: which agent, which file it goes to, and — after being told what
 * will run or be downloaded, under which licence and from where — whether it happens at all. What the
 * registry allows and why is decided in `common/acp/acpRegistry.ts`; the download in the main process.
 */

import { localize, localize2 } from '../../../../../nls.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { arch, platform } from '../../../../../base/common/process.js';
import { URI } from '../../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { AcpInstallPlan, AcpInstallRefusal, AcpPlatformTarget, IAcpRegistryAgent, agentEntryOf, installPlanOf, parseAcpRegistry, platformTargetOf, registryUpdateOf } from '../../common/acp/acpRegistry.js';
import { ACP_REGISTRY_URL_KEY } from '../../common/acp/acpRegistryConfiguration.js';
import { IVibeAcpInstaller, VIBE_ACP_INSTALLER_CHANNEL } from '../../common/acp/acpInstallerTypes.js';
import { IAcpAgentUpdate, IVibeAcpRegistryImportService, VIBE_ACP_ADD_FROM_REGISTRY_COMMAND_ID, VIBE_ACP_UPDATE_FROM_REGISTRY_COMMAND_ID } from '../../common/acp/vibeAcpRegistryImport.js';
import { VibeAgentLayer } from '../../common/acp/vibeAgentsFile.js';
import { withAgentAppended, withAgentUpdated } from '../../common/acp/vibeAgentsFileEdit.js';
import { IAuditLogService } from '../../common/auditLogService.js';
import { VIBE_COMMAND_CATEGORY } from '../../common/vibeCommandCategory.js';
import { IVibeAcpRegistryService } from '../../browser/acp/vibeAcpRegistryService.js';

/** The registry is rebuilt hourly; within that hour the pane need not ask again. */
const REGISTRY_CACHE_MS = 60 * 60 * 1000;

class VibeAcpRegistryImportService extends Disposable implements IVibeAcpRegistryImportService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeUpdates = this._register(new Emitter<void>());
	readonly onDidChangeUpdates: Event<void> = this._onDidChangeUpdates.event;

	private readonly _installer: IVibeAcpInstaller;
	private _updates: ReadonlyMap<string, IAcpAgentUpdate> = new Map();
	private _fetched: { readonly at: number; readonly url: string; readonly agents: readonly IAcpRegistryAgent[] } | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IVibeAcpRegistryService private readonly _registry: IVibeAcpRegistryService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IDialogService private readonly _dialog: IDialogService,
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@IProgressService private readonly _progress: IProgressService,
		@IAuditLogService private readonly _auditLog: IAuditLogService,
	) {
		super();
		this._installer = ProxyChannel.toService<IVibeAcpInstaller>(mainProcessService.getChannel(VIBE_ACP_INSTALLER_CHANNEL));
		this._register(this._registry.onDidChange(() => this._recomputeUpdates()));
	}

	get updates(): ReadonlyMap<string, IAcpAgentUpdate> {
		return this._updates;
	}

	async checkUpdates(): Promise<void> {
		if (!this._registry.agents.some(agent => agent.registry)) {
			return;
		}
		await this._agents(false);
		this._recomputeUpdates();
	}

	async addFromRegistry(): Promise<void> {
		const agents = await this._agentsOrReport(true);
		if (!agents) {
			return;
		}
		const target = currentTarget();
		type AgentItem = IQuickPickItem & { readonly agent: IAcpRegistryAgent; readonly plan: AcpInstallPlan };
		const items: AgentItem[] = agents.map(agent => {
			const plan = installPlanOf(agent, target);
			const added = this._registry.agents.some(entry => entry.id === agent.id || entry.registry?.id === agent.id);
			return {
				agent,
				plan,
				label: agent.name,
				description: [agent.version, agent.license, added ? localize('vibeide.acp.registry.added', "уже добавлен") : undefined].filter(Boolean).join(' · '),
				detail: [agent.description, planSummary(plan, target)].filter(Boolean).join(' — '),
			};
		});
		const picked = await this._quickInput.pick(items, {
			placeHolder: localize('vibeide.acp.registry.pick', "Агент из реестра ACP"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			return;
		}
		const { agent, plan } = picked;
		if (plan.kind === 'refused') {
			this._notifications.info(localize('vibeide.acp.registry.refused', "«{0}» из реестра не добавить: {1}. Подключить его вручную можно по docs/manuals/agentsSpec.md.", agent.name, refusalText(plan.reason)));
			return;
		}
		if (this._registry.agents.some(entry => entry.id === agent.id)) {
			this._notifications.info(localize('vibeide.acp.registry.exists', "Агент «{0}» уже есть в списке. Новая версия ставится кнопкой обновления во вкладке «Внешние агенты».", agent.name));
			return;
		}
		const layer = plan.kind === 'binary' ? 'machine' : await this._pickLayer();
		if (!layer) {
			return;
		}
		const fileUri = await this._registry.fileOf(layer);
		if (!fileUri) {
			this._notifications.warn(localize('vibeide.acp.registry.noFolder', "Открытой папки нет — в проект записывать некуда."));
			return;
		}
		const confirmed = await this._dialog.confirm({
			message: localize('vibeide.acp.registry.confirm', "Добавить агента «{0}» {1}?", agent.name, agent.version),
			detail: confirmDetail(agent, plan, layer),
			primaryButton: plan.kind === 'binary' ? localize('vibeide.acp.registry.download', "Скачать и добавить") : localize('vibeide.acp.registry.add', "Добавить"),
		});
		if (!confirmed.confirmed) {
			return;
		}
		try {
			const command = plan.kind === 'binary' ? await this._install(agent, plan) : undefined;
			const entry = agentEntryOf(agent, plan, command);
			if (!entry) {
				return;
			}
			await this._fileService.writeFile(fileUri, VSBuffer.fromString(withAgentAppended(await this._read(fileUri), entry)));
			this._audit(agent, plan, layer);
			await this._registry.reload();
			this._notifications.info(localize('vibeide.acp.registry.done', "Агент «{0}» добавлен — позвать его можно во вкладке «Внешние агенты».", agent.name));
		} catch (err) {
			this._notifications.error(localize('vibeide.acp.registry.failed', "Не удалось добавить «{0}»: {1}", agent.name, err instanceof Error ? err.message : String(err)));
		}
	}

	async update(agentId: string): Promise<void> {
		const entry = this._registry.agents.find(agent => agent.id === agentId);
		const layer = this._registry.layerOf(agentId);
		if (!entry?.registry || !layer) {
			return;
		}
		const agents = await this._agentsOrReport(true);
		if (!agents) {
			return;
		}
		const next = registryUpdateOf(entry, agents);
		if (!next) {
			this._recomputeUpdates();
			this._notifications.info(localize('vibeide.acp.registry.latest', "У «{0}» уже последняя версия из реестра.", entry.name ?? entry.id));
			return;
		}
		const target = currentTarget();
		const plan = installPlanOf(next.agent, target);
		if (plan.kind === 'refused') {
			this._notifications.warn(localize('vibeide.acp.registry.updateRefused', "Версию {0} агента «{1}» не поставить: {2}.", next.to, entry.name ?? entry.id, refusalText(plan.reason)));
			return;
		}
		const confirmed = await this._dialog.confirm({
			message: localize('vibeide.acp.registry.updateConfirm', "Обновить «{0}» с {1} до {2}?", entry.name ?? entry.id, next.from, next.to),
			detail: confirmDetail(next.agent, plan, layer),
			primaryButton: localize('vibeide.acp.registry.update', "Обновить"),
		});
		if (!confirmed.confirmed) {
			return;
		}
		const fileUri = await this._registry.fileOf(layer);
		try {
			const command = plan.kind === 'binary' ? await this._install(next.agent, plan) : undefined;
			const updated = agentEntryOf(next.agent, plan, command);
			const text = fileUri ? await this._read(fileUri) : undefined;
			const patched = updated && text ? withAgentUpdated(text, entry.id, { command: updated.command, args: updated.args, registry: updated.registry }) : undefined;
			if (!fileUri || !patched) {
				throw new Error(localize('vibeide.acp.registry.entryMoved', "запись агента не найдена в файле, из которого она пришла"));
			}
			await this._fileService.writeFile(fileUri, VSBuffer.fromString(patched));
			if (plan.kind === 'binary') {
				// A running session may still hold the old binary (Windows refuses to delete it then): the
				// update is done either way, and the old folder goes with the next update.
				await this._installer.removeBinary(next.agent.id, next.from).catch(() => { });
			}
			this._audit(next.agent, plan, layer, next.from);
			await this._registry.reload();
			this._notifications.info(localize('vibeide.acp.registry.updated', "«{0}» обновлён до {1}. Уже открытые сессии работают на прежней версии до переподключения.", entry.name ?? entry.id, next.to));
		} catch (err) {
			this._notifications.error(localize('vibeide.acp.registry.updateFailed', "Не удалось обновить «{0}»: {1}", entry.name ?? entry.id, err instanceof Error ? err.message : String(err)));
		}
	}

	private async _pickLayer(): Promise<VibeAgentLayer | undefined> {
		type LayerItem = IQuickPickItem & { readonly layer: VibeAgentLayer };
		const picked = await this._quickInput.pick<LayerItem>([
			{ layer: 'project', label: localize('vibeide.acp.registry.layer.project', "В проект"), description: '.vibe/agents.json', detail: localize('vibeide.acp.registry.layer.projectDetail', "Файл едет в репозитории — агент появится у всей команды") },
			{ layer: 'machine', label: localize('vibeide.acp.registry.layer.machine', "На эту машину"), description: '~/.vibe/agents.json', detail: localize('vibeide.acp.registry.layer.machineDetail', "Только здесь, во всех проектах; запись проекта с тем же id сильнее") },
		], { placeHolder: localize('vibeide.acp.registry.layer', "Куда записать агента") });
		return picked?.layer;
	}

	private async _install(agent: IAcpRegistryAgent, plan: Extract<AcpInstallPlan, { kind: 'binary' }>): Promise<string> {
		return this._progress.withProgress(
			{ location: ProgressLocation.Notification, title: localize('vibeide.acp.registry.installing', "Скачиваю «{0}» и сверяю контрольную сумму…", agent.name) },
			() => this._installer.installBinary({
				agentId: agent.id,
				version: agent.version,
				archive: plan.binary.archive,
				sha256: plan.binary.sha256,
				format: plan.format,
				cmd: plan.binary.cmd,
			}),
		);
	}

	private async _agentsOrReport(force: boolean): Promise<readonly IAcpRegistryAgent[] | undefined> {
		try {
			return await this._progress.withProgress(
				{ location: ProgressLocation.Notification, title: localize('vibeide.acp.registry.fetching', "Читаю реестр ACP…") },
				() => this._agents(force),
			);
		} catch (err) {
			this._notifications.error(localize('vibeide.acp.registry.fetchFailed', "Реестр ACP не прочитан: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
	}

	private async _agents(force: boolean): Promise<readonly IAcpRegistryAgent[]> {
		const url = this._configuration.getValue<string>(ACP_REGISTRY_URL_KEY);
		if (!url) {
			throw new Error(localize('vibeide.acp.registry.noUrl', "адрес реестра не задан ({0})", ACP_REGISTRY_URL_KEY));
		}
		const fresh = this._fetched && this._fetched.url === url && Date.now() - this._fetched.at < REGISTRY_CACHE_MS;
		if (!force && fresh && this._fetched) {
			return this._fetched.agents;
		}
		const { agents } = parseAcpRegistry(await this._installer.fetchRegistry(url));
		this._fetched = { at: Date.now(), url, agents };
		return agents;
	}

	private _recomputeUpdates(): void {
		const agents = this._fetched?.agents ?? [];
		const updates = new Map<string, IAcpAgentUpdate>();
		for (const entry of this._registry.agents) {
			const next = registryUpdateOf(entry, agents);
			if (next) {
				updates.set(entry.id, { from: next.from, to: next.to });
			}
		}
		const changed = updates.size !== this._updates.size || [...updates].some(([id, update]) => this._updates.get(id)?.to !== update.to);
		this._updates = updates;
		if (changed) {
			this._onDidChangeUpdates.fire();
		}
	}

	private async _read(fileUri: URI): Promise<string | undefined> {
		try {
			return (await this._fileService.readFile(fileUri)).value.toString();
		} catch {
			return undefined;
		}
	}

	private _audit(agent: IAcpRegistryAgent, plan: Exclude<AcpInstallPlan, { kind: 'refused' }>, layer: VibeAgentLayer, updatedFrom?: string): void {
		if (!this._auditLog.isEnabled()) {
			return;
		}
		void this._auditLog.append({
			ts: Date.now(),
			actor: 'human',
			action: 'acp_agent_installed',
			ok: true,
			meta: {
				agentId: agent.id,
				version: agent.version,
				...(updatedFrom ? { updatedFrom } : {}),
				layer,
				...(plan.kind === 'package' ? { runner: plan.runner, package: plan.spec.package } : { archive: plan.binary.archive, sha256: plan.binary.sha256 }),
			},
		}).catch(() => { });
	}
}

function currentTarget(): AcpPlatformTarget | undefined {
	return platformTargetOf(platform, arch ?? '');
}

function planSummary(plan: AcpInstallPlan, target: AcpPlatformTarget | undefined): string {
	switch (plan.kind) {
		case 'package':
			return plan.runner === 'npx'
				? localize('vibeide.acp.registry.plan.npx', "запуск: npx {0}", plan.spec.package)
				: localize('vibeide.acp.registry.plan.uvx', "запуск: uvx {0} (нужен установленный uv)", plan.spec.package);
		case 'binary':
			return localize('vibeide.acp.registry.plan.binary', "скачать сборку {0} для {1}, sha256 сверяется", plan.format, target ?? '');
		case 'refused':
			return localize('vibeide.acp.registry.plan.refused', "нельзя: {0}", refusalText(plan.reason));
	}
}

function refusalText(reason: AcpInstallRefusal): string {
	switch (reason) {
		case 'noDistribution': return localize('vibeide.acp.registry.refusal.noDistribution', "реестр не говорит, как запускать этого агента");
		case 'noBuildForPlatform': return localize('vibeide.acp.registry.refusal.noBuild', "нет сборки для этой платформы");
		case 'noChecksum': return localize('vibeide.acp.registry.refusal.noChecksum', "у сборки нет контрольной суммы sha256 — скачанное нечем проверить");
		case 'unsupportedArchive': return localize('vibeide.acp.registry.refusal.archive', "архив в формате, который VibeIDE не распаковывает (tar.bz2, tar.xz, 7z)");
		case 'unpinnedPackage': return localize('vibeide.acp.registry.refusal.unpinned', "пакет без точной версии — запускалось бы то, что опубликовано в день запуска");
		case 'unsafeCommandPath': return localize('vibeide.acp.registry.refusal.path', "команда указывает за пределы архива");
	}
}

function confirmDetail(agent: IAcpRegistryAgent, plan: Exclude<AcpInstallPlan, { kind: 'refused' }>, layer: VibeAgentLayer): string {
	const what = plan.kind === 'package'
		? localize('vibeide.acp.registry.detail.package', "При каждом запуске сессии будет выполняться «{0} {1}» — пакет ставится из {2} ровно этой версии.", plan.runner, plan.spec.package, plan.runner === 'npx' ? 'npm' : 'PyPI')
		: localize('vibeide.acp.registry.detail.binary', "Будет скачан архив {0}; он принимается, только если его sha256 совпадёт с реестром ({1}). Бинарь ляжет в профиль VibeIDE.", plan.binary.archive, plan.binary.sha256);
	const where = layer === 'project'
		? localize('vibeide.acp.registry.detail.project', "Запись ляжет в .vibe/agents.json проекта и уедет в репозиторий.")
		: localize('vibeide.acp.registry.detail.machine', "Запись ляжет в ~/.vibe/agents.json этой машины.");
	const origin = [
		agent.license ? localize('vibeide.acp.registry.detail.license', "Лицензия: {0}{1}", agent.license, agent.licenseUrl ? ` (${agent.licenseUrl})` : '') : localize('vibeide.acp.registry.detail.noLicense', "Лицензия в реестре не указана."),
		agent.repository ? localize('vibeide.acp.registry.detail.repo', "Исходники: {0}", agent.repository) : localize('vibeide.acp.registry.detail.noRepo', "Ссылки на исходники в реестре нет."),
		agent.website ? localize('vibeide.acp.registry.detail.site', "Сайт: {0}", agent.website) : undefined,
	].filter(Boolean).join('\n');
	return [what, where, origin].join('\n\n');
}

registerSingleton(IVibeAcpRegistryImportService, VibeAcpRegistryImportService, InstantiationType.Delayed);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBE_ACP_ADD_FROM_REGISTRY_COMMAND_ID,
			title: localize2('vibeide.acp.registry.addCommand', "Внешние агенты: добавить из реестра ACP"),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IVibeAcpRegistryImportService).addFromRegistry();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBE_ACP_UPDATE_FROM_REGISTRY_COMMAND_ID,
			title: localize2('vibeide.acp.registry.updateCommand', "Внешние агенты: обновить агента из реестра ACP"),
			category: VIBE_COMMAND_CATEGORY,
			f1: false,
		});
	}
	run(accessor: ServicesAccessor, agentId: unknown): Promise<void> {
		return typeof agentId === 'string' ? accessor.get(IVibeAcpRegistryImportService).update(agentId) : Promise.resolve();
	}
});
