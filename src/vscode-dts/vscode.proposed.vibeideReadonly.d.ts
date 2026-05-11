/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// VibeIDE proposed API — read-only surface for third-party extensions.
// Roadmap §M.3 / L1122.
//
// Opt-in: { "enabledApiProposals": ["vibeideReadonly"] } in extension package.json.
//
// ExtHost wiring lives in src/vs/workbench/api/common/extHostVibeIDE.ts and is
// bridged through MainThreadVibeIDE → workbench services
// (IChatThreadService, IVibeSkillsLibraryService, IVibePlanEventJournalService,
//  IVibeConstraintsService).

declare module 'vscode' {

	export namespace vibeide {

		/** Read-only view onto VibeIDE's agent runtime state. */
		export namespace agent {
			export function status(): Thenable<AgentStatusSnapshot>;
		}

		/** Read-only view onto the workspace's `.vibe/skills/` library. */
		export namespace skills {
			export function list(): Thenable<readonly SkillEntry[]>;
		}

		/** Read-only view onto persisted plans under `.vibe/plans/`. */
		export namespace plans {
			export function subscribeToEvents(listener: (event: PlanEvent) => void): Disposable;
		}

		/** Read-only view onto the workspace's `.vibe/constraints.json`. */
		export namespace constraints {
			export function queryAllowed(query: ConstraintQuery): Thenable<boolean>;
		}

		export interface AgentStatusSnapshot {
			readonly mode: 'manual' | 'supervised' | 'auto';
			readonly running: boolean;
			readonly vibeVersion: string;
		}

		export interface SkillEntry {
			readonly id: string;
			readonly path: string;
			readonly name: string;
			readonly description: string;
			readonly vibeVersion?: string;
			readonly origin: 'workspace' | 'global';
		}

		export type PlanEvent =
			| { readonly type: 'plan.created'; readonly planId: string }
			| { readonly type: 'plan.step.started'; readonly planId: string; readonly stepNumber: number }
			| { readonly type: 'plan.step.completed'; readonly planId: string; readonly stepNumber: number }
			| { readonly type: 'plan.step.failed'; readonly planId: string; readonly stepNumber: number; readonly reason: string }
			| { readonly type: 'plan.completed'; readonly planId: string }
			| { readonly type: 'plan.paused'; readonly planId: string; readonly reason: string };

		export interface ConstraintQuery {
			readonly tool: string;
			readonly target: string;
		}
	}
}
