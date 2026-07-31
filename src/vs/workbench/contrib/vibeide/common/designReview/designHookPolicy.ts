/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The design hook: measure the page after the agent touched the interface, without being asked.
 *
 * Why a hook at all — the detector only helps if it runs. Asked politely, a model checks its work
 * when it remembers to; hooked to the end of a turn that changed UI files, it checks every time.
 *
 * Why the strict mode is floor-only: bouncing a model over taste ("the halo is a cliché") would
 * turn an opinion into a blocker and produce loops over style. Contrast below AA, a target too
 * small to hit, clipped content — those are defects at any taste, and the run should not end on
 * them. Pure decision logic; the run and the measurement live in the workbench.
 */

import { Finding } from './designSnapshot.js';

export type DesignHookMode =
	/** Never runs. */
	| 'off'
	/** Measures and reports; the turn ends either way. */
	| 'notify'
	/** Measures and sends the model back while there are unaccepted floor findings. */
	| 'enforceFloor';

/** Extensions whose change can move pixels. Editing a service or a test cannot. */
const UI_EXTENSIONS = [
	'.css', '.scss', '.sass', '.less', '.styl',
	'.html', '.htm', '.svg',
	'.tsx', '.jsx', '.vue', '.svelte', '.astro',
];

/** True when at least one changed path could have changed what the page looks like. */
export function touchesUi(paths: readonly string[]): boolean {
	return paths.some(path => {
		const lower = path.toLowerCase();
		// A test file that ends in .tsx is still a test: it renders nothing the user sees.
		if (/\.(?:test|spec)\.[a-z]+$/.test(lower)) {
			return false;
		}
		return UI_EXTENSIONS.some(extension => lower.endsWith(extension));
	});
}

export type DesignHookDecision =
	/** Nothing to say: hook off, page unreachable, or no findings. */
	| 'quiet'
	/** Report the findings; the turn still ends. */
	| 'note'
	/** Send the model back to fix the floor findings. */
	| 'bounce';

export interface DesignHookInput {
	readonly mode: DesignHookMode;
	/** False when the page could not be measured — silence beats a fake clean report. */
	readonly measured: boolean;
	readonly findings: readonly Finding[];
	readonly attemptsUsed: number;
	readonly maxAttempts: number;
}

/**
 * Decides what the hook does with what it measured.
 *
 * Accepted drift never counts: a project that documented a deliberate choice must not be nagged
 * about it, let alone bounced.
 */
export function decideDesignHook(input: DesignHookInput): DesignHookDecision {
	const { mode, measured, findings, attemptsUsed, maxAttempts } = input;
	if (mode === 'off' || !measured) {
		return 'quiet';
	}
	const live = findings.filter(finding => !finding.accepted);
	if (live.length === 0) {
		return 'quiet';
	}
	if (mode === 'notify') {
		return 'note';
	}
	const floor = live.filter(finding => finding.ruleClass === 'floor');
	if (floor.length === 0) {
		return 'note';
	}
	return attemptsUsed < Math.max(1, maxAttempts) ? 'bounce' : 'note';
}

/** Findings worth blocking on: the quality floor the project cannot accept away. */
export function floorFindings(findings: readonly Finding[]): Finding[] {
	return findings.filter(finding => !finding.accepted && finding.ruleClass === 'floor');
}
