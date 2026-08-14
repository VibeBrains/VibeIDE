/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Repository state for the agent, read through the main process.
 *
 * The four git reads already existed there for commit-message generation; this only offers them to
 * the chat without a terminal in between. Every method answers with a sentence instead of throwing:
 * a tool that raises on "not a git repository" teaches the model to avoid the tool, whereas a plain
 * answer lets it decide what to do next.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { IVibeGitReadService, IVibeideSCMService } from '../common/vibeideSCMTypes.js';

class VibeGitReadService extends Disposable implements IVibeGitReadService {
	declare readonly _serviceBrand: undefined;

	private readonly _scm: IVibeideSCMService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		this._scm = ProxyChannel.toService<IVibeideSCMService>(mainProcessService.getChannel('vibeide-channel-scm'));
	}

	private _folderPath(): string | undefined {
		return this._workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	/**
	 * Run one read, turning both "no folder" and a git failure into readable text.
	 *
	 * The error text is passed through rather than replaced: "not a git repository" and "detached
	 * HEAD" mean different things to whoever reads the answer, and flattening them into one message
	 * would hide exactly the detail that decides the next step.
	 */
	private async _read(what: (path: string) => Promise<string>, empty: string): Promise<string> {
		const path = this._folderPath();
		if (!path) {
			return localize('vibeide.git.noFolder', 'Папка не открыта — состояние репозитория недоступно.');
		}
		try {
			const out = (await what(path))?.trim();
			return out ? out : empty;
		} catch (err) {
			return localize('vibeide.git.failed', 'Не удалось прочитать состояние git: {0}', err instanceof Error ? err.message : String(err));
		}
	}

	stat(): Promise<string> {
		return this._read(p => this._scm.gitStat(p), localize('vibeide.git.noChanges', 'Изменений нет — рабочая папка чистая.'));
	}

	sampledDiffs(): Promise<string> {
		return this._read(p => this._scm.gitSampledDiffs(p), localize('vibeide.git.noDiffs', 'Изменений нет — показывать нечего.'));
	}

	branch(): Promise<string> {
		return this._read(p => this._scm.gitBranch(p), localize('vibeide.git.noBranch', 'Ветку определить не удалось.'));
	}

	log(): Promise<string> {
		return this._read(p => this._scm.gitLog(p), localize('vibeide.git.noLog', 'В репозитории пока нет коммитов.'));
	}

	couplingLog(days: number, maxCommits: number): Promise<string> {
		return this._read(
			p => this._scm.gitCouplingLog(p, days, maxCommits),
			localize('vibeide.git.noHistory', 'История коммитов за этот период пуста.'));
	}
}

registerSingleton(IVibeGitReadService, VibeGitReadService, InstantiationType.Delayed);
