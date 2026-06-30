/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeSubagentRegistryService — typed subagent preset registry.
 *
 * Maintains the canonical list of subagent types, each with:
 *  - A system-prompt appendix injected into the subagent's context
 *  - A tool whitelist (subset of the parent's tool surface)
 *  - Default step/token limits
 *
 * Types:
 *  - explore: read-only codebase search; no mutations
 *  - implement-step: file writes + terminal; scoped to a single plan step
 *  - recover-or-skip: diagnose a failed step; read + limited terminal; recommend retry/skip
 *
 * Additional types can be registered by extensions (Phase 3b).
 *
 * Roadmap-agent mode:
 *  When the user activates "Roadmap Agent" mode, the orchestrator reads the
 *  source-of-truth file (docs/roadmap.md or a .vibe/plans/*.plan.md), builds a queue of
 *  pending items, and decides per-item whether to execute inline or delegate to a typed subagent.
 *
 * Delegation heuristic:
 *  - Item marked as large / complex (user annotation or heuristic: >3 sub-bullets) → delegate
 *  - Context window fill >60% → delegate remaining items to avoid quality degradation
 *  - Item explicitly tagged @subagent in the plan file → always delegate
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { SubagentType } from './vibeSubagentService.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubagentPreset {
	type: SubagentType;
	/** Human-readable name for UI display */
	displayName: string;
	/** System appendix injected before the subagent's first message */
	systemAppendix: string;
	/** Tool whitelist (subset of all available tools) */
	allowedTools: readonly string[];
	/** Default step limit */
	defaultMaxSteps: number;
	/** Default wall-clock limit in ms */
	defaultMaxWallClockMs: number;
	/** Default token ceiling */
	defaultMaxTokens: number;
}

export interface RoadmapAgentQueueItem {
	/** Source item text from roadmap/plan */
	text: string;
	/** Line number in source file */
	lineNumber: number;
	/** Whether this item should be delegated to a subagent */
	shouldDelegate: boolean;
	/** Which subagent type to use (only relevant if shouldDelegate=true) */
	delegateType?: SubagentType;
	/** Reason for delegation decision */
	delegationReason?: string;
}

export const IVibeSubagentRegistryService = createDecorator<IVibeSubagentRegistryService>('vibeSubagentRegistryService');

export interface IVibeSubagentRegistryService {
	readonly _serviceBrand: undefined;

	/** Get a preset by type */
	getPreset(type: SubagentType): SubagentPreset;

	/** List all registered presets */
	listPresets(): SubagentPreset[];

	/**
	 * Analyse roadmap items and build a delegation queue.
	 * Items are analyzed in order; delegation heuristic applied to each.
	 */
	buildDelegationQueue(items: string[], contextFillPct: number): RoadmapAgentQueueItem[];

	/**
	 * Decide whether a single item should be delegated.
	 * Returns delegation info or undefined (handle inline).
	 */
	decideDelegation(itemText: string, contextFillPct: number): { shouldDelegate: boolean; type?: SubagentType; reason?: string };
}

// ── Built-in presets ───────────────────────────────────────────────────────────

const BUILT_IN_PRESETS: SubagentPreset[] = [
	{
		type: 'explore',
		displayName: 'Explore',
		systemAppendix: [
			'You are an explore subagent. Your ONLY job is to read the codebase and produce a structured report.',
			'You MUST NOT write or modify any files.',
			'Intermediate tool calls stay in your isolated context — the parent ONLY sees your final structured report.',
			'When done, output a JSON block with keys: paths (array), citations (array of {path,snippet}), confidence (0-1), truncated (bool).',
		].join('\n'),
		allowedTools: ['read_file', 'list_dir', 'grep', 'glob', 'semantic_search'],
		defaultMaxSteps: 20,
		defaultMaxWallClockMs: 60_000,
		defaultMaxTokens: 20_000,
	},
	{
		type: 'implement-step',
		displayName: 'Implement Step',
		systemAppendix: [
			'You are an implement-step subagent. Your job is to implement ONE clearly-defined plan step.',
			'You may read and write files and run terminal commands.',
			'Stay strictly within the scope defined in your handoff goal.',
			'Do NOT implement adjacent tasks — complete your assigned step, then report success or failure.',
			'When done, output a JSON block with keys: status (success|failed|skipped), artifacts (array of changed paths), reason (if not success).',
		].join('\n'),
		allowedTools: ['read_file', 'write_file', 'edit_file', 'run_terminal_command', 'list_dir', 'grep'],
		defaultMaxSteps: 30,
		defaultMaxWallClockMs: 120_000,
		defaultMaxTokens: 30_000,
	},
	{
		type: 'recover-or-skip',
		displayName: 'Recover or Skip',
		systemAppendix: [
			'You are a recover-or-skip subagent. A previous step has failed. Your job is to diagnose the failure.',
			'You may run read-only commands and limited terminal diagnostics.',
			'Do NOT make speculative file edits. Diagnose only.',
			'Output a JSON block with: recommendation (retry|skip|escalate), reason, blockers (array).',
		].join('\n'),
		allowedTools: ['read_file', 'run_terminal_command', 'grep'],
		defaultMaxSteps: 10,
		defaultMaxWallClockMs: 30_000,
		defaultMaxTokens: 10_000,
	},
];

// ── Vibe Agents — curated role pack (VA) ─────────────────────────────────────
// Permission model = the `allowedTools` whitelist: read-only roles (orchestrator,
// planner, code-reviewer, security) physically cannot write or run commands. Merged
// into the preset map at construction time (see class field) to avoid const TDZ.

/** Read-only tool whitelist — roles that must not modify the workspace. */
const ROLE_READONLY_TOOLS = ['read_file', 'list_dir', 'grep', 'glob', 'semantic_search'];
/** Full tool whitelist — roles that build (write/edit/run). */
const ROLE_FULL_TOOLS = ['read_file', 'write_file', 'edit_file', 'run_terminal_command', 'list_dir', 'grep', 'glob'];

const VIBE_AGENT_ROLE_PRESETS: SubagentPreset[] = [
	{
		type: 'orchestrator',
		displayName: 'Оркестратор',
		systemAppendix: 'Ты оркестратор. Классифицируй задачу и делегируй её подходящим ролям (planner/designer/frontend-dev/backend-dev/code-reviewer/qa/security). Сам код НЕ пишешь и команды НЕ запускаешь. Верни план делегирования.',
		allowedTools: ROLE_READONLY_TOOLS,
		defaultMaxSteps: 10,
		defaultMaxWallClockMs: 30_000,
		defaultMaxTokens: 12_000,
	},
	{
		type: 'planner',
		displayName: 'Планировщик',
		systemAppendix: 'Ты планировщик. Декомпозируй задачу на эпики/шаги, определи критический путь и риски. Только чтение, без правок. Верни структурированный план.',
		allowedTools: ROLE_READONLY_TOOLS,
		defaultMaxSteps: 15,
		defaultMaxWallClockMs: 60_000,
		defaultMaxTokens: 20_000,
	},
	{
		type: 'designer',
		displayName: 'Дизайнер',
		systemAppendix: 'Ты дизайнер UI. Отвечаешь за компоненты, дизайн-систему, стили. Меняй только UI-слой; бизнес-логику и бэкенд не трогай.',
		allowedTools: ROLE_FULL_TOOLS,
		defaultMaxSteps: 30,
		defaultMaxWallClockMs: 120_000,
		defaultMaxTokens: 30_000,
	},
	{
		type: 'frontend-dev',
		displayName: 'Фронтенд',
		systemAppendix: 'Ты фронтенд-разработчик. State, API-клиент, роутинг, TypeScript, UI-тесты. Оставайся в рамках фронтенда — серверную логику не меняй.',
		allowedTools: ROLE_FULL_TOOLS,
		defaultMaxSteps: 40,
		defaultMaxWallClockMs: 180_000,
		defaultMaxTokens: 40_000,
	},
	{
		type: 'backend-dev',
		displayName: 'Бэкенд',
		systemAppendix: 'Ты бэкенд-разработчик. API, сервисы, БД, серверная логика. UI-слой не трогай.',
		allowedTools: ROLE_FULL_TOOLS,
		defaultMaxSteps: 40,
		defaultMaxWallClockMs: 180_000,
		defaultMaxTokens: 40_000,
	},
	{
		type: 'code-reviewer',
		displayName: 'Ревьюер',
		systemAppendix: 'Ты ревьюер кода. Проверяй корректность, безопасность, производительность. Только чтение — код НЕ меняй. Верни список находок с severity и расположением.',
		allowedTools: ROLE_READONLY_TOOLS,
		defaultMaxSteps: 20,
		defaultMaxWallClockMs: 90_000,
		defaultMaxTokens: 25_000,
	},
	{
		type: 'qa',
		displayName: 'QA',
		systemAppendix: 'Ты QA-инженер. Прогоняй тесты, верифицируй поведение, формируй отчёт. Можешь запускать команды тестов. Не правь продакшен-код — заводи находки.',
		allowedTools: ROLE_FULL_TOOLS,
		defaultMaxSteps: 25,
		defaultMaxWallClockMs: 180_000,
		defaultMaxTokens: 25_000,
	},
	{
		type: 'security',
		displayName: 'Security',
		systemAppendix: 'Ты security-аудитор. Ищи уязвимости (OWASP Top 10), утечки секретов, небезопасные зависимости. Только чтение, без правок. Верни отчёт с severity и рекомендациями.',
		allowedTools: ROLE_READONLY_TOOLS,
		defaultMaxSteps: 20,
		defaultMaxWallClockMs: 90_000,
		defaultMaxTokens: 25_000,
	},
];

// ── Delegation heuristic constants ─────────────────────────────────────────────

const CONTEXT_FILL_DELEGATE_THRESHOLD = 0.6; // delegate when context > 60% full
const LARGE_ITEM_SUB_BULLET_THRESHOLD = 3;   // delegate if item has > N sub-bullets
const EXPLICIT_DELEGATE_TAG = '@subagent';   // explicit tag in plan item

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeSubagentRegistryService extends Disposable implements IVibeSubagentRegistryService {
	declare readonly _serviceBrand: undefined;

	private readonly _presets = new Map<SubagentType, SubagentPreset>(
		[...BUILT_IN_PRESETS, ...VIBE_AGENT_ROLE_PRESETS].map(p => [p.type, p])
	);

	constructor(
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._log.trace('[VibeSubagentRegistry] initialized');
	}

	getPreset(type: SubagentType): SubagentPreset {
		return this._presets.get(type) ?? BUILT_IN_PRESETS[0];
	}

	listPresets(): SubagentPreset[] {
		return Array.from(this._presets.values());
	}

	buildDelegationQueue(items: string[], contextFillPct: number): RoadmapAgentQueueItem[] {
		return items.map((text, idx) => {
			const decision = this.decideDelegation(text, contextFillPct);
			return {
				text,
				lineNumber: idx,
				shouldDelegate: decision.shouldDelegate,
				delegateType: decision.type,
				delegationReason: decision.reason,
			};
		});
	}

	decideDelegation(itemText: string, contextFillPct: number): { shouldDelegate: boolean; type?: SubagentType; reason?: string } {
		// Explicit delegate tag
		if (itemText.includes(EXPLICIT_DELEGATE_TAG)) {
			return { shouldDelegate: true, type: 'implement-step', reason: 'explicit @subagent tag' };
		}

		// Context window too full
		if (contextFillPct >= CONTEXT_FILL_DELEGATE_THRESHOLD) {
			return { shouldDelegate: true, type: 'implement-step', reason: `context fill ${Math.round(contextFillPct * 100)}% ≥ ${CONTEXT_FILL_DELEGATE_THRESHOLD * 100}%` };
		}

		// Count sub-bullets (indented lines following the item)
		const subBullets = (itemText.match(/\n\s+[-*]/g) ?? []).length;
		if (subBullets > LARGE_ITEM_SUB_BULLET_THRESHOLD) {
			return { shouldDelegate: true, type: 'implement-step', reason: `large item (${subBullets} sub-bullets)` };
		}

		return { shouldDelegate: false };
	}
}

registerSingleton(IVibeSubagentRegistryService, VibeSubagentRegistryService, InstantiationType.Delayed);
