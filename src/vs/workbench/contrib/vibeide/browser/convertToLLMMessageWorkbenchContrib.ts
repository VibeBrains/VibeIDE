/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeideModelService } from '../common/vibeideModelService.js';
import { IVibeProjectRulesService } from './vibeProjectRulesService.js';

class ConvertContribWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibe.convertcontrib';
	_serviceBrand: undefined;

	constructor(
		@IVibeideModelService private readonly vibeideModelService: IVibeideModelService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IVibeProjectRulesService private readonly projectRulesService: IVibeProjectRulesService,
	) {
		super();

		const initializeURI = (uri: URI) => {
			this.workspaceContext.getWorkspace();
			const vibeRulesMdURI = URI.joinPath(uri, '.vibe', 'rules.md');
			void this.vibeideModelService.initializeModel(vibeRulesMdURI);
			const agentsMdURI = URI.joinPath(uri, 'AGENTS.md');
			void this.vibeideModelService.initializeModel(agentsMdURI);
		};

		// call
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders((e) => {
			[...e.changed, ...e.added].forEach(w => { initializeURI(w.uri); });
		}));
		this.workspaceContext.getWorkspace().folders.forEach(w => { initializeURI(w.uri); });

		// Load project rules (.vibe/rules.md, AGENTS.md) into cache
		void this.projectRulesService.reloadRules();
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders(() => {
			void this.projectRulesService.reloadRules();
		}));
	}
}


registerWorkbenchContribution2(ConvertContribWorkbenchContribution.ID, ConvertContribWorkbenchContribution, WorkbenchPhase.BlockRestore);
