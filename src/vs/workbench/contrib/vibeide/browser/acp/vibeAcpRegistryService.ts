/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Реестр внешних агентов проекта: кого можно позвать в эту рабочую папку.
 *
 * Читает `.vibe/agents.json` из корня и следит за файлом: команда добавляет агента и видит его
 * в списке, не перезапуская IDE. Разбор и проверка формата — в чистом `common/acp/vibeAgentsFile.ts`;
 * здесь только файловая часть.
 *
 * ОТСУТСТВИЕ ФАЙЛА — НЕ ОШИБКА, а сегодняшнее поведение: внешних агентов просто нет.
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { VibeAgentEntry, activeAgents, parseVibeAgentsFileOrEmpty } from '../../common/acp/vibeAgentsFile.js';
import { IAcpAgentLaunch } from '../../common/acp/acpTypes.js';

export const IVibeAcpRegistryService = createDecorator<IVibeAcpRegistryService>('vibeAcpRegistryService');

export interface IVibeAcpRegistryService {
	readonly _serviceBrand: undefined;

	/** Меняется, когда файл реестра переписали. */
	readonly onDidChange: Event<void>;

	/** Агенты, которых стоит предлагать (выключенные записи отфильтрованы). */
	readonly agents: readonly VibeAgentEntry[];

	/** Жалобы последнего чтения: пропущенные записи, дубли. Показываются как предупреждение. */
	readonly problems: readonly string[];

	/** Перечитать файл. */
	reload(): Promise<void>;

	/** Как запускать эту запись: путь до рабочей папки уже развёрнут в абсолютный. */
	launchOf(agent: VibeAgentEntry): IAcpAgentLaunch | undefined;
}

class VibeAcpRegistryService extends Disposable implements IVibeAcpRegistryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _agents: readonly VibeAgentEntry[] = [];
	private _problems: readonly string[] = [];
	private readonly _watch = this._register(new MutableDisposable());

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => void this.reload()));
		void this.reload();
	}

	get agents(): readonly VibeAgentEntry[] {
		return this._agents;
	}

	get problems(): readonly string[] {
		return this._problems;
	}

	async reload(): Promise<void> {
		this._watchFile(this._registryUri());
		await this._readAndApply();
	}

	launchOf(agent: VibeAgentEntry): IAcpAgentLaunch | undefined {
		const root = this._root();
		if (!root) { return undefined; }
		const cwd = agent.dir ? joinPath(root, agent.dir) : root;
		return {
			name: agent.name ?? agent.id,
			command: agent.command,
			args: agent.args ?? [],
			...(agent.env ? { env: agent.env } : {}),
			// Протокол требует абсолютный путь, а агент — обычный процесс: ему нужен путь файловой
			// системы, а не URI со схемой.
			cwd: cwd.fsPath,
		};
	}

	/** Отдельный наблюдатель за одним файлом: общий следил бы за всей папкой без нужды. */
	private _watchFile(fileUri: URI | undefined): void {
		this._watch.clear();
		if (!fileUri) { return; }
		const watcher = this._fileService.createWatcher(fileUri, { recursive: false, excludes: [] });
		watcher.onDidChange(() => void this._readAndApply());
		this._watch.value = watcher;
	}

	/** Прочитать и применить. Наблюдатель при этом не трогается — он следит за тем же файлом. */
	private async _readAndApply(): Promise<void> {
		const fileUri = this._registryUri();
		let content: string | undefined;
		if (fileUri) {
			try {
				content = (await this._fileService.readFile(fileUri)).value.toString();
			} catch {
				// Нет файла — внешних агентов нет. Это не повод жаловаться.
				content = undefined;
			}
		}
		const parsed = parseVibeAgentsFileOrEmpty(content);
		this._agents = activeAgents(parsed.agents);
		this._problems = parsed.problems;
		this._onDidChange.fire();
	}

	private _registryUri(): URI | undefined {
		const root = this._root();
		return root ? joinPath(root, '.vibe', 'agents.json') : undefined;
	}

	private _root(): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}
}

registerSingleton(IVibeAcpRegistryService, VibeAcpRegistryService, InstantiationType.Delayed);
