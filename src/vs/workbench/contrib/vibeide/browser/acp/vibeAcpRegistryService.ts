/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Реестр внешних агентов проекта: кого можно позвать в эту рабочую папку.
 *
 * Читает два файла и следит за обоими: команда добавляет агента и видит его в списке, не
 * перезапуская IDE. Разбор и проверка формата — в чистом `common/acp/vibeAgentsFile.ts`; здесь
 * только файловая часть.
 *
 * - `<проект>/.vibe/agents.json` едет в репозитории: набор агентов у команды общий, как дев-стек.
 * - `~/.vibe/agents.json` — машинный слой: агенты этой машины. Туда ложится бинарь, скачанный из
 *   реестра ACP, — абсолютный путь к нему в общем файле команды был бы бессмыслен.
 * При совпадении id проектная запись сильнее машинной.
 *
 * ОТСУТСТВИЕ ФАЙЛОВ — НЕ ОШИБКА, а сегодняшнее поведение: внешних агентов просто нет.
 */

import { IMCPService } from '../../common/mcpService.js';
import { vibeLog } from '../../common/vibeLog.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { VibeAgentEntry, VibeAgentLayer, activeAgents, mergeAgentLayers, parseVibeAgentsFileOrEmpty } from '../../common/acp/vibeAgentsFile.js';
import { IAcpAgentLaunch } from '../../common/acp/acpTypes.js';
import { ConfigGuardFinding, scanAgentsConfig } from '../../common/vibeConfigGuard.js';

export const IVibeAcpRegistryService = createDecorator<IVibeAcpRegistryService>('vibeAcpRegistryService');

export interface IVibeAcpRegistryService {
	readonly _serviceBrand: undefined;

	/** Меняется, когда файл реестра переписали. */
	readonly onDidChange: Event<void>;

	/** Агенты, которых стоит предлагать (выключенные записи отфильтрованы). */
	readonly agents: readonly VibeAgentEntry[];

	/** Жалобы последнего чтения: пропущенные записи, дубли. Показываются как предупреждение. */
	readonly problems: readonly string[];

	/** Config Guard findings of both files — the same rules as for the commands of MCP servers. */
	readonly guardFindings: readonly ConfigGuardFinding[];

	/** Перечитать файл. */
	reload(): Promise<void>;

	/** Как запускать эту запись: путь до рабочей папки уже развёрнут в абсолютный. */
	launchOf(agent: VibeAgentEntry): IAcpAgentLaunch | undefined;

	/** Which file the agent came from — adding and updating write back to that same file. */
	layerOf(agentId: string): VibeAgentLayer | undefined;

	/** The file of a layer; `undefined` for the project layer while no folder is open. */
	fileOf(layer: VibeAgentLayer): Promise<URI | undefined>;
}

const CONFIG_GUARD_ENABLED_KEY = 'vibeide.configGuard.enabled';
const CONFIG_GUARD_MODE_KEY = 'vibeide.configGuard.mode';

class VibeAcpRegistryService extends Disposable implements IVibeAcpRegistryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _agents: readonly VibeAgentEntry[] = [];
	private _layers = new Map<string, VibeAgentLayer>();
	private _problems: readonly string[] = [];
	private _guardFindings: readonly ConfigGuardFinding[] = [];
	private readonly _watch = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IMCPService private readonly _mcp: IMCPService,
		@IPathService private readonly _pathService: IPathService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => void this.reload()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_GUARD_ENABLED_KEY) || e.affectsConfiguration(CONFIG_GUARD_MODE_KEY)) {
				void this._readAndApply();
			}
		}));
		void this.reload();
	}

	get agents(): readonly VibeAgentEntry[] {
		return this._agents;
	}

	get problems(): readonly string[] {
		return this._problems;
	}

	get guardFindings(): readonly ConfigGuardFinding[] {
		return this._guardFindings;
	}

	layerOf(agentId: string): VibeAgentLayer | undefined {
		return this._layers.get(agentId);
	}

	async fileOf(layer: VibeAgentLayer): Promise<URI | undefined> {
		if (layer === 'machine') {
			return joinPath(await this._pathService.userHome(), '.vibe', 'agents.json');
		}
		const root = this._root();
		return root ? joinPath(root, '.vibe', 'agents.json') : undefined;
	}

	async reload(): Promise<void> {
		await this._watchFiles();
		await this._readAndApply();
	}

	launchOf(agent: VibeAgentEntry): IAcpAgentLaunch | undefined {
		const root = this._root();
		if (!root) { return undefined; }
		const cwd = agent.dir ? joinPath(root, agent.dir) : root;
		// Политика записи — единственный источник: нет списка, нет и серверов у гостя.
		const { servers: mcpServers, skipped } = agent.mcpServers?.length
			? this._mcp.getAcpMcpServers(agent.mcpServers)
			: { servers: [], skipped: [] };
		for (const miss of skipped) {
			// Пропуск называется вслух: гость без сервера ведёт себя так, будто сервер сломан, и без
			// этой строки причину искали бы у него.
			vibeLog.warn('ACP', `${agent.id}: сервер «${miss.name}» гостю не передан — ${miss.reason}`);
		}
		return {
			name: agent.name ?? agent.id,
			command: agent.command,
			args: agent.args ?? [],
			...(agent.env ? { env: agent.env } : {}),
			// Протокол требует абсолютный путь, а агент — обычный процесс: ему нужен путь файловой
			// системы, а не URI со схемой.
			cwd: cwd.fsPath,
			...(mcpServers.length > 0 ? { mcpServers } : {}),
		};
	}

	/** Отдельный наблюдатель на каждый файл: общий следил бы за целыми папками без нужды. */
	private async _watchFiles(): Promise<void> {
		const store = new DisposableStore();
		for (const layer of ['project', 'machine'] as const) {
			const fileUri = await this.fileOf(layer);
			if (!fileUri) { continue; }
			const watcher = store.add(this._fileService.createWatcher(fileUri, { recursive: false, excludes: [] }));
			store.add(watcher.onDidChange(() => void this._readAndApply()));
		}
		this._watch.value = store;
	}

	/** Прочитать оба файла и применить. Наблюдатели при этом не трогаются — они следят за теми же файлами. */
	private async _readAndApply(): Promise<void> {
		const project = parseVibeAgentsFileOrEmpty(await this._readText(await this.fileOf('project')));
		const machine = parseVibeAgentsFileOrEmpty(await this._readText(await this.fileOf('machine')));
		const listing = mergeAgentLayers(activeAgents(machine.agents), activeAgents(project.agents));
		const findings = scanAgentsConfig(listing.map(item => item.agent));
		const guardOn = this._configurationService.getValue<boolean>(CONFIG_GUARD_ENABLED_KEY) !== false;
		const blocking = guardOn && this._configurationService.getValue<string>(CONFIG_GUARD_MODE_KEY) === 'block';
		const blocked = new Set(blocking ? findings.filter(finding => finding.severity === 'critical').map(finding => finding.subject) : []);

		this._agents = listing.map(item => item.agent).filter(agent => !blocked.has(agent.id));
		this._layers = new Map(listing.map(item => [item.agent.id, item.layer]));
		this._guardFindings = guardOn ? findings : [];
		this._problems = [
			...project.problems.map(problem => `.vibe/agents.json: ${problem}`),
			...machine.problems.map(problem => `~/.vibe/agents.json: ${problem}`),
			...(guardOn ? findings.map(finding => `Config Guard: ${finding.message}${blocked.has(finding.subject) && finding.severity === 'critical' ? ' Агент не предлагается — режим block.' : ''}`) : []),
		];
		this._onDidChange.fire();
	}

	private async _readText(fileUri: URI | undefined): Promise<string | undefined> {
		if (!fileUri) { return undefined; }
		try {
			return (await this._fileService.readFile(fileUri)).value.toString();
		} catch {
			// Нет файла — внешних агентов из этого слоя нет. Это не повод жаловаться.
			return undefined;
		}
	}

	private _root(): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}
}

registerSingleton(IVibeAcpRegistryService, VibeAcpRegistryService, InstantiationType.Delayed);
