/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure builder for the "silent stream stall" diagnostics report.
 *
 * The hard-stall symptom (request sent, no first byte, no error, no token spend, hangs to the
 * watchdog timeout) is most often a wedged shared undici keep-alive pool on a cloud provider. This
 * report bundles the chat-run trace timeline (which now records the silent gap and the transport
 * reset) with the stall context + live dispatcher generation, so the cause is diagnosable from a
 * single shareable file. Kept dependency-free so it is trivially testable from test/common.
 */

export interface StallReportContext {
	readonly provider?: string;
	readonly model?: string;
	readonly hardStallSeconds: number;
	readonly lastErrorMessage?: string;
}

export interface StallReportTransport {
	readonly id: number;
	readonly ageMs: number;
	readonly initialized: boolean;
}

export interface StallReportInput {
	readonly context: StallReportContext;
	readonly transport?: StallReportTransport;
	/** Pre-rendered chat-run trace timeline (renderChatTraceMarkdown(getChatTrace())). */
	readonly traceMarkdown: string;
	readonly capturedAtIso: string;
	readonly appName?: string;
	readonly appVersion?: string;
}

/** Render the full stall report as markdown. */
export function buildStallReportMarkdown(input: StallReportInput): string {
	const { context, transport, traceMarkdown, capturedAtIso, appName, appVersion } = input;
	const lines: string[] = [];

	lines.push('# VibeIDE — отчёт о зависании стрима');
	lines.push('');
	lines.push(`- Снято: \`${capturedAtIso}\``);
	if (appName || appVersion) { lines.push(`- Сборка: ${appName ?? 'VibeIDE'} ${appVersion ?? ''}`.trimEnd()); }
	lines.push(`- Провайдер: \`${context.provider ?? '—'}\``);
	lines.push(`- Модель: \`${context.model ?? '—'}\``);
	lines.push(`- Порог hard-stall: ${context.hardStallSeconds}с`);
	if (transport) {
		// id bumps every (re)create — if "Сбросить клиентов"/auto-retry helped, the next request runs on
		// a higher id. ageMs = how long this exact pool has been reused; a wedge tends to be an old pool.
		lines.push(`- Транспорт (undici): поколение #${transport.id}, возраст ${(transport.ageMs / 1000).toFixed(0)}с${transport.initialized ? '' : ' (не инициализирован)'}`);
	}
	if (context.lastErrorMessage) {
		lines.push('');
		lines.push('## Текст ошибки');
		lines.push('');
		lines.push('```');
		lines.push(context.lastErrorMessage);
		lines.push('```');
	}

	lines.push('');
	lines.push('## Таймлайн прогона чата');
	lines.push('');
	lines.push('> Ищите `llmTurn:start` → большой разрыв → `llmTurn:soft-stall`/`llmTurn:hard-stall` с `anyToken=false`:');
	lines.push('> это «тихий» провал send-path (запрос ушёл, ответ не начался). `llmTurn:transport-reset`');
	lines.push('> показывает автоматическое пересоздание сетевого пула перед повтором.');
	lines.push('');
	lines.push(traceMarkdown.trim());
	lines.push('');
	lines.push('---');
	lines.push('_Для деталей уровня сети приложите также полный crash-report ZIP (он включает `main.log` с логами `systemCAFetch`/`sendLLMMessage`)._');

	return lines.join('\n') + '\n';
}
