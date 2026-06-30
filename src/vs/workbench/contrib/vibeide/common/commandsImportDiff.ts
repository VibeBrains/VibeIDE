/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — community-pack import visual diff (pure helper).
 *
 * K.2 line 917 sub-bullet — when importing a community pack of project commands
 * we need a visual diff of `command` / `args` / `env` per item, BEFORE the user
 * confirms the import. SHA-256 verification (already shipped) is not enough:
 * the user must SEE which strings will end up in their `.vibe/commands.json`,
 * because a malicious pack with a valid hash can still ship a harmful command.
 *
 * Adoption order:
 *   1. The community-import flow downloads the pack, verifies its SHA-256.
 *   2. Calls `diffCommandsForImport(current, incoming)` to get the per-id diff.
 *   3. Renders `renderImportDiffMarkdown(diff)` in a confirm dialog with a
 *      "scary" label when `diff.hasChanges` includes `command|args|env`.
 *   4. On approval, the importer writes the resolved `.vibe/commands.json`.
 *
 * vscode-free.
 */

export interface ProjectCommandLite {
	readonly id: string;
	readonly name?: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
}

export type ImportItemKind =
	| 'added'
	| 'modified'
	| 'removed'
	| 'unchanged';

export type ChangedField = 'name' | 'command' | 'args' | 'env' | 'cwd';

export interface ImportItemDiff {
	readonly id: string;
	readonly kind: ImportItemKind;
	readonly changedFields: readonly ChangedField[];
	readonly before?: ProjectCommandLite;
	readonly after?: ProjectCommandLite;
}

export interface ImportDiff {
	readonly items: readonly ImportItemDiff[];
	readonly stats: {
		readonly added: number;
		readonly modified: number;
		readonly removed: number;
		readonly unchanged: number;
	};
	/**
	 * True iff at least one diff touches the security-sensitive fields
	 * (command / args / env / cwd) — caller surfaces a "DANGER" banner in that case.
	 */
	readonly touchesSensitiveFields: boolean;
}

const SENSITIVE_FIELDS: readonly ChangedField[] = ['command', 'args', 'env', 'cwd'];

/**
 * Pure: produces a per-id diff between the current commands list and the
 * incoming commands list from a community pack.
 *
 * Algorithm:
 *   - Build maps by id.
 *   - For each id in either side:
 *      - in incoming only        → 'added'
 *      - in current only         → 'removed'
 *      - both, no field changes  → 'unchanged'
 *      - both, field changes     → 'modified' with `changedFields` list
 *
 * Order of returned items is deterministic: stable insertion order of incoming
 * first (added + modified + unchanged in incoming order), then removed in
 * current order.
 */
export function diffCommandsForImport(
	current: readonly ProjectCommandLite[],
	incoming: readonly ProjectCommandLite[],
): ImportDiff {
	const currentById = new Map<string, ProjectCommandLite>();
	for (const c of current) { currentById.set(c.id, c); }

	const items: ImportItemDiff[] = [];
	let added = 0, modified = 0, removed = 0, unchanged = 0;
	let touchesSensitiveFields = false;
	const seenIds = new Set<string>();

	for (const next of incoming) {
		seenIds.add(next.id);
		const prev = currentById.get(next.id);
		if (!prev) {
			items.push({ id: next.id, kind: 'added', changedFields: [], after: next });
			added++;
			// New item with non-empty command counts as "introducing a sensitive field".
			if (next.command.length > 0) { touchesSensitiveFields = true; }
			continue;
		}
		const fields = compareFields(prev, next);
		if (fields.length === 0) {
			items.push({ id: next.id, kind: 'unchanged', changedFields: [], before: prev, after: next });
			unchanged++;
			continue;
		}
		items.push({ id: next.id, kind: 'modified', changedFields: fields, before: prev, after: next });
		modified++;
		if (fields.some(f => SENSITIVE_FIELDS.includes(f))) { touchesSensitiveFields = true; }
	}
	for (const c of current) {
		if (!seenIds.has(c.id)) {
			items.push({ id: c.id, kind: 'removed', changedFields: [], before: c });
			removed++;
		}
	}
	return {
		items,
		stats: { added, modified, removed, unchanged },
		touchesSensitiveFields,
	};
}

function compareFields(a: ProjectCommandLite, b: ProjectCommandLite): ChangedField[] {
	const out: ChangedField[] = [];
	if ((a.name ?? '') !== (b.name ?? '')) { out.push('name'); }
	if (a.command !== b.command) { out.push('command'); }
	if (!arrayEquals(a.args ?? [], b.args ?? [])) { out.push('args'); }
	if (!recordEquals(a.env ?? {}, b.env ?? {})) { out.push('env'); }
	if ((a.cwd ?? '') !== (b.cwd ?? '')) { out.push('cwd'); }
	return out;
}

function arrayEquals(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
	return true;
}

function recordEquals(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
	const ak = Object.keys(a).sort();
	const bk = Object.keys(b).sort();
	if (ak.length !== bk.length) { return false; }
	for (let i = 0; i < ak.length; i++) {
		if (ak[i] !== bk[i]) { return false; }
		if (a[ak[i]] !== b[bk[i]]) { return false; }
	}
	return true;
}

/**
 * Pure: renders the diff as a markdown body for the confirm dialog. Sensitive
 * field changes get an explicit `[!]` marker before the field name.
 */
export function renderImportDiffMarkdown(diff: ImportDiff): string {
	const lines: string[] = [];
	const { stats } = diff;
	lines.push(`## Импорт project commands — предпросмотр`);
	lines.push('');
	lines.push(`Будет: добавлено ${stats.added}, изменено ${stats.modified}, удалено ${stats.removed}, без изменений ${stats.unchanged}.`);
	lines.push('');
	if (diff.touchesSensitiveFields) {
		lines.push('> ⚠️  В импорте есть изменения **command / args / env / cwd**. SHA-256 проверки недостаточно — проверьте каждое поле ниже.');
		lines.push('');
	}
	for (const item of diff.items) {
		switch (item.kind) {
			case 'added':
				lines.push(`+ **${item.id}** (новая) — \`${shortCommand(item.after!)}\``);
				break;
			case 'modified': {
				const tagged = item.changedFields.map(f => SENSITIVE_FIELDS.includes(f) ? `[!]${f}` : f);
				lines.push(`~ **${item.id}** — изменено: ${tagged.join(', ')}`);
				break;
			}
			case 'removed':
				lines.push(`− **${item.id}** (будет удалено)`);
				break;
			case 'unchanged':
				lines.push(`= ${item.id} (без изменений)`);
				break;
		}
	}
	return lines.join('\n');
}

/**
 * Pure: produces a human-readable label of `command` for compact rendering.
 * Truncates to 60 chars with ellipsis. Caller may show full command in a
 * tooltip/expand block.
 */
export function shortCommand(c: ProjectCommandLite): string {
	const argsPart = c.args && c.args.length > 0 ? ' ' + c.args.join(' ') : '';
	const full = c.command + argsPart;
	if (full.length <= 60) { return full; }
	return full.slice(0, 59) + '…';
}
