/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Режим разрешений чата: один список «Режим» вместо отдельного флага «Автопилот»
 *
 * У встроенных моделей был один флаг, который одобрял всё сразу, и человек не мог выбрать
 * середину — «спрашивай про команды, но не про правки». Здесь чистое решение: какое действие
 * агент делает сам, а про какое спрашивает, без сервисов, файловой системы и платформы
 */

import { URI } from '../../../../base/common/uri.js';
import type { ChatMode } from './vibeideSettingsTypes.js';
import type { ToolApprovalType } from './toolsServiceTypes.js';
import { ICommandOutsidePath, commandPathsOutsideScope } from './commandPathsOutsideScope.js';
import { analyzeShellLine } from './nlShellSafetyAnalyzer.js';
import { isUnder } from './acp/acpPermissionPolicy.js';

/**
 * Режим разрешений при ChatMode 'agent': четыре ступени от «спрашивай про всё» до «не спрашивай о разрешениях»
 * Корень диска и разрушительные команды спрашиваются и в обходе — их решает не режим
 */
export type ChatPermissionMode = 'manual' | 'edits' | 'auto' | 'bypass';

/** Все режимы разрешений в порядке списка: от самого осторожного к самому автономному */
export const CHAT_PERMISSION_MODES: readonly ChatPermissionMode[] = ['manual', 'edits', 'auto', 'bypass'];

/** Режим по умолчанию: агент идёт сам, как прежний включённый по умолчанию автопилот */
export const DEFAULT_CHAT_PERMISSION_MODE: ChatPermissionMode = 'auto';

/** Сужает произвольное значение до режима разрешений: настройки приходят из JSON и могут быть чем угодно */
export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
	return typeof value === 'string' && (CHAT_PERMISSION_MODES as readonly string[]).includes(value);
}

/** auto и bypass — агент идёт сам: сброс лимитов, подпины, авто-вливание дерева субагента */
export function isAutonomousPermissionMode(mode: ChatPermissionMode): boolean {
	return mode === 'auto' || mode === 'bypass';
}

/** Для ChatMode 'agent' — сам режим; для 'normal' | 'gather' | 'plan' — 'manual' (там только чтение) */
export function effectivePermissionMode(chatMode: ChatMode, mode: ChatPermissionMode): ChatPermissionMode {
	return chatMode === 'agent' ? mode : 'manual';
}

/** Пункт списка «Режим» */
export type ChatModeChoice = 'normal' | 'gather' | 'plan' | 'manual' | 'edits' | 'auto' | 'bypass';

/** Пункты списка «Режим» в порядке показа: три чат-режима, затем четыре режима разрешений */
export const CHAT_MODE_CHOICES: readonly ChatModeChoice[] = ['normal', 'gather', 'plan', 'manual', 'edits', 'auto', 'bypass'];

/** Каким пунктом списка показать текущее состояние: agent → режим разрешений, иначе сам chatMode */
export function chatModeChoiceOf(chatMode: ChatMode, mode: ChatPermissionMode): ChatModeChoice {
	return chatMode === 'agent' ? mode : chatMode;
}

/** normal/gather/plan меняют только chatMode и оставляют прежний режим разрешений; остальные → chatMode 'agent' и свой режим */
export function settingsOfChatModeChoice(choice: ChatModeChoice, current: ChatPermissionMode): { readonly chatMode: ChatMode; readonly permissionMode: ChatPermissionMode } {
	switch (choice) {
		case 'normal':
		case 'gather':
		case 'plan':
			return { chatMode: choice, permissionMode: current };
		default:
			return { chatMode: 'agent', permissionMode: choice };
	}
}

/** Счётчик мягкой паузы при автономном режиме: паузы нет, ход идёт до конца сам */
export const AUTONOMOUS_SOFT_CHECKPOINT_ITERATIONS = 0;

/** Счётчик мягкой паузы при управляемом режиме: агент останавливается и спрашивает человека */
export const CONTROLLED_SOFT_CHECKPOINT_ITERATIONS = 25;

/** Счётчик мягкой паузы (vibeide.agent.softCheckpointIterations) при выборе режима: auto/bypass → 0 (без паузы), manual/edits → 25 */
export function softCheckpointIterationsFor(mode: ChatPermissionMode): number {
	return isAutonomousPermissionMode(mode) ? AUTONOMOUS_SOFT_CHECKPOINT_ITERATIONS : CONTROLLED_SOFT_CHECKPOINT_ITERATIONS;
}

/** Старые настройки, из которых мигрирует режим: поле автопилота по умолчанию было включено */
export interface ILegacyPermissionSettings {
	readonly chatPermissionMode?: unknown;
	readonly chatAgentAutopilot?: unknown;
	readonly autoApprove?: unknown; // объект { edits?: boolean, ... } или boolean у старых сборок
}

/** Миграция старых настроек. Поле chatAgentAutopilot по умолчанию было true, поэтому undefined — это «включён» */
export function migratedPermissionMode(legacy: ILegacyPermissionSettings): ChatPermissionMode {
	if (isChatPermissionMode(legacy.chatPermissionMode)) {
		return legacy.chatPermissionMode;
	}
	// Явно выключенный автопилот — человек хотел спрашивать; галочка «правки» уточняет, про что именно
	if (legacy.chatAgentAutopilot === false) {
		const edits = typeof legacy.autoApprove === 'object' && legacy.autoApprove !== null
			&& (legacy.autoApprove as { readonly edits?: unknown }).edits === true;
		return edits ? 'edits' : 'manual';
	}
	return 'auto';
}

/** Сохранённые настройки треда: новое поле permissionMode или старое autopilot */
export function permissionModeOfThreadConfig(config: { readonly permissionMode?: unknown; readonly autopilot?: unknown }): ChatPermissionMode | undefined {
	if (isChatPermissionMode(config.permissionMode)) {
		return config.permissionMode;
	}
	// Старый булев флаг треда: включён — агент шёл сам, выключен — спрашивал про всё
	if (config.autopilot === true) {
		return 'auto';
	}
	if (config.autopilot === false) {
		return 'manual';
	}
	return undefined;
}

/** Что решение знает о вызове инструмента */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'command' | 'mcp';

/** Факты вызова инструмента: только то, по чему можно решить, спрашивать человека или нет */
export interface IToolCallFacts {
	readonly kind: ToolCallKind;
	/** Абсолютные пути файловых аргументов (fsPath) */
	readonly paths: readonly string[];
	/** Строка shell-команды, когда она известна до запуска (run_command, run_persistent_command); у команды словами её нет */
	readonly command?: string;
	/** Оценка риска правки, если её посчитали */
	readonly editRisk?: 'LOW' | 'MEDIUM' | 'HIGH';
}

/** Как вызов встроенного инструмента описать фактами: по имени, типу одобрения и параметрам */
export function toolCallFactsOf(
	toolName: string,
	approvalType: ToolApprovalType | undefined,
	params: { readonly uri?: unknown; readonly searchInFolder?: unknown; readonly command?: unknown },
): IToolCallFacts {
	const kind = toolCallKindOf(toolName, approvalType);
	if (kind === 'mcp') {
		return { kind, paths: [] };
	}
	const paths: string[] = [];
	for (const candidate of [params.uri, params.searchInFolder]) {
		if (URI.isUri(candidate)) {
			paths.push(candidate.fsPath);
		}
	}
	// У команды словами (run_nl_command) строки нет: её ещё не написали, спрашивать не про что
	const command = kind === 'command' && typeof params.command === 'string' ? params.command : undefined;
	return command === undefined ? { kind, paths } : { kind, paths, command };
}

/** Тип вызова по типу одобрения: удаление отделено от правки, потому что отменить его дороже */
function toolCallKindOf(toolName: string, approvalType: ToolApprovalType | undefined): ToolCallKind {
	switch (approvalType) {
		case 'edits':
			return toolName === 'delete_file_or_folder' ? 'delete' : 'edit';
		case 'terminal':
			return 'command';
		case 'MCP tools':
			return 'mcp';
		default:
			return 'read';
	}
}

/** Всё, что решение знает о человеке и проекте: режим, корни, разрешения и настройка подтверждений */
export interface IToolApprovalContext {
	readonly mode: ChatPermissionMode; // уже effectivePermissionMode
	readonly roots: readonly string[]; // fsPath папок проекта
	readonly caseInsensitivePaths: boolean;
	/** Постоянные разрешения из настроек (галочки «терминал» и «MCP») — снимают вопрос своего типа во «Вручную» и «Принимать правки» */
	readonly grants: { readonly terminal: boolean; readonly mcp: boolean };
	/** vibeide.agent.confirmDestructiveCommands !== false */
	readonly confirmDestructiveCommands: boolean;
}

/** Почему решение принято именно так: имя причины нужно карточке и тестам */
export type ToolApprovalReason = 'criticalPath' | 'destructive' | 'commandOutsideProject' | 'bypass' | 'outsideProject' | 'readInsideProject' | 'modeAuto' | 'modeEdits' | 'highRiskEdit' | 'grant' | 'modeManual';

/** Решение по вызову: выполнять самому или спросить человека, и чем это объясняется */
export interface IToolApprovalDecision {
	readonly action: 'allow' | 'ask';
	readonly reason: ToolApprovalReason;
	/** Для команды: пути вне проекта (их покажет карточка через describeOutsidePaths) */
	readonly outsidePaths?: readonly ICommandOutsidePath[];
	/** Для команды: признаки разрушительности из analyzeShellLine */
	readonly destructiveReasons?: readonly string[];
}

/** Что делать с вызовом инструмента: порядок правил — от того, что не решается режимом, к самому режиму */
export function decideToolApproval(facts: IToolCallFacts, context: IToolApprovalContext): IToolApprovalDecision {
	let outsidePaths: readonly ICommandOutsidePath[] | undefined;
	let destructiveReasons: readonly string[] | undefined;
	const command = facts.kind === 'command' ? facts.command : undefined;
	if (command !== undefined) {
		// Команда — единственный вид вызова, где опасность не видна по типу: её читают из строки
		outsidePaths = commandPathsOutsideScope(command, { roots: context.roots, caseInsensitive: context.caseInsensitivePaths });
		destructiveReasons = analyzeShellLine(command)?.reasons;
		const decide = (action: 'allow' | 'ask', reason: ToolApprovalReason): IToolApprovalDecision => withCommandDetails(action, reason, outsidePaths, destructiveReasons);
		// Корень диска или домашней папки не выполняется без человека никогда, даже в обходе
		if (outsidePaths.some(item => item.critical)) {
			return decide('ask', 'criticalPath');
		}
		if (context.confirmDestructiveCommands && destructiveReasons !== undefined) {
			return decide('ask', 'destructive');
		}
		if (context.confirmDestructiveCommands && outsidePaths.length > 0) {
			return decide('ask', 'commandOutsideProject');
		}
	}
	return decideByMode(context, facts, outsidePaths, destructiveReasons);
}

/** Правила режима: для вызова со строкой команды и без неё они одинаковы, различается только довесок */
function decideByMode(context: IToolApprovalContext, facts: IToolCallFacts, outsidePaths: readonly ICommandOutsidePath[] | undefined, destructiveReasons: readonly string[] | undefined): IToolApprovalDecision {
	const decide = (action: 'allow' | 'ask', reason: ToolApprovalReason): IToolApprovalDecision => withCommandDetails(action, reason, outsidePaths, destructiveReasons);
	if (context.mode === 'bypass') {
		return decide('allow', 'bypass');
	}
	// Пустой список корней — проект не открыт: судить о «вне проекта» не по чему
	if (context.roots.length > 0 && isFileKind(facts.kind) && facts.paths.some(path => !isInsideProject(path, context))) {
		return decide('ask', 'outsideProject');
	}
	if (facts.kind === 'read') {
		return decide('allow', 'readInsideProject');
	}
	if (context.mode === 'auto') {
		return decide('allow', 'modeAuto');
	}
	if (context.mode === 'edits' && facts.kind === 'edit') {
		return decide(facts.editRisk === 'HIGH' ? 'ask' : 'allow', facts.editRisk === 'HIGH' ? 'highRiskEdit' : 'modeEdits');
	}
	if (facts.kind === 'command' && context.grants.terminal) {
		return decide('allow', 'grant');
	}
	if (facts.kind === 'mcp' && context.grants.mcp) {
		return decide('allow', 'grant');
	}
	return decide('ask', context.mode === 'edits' ? 'modeEdits' : 'modeManual');
}

/** Довесок к решению: пути вне проекта и признаки разрушительности карточка показывает человеку */
function withCommandDetails(action: 'allow' | 'ask', reason: ToolApprovalReason, outsidePaths: readonly ICommandOutsidePath[] | undefined, destructiveReasons: readonly string[] | undefined): IToolApprovalDecision {
	return {
		action,
		reason,
		...(outsidePaths !== undefined && outsidePaths.length > 0 ? { outsidePaths } : {}),
		...(destructiveReasons !== undefined && destructiveReasons.length > 0 ? { destructiveReasons } : {}),
	};
}

/** Файловые вызовы: для них имеет смысл вопрос «путь вне проекта» */
function isFileKind(kind: ToolCallKind): boolean {
	return kind === 'read' || kind === 'edit' || kind === 'delete';
}

/** Лежит ли путь в одной из папок проекта: на macOS и Windows регистр не различает имена */
function isInsideProject(path: string, context: IToolApprovalContext): boolean {
	const normalize = (value: string) => context.caseInsensitivePaths ? value.toLowerCase() : value;
	const candidate = normalize(path);
	return context.roots.some(root => isUnder(candidate, normalize(root)));
}
