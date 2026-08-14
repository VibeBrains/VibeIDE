/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor, useIsDark } from '../util/services.js';
import { AgentRunRecord, AgentRunStatus, isTerminalRunStatus, summariseAgentRuns } from '../../../../common/agentRunLedger.js';
import { formatChatTimestamp } from '../../../../common/chatTimestampFormatter.js';
import { SubagentStopReason, stopReasonToRussian } from '../../../../common/subagentLoopPolicy.js';
import { AgentSessionMismatch, sessionMismatchToRussian } from '../../../../common/agentRunFingerprint.js';

// ── Vocabulary ────────────────────────────────────────────────────────────────
// The ledger stores roles and statuses as plain strings so a rename cannot orphan old records;
// these tables give them a Russian face, falling back to the raw value when it is unknown.

const ROLE_NAMES: Record<string, string> = {
	'explore': 'Исследование',
	'implement-step': 'Реализация шага',
	'recover-or-skip': 'Восстановление',
	'orchestrator': 'Оркестратор',
	'planner': 'Планировщик',
	'designer': 'Дизайнер',
	'frontend-dev': 'Фронтенд',
	'backend-dev': 'Бэкенд',
	'code-reviewer': 'Ревьюер',
	'qa': 'Тестирование',
	'security': 'Безопасность',
};

const STATUS_NAMES: Record<AgentRunStatus, string> = {
	'pending': 'в очереди',
	'running': 'работает',
	'completed': 'готово',
	'failed': 'ошибка',
	'stopped': 'остановлен',
	'skipped': 'пропущен',
	'orphaned': 'брошен',
};

/** Chart colours follow the active theme, so the panel reads correctly in light and dark. */
const STATUS_COLORS: Record<AgentRunStatus, string> = {
	'pending': 'var(--vibe-fg-3)',
	'running': 'var(--vscode-charts-blue)',
	'completed': 'var(--vscode-charts-green)',
	'failed': 'var(--vscode-charts-red)',
	'stopped': 'var(--vibe-fg-3)',
	'skipped': 'var(--vibe-fg-3)',
	'orphaned': 'var(--vscode-charts-orange)',
};

type RunFilter = 'all' | 'live' | 'done' | 'attention';

const FILTER_NAMES: Record<RunFilter, string> = {
	'all': 'Все',
	'live': 'Работают',
	'done': 'Завершены',
	'attention': 'Требуют внимания',
};

const LIMIT_STOP_CODES: ReadonlySet<string> = new Set(['max-steps', 'deadline', 'token-budget']);

function needsAttention(run: AgentRunRecord): boolean {
	return run.status === 'orphaned' || run.status === 'failed' || (!!run.stopCode && LIMIT_STOP_CODES.has(run.stopCode));
}

function formatCount(value: number): string {
	return value.toLocaleString('ru-RU');
}

/** "12 400 / 100 000" — a spend without its ceiling says nothing about whether it was a lot. */
function formatOfQuota(used: number | undefined, quota: number | undefined): string {
	if (used === undefined && quota === undefined) {
		return '—';
	}
	const left = used === undefined ? '—' : formatCount(used);
	return quota === undefined || quota === 0 ? left : `${left} / ${formatCount(quota)}`;
}

/** Why a run ended, in words — the pill alone never explains itself. */
function describeOutcome(run: AgentRunRecord): string | undefined {
	if (run.status === 'orphaned') {
		return 'окно закрылось, не завершив прогон';
	}
	if (run.stopCode) {
		return stopReasonToRussian(run.stopCode as SubagentStopReason);
	}
	return run.failureReason;
}

// ── Presentational pieces ─────────────────────────────────────────────────────

const Label = ({ children }: { children: React.ReactNode }) =>
	<div className='text-root uppercase tracking-[0.12em] text-vibe-fg-2'>{children}</div>;

const Cell = ({ label, value, hint }: { label: string; value: string; hint?: string }) =>
	<div className='rounded-md border border-vibe-border-4 bg-vibe-bg-1 px-3 py-2'>
		<Label>{label}</Label>
		<div className='mt-0.5 text-root text-vibe-fg-1 truncate' title={value}>{value}</div>
		{hint && <div className='mt-0.5 text-root text-vibe-fg-2 truncate' title={hint}>{hint}</div>}
	</div>;

const StatusPill = ({ status }: { status: AgentRunStatus }) =>
	<span className='inline-flex items-center gap-1.5 rounded-full border border-vibe-border-3 px-2 py-0.5 text-root text-vibe-fg-2'>
		<span className='inline-block size-1.5 rounded-full' style={{ background: STATUS_COLORS[status] }} />
		{STATUS_NAMES[status]}
	</span>;

const AttentionTile = ({ label, count }: { label: string; count: number }) =>
	<div className='flex items-center justify-between rounded-md border border-vibe-border-4 bg-vibe-bg-1 px-3 py-2'>
		<span className='text-root text-vibe-fg-2'>{label}</span>
		<span className={`text-root tabular-nums ${count > 0 ? 'text-vibe-fg-0' : 'text-vibe-fg-2'}`}>{count}</span>
	</div>;

const RunCard = ({ run }: { run: AgentRunRecord }) => {
	const outcome = describeOutcome(run);
	const files = run.artifacts ?? [];

	return <div className='rounded-lg border border-vibe-border-3 bg-vibe-bg-2 p-4'>
		<div className='flex items-start justify-between gap-3'>
			<div className='min-w-0'>
				<Label>{`Роль: ${ROLE_NAMES[run.role] ?? run.role}`}</Label>
				<div className='mt-1 text-base text-vibe-fg-0 break-words'>{run.goal || '—'}</div>
			</div>
			<StatusPill status={run.status} />
		</div>

		<div className='mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4'>
			<Cell
				label='Токены'
				value={formatOfQuota(run.tokensUsed, run.tokenQuota)}
				// The role is not billed twice for prompt-cached context; without this line that
				// discount is invisible and the spend looks unexplained.
				hint={run.cachedTokens ? `из кэша ${formatCount(run.cachedTokens)}` : undefined}
			/>
			<Cell label='Шаги' value={formatOfQuota(run.stepsDone, run.maxSteps)} />
			<Cell label='Модель' value={run.model || '—'} />
			<Cell label='Начат' value={formatChatTimestamp(run.startedAt, 'DD.MM.YYYY HH:mm')} />
		</div>

		{files.length > 0 && <div className='mt-3'>
			<Label>Файлы</Label>
			<div className='mt-1 font-mono text-root text-vibe-fg-2 break-all'>{files.join(', ')}</div>
		</div>}

		<div className='mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-vibe-border-4 pt-2'>
			<span className='font-mono text-root text-vibe-fg-2'>{run.runId}</span>
			<div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-root text-vibe-fg-2'>
				{run.replayOfRunId && <span title={`повтор прогона ${run.replayOfRunId}`}>повтор</span>}
				{run.resumeReason && <span>{`продолжен на новом основании: ${sessionMismatchToRussian(run.resumeReason as AgentSessionMismatch)}`}</span>}
				{outcome && <span>{outcome}</span>}
			</div>
		</div>
	</div>;
};

// ── Panel ─────────────────────────────────────────────────────────────────────

export const AgentsDispatch = () => {
	const accessor = useAccessor();
	const ledger = accessor.get('IVibeAgentRunLedgerService');

	const [runs, setRuns] = useState<readonly AgentRunRecord[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [filter, setFilter] = useState<RunFilter>('all');
	const [query, setQuery] = useState('');

	const reload = useCallback(async () => {
		const next = await ledger.getRuns();
		setRuns(next);
		setLoaded(true);
	}, [ledger]);

	useEffect(() => {
		void reload();
		const listener = ledger.onDidChangeRuns(() => void reload());
		return () => listener.dispose();
	}, [ledger, reload]);

	const summary = useMemo(() => summariseAgentRuns(runs), [runs]);

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return runs
			.filter(run => {
				if (filter === 'live') { return !isTerminalRunStatus(run.status); }
				if (filter === 'done') { return isTerminalRunStatus(run.status); }
				if (filter === 'attention') { return needsAttention(run); }
				return true;
			})
			.filter(run => !needle
				|| run.goal.toLowerCase().includes(needle)
				|| run.role.toLowerCase().includes(needle)
				|| (run.model ?? '').toLowerCase().includes(needle))
			// Working runs first, then the most recent — the question "кто сейчас работает" comes first.
			.sort((a, b) => {
				const liveDelta = Number(isTerminalRunStatus(a.status)) - Number(isTerminalRunStatus(b.status));
				return liveDelta !== 0 ? liveDelta : b.startedAt - a.startedAt;
			});
	}, [runs, filter, query]);

	const enabled = ledger.isEnabled();
	const isDark = useIsDark();

	// `@@vibe-scope` is mandatory: scope-tailwind wraps every generated rule in `.vibe-scope`,
	// so a React root without it renders completely unstyled — the markup is right, the CSS
	// simply never matches. `dark` drives Tailwind's selector-based dark mode.
	//
	// The root carries NO utility classes. Rules are generated as `.vibe-scope .vibe-px-6`, i.e.
	// for DESCENDANTS, so anything put here silently does nothing — measured: `padding: 0px`
	// while `px-6 py-5` was declared. Sizing and background go through inline style; the rest
	// lives on the inner wrapper.
	return <div
		className={`@@vibe-scope ${isDark ? 'dark' : ''}`}
		style={{ height: '100%', width: '100%', overflowY: 'auto', background: 'var(--vibe-bg-1)' }}
	>
		<div className='mx-auto flex max-w-5xl flex-col gap-4 px-8 py-8 text-vibe-fg-1'>

			<div className='flex items-end justify-between gap-4'>
				<div>
					<h1 className='text-4xl font-semibold text-vibe-fg-0'>Диспетчерская агентов</h1>
					<div className='mt-0.5 text-root text-vibe-fg-2'>Кто что делает и что сделал</div>
				</div>
				<div className='flex items-center gap-2'>
					<button
						className='rounded-md border border-vibe-border-3 px-3 py-1.5 text-root text-vibe-fg-1 transition-colors hover:bg-vibe-bg-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-vibe-border-1'
						title='Показать, что агенту или роли будет разрешено — ничего не запуская'
						onClick={() => void accessor.get('ICommandService').executeCommand('vibeide.agents.preflight')}
					>
						Проверить запуск
					</button>
					<button
						className='rounded-md border border-vibe-border-3 px-3 py-1.5 text-root text-vibe-fg-1 transition-colors hover:bg-vibe-bg-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-vibe-border-1'
						onClick={() => void reload()}
					>
						Обновить
					</button>
				</div>
			</div>

			{!enabled && <div className='rounded-md border border-vibe-border-3 bg-vibe-bg-2 px-3 py-2 text-root text-vibe-warning'>
				Журнал прогонов выключен (<span className='font-mono text-root'>vibeide.agents.ledger.enable</span>). Новые прогоны не записываются — список показывает только то, что было записано раньше.
			</div>}

			<div className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
				<AttentionTile label='Брошенные прогоны' count={summary.orphaned} />
				<AttentionTile label='Завершились ошибкой' count={summary.failed} />
				<AttentionTile label='Упёрлись в лимит' count={summary.limited} />
			</div>

			<div className='flex flex-wrap items-center gap-2'>
				{(Object.keys(FILTER_NAMES) as RunFilter[]).map(key =>
					<button
						key={key}
						className={`rounded-full border px-3 py-1 text-root transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-vibe-border-1 ${filter === key
							? 'border-vibe-border-1 bg-vibe-bg-2 text-vibe-fg-0'
							: 'border-vibe-border-4 text-vibe-fg-2 hover:text-vibe-fg-1'}`}
						onClick={() => setFilter(key)}
					>
						{FILTER_NAMES[key]}
					</button>
				)}
				<label className='ml-auto flex items-center gap-2 text-root text-vibe-fg-2' htmlFor='vibe-dispatch-search'>
					Поиск
					<input
						id='vibe-dispatch-search'
						className='w-56 rounded-md border border-vibe-border-3 bg-vibe-bg-1 px-3 py-1.5 text-root text-vibe-fg-1 placeholder:text-vibe-fg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-vibe-border-1'
						placeholder='Цель, роль или модель'
						value={query}
						onChange={e => setQuery(e.target.value)}
					/>
				</label>
			</div>

			{visible.length === 0
				? <div className='rounded-lg border border-dashed border-vibe-border-3 mx-auto max-w-[70ch] px-4 py-10 text-center text-root text-vibe-fg-2'>
					{!loaded
						? 'Читаю журнал…'
						: runs.length === 0
							// Неразрывные пробелы после коротких слов: иначе «и», «он», «как» повисают
						// в конце строки — то самое, что наш же детектор считает дефектом набора.
						? 'Прогонов ещё не было. Здесь появится каждый запуск роли — и пока он работает, и после того как закончил.'
							: 'Под фильтр ничего не подошло.'}
				</div>
				: <div className='flex flex-col gap-3'>
					{visible.map(run => <RunCard key={run.runId} run={run} />)}
				</div>}

			<div className='mx-auto max-w-[70ch] pt-1 text-center text-root text-vibe-fg-2'>
				{`Всего прогонов: ${formatCount(summary.total)} · токенов израсходовано: ${formatCount(summary.tokensTotal)}. `}
				В журнал попадают только метаданные прогона — переписка с моделью, промпты и аргументы инструментов в него не пишутся.
			</div>
		</div>
	</div>;
};
