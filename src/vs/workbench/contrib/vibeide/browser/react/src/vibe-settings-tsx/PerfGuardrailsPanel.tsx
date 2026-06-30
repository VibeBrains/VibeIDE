/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// L991-992 — Settings React panel that surfaces the Performance Guardrails
// runtime aggregate (trip count / avg / max / threshold per rule) without
// requiring the user to drop into `vibe doctor --perf`. The data source is
// `.vibe/perf-guardrails-events.jsonl` (written by IVibePerfGuardrailsService);
// a streaming subscription is backlog — for now the panel re-reads the file
// when the user clicks Refresh.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { safetyS } from './vibeSettingsRu.js';

interface PerfRuleSummary {
	rule: string;
	trips: number;
	avg: number;
	max: number;
	threshold: number;
}

function aggregate(events: ReadonlyArray<{ rule: string; observedValue: number; thresholdValue: number }>): PerfRuleSummary[] {
	const byRule = new Map<string, { sum: number; max: number; threshold: number; trips: number }>();
	for (const e of events) {
		const slot = byRule.get(e.rule) ?? { sum: 0, max: 0, threshold: e.thresholdValue, trips: 0 };
		slot.sum += e.observedValue;
		slot.max = Math.max(slot.max, e.observedValue);
		slot.threshold = e.thresholdValue;
		slot.trips += 1;
		byRule.set(e.rule, slot);
	}
	return [...byRule.entries()]
		.map(([rule, s]) => ({ rule, trips: s.trips, avg: s.sum / s.trips, max: s.max, threshold: s.threshold }))
		.sort((a, b) => b.trips - a.trips);
}

async function readEvents(accessor: ReturnType<typeof useAccessor>): Promise<PerfRuleSummary[]> {
	try {
		const workspaceContextService = accessor.get('IWorkspaceContextService') as { getWorkspace(): { folders: { uri: { toString(): string; with(opts: { path: string }): unknown } }[] } };
		const fileService = accessor.get('IFileService') as { readFile(uri: unknown): Promise<{ value: { toString(): string } }> };
		const folders = workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return []; }
		const root = folders[0].uri;
		const uri = (root as unknown as { with: (opts: { path: string }) => unknown }).with({ path: ((root as unknown as { path: string }).path) + '/.vibe/perf-guardrails-events.jsonl' });
		const file = await fileService.readFile(uri);
		const text = file.value.toString();
		const events: { rule: string; observedValue: number; thresholdValue: number }[] = [];
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) { continue; }
			try {
				const evt = JSON.parse(trimmed);
				if (evt && typeof evt.rule === 'string' && typeof evt.observedValue === 'number' && typeof evt.thresholdValue === 'number') {
					events.push(evt);
				}
			} catch { /* malformed line — skip */ }
		}
		return aggregate(events);
	} catch {
		return [];
	}
}

export const PerfGuardrailsPanel: React.FC = () => {
	const accessor = useAccessor();
	const [rows, setRows] = useState<PerfRuleSummary[]>([]);
	const [loading, setLoading] = useState<boolean>(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setRows(await readEvents(accessor));
		} finally {
			setLoading(false);
		}
	}, [accessor]);

	useEffect(() => { void refresh(); }, [refresh]);

	const openOutput = useCallback(async () => {
		const commandService = accessor.get('ICommandService') as { executeCommand(id: string, ...args: unknown[]): Promise<unknown> };
		try {
			await commandService.executeCommand('workbench.action.output.show.vibeide');
		} catch {
			await commandService.executeCommand('workbench.action.toggleOutput');
		}
	}, [accessor]);

	const empty = rows.length === 0;
	const fmt = useMemo(() => (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '–'), []);

	return (
		<div className='@@vibe-chat-like-shell overflow-hidden'>
			<div className='px-3 pt-3 pb-2 flex items-center gap-2'>
				<h3 className='text-lg font-semibold text-vibe-fg-1 flex-1'>{safetyS.perfPanelTitle}</h3>
				<button
					type='button'
					className='px-2 py-1 text-sm bg-vibe-bg-3 hover:bg-vibe-bg-4 rounded-sm flex items-center gap-1'
					onClick={refresh}
					disabled={loading}
					aria-busy={loading}
				>
					<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
					{safetyS.perfPanelRefresh}
				</button>
				<button
					type='button'
					className='px-2 py-1 text-sm bg-vibe-bg-3 hover:bg-vibe-bg-4 rounded-sm flex items-center gap-1'
					onClick={openOutput}
				>
					<ExternalLink size={14} />
					{safetyS.perfPanelOpenOutput}
				</button>
			</div>
			<p className='px-3 text-sm text-vibe-fg-3'>{safetyS.perfPanelIntro}</p>
			{empty ? (
				<p className='px-3 pb-3 pt-2 text-sm text-vibe-fg-4 italic'>{safetyS.perfPanelEmpty}</p>
			) : (
				<table className='w-full text-sm mt-2'>
					<thead>
						<tr className='text-left text-vibe-fg-3'>
							<th className='px-3 py-1'>{safetyS.perfPanelColRule}</th>
							<th className='px-3 py-1 text-right'>{safetyS.perfPanelColTrips}</th>
							<th className='px-3 py-1 text-right'>{safetyS.perfPanelColAvg}</th>
							<th className='px-3 py-1 text-right'>{safetyS.perfPanelColMax}</th>
							<th className='px-3 py-1 text-right'>{safetyS.perfPanelColThreshold}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(r => (
							<tr key={r.rule} className='border-t border-vibe-border-4'>
								<td className='px-3 py-1 font-mono'>{r.rule}</td>
								<td className='px-3 py-1 text-right'>{r.trips}</td>
								<td className='px-3 py-1 text-right'>{fmt(r.avg)}</td>
								<td className='px-3 py-1 text-right'>{fmt(r.max)}</td>
								<td className='px-3 py-1 text-right'>{fmt(r.threshold)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
};

export default PerfGuardrailsPanel;
