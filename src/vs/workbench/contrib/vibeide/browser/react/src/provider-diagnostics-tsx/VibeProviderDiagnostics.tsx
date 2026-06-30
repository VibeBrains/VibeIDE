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
 * (L1 config / L2 network / L3 auth / L4 models). Also exposes «Сбросить клиентов» — the
 * one-click fix for the "no tokens until restart" failure (stale local client caches +
 * wedged shared cloud dispatcher), and a Markdown export of the whole report.
 *
 * Inline classNames are `@@`-prefixed so scope-tailwind ships them raw (they match the
 * class names in vibeModal.css). See docs/knowledge/architecture/provider-diagnostics.md.
 */

type LayerStatus = 'idle' | 'pending' | 'ok' | 'warn' | 'fail' | 'skip';

interface LayerResult { status: LayerStatus; detail?: string }

interface ProviderRow {
	id: string;
	name: string;
	kind: 'builtin' | 'dynamic';
	baseURL?: string;
	keySource: string;            // 'gui' | 'env' | 'ref' | 'os-env' | 'secure' | 'none'
	dyn?: ProviderDiagnosticsTarget;
	layers: { config: LayerResult; network: LayerResult; auth: LayerResult; models: LayerResult };
	latencyMs?: number;
	modelCount?: number;
	selectedModelPresent?: boolean | null;  // null = not the selected provider
	checking: boolean;
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
		// Dynamic providers (.vibe/providers.json) — only the active ones (have a key).
		for (const t of dynProviders.getDiagnosticsTargets()) {
			const keySource = (t.apiKeyEnv && !t.apiKey) ? 'os-env' : t.keySource;
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
				if (!t.baseURL) {
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
				const res = await catalog.fetchDynamicWithStatus(t.baseURL, t.apiKey, t.modelsUrl);
				latencyMs = Math.round(performance.now() - start);
				if (res.status === 'ok') {
					layers.network = { status: 'ok' };
					layers.auth = { status: 'ok' };
					modelCount = res.models.length;
					layers.models = { status: modelCount > 0 ? 'ok' : 'warn', detail: `${modelCount} моделей` };
					markModelPresence(res.models);
				} else if (res.status === 'unauthorized') {
					layers.network = { status: 'ok' };
					if (!t.apiKey && t.apiKeyEnv) {
						layers.auth = { status: 'warn', detail: 'ключ в OS env — проверится при отправке' };
					} else {
						layers.auth = { status: 'fail', detail: 'ключ отклонён (401/403)' };
					}
					layers.models = { status: 'skip' };
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

	const recheckOne = useCallback(async (id: string) => {
		setRows(prev => prev.map(r => r.id === id ? { ...r, checking: true } : r));
		const target = rows.find(r => r.id === id);
		if (!target) { return; }
		const updated = await checkOne(target);
		setRows(prev => prev.map(r => r.id === id ? updated : r));
	}, [rows, checkOne]);

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

	const buildMarkdown = useCallback((): string => {
		const now = new Date().toISOString();
		const lines: string[] = [];
		lines.push('# VibeIDE — диагностика провайдеров', '', `Дата: ${now}`, `Окружение: ${navigator.userAgent}`, '');
		if (selectedModel) { lines.push(`Выбранная модель (Chat): \`${selectedModel.providerName} / ${selectedModel.modelName}\``, ''); }
		lines.push('| Провайдер | Тип | Ключ | Конфиг | Сеть | Авториз. | Модели | Latency | Выбранная модель |');
		lines.push('|---|---|---|---|---|---|---|---|---|');
		for (const r of rows) {
			const L = r.layers;
			const sel = r.selectedModelPresent === null ? '—' : (r.selectedModelPresent ? 'в каталоге ✓' : 'НЕ в каталоге ✗');
			lines.push(`| ${r.name} | ${r.kind} | ${KEY_SOURCE_LABEL[r.keySource] ?? r.keySource} | ${STATUS_GLYPH[L.config.status]} | ${STATUS_GLYPH[L.network.status]} | ${STATUS_GLYPH[L.auth.status]} | ${STATUS_GLYPH[L.models.status]}${r.modelCount !== undefined ? ` (${r.modelCount})` : ''} | ${r.latencyMs !== undefined ? r.latencyMs + ' мс' : '—'} | ${sel} |`);
		}
		lines.push('');
		// Per-provider detail (errors etc.)
		for (const r of rows) {
			const details = (Object.keys(r.layers) as (keyof ProviderRow['layers'])[])
				.filter(k => r.layers[k].detail)
				.map(k => `  - ${LAYER_LABELS[k]}: ${r.layers[k].status} — ${r.layers[k].detail}`);
			if (details.length) { lines.push(`### ${r.name}`, ...details, ''); }
		}
		lines.push('', '> Ключи не включены в отчёт — только источник.');
		return lines.join('\n');
	}, [rows, selectedModel]);

	const exportMd = useCallback(async () => {
		const md = buildMarkdown();
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
							<button className="@@vibeide-provdiag-recheck" disabled={r.checking || busy} onClick={() => recheckOne(r.id)}>↻</button>
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
							{r.selectedModelPresent === false && (
								<span className="@@vibeide-provdiag-chip status-warn" title="Выбранная в чате модель не найдена в каталоге провайдера">выбранной модели нет</span>
							)}
						</div>
						{r.baseURL && <div className="@@vibeide-provdiag-url">{r.baseURL}</div>}
						{Object.values(r.layers).some(l => l.detail && (l.status === 'fail' || l.status === 'warn')) && (
							<div className="@@vibeide-provdiag-detail">
								{(Object.keys(r.layers) as (keyof ProviderRow['layers'])[])
									.filter(k => r.layers[k].detail && (r.layers[k].status === 'fail' || r.layers[k].status === 'warn'))
									.map(k => <div key={k}>{LAYER_LABELS[k]}: {r.layers[k].detail}</div>)}
							</div>
						)}
					</div>
				))}
			</div>
		</VibeModalForm>
	);
};
