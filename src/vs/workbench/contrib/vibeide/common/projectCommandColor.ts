/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Resolution of the optional `color` field of `.vibe/commands.json`.
 *
 * The format declares a **theme colour id** (e.g. `terminal.ansiBlue`), not a
 * literal CSS colour: the workspace file must not be able to inject arbitrary
 * CSS, and a literal would survive a light/dark switch unchanged while the rest
 * of the UI follows the theme.
 *
 * Pure by design — the caller supplies the "is this id registered" predicate so
 * this module stays free of the colour registry and remains unit-testable.
 */

/** Ids are dotted lowerCamelCase segments, as registered by `registerColor`. */
const THEME_COLOR_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

/**
 * Returns the theme colour id to paint the command with, or `undefined` when
 * the field is absent, malformed, or names a colour no theme defines. An
 * unknown id is dropped rather than passed through: emitting a CSS variable
 * nobody declares renders as "no colour at all" on some surfaces and as an
 * inherited colour on others, which looks like a rendering bug.
 */
export function resolveProjectCommandColorId(
	color: string | undefined,
	isRegisteredColorId: (id: string) => boolean,
): string | undefined {
	if (typeof color !== 'string') {
		return undefined;
	}
	const id = color.trim();
	if (!THEME_COLOR_ID_PATTERN.test(id)) {
		return undefined;
	}
	return isRegisteredColorId(id) ? id : undefined;
}
