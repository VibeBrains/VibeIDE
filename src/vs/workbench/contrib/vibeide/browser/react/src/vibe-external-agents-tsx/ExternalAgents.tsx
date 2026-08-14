/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor, useIsDark } from '../util/services.js';
import { IVibeAcpSessionView } from '../../../acp/vibeAcpSessionsService.js';
import { AcpLogEntry, IAcpSessionSpend } from '../../../../common/acp/acpSessionLog.js';
import { AcpStopReason, IAcpDiff } from '../../../../common/acp/acpProtocol.js';
import { VibeAgentEntry } from '../../../../common/acp/vibeAgentsFile.js';

// ── Словарь ───────────────────────────────────────────────────────────────────

const STOP_NAMES: Record<AcpStopReason, string> = {
	'completed': 'ход завершён',
	'cancelled': 'ход прерван',
	'refusal': 'агент отказался',
	'max_turns': 'упёрся в предел шагов',
	'max_tokens': 'упёрся в предел токенов',
	'unknown': 'причина остановки неизвестна',
};

const TOOL_KIND_NAMES: Record<string, string> = {
	'read': 'чтение',
	'edit': 'правка',
	'delete': 'удаление',
	'move': 'перемещение',
	'search': 'поиск',
	'execute': 'команда',
	'think': 'размышление',
	'fetch': 'запрос в сеть',
};

/** Дифф длиннее этого сворачивается: правка на 200 строк иначе вытеснит с экрана всё остальное. */
const DIFF_PREVIEW_LINES = 12;

/**
 * Кнопка поверхности.
 *
 * Компонент, а не строковая константа с классами: scope-tailwind префиксует только литералы в
 * JSX, и классы, вынесенные в переменную, до стилей не доезжают — кнопка остаётся голой.
 * Обводка фокуса задана явно: без неё с клавиатуры не видно, где находишься.
 */
const PaneButton = ({ children, onClick, disabled, title, quiet }: {
	children: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
	title?: string;
	quiet?: boolean;
}) => <button
	className={`rounded-md border px-3 py-1.5 text-root text-vibe-fg-1 transition-colors hover:bg-vibe-bg-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-vibe-border-1 disabled:opacity-50 ${quiet ? 'border-transparent' : 'border-vibe-border-3'}`}
	disabled={disabled}
	title={title}
	onClick={onClick}
>
	{children}
</button>;

const formatCount = (value: number): string => value.toLocaleString('ru-RU');

/** Цена хода в рублях не считается — курс наш выдумывать нельзя; показываем как есть, в долларах. */
function formatSpend(spend: IAcpSessionSpend | undefined): string {
	if (!spend) { return 'расход пока не сообщался'; }
	const context = `${formatCount(spend.used)} / ${formatCount(spend.size)} токенов контекста`;
	return spend.costUsd === undefined ? context : `${context} · $${spend.costUsd.toFixed(4)}`;
}

// ── Дифф ──────────────────────────────────────────────────────────────────────

const DiffBlock = ({ diff }: { diff: IAcpDiff }) => {
	const [expanded, setExpanded] = useState(false);
	const oldLines = diff.oldText ? diff.oldText.split('\n') : [];
	const newLines = diff.newText ? diff.newText.split('\n') : [];
	const long = oldLines.length + newLines.length > DIFF_PREVIEW_LINES;
	const cut = (lines: string[]) => (expanded || !long ? lines : lines.slice(0, DIFF_PREVIEW_LINES));

	return <div className='rounded-md border border-vibe-border-4 bg-vibe-bg-1'>
		<div className='border-b border-vibe-border-4 px-2 py-1 font-mono text-root text-vibe-fg-2'>{diff.path}</div>
		<pre className='overflow-x-auto px-2 py-1 font-mono text-root leading-relaxed'>
			{cut(oldLines).map((line, index) => <div key={`o${index}`} className='text-vibe-warning'>{`− ${line}`}</div>)}
			{cut(newLines).map((line, index) => <div key={`n${index}`} className='text-vibe-success'>{`+ ${line}`}</div>)}
		</pre>
		{long && <button
			className='w-full border-t border-vibe-border-4 px-2 py-1 text-root text-vibe-fg-2 transition-colors hover:text-vibe-fg-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-vibe-border-1'
			onClick={() => setExpanded(value => !value)}
		>
			{expanded ? 'Свернуть' : `Показать целиком (${oldLines.length + newLines.length} строк)`}
		</button>}
	</div>;
};

// ── Лента ─────────────────────────────────────────────────────────────────────

const LogEntry = ({ entry }: { entry: AcpLogEntry }) => {
	if (entry.kind === 'message') {
		return <div className={`whitespace-pre-wrap text-root ${entry.thought ? 'italic text-vibe-fg-2' : 'text-vibe-fg-1'}`}>
			{entry.text}
		</div>;
	}
	const kind = TOOL_KIND_NAMES[entry.toolKind] ?? entry.toolKind;
	return <div className='rounded-lg border border-vibe-border-3 bg-vibe-bg-2 px-3 py-2'>
		<div className='flex items-center justify-between gap-2 text-root'>
			<span className='text-vibe-fg-1'>{entry.title || 'действие без названия'}</span>
			<span className='text-vibe-fg-2'>{[kind, entry.status === 'failed' ? 'ошибка' : entry.status === 'completed' ? 'готово' : 'идёт'].filter(Boolean).join(' · ')}</span>
		</div>
		{entry.paths.length > 0 && entry.diffs.length === 0 && <div className='mt-1 font-mono text-root text-vibe-fg-2'>
			{entry.paths.join('\n')}
		</div>}
		{entry.diffs.length > 0 && <div className='mt-2 flex flex-col gap-2'>
			{entry.diffs.map((diff, index) => <DiffBlock key={`${diff.path}:${index}`} diff={diff} />)}
		</div>}
	</div>;
};

// ── Вопрос разрешения ─────────────────────────────────────────────────────────

const PermissionCard = ({ session, onAnswer }: { session: IVibeAcpSessionView; onAnswer: (optionId: string | undefined) => void }) => {
	const request = session.pendingPermission;
	if (!request) { return null; }
	return <div className='rounded-lg border border-vibe-warning bg-vibe-bg-2 px-3 py-3'>
		<div className='text-root font-semibold text-vibe-fg-0'>{request.title}</div>
		<div className='mt-1 whitespace-pre-wrap text-root text-vibe-fg-2'>{request.detail}</div>
		{request.diffs.length > 0 && <div className='mt-2 flex flex-col gap-2'>
			{request.diffs.map((diff, index) => <DiffBlock key={`${diff.path}:${index}`} diff={diff} />)}
		</div>}
		<div className='mt-3 flex flex-wrap items-center gap-2'>
			{/* Варианты придумывает сам агент: угадывать, который из них «нет», нельзя. */}
			{request.options.map(option => <PaneButton key={option.optionId} onClick={() => onAnswer(option.optionId)}>
				{option.name}
			</PaneButton>)}
			<PaneButton
				quiet
				title='Ответ «нет» без выбора варианта: агент получит отмену, а снятый чекпоинт будет отброшен'
				onClick={() => onAnswer(undefined)}
			>
				Отказать
			</PaneButton>
		</div>
		<div className='mt-2 text-root text-vibe-fg-2'>Чекпоинт по этим файлам уже снят — правку можно будет откатить.</div>
	</div>;
};

// ── Сессия ────────────────────────────────────────────────────────────────────

const SessionCard = ({ session }: { session: IVibeAcpSessionView }) => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const [draft, setDraft] = useState('');
	// Идентификатор свой на сессию: карточек может быть несколько, а один id на всех связал бы
	// подпись с чужим полем.
	const inputId = `vibe-acp-task-${session.sessionId}`;

	const send = useCallback(() => {
		const text = draft.trim();
		if (!text) { return; }
		setDraft('');
		void sessions.prompt(session.sessionId, text);
	}, [draft, sessions, session.sessionId]);

	return <div className='flex flex-col gap-3 rounded-lg border border-vibe-border-3 bg-vibe-bg-1 px-4 py-3'>
		<div className='flex items-center justify-between gap-3'>
			<div>
				<div className='text-root font-semibold text-vibe-fg-0'>{session.agentName}</div>
				<div className='text-root text-vibe-fg-2'>{formatSpend(session.log.spend)}</div>
			</div>
			<div className='flex items-center gap-2'>
				{session.busy && <PaneButton onClick={() => void sessions.cancel(session.sessionId)}>Прервать</PaneButton>}
				<PaneButton onClick={() => void sessions.endSession(session.sessionId)}>Закрыть сессию</PaneButton>
			</div>
		</div>

		{session.error && <div className='rounded-md border border-vibe-border-3 bg-vibe-bg-2 px-3 py-2 text-root text-vibe-warning'>
			{session.error}
		</div>}

		{session.log.entries.length > 0 && <div className='flex max-h-[50vh] flex-col gap-2 overflow-y-auto'>
			{session.log.entries.map(entry => <LogEntry key={entry.id} entry={entry} />)}
		</div>}

		<PermissionCard session={session} onAnswer={optionId => void sessions.answerPermission(session.sessionId, optionId)} />

		<div className='flex flex-col gap-2'>
			{/* Подпись видимая, а не плейсхолдер: плейсхолдер исчезает при вводе, и заполненная
			    форма превращается в набор безымянных прямоугольников. */}
			<label className='text-root font-medium text-vibe-fg-2' htmlFor={inputId}>Задача агенту</label>
			<div className='flex items-end gap-3'>
				<textarea
					id={inputId}
					className='min-h-[72px] flex-1 rounded-md border border-vibe-border-3 bg-vibe-bg-1 px-3 py-2 text-root text-vibe-fg-1 placeholder:text-vibe-fg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-vibe-border-1'
					placeholder={session.busy ? 'Агент работает — дождитесь конца хода или прервите его' : 'Что сделать в этой рабочей папке?'}
					value={draft}
					disabled={session.busy}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { send(); }
					}}
				/>
				<PaneButton disabled={session.busy || !draft.trim()} onClick={send}>Отправить</PaneButton>
			</div>
			<div className='text-root text-vibe-fg-2'>
				{!session.busy && session.lastStopReason ? STOP_NAMES[session.lastStopReason] : 'Отправить — ⌘/Ctrl + Enter'}
			</div>
		</div>
	</div>;
};

// ── Поверхность ───────────────────────────────────────────────────────────────

export const ExternalAgents = () => {
	const accessor = useAccessor();
	const registry = accessor.get('IVibeAcpRegistryService');
	const sessions = accessor.get('IVibeAcpSessionsService');
	const isDark = useIsDark();

	const [agents, setAgents] = useState<readonly VibeAgentEntry[]>(registry.agents);
	const [problems, setProblems] = useState<readonly string[]>(registry.problems);
	const [views, setViews] = useState<readonly IVibeAcpSessionView[]>(sessions.sessions);
	const [starting, setStarting] = useState<string | undefined>(undefined);
	const [startError, setStartError] = useState<string | undefined>(undefined);

	useEffect(() => {
		const listener = registry.onDidChange(() => {
			setAgents(registry.agents);
			setProblems(registry.problems);
		});
		return () => listener.dispose();
	}, [registry]);

	useEffect(() => {
		const listener = sessions.onDidChange(() => setViews(sessions.sessions));
		return () => listener.dispose();
	}, [sessions]);

	const start = useCallback(async (agent: VibeAgentEntry) => {
		setStarting(agent.id);
		setStartError(undefined);
		try {
			await sessions.startSession(agent);
		} catch (err) {
			setStartError(err instanceof Error ? err.message : String(err));
		} finally {
			setStarting(undefined);
		}
	}, [sessions]);

	/** Агент, у которого уже есть живая сессия, второй раз не предлагается. */
	const idle = useMemo(() => agents.filter(agent => !views.some(view => view.agentId === agent.id)), [agents, views]);

	// `@@vibe-scope` обязателен: scope-tailwind заворачивает каждое правило в `.vibe-scope`,
	// и корень без него отрисуется вовсе без стилей.
	//
	// На самом корне классов оформления быть НЕ ДОЛЖНО: правила генерируются как
	// `.vibe-scope .vibe-px-6`, то есть действуют только на потомков — отступ, повешенный сюда,
	// молча не применяется. Поэтому корень несёт лишь скоуп и размеры инлайном, а всё оформление
	// живёт на внутренней обёртке.
	return <div
		className={`@@vibe-scope ${isDark ? 'dark' : ''}`}
		// Фон задаётся здесь же и тем же токеном: обёртка ограничена по ширине, и покрась мы фон
		// только её, поверхность по краям осталась бы цвета редактора.
		style={{ height: '100%', width: '100%', overflowY: 'auto', background: 'var(--vibe-bg-1)' }}
	>
		<div className='mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8 text-vibe-fg-1'>

			<div>
				<h1 className='text-4xl font-semibold text-vibe-fg-0'>Внешние агенты</h1>
				<div className='mt-1 max-w-[60ch] text-root leading-relaxed text-vibe-fg-2'>
					Чужой агент работает в этой папке, но правит её через нас: спрашивает разрешение, а мы снимаем чекпоинт и пишем правки в журнал.
				</div>
			</div>

			{problems.length > 0 && <div className='rounded-md border border-vibe-border-3 bg-vibe-bg-2 px-3 py-2 text-root text-vibe-warning'>
				<div className='font-semibold'>Реестр прочитан частично:</div>
				{problems.map((problem, index) => <div key={index}>{problem}</div>)}
			</div>}

			{startError && <div className='rounded-md border border-vibe-border-3 bg-vibe-bg-2 px-3 py-2 text-root text-vibe-warning'>
				{startError}
			</div>}

			{agents.length === 0
				? <div className='rounded-lg border border-dashed border-vibe-border-3 px-4 py-10 text-center text-root text-vibe-fg-2'>
					Реестра <span className='font-mono text-root'>.vibe/agents.json</span> в этой папке нет — звать некого.
					Формат описан в <span className='font-mono text-root'>docs/manuals/agentsSpec.md</span>: его можно отдать модели и попросить собрать файл.
				</div>
				: <div className='flex flex-wrap items-center gap-2'>
					{idle.map(agent => <PaneButton key={agent.id} disabled={starting !== undefined} onClick={() => void start(agent)}>
						{starting === agent.id ? `${agent.name ?? agent.id}: запускаю…` : `Позвать ${agent.name ?? agent.id}`}
					</PaneButton>)}
					{idle.length === 0 && <div className='text-root text-vibe-fg-2'>Все агенты реестра уже работают.</div>}
				</div>}

			<div className='flex flex-col gap-3'>
				{views.map(view => <SessionCard key={view.sessionId} session={view} />)}
			</div>
		</div>
	</div>;
};
