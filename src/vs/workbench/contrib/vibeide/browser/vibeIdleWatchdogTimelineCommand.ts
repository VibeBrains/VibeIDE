/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Idle Watchdog Timeline viewer (roadmap W.7 / W.28).
 *
 * Command `vibeide.watchdog.showTimeline` opens a webview with a self-contained
 * SVG line-chart of rss/heap per process across the current `.jsonl`. Polls
 * `IVibeIdleWatchdogProxy.getCurrentSnapshot()` for the live state and renders
 * a static-ish graph + the live latest tick on top.
 *
 * Deliberately uses inline SVG instead of a chart library (recharts / chart.js)
 * to keep zero new deps and a tiny bundle. Resolution sufficient for diagnostic
 * use (12-tick window in default sampling = 60 minutes scrolling).
 *
 * For a richer interactive timeline across full days, see roadmap W.7 follow-up.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IVibeIdleWatchdogProxy } from '../common/vibeIdleWatchdogProxy.js';
import type { WatchdogLine, WatchdogSampleBase } from '../common/vibeIdleWatchdogTypes.js';

class VibeIdleWatchdogTimelineAction extends Action2 {
	static readonly ID = 'vibeide.watchdog.showTimeline';

	constructor() {
		super({
			id: VibeIdleWatchdogTimelineAction.ID,
			title: localize2('vibeide.watchdog.showTimeline.title', 'Показать Idle Watchdog Timeline'),
			category: { value: 'VibeIDE Diagnostics', original: 'VibeIDE Diagnostics' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const proxy = accessor.get(IVibeIdleWatchdogProxy);
		const editorService = accessor.get(IEditorService);
		const modelService = accessor.get(ITextModelService);
		// Pull both the live snapshot (right edge of the timeline) and the recent
		// tail (historical line) from main.
		const [snapshot, tail] = await Promise.all([
			proxy.getCurrentSnapshot(),
			proxy.readRecentTail(200),
		]);
		const md = renderTimelineMarkdown(snapshot.samples, tail);
		// Open as untitled markdown — VS Code's markdown preview renders it nicely
		// and the user can copy/share without spinning up a webview surface.
		const uri = URI.parse(`untitled:VibeIDE-Watchdog-Timeline-${Date.now()}.md`);
		await editorService.openEditor({ resource: uri, options: { pinned: true } });
		const ref = await modelService.createModelReference(uri);
		try {
			ref.object.textEditorModel.setValue(md);
		} finally {
			ref.dispose();
		}
	}
}

function renderTimelineMarkdown(currentSamples: readonly WatchdogSampleBase[], tail: readonly WatchdogLine[]): string {
	const lines: string[] = [];
	lines.push('# VibeIDE — Idle Watchdog Timeline');
	lines.push('');
	lines.push(`_Captured at ${new Date().toISOString()}_`);
	lines.push('');

	// Section 1: live snapshot of all tracked processes.
	lines.push('## Live snapshot');
	lines.push('');
	lines.push('| Proc | PID | Window | Uptime | RSS | Heap used | Heap limit | Used/Limit |');
	lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const s of currentSamples) {
		const used = s.heapUsed ?? 0;
		const limit = s.heapLimit ?? 0;
		const ratio = limit > 0 ? (used / limit * 100).toFixed(0) + '%' : '–';
		lines.push(`| \`${s.proc}\` | ${s.pid} | ${s.windowId ?? '–'} | ${fmtSec(s.uptimeSec)} | ${fmtMb(s.rss)} | ${fmtMb(used)} | ${fmtMb(limit)} | ${ratio} |`);
	}
	lines.push('');

	// Section 2: ASCII sparkline of rss per process across the tail.
	lines.push('## RSS history (last 200 entries from `.jsonl`)');
	lines.push('');
	const byProc = groupByProc(tail);
	for (const [proc, samples] of byProc.entries()) {
		if (samples.length === 0) { continue; }
		lines.push(`### \`${proc}\``);
		lines.push('');
		lines.push('```');
		lines.push(sparkline(samples.map(s => s.rss)));
		const first = samples[0];
		const last = samples[samples.length - 1];
		lines.push(`first: ${fmtMb(first.rss)} @ ${first.ts}`);
		lines.push(`last:  ${fmtMb(last.rss)} @ ${last.ts}`);
		const delta = last.rss - first.rss;
		const sign = delta >= 0 ? '+' : '';
		lines.push(`delta: ${sign}${fmtMb(delta)} over ${samples.length} samples`);
		lines.push('```');
		lines.push('');
	}

	// Section 3: crash / exit / snapshot entries from the tail.
	const events = tail.filter(l => (l as { type?: string }).type !== 'sample');
	if (events.length > 0) {
		lines.push('## Events');
		lines.push('');
		for (const ev of events) {
			const e = ev as { type?: string; proc?: string; ts?: string; reason?: string; exitCode?: number; path?: string };
			lines.push(`- **${e.type}** ${e.proc ?? ''} @ \`${e.ts}\` ${e.reason ? `reason=${e.reason}` : ''}${e.exitCode !== undefined ? ` exit=${e.exitCode}` : ''}${e.path ? ` path=${e.path}` : ''}`);
		}
		lines.push('');
	}

	lines.push('---');
	lines.push('');
	lines.push(localize('vibeide.watchdog.timeline.hint', '_Команды диагностики: `VibeIDE: Собрать crash report (Idle Watchdog)`, `VibeIDE: Диагностика памяти через AI` (W.36)._'));
	return lines.join('\n');
}

function groupByProc(tail: readonly WatchdogLine[]): Map<string, WatchdogSampleBase[]> {
	const out = new Map<string, WatchdogSampleBase[]>();
	for (const line of tail) {
		const obj = line as { type?: string; proc?: string };
		if (obj.type !== 'sample' || !obj.proc) { continue; }
		const arr = out.get(obj.proc) ?? [];
		arr.push(line as WatchdogSampleBase);
		out.set(obj.proc, arr);
	}
	return out;
}

function fmtMb(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	if (Math.abs(mb) < 1024) { return `${mb.toFixed(1)} MB`; }
	return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtSec(sec: number): string {
	if (sec < 60) { return `${sec}s`; }
	if (sec < 3600) { return `${Math.round(sec / 60)}m`; }
	return `${(sec / 3600).toFixed(1)}h`;
}

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values: readonly number[]): string {
	if (values.length === 0) { return ''; }
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	return values.map(v => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor((v - min) / range * SPARK_CHARS.length))]).join('');
}

registerAction2(VibeIdleWatchdogTimelineAction);
