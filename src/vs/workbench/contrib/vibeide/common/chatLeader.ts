/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Кто ведёт тред чата: модель функции «Чат» или внешний агент
 *
 * Выбор модели хранится на функцию («Чат»), а выбор агента — на тред
 * Всё, что показывает «текущую модель» (строка состояния, чип над полем ввода), обязано спросить сначала тред
 * Иначе при выбранном агенте оно называет модель, которая в этом треде ничего не делает
 *
 * Чистая: тред приходит структурой, без зависимости от сервиса чата
 */

import { ModelSelection } from './vibeideSettingsTypes.js';

/** То, что про агента треда нужно показу: кто он */
export interface IChatAgentBinding {
	readonly agentId: string;
	readonly agentName: string;
}

export type ChatLeader =
	| { readonly kind: 'agent'; readonly agentId: string; readonly agentName: string }
	| { readonly kind: 'model'; readonly selection: ModelSelection | null };

/** Ведущий треда: агент, если он выбран на этот тред, иначе модель функции «Чат» */
export function chatLeaderOf(
	thread: { readonly acpAgent?: IChatAgentBinding } | undefined,
	chatSelection: ModelSelection | null | undefined,
): ChatLeader {
	return thread?.acpAgent
		? { kind: 'agent', agentId: thread.acpAgent.agentId, agentName: thread.acpAgent.agentName }
		: { kind: 'model', selection: chatSelection ?? null };
}

/**
 * Ключ смены ведущего: показ обновляется, только когда он изменился
 * Модель в ключ не входит: её смену показ ловит по событию настроек
 */
export function chatLeaderKey(leader: ChatLeader): string {
	return leader.kind === 'agent' ? `agent:${leader.agentId}:${leader.agentName}` : 'model';
}
