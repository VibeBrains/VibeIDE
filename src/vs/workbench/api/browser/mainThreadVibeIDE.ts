/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import {
	ExtHostContext,
	ExtHostVibeIDEShape,
	MainContext,
	MainThreadVibeIDEShape,
	VibeIDEAgentStatusDTO,
	VibeIDEConstraintQueryDTO,
	VibeIDEPlanEventDTO,
	VibeIDESkillEntryDTO,
} from '../common/extHost.protocol.js';
import { IChatThreadService } from '../../contrib/vibeide/browser/chatThreadService.js';
import { IVibeSkillsLibraryService } from '../../contrib/vibeide/common/vibeSkillsLibraryService.js';
import { IVibePlanEventJournalService } from '../../contrib/vibeide/common/vibePlanEventJournalService.js';
import { IVibeConstraintsService } from '../../contrib/vibeide/common/vibeConstraintsService.js';

const KNOWN_PLAN_EVENT_TYPES = new Set([
	'plan.created',
	'plan.step.started',
	'plan.step.completed',
	'plan.step.failed',
	'plan.completed',
	'plan.paused',
]);

@extHostNamedCustomer(MainContext.MainThreadVibeIDE)
export class MainThreadVibeIDE extends Disposable implements MainThreadVibeIDEShape {

	private readonly _proxy: ExtHostVibeIDEShape;
	private readonly _planSubscription = this._register(new MutableDisposable());

	constructor(
		context: IExtHostContext,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IVibeSkillsLibraryService private readonly _skillsLibrary: IVibeSkillsLibraryService,
		@IVibePlanEventJournalService private readonly _planJournal: IVibePlanEventJournalService,
		@IVibeConstraintsService private readonly _constraints: IVibeConstraintsService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();
		this._proxy = context.getProxy(ExtHostContext.ExtHostVibeIDE);
	}

	async $agentStatus(): Promise<VibeIDEAgentStatusDTO> {
		const streamState = this._chatThreadService.streamState;
		const running = Object.values(streamState).some(s => !!s?.isRunning);
		// Mode is not yet a first-class concept on the service; default to 'supervised'
		// to reflect that workflows require user approval to execute.
		const mode: VibeIDEAgentStatusDTO['mode'] = 'supervised';
		const vibeVersion = String((this._productService as unknown as { vibeVersion?: string }).vibeVersion ?? this._productService.version ?? '0.0.0');
		return { mode, running, vibeVersion };
	}

	async $skillsList(): Promise<readonly VibeIDESkillEntryDTO[]> {
		const skills = await this._skillsLibrary.getSkills();
		return skills.map(s => ({
			id: s.skillId,
			path: s.relativePath,
			name: s.title,
			description: s.description,
			vibeVersion: s.vibeVersion,
			origin: s.relativePath.includes('.vibe/skills') || s.relativePath.includes('.vibe\\skills') ? 'workspace' : 'global',
		}));
	}

	async $plansSubscribe(): Promise<void> {
		if (this._planSubscription.value) {
			return;
		}
		this._planSubscription.value = this._planJournal.onEvent(record => {
			const dto = coerceToPlanEventDTO(record);
			if (dto) {
				this._proxy.$onPlanEvent(dto);
			}
		});
	}

	async $plansUnsubscribe(): Promise<void> {
		this._planSubscription.clear();
	}

	async $constraintsQueryAllowed(query: VibeIDEConstraintQueryDTO): Promise<boolean> {
		try {
			if (query.tool === 'write') {
				this._constraints.checkWriteAllowed(query.target);
				return true;
			}
			if (query.tool === 'read') {
				this._constraints.checkReadAllowed(query.target);
				return true;
			}
			// Unknown tools default to deny on the read-only surface.
			return false;
		} catch {
			return false;
		}
	}
}

function coerceToPlanEventDTO(record: Record<string, unknown>): VibeIDEPlanEventDTO | undefined {
	const type = typeof record.type === 'string' ? record.type : undefined;
	if (!type || !KNOWN_PLAN_EVENT_TYPES.has(type)) {
		return undefined;
	}
	const planId = typeof record.planId === 'string' ? record.planId : '';
	if (!planId) {
		return undefined;
	}
	switch (type) {
		case 'plan.created':
		case 'plan.completed':
			return { type, planId } as VibeIDEPlanEventDTO;
		case 'plan.paused':
			return { type, planId, reason: typeof record.reason === 'string' ? record.reason : '' };
		case 'plan.step.started':
		case 'plan.step.completed':
			return { type, planId, stepNumber: typeof record.stepNumber === 'number' ? record.stepNumber : 0 } as VibeIDEPlanEventDTO;
		case 'plan.step.failed':
			return {
				type,
				planId,
				stepNumber: typeof record.stepNumber === 'number' ? record.stepNumber : 0,
				reason: typeof record.reason === 'string' ? record.reason : '',
			};
	}
	return undefined;
}
