/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export interface GitBlameInfo {
	filePath: string;
	lineNumber: number;
	author: string;
	email: string;
	date: string;
	commitHash: string;
	commitMessage: string;
	isAgentCommit: boolean; // Co-authored-by: VibeIDE Agent
}

export const IVibeGitBlameService = createDecorator<IVibeGitBlameService>('vibeGitBlameService');

export interface IVibeGitBlameService {
	readonly _serviceBrand: undefined;

	/**
	 * Get git blame info for a specific line.
	 * Used when agent proposes a change — shows who wrote the original line.
	 */
	getBlameForLine(filePath: string, lineNumber: number): Promise<GitBlameInfo | null>;

	/**
	 * Check if a line was written by VibeIDE Agent.
	 * Uses Co-authored-by: VibeIDE Agent marker in commit message.
	 */
	isAgentWritten(filePath: string, lineNumber: number): Promise<boolean>;
}

/**
 * VibeIDE Git Blame in Agent Context.
 * Shows original author when agent proposes changes.
 * Compliance: distinguishes human-written vs AI-written code.
 */
class VibeGitBlameService extends Disposable implements IVibeGitBlameService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
	}

	async getBlameForLine(filePath: string, lineNumber: number): Promise<GitBlameInfo | null> {
		try {
			// Use VS Code's built-in git extension for blame
			// The actual implementation will use git.getLineBlame command
			const blameInfo = await this._commandService.executeCommand<{
				author: string;
				authorEmail: string;
				date: string;
				hash: string;
				message: string;
			}>('git.getLineBlame', filePath, lineNumber);

			if (!blameInfo) { return null; }

			return {
				filePath,
				lineNumber,
				author: blameInfo.author,
				email: blameInfo.authorEmail,
				date: blameInfo.date,
				commitHash: blameInfo.hash,
				commitMessage: blameInfo.message,
				isAgentCommit: blameInfo.message?.includes('VibeIDE Agent') || blameInfo.authorEmail?.includes('agent@vibeide'),
			};
		} catch {
			// git extension may not have this command — graceful fallback
			return null;
		}
	}

	async isAgentWritten(filePath: string, lineNumber: number): Promise<boolean> {
		const blame = await this.getBlameForLine(filePath, lineNumber);
		return blame?.isAgentCommit ?? false;
	}
}

registerSingleton(IVibeGitBlameService, VibeGitBlameService, InstantiationType.Delayed);
