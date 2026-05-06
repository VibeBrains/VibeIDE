/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVibeTokenBudgetService } from '../common/vibeTokenBudgetService.js';
import { IVibeContextGuardService } from './vibeContextGuardService.js';
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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVibeSkillsLibraryService } from '../common/vibeSkillsLibraryService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { IChatThreadService } from './chatThreadService.js';
import { IVibePlanBindingRegistry } from './vibePlanBindingRegistry.js';
import { VIBEIDE_VIEW_CONTAINER_ID } from './sidebarPane.js';
import type { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IAuditLogService } from '../common/auditLogService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { isWindows, isMacintosh, isLinux } from '../../../../base/common/platform.js';
import type { PlanMessage } from '../common/chatThreadServiceTypes.js';

const VIBEIDE_OPEN_SIDEBAR_CMD = 'vibeide.sidebar.open';

const COMMUNITY_MANIFEST_FORMAT = 'vibe-community-skill-manifest-v1';
const COMMUNITY_CATALOG_FORMAT = 'vibe-community-skills-catalog-v1';

function assertJsonRecord(json: unknown): asserts json is Record<string, unknown> {
	if (!json || typeof json !== 'object' || Array.isArray(json)) {
		throw new Error(localize('vibeideSkillsCommunityExpectObject', 'Invalid JSON: expected an object.'));
	}
}

type ParsedCommunityManifest = { skillId: string; skillMarkdown: string };

function parseCommunitySkillManifest(json: unknown): ParsedCommunityManifest {
	assertJsonRecord(json);
	if (json.format !== COMMUNITY_MANIFEST_FORMAT) {
		throw new Error(localize('vibeideSkillsCommunityBadManifestFmt', 'Manifest JSON must have format "{0}".', COMMUNITY_MANIFEST_FORMAT));
	}
	const skillId = json.skillId;
	const skillMarkdown = json.skillMarkdown;
	if (typeof skillId !== 'string' || !skillId.trim()) {
		throw new Error(localize('vibeideSkillsCommunityBadSkillId', 'manifest.skillId is required.'));
	}
	if (typeof skillMarkdown !== 'string' || !skillMarkdown.trim()) {
		throw new Error(localize('vibeideSkillsCommunityBadBody', 'manifest.skillMarkdown is required.'));
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
		throw new Error(localize('vibeideSkillsCommunityBadCatalogFmt', 'Catalog JSON must have format "{0}".', COMMUNITY_CATALOG_FORMAT));
	}
	const entries = json.entries;
	if (!Array.isArray(entries)) {
		throw new Error(localize('vibeideSkillsCommunityBadEntries', 'catalog.entries must be an array.'));
	}
	return entries.map((e: unknown, i: number) => {
		assertJsonRecord(e);
		const id = e.id;
		const manifestUrl = e.manifestUrl;
		if (typeof id !== 'string' || !id.trim()) {
			throw new Error(localize('vibeideSkillsCommunityBadEntryId', 'entries[{0}].id is required.', String(i)));
		}
		if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) {
			throw new Error(localize('vibeideSkillsCommunityBadEntryUrl', 'entries[{0}].manifestUrl is required.', String(i)));
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
		throw new Error(localize('vibeideSkillsCommunityHttpErr', 'HTTP {0} when fetching URL.', String(res.status)));
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
			message: localize('vibeideSkillsCommunityNoWs', 'Open a folder workspace first.'),
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
		message: localize('vibeideSkillsCommunityInstalled', 'Installed Agent Skill under .vibe/skills/{0}/', skillId),
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

CommandsRegistry.registerCommand('vibeide.trustScore.setManual', (_accessor: ServicesAccessor) => {
	// Phase 2: update Trust Score state to Manual
});

CommandsRegistry.registerCommand('vibeide.trustScore.setSupervised', (_accessor: ServicesAccessor) => {
	// Phase 2: update Trust Score state to Supervised
});

CommandsRegistry.registerCommand('vibeide.trustScore.setAuto', (_accessor: ServicesAccessor) => {
	// Phase 2: update Trust Score state to Auto
});

// Token budget
CommandsRegistry.registerCommand('vibeide.tokenBudget.reset', (accessor: ServicesAccessor) => {
	const budget = accessor.get(IVibeTokenBudgetService);
	budget.resetSession();
});

CommandsRegistry.registerCommand('vibeide.tokenBudget.status', (accessor: ServicesAccessor) => {
	const budget = accessor.get(IVibeTokenBudgetService);
	const status = budget.getStatus();
	const log = accessor.get(ILogService);
	log.info(`[VibeIDE] Token budget: ${status.sessionTokensUsed.toLocaleString()}/${status.sessionTokensLimit.toLocaleString()} (${status.percentUsed.toFixed(0)}%)`);
});

CommandsRegistry.registerCommand('vibeide.emergencyStopAllAgents', async (accessor: ServicesAccessor) => {
	const chat = accessor.get(IChatThreadService);
	const notifications = accessor.get(INotificationService);
	const n = await chat.emergencyStopAllAgents();
	notifications.notify({
		severity: Severity.Info,
		message: localize(
			'vibeideEmergencyStopDone',
			'Emergency stop: aborted {0} active agent thread(s). On-disk execution leases are unchanged — clear stale leases from the plan dashboard if needed.',
			n,
		),
	});
});

// Dead man's switch
CommandsRegistry.registerCommand('vibeide.dms.stop', (accessor: ServicesAccessor) => {
	// Phase 2: stop current DMS
	const log = accessor.get(ILogService);
	log.info('[VibeIDE] Dead man\'s switch stopped');
});

// Loop detector
CommandsRegistry.registerCommand('vibeide.loopDetector.reset', (accessor: ServicesAccessor) => {
	// Phase 2: reset current session loop detector
	const log = accessor.get(ILogService);
	log.info('[VibeIDE] Loop detector reset');
});

// Context guard
CommandsRegistry.registerCommand('vibeide.context.status', (accessor: ServicesAccessor) => {
	const guard = accessor.get(IVibeContextGuardService);
	const status = guard.getStatus();
	const log = accessor.get(ILogService);
	log.info(`[VibeIDE] Context: ${status.percentUsed.toFixed(0)}% (${status.currentTokens.toLocaleString()}/${status.maxTokens.toLocaleString()} tokens)`);
});

// Agent history
CommandsRegistry.registerCommand('vibeide.agentHistory.show', (accessor: ServicesAccessor) => {
	const history = accessor.get(IVibeAgentHistoryService);
	const entries = history.getCurrentSessionHistory();
	const log = accessor.get(ILogService);
	log.info(`[VibeIDE] Agent history: ${entries.length} actions in current session`);
	entries.slice(-5).forEach((e, i) => log.info(`  ${i + 1}. ${e.action}: ${e.description.slice(0, 60)}`));
});

// Memory decay
CommandsRegistry.registerCommand('vibeide.memory.persist', (accessor: ServicesAccessor) => {
	const memory = accessor.get(IVibeMemoryDecayService);
	memory.persist();
});

// Semantic search
CommandsRegistry.registerCommand('vibeide.search.semantic', async (accessor: ServicesAccessor, query: string) => {
	const search = accessor.get(IVibeSemanticSearchService);
	const log = accessor.get(ILogService);
	if (!search.isReady()) {
		log.warn('[VibeIDE] Semantic search not ready. Enable RAG in settings.');
		return;
	}
	const results = await search.search(query, 5);
	log.info(`[VibeIDE] Search results for "${query}":`);
	results.forEach((r, i) => log.info(`  ${i + 1}. ${r.filePath} (score: ${r.score.toFixed(2)}): ${r.snippet.slice(0, 60)}`));
});

// Diff preview
CommandsRegistry.registerCommand('vibeide.diff.showComplexity', (accessor: ServicesAccessor) => {
	const log = accessor.get(ILogService);
	log.info('[VibeIDE] Diff complexity: open diff panel to see indicator');
});

// Checkpoint prune
CommandsRegistry.registerCommand('vibeide.checkpoint.prune', (_accessor: ServicesAccessor) => {
	const { execSync } = require('child_process');
	execSync('node scripts/vibe-checkpoint-prune.js --keep-last 50', { stdio: 'inherit' });
});

// Vibe doctor
CommandsRegistry.registerCommand('vibeide.doctor.run', (_accessor: ServicesAccessor) => {
	const { execSync } = require('child_process');
	execSync('node scripts/vibe-doctor.js', { stdio: 'inherit' });
});

// Export audit log (GDPR)
CommandsRegistry.registerCommand('vibeide.audit.export', (_accessor: ServicesAccessor) => {
	const { execSync } = require('child_process');
	execSync('node scripts/vibe-session-export.js --all --output vibe-audit-export.json', { stdio: 'inherit' });
});

CommandsRegistry.registerCommand('vibeide.audit.deleteAll', (_accessor: ServicesAccessor) => {
	const { execSync } = require('child_process');
	execSync('node scripts/vibe-session-export.js --delete-all', { stdio: 'inherit' });
});

// Transparency dashboard
CommandsRegistry.registerCommand('vibeide.transparency.show', (_accessor: ServicesAccessor) => {
	const { execSync } = require('child_process');
	execSync('node scripts/vibe-transparency-dashboard.js --markdown', { stdio: 'inherit' });
});

// --- Plan Mode commands ---

// Switch chat mode to Plan (accessible from Command Palette)
CommandsRegistry.registerCommand('vibeide.chatMode.plan', (accessor: ServicesAccessor) => {
	const { IVibeideSettingsService } = require('../common/vibeideSettingsService.js') as typeof import('../common/vibeideSettingsService.js');
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
			title: localize2('vibeideSkillsShowFolderTitle', 'VibeIDE: Open Agent Skills folder (.vibe/skills)'),
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
				message: localize('vibeideSkillsNoWs', 'Open a folder workspace first.'),
			});
			return;
		}
		const skillsDir = joinPath(roots[0].uri, '.vibe', 'skills');
		await files.createFolder(skillsDir);
		await cmds.executeCommand('revealInExplorer', skillsDir);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.newTemplate',
			f1: true,
			title: localize2('vibeideSkillsNewTemplateTitle', 'VibeIDE: New Agent Skill template (.vibe/skills)'),
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
				message: localize('vibeideSkillsTplNoWs', 'Open a folder workspace before adding a skill.'),
			});
			return;
		}
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
		accessor.get(ILogService).info(`[VibeIDE] New skill scaffold: ${uri.fsPath}`);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.pickSession',
			f1: true,
			title: localize2('vibeideSkillsPickSessionTitle', 'VibeIDE: Skills — select for session'),
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
			notifications.notify({ severity: Severity.Warning, message: localize('vibeideSkillsPickNoWs', 'Open a folder workspace first.') });
			return;
		}
		const loaded = await skillsLib.getSkills();
		if (!loaded.length) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeideSkillsPickNone', 'No skills loaded from .vibe/skills or global paths.') });
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
			placeHolder: localize('vibeideSkillsPickPh', 'Toggle skills for GUIDELINES discovery (empty selection = use all skills)'),
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
			title: localize2('vibeideSkillsClearSessionTitle', 'VibeIDE: Skills — clear session filter'),
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
			title: localize2('vibeidePlansNewInWorkspaceTitle', 'VibeIDE: New plan in workspace (.vibe/plans)'),
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
				message: localize('vibeidePlansNoWs', 'Open a folder workspace before creating a project plan.'),
			});
			return;
		}
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
		accessor.get(ILogService).info(`[VibeIDE] New plan template: ${fileUri.fsPath}`);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.plans.showPlansFolder',
			f1: true,
			title: localize2('vibeidePlansShowFolderTitle', 'VibeIDE: Open .vibe/plans folder in Explorer'),
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
				message: localize('vibeidePlansShowNoWs', 'Open a folder workspace first.'),
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
			title: localize2('vibeidePlansExplainRiskTitle', 'VibeIDE Plan: Explain plan risk (heuristic scan)'),
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
				message: localize('vibeidePlansExplainRiskNeedPlan', 'Open a `.plan.md` file first, or use **Explain risk** from the plan dashboard while that tab is active.'),
			});
			return;
		}

		let text: string;
		try {
			text = (await files.readFile(uri)).value.toString();
		} catch {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeidePlansExplainRiskReadFail', 'Could not read the plan file.'),
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
				'Plan risk (heuristic scan — no secret values shown): external URLs ≈ {0}; git push mentioned: {1}; MCP hints: {2}; lines that look like secret assignments ≈ {3}. Review before Execute.',
				urlCount,
				gitPush ? localize('vibeideAffirmative', 'yes') : localize('vibeideNegative', 'no'),
				mcpHints ? localize('vibeideAffirmative', 'yes') : localize('vibeideNegative', 'no'),
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
			title: localize2('vibeidePlansFindSimilarTitle', 'VibeIDE Plan: Find similar completed plans (local)'),
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
			notifications.notify({ severity: Severity.Warning, message: localize('vibeidePlansFindSimilarNoWs', 'Open a folder workspace first.') });
			return;
		}

		const query = await quickInput.input({
			title: localize('vibeidePlansFindSimilarInputTitle', 'Describe the plan you are looking for'),
			placeHolder: localize('vibeidePlansFindSimilarPlaceholder', 'e.g. refactor auth, add RU locale, fix checkpoint UI'),
		});
		if (!query?.trim()) {
			return;
		}

		const hits = await planSearch.findSimilarPlans(query.trim(), 12);
		if (!hits.length) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeidePlansFindSimilarEmpty', 'No `.plan.md` files under `.vibe/plans/` yet, or nothing matched.'),
			});
			return;
		}

		const items: (IQuickPickItem & { resource?: URI })[] = hits.map(h => ({
			label: h.label,
			description: `${(h.score * 100).toFixed(0)}% · ${h.preview}`,
			resource: h.uri,
		}));

		const picked = await quickInput.pick(items, {
			canPickMany: false,
			placeHolder: localize('vibeidePlansFindSimilarPick', 'Open a plan'),
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
			title: localize2('vibeideAttachApiSpecTitle', 'VibeIDE: Attach OpenAPI / GraphQL spec to chat'),
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
				message: localize('vibeideAttachSpecNoWs', 'Open a folder workspace first.'),
			});
			return;
		}

		const picked = await fileDialog.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: roots[0].uri,
			title: localize('vibeideAttachSpecDialogTitle', 'Select OpenAPI (YAML/JSON) or GraphQL schema'),
			filters: [
				{ name: 'API specs', extensions: ['yaml', 'yml', 'json', 'graphql', 'gql'] },
				{ name: 'All files', extensions: ['*'] },
			],
		});
		const uri = picked?.[0];
		if (!uri) {
			return;
		}
		if (!workspace.isInsideWorkspace(uri)) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeideAttachSpecOutsideWs', 'Pick a file inside the workspace.'),
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
			message: localize('vibeideAttachSpecDone', 'Attached spec file to chat context: {0}', uri.fsPath),
		});
		log.info(`[VibeIDE] attachApiSpec: ${uri.fsPath}`);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.skills.importCommunityUrl',
			f1: true,
			title: localize2('vibeideSkillsImportCommunityUrlTitle', 'VibeIDE: Import Agent Skill from URL (community manifest or raw SKILL.md)'),
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
			prompt: localize('vibeideSkillsCommunityUrlPrompt', 'HTTPS URL of a community skill manifest JSON or a raw SKILL.md file'),
			placeHolder: 'https://…',
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsCommunityUrlRequired', 'Enter a URL.') : undefined),
		});
		if (urlRaw === undefined || !urlRaw.trim()) {
			return;
		}
		const expectSha = (await qi.input({
			prompt: localize('vibeideSkillsCommunityShaPrompt', 'Expected SHA-256 of downloaded body (optional; leave empty to skip)'),
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
				message: localize('vibeideSkillsCommunityShaMismatch', 'SHA-256 mismatch (got {0}).', hex),
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
				message: localize('vibeideSkillsCommunityNeither', 'URL body is neither a community manifest JSON nor a SKILL.md starting with YAML frontmatter (---).'),
			});
			return;
		}
		const skillIdRaw = await qi.input({
			prompt: localize('vibeideSkillsCommunityRawIdPrompt', 'Skill folder id (directory name under .vibe/skills/)'),
			value: `imported-${Date.now()}`,
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsCommunityIdRequired', 'Enter a skill id.') : undefined),
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
			title: localize2('vibeideSkillsBrowseCommunityCatalogTitle', 'VibeIDE: Browse community Agent Skills catalog'),
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
			prompt: localize('vibeideSkillsCommunityCatalogUrlPrompt', 'HTTPS URL of catalog JSON ({0})', COMMUNITY_CATALOG_FORMAT),
			value: defaultCatalog,
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsCommunityCatalogUrlRequired', 'Enter catalog URL or set vibeide.skills.communityCatalogUrl.') : undefined),
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
				message: localize('vibeideSkillsCommunityCatalogEmpty', 'Catalog has no entries.'),
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
				placeHolder: localize('vibeideSkillsCommunityPickEntry', 'Pick a skill to install'),
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
				message: localize('vibeideSkillsCommunityManifestShaMismatch', 'Manifest SHA-256 mismatch for "{0}".', entry.id),
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
			title: localize2('vibeideSkillsSaveAsFromChatTitle', 'VibeIDE: Save last assistant reply as Agent Skill'),
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
				message: localize('vibeideSkillsSaveChatNoWs', 'Open a folder workspace first.'),
			});
			return;
		}
		const raw = findLastAssistantDisplayContent(chat.getCurrentThread().messages as ChatMessage[]);
		if (!raw.trim()) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeideSkillsSaveChatEmpty', 'No assistant message with text found in the current thread.'),
			});
			return;
		}
		const redacted = secrets.detectSecrets(raw).redactedText;
		const slug = await qi.input({
			prompt: localize('vibeideSkillsSaveChatIdPrompt', 'Skill id (folder name under .vibe/skills/)'),
			value: `from-chat-${Date.now()}`,
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsSaveChatIdRequired', 'Enter a skill id.') : undefined),
		});
		if (slug === undefined || !slug.trim()) {
			return;
		}
		const description = await qi.input({
			prompt: localize('vibeideSkillsSaveChatDescPrompt', 'Short description (YAML frontmatter — when to use this skill)'),
			value: localize('vibeideSkillsSaveChatDescDefault', 'Saved from chat — edit description after install.'),
			ignoreFocusLost: true,
			validateInput: async (v) => (!v.trim() ? localize('vibeideSkillsSaveChatDescRequired', 'Enter a description.') : undefined),
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
			title: localize2('vibeideCopyIssueReportTitle', 'VibeIDE: Copy diagnostic report for issue'),
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
			`**Product:** ${name} ${version}${commit ? ` (${commit.slice(0, 7)})` : ''}`,
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
			message: localize('vibeideCopyIssueReportDone', 'Diagnostic report copied to clipboard.'),
		});
	}
});
