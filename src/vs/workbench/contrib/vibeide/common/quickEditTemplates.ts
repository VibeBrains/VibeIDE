/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Ctrl+K Quick Edit — slash-command prompt templates (pure helpers, no DI, no I/O).
 *
 * Roadmap §"R. Ctrl+K Quick Edit — Cursor-like inline AI edit" / R.1.
 *
 * Built-in slash commands the user can type in the floating Quick Edit widget
 * (e.g. `/doc`, `/refactor`, `/tests`). At submit time the QuickEditChat
 * component runs the typed text through `expandQuickEditSlashCommand` and, on
 * match, rewrites the textarea value to the expanded prompt before the
 * existing `editCodeService.startApplying` pipeline reads it.
 */

export type QuickEditSlashCommand = {
	readonly name: string;
	readonly description: string;
	readonly prompt: string;
};

export const QUICK_EDIT_SLASH_COMMANDS: readonly QuickEditSlashCommand[] = [
	{
		name: 'doc',
		description: 'Generate documentation comments for the selection',
		prompt: 'Generate documentation comments (TSDoc/JSDoc/docstring as appropriate for the language) for the selected code. Include parameters, return values, side effects, and a brief usage note. Keep the code itself unchanged — only add the doc-comment.',
	},
	{
		name: 'refactor',
		description: 'Refactor for clarity, preserve behavior',
		prompt: 'Refactor the selected code for clarity: improve naming, reduce nesting, extract obvious helpers, simplify control flow. Preserve external behavior and the public API exactly. Do not introduce new dependencies.',
	},
	{
		name: 'tests',
		description: 'Generate unit tests for the selection',
		prompt: 'Generate unit tests for the selected code using the conventional test framework for this language/project. Cover the happy path and at least one edge case (null/empty/boundary). Keep tests independent and deterministic.',
	},
	{
		name: 'explain',
		description: 'Prepend a short comment explaining the code',
		prompt: 'Replace the selected code with the same code, prepended by a concise 2–3 sentence comment block (using the language\'s native comment syntax) that explains what this code does, why it exists, and any non-obvious behavior.',
	},
	{
		name: 'fix',
		description: 'Find and fix bugs in the selection',
		prompt: 'Find and fix bugs, off-by-one errors, missing null/undefined checks, race conditions, and obvious logic mistakes in the selected code. Preserve the public interface and naming.',
	},
	{
		name: 'optimize',
		description: 'Optimize for performance, preserve behavior',
		prompt: 'Optimize the selected code for performance and memory while preserving observable behavior. Prefer algorithmic improvements over micro-optimizations. Do not sacrifice readability for marginal gains.',
	},
	{
		name: 'typehints',
		description: 'Add type annotations / type hints',
		prompt: 'Add precise type annotations / type hints to the selected code. Use the language\'s idiomatic typing system (TypeScript types, Python type hints, etc.). Do not change runtime behavior. Add minimal helper type aliases only if they significantly improve readability.',
	},
] as const;

export type QuickEditSlashExpansion =
	| { readonly matched: true; readonly command: string; readonly expanded: string }
	| { readonly matched: false };

const SLASH_COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?:[\s\t]+([\s\S]+))?$/i;

/**
 * Detect a leading `/command [extra context]` in the user's instruction and
 * expand it to the full template prompt. Unknown commands and non-slash input
 * return `{ matched: false }` so the existing pipeline forwards the text
 * verbatim (preserves the ability to literally type `/something` if a model
 * needs it).
 *
 * `extraCommands` lets R.3 (workspace overrides) layer custom commands on top
 * of the built-in set; workspace entries shadow built-ins with the same name.
 * Unknown name → no match (we don't silently fall back to built-in or to
 * passthrough — explicit shadowing means a built-in `/doc` is the workspace's
 * `doc`).
 */
export function expandQuickEditSlashCommand(
	text: string,
	extraCommands?: Readonly<Record<string, string>>,
): QuickEditSlashExpansion {
	if (typeof text !== 'string') { return { matched: false }; }
	const trimmed = text.trim();
	if (!trimmed.startsWith('/')) { return { matched: false }; }

	const m = SLASH_COMMAND_RE.exec(trimmed);
	if (!m) { return { matched: false }; }

	const rawName = m[1].toLowerCase();
	const extraContext = (m[2] ?? '').trim();

	const workspaceTemplate = extraCommands ? extraCommands[rawName] : undefined;
	const builtin = QUICK_EDIT_SLASH_COMMANDS.find(c => c.name === rawName);
	const template = workspaceTemplate ?? builtin?.prompt;
	if (!template) { return { matched: false }; }

	const expanded = extraContext
		? `${template}\n\nAdditional instructions: ${extraContext}`
		: template;

	return { matched: true, command: rawName, expanded };
}

/**
 * Compact one-line hint for chip-row over the input box (R.1).
 * Shown only while the textarea is empty.
 */
export function quickEditSlashHintNames(maxShown = 5): readonly string[] {
	return QUICK_EDIT_SLASH_COMMANDS.slice(0, Math.max(0, maxShown)).map(c => `/${c.name}`);
}
