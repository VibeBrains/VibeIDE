/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure classifier for the tool-call format status indicator (vibeStatusBarToolFormat.ts).
 *
 * Kept free of vscode/service imports so the decision logic — which the UI layer
 * cannot easily build-test — is covered by plain unit tests. The UI contribution
 * maps the returned kind onto localized text / tooltip / severity.
 */

export type ToolCallFormatKind =
	| 'auto'                  // model selection is "auto" — resolved per request
	| 'native'                // native function-calling (specialToolFormat set)
	| 'xml'                   // XML fallback — model has no native FC by default
	| 'xml-autodowngraded';   // XML fallback in effect because of an auto-downgrade override

export interface ClassifyToolCallFormatInput {
	/** True when the model selection is auto/unset (no single resolvable format). */
	readonly isAutoSelection: boolean;
	/** `getModelCapabilities(...).specialToolFormat` — truthy means native FC. */
	readonly specialToolFormat: string | undefined | null;
	/** `ModelOverrides._autoDetected` for the selected model. */
	readonly autoDetected: boolean;
	/** `ModelOverrides._detectedAt` (ms epoch) for the selected model, if any. */
	readonly detectedAt: number | undefined;
	/** Current time (ms epoch). Passed in so the function stays pure/testable. */
	readonly now: number;
	/** Auto-downgrade TTL in ms (AUTO_DOWNGRADE_TTL_MS). */
	readonly ttlMs: number;
}

/**
 * An auto-downgrade override only takes effect within its TTL — past it,
 * getModelCapabilities ignores the override and the model gets a fresh native-FC
 * attempt. Mirror that TTL window here so the indicator only shows the
 * "auto-downgraded" state while it is actually in effect.
 */
export function isAutoDowngradeInEffect(autoDetected: boolean, detectedAt: number | undefined, now: number, ttlMs: number): boolean {
	return autoDetected && typeof detectedAt === 'number' && (now - detectedAt < ttlMs);
}

export function classifyToolCallFormat(input: ClassifyToolCallFormatInput): ToolCallFormatKind {
	if (input.isAutoSelection) { return 'auto'; }
	if (input.specialToolFormat) { return 'native'; }
	return isAutoDowngradeInEffect(input.autoDetected, input.detectedAt, input.now, input.ttlMs)
		? 'xml-autodowngraded'
		: 'xml';
}
