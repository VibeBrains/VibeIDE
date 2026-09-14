/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolTrailView } from './toolCallTrail.js';

/**
 * Последовательность «прочитал секрет — сходил в сеть», замеченная по темпу.
 *
 * WHY a sequence and not another single-event check. The four circuit breakers we already have each
 * judge ONE event: a secret in changed files, a write to a closed path, repeated provider errors, a
 * role over budget. None of them can see that reading `.env` and then calling out to the network is
 * dangerous in a way neither half is — which is exactly the shape Google's threat-intelligence group
 * reports for autonomous agent attacks: a compromised resource, then plan-build-execute of mass
 * credential harvesting **in under six hours**, with markdown playbooks, self-remediation and IP
 * rotation, and no human between the stages
 * (cloud.google.com/blog/topics/threat-intelligence/from-prompting-to-autonomy-the-evolution-of-adversarial-ai).
 * Their advice is explicitly about velocity and automation rather than individual events.
 *
 * WHAT THIS IS NOT: a verdict. That report gives **no thresholds and no false-positive guidance** —
 * we checked, and inventing a number and citing them for it would be dishonest. The window below is
 * our own judgement and a setting, and a hit is reported, never used to stop the turn: an agent
 * legitimately reads a config and then fetches a doc. The value is that the pair becomes VISIBLE at
 * the moment it happens instead of being reconstructed afterwards from a journal, if at all.
 *
 * Pure: the caller supplies the trail it already keeps for project hooks.
 */

/**
 * Пути, чтение которых считается чтением секрета.
 *
 * The list starts from what the report describes being harvested — `.env`, and the agent-config
 * folders `.claude/`, `.vscode/`, `.cursor/` — and adds the classics that live next to them. Matched
 * on the path the trail already carries; the trail deliberately never carries arguments or command
 * lines, so a `run_command` that cats a secret is invisible here and honestly out of reach.
 */
const SECRET_PATH_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.env(\.|$)/i,
	/(^|\/)\.(claude|vscode|cursor|vibe)\//i,
	/(^|\/)\.ssh\//i,
	/(^|\/)\.aws\//i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)id_(rsa|ed25519|ecdsa)(\.|$)/i,
	/\.(pem|p12|pfx|key)$/i,
	/(^|\/)credentials(\.|$)/i,
	/(^|\/)secrets?(\.|\/|$)/i,
];

/** Инструменты, уводящие данные с машины. */
const NETWORK_TOOLS: ReadonlySet<string> = new Set(['browse_url', 'web_search']);

/**
 * Окно, внутри которого пара считается связанной, в секундах.
 *
 * Ours, not the report's. Chosen as the span in which a turn's own steps follow one another: wider,
 * and every session that once read a config gets flagged for the rest of the hour; narrower, and a
 * model that pauses to think between the two calls slips through.
 */
export const DEFAULT_EXFILTRATION_WINDOW_SECONDS = 120;

export interface ExfiltrationFinding {
	/** Путь, который прочитали. */
	readonly secretPath: string;
	/** Инструмент, которым сходили в сеть. */
	readonly networkTool: string;
	/** Куда именно, если известно: имя MCP-сервера. */
	readonly server?: string;
	/** Сколько секунд прошло между чтением и вызовом. */
	readonly gapSeconds: number;
}

/** Читает ли этот вызов что-то похожее на секрет. */
function readsSecret(call: ToolTrailView): boolean {
	if (!call.path) {
		return false;
	}
	const path = call.path.replace(/\\/g, '/');
	return SECRET_PATH_PATTERNS.some(pattern => pattern.test(path));
}

/**
 * Уводит ли этот вызов данные с машины.
 *
 * An MCP call counts whatever it is named: the tool runs on someone else's server, so its arguments
 * have already left the machine by the time it returns.
 */
function reachesNetwork(call: ToolTrailView): boolean {
	return NETWORK_TOOLS.has(call.tool) || call.server !== undefined;
}

/**
 * Пары «чтение секрета → сетевой вызов» в пределах окна.
 *
 * The trail arrives oldest-first with `secondsAgo` counted from now, so a later call has a SMALLER
 * `secondsAgo`. Ordering is taken from that field rather than from array position: the caller may
 * have trimmed the trail, and a rule that silently depends on array order breaks quietly when it does.
 */
export function findExfiltrationSequences(
	trail: readonly ToolTrailView[],
	windowSeconds: number = DEFAULT_EXFILTRATION_WINDOW_SECONDS,
): ExfiltrationFinding[] {
	// Обе стороны отбираются по одному разу, а не заново на каждой итерации: путь проверяется
	// девятью выражениями, и в двойном цикле та же строка проверялась бы столько раз, сколько в
	// следе сетевых вызовов. `secretPath` здесь же становится обычной строкой — без «!» на месте
	// использования, которое иначе пришлось бы обосновывать взглядом на соседнюю функцию.
	const secretReads: { readonly path: string; readonly secondsAgo: number }[] = [];
	for (const call of trail) {
		if (call.path !== undefined && readsSecret(call)) {
			secretReads.push({ path: call.path, secondsAgo: call.secondsAgo });
		}
	}
	if (secretReads.length === 0) {
		return [];
	}

	const findings: ExfiltrationFinding[] = [];
	for (const network of trail) {
		if (!reachesNetwork(network)) {
			continue;
		}
		for (const secret of secretReads) {
			const gapSeconds = secret.secondsAgo - network.secondsAgo;
			// Strictly positive: the read must come BEFORE the call. Equal timestamps are not a
			// sequence — with second resolution they are one moment, and calling that «сначала
			// прочитал, потом отправил» would be a claim the data does not support.
			if (gapSeconds > 0 && gapSeconds <= windowSeconds) {
				findings.push({
					secretPath: secret.path,
					networkTool: network.tool,
					...(network.server !== undefined ? { server: network.server } : {}),
					gapSeconds,
				});
			}
		}
	}
	return findings;
}

/** Одна строка для журнала и уведомления — уже по-русски. */
export function describeExfiltrationFinding(finding: ExfiltrationFinding): string {
	const target = finding.server ? `${finding.networkTool} (сервер ${finding.server})` : finding.networkTool;
	return `прочитан «${finding.secretPath}», через ${finding.gapSeconds} с — сетевой вызов ${target}`;
}
