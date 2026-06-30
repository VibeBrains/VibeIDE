/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';

/**
 * GDPR DSAR / Right-to-be-Forgotten — pure manifest helper.
 *
 * N.2 lines 1179 + 1180 — `vibe doctor --gdpr-export` and `--gdpr-delete` already
 * exist as CLI flags, but there's no in-IDE wizard, so users have no way to
 * discover the GDPR surface. The wizard needs a deterministic, auditable list of
 * what's included and what's excluded — that's this module.
 *
 * Two manifests:
 *
 *   buildGDPRExportManifest()
 *     What `Export my data (GDPR)` will collect into a zip + checksum.
 *
 *   buildGDPRDeleteManifest()
 *     What `Delete all my data (GDPR)` will erase. ALWAYS excludes the
 *     workspace code (the user's source files) — that's not "my data" under
 *     GDPR Article 17, and erasing it would be silently destructive.
 *
 * The manifests are static surface descriptions, not the actual file lists —
 * the runtime collector consults them to know which collectors to invoke,
 * which to skip, and what to display in the confirm dialog.
 */

export type GDPRCategory =
	| 'audit-log'
	| 'settings'
	| 'vibe-artifacts'
	| 'chat-history'
	| 'byok-keys'
	| 'workspace-code';

export interface GDPRItem {
	readonly category: GDPRCategory;
	/** Short label for confirm-dialog rendering. Russian (UX language). */
	readonly label: string;
	/** Workspace-relative path or storage scope identifier. */
	readonly location: string;
	/** True = included in the export / delete operation; false = explicitly excluded. */
	readonly included: boolean;
	/** Reason a category is excluded — only set when `included` is false. */
	readonly excludedReason?: string;
}

export interface GDPRDeleteItem extends GDPRItem {
	/** True = the operation cannot be undone (no soft-delete; no recovery). */
	readonly irreversible: boolean;
}

/**
 * Pure: returns the canonical list of artefacts pulled into the DSAR export.
 * Order is stable — UI rendering relies on the array order being deterministic.
 */
export function buildGDPRExportManifest(): readonly GDPRItem[] {
	return [
		{
			category: 'audit-log',
			label: localize('vibeide.gdpr.label.auditLog', "Audit log (журнал действий агента)"),
			location: '<userdata>/audit-log/*.jsonl',
			included: true,
		},
		{
			category: 'settings',
			label: localize('vibeide.gdpr.label.settings', "Настройки VibeIDE и профили"),
			location: '<userdata>/User/settings.json + .vibe/*.json',
			included: true,
		},
		{
			category: 'vibe-artifacts',
			label: localize('vibeide.gdpr.label.vibeArtifacts', "Артефакты .vibe/ (планы, snapshots, agent-locks)"),
			location: '<workspace>/.vibe/**',
			included: true,
		},
		{
			category: 'chat-history',
			label: localize('vibeide.gdpr.label.chatHistory', "История чатов и треды агента"),
			location: '<userdata>/vibeide-chat-threads.json',
			included: true,
		},
		{
			category: 'byok-keys',
			label: localize('vibeide.gdpr.label.byokKeys', "BYOK API-ключи (зашифрованные)"),
			location: '<userdata>/secrets — IEncryptionService',
			included: true,
		},
		{
			category: 'workspace-code',
			label: localize('vibeide.gdpr.label.workspaceCode', "Исходный код проекта"),
			location: '<workspace>/**',
			included: false,
			excludedReason: localize('vibeide.gdpr.excludedReason.workspaceCode', "не относится к GDPR personal data — это твой код, не твои данные"),
		},
	];
}

/**
 * Pure: returns the canonical list of artefacts removed by Right-to-be-Forgotten.
 * Order matches the export manifest — workspace code is always excluded for safety.
 */
export function buildGDPRDeleteManifest(): readonly GDPRDeleteItem[] {
	return [
		{
			category: 'audit-log',
			label: localize('vibeide.gdpr.label.auditLog', "Audit log (журнал действий агента)"),
			location: '<userdata>/audit-log/*.jsonl',
			included: true,
			irreversible: true,
		},
		{
			category: 'settings',
			label: localize('vibeide.gdpr.label.settings', "Настройки VibeIDE и профили"),
			location: '<userdata>/User/settings.json + .vibe/*.json',
			included: true,
			irreversible: false,
		},
		{
			category: 'vibe-artifacts',
			label: localize('vibeide.gdpr.label.vibeArtifacts', "Артефакты .vibe/ (планы, snapshots, agent-locks)"),
			location: '<workspace>/.vibe/**',
			included: true,
			irreversible: true,
		},
		{
			category: 'chat-history',
			label: localize('vibeide.gdpr.label.chatHistory', "История чатов и треды агента"),
			location: '<userdata>/vibeide-chat-threads.json',
			included: true,
			irreversible: true,
		},
		{
			category: 'byok-keys',
			label: localize('vibeide.gdpr.label.byokKeys', "BYOK API-ключи (зашифрованные)"),
			location: '<userdata>/secrets — IEncryptionService',
			included: true,
			irreversible: true,
		},
		{
			category: 'workspace-code',
			label: localize('vibeide.gdpr.label.workspaceCode', "Исходный код проекта"),
			location: '<workspace>/**',
			included: false,
			excludedReason: localize('vibeide.gdpr.excludedReason.workspaceCodeRtbf', "удаление workspace кода не входит в RTBF — это область пользователя"),
			irreversible: false,
		},
	];
}

/**
 * Pure: renders a confirm-dialog body for the export wizard. Three sections —
 * "Будет экспортировано", "Не будет экспортировано", footer with checksum note.
 */
export function describeGDPRExportConfirm(items: readonly GDPRItem[]): string {
	const included = items.filter(i => i.included);
	const excluded = items.filter(i => !i.included);
	const lines: string[] = [];
	lines.push('Будет собрано в zip + SHA-256:');
	for (const it of included) { lines.push(`  • ${it.label} — ${it.location}`); }
	if (excluded.length > 0) {
		lines.push('');
		lines.push('Не будет включено:');
		for (const it of excluded) {
			lines.push(`  • ${it.label} — ${it.excludedReason ?? 'исключено'}`);
		}
	}
	return lines.join('\n');
}

/**
 * Pure: renders a confirm-dialog body for the delete wizard. Lists what's
 * irreversible explicitly (≠ "settings" which can be re-imported from a
 * profile backup).
 */
export function describeGDPRDeleteConfirm(items: readonly GDPRDeleteItem[]): string {
	const included = items.filter(i => i.included);
	const excluded = items.filter(i => !i.included);
	const lines: string[] = [];
	lines.push('БУДЕТ УДАЛЕНО (без возможности восстановления):');
	for (const it of included) {
		const tag = it.irreversible ? ' [НЕОБРАТИМО]' : '';
		lines.push(`  • ${it.label}${tag} — ${it.location}`);
	}
	if (excluded.length > 0) {
		lines.push('');
		lines.push('Останется на диске:');
		for (const it of excluded) {
			lines.push(`  • ${it.label} — ${it.excludedReason ?? 'исключено'}`);
		}
	}
	return lines.join('\n');
}

/**
 * Pure: counts irreversible items — used by the wizard to set the "type DELETE
 * to confirm" gating threshold (any irreversible item triggers it).
 */
export function countIrreversibleDeleteItems(items: readonly GDPRDeleteItem[]): number {
	return items.filter(i => i.included && i.irreversible).length;
}
