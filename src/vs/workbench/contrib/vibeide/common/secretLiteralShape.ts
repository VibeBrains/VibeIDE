/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tells a literal secret from a piece of code on the right-hand side of `key = value`
 *
 * Assignment rules (password, token, api key) match by shape: a keyword, a separator, a run of value characters
 * The same shape covers a hard-coded string and a variable that merely carries the keyword in its name
 * Only the value tells them apart
 * A literal is quoted, or carries a digit or a symbol that an identifier never has
 * Code is a call, a member access, a type, a path or a variable reference
 */

/** Stand-ins that mark the place of a secret without being one: interpolation, template, format spec, mask */
const PLACEHOLDER_SHAPES: readonly RegExp[] = [
	// Shell and template interpolation: $NAME, ${NAME}, $(cat file), $deviceToken
	// An opened ${ or $( is enough, because whitespace cuts the value before the closing bracket
	/^\$(?:[{(].*|[A-Z_][A-Z0-9_]*|[A-Za-z_]+)$/,
	// Template engines: {{ name }}, <%= name %>, #{name}, %{name}, {name}
	/^(?:\{\{.*\}\}|<%.*%>|[#%]?\{[^{}]*\})$/,
	// Documentation stand-ins and redaction output: <your-key>, [REDACTED], [[REDACTED:Password]]
	/^(?:<[^<>]+>|\[{1,2}[^[\]]+\]{1,2})$/,
	// printf and environment-variable forms: %s, %(name)s, %1$s, %NAME%
	/^%(?:(?:\(\w+\)|\d+\$)?[-+ #0]*\d*(?:\.\d+)?[a-zA-Z]|[A-Za-z_][A-Za-z0-9_]*%)$/,
	// Masks: ********, xxxxxxxx, XXXX-XXXX, ......, and any single repeated character
	/^(?:[*•.#_\-xX]+|(.)\1+)$/,
];

/** Code punctuation that trails a value and is not part of it: a nullable type mark, a comma, a closing bracket, `!!` */
const TRAILING_CODE_PUNCTUATION = /(?:!!|[?,;)])+$/;

/** A digit or a symbol that identifiers do not contain */
const LITERAL_MARKER = /[0-9!@#$%^&*+=/|\\~]/;

/** Shapes that mean code even when the value carries a digit or a symbol */
const CODE_SHAPES: readonly RegExp[] = [
	// Call or index: getValue(, fetchV2Value(, items[
	/^[A-Za-z_$][\w$]*(?:(?:\??\.|->|::)[A-Za-z_$][\w$]*)*[([]/,
	// Member access: config.value2, process.env.NAME_V2, this->value, Config::VALUE, this.value!
	/^[A-Za-z_$][\w$]*(?:(?:\??\.|->|::)[A-Za-z_$][\w$]*)+[!?]*$/,
	// Generic type or comparison: Map<Int64,
	/^[A-Za-z_][\w.]*</,
	// File path or regex literal: /run/secrets/name, ./name, ../name, ~/name
	/^(?:~|\.{1,2})?\//,
	// Minified boolean: !0, !1
	/^![01](?![A-Za-z0-9])/,
];

/** True when the whole value is a stand-in for a secret, not a secret */
export function isPlaceholderValue(value: string): boolean {
	return PLACEHOLDER_SHAPES.some(shape => shape.test(value));
}

/**
 * True when the value on the right of an assignment looks like a literal secret
 *
 * `quote` is the quote character around the value, an empty string for a bare value
 * A quoted value is a literal unless it is a stand-in or a JS template literal with an interpolation
 * An unquoted value is a literal only with a digit or a symbol in it and no sign of code
 * A plain word without those (an identifier, a type, `null`) is a name, and it is code far more often than a password
 */
export function looksLikeSecretLiteral(value: string, quote: string): boolean {
	if (quote) {
		return !isPlaceholderValue(value) && !(quote === '`' && value.includes('${'));
	}
	const bare = value.replace(TRAILING_CODE_PUNCTUATION, '');
	if (isPlaceholderValue(bare) || !LITERAL_MARKER.test(bare)) {
		return false;
	}
	return !CODE_SHAPES.some(shape => shape.test(bare));
}
