/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — first-success onboarding hint
 * (roadmap §"Init и онбординг → Onboarding hint: при первом успешном запуске
 * — нотификация «Закрепить команду в верхнем баре?» с действием Pin").
 *
 * Pure decision helper — `vscode`-free — so the one-shot trigger logic can be
 * unit-tested without `INotificationService` / `IStorageService`. Caller
 * persists `OnboardingHintState` between sessions in `IStorageService`
 * (workspace scope) and consults this helper after every successful
 * command run.
 *
 * The hint is one-shot per workspace: once shown (regardless of whether the
 * user clicked Pin or dismissed) it never re-appears, so a power user does
 * not get nagged. Caller may surface a `Reset onboarding` palette command if
 * needed.
 */

export interface OnboardingHintState {
	/** Whether the hint has already been shown in this workspace. */
	readonly hintShown: boolean;
}

export interface OnboardingHintInput {
	readonly state: OnboardingHintState;
	/** A command run completed with exit code 0 (or otherwise judged "success"). */
	readonly hadSuccessfulRun: boolean;
	/** Whether at least one command in the current `.vibe/commands.json` is pinned. */
	readonly hasPinnedCommand: boolean;
	/** Whether the user has already pinned anything via the palette/menu. */
	readonly userHasInteractedWithPin: boolean;
}

export type OnboardingHintDecision =
	| { readonly kind: 'show' }
	| { readonly kind: 'skip'; readonly reason: 'already-shown' | 'no-success-yet' | 'already-pinned' | 'user-interacted' };

/**
 * Decide whether to surface the «Закрепить команду в верхнем баре?» toast.
 *
 * Order (top-down — first match wins):
 *   1. state.hintShown          → 'already-shown'
 *   2. !hadSuccessfulRun        → 'no-success-yet'
 *   3. hasPinnedCommand         → 'already-pinned'  (user opened a pre-pinned commands.json)
 *   4. userHasInteractedWithPin → 'user-interacted' (user already used Pin)
 *   5. otherwise                → 'show'
 */
export function decideOnboardingHint(input: OnboardingHintInput): OnboardingHintDecision {
	if (input.state.hintShown) {
		return { kind: 'skip', reason: 'already-shown' };
	}
	if (!input.hadSuccessfulRun) {
		return { kind: 'skip', reason: 'no-success-yet' };
	}
	if (input.hasPinnedCommand) {
		return { kind: 'skip', reason: 'already-pinned' };
	}
	if (input.userHasInteractedWithPin) {
		return { kind: 'skip', reason: 'user-interacted' };
	}
	return { kind: 'show' };
}

/**
 * Build the next state after a hint was surfaced (regardless of user action).
 * Pure: returns a new state object so the caller can persist it atomically.
 */
export function markOnboardingHintShown(state: OnboardingHintState): OnboardingHintState {
	return { ...state, hintShown: true };
}

/**
 * Build a fresh state for first-time workspace open. Pure — no IO.
 */
export function freshOnboardingHintState(): OnboardingHintState {
	return { hintShown: false };
}

/**
 * Decode a persisted state value loaded from `IStorageService`. Tolerates
 * any malformation by returning a fresh state (defense-in-depth: a corrupt
 * storage value should not block onboarding).
 */
export function decodeOnboardingHintState(raw: unknown): OnboardingHintState {
	if (!raw || typeof raw !== 'object') {
		return freshOnboardingHintState();
	}
	const r = raw as Record<string, unknown>;
	return { hintShown: r.hintShown === true };
}
