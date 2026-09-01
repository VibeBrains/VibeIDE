/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Vibe Agents — surfaces the role-routing logic (VA.3/VA.4) to the user. Shows which roles
 * (and whether security-by-default) a task would dispatch to. Execution lands with the
 * Phase-3b subagent runner; this command exposes the deterministic plan today.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { approvalTypeOfBuiltinToolName } from '../common/prompt/tools/index.js';
import { IVibeSubagentOrchestratorService } from '../common/vibeSubagentOrchestratorService.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { subagentCostUsd, formatUsd } from '../common/subagentCostEstimate.js';
import { IChatThreadService } from './chatThreadService.js';
import type { ChatImageAttachment } from '../common/chatThreadServiceTypes.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

registerAction2(
	class VibeAgentsPlanRoute extends Action2 {
		constructor() {
			super({
				id: 'vibeide.vibeAgents.planRoute',
				title: localize2('vibeAgents.planRoute', 'Vibe Agents: Показать маршрут ролей для задачи'),
				category: VIBE_COMMAND_CATEGORY,
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const orchestrator = accessor.get(IVibeSubagentOrchestratorService);
			const notice = accessor.get(INotificationService);

			const task = await quickInput.input({
				title: localize('vibeAgents.planRoute.title', "Опишите задачу — покажу маршрут ролей"),
				placeHolder: localize('vibeAgents.planRoute.placeholder', "например: добавить страницу входа через OAuth"),
			});
			if (!task?.trim()) {
				return;
			}

			const route = orchestrator.planRoute(task.trim());
			const stages = route.stages
				.map(stage => (stage.length > 1 ? `[${stage.join(' ∥ ')}]` : stage[0]))
				.join(' → ');
			const security = route.securityAdded ? localize('vibeAgents.planRoute.security', " (+security авто)") : '';
			notice.info(localize('vibeAgents.planRoute.result', "Маршрут ({0}): {1}{2}", route.kind, stages, security));
		}
	},
);

registerAction2(
	class VibeAgentsExecuteRoute extends Action2 {
		constructor() {
			super({
				id: 'vibeide.vibeAgents.executeRoute',
				title: localize2('vibeAgents.executeRoute', 'Vibe Agents: Выполнить маршрут ролей для задачи'),
				category: VIBE_COMMAND_CATEGORY,
				f1: true,
			});
		}

		// Audit H: `executeRoute` existed since VA.3 but had NO user-facing entry — roles could
		// be planned, never launched. Progress is visible on the subagent status-bar counter;
		// a running role can be cancelled from its picker (audit F).
		async run(accessor: ServicesAccessor, arg?: string | { prompt?: string; overrides?: Record<string, number>; images?: readonly ChatImageAttachment[] }): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const orchestrator = accessor.get(IVibeSubagentOrchestratorService);
			const notice = accessor.get(INotificationService);
			const chatThreadService = accessor.get(IChatThreadService);
			const settings = accessor.get(IVibeideSettingsService);

			// Prompt + per-run limit overrides come from the in-chat «маршрут ролей» modal (object arg);
			// the command-palette entry passes a bare string or nothing (→ quick-input fallback).
			const argPrompt = typeof arg === 'string' ? arg : arg?.prompt;
			const images = (typeof arg === 'object' && arg?.images && arg.images.length) ? arg.images : undefined;
			const fv = (typeof arg === 'object' && arg?.overrides) ? arg.overrides : undefined;
			const limitOverrides = fv ? {
				...(fv.maxSteps ? { maxSteps: fv.maxSteps } : {}),
				...(fv.maxTokens ? { maxTokens: fv.maxTokens } : {}),
				...(fv.maxWallClockSec ? { maxWallClockMs: fv.maxWallClockSec * 1000 } : {}),
				...(typeof fv.maxResumes === 'number' ? { maxResumes: fv.maxResumes } : {}),
			} : undefined;

			const task = (typeof argPrompt === 'string' && argPrompt.trim())
				? argPrompt
				: await quickInput.input({
					title: localize('vibeAgents.executeRoute.title', "Опишите задачу — команда ролей выполнит её"),
					placeHolder: localize('vibeAgents.executeRoute.placeholder', "например: добавить страницу входа через OAuth"),
				});
			if (!task?.trim()) {
				return;
			}

			const route = orchestrator.planRoute(task.trim(), { hasImages: !!images });
			const stages = route.stages.map(stage => (stage.length > 1 ? `[${stage.join(' ∥ ')}]` : stage[0])).join(' → ');
			notice.info(localize('vibeAgents.executeRoute.started', "Команда ролей запущена: {0}. Прогресс — в статус-баре субагентов; отмена — клик по нему.", stages));

			// Capture the LAUNCH thread now: the report must land where the route was started,
			// not wherever the user happens to be when it finishes.
			const threadId = chatThreadService.state.currentThreadId;
			const startedAtMs = Date.now();
			try {
				const results = await orchestrator.executeRoute({
					parentThreadId: threadId,
					taskText: task.trim(),
					...(limitOverrides && Object.keys(limitOverrides).length ? { overrides: limitOverrides } : {}),
					...(images ? { images } : {}),
				});
				const ok = results.filter(r => r.status === 'success').length;
				const overrides = settings.state.overridesOfModel;
				const totalTokens = results.reduce((s, r) => s + r.tokensUsed, 0);
				const totalUsd = results.reduce((s, r) => s + (subagentCostUsd(r, overrides) ?? 0), 0);
				const openHandoffs = orchestrator.listOpenHandoffs().length;
				const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000);
				const md = [
					localize('vibeAgents.executeRoute.reportTitle', "# Vibe Agents — отчёт команды ролей"),
					'',
					localize('vibeAgents.executeRoute.reportTask', "Задача: {0}", task.trim()),
					localize('vibeAgents.executeRoute.reportRoute', "Маршрут: {0}", stages),
					'',
					...results.map(r => {
						const usd = subagentCostUsd(r, overrides);
						return [
							`## ${r.subagentId} — ${r.status}`,
							r.summary,
							r.artifacts?.length ? localize('vibeAgents.executeRoute.reportArtifacts', "Артефакты: {0}", r.artifacts.join(', ')) : undefined,
							r.reason ? localize('vibeAgents.executeRoute.reportReason', "Причина: {0}", r.reason) : undefined,
							localize('vibeAgents.executeRoute.reportTokens', "~{0} токенов (оценка){1}{2}", String(r.tokensUsed), usd !== undefined ? ` · ≈$${formatUsd(usd)}` : '', r.modelName ? ` · ${r.providerName}/${r.modelName}` : ''),
							'',
						].filter((l): l is string => l !== undefined);
					}).flat(),
					'---',
					localize('vibeAgents.executeRoute.reportTotals', "Итого: {0}/{1} успешно · ~{2} токенов{3} · {4} с", String(ok), String(results.length), String(totalTokens), totalUsd > 0 ? ` · ≈$${formatUsd(totalUsd)}` : '', String(elapsedSec)),
					...(openHandoffs > 0 ? [localize('vibeAgents.executeRoute.reportHandoffs', "⏸ Открытых продолжений (см. «субпин» в статус-баре): {0}", String(openHandoffs))] : []),
				].join('\n');
				// Post the report AS A CHAT MESSAGE (not an untitled editor): the work lives in the chat,
				// and a display-only assistant message is never «dirty», so it can't trigger the
				// save-on-close dialog / loop that untitled `contents` editors did.
				chatThreadService.addAssistantNotice(threadId, md);
				notice.notify({
					severity: ok === results.length ? Severity.Info : Severity.Warning,
					message: localize('vibeAgents.executeRoute.done', "Команда ролей завершена: {0}/{1} успешно. Отчёт добавлен в чат.", String(ok), String(results.length)),
				});
			} catch (e) {
				notice.error(localize('vibeAgents.executeRoute.failed', "Команда ролей прервана: {0}", e instanceof Error ? e.message : String(e)));
			}
		}
	},
);

registerAction2(
	class VibeAgentsListRoles extends Action2 {
		constructor() {
			super({
				id: 'vibeide.vibeAgents.listRoles',
				title: localize2('vibeAgents.listRoles', 'Vibe Agents: Показать роли и их права'),
				category: VIBE_COMMAND_CATEGORY,
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const registry = accessor.get(IVibeSubagentRegistryService);
			const quickInput = accessor.get(IQuickInputService);
			// Audit J: «full access» is derived from the approval map, not from a hardcoded tool
			// name — the previous `includes('write_file')` check silently broke when the role
			// whitelists were fixed to real builtin ids (write_file never existed).
			const items = registry.listPresets().map(p => ({
				label: p.displayName,
				description: p.allowedTools.some(t => Object.hasOwn(approvalTypeOfBuiltinToolName, t))
					? localize('vibeAgents.roles.full', "полный доступ (запись/терминал)")
					: localize('vibeAgents.roles.readonly', "только чтение"),
				detail: p.allowedTools.join(', '),
			}));
			await quickInput.pick(items, { title: localize('vibeAgents.roles.title', "Роли субагентов и их права"), canPickMany: false });
		}
	},
);
