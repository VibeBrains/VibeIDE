/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { AcpToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { IAcpDiff } from '../../../../common/acp/acpProtocol.js';
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
