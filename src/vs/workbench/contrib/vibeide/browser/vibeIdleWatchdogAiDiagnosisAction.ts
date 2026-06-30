/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * AI diagnosis action — «Watchdog Doctor» (roadmap W.36).
 *
 * Collects watchdog snapshot + recent tail + crash entries and dumps a
 * pre-formatted markdown report into a new editor with a structured prompt
 * appended. The user can then paste it into the VibeIDE chat (or any LLM
 * tool of choice) for analysis.
 *
 * Privacy: no workspace paths leave the local machine — `.jsonl` entries
 * already use only `workspaceHash`. `note` field (e.g., Electron `serviceName`)
 * can contain process metadata but no user content. Safe to paste into chat.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IVibeIdleWatchdogProxy } from '../common/vibeIdleWatchdogProxy.js';
import { clusterCrashes } from '../common/vibeIdleWatchdogCrashClustering.js';
import type { WatchdogLine, WatchdogSampleBase } from '../common/vibeIdleWatchdogTypes.js';

class VibeIdleWatchdogAiDiagnosisAction extends Action2 {
	static readonly ID = 'vibeide.watchdog.aiDiagnose';

	constructor() {
		super({
			id: VibeIdleWatchdogAiDiagnosisAction.ID,
			title: localize2('vibeide.watchdog.aiDiagnose.title', 'Диагностика памяти через AI'),
			category: { value: 'VibeIDE Diagnostics', original: 'VibeIDE Diagnostics' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const proxy = accessor.get(IVibeIdleWatchdogProxy);
		const editorService = accessor.get(IEditorService);
		const modelService = accessor.get(ITextModelService);

		const [snapshot, tail] = await Promise.all([
			proxy.getCurrentSnapshot(),
			proxy.readRecentTail(500),
		]);
		const clusters = clusterCrashes(tail);
		const report = renderAiPrompt(snapshot.samples, tail, clusters);

		const uri = URI.parse(`untitled:VibeIDE-AI-Diagnosis-${Date.now()}.md`);
		await editorService.openEditor({ resource: uri, options: { pinned: true } });
		const ref = await modelService.createModelReference(uri);
		try {
			ref.object.textEditorModel.setValue(report);
		} finally {
			ref.dispose();
		}
	}
}

function renderAiPrompt(samples: readonly WatchdogSampleBase[], tail: readonly WatchdogLine[], clusters: readonly { signature: string; count: number; lastSeen: string; proc: string; reason: string | undefined }[]): string {
	const out: string[] = [];
	out.push('# VibeIDE — AI Memory Diagnosis Prompt');
	out.push('');
	out.push('> Передайте этот markdown в VibeIDE чат, чтобы получить анализ паттернов памяти и потенциальных утечек.');
	out.push('');
	out.push('## Промпт для LLM');
	out.push('');
	out.push('```');
	out.push('Ты — senior диагностический инженер. Проанализируй приложенные watchdog-данные VibeIDE');
	out.push('(VS Code-форк на Electron). Определи:');
	out.push('  1. Есть ли признаки утечки памяти? В каком процессе?');
	out.push('  2. Slope rss за последний час по каждому процессу.');
	out.push('  3. Есть ли recurring crash pattern (см. секцию Crash clusters)?');
	out.push('  4. Какие 2-3 наиболее вероятные причины (в порядке убывания)?');
	out.push('  5. Какие 2-3 следующих шага диагностики предложить пользователю?');
	out.push('Отвечай по-русски, кратко (5-7 предложений), без воды.');
	out.push('```');
	out.push('');
	out.push('## Текущий снимок');
	out.push('');
	out.push('```json');
	out.push(JSON.stringify({ capturedAt: new Date().toISOString(), samples }, null, 2));
	out.push('```');
	out.push('');
	out.push(`## Tail (${tail.length} последних записей .jsonl)`);
	out.push('');
	out.push('```jsonl');
	for (const line of tail.slice(-100)) {
		out.push(JSON.stringify(line));
	}
	out.push('```');
	out.push('');
	if (clusters.length > 0) {
		out.push('## Crash clusters');
		out.push('');
		out.push('| Signature | Count | Last seen | Proc | Reason |');
		out.push('| --- | --- | --- | --- | --- |');
		for (const c of clusters) {
			out.push(`| \`${c.signature}\` | ${c.count} | ${c.lastSeen} | ${c.proc} | ${c.reason ?? '–'} |`);
		}
		out.push('');
	}
	out.push('---');
	out.push('');
	out.push(localize('vibeide.watchdog.aiDiagnose.footer', '_Безопасность: никаких workspace путей; user-content отсутствует. Безопасно для шеринга / paste в external LLM._'));
	return out.join('\n');
}

registerAction2(VibeIdleWatchdogAiDiagnosisAction);
