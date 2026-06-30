/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAuditLogService } from './auditLogService.js';

export interface ProjectHealthSnapshot {
	sessionId: string;
	timestamp: number;
	testCoverage?: { before: number; after: number };
	complexityDelta?: number;
	securityIssues: number;
	tokenEfficiency: number; // tokens per line of code
	aiAssistedLines: number;
	manualLines: number;
	totalActions: number;
}

export const IVibeProjectHealthService = createDecorator<IVibeProjectHealthService>('vibeProjectHealthService');

export interface IVibeProjectHealthService {
	readonly _serviceBrand: undefined;
	captureSnapshot(): Promise<ProjectHealthSnapshot>;
	getLastSnapshot(): ProjectHealthSnapshot | null;
	generateReport(): string;
}

/**
 * VibeIDE Project Health Dashboard.
 * After session: coverage delta, complexity delta, security issues, token efficiency.
 */
class VibeProjectHealthService extends Disposable implements IVibeProjectHealthService {
	declare readonly _serviceBrand: undefined;

	private _lastSnapshot: ProjectHealthSnapshot | null = null;

	constructor(
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
	}

	async captureSnapshot(): Promise<ProjectHealthSnapshot> {
		const events = await this._auditLogService.queryRecent(1000);
		const aiActions = events.filter(e => ['apply', 'prompt'].includes(e.action));
		const totalFiles = new Set(events.flatMap(e => e.files || [])).size;

		const snapshot: ProjectHealthSnapshot = {
			sessionId: `session-${Date.now()}`,
			timestamp: Date.now(),
			securityIssues: 0, // Phase 2: integrate with VibeDependencyVulnService
			tokenEfficiency: aiActions.length > 0 ? Math.round(totalFiles / aiActions.length * 10) / 10 : 0,
			aiAssistedLines: events.filter(e => e.action === 'apply').length * 10, // Estimate
			manualLines: 0, // Phase 2: git diff analysis
			totalActions: events.length,
		};

		this._lastSnapshot = snapshot;
		vibeLog.info('ProjectHealth', `Snapshot: ${events.length} actions, ${totalFiles} files`);
		return snapshot;
	}

	getLastSnapshot(): ProjectHealthSnapshot | null {
		return this._lastSnapshot;
	}

	generateReport(): string {
		const s = this._lastSnapshot;
		if (!s) { return 'No snapshot available. Run a session first.'; }

		return [
			'## Project Health Report',
			`Session: ${new Date(s.timestamp).toISOString()}`,
			`Total actions: ${s.totalActions}`,
			`AI-assisted lines (est.): ${s.aiAssistedLines}`,
			`Token efficiency: ${s.tokenEfficiency} files/action`,
			`Security issues: ${s.securityIssues}`,
			'',
			'*Phase 2: test coverage delta, complexity delta, git blame attribution*',
		].join('\n');
	}
}

registerSingleton(IVibeProjectHealthService, VibeProjectHealthService, InstantiationType.Delayed);
