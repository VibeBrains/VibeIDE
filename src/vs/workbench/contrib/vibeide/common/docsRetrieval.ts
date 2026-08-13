/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Библиотекарь»: подбор заметок из базы знаний под задачу — кодом, без обращения к модели.
 *
 * Зачем не LLM. Ретривер на модели означает лишний запрос перед каждым ходом: платный, медленный
 * и сам способный ошибиться — классический N+1 к LLM ради того, чтобы решить, что показать LLM.
 * Здесь совпадение слов и один шаг по графу ссылок; ошибиться такой подбор может только в сторону
 * «принёс не самое нужное», и это дёшево.
 *
 * Чистый модуль: на вход — узлы и рёбра графа, на выход — упорядоченные идентификаторы с
 * причиной. Ни файловой системы, ни сервисов, поэтому проверяется из `test/common/`.
 */

import { IDocGraphEdge, IDocGraphNode } from './vibeDocsGraph.js';

/** Одна подобранная заметка с объяснением, почему она здесь. */
export interface IRetrievedDoc {
	readonly id: string;
	readonly label: string;
	/** Совпавшие слова и/или пометка о соседстве по графу — то, что можно показать человеку. */
	readonly why: string;
	readonly score: number;
}

/**
 * Слова короче этого игнорируются: «на», «из», «до» совпадают со всем подряд и только шумят.
 * Кириллица и латиница здесь равноправны — корпус двуязычный.
 */
const MIN_TERM_LENGTH = 4;

/** Сколько символов запроса вообще смотрим: дальше начинается пересказ, а не тема. */
const MAX_QUERY_CHARS = 2000;

/** Вес совпадения по заголовку — заголовок писал автор про суть, имя файла часто техническое. */
const HEADING_WEIGHT = 3;
const LABEL_WEIGHT = 4;
const DOMAIN_WEIGHT = 1;
/** Сосед по ссылке от найденного получает долю его веса: связь автор проставил руками. */
const NEIGHBOUR_FACTOR = 0.35;

/**
 * Слова запроса, годные для сопоставления.
 *
 * Нормализация намеренно грубая — регистр и границы по не-буквам. Стемминга нет: он требует
 * словаря на язык, а корпус двуязычный, и «почти совпавшее» слово ловится префиксом ниже.
 */
export function extractQueryTerms(query: string): string[] {
	const seen = new Set<string>();
	for (const raw of query.slice(0, MAX_QUERY_CHARS).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length >= MIN_TERM_LENGTH) {
			seen.add(raw);
		}
	}
	return [...seen];
}

/**
 * Совпадение по префиксу, а не по равенству: «квирк» должен находить «квирки» и «квирков»,
 * «detector» — «detectors». Порог в 4 символа не даёт префиксу стать совпадением со всем.
 */
function matches(term: string, text: string): boolean {
	const haystack = text.toLowerCase();
	if (haystack.includes(term)) {
		return true;
	}
	// Обратное направление: слово запроса длиннее слова заметки («детекторами» ↔ «детектор»).
	return term.length > MIN_TERM_LENGTH && haystack.includes(term.slice(0, MIN_TERM_LENGTH + 2));
}

/**
 * Ранжирует заметки под задачу.
 *
 * Порядок работы: прямое совпадение слов по метке, заголовкам и домену → затем один шаг по графу
 * ссылок от найденного. Шаг ровно один: ссылки в базе знаний транзитивны почти до всего корпуса,
 * и два шага возвращают «всё», то есть ничего.
 *
 * `limit` ограничивает выдачу, потому что это подкладывается в промпт: двадцать заметок вытеснят
 * из контекста задачу, ради которой их принесли.
 */
export function rankDocsForTask(
	query: string,
	nodes: readonly IDocGraphNode[],
	edges: readonly IDocGraphEdge[],
	limit: number,
): IRetrievedDoc[] {
	const terms = extractQueryTerms(query);
	if (terms.length === 0 || limit <= 0) {
		return [];
	}

	const direct = new Map<string, { score: number; hits: Set<string> }>();
	for (const node of nodes) {
		let score = 0;
		const hits = new Set<string>();
		for (const term of terms) {
			if (matches(term, node.label)) { score += LABEL_WEIGHT; hits.add(term); }
			if (node.domain && matches(term, node.domain)) { score += DOMAIN_WEIGHT; hits.add(term); }
			for (const heading of node.headings) {
				if (matches(term, heading)) { score += HEADING_WEIGHT; hits.add(term); break; }
			}
		}
		if (score > 0) {
			direct.set(node.id, { score, hits });
		}
	}
	if (direct.size === 0) {
		return [];
	}

	// Соседство считается ПОСЛЕ прямых совпадений и не влияет на них: иначе хаб с сотней ссылок
	// вылезал бы первым на любой запрос просто потому, что он хаб.
	const neighbour = new Map<string, number>();
	for (const edge of edges) {
		const fromDirect = direct.get(edge.from);
		const toDirect = direct.get(edge.to);
		if (fromDirect && !direct.has(edge.to)) {
			neighbour.set(edge.to, Math.max(neighbour.get(edge.to) ?? 0, fromDirect.score * NEIGHBOUR_FACTOR));
		}
		if (toDirect && !direct.has(edge.from)) {
			neighbour.set(edge.from, Math.max(neighbour.get(edge.from) ?? 0, toDirect.score * NEIGHBOUR_FACTOR));
		}
	}

	const labelOf = new Map(nodes.map(n => [n.id, n.label]));
	const out: IRetrievedDoc[] = [];
	for (const [id, hit] of direct) {
		out.push({ id, label: labelOf.get(id) ?? id, score: hit.score, why: `совпало: ${[...hit.hits].join(', ')}` });
	}
	for (const [id, score] of neighbour) {
		out.push({ id, label: labelOf.get(id) ?? id, score, why: 'связана ссылкой с найденным' });
	}

	// Сортировка детерминирована до последнего разряда: одинаковый вес → по id, иначе два прогона
	// на одном корпусе дали бы разный промпт, и «почему агент ответил иначе» стало бы неотвечаемым.
	out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	return out.slice(0, limit);
}
