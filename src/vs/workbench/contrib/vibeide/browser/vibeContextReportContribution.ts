/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IConvertToLLMMessageService, ContextBreakdown } from './convertToLLMMessageService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';

// Visual gauge dimensions: a `ROWS × COLS` grid of cells whose filled fraction mirrors the
// context-window fill. Plain-text editor → no ANSI colour, so a single fill glyph (no per-category
// tint like the terminal /context); the per-segment split lives in the table below.
const GAUGE_ROWS = 8;
const GAUGE_COLS = 24;
const CELL_FILLED = '⛁';
const CELL_EMPTY = '⛶';

function fmt(n: number): string {
	return n.toLocaleString('ru-RU');
}

/** Render the fill gauge for `used/max`. `max <= 0` (unknown window) → all-empty grid. */
function renderGauge(used: number, max: number): string {
	const total = GAUGE_ROWS * GAUGE_COLS;
	const fraction = max > 0 ? Math.min(1, Math.max(0, used / max)) : 0;
	const filled = Math.round(fraction * total);
	const cells: string[] = [];
	for (let r = 0; r < GAUGE_ROWS; r++) {
		const row: string[] = [];
		for (let c = 0; c < GAUGE_COLS; c++) {
			row.push((r * GAUGE_COLS + c) < filled ? CELL_FILLED : CELL_EMPTY);
		}
		cells.push(row.join(' '));
	}
	return cells.join('\n');
}

/** ASCII proportion bar for a single table row (share of the used budget). */
function bar(fraction: number, width: number = 16): string {
	const f = Math.min(1, Math.max(0, fraction));
	const filled = Math.round(f * width);
	return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function renderReport(b: ContextBreakdown): string {
	const lines: string[] = [];
	const model = `${b.providerName}/${b.modelName}`;

	lines.push(`# Context Report — ${model}`);
	lines.push('');

	// Header facts.
	lines.push(`Модель: ${model}`);
	lines.push(b.maxTokens > 0
		? `Контекстное окно: ${fmt(b.maxTokens)} токенов`
		: `Контекстное окно: неизвестно (модель не выбрана/не резолвится)`);

	if (b.liveTotalTokens !== undefined) {
		const pct = b.maxTokens > 0 ? (b.liveTotalTokens / b.maxTokens) * 100 : 0;
		lines.push(`Заполнено (факт последнего запроса): ${fmt(b.liveTotalTokens)} токенов${b.maxTokens > 0 ? ` (${pct.toFixed(1)}%)` : ''}`);
	} else {
		lines.push(`Заполнено (факт): нет данных — в этом треде ещё не было запроса (ниже только оценка состава).`);
	}
	lines.push(`Системная часть (оценка length/4): ${fmt(b.systemSideTokens)} токенов`);
	lines.push(`Калибровка estimate→real: ×${b.calibrationFactor.toFixed(2)} (реальные токены ≈ оценка × коэффициент)`);
	lines.push('');

	// Gauge — fill against the real fact when available, else the system-side estimate.
	const gaugeUsed = b.liveTotalTokens ?? b.systemSideTokens;
	lines.push('```');
	lines.push('Context Usage');
	lines.push(renderGauge(gaugeUsed, b.maxTokens));
	lines.push('');
	lines.push(`${CELL_FILLED} занято   ${CELL_EMPTY} свободно`);
	lines.push('```');
	lines.push('');

	// Per-segment table (system side), sorted by weight desc.
	const denom = b.systemSideTokens > 0 ? b.systemSideTokens : 1;
	const rows = [...b.segments].sort((x, y) => y.tokens - x.tokens);
	lines.push('## Состав системной части (оценка)');
	lines.push('');
	lines.push('| Категория | Токены | Доля | |');
	lines.push('|---|--:|--:|---|');
	for (const s of rows) {
		const frac = s.tokens / denom;
		lines.push(`| ${s.label} | ${fmt(s.tokens)} | ${(frac * 100).toFixed(1)}% | \`${bar(frac)}\` |`);
	}
	lines.push(`| **Система (итого)** | **${fmt(b.systemSideTokens)}** | **100%** | |`);
	lines.push('');

	// Conversation/history (derived remainder).
	lines.push('## Диалог / история');
	lines.push('');
	if (b.messagesTokens !== undefined) {
		lines.push(`Сообщения и динамические вставки (остаток от факта): **${fmt(b.messagesTokens)}** токенов (оценка).`);
		lines.push('');
		lines.push('> Считается как `факт / коэффициент − системная часть`: в этот остаток попадают история сообщений, префиксы пользовательского хода (skill/rule-врезки, языковая директива) и обрамляющие конверты <project_rules>/<session_goals>.');
	} else {
		lines.push('История недоступна, пока в треде не прошёл хотя бы один запрос (context guard ещё на нуле).');
	}
	lines.push('');

	// Notes.
	lines.push('---');
	lines.push('');
	lines.push('Примечания:');
	lines.push('- Оценка токенов — `length / 4` (тот же примитив, что у бюджет-гарда). Реальное число у плотных токенизаторов (код/CJK) и reasoning-моделей выше — на это и есть калибровочный коэффициент.');
	if (b.toolsViaSdk) {
		lines.push('- Модель использует нативный function-calling: схемы инструментов уходят через SDK провайдера, а НЕ в текст промпта. Строка «Инструменты» здесь — оценка веса этой поверхности, не часть системного текста.');
	}
	lines.push('- Отчёт ничего не отправляет: это слепок того, ЧТО ушло бы выбранной модели прямо сейчас.');

	return lines.join('\n');
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.context.status',
			title: { value: localize('vibeide.context.report', 'Отчёт об использовании контекста'), original: 'Show Context Usage Report' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Capture every service synchronously BEFORE any `await` — a ServicesAccessor is valid only
		// during the synchronous portion of run() (see services-accessor.md).
		const convertSvc = accessor.get(IConvertToLLMMessageService);
		const settingsSvc = accessor.get(IVibeideSettingsService);
		const modelSvc = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);

		const modelSelection = settingsSvc.state.modelSelectionOfFeature['Chat'] ?? null;
		const breakdown = await convertSvc.buildContextBreakdown(modelSelection);
		const content = renderReport(breakdown);

		const uri = URI.parse(`untitled://vibeide-context-report-${Date.now()}.md`);
		const ref = await modelSvc.createModelReference(uri);
		ref.object.textEditorModel?.setValue(content);
		ref.dispose();
		await editorService.openEditor({ resource: uri });
	}
});
