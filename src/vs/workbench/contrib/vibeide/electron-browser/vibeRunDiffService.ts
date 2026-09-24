/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { AgentReadRules, agentMayReadByRules } from '../common/agentReadPolicy.js';
import { stepMayWrite, WriteScope } from '../common/pipeline/vibePipelineFile.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { IVibeConstraintsService } from '../common/vibeConstraintsService.js';
import { IVibePerFilePermissionsService } from '../common/vibePerFilePermissionsService.js';
import { CollectedDiff, IChangedFile, IChangeSet, IVibeideSCMService, IVibeRunDiffService, RunDiffRequest } from '../common/vibeideSCMTypes.js';
import { PIPELINE_SNAPSHOT_STALE_MS } from '../common/workspaceChangesPolicy.js';
import { vibeLog } from '../common/vibeLog.js';
import { IVibeIgnoreService } from '../browser/vibeIgnoreService.js';

/**
 * The changes of a pipeline run, as an agent may see them.
 *
 * Git does the listing and the patching in the main process; here the files are placed in the open
 * folder, the agent's read rules decide what may be shown — the same rules as for its search
 * results — and secrets are masked before a section reaches a prompt.
 */
class VibeRunDiffService extends Disposable implements IVibeRunDiffService {
	declare readonly _serviceBrand: undefined;

	private readonly _readRules: AgentReadRules;

	constructor(
		@IVibeideSCMService private readonly _scm: IVibeideSCMService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@ISecretDetectionService private readonly _secrets: ISecretDetectionService,
		@IVibeIgnoreService ignore: IVibeIgnoreService,
		@IVibeConstraintsService constraints: IVibeConstraintsService,
		@IVibePerFilePermissionsService permissions: IVibePerFilePermissionsService,
	) {
		super();
		this._readRules = { ignore, constraints, permissions };
	}

	/** First workspace folder — the one a pipeline runs in. */
	private _folder(): URI | undefined {
		return this._workspace.getWorkspace().folders[0]?.uri;
	}

	async pin(run: string, label: string): Promise<string | undefined> {
		const folder = this._folder();
		if (!folder) {
			return undefined;
		}
		try {
			return await this._scm.pinPipelineSnapshot(folder.fsPath, run, label);
		} catch (error) {
			vibeLog.warn('RunDiff', `снимок ${run}/${label} не снят:`, error);
			return undefined;
		}
	}

	async collect(request: RunDiffRequest): Promise<CollectedDiff> {
		const folder = this._folder();
		if (!folder) {
			return { sections: [], files: 0, hidden: 0, unavailable: 'нет открытой папки' };
		}
		try {
			const sets: IChangeSet[] = [];
			if (request.since) {
				const set = await this._scm.listChanges(folder.fsPath, { kind: 'snapshot', commit: request.since });
				if (!set) {
					return { sections: [], files: 0, hidden: 0, unavailable: 'git не прочитал снимок, снятый перед первым шагом' };
				}
				sets.push(set);
			}
			for (const branch of request.branches) {
				const set = await this._scm.listChanges(folder.fsPath, { kind: 'branch', branch });
				if (set) {
					sets.push(set);
				} else {
					vibeLog.warn('RunDiff', `ветка ${branch} не прочитана — её работы в диффе не будет`);
				}
			}
			const sections: string[] = [];
			let files = 0;
			let hidden = 0;
			let used = 0;
			for (const set of sets) {
				const shown: IChangedFile[] = [];
				for (const file of set.files) {
					const verdict = this._verdict(file, set.prefix, folder, request.within);
					if (verdict === 'hidden') {
						hidden++;
					} else if (verdict === 'shown') {
						shown.push(file);
					}
				}
				files += shown.length;
				if (shown.length === 0 || used > request.maxChars) {
					continue;
				}
				for (const section of await this._scm.diffChanges(folder.fsPath, set.from, set.to, shown, request.maxChars - used)) {
					const masked = this._secrets.detectSecrets(section).redactedText;
					sections.push(masked);
					used += masked.length;
				}
			}
			return { sections, files, hidden };
		} catch (error) {
			vibeLog.warn('RunDiff', 'дифф прогона не собран:', error);
			return { sections: [], files: 0, hidden: 0, unavailable: 'git не смог собрать дифф — подробности в журнале' };
		}
	}

	/**
	 * Whether a changed file goes into the diff: `outside` when it lies outside the open folder or the
	 * scope asked for — not the step's business, and not counted; `hidden` when the agent's read rules
	 * close it — counted, so the judge knows something was held back.
	 */
	private _verdict(file: IChangedFile, prefix: string, folder: URI, within: WriteScope | undefined): 'shown' | 'hidden' | 'outside' {
		let hidden = false;
		for (const path of file.oldPath ? [file.path, file.oldPath] : [file.path]) {
			if (!path.startsWith(prefix)) {
				return 'outside';
			}
			if (!agentMayReadByRules(joinPath(folder, path.slice(prefix.length)), this._readRules)) {
				hidden = true;
			}
		}
		if (hidden) {
			return 'hidden';
		}
		return within && !stepMayWrite(within, file.path.slice(prefix.length)) ? 'outside' : 'shown';
	}

	async release(run: string): Promise<void> {
		const folder = this._folder();
		if (!folder) {
			return;
		}
		await this._scm.releasePipelineSnapshots(folder.fsPath, run).catch(() => { /* never throws by contract */ });
		// Pins of runs a window closed mid-run: nothing else would ever release them.
		await this._scm.prunePipelineSnapshots(folder.fsPath, PIPELINE_SNAPSHOT_STALE_MS).catch(() => 0);
	}
}

registerSingleton(IVibeRunDiffService, VibeRunDiffService, InstantiationType.Delayed);
