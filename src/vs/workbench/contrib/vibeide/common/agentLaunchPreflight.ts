/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Launch preflight — what the agent will be allowed to do, answered before it runs.
 *
 * Today the only way to learn the answer is to start the agent and watch it hit a wall:
 * `checkWriteAllowed` throws at the moment of the write, `allowed-models.json` bites when the
 * request is already formed. For a user whose main worry is "it will break something", that is
 * the wrong moment to find out.
 *
 * This module evaluates the same facts the runtime uses — constraint rules, per-file permissions,
 * the role's tool whitelist, the model whitelist, budgets, approval mode — and reports them as a
 * readable plan. It performs no I/O, contacts no provider and writes nothing; the caller collects
 * the facts, this decides what they mean.
 */

import { VibeConstraintRule } from './vibeConstraintsService.js';
import { VibePermissions } from './vibePerFilePermissionsService.js';

/** Tools whose presence means the run can modify the workspace or the machine. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'rewrite_file', 'create_file_or_folder']);
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['run_command', 'run_terminal_command']);

export interface LaunchPlanFacts {
	/** Whose launch is being explained — the main agent or one subagent role. */
	readonly subject: 'agent' | 'role';
	/** Display name for the subject, e.g. «Ревьюер» or «Основной агент». */
	readonly subjectName: string;
	readonly allowedTools: readonly string[];
	readonly provider: string;
	readonly model: string;
	/** Result of the `allowed-models.json` whitelist check for `model`. */
	readonly modelAllowed: boolean;
	readonly workspaceName: string;
	readonly constraintRules: readonly VibeConstraintRule[];
	readonly permissions: VibePermissions;
	/** Autopilot executes tools without asking; otherwise every risky call is confirmed. */
	readonly autopilot: boolean;
	readonly tokenQuota: number;
	readonly maxSteps: number;
	readonly maxWallClockSec: number;
	readonly verifyGateMode: 'off' | 'warn' | 'enforce';
	readonly verifyCommand: string;
	readonly runLedgerEnabled: boolean;
}

export type PreflightSeverity = 'block' | 'warn' | 'note';

export interface PreflightFinding {
	readonly severity: PreflightSeverity;
	readonly title: string;
	readonly detail: string;
}

export interface PreflightReport {
	readonly findings: readonly PreflightFinding[];
	/** Glob patterns closed for writing, from both rule sources. */
	readonly writeBlocked: readonly string[];
	/** Glob patterns closed for reading. */
	readonly readBlocked: readonly string[];
	readonly canWrite: boolean;
	readonly canRunCommands: boolean;
	/** True when nothing blocks the launch — notes and warnings may still be present. */
	readonly launchable: boolean;
}

/** Decide what the collected facts mean. Pure. */
export function evaluateLaunchPlan(facts: LaunchPlanFacts): PreflightReport {
	const findings: PreflightFinding[] = [];

	const canWrite = facts.allowedTools.some(tool => WRITE_TOOLS.has(tool));
	const canRunCommands = facts.allowedTools.some(tool => COMMAND_TOOLS.has(tool));

	const writeBlocked = collectPatterns(facts, 'deny_write');
	const readBlocked = collectPatterns(facts, 'deny_read');

	if (!facts.modelAllowed) {
		findings.push({
			severity: 'block',
			title: 'Модель не в белом списке',
			detail: `«${facts.model}» отсутствует в .vibe/allowed-models.json — запуск будет отклонён до того, как уйдёт первый запрос.`,
		});
	}

	if (!canWrite && !canRunCommands) {
		findings.push({
			severity: 'note',
			title: 'Только чтение',
			detail: 'Ни один инструмент записи или запуска команд не разрешён — файлы проекта измениться не могут.',
		});
	}

	if (canRunCommands && facts.autopilot) {
		findings.push({
			severity: 'warn',
			title: 'Команды выполняются без запроса',
			detail: 'Включён автопилот, а среди инструментов есть запуск команд: подтверждения спрашиваться не будут. Выключите автопилот, если хотите одобрять каждый запуск.',
		});
	}

	if (canWrite && writeBlocked.length === 0) {
		findings.push({
			severity: 'note',
			title: 'Запрет на запись не настроен',
			detail: 'Ни .vibe/constraints.json, ни .vibe/permissions.json не закрывают ни одного пути — записывать можно в любой файл проекта.',
		});
	}

	if (canWrite && facts.verifyGateMode === 'off') {
		findings.push({
			severity: 'note',
			title: 'Результат не проверяется сборкой',
			detail: 'VERIFY-GATE выключен: агент закроет задачу, не прогоняя сборку или тесты. Ключ vibeide.agent.verifyGate.mode.',
		});
	} else if (facts.verifyGateMode !== 'off' && !facts.verifyCommand.trim()) {
		findings.push({
			severity: 'warn',
			title: 'VERIFY-GATE включён, но команда не задана',
			detail: 'Режим проверки выбран, а vibeide.agent.verifyGate.command пуст — гейт останется бездействующим.',
		});
	}

	if (!facts.runLedgerEnabled) {
		findings.push({
			severity: 'note',
			title: 'Журнал прогонов выключен',
			detail: 'Этот запуск не попадёт в «Диспетчерскую агентов» — истории о нём не останется.',
		});
	}

	return {
		findings,
		writeBlocked,
		readBlocked,
		canWrite,
		canRunCommands,
		launchable: !findings.some(finding => finding.severity === 'block'),
	};
}

/**
 * Patterns closed for `kind`, merged from constraint rules and per-file permissions, deduplicated
 * and sorted so the report reads the same on every run.
 */
function collectPatterns(facts: LaunchPlanFacts, kind: 'deny_write' | 'deny_read'): string[] {
	const patterns = new Set<string>();
	for (const rule of facts.constraintRules) {
		if (rule.type === kind && rule.pattern) {
			patterns.add(rule.pattern);
		}
	}
	const fromPermissions = kind === 'deny_write' ? facts.permissions.deny_write : facts.permissions.deny_read;
	for (const pattern of fromPermissions ?? []) {
		patterns.add(pattern);
	}
	return [...patterns].sort();
}

const SEVERITY_MARK: Record<PreflightSeverity, string> = {
	block: '⛔',
	warn: '⚠️',
	note: 'ℹ️',
};

/** Render the plan as the markdown report the command opens. Pure. */
export function renderPreflightMarkdown(facts: LaunchPlanFacts, report: PreflightReport): string {
	const subject = facts.subject === 'role' ? `роль «${facts.subjectName}»` : facts.subjectName;
	const lines: string[] = [
		`# Проверка запуска: ${subject}`,
		'',
		'Ничего не запущено: отчёт собран из тех же правил, по которым работает агент. Модель не вызывалась, файлы не менялись.',
		'',
		'## Итог',
		'',
	];

	if (!report.launchable) {
		lines.push('**Запуск невозможен** — ниже есть блокирующая причина.', '');
	} else if (report.findings.some(f => f.severity === 'warn')) {
		lines.push('**Запуск возможен, но есть на что посмотреть.**', '');
	} else {
		lines.push('**Запуск возможен.**', '');
	}

	if (report.findings.length > 0) {
		for (const finding of report.findings) {
			lines.push(`- ${SEVERITY_MARK[finding.severity]} **${finding.title}** — ${finding.detail}`);
		}
		lines.push('');
	}

	lines.push(
		'## Что разрешено',
		'',
		'| Что | Значение |',
		'|---|---|',
		`| Правка файлов | ${report.canWrite ? 'да' : 'нет'} |`,
		`| Запуск команд | ${report.canRunCommands ? 'да' : 'нет'} |`,
		`| Подтверждение действий | ${facts.autopilot ? 'не спрашивается (автопилот)' : 'спрашивается' } |`,
		`| Инструменты | ${facts.allowedTools.length > 0 ? facts.allowedTools.map(t => `\`${t}\``).join(', ') : 'нет'} |`,
		`| Модель | \`${facts.model}\` (${facts.provider})${facts.modelAllowed ? '' : ' — вне белого списка'} |`,
		`| Рабочая папка | ${facts.workspaceName} |`,
		'',
		'## Закрытые пути',
		'',
	);

	if (report.writeBlocked.length === 0 && report.readBlocked.length === 0) {
		lines.push('Ни один путь не закрыт — правила в `.vibe/constraints.json` и `.vibe/permissions.json` не заданы.', '');
	} else {
		lines.push('| Действие | Шаблоны |', '|---|---|');
		lines.push(`| Запись запрещена | ${formatPatterns(report.writeBlocked)} |`);
		lines.push(`| Чтение запрещено | ${formatPatterns(report.readBlocked)} |`);
		lines.push('');
	}

	lines.push(
		'## Лимиты прогона',
		'',
		'| Лимит | Значение |',
		'|---|---|',
		`| Токены | ${formatLimit(facts.tokenQuota)} |`,
		`| Шаги | ${formatLimit(facts.maxSteps)} |`,
		`| Время | ${facts.maxWallClockSec > 0 ? `${facts.maxWallClockSec} с` : 'без ограничения'} |`,
		`| Проверка результата | ${describeVerifyGate(facts)} |`,
		`| Журнал прогонов | ${facts.runLedgerEnabled ? 'ведётся' : 'выключен'} |`,
		'',
	);

	return lines.join('\n') + '\n';
}

function formatPatterns(patterns: readonly string[]): string {
	return patterns.length > 0 ? patterns.map(p => `\`${p}\``).join(', ') : '—';
}

function formatLimit(value: number): string {
	return value > 0 ? value.toLocaleString('ru-RU') : 'без ограничения';
}

function describeVerifyGate(facts: LaunchPlanFacts): string {
	if (facts.verifyGateMode === 'off') {
		return 'выключена';
	}
	const command = facts.verifyCommand.trim();
	if (!command) {
		return `режим «${facts.verifyGateMode}», но команда не задана`;
	}
	return `\`${command}\` (режим «${facts.verifyGateMode}»)`;
}
