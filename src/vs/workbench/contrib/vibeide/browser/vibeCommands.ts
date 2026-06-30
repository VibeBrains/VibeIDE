/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVibeTokenBudgetService } from '../common/vibeTokenBudgetService.js';
import { IVibeAgentHistoryService } from '../common/vibeAgentHistoryService.js';
import { IVibeMemoryDecayService } from '../common/vibeMemoryDecayService.js';
import { IVibeSemanticSearchService } from '../common/vibeSemanticSearchService.js';
import { IVibePlanSimilarSearchService } from '../common/vibePlanSimilarSearchService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localize, localize2 } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVibeSkillsLibraryService } from '../common/vibeSkillsLibraryService.js';
import { IFileDialogService, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ITextResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { IChatThreadService } from './chatThreadService.js';
import { IVibePlanBindingRegistry } from './vibePlanBindingRegistry.js';
import { IVibePersistedPlanService } from '../common/vibePersistedPlanService.js';
import { decodeLease, selectAllForEmergencyStop, PlanExecutionLease } from '../common/planLeaseLifecycle.js';
import { VIBEIDE_VIEW_CONTAINER_ID } from './sidebarPane.js';
import type { ChatMessage, PlanMessage } from '../common/chatThreadServiceTypes.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IAuditLogService } from '../common/auditLogService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ProviderName } from '../common/vibeideSettingsTypes.js';
import { isWindows, isMacintosh, isLinux } from '../../../../base/common/platform.js';

const VIBEIDE_OPEN_SIDEBAR_CMD = 'vibeide.sidebar.open';

const COMMUNITY_MANIFEST_FORMAT = 'vibe-community-skill-manifest-v1';
const COMMUNITY_CATALOG_FORMAT = 'vibe-community-skills-catalog-v1';

function assertJsonRecord(json: unknown): asserts json is Record<string, unknown> {
	if (!json || typeof json !== 'object' || Array.isArray(json)) {
		throw new Error(localize('vibeideSkillsCommunityExpectObject', 'Некорректный JSON: ожидается объект.'));
	}
}

type ParsedCommunityManifest = { skillId: string; skillMarkdown: string };

/**
 * Run a maintenance script in a dedicated integrated terminal (Panel). Replaces the old
 * `require('child_process').execSync(...)` calls that throw in the renderer process. Output is
 * visible to the user; cwd is the workspace folder (these scripts assume the VibeIDE repo).
 */
async function runInVibeTerminal(terminal: ITerminalService, name: string, cmd: string): Promise<void> {
	const t = await terminal.createTerminal({ location: TerminalLocation.Panel, config: { name } });
	await terminal.setActiveInstance(t);
	await terminal.focusActiveInstance();
	await t.sendText(cmd, true);
}

function parseCommunitySkillManifest(json: unknown): ParsedCommunityManifest {
	assertJsonRecord(json);
	if (json.format !== COMMUNITY_MANIFEST_FORMAT) {
		throw new Error(localize('vibeideSkillsCommunityBadManifestFmt', 'JSON манифеста должен содержать поле format "{0}".', COMMUNITY_MANIFEST_FORMAT));
	}
	const skillId = json.skillId;
	const skillMarkdown = json.skillMarkdown;
	if (typeof skillId !== 'string' || !skillId.trim()) {
		throw new Error(localize('vibeideSkillsCommunityBadSkillId', 'manifest.skillId обязателен.'));
	}
	if (typeof skillMarkdown !== 'string' || !skillMarkdown.trim()) {
		throw new Error(localize('vibeideSkillsCommunityBadBody', 'manifest.skillMarkdown обязателен.'));
	}
	return { skillId: skillId.trim(), skillMarkdown: skillMarkdown.replace(/\r\n/g, '\n') };
}

interface CommunityCatalogEntry {
	id: string;
	name?: string;
	manifestUrl: string;
	sha256?: string;
}

function parseCommunitySkillsCatalog(json: unknown): CommunityCatalogEntry[] {
	assertJsonRecord(json);
	if (json.format !== COMMUNITY_CATALOG_FORMAT) {
		throw new Error(localize('vibeideSkillsCommunityBadCatalogFmt', 'JSON каталога должен содержать поле format "{0}".', COMMUNITY_CATALOG_FORMAT));
	}
	const entries = json.entries;
	if (!Array.isArray(entries)) {
		throw new Error(localize('vibeideSkillsCommunityBadEntries', 'catalog.entries должен быть массивом.'));
	}
	return entries.map((e: unknown, i: number) => {
		assertJsonRecord(e);
		const id = e.id;
		const manifestUrl = e.manifestUrl;
		if (typeof id !== 'string' || !id.trim()) {
			throw new Error(localize('vibeideSkillsCommunityBadEntryId', 'entries[{0}].id обязателен.', String(i)));
		}
		if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) {
			throw new Error(localize('vibeideSkillsCommunityBadEntryUrl', 'entries[{0}].manifestUrl обязателен.', String(i)));
		}
		const sha256 = typeof e.sha256 === 'string' && e.sha256.trim() ? e.sha256.trim().toLowerCase() : undefined;
		const name = typeof e.name === 'string' ? e.name : undefined;
		return { id: id.trim(), name, manifestUrl: manifestUrl.trim(), sha256 };
	});
}

async function vibeCommunitySha256Hex(text: string): Promise<string> {
	const hash = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
	).map(b => b.toString(16).padStart(2, '0')).join('');
	return hash;
}

async function vibeCommunityFetchText(urlStr: string): Promise<string> {
	const res = await fetch(urlStr);
	if (!res.ok) {
		throw new Error(localize('vibeideSkillsCommunityHttpErr', 'HTTP {0} при загрузке URL.', String(res.status)));
	}
	return (await res.text()).replace(/\r\n/g, '\n');
}

function sanitizeCommunitySkillFolderId(skillId: string): string {
	const s = skillId.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return s.length ? s : 'imported-skill';
}

function findLastAssistantDisplayContent(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'assistant') {
			const c = m.displayContent?.trim();
			if (c) {
				return m.displayContent;
			}
		}
	}
	return '';
}

/** Resolved up-front: ServicesAccessor is invalid after the first `await` in command handlers (invokeFunction). */
type InstallCommunitySkillServices = {
	workspace: IWorkspaceContextService;
	files: IFileService;
	cmds: ICommandService;
	notifications: INotificationService;
	log: ILogService;
};

async function installCommunitySkillMarkdown(
	services: InstallCommunitySkillServices,
	skillIdRaw: string,
	skillMarkdown: string,
	logSuffix: string,
): Promise<void> {
	const { workspace, files, cmds, notifications, log } = services;
	const roots = workspace.getWorkspace().folders;
	if (!roots.length) {
		notifications.notify({
			severity: Severity.Warning,
			message: localize('vibeideSkillsCommunityNoWs', 'Сначала откройте папку рабочей области.'),
		});
		return;
	}
	const skillId = sanitizeCommunitySkillFolderId(skillIdRaw);
	const skillsRoot = joinPath(roots[0].uri, '.vibe', 'skills');
	const skillDir = joinPath(skillsRoot, skillId);
	await files.createFolder(skillDir);
	const uri = joinPath(skillDir, 'SKILL.md');
	await files.writeFile(uri, VSBuffer.fromString(skillMarkdown.trimEnd() + '\n'));
	await cmds.executeCommand('vscode.open', uri);
	log.info(`[VibeIDE] Community skill installed: ${uri.fsPath} (${logSuffix})`);
	notifications.notify({
		severity: Severity.Info,
		message: localize('vibeideSkillsCommunityInstalled', 'Скилл агента установлен в .vibe/skills/{0}/', skillId),
	});
}

/**
 * VibeIDE Commands — registered in Command Palette.
 * All VibeIDE actions available via Ctrl+Shift+P without full UI.
 */

// Trust Score commands
CommandsRegistry.registerCommand('vibeide.trustScore.toggle', async (accessor: ServicesAccessor) => {
	const config = accessor.get(IConfigurationService);
	const log = accessor.get(ILogService);
	const current = config.getValue<string>('vibeide.trustScore.level') || 'manual';
	const next = current === 'manual' ? 'supervised' : current === 'supervised' ? 'auto' : 'manual';
	await config.updateValue('vibeide.trustScore.level', next, ConfigurationTarget.USER);
	log.info(`[VibeIDE] Trust Score: ${current} → ${next}`);
});

// Direct Trust Score level setters (bound to Ctrl+Shift+1/2/3). Were empty stubs — now they
// actually write `vibeide.trustScore.level` and confirm with a toast (mirrors trustScore.toggle).
for (const { id, level, label } of [
	{ id: 'vibeide.trustScore.setManual', level: 'manual', label: localize('vibeide.trustScore.manual', 'Ручной (Manual) 🟢') },
	{ id: 'vibeide.trustScore.setSupervised', level: 'supervised', label: localize('vibeide.trustScore.supervised', 'Под наблюдением (Supervised) 🟡') },
	{ id: 'vibeide.trustScore.setAuto', level: 'auto', label: localize('vibeide.trustScore.auto', 'Авто (Auto) 🔴') },
] as const) {
	CommandsRegistry.registerCommand(id, async (accessor: ServicesAccessor) => {
		const config = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);
		await config.updateValue('vibeide.trustScore.level', level, ConfigurationTarget.USER);
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.trustScore.setDone', 'Trust Score: режим — {0}.', label) });
	});
}

// Token budget
CommandsRegistry.registerCommand('vibeide.tokenBudget.reset', (accessor: ServicesAccessor) => {
	const budget = accessor.get(IVibeTokenBudgetService);
	const notifications = accessor.get(INotificationService);
	budget.resetSession();
	notifications.notify({ severity: Severity.Info, message: localize('vibeide.tokenBudget.resetDone', 'Бюджет токенов сессии сброшен.') });
});

// Wired to the provider status bar (click). Was log-only → invisible. Now shows a toast.
CommandsRegistry.registerCommand('vibeide.tokenBudget.status', (accessor: ServicesAccessor) => {
	const budget = accessor.get(IVibeTokenBudgetService);
	const notifications = accessor.get(INotificationService);
	const status = budget.getStatus();
	notifications.notify({
		severity: Severity.Info,
		message: localize('vibeide.tokenBudget.statusMsg', 'Бюджет токенов: {0}/{1} ({2}%) за сессию.',
			status.sessionTokensUsed.toLocaleString(), status.sessionTokensLimit.toLocaleString(), status.percentUsed.toFixed(0)),
	});
});

CommandsRegistry.registerCommand('vibeide.emergencyStopAllAgents', async (accessor: ServicesAccessor) => {
	const chat = accessor.get(IChatThreadService);
	const notifications = accessor.get(INotificationService);
	const fileService = accessor.get(IFileService);
	const workspace = accessor.get(IWorkspaceContextService);
	const persistedPlans = accessor.get(IVibePersistedPlanService);
	const log = accessor.get(ILogService);

	const n = await chat.emergencyStopAllAgents();

	// Clear all on-disk execution leases across every workspace folder.
	let clearedLeases = 0;
	for (const folder of workspace.getWorkspace().folders) {
		try {
			const leasesDir = joinPath(folder.uri, '.vibe', 'plans', '.leases');
			let dir;
			try {
				dir = await fileService.resolve(leasesDir);
			} catch {
				continue;
			}
			if (!dir.children || dir.children.length === 0) {
				continue;
			}
			const leases: PlanExecutionLease[] = [];
			for (const child of dir.children) {
				if (child.isDirectory || !child.name.endsWith('.json')) {
					continue;
				}
				try {
					const buf = await fileService.readFile(child.resource);
					const decoded = decodeLease(JSON.parse(buf.value.toString()));
					if (decoded.ok) {
						leases.push(decoded.value);
					}
				} catch { /* skip unreadable */ }
			}
			const toStop = selectAllForEmergencyStop(leases);
			for (const lease of toStop) {
				try {
					await persistedPlans.clearExecutionLease(folder.uri, lease.planId);
					clearedLeases++;
				} catch (e) {
					log.warn(`[EmergencyStop] failed to clear lease ${lease.planId}: ${(e as Error).message}`);
				}
			}
		} catch (e) {
			log.warn(`[EmergencyStop] lease scan failed for ${folder.uri.toString()}: ${(e as Error).message}`);
		}
	}

	notifications.notify({
		severity: Severity.Info,
		message: localize(
			'vibeideEmergencyStopDone',
			'Аварийная остановка: прервано тредов агента: {0}; снято дисковых лиз выполнения: {1}.',
			n,
			clearedLeases,
		),
	});
});

// Removed: `vibeide.dms.stop` and `vibeide.loopDetector.reset` — Phase-2 stubs that only logged,
// never implemented, and referenced nowhere (no keybinding / status bar / menu). Dead code.

// Context guard
// `vibeide.context.status` moved to vibeContextReportContribution.ts — it now opens a full
// context-composition report (gauge + per-segment table) instead of logging one line.

// Agent history
CommandsRegistry.registerCommand('vibeide.agentHistory.show', (accessor: ServicesAccessor) => {
	const history = accessor.get(IVibeAgentHistoryService);
	const notifications = accessor.get(INotificationService);
	const entries = history.getCurrentSessionHistory();
	if (entries.length === 0) {
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.agentHistory.empty', 'История действий агента в этой сессии пуста.') });
		return;
	}
	const tail = entries.slice(-5).map(e => `• ${e.action}: ${e.description.slice(0, 80)}`).join('\n');
	notifications.notify({
		severity: Severity.Info,
		message: localize('vibeide.agentHistory.msg', 'Действий агента за сессию: {0}. Последние:\n{1}', entries.length, tail),
	});
});

// Memory decay
CommandsRegistry.registerCommand('vibeide.memory.persist', (accessor: ServicesAccessor) => {
	const memory = accessor.get(IVibeMemoryDecayService);
	const notifications = accessor.get(INotificationService);
	memory.persist();
	notifications.notify({ severity: Severity.Info, message: localize('vibeide.memory.persistDone', 'Память агента сохранена на диск.') });
});

// Semantic search — when invoked without a query (palette/keybinding), prompt for one, then show
// hits in a quick pick that opens the chosen file. Was log-only (invisible) and unusable from the UI.
CommandsRegistry.registerCommand('vibeide.search.semantic', async (accessor: ServicesAccessor, query?: string) => {
	const search = accessor.get(IVibeSemanticSearchService);
	const notifications = accessor.get(INotificationService);
	const quickInput = accessor.get(IQuickInputService);
	const editorService = accessor.get(IEditorService);
	if (!search.isReady()) {
		notifications.notify({ severity: Severity.Warning, message: localize('vibeide.search.notReady', 'Семантический поиск не готов — включите RAG в настройках VibeIDE.') });
		return;
	}
	const q = (query ?? '').trim() || (await quickInput.input({ prompt: localize('vibeide.search.prompt', 'Семантический поиск по кодовой базе') }))?.trim();
	if (!q) { return; }
	const results = await search.search(q, 10);
	if (results.length === 0) {
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.search.none', 'Ничего не найдено по запросу «{0}».', q) });
		return;
	}
	const picked = await quickInput.pick(
		results.map(r => ({ label: r.filePath, description: `${(r.score).toFixed(2)}`, detail: r.snippet.slice(0, 120), filePath: r.filePath })),
		{ placeHolder: localize('vibeide.search.results', 'Результаты для «{0}» — выберите файл', q) },
	);
	if (picked) { await editorService.openEditor({ resource: URI.file((picked as { filePath: string }).filePath) }); }
});

// Diff preview hint — informational. Was log-only; now a visible toast.
CommandsRegistry.registerCommand('vibeide.diff.showComplexity', (accessor: ServicesAccessor) => {
	const notifications = accessor.get(INotificationService);
	notifications.notify({ severity: Severity.Info, message: localize('vibeide.diff.complexityHint', 'Индикатор сложности диффа отображается на панели diff при открытом сравнении.') });
});

// Checkpoint prune — run the maintenance script in a terminal (renderer execSync threw).
CommandsRegistry.registerCommand('vibeide.checkpoint.prune', async (accessor: ServicesAccessor) => {
	await runInVibeTerminal(accessor.get(ITerminalService), 'VibeIDE Checkpoint Prune', 'node scripts/vibe-checkpoint-prune.js --keep-last 50');
});

// Vibe doctor
CommandsRegistry.registerCommand('vibeide.doctor.run', async (accessor: ServicesAccessor) => {
	await runInVibeTerminal(accessor.get(ITerminalService), 'VibeIDE Doctor', 'node scripts/vibe-doctor.js');
});

// Export audit log (GDPR)
CommandsRegistry.registerCommand('vibeide.audit.export', async (accessor: ServicesAccessor) => {
	await runInVibeTerminal(accessor.get(ITerminalService), 'VibeIDE Audit Export', 'node scripts/vibe-session-export.js --all --output vibe-audit-export.json');
});

CommandsRegistry.registerCommand('vibeide.audit.deleteAll', async (accessor: ServicesAccessor) => {
	const dialog = accessor.get(IDialogService);
	const terminal = accessor.get(ITerminalService);
	const confirmed = await dialog.confirm({
		message: localize('vibeide.audit.deleteAll.confirm', 'Удалить все данные аудита/сессий VibeIDE?'),
		detail: localize('vibeide.audit.deleteAll.detail', 'Операция необратима. Скрипт удаления запустится в терминале.'),
		primaryButton: localize('vibeide.audit.deleteAll.primary', 'Удалить'),
	});
	if (!confirmed.confirmed) { return; }
	await runInVibeTerminal(terminal, 'VibeIDE Audit Delete', 'node scripts/vibe-session-export.js --delete-all');
});

// Transparency dashboard
CommandsRegistry.registerCommand('vibeide.transparency.show', async (accessor: ServicesAccessor) => {
	await runInVibeTerminal(accessor.get(ITerminalService), 'VibeIDE Transparency', 'node scripts/vibe-transparency-dashboard.js --markdown');
});

// --- Plan Mode commands ---

// Switch chat mode to Plan (accessible from Command Palette)
CommandsRegistry.registerCommand('vibeide.chatMode.plan', (accessor: ServicesAccessor) => {
	const settings = accessor.get(IVibeideSettingsService);
	settings.setGlobalSetting('chatMode', 'plan');
	accessor.get(ILogService).info('[VibeIDE] Chat mode → Plan');
});

// Pre-flight plan: approve (keyboard: Enter when vibeide.preFlightPlanOpen)
// Wires into the existing PlanComponent approval flow via the chat thread
CommandsRegistry.registerCommand('vibeide.preFlight.approve', (accessor: ServicesAccessor) => {
	// The actual approval is handled by the React PlanComponent handleApprove / handleExecuteInAgent.
	// This command serves as a keyboard binding hook; the UI listens to this via the when-context.
	accessor.get(ILogService).info('[VibeIDE] Pre-flight approve triggered');
});

// Pre-flight plan: cancel (keyboard: Escape when vibeide.preFlightPlanOpen)
CommandsRegistry.registerCommand('vibeide.preFlight.cancel', (accessor: ServicesAccessor) => {
	accessor.get(ILogService).info('[VibeIDE] Pre-flight cancel triggered');
});

/** Built-in plan dashboard / tooling: bound executor sessions per persisted planId (workspace folder[0]). */
CommandsRegistry.registerCommand('vibeide.plans.bindingSnapshot', (accessor: ServicesAccessor, planId?: string) => {
	const workspace = accessor.get(IWorkspaceContextService);
	const reg = accessor.get(IVibePlanBindingRegistry);
	const folders = workspace.getWorkspace().folders;
	if (!folders.length || !planId) {
		return { count: 0, threadIds: [] as string[] };
	}
	const threadIds = reg.getThreadIds(folders[0]!.uri, String(planId));
	return { count: threadIds.length, threadIds };
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.showFolder',
			f1: true,
			title: localize2('vibeideSkillsShowFolderTitle', 'VibeIDE: Открыть папку скиллов агента (.vibe/skills)'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspace = accessor.get(IWorkspaceContextService);
		const files = accessor.get(IFileService);
		const cmds = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const roots = workspace.getWorkspace().folders;
		if (!roots.length) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeideSkillsNoWs', 'Сначала откройте папку рабочей области.'),
			});
			return;
		}
		const skillsDir = joinPath(roots[0].uri, '.vibe', 'skills');
		await files.createFolder(skillsDir);
		await cmds.executeCommand('revealInExplorer', skillsDir);
	}
});

// Reset auto-detected tool-format overrides. The agent loop auto-downgrades a
// model to XML-fallback after repeated native-FC tool failures (roadmap O.9/O.11,
// model-stalls #008), writing an `_autoDetected` override. That recovers
// stability but is sticky — if the provider/model later behaves, the model stays
// in slower XML mode. This command clears all such overrides in one click so the
// next call retries native function-calling. Manual overrides (no `_autoDetected`)
// are left untouched. Mirrors the per-model clear in chatThreadService O.11.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.toolFormat.resetAutoDetectedOverrides',
			f1: true,
			title: localize2('vibeideResetToolFormatTitle', 'VibeIDE: Сбросить авто-определённые tool-format оверрайды (включить native tool calling)'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const settings = accessor.get(IVibeideSettingsService);
		const notifications = accessor.get(INotificationService);

		const overridesOfModel = settings.state.overridesOfModel;
		const toClear: { provider: ProviderName; model: string }[] = [];
		for (const provider of Object.keys(overridesOfModel) as ProviderName[]) {
			const models = overridesOfModel[provider];
			if (!models) { continue; }
			for (const model of Object.keys(models)) {
				if (models[model]?._autoDetected) { toClear.push({ provider, model }); }
			}
		}

		if (toClear.length === 0) {
			notifications.info(localize('vibeideResetToolFormatNone', 'Авто-определённых tool-format оверрайдов нет — все модели уже в исходном режиме.'));
			return;
		}

		for (const { provider, model } of toClear) {
			await settings.setOverridesOfModel(provider, model, undefined);
		}

		notifications.info(localize(
			'vibeideResetToolFormatDone',
			'Сброшено авто-оверрайдов tool-format: {0}. При следующем вызове модели снова попробуют native function-calling: {1}.',
			toClear.length,
			toClear.map(t => `${t.provider}/${t.model}`).join(', '),
		));
	}
});

// Capture a project rule into .vibe/rules.md (roadmap 3061). Prefills from the
// active editor selection when there is one, then appends the entered text as a
// markdown bullet — quick way to turn an observation into a persisted agent rule.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.rules.addRule',
			f1: true,
			title: localize2('vibeideAddRuleTitle', 'VibeIDE: Добавить правило в .vibe/rules.md'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const workspace = accessor.get(IWorkspaceContextService);
		const files = accessor.get(IFileService);
		const editorService = accessor.get(IEditorService);
		const notifications = accessor.get(INotificationService);

		const roots = workspace.getWorkspace().folders;
		if (!roots.length) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeideAddRuleNoWs', 'Сначала откройте папку рабочей области.') });
			return;
		}

		// Best-effort prefill from the active editor selection (optional — the
		// command still works via manual input if there's no usable selection).
		let prefill = '';
		try {
			const ctrl = editorService.activeTextEditorControl;
			if (isCodeEditor(ctrl)) {
				const sel = ctrl.getSelection();
				const model = ctrl.getModel();
				if (sel && model && !sel.isEmpty()) { prefill = model.getValueInRange(sel).trim(); }
			}
		} catch { /* prefill is optional */ }

		const entered = await quickInput.input({
			prompt: localize('vibeideAddRulePrompt', 'Текст правила — будет добавлен в .vibe/rules.md'),
			value: prefill,
			placeHolder: localize('vibeideAddRulePlaceholder', 'например: всегда запускать тесты перед коммитом'),
		});
		const rule = entered?.trim();
		if (!rule) { return; }

		const vibeDir = joinPath(roots[0].uri, '.vibe');
		const rulesUri = joinPath(vibeDir, 'rules.md');
		await files.createFolder(vibeDir);
		let existing = '';
		try { existing = (await files.readFile(rulesUri)).value.toString(); } catch { /* file may not exist yet */ }
		const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
		await files.writeFile(rulesUri, VSBuffer.fromString(`${existing}${sep}- ${rule}\n`));
		notifications.info(localize('vibeideAddRuleDone', 'Правило добавлено в .vibe/rules.md.'));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.newTemplate',
			f1: true,
			title: localize2('vibeideSkillsNewTemplateTitle', 'VibeIDE: Новый шаблон скилла агента (.vibe/skills)'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspace = accessor.get(IWorkspaceContextService);
		const filesAccessor = accessor.get(IFileService);
		const cmds = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const roots = workspace.getWorkspace().folders;
		if (!roots.length) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeideSkillsTplNoWs', 'Сначала откройте папку рабочей области.'),
			});
			return;
		}
		const logService = accessor.get(ILogService);
		const skillsRoot = joinPath(roots[0].uri, '.vibe', 'skills');
		await filesAccessor.createFolder(skillsRoot);
		const slug = `new-skill-${Date.now()}`;
		const skillDir = joinPath(skillsRoot, slug);
		await filesAccessor.createFolder(skillDir);
		const uri = joinPath(skillDir, 'SKILL.md');
		const tpl = [
			'---',
			`name: ${slug}`,
			'description: Кратко, когда использовать этот навык (до ~1024 символов).',
			'vibeVersion: 1.0.0',
			'---',
			'',
			'# Новый навык',
			'',
			'<!-- Редактируйте тело. В чате: /skill:' + slug + ' -->',
			'',
			'1. Зачем нужен навык одним абзацем.',
			'2. Основные шаги модели.',
			'',
		].join('\n');
		await filesAccessor.writeFile(uri, VSBuffer.fromString(tpl));
		await cmds.executeCommand('vscode.open', uri);
		logService.info(`[VibeIDE] New skill scaffold: ${uri.fsPath}`);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.pickSession',
			f1: true,
			title: localize2('vibeideSkillsPickSessionTitle', 'VibeIDE: Скиллы — выбрать для сессии'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const skillsLib = accessor.get(IVibeSkillsLibraryService);
		const cfg = accessor.get(IConfigurationService);
		const qi = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const workspace = accessor.get(IWorkspaceContextService);
		if (!workspace.getWorkspace().folders.length) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeideSkillsPickNoWs', 'Сначала откройте папку рабочей области.') });
			return;
		}
		const loaded = await skillsLib.getSkills();
		if (!loaded.length) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeideSkillsPickNone', 'Скиллы в .vibe/skills и глобальных путях не найдены.') });
			return;
		}
		const active = new Set((cfg.getValue<string[]>('vibeide.skills.sessionActiveIds') ?? []).map(s => s.trim().toLowerCase()).filter(Boolean));
		const items: (IQuickPickItem & { picked?: boolean })[] = loaded.map(s => ({
			label: s.skillId,
			description: s.description.length > 140 ? `${s.description.slice(0, 137)}…` : s.description,
			picked: active.has(s.skillId.toLowerCase()),
		}));
		const picked = await qi.pick(items, {
			canPickMany: true,
			placeHolder: localize('vibeideSkillsPickPh', 'Включить/выключить скиллы для обнаружения GUIDELINES (пустой выбор = все скиллы)'),
		});
		if (picked === undefined) {
			return;
		}
		const next = picked.map(p => p.label).filter(Boolean);
		await cfg.updateValue('vibeide.skills.sessionActiveIds', next, ConfigurationTarget.WORKSPACE);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.clearSession',
			f1: true,
			title: localize2('vibeideSkillsClearSessionTitle', 'VibeIDE: Скиллы — очистить фильтр сессии'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IConfigurationService).updateValue('vibeide.skills.sessionActiveIds', [], ConfigurationTarget.WORKSPACE);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.plans.newInWorkspace',
			f1: true,
			title: localize2('vibeidePlansNewInWorkspaceTitle', 'VibeIDE: Новый план в рабочей области (.vibe/plans)'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspace = accessor.get(IWorkspaceContextService);
		const files = accessor.get(IFileService);
		const cmds = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const roots = workspace.getWorkspace().folders;
		if (!roots.length) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeidePlansNoWs', 'Сначала откройте папку рабочей области.'),
			});
			return;
		}
		const logService = accessor.get(ILogService);
		const wf = roots[0].uri;
		const plansDir = joinPath(wf, '.vibe', 'plans');
		await files.createFolder(plansDir);
		const planId = generateUuid();
		const createdAt = new Date().toISOString();
		const fileUri = joinPath(plansDir, `manual-${Date.now()}.plan.md`);
		const text = [
			'---',
			`planId: "${planId}"`,
			'vibeVersion: "1"',
			'planRevision: 1',
			'status: draft',
			`createdAt: "${createdAt}"`,
			`workspaceRootUri: "${wf.toString(true)}"`,
			'# Optional: providerId/modelId for routing — not raw API keys.',
			'# activeModel: { "providerId": "openAI", "modelName": "gpt-4o" }',
			'---',
			'',
			'# Plan',
			'',
			'## Goal',
			'',
			'(Describe objective.)',
			'',
			'## Steps',
			'',
			'- [ ] Step 1',
			'',
		].join('\n');
		await files.writeFile(fileUri, VSBuffer.fromString(text));
		await cmds.executeCommand('vscode.openWith', fileUri, 'vibeide.planDashboard');
		logService.info(`[VibeIDE] New plan template: ${fileUri.fsPath}`);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.plans.showPlansFolder',
			f1: true,
			title: localize2('vibeidePlansShowFolderTitle', 'VibeIDE: Открыть папку .vibe/plans в проводнике'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspace = accessor.get(IWorkspaceContextService);
		const files = accessor.get(IFileService);
		const cmds = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const roots = workspace.getWorkspace().folders;
		if (!roots.length) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeidePlansShowNoWs', 'Сначала откройте папку рабочей области.'),
			});
			return;
		}
		const plansDir = joinPath(roots[0].uri, '.vibe', 'plans');
		await files.createFolder(plansDir);
		await cmds.executeCommand('revealInExplorer', plansDir);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.plans.explainRisk',
			f1: true,
			title: localize2('vibeidePlansExplainRiskTitle', 'VibeIDE Plan: Объяснить риски плана (эвристический анализ)'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const files = accessor.get(IFileService);
		const notifications = accessor.get(INotificationService);
		const editors = accessor.get(IEditorService);

		let uri: URI | undefined;
		const fromArg = args[0];
		if (URI.isUri(fromArg)) {
			uri = fromArg;
		} else if (typeof fromArg === 'string') {
			try {
				uri = URI.parse(fromArg);
			} catch {
				uri = undefined;
			}
		}
		if (!uri) {
			const active = editors.activeEditor?.resource;
			if (active?.scheme === 'file' && active.fsPath.toLowerCase().endsWith('.plan.md')) {
				uri = active;
			}
		}
		if (!uri || uri.scheme !== 'file' || !uri.fsPath.toLowerCase().endsWith('.plan.md')) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeidePlansExplainRiskNeedPlan', 'Откройте файл `.plan.md` или используйте **Объяснить риски** с панели плана, пока открыта нужная вкладка.'),
			});
			return;
		}

		let text: string;
		try {
			text = (await files.readFile(uri)).value.toString();
		} catch {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeidePlansExplainRiskReadFail', 'Не удалось прочитать файл плана.'),
			});
			return;
		}

		const urlRe = /\bhttps?:\/\/[^\s)<>'"]+/gi;
		const urlMatches = text.match(urlRe);
		const urlCount = urlMatches ? urlMatches.length : 0;
		const gitPush = /\bgit\s+push\b/i.test(text);
		const mcpHints = /\bmcp\b/i.test(text) || /type:\s*mcp/i.test(text);
		let secretCueLines = 0;
		const secretCue = /\b(api[_-]?key|client_secret|password|passwd|bearer\s+token|secret)\b/i;
		for (const line of text.split(/\r?\n/)) {
			if (secretCue.test(line) && /[=:]/.test(line)) {
				secretCueLines++;
			}
		}

		notifications.notify({
			severity: Severity.Info,
			message: localize(
				'vibeidePlansExplainRiskSummary',
				'Риски плана (эвристика, значения секретов не показываются): внешних URL ≈ {0}; git push упоминается: {1}; признаки MCP: {2}; строки, похожие на присвоение секрета ≈ {3}. Проверьте перед запуском.',
				urlCount,
				gitPush ? localize('vibeideAffirmative', 'да') : localize('vibeideNegative', 'нет'),
				mcpHints ? localize('vibeideAffirmative', 'да') : localize('vibeideNegative', 'нет'),
				secretCueLines,
			),
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.plans.findSimilar',
			f1: true,
			title: localize2('vibeidePlansFindSimilarTitle', 'VibeIDE Plan: Найти похожие завершённые планы (локально)'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const planSearch = accessor.get(IVibePlanSimilarSearchService);
		const editors = accessor.get(IEditorService);
		const notifications = accessor.get(INotificationService);
		const workspace = accessor.get(IWorkspaceContextService);

		if (!workspace.getWorkspace().folders.length) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeidePlansFindSimilarNoWs', 'Сначала откройте папку рабочей области.') });
			return;
		}

		const query = await quickInput.input({
			title: localize('vibeidePlansFindSimilarInputTitle', 'Опишите план, который ищете'),
			placeHolder: localize('vibeidePlansFindSimilarPlaceholder', 'например: рефакторинг авторизации, добавить RU-локаль, исправить UI чекпоинта'),
		});
		if (!query?.trim()) {
			return;
		}

		const hits = await planSearch.findSimilarPlans(query.trim(), 12);
		if (!hits.length) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeidePlansFindSimilarEmpty', 'Файлы `.plan.md` в `.vibe/plans/` не найдены или ни один не совпал.'),
			});
			return;
		}

		const items: (IQuickPickItem & { resource?: URI })[] = hits.map(h => ({
			label: h.label,
			description: localize('vibeidePlansFindSimilarItemDescription', '{0}% · {1}', (h.score * 100).toFixed(0), h.preview),
			resource: h.uri,
		}));

		const picked = await quickInput.pick(items, {
			canPickMany: false,
			placeHolder: localize('vibeidePlansFindSimilarPick', 'Открыть план'),
		});
		if (picked?.resource) {
			const input: ITextResourceEditorInput = { resource: picked.resource, options: { transient: true } };
			await editors.openEditor(input);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.context.attachApiSpec',
			f1: true,
			title: localize2('vibeideAttachApiSpecTitle', 'VibeIDE: Прикрепить спецификацию OpenAPI / GraphQL к чату'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspace = accessor.get(IWorkspaceContextService);
		const fileDialog = accessor.get(IFileDialogService);
		const chatThreads = accessor.get(IChatThreadService);
		const views = accessor.get(IViewsService);
		const cmds = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		const lang = accessor.get(ILanguageService);
		const log = accessor.get(ILogService);

		const roots = workspace.getWorkspace().folders;
		if (!roots.length) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeideAttachSpecNoWs', 'Сначала откройте папку рабочей области.'),
			});
			return;
		}

		const picked = await fileDialog.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: roots[0].uri,
			title: localize('vibeideAttachSpecDialogTitle', 'Выберите спецификацию OpenAPI (YAML/JSON) или схему GraphQL'),
			filters: [
				{ name: localize('vibeideAttachSpecFilterApiSpecs', 'API-спецификации'), extensions: ['yaml', 'yml', 'json', 'graphql', 'gql'] },
				{ name: localize('vibeideAttachSpecFilterAllFiles', 'Все файлы'), extensions: ['*'] },
			],
		});
		const uri = picked?.[0];
		if (!uri) {
			return;
		}
		if (!workspace.isInsideWorkspace(uri)) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeideAttachSpecOutsideWs', 'Выберите файл внутри рабочей области.'),
			});
			return;
		}

		await views.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
		await cmds.executeCommand(VIBEIDE_OPEN_SIDEBAR_CMD);

		const languageId = lang.guessLanguageIdByFilepathOrFirstLine(uri);
		chatThreads.addNewStagingSelection({
			type: 'File',
			uri,
			language: languageId || '',
			state: { wasAddedAsCurrentFile: false },
		});

		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeideAttachSpecDone', 'Файл спецификации прикреплён к контексту чата: {0}', uri.fsPath),
		});
		log.info(`[VibeIDE] attachApiSpec: ${uri.fsPath}`);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.importCommunityUrl',
			f1: true,
			title: localize2('vibeideSkillsImportCommunityUrlTitle', 'VibeIDE: Импортировать скилл агента из URL (манифест сообщества или сырой SKILL.md)'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const qi = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const installSkillServices: InstallCommunitySkillServices = {
			workspace: accessor.get(IWorkspaceContextService),
			files: accessor.get(IFileService),
			cmds: accessor.get(ICommandService),
			notifications,
			log: accessor.get(ILogService),
		};
		const urlRaw = await qi.input({
			prompt: localize('vibeideSkillsCommunityUrlPrompt', 'HTTPS URL манифеста JSON скилла сообщества или сырого файла SKILL.md'),
			placeHolder: 'https://…',
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsCommunityUrlRequired', 'Введите URL.') : undefined),
		});
		if (urlRaw === undefined || !urlRaw.trim()) {
			return;
		}
		const expectSha = (await qi.input({
			prompt: localize('vibeideSkillsCommunityShaPrompt', 'Ожидаемый SHA-256 тела ответа (необязательно; оставьте пустым, чтобы пропустить)'),
			ignoreFocusLost: true,
		}))?.trim().toLowerCase() ?? '';
		let text: string;
		try {
			text = await vibeCommunityFetchText(urlRaw.trim());
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: String(e) });
			return;
		}
		let hex = '';
		try {
			hex = await vibeCommunitySha256Hex(text);
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: String(e) });
			return;
		}
		if (expectSha && expectSha !== hex) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeideSkillsCommunityShaMismatch', 'Несоответствие SHA-256 (получен {0}).', hex),
			});
			return;
		}

		let parsedJson: unknown | null = null;
		try {
			parsedJson = JSON.parse(text);
		} catch {
			parsedJson = null;
		}
		if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson) &&
			(parsedJson as Record<string, unknown>).format === COMMUNITY_MANIFEST_FORMAT) {
			try {
				const m = parseCommunitySkillManifest(parsedJson);
				await installCommunitySkillMarkdown(installSkillServices, m.skillId, m.skillMarkdown, `manifest sha=${hex.slice(0, 12)}`);
			} catch (e) {
				notifications.notify({ severity: Severity.Error, message: String(e) });
			}
			return;
		}
		const trimmed = text.trimStart();
		if (!trimmed.startsWith('---')) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeideSkillsCommunityNeither', 'Тело URL не является ни JSON-манифестом сообщества, ни SKILL.md с YAML frontmatter (---).'),
			});
			return;
		}
		const skillIdRaw = await qi.input({
			prompt: localize('vibeideSkillsCommunityRawIdPrompt', 'Id папки скилла (имя директории в .vibe/skills/)'),
			value: `imported-${Date.now()}`,
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsCommunityIdRequired', 'Введите id скилла.') : undefined),
		});
		if (skillIdRaw === undefined || !skillIdRaw.trim()) {
			return;
		}
		await installCommunitySkillMarkdown(installSkillServices, skillIdRaw.trim(), trimmed, `raw SKILL sha=${hex.slice(0, 12)}`);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.browseCommunityCatalog',
			f1: true,
			title: localize2('vibeideSkillsBrowseCommunityCatalogTitle', 'VibeIDE: Просмотр каталога скиллов агента сообщества'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const qi = accessor.get(IQuickInputService);
		const cfg = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);
		const installSkillServices: InstallCommunitySkillServices = {
			workspace: accessor.get(IWorkspaceContextService),
			files: accessor.get(IFileService),
			cmds: accessor.get(ICommandService),
			notifications,
			log: accessor.get(ILogService),
		};
		const defaultCatalog = (cfg.getValue<string>('vibeide.skills.communityCatalogUrl') ?? '').trim();
		const catalogUrl = await qi.input({
			prompt: localize('vibeideSkillsCommunityCatalogUrlPrompt', 'HTTPS URL JSON-каталога ({0})', COMMUNITY_CATALOG_FORMAT),
			value: defaultCatalog,
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsCommunityCatalogUrlRequired', 'Введите URL каталога или задайте vibeide.skills.communityCatalogUrl.') : undefined),
		});
		if (catalogUrl === undefined || !catalogUrl.trim()) {
			return;
		}
		let entries: CommunityCatalogEntry[];
		try {
			const body = await vibeCommunityFetchText(catalogUrl.trim());
			entries = parseCommunitySkillsCatalog(JSON.parse(body));
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: String(e) });
			return;
		}
		if (!entries.length) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeideSkillsCommunityCatalogEmpty', 'Каталог не содержит записей.'),
			});
			return;
		}
		const sel = await qi.pick(
			entries.map(e => ({
				label: e.id,
				description: e.name ?? '',
				detail: e.manifestUrl,
			})),
			{
				placeHolder: localize('vibeideSkillsCommunityPickEntry', 'Выберите скилл для установки'),
				canPickMany: false,
			},
		);
		if (!sel) {
			return;
		}
		const entry = entries.find(e => e.id === sel.label);
		if (!entry) {
			return;
		}
		let manifestText: string;
		try {
			manifestText = await vibeCommunityFetchText(entry.manifestUrl);
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: String(e) });
			return;
		}
		const hex = await vibeCommunitySha256Hex(manifestText);
		if (entry.sha256 && entry.sha256.toLowerCase() !== hex) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeideSkillsCommunityManifestShaMismatch', 'Несоответствие SHA-256 манифеста для "{0}".', entry.id),
			});
			return;
		}
		try {
			const m = parseCommunitySkillManifest(JSON.parse(manifestText));
			await installCommunitySkillMarkdown(installSkillServices, m.skillId, m.skillMarkdown, `catalog:${entry.id} sha=${hex.slice(0, 12)}`);
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: String(e) });
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.saveAsFromChat',
			f1: true,
			title: localize2('vibeideSkillsSaveAsFromChatTitle', 'VibeIDE: Сохранить последний ответ ассистента как скилл агента'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chat = accessor.get(IChatThreadService);
		const secrets = accessor.get(ISecretDetectionService);
		const qi = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const workspace = accessor.get(IWorkspaceContextService);
		const installSkillServices: InstallCommunitySkillServices = {
			workspace,
			files: accessor.get(IFileService),
			cmds: accessor.get(ICommandService),
			notifications,
			log: accessor.get(ILogService),
		};
		const roots = workspace.getWorkspace().folders;
		if (!roots.length) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeideSkillsSaveChatNoWs', 'Сначала откройте папку рабочей области.'),
			});
			return;
		}
		const raw = findLastAssistantDisplayContent(chat.getCurrentThread().messages as ChatMessage[]);
		if (!raw.trim()) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeideSkillsSaveChatEmpty', 'В текущем треде нет сообщений ассистента с текстом.'),
			});
			return;
		}
		const redacted = secrets.detectSecrets(raw).redactedText;
		const slug = await qi.input({
			prompt: localize('vibeideSkillsSaveChatIdPrompt', 'Id скилла (имя папки в .vibe/skills/)'),
			value: `from-chat-${Date.now()}`,
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsSaveChatIdRequired', 'Введите id скилла.') : undefined),
		});
		if (slug === undefined || !slug.trim()) {
			return;
		}
		const description = await qi.input({
			prompt: localize('vibeideSkillsSaveChatDescPrompt', 'Краткое описание (YAML frontmatter — когда использовать этот скилл)'),
			value: localize('vibeideSkillsSaveChatDescDefault', 'Сохранено из чата — отредактируйте описание после установки.'),
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsSaveChatDescRequired', 'Введите описание.') : undefined),
		});
		if (description === undefined || !description.trim()) {
			return;
		}
		const nameForYaml = sanitizeCommunitySkillFolderId(slug.trim());
		const escDesc = description.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		const skillMarkdown = [
			'---',
			`name: ${nameForYaml}`,
			`description: "${escDesc}"`,
			'vibeVersion: 1.0.0',
			'---',
			'',
			'# Saved from chat',
			'',
			'<!-- Body generated from the last assistant reply in this thread (secrets redacted). -->',
			'',
			redacted.trim(),
			'',
		].join('\n');
		await installCommunitySkillMarkdown(installSkillServices, nameForYaml, skillMarkdown, 'save-as-from-chat');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.copyIssueReport',
			f1: true,
			title: localize2('vibeideCopyIssueReportTitle', 'VibeIDE: Скопировать диагностический отчёт для отчёта об ошибке'),
			category: localize2('vibeCategory', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const productService = accessor.get(IProductService);
		const clipboard = accessor.get(IClipboardService);
		const audit = accessor.get(IAuditLogService);
		const settings = accessor.get(IVibeideSettingsService);
		const chat = accessor.get(IChatThreadService);
		const secrets = accessor.get(ISecretDetectionService);
		const notifications = accessor.get(INotificationService);

		const os = isWindows ? 'win32' : isMacintosh ? 'darwin' : isLinux ? 'linux' : 'unknown';
		const version = productService.version ?? 'unknown';
		const vibeVersion = productService.vibeVersion ?? 'unknown';
		const commit = typeof productService.commit === 'string' ? productService.commit : '';
		const name = productService.nameShort ?? 'VibeIDE';

		const sel = settings.state.modelSelectionOfFeature['Chat'];
		const providerLine =
			sel && !(sel.providerName === 'auto' && sel.modelName === 'auto')
				? `${sel.providerName} / ${sel.modelName}`
				: 'auto';

		const thread = chat.getCurrentThread();
		let planCtx = 'no plan message in current thread';
		for (let i = thread.messages.length - 1; i >= 0; i--) {
			const m = thread.messages[i];
			if (m.role === 'plan') {
				const p = m as PlanMessage;
				planCtx = `persistedPlanId: ${p.persistedPlanId ?? '(none)'}; approval: ${p.approvalState ?? 'n/a'}`;
				break;
			}
		}

		let auditLines: string;
		if (audit.isEnabled()) {
			const events = await audit.queryRecent(40);
			const slim = events.map(e => {
				const metaStr =
					e.meta !== undefined ? secrets.detectSecrets(JSON.stringify(e.meta)).redactedText : '';
				const files = e.files?.map(f => {
					const norm = f.replace(/\\/g, '/');
					const parts = norm.split('/');
					return parts[parts.length - 1] || '(file)';
				});
				return {
					ts: e.ts,
					action: e.action,
					ok: e.ok,
					files,
					model: e.model,
					meta: metaStr.slice(0, 2000),
				};
			});
			auditLines = JSON.stringify(slim, null, 2);
		} else {
			auditLines = '(audit disabled — enable vibeide.audit.enable to include events)';
		}

		const report = [
			'## VibeIDE issue diagnostic',
			'',
			`**VibeIDE:** ${vibeVersion}${commit ? ` (${commit.slice(0, 7)})` : ''} — base ${name} ${version}`,
			`**OS:** ${os}`,
			`**Chat model (ids only):** ${providerLine}`,
			`**Current thread:** ${thread.id.slice(0, 8)}… — ${planCtx}`,
			'',
			'### Recent audit (redacted, basename-only paths)',
			'',
			'```json',
			auditLines,
			'```',
			'',
			'_No API keys: metadata passed through secret detection._',
		].join('\n');

		await clipboard.writeText(report);
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeideCopyIssueReportDone', 'Диагностический отчёт скопирован в буфер обмена.'),
		});
	}
});
