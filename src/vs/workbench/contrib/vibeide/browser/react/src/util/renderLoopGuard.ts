/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Render-loop tripwire. A genuine setState/effect loop re-renders the same component
// dozens of times within a frame, which surfaces to the user as a silent renderer freeze
// ("Окно не отвечает") — hard to diagnose because the default unresponsive sampler does
// NOT dump the JS stack. This logs ONCE per tag (per window) naming the culprit component,
// so the otherwise-invisible loop becomes a single greppable line in the renderer log.
// Pure observability: it never throws and never changes behaviour. Threshold is set below
// React's own "Maximum update depth exceeded" guard (≈50) so we still name the component
// even when a synchronous render-phase loop is about to be caught by an ErrorBoundary.

const RENDER_WINDOW_MS = 1000;
const RENDER_LOOP_THRESHOLD = 40;

const _ticksByTag = new Map<string, number[]>();
const _firedTags = new Set<string>();

export function trackRenderLoop(tag: string): void {
	const now = Date.now();
	let ticks = _ticksByTag.get(tag);
	if (!ticks) { ticks = []; _ticksByTag.set(tag, ticks); }
	ticks.push(now);
	while (ticks.length && now - ticks[0] > RENDER_WINDOW_MS) { ticks.shift(); }
	if (ticks.length >= RENDER_LOOP_THRESHOLD && !_firedTags.has(tag)) {
		_firedTags.add(tag);

		console.error(`[VibeIDE/RenderLoop] "${tag}" re-rendered ${ticks.length} times within ${RENDER_WINDOW_MS}ms — probable setState/effect loop (precedes a renderer freeze "Окно не отвечает").`);
	}
}
