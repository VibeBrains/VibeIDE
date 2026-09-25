/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeModalForm } from '../components/VibeModalForm.js';
import type { ProviderDiagnosticsTarget } from '../../../vibeDynamicProvidersService.js';
import type { ProviderName } from '../../../../common/vibeideSettingsTypes.js';

/**
 * «Проверка провайдеров» — resizable diagnostics window (brain menu → under «VibeIDE Команды»).
 * Lists every ACTIVE provider (one with an API key) and runs layered connectivity checks
 * (L1 config / L2 network / L3 auth / L4 models), plus an OPT-IN L5 end-to-end request through
 * the real `sendLLMMessage` (catches wedged-transport bugs the catalog probe cannot see — the
 * probe bypasses the SDK client cache). Also exposes «Сбросить клиентов» — the one-click fix
 * for the "no tokens until restart" failure (stale local client caches + wedged shared cloud
 * dispatcher), and a Markdown export of the whole report including the send-path trace.
 *
 * Inline classNames are `@@`-prefixed so scope-tailwind ships them raw (they match the
 * class names in vibeModal.css). See docs/knowledge/architecture/provider-diagnostics.md.
 */

type LayerStatus = 'idle' | 'pending' | 'ok' | 'warn' | 'fail' | 'skip';

interface LayerResult { status: LayerStatus; detail?: string }

/** Auto-refresh tick for the L1–L4 sweep while the modal is open (toggle in the toolbar). */
const AUTO_REFRESH_INTERVAL_MS = 30_000;

/** L5 sends ONE real (paid) request — never automatically, only from the per-provider button. */
const L5_TIMEOUT_MS = 30_000;
const L5_PROMPT = 'Ответь одним словом: OK';
const L5_SYSTEM = 'Ты — проверка связи. Отвечай одним словом.';

interface ProviderRow {
	id: string;
	name: string;
	kind: 'builtin' | 'dynamic';
	baseURL?: string;
	keySource: string;            // 'gui' | 'env' | 'ref' | 'os-env' | 'secure' | 'keyless' | 'local' | 'none'
	dyn?: ProviderDiagnosticsTarget;
	layers: { config: LayerResult; network: LayerResult; auth: LayerResult; models: LayerResult };
	latencyMs?: number;
	modelCount?: number;
	selectedModelPresent?: boolean | null;  // null = not the selected provider
	checking: boolean;
	/** L5 end-to-end request result (opt-in, costs tokens) — undefined until the user runs it. */
	l5?: LayerResult;
	l5Running?: boolean;
}

const LAYER_LABELS: Record<keyof ProviderRow['layers'], string> = {
	config: 'Конфиг',
	network: 'Сеть',
	auth: 'Авториз.',
	models: 'Модели',
};

const KEY_SOURCE_LABEL: Record<string, string> = {
	gui: 'введён в IDE',
	env: '.vibe/.env',
	ref: 'ссылка (apiKeyRef)',
	'os-env': 'OS env (в main)',
	secure: 'защищённое хранилище',
	keyless: 'не нужен (auth: none)',
	local: 'не задан (локальный сервер)',
	none: 'нет ключа',
};

const idleLayers = (): ProviderRow['layers'] => ({
	config: { status: 'idle' }, network: { status: 'idle' }, auth: { status: 'idle' }, models: { status: 'idle' },
});

const STATUS_GLYPH: Record<LayerStatus, string> = {
	idle: '·', pending: '…', ok: '✓', warn: '!', fail: '✗', skip: '–',
};

export const VibeProviderDiagnostics: React.FC = () => {
	const accessor = useAccessor();
	const diagService = accessor.get('IVibeProviderDiagnosticsService');
	const dynProviders = accessor.get('IVibeDynamicProvidersService');
	const settings = accessor.get('IVibeideSettingsService');
	const catalog = accessor.get('IRemoteCatalogService');
	const llm = accessor.get('ILLMMessageService');
	const convert = accessor.get('IConvertToLLMMessageService');
	const secrets = accessor.get('ISecretDetectionService');
	const clipboard = accessor.get('IClipboardService');
	const editorService = accessor.get('IEditorService');
	const commandService = accessor.get('ICommandService');
	const notifications = accessor.get('INotificationService');

	const [open, setOpen] = useState<boolean>(() => diagService.isOpen);
	const [rows, setRows] = useState<ProviderRow[]>([]);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const sub = diagService.onDidChangeOpen((v) => setOpen(v));
		return () => sub.dispose();
	}, [diagService]);

	const close = useCallback(() => diagService.close(), [diagService]);

	// The chat-feature selected model — used to flag "selected model present in catalog".
	const selectedModel = useMemo(() => {
		const sel = settings.state.modelSelectionOfFeature?.['Chat'];
		return sel && sel.providerName !== 'auto' ? sel : null;
	}, [settings]);

	const enumerate = useCallback((): ProviderRow[] => {
		const out: ProviderRow[] = [];
		// Dynamic providers (.vibe/providers.json) — only the active ones (have a key, or need none).
		for (const t of dynProviders.getDiagnosticsTargets()) {
			const keySource = t.keyless ? 'keyless' : t.localWithoutKey ? 'local' : (t.apiKeyEnv && !t.apiKey) ? 'os-env' : t.keySource;
			out.push({ id: t.id, name: t.displayName, kind: 'dynamic', baseURL: t.baseURL, keySource, dyn: t, layers: idleLayers(), checking: false });
		}
		// Built-in providers — only those with an actual API key. NOT `_didFillInProviderSettings`:
		// local providers (ollama/vLLM/lmStudio) satisfy that via their default endpoint with NO key,
		// so a bare, unconfigured install would wrongly list them. "Active" = a key is set.
		const sop = settings.state.settingsOfProvider as Record<string, { apiKey?: string } | undefined>;
		for (const [name, s] of Object.entries(sop)) {
			if (typeof s?.apiKey === 'string' && s.apiKey.trim()) {
				out.push({ id: name, name, kind: 'builtin', keySource: 'secure', layers: idleLayers(), checking: false });
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}, [dynProviders, settings]);

	const checkOne = useCallback(async (row: ProviderRow): Promise<ProviderRow> => {
		const layers: ProviderRow['layers'] = {
			config: { status: 'ok' }, network: { status: 'pending' }, auth: { status: 'pending' }, models: { status: 'pending' },
		};
		let latencyMs: number | undefined;
		let modelCount: number | undefined;
		let selectedModelPresent: boolean | null = null;
		const isSelectedProvider = !!selectedModel && selectedModel.providerName === row.id;

		const markModelPresence = (models: { id: string; name: string }[]) => {
			if (!isSelectedProvider || !selectedModel) { return; }
			selectedModelPresent = models.some(m => m.id === selectedModel.modelName || m.name === selectedModel.modelName);
		};

		try {
			if (row.kind === 'dynamic') {
				const t = row.dyn!;
				if (!t.baseURL || !t.catalogRequest) {
					layers.config = { status: 'fail', detail: 'нет baseURL' };
					layers.network = layers.auth = layers.models = { status: 'skip' };
					return { ...row, layers, checking: false };
				}
				if (!t.modelsFetch) {
					layers.network = { status: 'skip', detail: 'models.fetch: false' };
					layers.auth = { status: 'skip', detail: 'статический список' };
					layers.models = { status: 'skip', detail: 'без probe' };
					return { ...row, layers, checking: false };
				}
				const start = performance.now();
				const res = await catalog.fetchDynamicWithStatus(t.catalogRequest);
				latencyMs = Math.round(performance.now() - start);
				if (res.status === 'ok') {
					layers.network = { status: 'ok' };
					layers.auth = t.keyless ? { status: 'skip', detail: 'ключ не нужен' }
						: t.localWithoutKey ? { status: 'skip', detail: 'ключ не задан — сервер ответил без него' }
							: { status: 'ok' };
					modelCount = res.models.length;
					layers.models = { status: modelCount > 0 ? 'ok' : 'warn', detail: `${modelCount} моделей` };
					markModelPresence(res.models);
				} else if (res.status === 'unauthorized') {
					layers.network = { status: 'ok' };
					if (t.keyless) {
						layers.auth = { status: 'fail', detail: 'сервер требует ключ, а в файле auth: "none"' };
					} else if (t.localWithoutKey) {
						layers.auth = { status: 'fail', detail: 'локальный сервер требует ключ — задайте его' };
					} else if (!t.apiKey && t.apiKeyEnv) {
						layers.auth = { status: 'warn', detail: 'ключ в OS env — проверится при отправке' };
					} else {
						layers.auth = { status: 'fail', detail: 'ключ отклонён (401/403)' };
					}
					layers.models = { status: 'skip' };
				} else if (res.status === 'absent') {
					layers.network = { status: 'ok' };
					layers.auth = { status: 'warn', detail: 'каталога по этому адресу нет (404) — ключ не проверен' };
					layers.models = { status: 'warn', detail: 'модели из списка файла' };
				} else {
					layers.network = { status: 'fail', detail: 'недоступен / ошибка сервера' };
					layers.auth = { status: 'skip' };
					layers.models = { status: 'skip' };
				}
			} else {
				// Built-in: fetchCatalog probes the provider's endpoint with the stored key.
				const start = performance.now();
				const models = await catalog.fetchCatalog(row.id as ProviderName, true);
				latencyMs = Math.round(performance.now() - start);
				layers.network = { status: 'ok' };
				layers.auth = { status: 'ok' };
				modelCount = models.length;
				layers.models = { status: modelCount > 0 ? 'ok' : 'warn', detail: `${modelCount} моделей` };
				markModelPresence(models);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			layers.network = { status: 'fail', detail: msg.slice(0, 140) };
			layers.auth = { status: 'skip' };
			layers.models = { status: 'skip' };
			vibeLog.warn('VibeProviderDiagnostics', `[diag] check failed for ${row.id}`, err);
		}
		return { ...row, layers, latencyMs, modelCount, selectedModelPresent, checking: false };
	}, [catalog, selectedModel]);

	const runAll = useCallback(async (initial: ProviderRow[]) => {
		setBusy(true);
		setRows(initial.map(r => ({ ...r, checking: true, layers: { config: { status: 'pending' }, network: { status: 'pending' }, auth: { status: 'pending' }, models: { status: 'pending' } } })));
		const checked = await Promise.all(initial.map(checkOne));
		setRows(checked);
		setBusy(false);
	}, [checkOne]);

	// On open: enumerate active providers and run all checks once.
	useEffect(() => {
		if (!open) { return; }
		void runAll(enumerate());
	}, [open, enumerate, runAll]);

	// Auto-refresh (Phase 3): while the modal is open and the toggle is on, re-probe L1–L4
	// on the EXISTING rows every 30s. `checkOne` spreads the row, so L5 results survive the
	// tick — and L5 itself is never auto-run (it costs tokens; manual-only by design).
	// The busy-guard skips a tick when the previous sweep is still in flight.
	const [autoRefresh, setAutoRefresh] = useState(false);
	const refreshExisting = useCallback(async () => {
		if (busy || rows.length === 0) { return; }
		setBusy(true);
		setRows(prev => prev.map(r => ({ ...r, checking: true })));
		const checked = await Promise.all(rows.map(checkOne));
		setRows(checked);
		setBusy(false);
	}, [busy, rows, checkOne]);
	useEffect(() => {
		if (!open) { setAutoRefresh(false); return; }
	}, [open]);
	useEffect(() => {
		if (!open || !autoRefresh) { return; }
		const id = window.setInterval(() => { void refreshExisting(); }, AUTO_REFRESH_INTERVAL_MS);
		return () => window.clearInterval(id);
	}, [open, autoRefresh, refreshExisting]);

	const recheckOne = useCallback(async (id: string) => {
		setRows(prev => prev.map(r => r.id === id ? { ...r, checking: true } : r));
		const target = rows.find(r => r.id === id);
		if (!target) { return; }
		const updated = await checkOne(target);
		setRows(prev => prev.map(r => r.id === id ? updated : r));
	}, [rows, checkOne]);

	/**
	 * L5 — one REAL request through sendLLMMessage (opt-in, costs tokens). Unlike L1–L4 (which
	 * go through the catalog probe), this exercises the SDK client cache + shared dispatcher —
	 * exactly the path that wedges in the "no tokens until restart" bug.
	 */
	const runL5 = useCallback((row: ProviderRow) => {
		const sop = settings.state.settingsOfProvider as Record<string, { models?: { modelName: string; isHidden?: boolean }[] } | undefined>;
		const modelName = (selectedModel && selectedModel.providerName === row.id)
			? selectedModel.modelName
			: (sop[row.id]?.models?.find(m => !m.isHidden) ?? sop[row.id]?.models?.[0])?.modelName;
		const setL5 = (l5: LayerResult, running: boolean) =>
			setRows(prev => prev.map(r => r.id === row.id ? { ...r, l5, l5Running: running } : r));
		if (!modelName) {
			setL5({ status: 'skip', detail: 'нет модели для теста — включите модель провайдера в настройках' }, false);
			return;
		}
		const { messages, separateSystemMessage } = convert.prepareLLMSimpleMessages({
			simpleMessages: [{ role: 'user', content: L5_PROMPT }],
			systemMessage: L5_SYSTEM,
			modelSelection: { providerName: row.id as ProviderName, modelName },
			featureName: 'Chat',
		});
		const startMs = performance.now();
		let firstTokenMs: number | undefined;
		let timer: number | undefined;
		let settled = false;
		const finish = (l5: LayerResult) => {
			if (settled) { return; }
			settled = true;
			if (timer !== undefined) { window.clearTimeout(timer); }
			setL5(l5, false);
		};
		setL5({ status: 'pending' }, true);
		const requestId = llm.sendLLMMessage({
			messagesType: 'chatMessages',
			messages,
			separateSystemMessage,
			chatMode: null,
			modelSelection: { providerName: row.id as ProviderName, modelName },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			onText: () => {
				if (firstTokenMs === undefined) { firstTokenMs = Math.round(performance.now() - startMs); }
			},
			onFinalMessage: () => {
				const totalMs = Math.round(performance.now() - startMs);
				finish({ status: 'ok', detail: `${modelName}: первый токен ${firstTokenMs ?? totalMs} мс · всего ${totalMs} мс` });
			},
			onError: (e) => finish({ status: 'fail', detail: `${modelName}: ${(e.message || String(e)).slice(0, 140)}` }),
			onAbort: () => finish({ status: 'fail', detail: `${modelName}: нет ответа за ${L5_TIMEOUT_MS / 1000} с (таймаут)` }),
			logging: { loggingName: 'ProviderDiagnostics/L5' },
		});
		if (requestId === null) { return; } // onError already fired synchronously
		timer = window.setTimeout(() => llm.abort(requestId), L5_TIMEOUT_MS);
	}, [llm, convert, selectedModel, settings]);

	/** True when the passive layers look healthy but the real request fails — the wedged-transport signature. */
	const l5Contradiction = useCallback((r: ProviderRow): boolean =>
		r.l5?.status === 'fail' && Object.values(r.layers).every(l => l.status === 'ok' || l.status === 'skip'), []);

	const resetClients = useCallback(async () => {
		setBusy(true);
		try {
			await llm.resetProviderClients();
			notifications.info('Клиенты провайдеров сброшены: кэши очищены, соединение пересоздано. Повторная проверка…');
			await runAll(enumerate());
		} catch (err) {
			notifications.error('Не удалось сбросить клиентов: ' + (err instanceof Error ? err.message : String(err)));
			setBusy(false);
		}
	}, [llm, notifications, runAll, enumerate]);

	const buildMarkdown = useCallback(async (): Promise<string> => {
		const now = new Date().toISOString();
		const lines: string[] = [];
		lines.push('# VibeIDE — диагностика провайдеров', '', `Дата: ${now}`, `Окружение: ${navigator.userAgent}`, '');
		if (selectedModel) { lines.push(`Выбранная модель (Chat): \`${selectedModel.providerName} / ${selectedModel.modelName}\``, ''); }
		lines.push('| Провайдер | Тип | Ключ | Конфиг | Сеть | Авториз. | Модели | L5 (запрос) | Latency | Выбранная модель |');
		lines.push('|---|---|---|---|---|---|---|---|---|---|');
		for (const r of rows) {
			const L = r.layers;
			const sel = r.selectedModelPresent === null ? '—' : (r.selectedModelPresent ? 'в каталоге ✓' : 'НЕ в каталоге ✗');
			lines.push(`| ${r.name} | ${r.kind} | ${KEY_SOURCE_LABEL[r.keySource] ?? r.keySource} | ${STATUS_GLYPH[L.config.status]} | ${STATUS_GLYPH[L.network.status]} | ${STATUS_GLYPH[L.auth.status]} | ${STATUS_GLYPH[L.models.status]}${r.modelCount !== undefined ? ` (${r.modelCount})` : ''} | ${r.l5 ? STATUS_GLYPH[r.l5.status] : '·'} | ${r.latencyMs !== undefined ? r.latencyMs + ' мс' : '—'} | ${sel} |`);
		}
		lines.push('');
		// Per-provider detail (errors etc.)
		for (const r of rows) {
			const details = (Object.keys(r.layers) as (keyof ProviderRow['layers'])[])
				.filter(k => r.layers[k].detail)
				.map(k => `  - ${LAYER_LABELS[k]}: ${r.layers[k].status} — ${r.layers[k].detail}`);
			if (r.l5?.detail) { details.push(`  - L5 (сквозной запрос): ${r.l5.status} — ${r.l5.detail}`); }
			if (l5Contradiction(r)) { details.push('  - ⚠ L1–L4 зелёные, а сквозной запрос падает — похоже на залипший транспорт/кэш клиента; поможет «Сбросить клиентов».'); }
			if (details.length) { lines.push(`### ${r.name}`, ...details, ''); }
		}
		// Send-path trace from main (defense-in-depth: details are built secret-free at the
		// source, and the whole snapshot is redacted again before it leaves the modal).
		try {
			const traceRaw = await llm.getSendTrace();
			const trace = secrets.getConfig().enabled ? secrets.redactSecretsInObject(traceRaw).redacted : traceRaw;
			if (trace.length) {
				lines.push(`## События send-path (последние ${trace.length})`, '');
				lines.push('| Время | Событие | requestId | Провайдер | Модель | Детали |', '|---|---|---|---|---|---|');
				for (const e of trace) {
					lines.push(`| ${new Date(e.atMs).toISOString().slice(11, 23)} | ${e.kind} | ${e.requestId ? e.requestId.slice(0, 8) : '—'} | ${e.providerName ?? '—'} | ${e.modelName ?? '—'} | ${e.detail ?? ''} |`);
				}
				lines.push('');
			}
		} catch { /* trace is best-effort — the report is still useful without it */ }
		// Per-model normalization drill-down (Phase 3 / audit G): which model the layers carry —
		// same data as the Settings panel, so the exported report is self-sufficient for an issue.
		try {
			const byModel = await llm.getNormalizeCountersByModel();
			const rowsByModel = Object.entries(byModel)
				.map(([modelKey, perLayer]) => {
					const entries = Object.entries(perLayer).filter(([, hits]) => hits > 0);
					const total = entries.reduce((a, [, hits]) => a + hits, 0);
					const top = entries.sort((a, b) => b[1] - a[1])[0];
					return { modelKey, total, top };
				})
				.filter(e => e.total > 0)
				.sort((a, b) => b.total - a.total);
			if (rowsByModel.length) {
				lines.push('## Нормализация tool-call по моделям', '');
				lines.push('| Модель | Хиты | Топ-слой |', '|---|---|---|');
				for (const e of rowsByModel) {
					lines.push(`| ${e.modelKey} | ${e.total} | ${e.top ? `${e.top[0]} (${e.top[1]})` : '—'} |`);
				}
				lines.push('');
			}
		} catch { /* counters are best-effort too */ }
		lines.push('', '> Ключи не включены в отчёт — только источник; события send-path прогнаны через редакцию секретов.');
		return lines.join('\n');
	}, [rows, selectedModel, llm, secrets, l5Contradiction]);

	/** Markdown fragment for ONE provider card — handy to paste into an issue/chat. */
	const buildProviderMarkdown = useCallback((r: ProviderRow): string => {
		const L = r.layers;
		const layerLine = (Object.keys(L) as (keyof ProviderRow['layers'])[])
			.map(k => `${LAYER_LABELS[k]} ${STATUS_GLYPH[L[k].status]}`)
			.join(' · ');
		const lines: (string | undefined)[] = [
			`### ${r.name} (${r.kind === 'dynamic' ? 'свой' : 'встроенный'})`,
			`Ключ: ${KEY_SOURCE_LABEL[r.keySource] ?? r.keySource}`,
			`Слои: ${layerLine}${r.modelCount !== undefined ? ` · моделей: ${r.modelCount}` : ''}`,
			r.l5 ? `L5 (сквозной запрос): ${STATUS_GLYPH[r.l5.status]}${r.l5.detail ? ` — ${r.l5.detail}` : ''}` : undefined,
			r.latencyMs !== undefined ? `Latency: ${r.latencyMs} мс` : undefined,
			r.baseURL ? `URL: ${r.baseURL}` : undefined,
			...(Object.keys(L) as (keyof ProviderRow['layers'])[])
				.filter(k => L[k].detail)
				.map(k => `- ${LAYER_LABELS[k]}: ${L[k].status} — ${L[k].detail}`),
			l5Contradiction(r) ? '- ⚠ L1–L4 зелёные, а сквозной запрос падает — похоже на залипший транспорт/кэш клиента.' : undefined,
		];
		return lines.filter((l): l is string => !!l).join('\n');
	}, [l5Contradiction]);

	const copyProvider = useCallback(async (r: ProviderRow) => {
		try {
			await clipboard.writeText(buildProviderMarkdown(r));
			notifications.info(`Отчёт по «${r.name}» скопирован в буфер.`);
		} catch (err) {
			notifications.error('Не удалось скопировать: ' + (err instanceof Error ? err.message : String(err)));
		}
	}, [buildProviderMarkdown, clipboard, notifications]);

	const exportMd = useCallback(async () => {
		const md = await buildMarkdown();
		try { await clipboard.writeText(md); } catch { /* clipboard optional */ }
		try {
			await editorService.openEditor({ resource: undefined, contents: md, languageId: 'markdown', options: { pinned: true } });
		} catch (err) {
			notifications.error('Не удалось открыть отчёт: ' + (err instanceof Error ? err.message : String(err)));
		}
	}, [buildMarkdown, clipboard, editorService, notifications]);

	const summary = useMemo(() => {
		let ok = 0, warn = 0, fail = 0;
		for (const r of rows) {
			const states = Object.values(r.layers).map(l => l.status);
			if (states.includes('fail')) { fail++; }
			else if (states.includes('warn')) { warn++; }
			else if (states.every(s => s === 'ok' || s === 'skip')) { ok++; }
		}
		return { total: rows.length, ok, warn, fail };
	}, [rows]);

	return (
		<VibeModalForm
			open={open}
			title="Проверка провайдеров"
			onClose={close}
			defaultWidth={780}
			defaultHeight={560}
			headerRight={<span className="@@vibeide-provdiag-summary">{`${summary.total} · ✓${summary.ok} · !${summary.warn} · ✗${summary.fail}`}</span>}
		>
			<div className="@@vibeide-provdiag-toolbar">
				<button className="@@vibeide-provdiag-btn" disabled={busy} onClick={() => runAll(enumerate())}>Проверить все</button>
				<button className="@@vibeide-provdiag-btn" disabled={busy} onClick={resetClients} title="Очистить кэши клиентов и пересоздать соединение без перезапуска IDE">Сбросить клиентов</button>
				<button className="@@vibeide-provdiag-btn" onClick={exportMd}>Экспорт в Markdown</button>
				<button
					className="@@vibeide-provdiag-btn"
					onClick={() => setAutoRefresh(v => !v)}
					title="Автоматически перепроверять слои L1–L4 каждые 30 секунд, пока окно открыто (L5 не запускается — тратит токены)"
				>
					{autoRefresh ? '◉ Авто: вкл' : '○ Авто: выкл'}
				</button>
				<button className="@@vibeide-provdiag-btn" onClick={() => commandService.executeCommand('workbench.action.toggleVibeideSettings')}>Открыть настройки</button>
			</div>

			<div className="@@vibeide-provdiag-list">
				{rows.length === 0 && (
					<div className="@@vibeide-provdiag-empty">Нет активных провайдеров (с прописанным API-ключом).</div>
				)}
				{rows.map((r) => (
					<div key={`${r.kind}:${r.id}`} className="@@vibeide-provdiag-card">
						<div className="@@vibeide-provdiag-card-head">
							<span className="@@vibeide-provdiag-name">{r.name}</span>
							<span className="@@vibeide-provdiag-kind">{r.kind === 'dynamic' ? 'свой' : 'встроенный'}</span>
							<span className="@@vibeide-provdiag-key">ключ: {KEY_SOURCE_LABEL[r.keySource] ?? r.keySource}</span>
							<span className="@@vibeide-provdiag-spacer" />
							{r.latencyMs !== undefined && <span className="@@vibeide-provdiag-latency">{r.latencyMs} мс</span>}
							<button
								className="@@vibeide-provdiag-recheck"
								disabled={r.checking || busy || r.l5Running}
								title="L5: один настоящий запрос к модели через sendLLMMessage — тратит токены"
								onClick={() => runL5(r)}
							>L5</button>
							<button className="@@vibeide-provdiag-recheck" disabled={r.checking || busy} onClick={() => recheckOne(r.id)}>↻</button>
							<button
								className="@@vibeide-provdiag-recheck"
								title="Скопировать отчёт по этому провайдеру (markdown)"
								onClick={() => { void copyProvider(r); }}
							>⧉</button>
						</div>
						<div className="@@vibeide-provdiag-layers">
							{(Object.keys(r.layers) as (keyof ProviderRow['layers'])[]).map((k) => {
								const l = r.layers[k];
								return (
									<span key={k} className={`@@vibeide-provdiag-chip status-${l.status}`} title={l.detail || ''}>
										<span className="@@vibeide-provdiag-chip-glyph">{STATUS_GLYPH[l.status]}</span>
										{LAYER_LABELS[k]}
									</span>
								);
							})}
							{r.l5 && (
								<span className={`@@vibeide-provdiag-chip status-${r.l5.status}`} title={r.l5.detail || 'Сквозной запрос через sendLLMMessage'}>
									<span className="@@vibeide-provdiag-chip-glyph">{STATUS_GLYPH[r.l5.status]}</span>
									Запрос (L5)
								</span>
							)}
							{r.selectedModelPresent === false && (
								<span className="@@vibeide-provdiag-chip status-warn" title="Выбранная в чате модель не найдена в каталоге провайдера">выбранной модели нет</span>
							)}
						</div>
						{r.baseURL && <div className="@@vibeide-provdiag-url">{r.baseURL}</div>}
						{(Object.values(r.layers).some(l => l.detail && (l.status === 'fail' || l.status === 'warn')) || (r.l5?.detail && r.l5.status !== 'pending')) && (
							<div className="@@vibeide-provdiag-detail">
								{(Object.keys(r.layers) as (keyof ProviderRow['layers'])[])
									.filter(k => r.layers[k].detail && (r.layers[k].status === 'fail' || r.layers[k].status === 'warn'))
									.map(k => <div key={k}>{LAYER_LABELS[k]}: {r.layers[k].detail}</div>)}
								{r.l5?.detail && r.l5.status !== 'pending' && <div>Запрос (L5): {r.l5.detail}</div>}
							</div>
						)}
						{l5Contradiction(r) && (
							<div className="@@vibeide-provdiag-detail">
								⚠ Слои L1–L4 зелёные, а сквозной запрос падает — похоже на залипший транспорт или кэш клиента.{' '}
								<button className="@@vibeide-provdiag-btn" disabled={busy} onClick={resetClients}>Сбросить клиентов</button>
							</div>
						)}
					</div>
				))}
			</div>
		</VibeModalForm>
	);
};
