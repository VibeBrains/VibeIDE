/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The text-slop checks, run in a web worker under a time budget
 *
 * A pattern from `.vibe/slop.json` comes with the repository and can backtrack for hours; a regex cannot be interrupted
 * on its own thread, so the window never runs one. A check that outlives the budget terminates the worker and falls
 * back as `checkWithinBudget` describes; the next check gets a fresh worker
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IWebWorkerClient } from '../../../../base/common/worker/webWorker.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { parseSlopOverrides } from '../common/textSlop/slopCatalog.js';
import { checkWithinBudget, SlopWatchdogOutcome } from '../common/textSlop/slopWatchdog.js';
import { SlopFinding } from '../common/textSlop/textSlop.js';
import type { SlopWorkerReply, SlopWorkerRequest, TextSlopWorker } from '../common/textSlop/textSlopWorker.js';
import { IVibeTextSlopService, SLOP_CHECK_TIMEOUT_DEFAULT_MS, SLOP_CHECK_TIMEOUT_KEY, SLOP_PROJECT_FILE, TextSlopCheck } from '../common/textSlop/vibeTextSlopService.js';

/** The project's `.vibe/slop.json` as read for one check */
interface ProjectSlopFile {
	readonly text: string | undefined;
	readonly ruleIds: readonly string[];
	readonly warnings: readonly string[];
}

export class VibeTextSlopService extends Disposable implements IVibeTextSlopService {
	declare readonly _serviceBrand: undefined;

	private _worker: IWebWorkerClient<TextSlopWorker> | undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IWebWorkerService private readonly _webWorkerService: IWebWorkerService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._register({ dispose: () => this._stopWorker() });
	}

	async check(text: string, folder?: URI): Promise<TextSlopCheck | undefined> {
		const outcome = await this._run([text], false, folder);
		const report = outcome.reports?.[0];
		return report ? { report, warnings: outcome.warnings } : undefined;
	}

	async pageFindings(texts: readonly string[], folder?: URI): Promise<ReadonlyMap<string, readonly SlopFinding[]> | undefined> {
		const distinct = [...new Set(texts.filter(text => text.trim().length > 0))];
		const outcome = await this._run(distinct, true, folder);
		if (!outcome.reports) {
			return undefined;
		}
		const reports = outcome.reports;
		return new Map(distinct.map((text, i) => [text, reports[i].findings]));
	}

	private async _run(texts: readonly string[], lexical: boolean, folder: URI | undefined): Promise<SlopWatchdogOutcome> {
		const project = await this._readProjectFile(folder);
		const budgetMs = this._budgetMs();
		const request: SlopWorkerRequest = {
			texts,
			...(lexical ? { lexical: true } : {}),
			...(project.text !== undefined ? { overrides: project.text } : {}),
		};
		const outcome = await checkWithinBudget(req => this._runOnce(req, budgetMs), request, project.ruleIds, Math.round(budgetMs / 1000));
		return project.warnings.length > 0 ? { ...outcome, warnings: [...project.warnings, ...outcome.warnings] } : outcome;
	}

	/** One request in the worker; on the deadline the worker is terminated — the only way to stop a regex mid-match */
	private async _runOnce(request: SlopWorkerRequest, budgetMs: number): Promise<SlopWorkerReply | 'timeout'> {
		const worker = this._worker ??= this._webWorkerService.createWorkerClient<TextSlopWorker>(new WebWorkerDescriptor({
			esmModuleLocation: FileAccess.asBrowserUri('vs/workbench/contrib/vibeide/common/textSlop/textSlopWorkerMain.js'),
			label: 'TextSlopWorker',
		}));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs); });
		try {
			const answer = await Promise.race([worker.proxy.$check(request), deadline]);
			if (answer === 'timeout') {
				this._stopWorker();
			}
			return answer;
		} finally {
			clearTimeout(timer);
		}
	}

	private _stopWorker(): void {
		this._worker?.dispose();
		this._worker = undefined;
	}

	private _budgetMs(): number {
		const configured = this._configurationService.getValue<number>(SLOP_CHECK_TIMEOUT_KEY);
		return typeof configured === 'number' && configured >= 1000 ? configured : SLOP_CHECK_TIMEOUT_DEFAULT_MS;
	}

	/** Parsed here only for the rule ids — no pattern is compiled or run on the window thread */
	private async _readProjectFile(folder: URI | undefined): Promise<ProjectSlopFile> {
		const root = folder ?? this._workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return { text: undefined, ruleIds: [], warnings: [] };
		}
		const file = joinPath(root, SLOP_PROJECT_FILE);
		try {
			if (!await this._fileService.exists(file)) {
				return { text: undefined, ruleIds: [], warnings: [] };
			}
			const text = (await this._fileService.readFile(file)).value.toString();
			// The worker repeats the parse and reports its warnings; here they would only be said twice.
			const ruleIds = parseSlopOverrides(text, () => { }).rules.map(rule => rule.id);
			return { text, ruleIds, warnings: [] };
		} catch (error) {
			return { text: undefined, ruleIds: [], warnings: [`${SLOP_PROJECT_FILE}: ${error instanceof Error ? error.message : String(error)}`] };
		}
	}
}

registerSingleton(IVibeTextSlopService, VibeTextSlopService, InstantiationType.Delayed);
