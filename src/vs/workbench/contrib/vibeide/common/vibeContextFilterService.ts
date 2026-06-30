/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeContextFilterService — dynamic tool-result compaction for context window efficiency.
 *
 * Implements the "Dynamic context filtering / sandbox aggregation" roadmap item (§ F / § G).
 *
 * Policy contract: references/v1/context-filtering-policy.md
 *
 * Three modes:
 *  - raw       — no filtering (verbatim tool results)
 *  - aggregate — rule-based compaction (large files truncated, search hits capped)
 *  - auto      — aggregate when context fill ≥ 70%, raw below (DEFAULT)
 *  - off       — alias for raw; explicit no-filtering for audit/debug
 *
 * Transparency guarantee (§ F roadmap):
 *  - In aggregate mode, compact() returns BOTH the compact AND the full text via getLastFilterStats()
 *  - VibeDebugPromptService can record both versions for "debug my prompt" replay
 *  - Every truncation is marked with an explicit [... truncated] comment — never silent
 *
 * Phase MVP: service + compaction rules.
 * Phase 3b: hook into chatThreadService._runToolCall (injection point documented in policy).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.context.filterMode': {
			type: 'string',
			enum: ['auto', 'raw', 'aggregate', 'off'],
			enumDescriptions: [
				localize('filterMode.auto', 'Сжимать (aggregate), когда заполнение контекста ≥ 70%; ниже — raw (рекомендуется)'),
				localize('filterMode.raw', 'Всегда включать полные результаты инструментов (максимум прозрачности)'),
				localize('filterMode.aggregate', 'Всегда сжимать большие результаты инструментов (максимум эффективности)'),
				localize('filterMode.off', 'Без фильтрации (эквивалент raw; для сценариев аудита/отладки)'),
			],
			default: 'auto',
			description: localize('vibeide.context.filterMode', 'Как обрабатываются результаты инструментов перед добавлением в окно контекста LLM. Подробности — в references/v1/context-filtering-policy.md.'),
		},
		'vibeide.context.filterThresholdPct': {
			type: 'number',
			default: 70,
			minimum: 50,
			maximum: 95,
			description: localize('vibeide.context.filterThresholdPct', 'В режиме "auto": процент заполнения контекста, при котором включается aggregate-сжатие. По умолчанию: 70%.'),
		},
		'vibeide.context.filterMaxFileLines': {
			type: 'number',
			default: 200,
			minimum: 50,
			maximum: 2000,
			description: localize('vibeide.context.filterMaxFileLines', 'В режиме aggregate: максимум строк из результата чтения файла перед обрезкой.'),
		},
		'vibeide.context.filterMaxSearchHits': {
			type: 'number',
			default: 20,
			minimum: 5,
			maximum: 200,
			description: localize('vibeide.context.filterMaxSearchHits', 'В режиме aggregate: максимум результатов search/grep перед обрезкой.'),
		},
		'vibeide.context.filterMaxTerminalLines': {
			type: 'number',
			default: 100,
			minimum: 20,
			maximum: 1000,
			description: localize('vibeide.context.filterMaxTerminalLines', 'В режиме aggregate: максимум строк (tail) вывода терминала перед обрезкой.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type FilterMode = 'auto' | 'raw' | 'aggregate' | 'off';

export interface FilterStats {
	toolName: string;
	mode: FilterMode;
	originalChars: number;
	filteredChars: number;
	wasCompacted: boolean;
	/** The full original result (for VibeDebugPromptService to record) */
	fullResult: string;
	/** The compacted result that went into context */
	compactedResult: string;
}

export const IVibeContextFilterService = createDecorator<IVibeContextFilterService>('vibeContextFilterService');

export interface IVibeContextFilterService {
	readonly _serviceBrand: undefined;

	/**
	 * Filter a tool result before appending to LLM context.
	 *
	 * @param toolName  Name of the tool (read_file, grep, run_terminal_command, etc.)
	 * @param result    Raw tool output string
	 * @param contextFillPct  Current context fill (0-100); used in 'auto' mode
	 * @returns Filtered string to inject into context
	 */
	compact(toolName: string, result: string, contextFillPct: number): string;

	/**
	 * Effective mode for the given context fill percentage.
	 * Useful for status bar / debug transparency UI.
	 */
	effectiveMode(contextFillPct: number): FilterMode;

	/** Stats from the last compact() call (for VibeDebugPromptService integration). */
	getLastFilterStats(): FilterStats | null;

	/** Whether the service has compacted anything in the current session. */
	hasCompactedThisSession(): boolean;

	/** Reset session stats (call at session start). */
	resetSession(): void;

	/**
	 * Fires whenever `compact()` actually compacted something. Toast contribution
	 * subscribes here, reads the user's `filterMode` setting and decides via
	 * `decideContextFilterToast` whether to surface a notification (only when the
	 * user picked `auto` and aggregation kicked in for the first time this session).
	 */
	readonly onDidCompact: Event<{ ctxPct: number; toolName: string }>;
}

// ── Compaction rules ──────────────────────────────────────────────────────────

type ToolCompactor = (result: string, maxLines: number, maxHits: number, maxTerminalLines: number) => string;

const TOOL_COMPACTORS: Record<string, ToolCompactor> = {

	read_file: (result, maxLines) => {
		const lines = result.split('\n');
		if (lines.length <= maxLines) { return result; }
		const head = lines.slice(0, 10).join('\n');
		const tail = lines.slice(-Math.floor(maxLines / 4)).join('\n');
		const kept = lines.slice(0, Math.ceil(maxLines * 0.75)).join('\n');
		void head; void tail; // future: head+tail style
		return kept + `\n[... ${lines.length - Math.ceil(maxLines * 0.75)} more lines truncated. Full file available via read_file with explicit range.]`;
	},

	list_dir: (result, maxLines) => {
		const lines = result.split('\n').filter(l => l.trim());
		if (lines.length <= maxLines) { return result; }
		return lines.slice(0, maxLines).join('\n') + `\n[... ${lines.length - maxLines} more entries truncated]`;
	},

	grep: (result, _maxLines, maxHits) => {
		const lines = result.split('\n').filter(l => l.trim());
		if (lines.length <= maxHits) { return result; }
		return lines.slice(0, maxHits).join('\n') + `\n[... ${lines.length - maxHits} more matches truncated. Refine search pattern for full results.]`;
	},

	glob: (result, _maxLines, maxHits) => {
		const lines = result.split('\n').filter(l => l.trim());
		if (lines.length <= maxHits) { return result; }
		return lines.slice(0, maxHits).join('\n') + `\n[... ${lines.length - maxHits} more paths truncated]`;
	},

	run_terminal_command: (result, _maxLines, _maxHits, maxTerminalLines) => {
		const lines = result.split('\n');
		if (lines.length <= maxTerminalLines) { return result; }
		// Keep last N lines (most relevant for command output)
		const kept = lines.slice(-maxTerminalLines).join('\n');
		return `[... ${lines.length - maxTerminalLines} lines of terminal output truncated — showing last ${maxTerminalLines} lines]\n${kept}`;
	},

	semantic_search: (result, _maxLines, maxHits) => {
		const lines = result.split('\n').filter(l => l.trim());
		if (lines.length <= maxHits) { return result; }
		return lines.slice(0, maxHits).join('\n') + `\n[... ${lines.length - maxHits} more results truncated]`;
	},
};

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeContextFilterService extends Disposable implements IVibeContextFilterService {
	declare readonly _serviceBrand: undefined;

	private _lastStats: FilterStats | null = null;
	private _compactedThisSession = false;

	private readonly _onDidCompact = this._register(new Emitter<{ ctxPct: number; toolName: string }>());
	readonly onDidCompact: Event<{ ctxPct: number; toolName: string }> = this._onDidCompact.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
	}

	compact(toolName: string, result: string, contextFillPct: number): string {
		const mode = this.effectiveMode(contextFillPct);

		// raw / off → no filtering
		if (mode === 'raw' || mode === 'off') {
			this._lastStats = {
				toolName, mode,
				originalChars: result.length,
				filteredChars: result.length,
				wasCompacted: false,
				fullResult: result,
				compactedResult: result,
			};
			return result;
		}

		// aggregate mode
		const maxLines = this._config.getValue<number>('vibeide.context.filterMaxFileLines') ?? 200;
		const maxHits = this._config.getValue<number>('vibeide.context.filterMaxSearchHits') ?? 20;
		const maxTerminalLines = this._config.getValue<number>('vibeide.context.filterMaxTerminalLines') ?? 100;

		const compactor = TOOL_COMPACTORS[toolName];
		let compacted: string;

		if (compactor) {
			compacted = compactor(result, maxLines, maxHits, maxTerminalLines);
		} else {
			// Generic: cap at 8KB for unknown tools
			const cap = 8192;
			compacted = result.length > cap
				? result.slice(0, cap) + `\n[... ${result.length - cap} chars truncated (tool: ${toolName})]`
				: result;
		}

		const wasCompacted = compacted !== result;
		if (wasCompacted) {
			this._compactedThisSession = true;
			this._log.info(`[VibeContextFilter] Compacted ${toolName}: ${result.length} → ${compacted.length} chars (ctx ${contextFillPct.toFixed(0)}%)`);
			// Toast contribution decides whether to surface; we just announce the trigger.
			this._onDidCompact.fire({ ctxPct: contextFillPct / 100, toolName });
		}

		this._lastStats = {
			toolName, mode,
			originalChars: result.length,
			filteredChars: compacted.length,
			wasCompacted,
			fullResult: result,
			compactedResult: compacted,
		};

		return compacted;
	}

	effectiveMode(contextFillPct: number): FilterMode {
		const setting = this._config.getValue<FilterMode>('vibeide.context.filterMode') ?? 'auto';
		if (setting !== 'auto') { return setting; }
		const threshold = this._config.getValue<number>('vibeide.context.filterThresholdPct') ?? 70;
		return contextFillPct >= threshold ? 'aggregate' : 'raw';
	}

	getLastFilterStats(): FilterStats | null {
		return this._lastStats;
	}

	hasCompactedThisSession(): boolean {
		return this._compactedThisSession;
	}

	resetSession(): void {
		this._lastStats = null;
		this._compactedThisSession = false;
	}
}

registerSingleton(IVibeContextFilterService, VibeContextFilterService, InstantiationType.Delayed);
