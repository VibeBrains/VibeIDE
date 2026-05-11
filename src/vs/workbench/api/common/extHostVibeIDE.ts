/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import {
	ExtHostVibeIDEShape,
	IMainContext,
	MainContext,
	MainThreadVibeIDEShape,
	VibeIDEPlanEventDTO,
} from './extHost.protocol.js';

// L1122 — wiring of the `vibeide` proposed namespace to MainThreadVibeIDE.
// Surface is defined in src/vscode-dts/vscode.proposed.vibeideReadonly.d.ts.

export class ExtHostVibeIDE extends Disposable implements ExtHostVibeIDEShape {

	private readonly _proxy: MainThreadVibeIDEShape;
	private readonly _onPlanEvent = this._register(new Emitter<VibeIDEPlanEventDTO>());
	private readonly _planEvent: Event<VibeIDEPlanEventDTO> = this._onPlanEvent.event;
	private _planSubscriberCount = 0;

	constructor(mainContext: IMainContext) {
		super();
		this._proxy = mainContext.getProxy(MainContext.MainThreadVibeIDE);
	}

	$onPlanEvent(event: VibeIDEPlanEventDTO): void {
		this._onPlanEvent.fire(event);
	}

	// — agent.status —

	agentStatus(): Promise<vscode.vibeide.AgentStatusSnapshot> {
		return this._proxy.$agentStatus();
	}

	// — skills.list —

	async skillsList(): Promise<readonly vscode.vibeide.SkillEntry[]> {
		return this._proxy.$skillsList();
	}

	// — plans.subscribeToEvents —

	plansSubscribeToEvents(listener: (event: vscode.vibeide.PlanEvent) => void): vscode.Disposable {
		const store = new DisposableStore();
		if (this._planSubscriberCount === 0) {
			// Fire-and-forget; main side starts streaming events on success.
			this._proxy.$plansSubscribe().catch(() => { /* swallow — read-only surface */ });
		}
		this._planSubscriberCount++;
		store.add(this._planEvent(event => listener(event as vscode.vibeide.PlanEvent)));
		store.add({
			dispose: () => {
				this._planSubscriberCount = Math.max(0, this._planSubscriberCount - 1);
				if (this._planSubscriberCount === 0) {
					this._proxy.$plansUnsubscribe().catch(() => { /* swallow */ });
				}
			},
		});
		return store;
	}

	// — constraints.queryAllowed —

	constraintsQueryAllowed(query: vscode.vibeide.ConstraintQuery): Promise<boolean> {
		return this._proxy.$constraintsQueryAllowed({ tool: query.tool, target: query.target });
	}
}
