/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, Info } from 'lucide-react';
import { AcpCompactionMessage, AcpNoticeMessage, AcpToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { IAcpCommand, IAcpConfigChoice, IAcpConfigOption, IAcpDiff, isCompactionSettled } from '../../../../common/acp/acpProtocol.js';
import { IAcpPermissionRequest } from '../../../../common/acp/acpTypes.js';
import { ACP_PERMISSION_MODES, AcpDecisionReason, AcpGrant, AcpPermissionMode, DEFAULT_ACP_PERMISSION_MODE, describeAsking, describeGrant, permissionOptionLabel } from '../../../../common/acp/acpPermissionPolicy.js';
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

// ── Уведомления и сжатие контекста ────────────────────────────────────────────

const NOTICE_SEVERITY_NAMES: Record<AcpNoticeMessage['severity'], string> = {
	info: 'Сведение',
	warning: 'Предупреждение',
	error: 'Ошибка',
	other: 'Сведение',
};

const noticeSeverityClass = (severity: AcpNoticeMessage['severity']): string => {
	switch (severity) {
		case 'warning': return 'text-vibe-warning';
		case 'error': return 'text-vibe-error';
		default: return 'text-vibe-fg-3';
	}
};

/**
 * Живое уведомление агента: отдельная строка в ленте, а не реплика — текст его же пера
 * Строка стоит между репликами и не растёт: кадр notice самодостаточен
 */
export const AcpNoticeLine = ({ message, isCheckpointGhost }: { message: AcpNoticeMessage; isCheckpointGhost: boolean }) => {
	return <div className={`flex items-start gap-1.5 px-1 py-0.5 text-xs ${isCheckpointGhost ? 'opacity-50' : ''}`} role='status'>
		{message.severity === 'error'
			? <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${noticeSeverityClass(message.severity)}`} />
			: <Info className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${noticeSeverityClass(message.severity)}`} />}
		<div className='min-w-0'>
			<span className={`font-semibold ${noticeSeverityClass(message.severity)}`}>{NOTICE_SEVERITY_NAMES[message.severity]}</span>
			<span className='text-vibe-fg-1'>: {message.title}</span>
			{message.description && <div className='mt-0.5 whitespace-pre-wrap break-words text-vibe-fg-2'>{message.description}</div>}
		</div>
	</div>;
};

const COMPACTION_CAPTIONS: Record<AcpCompactionMessage['status'], string> = {
	in_progress: 'Сжатие контекста…',
	completed: 'Контекст сжат',
	failed: 'Не удалось сжать контекст',
	cancelled: 'Сжатие контекста отменено',
	// Неизвестное значение схемы: не выдаём за завершённое
	unknown: 'Сжатие контекста',
};

/**
 * Сжатие контекста: строка «Контекст сжат» со сводкой по клику или с клавиатуры
 * Раскрытие — настоящая кнопка с aria-expanded: без мыши строка доступна по Tab и открывается Enter/Space
 */
export const AcpCompactionLine = ({ message, isCheckpointGhost }: { message: AcpCompactionMessage; isCheckpointGhost: boolean }) => {
	const [expanded, setExpanded] = useState(false);
	const hasDetails = message.summary.length > 0 || !!message.error;

	if (!hasDetails) {
		return <div className={`px-1 py-0.5 text-xs ${isCheckpointGhost ? 'opacity-50' : ''}`} role='status'>
			<span className='text-vibe-fg-3'>{COMPACTION_CAPTIONS[message.status]}</span>
		</div>;
	}

	return <div className={isCheckpointGhost ? 'opacity-50' : ''}>
		<button
			type='button'
			className='flex w-full items-center gap-1 px-1 py-0.5 text-left text-xs text-vibe-fg-3 transition-colors hover:text-vibe-fg-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-vibe-border-1'
			aria-expanded={expanded}
			onClick={() => setExpanded(value => !value)}
		>
			<ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-100 ${expanded ? 'rotate-90' : ''}`} />
			<span>{COMPACTION_CAPTIONS[message.status]}</span>
			<span className='text-vibe-fg-4'>{expanded ? 'Свернуть' : 'Сводка'}</span>
		</button>
		{expanded && <div className='ml-5 mt-0.5 flex flex-col gap-1.5'>
			{message.summary && <pre className='max-h-64 overflow-auto @@vibe-scroll whitespace-pre-wrap break-words rounded-md border border-vibe-border-4 bg-vibe-bg-1 px-2 py-1 font-mono text-xs text-vibe-fg-2'>{message.summary}</pre>}
			{message.error && <div className={`text-xs ${message.status === 'failed' ? 'text-vibe-error' : 'text-vibe-fg-2'}`}>{message.error}</div>}
		</div>}
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

/**
 * Сессия треда как её видят карточка вопроса и ручки в строке композера
 * Новый объект приходит только при смене вопроса, разрешений или настроек агента, а не на каждый кусок его текста
 */
const useAcpSessionView = (sessionId: string | undefined) => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const read = useCallback(() => sessions.sessions.find(view => view.sessionId === sessionId), [sessions, sessionId]);
	const [pending, setPending] = useState(() => read());
	useEffect(() => {
		const sync = () => setPending(previous => {
			const next = read();
			return samePending(previous?.pendingPermissions, next?.pendingPermissions)
				&& previous?.grants === next?.grants
				&& previous?.configOptions === next?.configOptions
				&& previous?.configuring === next?.configuring
				? previous : next;
		});
		sync();
		const listener = sessions.onDidChange(sync);
		return () => listener.dispose();
	}, [sessions, read]);
	return pending;
};

/**
 * Тот же набор вопросов: сервис отдаёт новый массив на каждое изменение, а карточкам нужен
 * новый объект только тогда, когда появился, закрылся или сменил причину сам вопрос
 */
const samePending = (
	previous: readonly { readonly request: { readonly requestId: string }; readonly reason?: string; readonly grantOffers: readonly unknown[] }[] | undefined,
	next: readonly { readonly request: { readonly requestId: string }; readonly reason?: string; readonly grantOffers: readonly unknown[] }[] | undefined,
): boolean => previous?.length === next?.length && (previous ?? []).every((item, index) =>
	item.request.requestId === next?.[index]?.request.requestId
	&& item.reason === next?.[index]?.reason
	&& item.grantOffers === next?.[index]?.grantOffers
);

/**
 * Вопрос внешнего агента в ленте чата: что за действие, какие файлы, что именно меняется
 * Решение человека одно из предложенных агентом; «на сессию» добавляет наше разрешение, а агенту уходит разовое «да»
 */
export const AcpPermissionCard = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const threadsState = useChatThreadsState();
	const agent = threadsState.allThreads[threadId]?.acpAgent;
	const view = useAcpSessionView(agent?.sessionId);
	const pending = view?.pendingPermissions ?? [];
	if (!view || pending.length === 0) { return null; }

	return <div className='flex flex-col gap-2'>
		{pending.length > 1 && <div className='flex items-center gap-2 px-1'>
			<AcpButton onClick={() => void sessions.allowAllPermissions(view.sessionId)} title='Разрешить все открытые запросы этого хода разовым «да»'>
				{`Разрешить все ${pending.length}`}
			</AcpButton>
		</div>}
		{pending.map(item => <AcpPermissionRequestCard
			key={item.request.toolCallId || item.request.requestId}
			sessionId={view.sessionId}
			agentName={view.agentName}
			request={item.request}
			reason={item.reason}
			grantOffers={item.grantOffers}
		/>)}
	</div>;
};

/**
 * Один вопрос: кнопки принадлежат вызову (`toolCallId`), поэтому ответ закрывает только его
 * Решение человека одно из предложенных агентом; «на сессию» добавляет наше разрешение, а агенту уходит разовое «да»
 */
const AcpPermissionRequestCard = ({ sessionId, agentName, request, reason, grantOffers }: {
	readonly sessionId: string;
	readonly agentName: string;
	readonly request: IAcpPermissionRequest;
	readonly reason?: AcpDecisionReason;
	readonly grantOffers: readonly AcpGrant[];
}) => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const [offersOpen, setOffersOpen] = useState(false);

	const answer = (optionId: string | undefined, grant?: AcpGrant) => {
		setOffersOpen(false);
		void sessions.answerPermission(sessionId, request.requestId, optionId, grant);
	};
	const allowOnce = request.options.find(option => option.kind === 'allow_once');
	const asking = reason ? describeAsking(reason) : undefined;
	const irreversible = reason === 'irreversible';

	return <div
		className={`rounded-lg border bg-vibe-bg-2 px-3 py-3 ${irreversible ? 'border-vibe-warning' : 'border-vibe-border-3'}`}
		role='group'
		aria-label='Вопрос внешнего агента'
		data-tool-call-id={request.toolCallId}
	>
		<div className='text-xs text-vibe-fg-3'>{`${agentName} просит разрешения`}</div>
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
			{allowOnce && grantOffers.length > 0 && <AcpButton
				quiet
				title='Разрешить сейчас и не спрашивать про то же до конца сессии'
				onClick={() => setOffersOpen(open => !open)}
			>
				{offersOpen ? 'На сессию ▴' : 'На сессию ▾'}
			</AcpButton>}
		</div>
		{offersOpen && allowOnce && <div className='mt-2 flex flex-col items-start gap-1'>
			{grantOffers.map(offer => <AcpButton key={JSON.stringify(offer)} quiet onClick={() => answer(allowOnce.optionId, offer)}>
				{describeGrant(offer)}
			</AcpButton>)}
		</div>}
		{request.toolKind === 'edit' && request.paths.length > 0 && request.options.some(option => option.kind.startsWith('allow')) && <div className='mt-2 text-xs text-vibe-fg-3'>
			Принятая правка встанет в список файлов с изменениями: там её можно принять или отклонить.
		</div>}
	</div>;
};

// ── Настройки сессии агента ───────────────────────────────────────────────────

/**
 * Что агент подписал сам (`Model`, `Thought level`), по-русски по его категории
 * Режим агента среди них нет: его ведёт наш режим разговора, а ручной выбор режима без вопросов обошёл бы наши проверки
 */
const CONFIG_CATEGORY_NAMES: Record<string, { readonly label: string; readonly hint: string }> = {
	model: { label: 'Модель', hint: 'Модель самого агента. Меняется сразу и действует со следующего хода' },
	thought_level: { label: 'Мышление', hint: 'Сколько агент думает перед ответом. Меняется сразу и действует со следующего хода' },
};

const MODE_CATEGORY = 'mode';

/** Ручки агента в строке композера: его модель и глубина мышления, как он их объявил; агент вправе объявить и другие */
const AcpConfigPills = ({ sessionId, options, locked, className }: { sessionId: string; options: readonly IAcpConfigOption[]; locked: boolean; className: string }) => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const shown = options.filter(option => option.category !== MODE_CATEGORY && option.id !== MODE_CATEGORY);
	return <>
		{shown.map(option => {
			const known = option.category ? CONFIG_CATEGORY_NAMES[option.category] : undefined;
			const hint = [known?.label ?? option.name, known?.hint ?? option.description].filter(Boolean).join('. ');
			if (option.type === 'boolean') {
				return <label key={option.id} className={`${className} flex items-center gap-1 cursor-pointer`} title={hint}>
					<input type='checkbox' className='h-3 w-3' checked={option.currentValue} disabled={locked} onChange={event => void sessions.setConfigOption(sessionId, option.id, event.target.checked)} />
					<span>{known?.label ?? option.name}</span>
				</label>;
			}
			const selected = option.choices.find(choice => choice.value === option.currentValue);
			if (!selected) { return null; }
			return <span key={option.id} className='inline-flex' title={hint}>
				<VibeCustomDropdownBox<IAcpConfigChoice>
					className={className}
					options={[...option.choices]}
					selectedOption={selected}
					onChangeOption={choice => { if (!locked && choice.value !== option.currentValue) { void sessions.setConfigOption(sessionId, option.id, choice.value); } }}
					getOptionDisplayName={choice => choice.name}
					getOptionDropdownName={choice => choice.name}
					getOptionDropdownDetail={choice => choice.description ?? ''}
					getOptionGroup={choice => choice.group}
					getOptionsEqual={(a, b) => a.value === b.value}
					detailPresentation='tooltip'
				/>
			</span>;
		})}
	</>;
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
	const view = useAcpSessionView(thread?.acpAgent?.sessionId);
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
		{view && <AcpConfigPills sessionId={view.sessionId} options={view.configOptions} locked={view.configuring || view.disconnected} className={className} />}
		{grants > 0 && view && <button
			className='text-[11px] text-vibe-fg-4 underline decoration-dotted hover:text-vibe-fg-2'
			title='Разрешения, которые вы дали на эту сессию («На сессию» в вопросе агента). Сброс вернёт вопросы'
			onClick={() => sessions.clearGrants(view.sessionId)}
		>
			{`Сбросить разрешения сессии (${grants})`}
		</button>}
	</>;
};

// ── Команды агента ────────────────────────────────────────────────────────────

/**
 * Слэш-команды агента: из живой сессии, а до неё — как агент объявил их в прошлый раз
 * Список меняется редко, поэтому новый объект приходит только при смене состава
 */
export const useAcpAgentCommands = (agentId: string | undefined): readonly IAcpCommand[] => {
	const accessor = useAccessor();
	const sessions = accessor.get('IVibeAcpSessionsService');
	const [commands, setCommands] = useState<readonly IAcpCommand[]>(() => agentId ? sessions.commandsOf(agentId) : []);
	useEffect(() => {
		const sync = () => setCommands(previous => {
			const next = agentId ? sessions.commandsOf(agentId) : [];
			return previous.length === next.length && previous.every((command, index) => command.name === next[index].name && command.description === next[index].description) ? previous : next;
		});
		sync();
		const listener = sessions.onDidChange(sync);
		return () => listener.dispose();
	}, [sessions, agentId]);
	return commands;
};
