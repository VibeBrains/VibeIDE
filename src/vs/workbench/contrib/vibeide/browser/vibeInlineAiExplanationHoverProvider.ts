/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Inline AI explanations hover provider (roadmap §K.3 L929).
 *
 * Registers a hover provider for all files. When the cursor is over a line the
 * agent wrote (tracked by IVibeGutterIndicatorService), the hover shows:
 *   - which session wrote the line, model used, when it happened
 *   - the plan step title (if a plan was active)
 *   - the tool rationale from the nearest audit-log entry
 *
 * Uses `formatInlineAiExplanation` from the pure helper for the markdown body.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import * as languages from '../../../../editor/common/languages.js';
import { IVibeGutterIndicatorService } from './vibeGutterIndicatorService.js';
import { IAuditLogService, AuditEvent } from '../common/auditLogService.js';
import {
	formatInlineAiExplanation,
	SessionRef,
	PlanStepRef,
	ToolRationaleRef,
	AgentWriteRange,
} from '../common/inlineAiExplanationFormatter.js';

export class VibeInlineAiExplanationHoverProvider extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeInlineAiExplanationHoverProvider';

	constructor(
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IVibeGutterIndicatorService private readonly _gutterService: IVibeGutterIndicatorService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
		this._register(
			this._languageFeaturesService.hoverProvider.register(
				{ pattern: '**' },
				{ provideHover: (model, position, token) => this._provideHover(model, position, token) },
			),
		);
	}

	private async _provideHover(
		model: ITextModel,
		position: Position,
		_token: CancellationToken,
	): Promise<languages.Hover | undefined> {
		const filePath = model.uri.fsPath;
		const ranges = this._gutterService.getAgentRanges(filePath);
		if (!ranges.length) {
			return undefined;
		}

		const line = position.lineNumber;
		const match = ranges.find(r => line >= r.startLine && line <= r.endLine);
		if (!match) {
			return undefined;
		}

		// Audit log for context — best-effort; hover degrades gracefully on failure.
		let events: AuditEvent[] = [];
		try {
			events = await this._auditLogService.queryRecent(30);
		} catch {
			// ignore
		}

		const session: SessionRef = this._buildSessionRef(match.sessionId, match.timestamp, events);
		const planStep: PlanStepRef | undefined = this._findPlanStep(events, match.timestamp);
		const rationale: ToolRationaleRef | undefined = this._findRationale(events, match.timestamp);

		const writeRange: AgentWriteRange = {
			filePathBasename: filePath.replace(/\\/g, '/').split('/').pop() ?? filePath,
			startLine: match.startLine,
			endLine: match.endLine,
		};

		const { markdown } = formatInlineAiExplanation({ session, planStep, rationale, writeRange });

		return {
			contents: [new MarkdownString(markdown, { isTrusted: false })],
			range: {
				startLineNumber: match.startLine,
				startColumn: 1,
				endLineNumber: match.endLine,
				endColumn: model.getLineLength(match.endLine) + 1,
			},
		};
	}

	private _buildSessionRef(sessionId: string, timestamp: number, events: AuditEvent[]): SessionRef {
		// Find the nearest prompt event to extract model + summary.
		const promptEvent = this._nearestEvent(events, timestamp, 'prompt');
		return {
			sessionId,
			modelId: promptEvent?.model,
			promptSummary: promptEvent?.meta?.['summary'] as string | undefined,
			timestampMs: timestamp,
		};
	}

	private _findPlanStep(events: AuditEvent[], timestamp: number): PlanStepRef | undefined {
		const ev = this._nearestEvent(events, timestamp, 'plan_step_completed');
		if (!ev?.meta) {
			return undefined;
		}
		const { planId, stepIdx, stepTitle } = ev.meta as Record<string, unknown>;
		if (typeof planId !== 'string' || typeof stepTitle !== 'string') {
			return undefined;
		}
		return {
			planId,
			stepIdx: typeof stepIdx === 'number' ? stepIdx : 0,
			stepTitle,
		};
	}

	private _findRationale(events: AuditEvent[], timestamp: number): ToolRationaleRef | undefined {
		const ev = this._nearestEvent(events, timestamp, 'apply');
		if (!ev?.meta) {
			return undefined;
		}
		const { toolName, rationale } = ev.meta as Record<string, unknown>;
		if (typeof toolName !== 'string' || typeof rationale !== 'string') {
			return undefined;
		}
		return { toolName, rationale };
	}

	/** Find the event of `action` whose timestamp is closest to `targetMs`, within 30s. */
	private _nearestEvent(events: AuditEvent[], targetMs: number, action: AuditEvent['action']): AuditEvent | undefined {
		const window = 30_000;
		return events
			.filter(e => e.action === action && Math.abs(e.ts - targetMs) <= window)
			.sort((a, b) => Math.abs(a.ts - targetMs) - Math.abs(b.ts - targetMs))[0];
	}
}

registerWorkbenchContribution2(
	VibeInlineAiExplanationHoverProvider.ID,
	VibeInlineAiExplanationHoverProvider,
	WorkbenchPhase.AfterRestored,
);
