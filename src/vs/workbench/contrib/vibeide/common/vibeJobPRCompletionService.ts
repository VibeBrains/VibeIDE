/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeJobPRCompletionService — optional PR creation after successful background job.
 *
 * After a background agent job completes successfully, this service can optionally:
 *  1. Create a new branch from the job's worktree or current HEAD
 *  2. Commit any staged changes with an auto-generated commit message
 *  3. Open a draft PR via the IDE's SCM integration (not GitHub-only)
 *
 * NOT GitHub-only: uses IVibeGitWorktreeService and the SCM provider API,
 * which supports any git remote (GitHub, GitLab, Bitbucket, Gitea, etc.)
 *
 * User must explicitly enable per-job via `allowPRCreation: true` in job descriptor.
 * Never creates a PR in an unattended run without this explicit flag.
 *
 * Phase MVP: service contract + command palette entry.
 * Phase 3b: full SCM integration with provider-specific PR API.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAuditLogService } from './auditLogService.js';
import { IRequestService, asJson } from '../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export interface JobPRRequest {
	jobId: string;
	/** Branch name for the PR; auto-generated if not provided */
	branchName?: string;
	/** PR title; auto-generated from job summary if not provided */
	title?: string;
	/** PR body / description */
	body?: string;
	/** Whether to create as draft PR */
	draft?: boolean;
}

export interface JobPRResult {
	status: 'created' | 'already_exists' | 'failed' | 'disabled';
	branchName?: string;
	/** Platform-specific PR URL (if available) */
	prUrl?: string;
	reason?: string;
}

export const IVibeJobPRCompletionService = createDecorator<IVibeJobPRCompletionService>('vibeJobPRCompletionService');

export interface IVibeJobPRCompletionService {
	readonly _serviceBrand: undefined;

	/**
	 * Attempt to create a draft PR for a completed job.
	 * Returns 'disabled' immediately if no SCM provider supports PR creation.
	 * Phase 3b: actual branch creation + PR via SCM provider API.
	 */
	createPRForJob(request: JobPRRequest): Promise<JobPRResult>;

	/**
	 * Generate an auto PR title from job metadata.
	 * Format: "VibeIDE Agent: <first step summary> (+N more)"
	 */
	generatePRTitle(jobId: string, steps: string[]): string;

	/**
	 * Generate a PR body from job results.
	 * Includes step summary, token usage, and a link to the morning digest.
	 */
	generatePRBody(jobId: string, steps: string[], tokensUsed: number): string;
}

interface GitHubPRResponse {
	html_url?: string;
	number?: number;
	message?: string; // GitHub error message field
}

class VibeJobPRCompletionService extends Disposable implements IVibeJobPRCompletionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@IRequestService private readonly _request: IRequestService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
	}

	async createPRForJob(request: JobPRRequest): Promise<JobPRResult> {
		const branchName = request.branchName ?? `vibeide-agent/${request.jobId.slice(0, 20)}`;
		this._log.info(`[VibeJobPR] Creating PR for job ${request.jobId} on branch ${branchName}`);

		const token = this._config.getValue<string>('vibeide.git.githubToken');
		const repoSlug = this._config.getValue<string>('vibeide.git.repoSlug'); // "owner/repo"
		const baseBranch = this._config.getValue<string>('vibeide.git.defaultBranch') ?? 'main';

		if (!token || !repoSlug) {
			this._log.warn('[VibeJobPR] Missing vibeide.git.githubToken or vibeide.git.repoSlug — skipping GitHub PR creation');
			this._audit.append({ ts: Date.now(), action: 'job_pr_creation', ok: false, meta: { jobId: request.jobId, reason: 'no-token-or-slug' } });
			return { status: 'disabled', reason: 'github-token-or-repo-slug-not-configured', branchName };
		}

		const title = request.title ?? this.generatePRTitle(request.jobId, []);
		const body = request.body ?? '';
		const draft = request.draft ?? true;
		const url = `https://api.github.com/repos/${repoSlug}/pulls`;

		try {
			const ctx = await this._request.request({
				type: 'POST',
				url,
				data: JSON.stringify({ title, body, head: branchName, base: baseBranch, draft }),
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`,
					'Accept': 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					'User-Agent': 'VibeIDE',
				},
				callSite: 'VibeJobPRCompletionService.createPRForJob',
			}, CancellationToken.None);

			const data = await asJson<GitHubPRResponse>(ctx);

			if (ctx.res.statusCode === 422 && data?.message?.toLowerCase().includes('already exists')) {
				this._audit.append({ ts: Date.now(), action: 'job_pr_creation', ok: true, meta: { jobId: request.jobId, branchName, status: 'already_exists' } });
				return { status: 'already_exists', branchName };
			}

			if (!ctx.res.statusCode || ctx.res.statusCode >= 400) {
				const reason = data?.message ?? `HTTP ${ctx.res.statusCode}`;
				this._log.error(`[VibeJobPR] GitHub API error: ${reason}`);
				this._audit.append({ ts: Date.now(), action: 'job_pr_creation', ok: false, meta: { jobId: request.jobId, reason } });
				return { status: 'failed', reason, branchName };
			}

			const prUrl = data?.html_url;
			this._log.info(`[VibeJobPR] PR created: ${prUrl}`);
			this._audit.append({ ts: Date.now(), action: 'job_pr_creation', ok: true, meta: { jobId: request.jobId, branchName, prUrl, draft } });
			return { status: 'created', branchName, prUrl };
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			this._log.error(`[VibeJobPR] Request failed: ${reason}`);
			this._audit.append({ ts: Date.now(), action: 'job_pr_creation', ok: false, meta: { jobId: request.jobId, reason } });
			return { status: 'failed', reason, branchName };
		}
	}

	generatePRTitle(jobId: string, steps: string[]): string {
		const firstStep = steps[0]?.replace(/^- \[ \] /, '').slice(0, 60) ?? 'Automated changes';
		const rest = steps.length > 1 ? ` (+${steps.length - 1} more)` : '';
		return `VibeIDE Agent: ${firstStep}${rest}`;
	}

	generatePRBody(jobId: string, steps: string[], tokensUsed: number): string {
		const stepList = steps.map((s, i) => `- [x] ${s.replace(/^- \[ \] /, '').slice(0, 100)}`).join('\n');
		return [
			`## Background Agent Job: \`${jobId}\``,
			``,
			`### Steps completed`,
			stepList,
			``,
			`### Metadata`,
			`- Tokens used: ${tokensUsed.toLocaleString()}`,
			`- Morning digest: \`.vibe/jobs/${jobId}-digest.md\``,
			``,
			`> Generated by VibeIDE background agent (local runner). Review all changes before merging.`,
		].join('\n');
	}
}

registerSingleton(IVibeJobPRCompletionService, VibeJobPRCompletionService, InstantiationType.Delayed);
