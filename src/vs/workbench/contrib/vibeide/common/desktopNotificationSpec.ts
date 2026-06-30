/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `VibeDesktopNotificationService` — Electron Notification spec validator
 * (roadmap §"Real-impl tail / Phase 3b — `VibeDesktopNotificationService`
 * Electron Notification API (для blocking approval в фоне нужно настоящее
 * OS-уведомление)").
 *
 * Pure helpers — `vscode`-free. Caller passes a draft notification spec;
 * helper validates against the cross-platform constraints (title ≤ 64,
 * body ≤ 256, action label ≤ 32, max 3 actions on Windows, etc) and
 * returns a normalised payload ready for `new Notification(...)`.
 *
 * The actual `Notification` API stays in the runtime adapter — this
 * module is platform-aware via the `platform` argument so the unit tests
 * can exercise win32 / darwin / linux constraints without an OS check.
 */

export type NotificationPlatform = 'win32' | 'darwin' | 'linux' | 'unknown';

export type NotificationUrgency = 'low' | 'normal' | 'critical';

export interface NotificationActionDraft {
	readonly id: string;
	readonly label: string;
}

export interface DesktopNotificationDraft {
	readonly title: string;
	readonly body: string;
	readonly urgency?: NotificationUrgency;
	readonly silent?: boolean;
	readonly actions?: ReadonlyArray<NotificationActionDraft>;
	readonly iconPath?: string;
}

export interface DesktopNotificationSpec extends Required<Omit<DesktopNotificationDraft, 'iconPath'>> {
	readonly iconPath?: string;
}

export type NotificationValidationIssue =
	| 'title-empty'
	| 'title-too-long'
	| 'body-empty'
	| 'body-too-long'
	| 'too-many-actions'
	| 'action-id-malformed'
	| 'action-label-too-long'
	| 'action-label-empty'
	| 'urgency-invalid'
	| 'icon-path-not-absolute';

export type ValidateNotificationResult =
	| { readonly ok: true; readonly spec: DesktopNotificationSpec }
	| { readonly ok: false; readonly issues: ReadonlyArray<NotificationValidationIssue> };

const TITLE_MAX = 64;
const BODY_MAX = 256;
const ACTION_LABEL_MAX = 32;
const ACTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACTIONS_MAX_BY_PLATFORM: Record<NotificationPlatform, number> = {
	win32: 3,
	darwin: 5,
	linux: 5,
	unknown: 3,
};

const ABS_PATH_HINT = /^([a-zA-Z]:[\\/]|\/|file:\/\/|~[\\/])/;

/**
 * Validate + normalise a desktop notification draft. Pure — caller passes the
 * platform string (e.g. `process.platform`).
 *
 * Collects all issues (not first-fail) so the UI can surface a complete list
 * — caller decides whether to refuse the full draft or strip offending bits.
 */
export function validateDesktopNotification(
	draft: DesktopNotificationDraft,
	platform: NotificationPlatform,
): ValidateNotificationResult {
	const issues: NotificationValidationIssue[] = [];

	const title = typeof draft.title === 'string' ? draft.title : '';
	const body = typeof draft.body === 'string' ? draft.body : '';
	const trimmedTitle = title.trim();
	const trimmedBody = body.trim();

	if (trimmedTitle.length === 0) { issues.push('title-empty'); }
	if (title.length > TITLE_MAX) { issues.push('title-too-long'); }
	if (trimmedBody.length === 0) { issues.push('body-empty'); }
	if (body.length > BODY_MAX) { issues.push('body-too-long'); }

	const urgency = draft.urgency ?? 'normal';
	if (urgency !== 'low' && urgency !== 'normal' && urgency !== 'critical') {
		issues.push('urgency-invalid');
	}

	const actions = draft.actions ?? [];
	const maxActions = ACTIONS_MAX_BY_PLATFORM[platform] ?? 3;
	if (actions.length > maxActions) { issues.push('too-many-actions'); }
	for (const a of actions) {
		if (typeof a.id !== 'string' || !ACTION_ID_PATTERN.test(a.id)) {
			issues.push('action-id-malformed');
		}
		if (typeof a.label !== 'string' || a.label.trim().length === 0) {
			issues.push('action-label-empty');
		}
		if (typeof a.label === 'string' && a.label.length > ACTION_LABEL_MAX) {
			issues.push('action-label-too-long');
		}
	}

	if (draft.iconPath !== undefined) {
		if (typeof draft.iconPath !== 'string' || !ABS_PATH_HINT.test(draft.iconPath)) {
			issues.push('icon-path-not-absolute');
		}
	}

	if (issues.length > 0) {
		return { ok: false, issues };
	}

	const spec: DesktopNotificationSpec = {
		title: trimmedTitle,
		body: trimmedBody,
		urgency: urgency as NotificationUrgency,
		silent: draft.silent === true,
		actions: actions.map(a => ({ id: a.id, label: a.label.trim() })),
		...(draft.iconPath !== undefined ? { iconPath: draft.iconPath } : {}),
	};
	return { ok: true, spec };
}

/**
 * Detect the platform from a `process.platform`-shaped string. Pure — caller
 * passes the value, helper does not read `process` itself.
 */
export function detectNotificationPlatform(platform: string): NotificationPlatform {
	if (platform === 'win32') { return 'win32'; }
	if (platform === 'darwin') { return 'darwin'; }
	if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') { return 'linux'; }
	return 'unknown';
}

/**
 * Map abstract `urgency` to platform-specific Electron Notification options.
 * Pure: returns the literal flags.
 *   - critical → { urgency: 'critical' } on linux; { ...silent: false } else
 *   - low      → { urgency: 'low' } on linux; { silent: true } else
 *   - normal   → no special flags
 */
export function urgencyToElectronOptions(
	urgency: NotificationUrgency,
	platform: NotificationPlatform,
): Readonly<Record<string, unknown>> {
	if (platform === 'linux') {
		if (urgency === 'critical') { return { urgency: 'critical' }; }
		if (urgency === 'low') { return { urgency: 'low' }; }
		return {};
	}
	if (urgency === 'low') { return { silent: true }; }
	return {};
}
