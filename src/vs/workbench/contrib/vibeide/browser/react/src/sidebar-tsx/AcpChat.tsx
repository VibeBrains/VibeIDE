/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { AcpToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { IAcpDiff } from '../../../../common/acp/acpProtocol.js';
import { ACP_PERMISSION_MODES, AcpGrant, AcpPermissionMode, DEFAULT_ACP_PERMISSION_MODE, describeAsking, describeGrant, permissionOptionLabel } from '../../../../common/acp/acpPermissionPolicy.js';
import { useAccessor, useChatThreadsState } from '../util/services.js';
import { VibeCustomDropdownBox } from '../util/inputs.js';
import { ToolHeaderWrapper, ToolChildrenWrapper } from './SidebarChat.js';

// ── Словарь ───────────────────────────────────────────────────────────────────

const TOOL_KIND_NAMES: Record<string, string> = {
	'read': 'Чтение',
	'edit': 'Правка',
	'delete': 'Удаление',
	'move': 'Перемещение',
	'search': 'Поиск',
	'execute': 'Команда',
	'think': 'Размышление',
	'fetch': 'Запрос в сеть',
};

const TOOL_STATUS_NAMES: Record<string, string> = {
	pending: 'ждёт',
	in_progress: 'идёт',
	completed: 'готово',
	failed: 'ошибка',
	cancelled: 'отменено',
	unknown: 'идёт',
};

/** Дифф длиннее этого сворачивается: правка на 200 строк иначе вытеснит с экрана всё остальное. */
const DIFF_PREVIEW_LINES = 12;

// ── Дифф ──────────────────────────────────────────────────────────────────────

/** «Было → стало» так, как его показал агент: до применения правки он ещё ничего не изменил в файле */
export const AcpDiffBlock = ({ diff }: { diff: IAcpDiff }) => {
	const [expanded, setExpanded] = useState(false);
	const oldLines = diff.oldText ? diff.oldText.split('\n') : [];
	const newLines = diff.newText ? diff.newText.split('\n') : [];
	const long = oldLines.length + newLines.length > DIFF_PREVIEW_LINES;
	const cut = (lines: string[]) => (expanded || !long ? lines : lines.slice(0, DIFF_PREVIEW_LINES));

	return <div className='rounded-md border border-vibe-border-4 bg-vibe-bg-1'>
		<div className='border-b border-vibe-border-4 px-2 py-1 font-mono text-xs text-vibe-fg-2'>{diff.path}</div>
		<pre className='overflow-x-auto @@vibe-scroll px-2 py-1 font-mono text-xs leading-relaxed'>
			{cut(oldLines).map((line, index) => <div key={`o${index}`} className='text-vibe-warning'>{`− ${line}`}</div>)}
			{cut(newLines).map((line, index) => <div key={`n${index}`} className='text-vibe-success'>{`+ ${line}`}</div>)}
		</pre>
		{long && <button
			className='w-full border-t border-vibe-border-4 px-2 py-1 text-xs text-vibe-fg-2 transition-colors hover:text-vibe-fg-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-vibe-border-1'
			onClick={() => setExpanded(value => !value)}
		>
			{expanded ? 'Свернуть' : `Показать целиком (${oldLines.length + newLines.length} строк)`}
		</button>}
	</div>;
};

// ── Вызов инструмента ─────────────────────────────────────────────────────────

/**
 * Вызов инструмента внешнего агента в ленте чата
 * Агент делает его сам, поэтому карточка только рассказывает: что за инструмент, чем кончилось, что вывел
 */
export const AcpToolCard = ({ message, isCheckpointGhost }: { message: AcpToolMessage; isCheckpointGhost: boolean }) => {
	const kind = TOOL_KIND_NAMES[message.toolKind] ?? (message.toolKind || 'Инструмент');
	// Заголовок агент вправе не прислать, и в схеме v2 он необязателен: тогда имя инструмента, а затем путь
	const what = message.title || message.name || message.paths[0] || 'действие без названия';
	const hasDetails = message.diffs.length > 0 || message.output.length > 0;
	const exit = message.exitCode === undefined || message.exitCode === 0 ? '' : ` · код ${message.exitCode}`;

	return <div className={isCheckpointGhost ? 'opacity-50' : ''}>
		<ToolHeaderWrapper
			title={kind}
			desc1={what}
			desc2={`${TOOL_STATUS_NAMES[message.status] ?? ''}${exit}`}
			isError={message.status === 'failed' || (message.exitCode !== undefined && message.exitCode !== 0)}
			isRejected={message.status === 'cancelled'}
			icon={null}
		>
			{hasDetails ? <ToolChildrenWrapper className='bg-vibe-bg-3'>
				<div className='flex flex-col gap-2'>
					{message.paths.length > 0 && message.diffs.length === 0 && <div className='font-mono text-xs text-vibe-fg-3'>{message.paths.join('\n')}</div>}
					{message.diffs.map((diff, index) => <AcpDiffBlock key={`${diff.path}:${index}`} diff={diff} />)}
					{message.output && <pre className='max-h-64 overflow-auto @@vibe-scroll whitespace-pre-wrap break-words rounded-md border border-vibe-border-4 bg-vibe-bg-1 px-2 py-1 font-mono text-xs text-vibe-fg-2'>{message.output}</pre>}
				</div>
			</ToolChildrenWrapper> : undefined}
		</ToolHeaderWrapper>
	</div>;
};

// ── Вопрос разрешения ─────────────────────────────────────────────────────────

/**
 * Кнопка карточки
 *
 * Компонент, а не строковая константа с классами: scope-tailwind префиксует только литералы в JSX,
 * и классы, вынесенные в переменную, до стилей не доезжают — кнопка остаётся голой
 * Обводка фокуса задана явно: без неё с клавиатуры не видно, где находишься
 */
const AcpButton = ({ children, onClick, title, quiet }: { children: React.ReactNode; onClick: () => void; title?: string; quiet?: boolean }) => <button
	className={`rounded-md border px-3 py-1 text-xs text-vibe-fg-1 transition-colors hover:bg-vibe-bg-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-vibe-border-1 ${quiet ? 'border-transparent' : 'border-vibe-border-3'}`}
	title={title}
	onClick={onClick}
>
	{children}
</button>;

/** Вопрос сессии, ждущий человека, или ничего; новый объект приходит только при смене вопроса, а не на каждый кусок текста агента */
const usePendingPermission = (sessionId: string | undefined) => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const read = useCallback(() => sessions.sessions.find(view => view.sessionId === sessionId), [sessions, sessionId]);
	const [pending, setPending] = useState(() => read());
	useEffect(() => {
		const sync = () => setPending(previous => {
			const next = read();
			return previous?.pendingPermission?.requestId === next?.pendingPermission?.requestId && previous?.grants === next?.grants ? previous : next;
		});
		sync();
		const listener = sessions.onDidChange(sync);
		return () => listener.dispose();
	}, [sessions, read]);
	return pending;
};

/**
 * Вопрос внешнего агента в ленте чата: что за действие, какие файлы, что именно меняется
 * Решение человека одно из предложенных агентом; «на сессию» добавляет наше разрешение, а агенту уходит разовое «да»
 */
export const AcpPermissionCard = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const threadsState = useChatThreadsState();
	const agent = threadsState.allThreads[threadId]?.acpAgent;
	const view = usePendingPermission(agent?.sessionId);
	const [offersOpen, setOffersOpen] = useState(false);
	const request = view?.pendingPermission;
	if (!view || !request) { return null; }

	const answer = (optionId: string | undefined, grant?: AcpGrant) => {
		setOffersOpen(false);
		void sessions.answerPermission(view.sessionId, optionId, grant);
	};
	const allowOnce = request.options.find(option => option.kind === 'allow_once');
	const asking = view.pendingReason ? describeAsking(view.pendingReason) : undefined;
	const irreversible = view.pendingReason === 'irreversible';

	return <div className={`rounded-lg border bg-vibe-bg-2 px-3 py-3 ${irreversible ? 'border-vibe-warning' : 'border-vibe-border-3'}`} role='group' aria-label='Вопрос внешнего агента'>
		<div className='text-xs text-vibe-fg-3'>{`${view.agentName} просит разрешения`}</div>
		<div className='mt-1 text-sm font-semibold text-vibe-fg-0'>{request.title}</div>
		{/* Заголовок агент пишет как хочет; имя инструмента стабильно и показывает, что на самом деле вызывается */}
		{request.name && request.name !== request.title && <div className='mt-1 text-xs text-vibe-fg-3'>
			инструмент: <span className='font-mono'>{request.name}</span>
		</div>}
		{request.command ? <pre className='mt-2 max-h-40 overflow-auto @@vibe-scroll whitespace-pre-wrap break-words rounded-md border border-vibe-border-4 bg-vibe-bg-1 px-2 py-1 font-mono text-xs text-vibe-fg-1'>{request.command}</pre>
			: request.paths.length > 0 && request.diffs.length === 0 && <div className='mt-1 whitespace-pre-wrap font-mono text-xs text-vibe-fg-3'>{request.paths.join('\n')}</div>}
		{request.diffs.length > 0 && <div className='mt-2 flex flex-col gap-2'>
			{request.diffs.map((diff, index) => <AcpDiffBlock key={`${diff.path}:${index}`} diff={diff} />)}
		</div>}
		{asking && <div className={`mt-2 text-xs ${irreversible ? 'text-vibe-warning' : 'text-vibe-fg-3'}`}>{asking}</div>}
		<div className='mt-3 flex flex-wrap items-center gap-2'>
			{/* Варианты придумывает сам агент, поэтому слово берётся по виду варианта: угадывать «нет» по чужому имени нельзя */}
			{request.options.map(option => <AcpButton key={option.optionId} onClick={() => answer(option.optionId)}>
				{permissionOptionLabel(option, request.options)}
			</AcpButton>)}
			{allowOnce && view.pendingGrantOffers.length > 0 && <AcpButton
				quiet
				title='Разрешить сейчас и не спрашивать про то же до конца сессии'
				onClick={() => setOffersOpen(open => !open)}
			>
				{offersOpen ? 'На сессию ▴' : 'На сессию ▾'}
			</AcpButton>}
		</div>
		{offersOpen && allowOnce && <div className='mt-2 flex flex-col items-start gap-1'>
			{view.pendingGrantOffers.map(offer => <AcpButton key={JSON.stringify(offer)} quiet onClick={() => answer(allowOnce.optionId, offer)}>
				{describeGrant(offer)}
			</AcpButton>)}
		</div>}
		{request.paths.length > 0 && request.options.some(option => option.kind.startsWith('allow')) && <div className='mt-2 text-xs text-vibe-fg-3'>
			Чекпоинт по этим файлам уже снят — правку можно откатить.
		</div>}
	</div>;
};

// ── Режим ─────────────────────────────────────────────────────────────────────

const MODE_NAMES: Record<AcpPermissionMode, string> = {
	manual: 'Вручную',
	edits: 'Правки',
	plan: 'План',
	auto: 'Автопилот',
};

const MODE_DETAILS: Record<AcpPermissionMode, string> = {
	manual: 'Каждое действие агента спрашивается',
	edits: 'Правки в проекте без вопросов, остальное спрашивается',
	plan: 'Агент составляет план и ничего не меняет',
	auto: 'Всё без вопросов, кроме необратимых команд и выхода за проект',
};

/**
 * Режим разговора с внешним агентом вместо режимов чата, которых у чужого цикла нет
 * Выбор хранится на треде; сессия агента принимает его сразу, а разрешения на сессию можно сбросить тут же
 */
export const AcpModeControl = ({ className }: { className: string }) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const sessions = accessor.get('IVibeAcpSessionsService');
	const threadsState = useChatThreadsState();
	const thread = threadsState.allThreads[threadsState.currentThreadId];
	const view = usePendingPermission(thread?.acpAgent?.sessionId);
	if (!thread?.acpAgent) { return null; }
	const mode = thread.acpAgent.mode ?? DEFAULT_ACP_PERMISSION_MODE;
	const grants = view?.grants.length ?? 0;
	return <>
		<VibeCustomDropdownBox<AcpPermissionMode>
			className={className}
			options={[...ACP_PERMISSION_MODES]}
			selectedOption={mode}
			onChangeOption={next => chatThreadService.setThreadAcpMode(thread.id, next)}
			getOptionDisplayName={value => MODE_NAMES[value]}
			getOptionDropdownName={value => MODE_NAMES[value]}
			getOptionDropdownDetail={value => MODE_DETAILS[value]}
			getOptionsEqual={(a, b) => a === b}
			detailPresentation='tooltip'
		/>
		{grants > 0 && view && <button
			className='text-[11px] text-vibe-fg-4 underline decoration-dotted hover:text-vibe-fg-2'
			title='Разрешения, которые вы дали на эту сессию («На сессию» в вопросе агента). Сброс вернёт вопросы'
			onClick={() => sessions.clearGrants(view.sessionId)}
		>
			{`Сбросить разрешения сессии (${grants})`}
		</button>}
	</>;
};
