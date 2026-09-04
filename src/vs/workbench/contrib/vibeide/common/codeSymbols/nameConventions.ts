/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Conventions shared by every layer that reads a name out of source text.
 *
 * These lived as private copies in four different modules. Copies of a rule do not stay equal: the
 * two lists of «relative owners» had already drifted apart in ordering, and the next edit would have
 * changed the behaviour of one caller and not the others.
 */

/**
 * Owners that mean «the type this code is in» rather than a type spelled out.
 *
 * One set for all seven languages on purpose: `self` means the same thing in PHP, Python, Rust and
 * Ruby, and a language that has no such word simply never produces it.
 */
export const RELATIVE_OWNERS: ReadonlySet<string> = new Set([
	'$this', 'this', 'self', 'Self', 'static', 'parent', 'super', 'base', 'me',
]);

/**
 * Last segment of a qualified name: `\App\Billing\Invoice` → `Invoice`, `app.Invoice` → `Invoice`,
 * `crate::billing::Invoice` → `Invoice`.
 *
 * The index is keyed by short names, so every layer that receives a qualified name from source has
 * to shorten it the same way — which is exactly why this is one function and not four.
 */
export function shortNameOf(name: string): string {
	const parts = name.split(/[\\.]|::/);
	return parts[parts.length - 1] || name;
}
