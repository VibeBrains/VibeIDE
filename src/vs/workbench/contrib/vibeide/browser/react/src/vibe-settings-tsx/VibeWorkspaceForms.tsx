/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeButtonBgDarken } from '../util/inputs.js';
import { joinPath } from '../../../../../../../base/common/resources.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';
import {
	ADD_COMMAND_DRAFT_EMPTY,
	ADD_COMMAND_ERROR,
	AddCommandDraft,
	appendCommandToFile,
	buildProjectCommandFromDraft,
	previewProjectCommandJson,
	removeCommandFromFile,
	setPinnedInFile,
	validateAddCommandDraft,
} from '../../../../common/projectCommandsAddFormPolicy.js';
import {
	decodeProjectCommandsFile,
	ProjectCommand,
	ProjectCommandsFile,
	ProjectCommandTerminal,
	sortProjectCommandsForDisplay,
} from '../../../../common/projectCommandsTypes.js';
import { serializeProjectCommandsInitTemplate } from '../../../../common/projectCommandsInitTemplate.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../../../../common/projectCommandsServiceContract.js';
import { safeParseConfigJson } from '../../../../common/vibeConfigJsonParser.js';
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js';
import {
	MAX_VIBE_RULES_FORM_BYTES,
	isValidVibeWorkspaceTemplateId,
	VibeWorkspacePromptListItem,
	VibeWorkspaceRootFileListItem,
	VibeWorkspaceSkillListItem,
	VibeWorkspaceTreeNode,
	VibeWorkspaceWorkflowListItem,
} from '../../../vibeWorkspaceFormsService.js';
import { parseSkillMarkdown } from '../../../../common/vibeSkillsLibraryService.js';
import {
	workspaceRootJsonDocMarkdown,
	workspaceS,
	VIBE_AGENT_LOCKS_JSON_EXAMPLE,
	VIBE_ALLOWED_MODELS_JSON_EXAMPLE,
	VIBE_CONSTRAINTS_JSON_EXAMPLE,
	VIBE_GENERIC_ROOT_JSON_EXAMPLE,
	VIBE_GOALS_FORM_EXAMPLE,
	VIBE_PINNED_JSON_EXAMPLE,
} from './vibeSettingsRu.js';

function newWorkflowTemplateJson(fileBaseId: string): string {
	return `${JSON.stringify(
		{
			name: fileBaseId,
			description: workspaceS.workflowTplDescription,
			steps: [{ name: workspaceS.workflowTplStepName, description: workspaceS.workflowTplStepDescription }],
		},
		null,
		'\t',
	)}\n`;
}

const RJ_JSON_TAB = 'rj:' as const;

type WorkspaceFormsSubTab =
	| 'rules'
	| 'agents'
	| 'goals'
	| 'prompts'
	| 'workflows'
	| 'skills'
	| 'projectCommands'
	| 'vibeStructure'
	| `${typeof RJ_JSON_TAB}${string}`;

type MainWorkspaceSubtab = Exclude<WorkspaceFormsSubTab, `${typeof RJ_JSON_TAB}${string}`>;

function isRjTab(t: WorkspaceFormsSubTab): t is `${typeof RJ_JSON_TAB}${string}` {
	return typeof t === 'string' && t.startsWith(RJ_JSON_TAB);
}

function rjBasenameFromTab(t: WorkspaceFormsSubTab): string {
	return isRjTab(t) ? t.slice(RJ_JSON_TAB.length) : '';
}

function rootJsonExampleSnippet(basename: string): string {
	switch (basename) {
		case 'constraints.json':
			return VIBE_CONSTRAINTS_JSON_EXAMPLE;
		case 'allowed-models.json':
			return VIBE_ALLOWED_MODELS_JSON_EXAMPLE;
		case 'pinned.json':
			return VIBE_PINNED_JSON_EXAMPLE;
		case 'agent-locks.json':
			return VIBE_AGENT_LOCKS_JSON_EXAMPLE;
		default:
			return VIBE_GENERIC_ROOT_JSON_EXAMPLE;
	}
}

function VibeStructureTree(props: {
	nodes: VibeWorkspaceTreeNode[];
	depth: number;
	expandedDirs: ReadonlySet<string>;
	toggleDir: (relativePath: string) => void;
	selectedPath: string | null;
	onPickFile: (relativePath: string) => void;
}) {
	const { nodes, depth, expandedDirs, toggleDir, selectedPath, onPickFile } = props;
	return (
		<>
			{nodes.map(node => (
				node.kind === 'dir' ? (
					<div key={`d:${node.relativePath}`}>
						<button
							type='button'
							className='block w-full text-left px-1 py-0.5 rounded font-mono hover:bg-vibe-bg-1'
							style={{ paddingLeft: `${4 + depth * 12}px` }}
							onClick={() => toggleDir(node.relativePath)}
						>
							<span className='text-vibe-fg-4 mr-1'>{expandedDirs.has(node.relativePath) ? '▼' : '▶'}</span>
							<span className='text-vibe-fg-2'>{node.name}</span>
							<span className='text-vibe-fg-4'>/</span>
						</button>
						{expandedDirs.has(node.relativePath) ? (
							<VibeStructureTree
								nodes={node.children}
								depth={depth + 1}
								expandedDirs={expandedDirs}
								toggleDir={toggleDir}
								selectedPath={selectedPath}
								onPickFile={onPickFile}
							/>
						) : null}
					</div>
				) : (
					<button
						key={`f:${node.relativePath}`}
						type='button'
						className={`block w-full text-left px-1 py-0.5 rounded font-mono text-vibe-fg-2 hover:bg-vibe-bg-1 ${selectedPath === node.relativePath ? 'bg-vibe-bg-2' : ''}`}
						style={{ paddingLeft: `${10 + depth * 12}px` }}
						onClick={() => onPickFile(node.relativePath)}
					>
						{node.name}
					</button>
				)
			))}
		</>
	);
}

/** Workspace settings panel: Rules / Agents / Goals / Prompts / Workflows / Skills / structure tree; README preview via button; root JSON pills. */
export const VibeWorkspaceFormsPanel = () => {
	const accessor = useAccessor();
	const workspaceContext = accessor.get('IWorkspaceContextService');
	const forms = accessor.get('IVibeWorkspaceFormsService');
	const notificationService = accessor.get('INotificationService');
	const commandService = accessor.get('ICommandService');
	const fileService = accessor.get('IFileService');

	const folders = workspaceContext.getWorkspace().folders;
	const [folderIndex, setFolderIndex] = useState(0);
	const rootUri = folders[folderIndex]?.uri;

	const [subTab, setSubTab] = useState<WorkspaceFormsSubTab>('rules');
	// Monotonic tick incremented every time the user requests "open Add form" from
	// outside `ProjectCommandsPanel` (e.g. the commands.json action-row deep-link).
	// `ProjectCommandsPanel` watches the tick via `useEffect` and flips local
	// `addOpen` state — works for repeated clicks without a callback round-trip.
	const [pcOpenAddTick, setPcOpenAddTick] = useState(0);
	/** README preview: separate entry via button above the tab pills. */
	const [workspaceAuxView, setWorkspaceAuxView] = useState<'forms' | 'readme'>('forms');

	// --- Rules ---
	const [rulesText, setRulesText] = useState('');
	const [rulesRev, setRulesRev] = useState<string | undefined>(undefined);
	const [rulesDirty, setRulesDirty] = useState(false);
	const [rulesTooLarge, setRulesTooLarge] = useState(false);

	// --- Agents ---
	const [agentsText, setAgentsText] = useState('');
	const [agentsRev, setAgentsRev] = useState<string | undefined>(undefined);
	const [agentsDirty, setAgentsDirty] = useState(false);
	const [agentsTooLarge, setAgentsTooLarge] = useState(false);

	const loadRules = useCallback(async () => {
		if (!rootUri) { return; }
		const r = await forms.loadRules(rootUri);
		setRulesTooLarge(!!r.skippedTooLarge);
		setRulesText(r.skippedTooLarge ? '' : r.content);
		setRulesRev(r.revision);
		setRulesDirty(false);
	}, [forms, rootUri]);

	const loadAgents = useCallback(async () => {
		if (!rootUri) { return; }
		const r = await forms.loadAgents(rootUri);
		setAgentsTooLarge(!!r.skippedTooLarge);
		setAgentsText(r.skippedTooLarge ? '' : r.content);
		setAgentsRev(r.revision);
		setAgentsDirty(false);
	}, [forms, rootUri]);

	const [goalsText, setGoalsText] = useState('');
	const [goalsRev, setGoalsRev] = useState<string | undefined>(undefined);
	const [goalsDirty, setGoalsDirty] = useState(false);
	const [goalsTooLarge, setGoalsTooLarge] = useState(false);

	const loadGoals = useCallback(async () => {
		if (!rootUri) { return; }
		const r = await forms.loadGoals(rootUri);
		setGoalsTooLarge(!!r.skippedTooLarge);
		setGoalsText(r.skippedTooLarge ? '' : r.content);
		setGoalsRev(r.revision);
		setGoalsDirty(false);
	}, [forms, rootUri]);

	useEffect(() => {
		if (subTab === 'rules') { void loadRules(); }
	}, [subTab, folderIndex, loadRules]);

	useEffect(() => {
		if (subTab === 'agents') { void loadAgents(); }
	}, [subTab, folderIndex, loadAgents]);

	useEffect(() => {
		if (subTab === 'goals') { void loadGoals(); }
	}, [subTab, folderIndex, loadGoals]);

	const reloadIfConflict = useCallback(async (): Promise<boolean> => {
		return window.confirm(workspaceS.reloadDisk);
	}, []);

	const saveRules = async () => {
		if (!rootUri) { return; }
		const result = await forms.saveRules(rootUri, rulesText, rulesRev);
		if (result === 'conflict') {
			if (await reloadIfConflict()) { await loadRules(); }
			else if (window.confirm(workspaceS.overwriteDisk)) {
				const fresh = await forms.loadRules(rootUri);
				const r2 = await forms.saveRules(rootUri, rulesText, fresh.revision);
				if (r2 === 'saved') {
					notificationService.info(workspaceS.savedRules);
					await loadRules();
				}
			}
			return;
		}
		if (result === 'too_large') {
			notificationService.warn(workspaceS.fileExceedsBytes(MAX_VIBE_RULES_FORM_BYTES));
			return;
		}
		notificationService.info(workspaceS.savedRules);
		await loadRules();
	};

	const saveAgents = async () => {
		if (!rootUri) { return; }
		const result = await forms.saveAgents(rootUri, agentsText, agentsRev);
		if (result === 'conflict') {
			if (await reloadIfConflict()) { await loadAgents(); }
			else if (window.confirm(workspaceS.overwriteDisk)) {
				const fresh = await forms.loadAgents(rootUri);
				const r2 = await forms.saveAgents(rootUri, agentsText, fresh.revision);
				if (r2 === 'saved') {
					notificationService.info(workspaceS.savedAgents);
					await loadAgents();
				}
			}
			return;
		}
		if (result === 'too_large') {
			notificationService.warn(workspaceS.fileExceedsBytes(MAX_VIBE_RULES_FORM_BYTES));
			return;
		}
		notificationService.info(workspaceS.savedAgents);
		await loadAgents();
	};

	const saveGoals = async () => {
		if (!rootUri) { return; }
		const result = await forms.saveGoals(rootUri, goalsText, goalsRev);
		if (result === 'conflict') {
			if (await reloadIfConflict()) { await loadGoals(); }
			else if (window.confirm(workspaceS.overwriteDisk)) {
				const fresh = await forms.loadGoals(rootUri);
				const r2 = await forms.saveGoals(rootUri, goalsText, fresh.revision);
				if (r2 === 'saved') {
					notificationService.info(workspaceS.savedGoals);
					await loadGoals();
				}
			}
			return;
		}
		if (result === 'too_large') {
			notificationService.warn(workspaceS.fileExceedsBytes(MAX_VIBE_RULES_FORM_BYTES));
			return;
		}
		notificationService.info(workspaceS.savedGoals);
		await loadGoals();
	};

	const insertGoalsExampleClick = () => {
		const t = goalsText.trim();
		if (t !== '' && !window.confirm(workspaceS.insertGoalsExampleConfirm)) {
			return;
		}
		setGoalsText(VIBE_GOALS_FORM_EXAMPLE);
		setGoalsDirty(true);
	};

	// --- Prompts ---
	const [prompts, setPrompts] = useState<VibeWorkspacePromptListItem[]>([]);
	const [selPromptName, setSelPromptName] = useState<string | null>(null);
	const [promptBody, setPromptBody] = useState('');
	const [promptRev, setPromptRev] = useState<string | undefined>(undefined);
	const [promptNameEdit, setPromptNameEdit] = useState('');
	const [promptDirty, setPromptDirty] = useState(false);
	const [promptTooLarge, setPromptTooLarge] = useState(false);

	const reloadPromptList = useCallback(async () => {
		if (!rootUri) { setPrompts([]); return; }
		setPrompts(await forms.listPrompts(rootUri));
	}, [forms, rootUri]);

	useEffect(() => { void reloadPromptList(); }, [reloadPromptList, folderIndex, subTab]);

	const loadPrompt = async (name: string) => {
		if (!rootUri) { return; }
		const r = await forms.loadPrompt(rootUri, name);
		if (!r) { return; }
		setSelPromptName(name);
		setPromptNameEdit(name);
		setPromptTooLarge(!!r.skippedTooLarge);
		setPromptBody(r.skippedTooLarge ? '' : r.content);
		setPromptRev(r.revision);
		setPromptDirty(false);
	};

	const savePrompt = async () => {
		if (!rootUri || !selPromptName) { return; }
		const targetName = promptNameEdit.trim();
		if (!isValidVibeWorkspaceTemplateId(targetName)) {
			notificationService.warn(workspaceS.invalidPromptName);
			return;
		}
		const oldName = selPromptName;

		if (targetName !== oldName) {
			if (prompts.some(p => p.name === targetName)) {
				notificationService.warn(workspaceS.promptExists(targetName));
				return;
			}
			if (!window.confirm(workspaceS.renamePrompt(oldName, targetName))) {
				return;
			}
			const wrote = await forms.savePrompt(rootUri, targetName, promptBody, undefined);
			if (wrote !== 'saved') {
				notificationService.warn(workspaceS.renameFailed(String(wrote)));
				return;
			}
			await forms.deletePrompt(rootUri, oldName);
			notificationService.info(workspaceS.savedPromptAs(targetName));
			await reloadPromptList();
			await loadPrompt(targetName);
			return;
		}

		const res = await forms.savePrompt(rootUri, targetName, promptBody, promptRev);
		if (res === 'conflict') {
			if (await reloadIfConflict() && rootUri) {
				const fresh = await forms.loadPrompt(rootUri, targetName);
				if (fresh) {
					setPromptBody(fresh.content);
					setPromptRev(fresh.revision);
				}
			} else if (window.confirm(workspaceS.overwrite)) {
				const fresh = await forms.loadPrompt(rootUri, targetName);
				await forms.savePrompt(rootUri, targetName, promptBody, fresh?.revision);
			}
			return;
		}
		if (res === 'too_large') {
			notificationService.warn(workspaceS.templateExceedsBytes(MAX_VIBE_RULES_FORM_BYTES));
			return;
		}
		notificationService.info(workspaceS.savedPrompt(targetName));
		await reloadPromptList();
		await loadPrompt(targetName);
	};

	const addPrompt = async () => {
		if (!rootUri) { return; }
		let n = 'new-prompt';
		let i = 0;
		while (prompts.some(p => p.name === n)) {
			i++;
			n = `new-prompt-${i}`;
		}
		const result = await forms.savePrompt(rootUri, n, '# My prompt\n\n', undefined);
		if (result !== 'saved') {
			notificationService.warn(workspaceS.createPromptFailed(String(result)));
			return;
		}
		await reloadPromptList();
		await loadPrompt(n);
	};

	const dupPrompt = async () => {
		if (!rootUri || !selPromptName) { return; }
		let n = `${selPromptName}-copy`;
		let i = 0;
		while (prompts.some(p => p.name === n)) {
			i++;
			n = `${selPromptName}-copy-${i}`;
		}
		const d = await forms.duplicatePrompt(rootUri, selPromptName, n);
		if (d !== 'duplicated') {
			notificationService.warn(workspaceS.dupFailed(String(d)));
			return;
		}
		await reloadPromptList();
		await loadPrompt(n);
	};

	const delPrompt = async () => {
		if (!rootUri || !selPromptName || !window.confirm(workspaceS.deletePrompt(selPromptName))) { return; }
		await forms.deletePrompt(rootUri, selPromptName);
		await reloadPromptList();
		setSelPromptName(null);
		setPromptNameEdit('');
		setPromptBody('');
		setPromptRev(undefined);
	};

	// --- Workflows (.vibe/workflows/*.json) ---
	const [workflows, setWorkflows] = useState<VibeWorkspaceWorkflowListItem[]>([]);
	const [selWorkflowName, setSelWorkflowName] = useState<string | null>(null);
	const [workflowBody, setWorkflowBody] = useState('');
	const [workflowRev, setWorkflowRev] = useState<string | undefined>(undefined);
	const [workflowNameEdit, setWorkflowNameEdit] = useState('');
	const [workflowDirty, setWorkflowDirty] = useState(false);
	const [workflowTooLarge, setWorkflowTooLarge] = useState(false);

	const reloadWorkflowList = useCallback(async () => {
		if (!rootUri) {
			setWorkflows([]);
			return;
		}
		setWorkflows(await forms.listWorkflows(rootUri));
	}, [forms, rootUri]);

	useEffect(() => {
		if (subTab === 'workflows') {
			void reloadWorkflowList();
		}
	}, [reloadWorkflowList, folderIndex, subTab]);

	const loadWorkflowRow = async (name: string) => {
		if (!rootUri) {
			return;
		}
		const r = await forms.loadWorkflow(rootUri, name);
		if (!r) {
			return;
		}
		setSelWorkflowName(name);
		setWorkflowNameEdit(name);
		setWorkflowTooLarge(!!r.skippedTooLarge);
		setWorkflowBody(r.skippedTooLarge ? '' : r.content);
		setWorkflowRev(r.revision);
		setWorkflowDirty(false);
	};

	const saveWorkflowRow = async () => {
		if (!rootUri || !selWorkflowName) {
			return;
		}
		let parsedOk = false;
		try {
			JSON.parse(workflowBody);
			parsedOk = true;
		} catch {
			parsedOk = false;
		}
		if (!parsedOk) {
			notificationService.warn(workspaceS.invalidWorkflowJson);
			return;
		}

		const targetName = workflowNameEdit.trim();
		if (!isValidVibeWorkspaceTemplateId(targetName)) {
			notificationService.warn(workspaceS.invalidPromptName);
			return;
		}
		const oldName = selWorkflowName;

		if (targetName !== oldName) {
			if (workflows.some(w => w.name === targetName)) {
				notificationService.warn(workspaceS.workflowExists(targetName));
				return;
			}
			if (!window.confirm(workspaceS.renameWorkflowConfirm(oldName, targetName))) {
				return;
			}
			const wrote = await forms.saveWorkflow(rootUri, targetName, workflowBody, undefined);
			if (wrote !== 'saved') {
				notificationService.warn(workspaceS.renameFailed(String(wrote)));
				return;
			}
			await forms.deleteWorkflow(rootUri, oldName);
			notificationService.info(workspaceS.savedWorkflow(targetName));
			await reloadWorkflowList();
			await loadWorkflowRow(targetName);
			return;
		}

		const res = await forms.saveWorkflow(rootUri, targetName, workflowBody, workflowRev);
		if (res === 'conflict') {
			if (await reloadIfConflict() && rootUri) {
				const fresh = await forms.loadWorkflow(rootUri, targetName);
				if (fresh) {
					setWorkflowBody(fresh.content);
					setWorkflowRev(fresh.revision);
				}
			} else if (window.confirm(workspaceS.overwrite)) {
				const fresh = await forms.loadWorkflow(rootUri, targetName);
				await forms.saveWorkflow(rootUri, targetName, workflowBody, fresh?.revision);
			}
			return;
		}
		if (res === 'too_large') {
			notificationService.warn(workspaceS.templateExceedsBytes(MAX_VIBE_RULES_FORM_BYTES));
			return;
		}
		notificationService.info(workspaceS.savedWorkflow(targetName));
		await reloadWorkflowList();
		await loadWorkflowRow(targetName);
	};

	const addWorkflow = async () => {
		if (!rootUri) {
			return;
		}
		let n = 'new-workflow';
		let i = 0;
		while (workflows.some(w => w.name === n)) {
			i++;
			n = `new-workflow-${i}`;
		}
		const result = await forms.saveWorkflow(rootUri, n, newWorkflowTemplateJson(n), undefined);
		if (result !== 'saved') {
			notificationService.warn(workspaceS.createWorkflowFailed(String(result)));
			return;
		}
		await reloadWorkflowList();
		await loadWorkflowRow(n);
	};

	const dupWorkflow = async () => {
		if (!rootUri || !selWorkflowName) {
			return;
		}
		let n = `${selWorkflowName}-copy`;
		let i = 0;
		while (workflows.some(w => w.name === n)) {
			i++;
			n = `${selWorkflowName}-copy-${i}`;
		}
		const d = await forms.duplicateWorkflow(rootUri, selWorkflowName, n);
		if (d !== 'duplicated') {
			notificationService.warn(workspaceS.dupFailed(String(d)));
			return;
		}
		await reloadWorkflowList();
		await loadWorkflowRow(n);
	};

	const delWorkflow = async () => {
		if (!rootUri || !selWorkflowName || !window.confirm(workspaceS.deleteWorkflowConfirm(selWorkflowName))) {
			return;
		}
		await forms.deleteWorkflow(rootUri, selWorkflowName);
		await reloadWorkflowList();
		setSelWorkflowName(null);
		setWorkflowNameEdit('');
		setWorkflowBody('');
		setWorkflowRev(undefined);
	};

	// --- Skills ---
	const [skills, setSkills] = useState<VibeWorkspaceSkillListItem[]>([]);
	const [selSkillFolder, setSelSkillFolder] = useState<string | null>(null);
	const [skillNameF, setSkillNameF] = useState('');
	const [skillDescF, setSkillDescF] = useState('');
	const [skillBodyF, setSkillBodyF] = useState('');
	const [skillRev, setSkillRev] = useState<string | undefined>(undefined);
	const [skillDirty, setSkillDirty] = useState(false);
	const [newSkillFolderId, setNewSkillFolderId] = useState('my-skill');

	const reloadSkills = useCallback(async () => {
		if (!rootUri) { setSkills([]); return; }
		setSkills(await forms.listSkills(rootUri));
	}, [forms, rootUri]);

	useEffect(() => {
		if (subTab === 'skills') {
			void reloadSkills();
		}
	}, [reloadSkills, folderIndex, subTab]);

	const [skillTooLarge, setSkillTooLarge] = useState(false);

	const populateSkillFieldsFromRaw = (folderId: string, raw: string, revision: string | undefined, skippedLarge: boolean) => {
		setSelSkillFolder(folderId);
		setSkillTooLarge(skippedLarge);
		if (skippedLarge) {
			setSkillNameF(folderId);
			setSkillDescF('');
			setSkillBodyF('');
			setSkillRev(revision);
			setSkillDirty(false);
			return;
		}
		const rel = `.vibe/skills/${folderId}/SKILL.md`;
		const parsed = parseSkillMarkdown(raw, rel, folderId);
		setSkillNameF(parsed?.skillId ?? folderId);
		setSkillDescF(parsed?.description ?? '');
		setSkillBodyF(parsed?.body ?? raw);
		setSkillRev(revision);
		setSkillDirty(false);
	};

	const loadSkillRow = async (folderId: string) => {
		if (!rootUri) { return; }
		const r = await forms.loadSkill(rootUri, folderId);
		if (!r) { return; }
		populateSkillFieldsFromRaw(folderId, r.content, r.revision, !!r.skippedTooLarge);
	};

	const saveSkillRow = async () => {
		if (!rootUri || !selSkillFolder) { return; }
		const res = await forms.saveSkill(rootUri, selSkillFolder, skillNameF, skillDescF, skillBodyF, skillRev);
		if (res === 'conflict') {
			if (await reloadIfConflict()) { await loadSkillRow(selSkillFolder); }
			else if (window.confirm(workspaceS.overwrite)) {
				const fresh = await forms.loadSkill(rootUri, selSkillFolder);
				await forms.saveSkill(rootUri, selSkillFolder, skillNameF, skillDescF, skillBodyF, fresh?.revision);
			}
			return;
		}
		if (res === 'too_large') {
			notificationService.warn(workspaceS.skillTooLarge);
			return;
		}
		const sid = selSkillFolder;
		notificationService.info(workspaceS.savedSkill);
		await reloadSkills();
		await loadSkillRow(sid);
	};

	const createSkill = async () => {
		if (!rootUri) { return; }
		const fid = newSkillFolderId.trim();
		if (!isValidVibeWorkspaceTemplateId(fid)) {
			notificationService.warn(workspaceS.invalidFolderId);
			return;
		}
		const cr = await forms.createSkill(rootUri, fid, fid, `Skill ${fid}`, 'Write skill instructions here.\n');
		if (cr !== 'created') {
			notificationService.warn(workspaceS.folderExists);
			return;
		}
		await reloadSkills();
		await loadSkillRow(fid);
	};

	const deleteSkillFolder = async () => {
		if (!rootUri || !selSkillFolder || !window.confirm(workspaceS.deleteSkillFolder(selSkillFolder))) { return; }
		await forms.deleteSkill(rootUri, selSkillFolder);
		await reloadSkills();
		setSelSkillFolder(null);
		setSkillNameF('');
		setSkillDescF('');
		setSkillBodyF('');
	};

	// --- Workspace root `.json` listing (pill tabs) & structure tree ---
	const [rootListing, setRootListing] = useState<VibeWorkspaceRootFileListItem[]>([]);

	const reloadRootListing = useCallback(async () => {
		if (!rootUri) {
			setRootListing([]);
			return;
		}
		setRootListing(await forms.listVibeRootFiles(rootUri));
	}, [forms, rootUri]);

	useEffect(() => {
		if (workspaceAuxView !== 'forms' || !rootUri) {
			return;
		}
		void reloadRootListing();
	}, [workspaceAuxView, folderIndex, reloadRootListing, rootUri]);

	const jsonBasenamesSorted = useMemo(
		() =>
			rootListing
				.filter(f => f.name.toLowerCase().endsWith('.json'))
				.map(f => f.name)
				.sort((a, b) => a.localeCompare(b)),
		[rootListing],
	);

	// Split editable vs runtime-managed files. Runtime files (dot-prefix: `.window-lock.json`,
	// `.session-state.json`, …) are pinned/heartbeat/state — editing them by hand corrupts
	// IDE state. Rendered in a separate read-only block with explicit warning.
	const editableJsonBasenames = useMemo(
		() => jsonBasenamesSorted.filter(n => !n.startsWith('.')),
		[jsonBasenamesSorted],
	);
	const runtimeJsonBasenames = useMemo(
		() => jsonBasenamesSorted.filter(n => n.startsWith('.')),
		[jsonBasenamesSorted],
	);

	useEffect(() => {
		if (!isRjTab(subTab)) {
			return;
		}
		const name = rjBasenameFromTab(subTab);
		if (!jsonBasenamesSorted.includes(name)) {
			setSubTab('rules');
		}
	}, [jsonBasenamesSorted, subTab]);

	// --- `.vibe/` tree + raw edit (nested paths)
	const [vibeTree, setVibeTree] = useState<VibeWorkspaceTreeNode[]>([]);
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
	const [selStructureRel, setSelStructureRel] = useState<string | null>(null);
	const [structureText, setStructureText] = useState('');
	const [structureRev, setStructureRev] = useState<string | undefined>(undefined);
	const [structureDirty, setStructureDirty] = useState(false);
	const [structureTooLarge, setStructureTooLarge] = useState(false);

	const reloadStructureTree = useCallback(async () => {
		if (!rootUri) {
			setVibeTree([]);
			return;
		}
		setVibeTree(await forms.listVibeTree(rootUri));
	}, [forms, rootUri]);

	useEffect(() => {
		if (subTab !== 'vibeStructure') {
			return;
		}
		void reloadStructureTree();
	}, [reloadStructureTree, folderIndex, subTab]);

	useEffect(() => {
		if (subTab !== 'vibeStructure' || !vibeTree.length) {
			return undefined;
		}
		let cancelled = false;
		const t = window.setTimeout(() => {
			if (cancelled) {
				return;
			}
			setExpandedDirs(prev => {
				const n = new Set(prev);
				let changed = false;
				for (const ch of vibeTree) {
					if (ch.kind === 'dir' && !n.has(ch.relativePath)) {
						n.add(ch.relativePath);
						changed = true;
					}
				}
				return changed ? n : prev;
			});
		}, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(t);
		};
	}, [vibeTree, subTab]);

	const toggleExpandDir = (rel: string) => {
		setExpandedDirs(prev => {
			const next = new Set(prev);
			if (next.has(rel)) {
				next.delete(rel);
			} else {
				next.add(rel);
			}
			return next;
		});
	};

	const loadStructureFileRow = useCallback(async (relativePath: string) => {
		if (!rootUri) {
			return;
		}
		const r = await forms.loadVibeRelativeFile(rootUri, relativePath);
		if (!r) {
			return;
		}
		setSelStructureRel(relativePath);
		setStructureTooLarge(!!r.skippedTooLarge);
		setStructureText(r.skippedTooLarge ? '' : r.content);
		setStructureRev(r.revision);
		setStructureDirty(false);
	}, [forms, rootUri]);

	const saveStructureFileRow = async () => {
		if (!rootUri || !selStructureRel) {
			return;
		}
		const rel = selStructureRel;
		const res = await forms.saveVibeRelativeFile(rootUri, rel, structureText, structureRev);
		if (res === 'conflict') {
			if (await reloadIfConflict()) {
				await loadStructureFileRow(rel);
			} else if (window.confirm(workspaceS.overwriteDisk)) {
				const fresh = await forms.loadVibeRelativeFile(rootUri, rel);
				const r2 = await forms.saveVibeRelativeFile(rootUri, rel, structureText, fresh?.revision);
				if (r2 === 'saved') {
					notificationService.info(workspaceS.savedVibeRelative(rel));
					await reloadStructureTree();
					await reloadRootListing();
					await loadStructureFileRow(rel);
				}
			}
			return;
		}
		if (res === 'too_large') {
			notificationService.warn(workspaceS.fileExceedsBytes(MAX_VIBE_RULES_FORM_BYTES));
			return;
		}
		notificationService.info(workspaceS.savedVibeRelative(rel));
		await reloadStructureTree();
		await reloadRootListing();
		await loadStructureFileRow(rel);
	};

	// --- Root JSON pills (constraints, allowed-models, …)
	const selRootJsonName = isRjTab(subTab) ? rjBasenameFromTab(subTab) : null;
	const [rootJsonText, setRootJsonText] = useState('');
	const [rootJsonRev, setRootJsonRev] = useState<string | undefined>(undefined);
	const [rootJsonDirty, setRootJsonDirty] = useState(false);
	const [rootJsonTooLarge, setRootJsonTooLarge] = useState(false);

	const loadRootJsonRow = useCallback(async (basename: string) => {
		if (!rootUri) {
			return;
		}
		const r = await forms.loadVibeRootFile(rootUri, basename);
		if (!r) {
			return;
		}
		setRootJsonTooLarge(!!r.skippedTooLarge);
		setRootJsonText(r.skippedTooLarge ? '' : r.content);
		setRootJsonRev(r.revision);
		setRootJsonDirty(false);
	}, [forms, rootUri]);

	useEffect(() => {
		if (!rootUri || !isRjTab(subTab)) {
			return;
		}
		void loadRootJsonRow(rjBasenameFromTab(subTab));
	}, [folderIndex, loadRootJsonRow, rootUri, subTab]);

	const saveRootJsonRow = async () => {
		if (!rootUri || !selRootJsonName) {
			return;
		}
		const name = selRootJsonName;
		const res = await forms.saveVibeRootFile(rootUri, name, rootJsonText, rootJsonRev);
		if (res === 'conflict') {
			if (await reloadIfConflict()) {
				await loadRootJsonRow(name);
			} else if (window.confirm(workspaceS.overwriteDisk)) {
				const fresh = await forms.loadVibeRootFile(rootUri, name);
				const r2 = await forms.saveVibeRootFile(rootUri, name, rootJsonText, fresh?.revision);
				if (r2 === 'saved') {
					notificationService.info(workspaceS.savedVibeRelative(name));
					await reloadRootListing();
					await loadRootJsonRow(name);
				}
			}
			return;
		}
		if (res === 'too_large') {
			notificationService.warn(workspaceS.fileExceedsBytes(MAX_VIBE_RULES_FORM_BYTES));
			return;
		}
		notificationService.info(workspaceS.savedVibeRelative(name));
		await reloadRootListing();
		await loadRootJsonRow(name);
	};

	const insertRootJsonExampleClick = () => {
		if (!selRootJsonName) {
			return;
		}
		const snippet = rootJsonExampleSnippet(selRootJsonName);
		const t = rootJsonText.trim();
		if (t !== '' && !window.confirm(workspaceS.insertRootJsonExampleConfirm)) {
			return;
		}
		setRootJsonText(snippet);
		setRootJsonDirty(true);
	};

	const folderBasename = useMemo(() => rootUri ? (rootUri.path.split(/[/\\]/).filter(Boolean).pop() ?? rootUri.fsPath) : '', [rootUri]);

	const paneDirty =
		rulesDirty ||
		agentsDirty ||
		goalsDirty ||
		promptDirty ||
		workflowDirty ||
		skillDirty ||
		structureDirty ||
		rootJsonDirty;

	const trySwitchSubTab = (next: WorkspaceFormsSubTab) => {
		if (paneDirty && !window.confirm(workspaceS.discardDirty)) {
			return;
		}
		setSubTab(next);
	};

	const goToReadmeView = () => {
		if (paneDirty && !window.confirm(workspaceS.unsavedReadme)) {
			return;
		}
		setWorkspaceAuxView('readme');
	};

	const backToMainForms = () => {
		setWorkspaceAuxView('forms');
	};

	if (!folders.length) {
		return (
			<div className='text-sm text-vibe-fg-3 py-8'>
				<p className='mb-2'>{workspaceS.noFolder}</p>
				<p className='text-xs'>{workspaceS.openFolderHint}</p>
			</div>
		);
	}

	if (workspaceAuxView === 'readme' && rootUri) {
		return (
			<VibeWorkspaceReadmeForm rootUri={rootUri} onBackToForms={backToMainForms} />
		);
	}

	const mainWorkspacePills: { id: Exclude<MainWorkspaceSubtab, 'vibeStructure'>; label: string }[] = [
		{ id: 'rules', label: workspaceS.pillRules },
		{ id: 'agents', label: workspaceS.pillAgents },
		{ id: 'goals', label: workspaceS.pillGoals },
		{ id: 'prompts', label: workspaceS.pillPrompts },
		{ id: 'workflows', label: workspaceS.pillWorkflows },
		{ id: 'skills', label: workspaceS.pillSkills },
		{ id: 'projectCommands', label: workspaceS.pillProjectCommands },
	];

	return (
		<div className='flex flex-col gap-6 max-w-3xl'>
			<p className='text-xs text-vibe-fg-3'>
				{workspaceS.editingFolder} <span className='text-vibe-fg-2 font-medium'>{folderBasename}</span>
				{folders.length > 1 ? (
					<select
						className='ml-2 text-xs @@vibe-chat-like-control px-2 py-0.5'
						value={folderIndex}
						onChange={(e) => {
							if (paneDirty && !window.confirm(workspaceS.switchFolder)) { return; }
							setFolderIndex(Number(e.target.value));
							setWorkspaceAuxView('forms');
						}}
					>
						{folders.map((f, i) => (
							<option key={f.uri.toString()} value={i}>{f.name || f.uri.fsPath}</option>
						))}
					</select>
				) : null}
			</p>

			<div className='flex flex-col gap-2 items-stretch'>
				<div className='flex flex-wrap gap-2 items-center'>
					<button
						type='button'
						className='@@vibe-pill-button text-xs px-2 py-1 border border-vibe-border-1'
						onClick={() => goToReadmeView()}
						title={workspaceS.readmeTitle}
					>
						{workspaceS.readmeBtn}
					</button>
					<button
						type='button'
						className={`@@vibe-pill-button text-xs px-2 py-1 ${subTab === 'vibeStructure' ? '@@vibe-pill-button--active' : ''}`}
						onClick={() => trySwitchSubTab('vibeStructure')}
						title={workspaceS.vibeStructureHint}
					>
						{workspaceS.vibeStructureTab}
					</button>
				</div>
				<div className='flex flex-wrap gap-2 items-center'>
					{mainWorkspacePills.map(t => (
						<button
							key={t.id}
							type='button'
							className={`@@vibe-pill-button text-xs px-2 py-1 ${subTab === t.id ? '@@vibe-pill-button--active' : ''}`}
							onClick={() => trySwitchSubTab(t.id)}
						>{t.label}</button>
					))}
				</div>
				{editableJsonBasenames.length ? (
					<div className='flex flex-wrap gap-2 items-center'>
						{editableJsonBasenames.map(jn => {
							const id = `${RJ_JSON_TAB}${jn}` satisfies WorkspaceFormsSubTab;
							return (
								<button
									key={jn}
									type='button'
									className={`@@vibe-pill-button text-xs px-2 py-1 font-mono ${subTab === id ? '@@vibe-pill-button--active' : ''}`}
									onClick={() => trySwitchSubTab(id)}
								>
									{jn}
								</button>
							);
						})}
					</div>
				) : null}
				{runtimeJsonBasenames.length ? (
					<div className='flex flex-wrap gap-2 items-center pt-1 border-t border-vibe-border-1 mt-1'>
						<span className='text-[10px] text-vibe-fg-3 uppercase tracking-wide mr-1'>{workspaceS.runtimeJsonGroupLabel}</span>
						{runtimeJsonBasenames.map(jn => {
							const id = `${RJ_JSON_TAB}${jn}` satisfies WorkspaceFormsSubTab;
							return (
								<button
									key={jn}
									type='button'
									title={workspaceS.runtimeJsonTooltip}
									className={`@@vibe-pill-button text-xs px-2 py-1 font-mono opacity-70 ${subTab === id ? '@@vibe-pill-button--active' : ''}`}
									onClick={() => trySwitchSubTab(id)}
								>
									{jn}
								</button>
							);
						})}
					</div>
				) : null}
			</div>

			{subTab === 'rules' && (
				<div className='flex flex-col gap-2'>
					<p className='text-xs text-vibe-fg-3'>{workspaceS.rulesHint(MAX_VIBE_RULES_FORM_BYTES / 1024)}</p>
					{rulesTooLarge ? <p className='text-xs text-amber-500'>{workspaceS.rulesTooLarge}</p> : null}
					<textarea
						className='@@vibe-chat-like-control w-full min-h-[220px] text-xs font-mono p-2 text-vibe-fg-2'
						value={rulesText}
						disabled={rulesTooLarge}
						onChange={(e) => { setRulesText(e.target.value); setRulesDirty(true); }}
					/>
					<div className='flex gap-2 flex-wrap'>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void saveRules(); }} disabled={rulesTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
						<button type='button' className='text-xs text-vibe-fg-3 hover:brightness-110' onClick={() => { void loadRules(); }}>{workspaceS.revert}</button>
						<button
							type='button'
							className='text-xs text-vibe-fg-3 hover:brightness-110'
							onClick={() => rootUri && void commandService.executeCommand('vscode.open', joinPath(rootUri, '.vibe', 'rules.md'))}
						>{workspaceS.openEditor}</button>
					</div>
				</div>
			)}

			{subTab === 'agents' && (
				<div className='flex flex-col gap-2'>
					<p className='text-xs text-vibe-fg-3'>{workspaceS.agentsHint}</p>
					{agentsTooLarge ? <p className='text-xs text-amber-500'>{workspaceS.agentsTooLarge}</p> : null}
					<textarea
						className='@@vibe-chat-like-control w-full min-h-[220px] text-xs font-mono p-2 text-vibe-fg-2'
						value={agentsText}
						disabled={agentsTooLarge}
						onChange={(e) => { setAgentsText(e.target.value); setAgentsDirty(true); }}
					/>
					<div className='flex gap-2 flex-wrap'>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void saveAgents(); }} disabled={agentsTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
						<button type='button' className='text-xs text-vibe-fg-3 hover:brightness-110' onClick={() => { void loadAgents(); }}>{workspaceS.revert}</button>
						<button
							type='button'
							className='text-xs text-vibe-fg-3 hover:brightness-110'
							onClick={() => rootUri && void commandService.executeCommand('vscode.open', joinPath(rootUri, 'AGENTS.md'))}
						>{workspaceS.openEditor}</button>
					</div>
				</div>
			)}

			{subTab === 'goals' && (
				<div className='flex flex-col gap-2'>
					<p className='text-xs text-vibe-fg-3'>{workspaceS.goalsHint}</p>
					<details className='text-xs text-vibe-fg-3 @@vibe-chat-like-shell px-2 py-1'>
						<summary className='cursor-pointer text-vibe-fg-2 select-none'>{workspaceS.exampleSkeletonMarkup}</summary>
						<pre className='mt-2 max-h-40 overflow-auto font-mono text-[11px] text-vibe-fg-3 whitespace-pre-wrap border-t border-vibe-border-1 pt-2'>{VIBE_GOALS_FORM_EXAMPLE}</pre>
					</details>
					<button type='button' className='text-xs text-vibe-fg-3 border border-vibe-border-1 rounded px-2 py-1 self-start' onClick={insertGoalsExampleClick}>
						{workspaceS.insertGoalsExample}
					</button>
					{goalsTooLarge ? <p className='text-xs text-amber-500'>{workspaceS.goalsTooLarge}</p> : null}
					<textarea
						className='@@vibe-chat-like-control w-full min-h-[220px] text-xs font-mono p-2 text-vibe-fg-2'
						value={goalsText}
						disabled={goalsTooLarge}
						onChange={(e) => { setGoalsText(e.target.value); setGoalsDirty(true); }}
						spellCheck={false}
					/>
					<div className='flex gap-2 flex-wrap'>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void saveGoals(); }} disabled={goalsTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
						<button type='button' className='text-xs text-vibe-fg-3 hover:brightness-110' onClick={() => { void loadGoals(); }}>{workspaceS.revert}</button>
						<button
							type='button'
							className='text-xs text-vibe-fg-3 hover:brightness-110'
							onClick={() => rootUri && void commandService.executeCommand('vscode.open', joinPath(rootUri, '.vibe', 'goals.md'))}
						>{workspaceS.openEditor}</button>
					</div>
				</div>
			)}

			{subTab === 'prompts' && (
				<div className='flex flex-col gap-3'>
					<p className='text-xs text-vibe-fg-3'>{workspaceS.promptsHint}</p>
					<div className='flex gap-2 flex-wrap'>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void addPrompt(); }}>{workspaceS.addPrompt}</VibeButtonBgDarken>
						<button type='button' className='text-xs text-vibe-fg-3 border border-vibe-border-1 rounded px-2 py-1' onClick={() => { void dupPrompt(); }} disabled={!selPromptName}>{workspaceS.duplicate}</button>
						<button type='button' className='text-xs text-red-400 border border-vibe-border-1 rounded px-2 py-1' onClick={() => { void delPrompt(); }} disabled={!selPromptName}>{workspaceS.delete}</button>
					</div>
					<div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
						<div className='@@vibe-chat-like-shell p-2 max-h-56 overflow-y-auto text-xs'>
							{prompts.length === 0 ? <span className='text-vibe-fg-4'>{workspaceS.noPrompts}</span> : prompts.map(p => (
								<button
									key={p.name}
									type='button'
									className={`block w-full text-left px-1 py-1 rounded ${selPromptName === p.name ? 'bg-vibe-bg-2' : 'hover:bg-vibe-bg-1'}`}
									onClick={() => { void loadPrompt(p.name); }}
								>
									<div className='font-medium text-vibe-fg-2'>{p.name}</div>
									<div className='text-vibe-fg-4 truncate'>{p.preview || '—'}</div>
									{p.variables.length ? <div className='text-vibe-fg-4 text-[10px]'>{p.variables.map(v => `$${v}`).join(' ')}</div> : null}
								</button>
							))}
						</div>
						<div className='md:col-span-2 flex flex-col gap-2'>
							{selPromptName ? (
								<>
									<label className='text-xs text-vibe-fg-3'>{workspaceS.templateName}</label>
									<input
										className='@@vibe-chat-like-control text-xs font-mono px-2 py-1 text-vibe-fg-2'
										value={promptNameEdit}
										onChange={(e) => { setPromptNameEdit(e.target.value); setPromptDirty(true); }}
									/>
									{promptTooLarge ? <p className='text-xs text-amber-500'>{workspaceS.promptTooLarge}</p> : null}
									<textarea
										className='@@vibe-chat-like-control w-full min-h-[200px] text-xs font-mono p-2 text-vibe-fg-2'
										value={promptBody}
										disabled={promptTooLarge}
										onChange={(e) => { setPromptBody(e.target.value); setPromptDirty(true); }}
									/>
									<VibeButtonBgDarken className='px-3 py-1 text-xs self-start' onClick={() => { void savePrompt(); }} disabled={promptTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
								</>
							) : <span className='text-xs text-vibe-fg-4'>{workspaceS.selectPrompt}</span>}
						</div>
					</div>
				</div>
			)}

			{subTab === 'workflows' && (
				<div className='flex flex-col gap-3'>
					<p className='text-xs text-vibe-fg-3'>{workspaceS.workflowsHint}</p>
					<div className='flex gap-2 flex-wrap'>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void addWorkflow(); }}>{workspaceS.addWorkflow}</VibeButtonBgDarken>
						<button type='button' className='text-xs text-vibe-fg-3 border border-vibe-border-1 rounded px-2 py-1' onClick={() => { void dupWorkflow(); }} disabled={!selWorkflowName}>{workspaceS.duplicate}</button>
						<button type='button' className='text-xs text-red-400 border border-vibe-border-1 rounded px-2 py-1' onClick={() => { void delWorkflow(); }} disabled={!selWorkflowName}>{workspaceS.delete}</button>
					</div>
					<div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
						<div className='@@vibe-chat-like-shell p-2 max-h-56 overflow-y-auto text-xs'>
							{workflows.length === 0 ? <span className='text-vibe-fg-4'>{workspaceS.noWorkflows}</span> : workflows.map(w => (
								<button
									key={w.name}
									type='button'
									className={`block w-full text-left px-1 py-1 rounded ${selWorkflowName === w.name ? 'bg-vibe-bg-2' : 'hover:bg-vibe-bg-1'}`}
									onClick={() => { void loadWorkflowRow(w.name); }}
								>
									<div className='font-medium text-vibe-fg-2 font-mono'>{w.name}</div>
									<div className='text-vibe-fg-4 truncate'>{w.preview || '—'}</div>
									<div className='text-vibe-fg-4 text-[10px]'>{workspaceS.workflowStepCount(w.stepCount)}</div>
								</button>
							))}
						</div>
						<div className='md:col-span-2 flex flex-col gap-2'>
							{selWorkflowName ? (
								<>
									<label className='text-xs text-vibe-fg-3'>{workspaceS.workflowFileId}</label>
									<input
										className='@@vibe-chat-like-control text-xs font-mono px-2 py-1 text-vibe-fg-2'
										value={workflowNameEdit}
										onChange={(e) => { setWorkflowNameEdit(e.target.value); setWorkflowDirty(true); }}
									/>
									{workflowTooLarge ? <p className='text-xs text-amber-500'>{workspaceS.promptTooLarge}</p> : null}
									<textarea
										className='@@vibe-chat-like-control w-full min-h-[220px] text-xs font-mono p-2 text-vibe-fg-2'
										value={workflowBody}
										disabled={workflowTooLarge}
										onChange={(e) => { setWorkflowBody(e.target.value); setWorkflowDirty(true); }}
										spellCheck={false}
									/>
									<div className='flex gap-2 flex-wrap'>
										<VibeButtonBgDarken className='px-3 py-1 text-xs self-start' onClick={() => { void saveWorkflowRow(); }} disabled={workflowTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
										<button type='button' className='text-xs text-vibe-fg-3 hover:brightness-110' onClick={() => rootUri && void commandService.executeCommand('vscode.open', joinPath(rootUri, '.vibe', 'workflows', `${selWorkflowName}.json`))}>{workspaceS.openEditor}</button>
									</div>
								</>
							) : <span className='text-xs text-vibe-fg-4'>{workspaceS.selectWorkflow}</span>}
						</div>
					</div>
				</div>
			)}

			{subTab === 'skills' && (
				<div className='flex flex-col gap-3'>
					<p className='text-xs text-vibe-fg-3'>
						{workspaceS.skillsHintLine1Prefix}<code className='text-vibe-fg-2'>.vibe/skills/</code>{workspaceS.skillsHintLine1Mid}<code className='text-vibe-fg-2'>SKILL.md</code>{workspaceS.skillsHintLine1Suffix}
						{workspaceS.skillsHintLine2Prefix}<code className='text-vibe-fg-2'>name</code>{workspaceS.skillsHintLine2Mid}<code className='text-vibe-fg-2'>/skill:</code>{workspaceS.skillsHintLine2Suffix}
					</p>
					<div className='flex flex-wrap gap-2 items-end'>
						<div className='flex flex-col gap-1'>
							<span className='text-xs text-vibe-fg-3'>{workspaceS.newFolderId}</span>
							<input className='@@vibe-chat-like-control text-xs font-mono px-2 py-1' value={newSkillFolderId} onChange={e => setNewSkillFolderId(e.target.value)} />
						</div>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void createSkill(); }}>{workspaceS.createSkill}</VibeButtonBgDarken>
					</div>
					<div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
						<div className='@@vibe-chat-like-shell p-2 max-h-56 overflow-y-auto text-xs'>
							{skills.length === 0 ? <span className='text-vibe-fg-4'>{workspaceS.noSkills}</span> : skills.map(s => (
								<button
									key={s.folderId}
									type='button'
									className={`block w-full text-left px-1 py-1 rounded ${selSkillFolder === s.folderId ? 'bg-vibe-bg-2' : 'hover:bg-vibe-bg-1'}`}
									onClick={() => { void loadSkillRow(s.folderId); }}
								>
									<div className='font-medium text-vibe-fg-2'>{s.folderId}</div>
									<div className='text-vibe-fg-3'>{s.skillId}</div>
									<div className='text-vibe-fg-4 truncate'>{s.description}</div>
								</button>
							))}
						</div>
						<div className='md:col-span-2 flex flex-col gap-2'>
							{selSkillFolder ? (
								<>
									<label className='text-xs text-vibe-fg-3'>{workspaceS.folderFixed}</label>
									<input className='@@vibe-chat-like-control text-xs font-mono px-2 py-1 opacity-80' readOnly value={selSkillFolder} />
									<label className='text-xs text-vibe-fg-3'>{workspaceS.skillName}</label>
									<input className='@@vibe-chat-like-control text-xs font-mono px-2 py-1' value={skillNameF} onChange={e => { setSkillNameF(e.target.value); setSkillDirty(true); }} disabled={skillTooLarge} />
									<label className='text-xs text-vibe-fg-3'>{workspaceS.description}</label>
									<input className='@@vibe-chat-like-control text-xs px-2 py-1' value={skillDescF} onChange={e => { setSkillDescF(e.target.value); setSkillDirty(true); }} disabled={skillTooLarge} />
									<label className='text-xs text-vibe-fg-3'>{workspaceS.bodyMd}</label>
									{skillTooLarge ? <p className='text-xs text-amber-500'>{workspaceS.skillTooLargeEditor}</p> : null}
									<textarea
										className='@@vibe-chat-like-control w-full min-h-[180px] text-xs font-mono p-2 text-vibe-fg-2'
										value={skillBodyF}
										disabled={skillTooLarge}
										onChange={e => { setSkillBodyF(e.target.value); setSkillDirty(true); }}
									/>
									<div className='flex gap-2 flex-wrap'>
										<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void saveSkillRow(); }} disabled={skillTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
										<button type='button' className='text-xs text-red-400' onClick={() => { void deleteSkillFolder(); }}>{workspaceS.deleteSkillFolderBtn}</button>
									</div>
								</>
							) : <span className='text-xs text-vibe-fg-4'>{workspaceS.selectOrCreateSkill}</span>}
						</div>
					</div>
				</div>
			)}

			{subTab === 'projectCommands' && (
				<ProjectCommandsPanel openAddTick={pcOpenAddTick} />
			)}

			{subTab === 'vibeStructure' && (
				<div className='flex flex-col gap-3'>
					<p className='text-xs text-vibe-fg-3'>{workspaceS.vibeStructureHint}</p>
					<button
						type='button'
						className='text-xs text-vibe-fg-3 hover:brightness-110 self-start'
						onClick={() => {
							void reloadStructureTree();
							void reloadRootListing();
						}}
					>
						{workspaceS.refreshFileList}
					</button>
					<div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
						<div className='@@vibe-chat-like-shell p-2 max-h-[22rem] overflow-y-auto text-xs'>
							{vibeTree.length === 0 ? (
								<span className='text-vibe-fg-4'>{workspaceS.noVibeTree}</span>
							) : (
								<VibeStructureTree
									nodes={vibeTree}
									depth={0}
									expandedDirs={expandedDirs}
									toggleDir={toggleExpandDir}
									selectedPath={selStructureRel}
									onPickFile={(rel) => { void loadStructureFileRow(rel); }}
								/>
							)}
						</div>
						<div className='md:col-span-2 flex flex-col gap-2'>
							{selStructureRel ? (
								<>
									<p className='text-xs text-vibe-fg-3'><code className='font-mono text-vibe-fg-2'>.vibe/{selStructureRel}</code></p>
									{structureTooLarge ? (
										<p className='text-xs text-amber-500'>{workspaceS.fileExceedsBytes(MAX_VIBE_RULES_FORM_BYTES)}</p>
									) : null}
									<textarea
										className='@@vibe-chat-like-control w-full min-h-[220px] text-xs font-mono p-2 text-vibe-fg-2'
										value={structureText}
										disabled={structureTooLarge}
										onChange={(e) => { setStructureText(e.target.value); setStructureDirty(true); }}
										spellCheck={false}
									/>
									<div className='flex gap-2 flex-wrap'>
										<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void saveStructureFileRow(); }} disabled={structureTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
										<button type='button' className='text-xs text-vibe-fg-3 hover:brightness-110' onClick={() => { void loadStructureFileRow(selStructureRel); }}>{workspaceS.revert}</button>
										<button
											type='button'
											className='text-xs text-vibe-fg-3 hover:brightness-110'
											onClick={() => {
												if (!rootUri || !selStructureRel) { return; }
												let u = joinPath(rootUri, '.vibe');
												for (const seg of selStructureRel.split('/')) {
													u = joinPath(u, seg);
												}
												void commandService.executeCommand('vscode.open', u);
											}}
										>{workspaceS.openEditor}</button>
									</div>
								</>
							) : (
								<span className='text-xs text-vibe-fg-4'>{workspaceS.selectStructureFile}</span>
							)}
						</div>
					</div>
				</div>
			)}

			{isRjTab(subTab) && selRootJsonName ? (
				<div className='flex flex-col gap-2'>
					<p className='text-xs text-vibe-fg-3'>{workspaceS.rootJsonHint(selRootJsonName)}</p>
					{selRootJsonName === 'commands.json' ? (
						<div className='flex flex-wrap gap-2 items-center'>
							<span className='text-[10px] text-vibe-fg-3 uppercase tracking-wide'>{workspaceS.pcJsonActionsLabel}</span>
							<button
								type='button'
								className='text-xs text-vibe-fg-2 border border-vibe-border-1 rounded px-2 py-1 hover:brightness-110'
								title={workspaceS.pcJsonOpenFormTip}
								onClick={() => { setSubTab('projectCommands'); setPcOpenAddTick(t => t + 1); }}
							>{workspaceS.pcJsonOpenForm}</button>
							<button
								type='button'
								className='text-xs text-vibe-fg-3 border border-vibe-border-1 rounded px-2 py-1 hover:brightness-110'
								title={workspaceS.pcJsonOpenTableTip}
								onClick={() => { setSubTab('projectCommands'); }}
							>{workspaceS.pcJsonOpenTable}</button>
							<button
								type='button'
								className='text-xs text-vibe-fg-3 border border-vibe-border-1 rounded px-2 py-1 hover:brightness-110'
								title={workspaceS.pcJsonOpenPaletteTip}
								onClick={() => { void commandService.executeCommand(PROJECT_COMMANDS_PALETTE_IDS.run); }}
							>{workspaceS.pcJsonOpenPalette}</button>
							<button
								type='button'
								className='text-xs text-vibe-fg-3 border border-vibe-border-1 rounded px-2 py-1 hover:brightness-110'
								title={workspaceS.pcJsonReloadTip}
								onClick={() => { void commandService.executeCommand('vibeide.commands.reload'); }}
							>{workspaceS.pcJsonReload}</button>
						</div>
					) : null}
					<details open className='text-xs @@vibe-chat-like-shell px-2 py-1'>
						<summary className='cursor-pointer text-vibe-fg-2 select-none mb-2'>{workspaceS.rootJsonDocFold}</summary>
						<div className='text-xs text-vibe-fg-3 border-t border-vibe-border-1 pt-2 max-h-[22rem] overflow-y-auto prose prose-sm prose-p:my-1 prose-ul:my-1 prose-ul:list-disc prose-ul:pl-4 prose-code:before:content-none prose-code:after:content-none select-text'>
							<ChatMarkdownRender inPTag={true} string={workspaceRootJsonDocMarkdown(selRootJsonName)} chatMessageLocation={undefined} />
						</div>
					</details>
					<details className='text-xs text-vibe-fg-3 @@vibe-chat-like-shell px-2 py-1'>
						<summary className='cursor-pointer text-vibe-fg-2 select-none'>{workspaceS.exampleSkeleton}</summary>
						<pre className='mt-2 max-h-40 overflow-auto font-mono text-[11px] text-vibe-fg-3 whitespace-pre-wrap border-t border-vibe-border-1 pt-2'>{rootJsonExampleSnippet(selRootJsonName)}</pre>
					</details>
					<button type='button' className='text-xs text-vibe-fg-3 border border-vibe-border-1 rounded px-2 py-1 self-start' onClick={insertRootJsonExampleClick}>
						{workspaceS.insertRootJsonExample}
					</button>
					{rootJsonTooLarge ? <p className='text-xs text-amber-500'>{workspaceS.fileExceedsBytes(MAX_VIBE_RULES_FORM_BYTES)}</p> : null}
					<textarea
						className='@@vibe-chat-like-control w-full min-h-[220px] text-xs font-mono p-2 text-vibe-fg-2'
						value={rootJsonText}
						disabled={rootJsonTooLarge}
						onChange={(e) => { setRootJsonText(e.target.value); setRootJsonDirty(true); }}
						spellCheck={false}
					/>
					<div className='flex gap-2 flex-wrap'>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => { void saveRootJsonRow(); }} disabled={rootJsonTooLarge}>{workspaceS.save}</VibeButtonBgDarken>
						<button type='button' className='text-xs text-vibe-fg-3 hover:brightness-110' onClick={() => { void loadRootJsonRow(selRootJsonName); }}>{workspaceS.revert}</button>
						<button
							type='button'
							className='text-xs text-vibe-fg-3 hover:brightness-110'
							onClick={() => rootUri && void commandService.executeCommand('vscode.open', joinPath(rootUri, '.vibe', selRootJsonName))}
						>{workspaceS.openEditor}</button>
					</div>
				</div>
			) : null}

		</div>
	);
};

/**
 * Project Commands — Settings group (roadmap §C "Surface" — Прогон 3 full UI).
 *
 * Surfaces the workspace-first shell shortcuts loaded by
 * `IVibeCustomCommandsService` directly inside Settings → Workspace, so the
 * user does not have to bounce through the Command Palette for the common
 * day-to-day actions:
 *
 *   - **Toolbar position** radio (`vibeide.commands.toolbar.position`):
 *     titlebar / statusbar / hidden. Live config update.
 *   - **Top action row**: Open .vibe/commands.json · Import tasks.json · Import URL ·
 *     Reload · Open palette. Each dispatches the canonical palette command id —
 *     the actual behaviour lives in `vibeCustomCommandsContribution.ts`, so this
 *     panel is a thin "control surface" rather than a re-implementation.
 *   - **Filter** input — substring match against id / name / command.
 *   - **Commands table** — display-sorted (by `order`, then `name`). Each row:
 *     id, name, command summary, pinned indicator, order, and per-row actions
 *     (Run / Copy / Pin/Unpin / Edit-in-JSON / Delete). Pin/Delete mutate
 *     `.vibe/commands.json` directly via `IFileService` + the pure helpers in
 *     `projectCommandsAddFormPolicy.ts` (writes go through `commands.reload()`
 *     so the snapshot and top-bar update).
 *   - **Inline Add form** — collapsible. Validates every keystroke against
 *     `validateAddCommandDraft` (id pattern + duplicate, name + command
 *     required, cwd not absolute / no `..`, order integer). Shows a live JSON
 *     preview built by `previewProjectCommandJson`. Save writes via
 *     `appendCommandToFile` (creates the file from the init template when
 *     missing).
 *
 * The "counter" line («Загружено команд: N · закреплено: M») reads live from
 * `IVibeCustomCommandsService.getCommands()` and re-renders on
 * `onDidChangeCommands` (FS-watch / manual reload / globalPaths change).
 */
const ProjectCommandsPanel: React.FC<{ openAddTick?: number }> = ({ openAddTick = 0 }) => {
	const accessor = useAccessor();
	const commands = accessor.get('IVibeCustomCommandsService');
	const config = accessor.get('IConfigurationService');
	const commandService = accessor.get('ICommandService');
	const fileService = accessor.get('IFileService');
	const workspace = accessor.get('IWorkspaceContextService');
	const clipboard = accessor.get('IClipboardService');
	const notifications = accessor.get('INotificationService');

	const [snapshot, setSnapshot] = useState(() => commands.getCommands());
	const [position, setPosition] = useState<string>(() => {
		const raw = config.getValue('vibeide.commands.toolbar.position');
		return typeof raw === 'string' ? raw : 'titlebar';
	});
	const [maxPinned, setMaxPinned] = useState<number>(() => {
		const raw = config.getValue('vibeide.commands.toolbar.maxPinned');
		return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.floor(raw))) : 6;
	});
	const [maxPinnedDraft, setMaxPinnedDraft] = useState<string>(() => String(maxPinned));
	const [filter, setFilter] = useState('');
	const [addOpen, setAddOpen] = useState(false);
	const [draft, setDraft] = useState<AddCommandDraft>(ADD_COMMAND_DRAFT_EMPTY);
	const [saveBusy, setSaveBusy] = useState(false);

	useEffect(() => {
		const d = commands.onDidChangeCommands(e => setSnapshot(e.commands));
		return () => d.dispose();
	}, [commands]);

	// Deep-link from outside the panel (commands.json action-row) — each tick > 0
	// opens the Add form. We skip the initial 0 so just navigating to the tab
	// doesn't auto-expand the form.
	useEffect(() => {
		if (openAddTick > 0) {
			setAddOpen(true);
		}
	}, [openAddTick]);

	useEffect(() => {
		const d = config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.commands.toolbar.position')) {
				const raw = config.getValue('vibeide.commands.toolbar.position');
				setPosition(typeof raw === 'string' ? raw : 'titlebar');
			}
			if (e.affectsConfiguration('vibeide.commands.toolbar.maxPinned')) {
				const raw = config.getValue('vibeide.commands.toolbar.maxPinned');
				const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.floor(raw))) : 6;
				setMaxPinned(n);
				setMaxPinnedDraft(String(n));
			}
		});
		return () => d.dispose();
	}, [config]);

	const pinnedCount = useMemo(() => snapshot.filter(c => c.pinned === true).length, [snapshot]);

	const onPositionChange = useCallback(async (next: string) => {
		try {
			await config.updateValue('vibeide.commands.toolbar.position', next);
		} catch {
			// Surface errors via existing config notifications — no extra toast needed.
		}
	}, [config]);

	// Commit `maxPinned` only when the user finishes editing (blur or Enter) and
	// the parsed value is a valid integer in [1, 20]. Intermediate keystrokes
	// (e.g. empty string while clearing) are kept in `maxPinnedDraft` only.
	const commitMaxPinned = useCallback(async () => {
		const parsed = Number(maxPinnedDraft.trim());
		if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
			setMaxPinnedDraft(String(maxPinned));
			return;
		}
		const clamped = Math.max(1, Math.min(20, parsed));
		if (clamped !== parsed) {setMaxPinnedDraft(String(clamped));}
		if (clamped === maxPinned) {return;}
		try {
			await config.updateValue('vibeide.commands.toolbar.maxPinned', clamped);
		} catch {
			setMaxPinnedDraft(String(maxPinned));
		}
	}, [config, maxPinned, maxPinnedDraft]);

	const radio = (val: 'titlebar' | 'statusbar' | 'hidden', label: string) => (
		<label className='flex items-center gap-2 cursor-pointer select-none my-1'>
			<input
				type='radio'
				name='vibeide-pc-toolbar-position'
				checked={position === val}
				onChange={() => void onPositionChange(val)}
			/>
			<span className='text-xs text-vibe-fg-2'>{label}</span>
		</label>
	);

	// Display-sorted + filtered table view.
	const displaySorted = useMemo(() => sortProjectCommandsForDisplay(snapshot), [snapshot]);
	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) {return displaySorted;}
		return displaySorted.filter(c => {
			const argsLine = (c.args ?? []).join(' ').toLowerCase();
			return c.id.toLowerCase().includes(q)
				|| c.name.toLowerCase().includes(q)
				|| c.command.toLowerCase().includes(q)
				|| argsLine.includes(q);
		});
	}, [displaySorted, filter]);

	const existingIds = useMemo(() => new Set(snapshot.map(c => c.id)), [snapshot]);
	const validation = useMemo(() => validateAddCommandDraft(draft, existingIds), [draft, existingIds]);
	const previewCommand = useMemo<ProjectCommand | null>(() => {
		// Build a preview even when the draft is incomplete — gives the user a
		// "what will land in JSON" hint that updates as they type. We only need
		// id+name+command to be non-empty for the preview to be meaningful.
		if (!draft.id.trim() || !draft.name.trim() || !draft.command.trim()) {return null;}
		try {
			return buildProjectCommandFromDraft(draft);
		} catch {
			return null;
		}
	}, [draft]);

	const fieldErrorLabel = useCallback((code: string | null): string | null => {
		switch (code) {
			case ADD_COMMAND_ERROR.idMissing: return workspaceS.pcErrIdMissing;
			case ADD_COMMAND_ERROR.idPattern: return workspaceS.pcErrIdPattern;
			case ADD_COMMAND_ERROR.idDuplicate: return workspaceS.pcErrIdDuplicate;
			case ADD_COMMAND_ERROR.nameMissing: return workspaceS.pcErrNameMissing;
			case ADD_COMMAND_ERROR.commandMissing: return workspaceS.pcErrCommandMissing;
			case ADD_COMMAND_ERROR.cwdAbsolute: return workspaceS.pcErrCwdAbsolute;
			case ADD_COMMAND_ERROR.cwdTraversal: return workspaceS.pcErrCwdTraversal;
			case ADD_COMMAND_ERROR.orderNotNumber: return workspaceS.pcErrOrderNotNumber;
			default: return null;
		}
	}, []);

	const firstWorkspaceFolder = useCallback((): URI | null => {
		const folder = workspace.getWorkspace().folders[0];
		return folder ? folder.uri : null;
	}, [workspace]);

	/**
	 * Load + decode `.vibe/commands.json` for the first workspace folder.
	 * Returns `null` when the file is missing, malformed, or the user is in a
	 * folder-less window — caller decides whether to fall back to the init
	 * template or surface a notification.
	 */
	const readCommandsFile = useCallback(async (uri: URI): Promise<ProjectCommandsFile | null> => {
		try {
			const buf = await fileService.readFile(uri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (!parsed.ok) {return null;}
			const decoded = decodeProjectCommandsFile(parsed.value);
			return decoded.ok ? decoded.value : null;
		} catch {
			return null;
		}
	}, [fileService]);

	const onRunRow = useCallback(async (cmd: ProjectCommand) => {
		const outcome = await commands.run(cmd.id);
		if (outcome.outcome === 'refused') {
			notifications.notify({ severity: 2 /* Warning */, message: workspaceS.pcRowRunRefused(outcome.reason ?? 'unknown') });
		} else if (outcome.outcome === 'failure') {
			notifications.notify({ severity: 1 /* Error */, message: workspaceS.pcRowRunFailure(outcome.reason ?? 'unknown') });
		}
	}, [commands, notifications]);

	const onCopyRow = useCallback(async (cmd: ProjectCommand) => {
		const argSuffix = (cmd.args && cmd.args.length > 0) ? ' ' + cmd.args.join(' ') : '';
		await clipboard.writeText(`${cmd.command}${argSuffix}`);
		notifications.notify({ severity: 3 /* Info */, message: workspaceS.pcRowCopyDone });
	}, [clipboard, notifications]);

	const onPinToggleRow = useCallback(async (cmd: ProjectCommand) => {
		const folderUri = firstWorkspaceFolder();
		if (!folderUri) {return;}
		const uri = joinPath(folderUri, '.vibe', 'commands.json');
		const file = await readCommandsFile(uri);
		if (!file) {
			notifications.notify({ severity: 2, message: workspaceS.pcRowGlobalOnly });
			return;
		}
		const next = setPinnedInFile(file, cmd.id, !(cmd.pinned === true));
		if (!next) {
			notifications.notify({ severity: 2, message: workspaceS.pcRowGlobalOnly });
			return;
		}
		await fileService.writeFile(uri, VSBuffer.fromString(next.serialized));
		await commands.reload();
	}, [firstWorkspaceFolder, readCommandsFile, fileService, commands, notifications]);

	const onDeleteRow = useCallback(async (cmd: ProjectCommand) => {
		// Use native confirm — settings panel already lives inside the editor
		// surface and we want a synchronous yes/no without spinning up dialog
		// service plumbing (which would require an extra `IDialogService` import).
		 
		const confirmed = typeof window !== 'undefined' ? window.confirm(workspaceS.pcRowDeleteConfirm(cmd.name)) : false;
		if (!confirmed) {return;}
		const folderUri = firstWorkspaceFolder();
		if (!folderUri) {return;}
		const uri = joinPath(folderUri, '.vibe', 'commands.json');
		const file = await readCommandsFile(uri);
		if (!file) {
			notifications.notify({ severity: 2, message: workspaceS.pcRowGlobalOnly });
			return;
		}
		const next = removeCommandFromFile(file, cmd.id);
		if (!next) {
			notifications.notify({ severity: 2, message: workspaceS.pcRowGlobalOnly });
			return;
		}
		await fileService.writeFile(uri, VSBuffer.fromString(next.serialized));
		await commands.reload();
	}, [firstWorkspaceFolder, readCommandsFile, fileService, commands, notifications]);

	const onSaveAdd = useCallback(async () => {
		if (!validation.isValid || saveBusy) {return;}
		setSaveBusy(true);
		try {
			const folderUri = firstWorkspaceFolder();
			if (!folderUri) {
				notifications.notify({ severity: 2, message: workspaceS.pcAddNoWorkspace });
				return;
			}
			const uri = joinPath(folderUri, '.vibe', 'commands.json');
			let file = await readCommandsFile(uri);
			if (!file) {
				// File missing or unparsable — bootstrap from the canonical init template.
				const exists = await fileService.exists(uri);
				if (!exists) {
					await fileService.writeFile(uri, VSBuffer.fromString(serializeProjectCommandsInitTemplate({ vibeVersion: '1.0.0' })));
					file = await readCommandsFile(uri);
				}
			}
			if (!file) {
				notifications.notify({ severity: 1, message: workspaceS.pcAddSaveError('cannot-read-or-init') });
				return;
			}
			const built = buildProjectCommandFromDraft(draft);
			const { serialized } = appendCommandToFile(file, built);
			await fileService.writeFile(uri, VSBuffer.fromString(serialized));
			await commands.reload();
			notifications.notify({ severity: 3, message: workspaceS.pcAddSaveSuccess(built.id) });
			setDraft(ADD_COMMAND_DRAFT_EMPTY);
			setAddOpen(false);
		} catch (e) {
			notifications.notify({ severity: 1, message: workspaceS.pcAddSaveError((e as Error).message ?? String(e)) });
		} finally {
			setSaveBusy(false);
		}
	}, [validation.isValid, saveBusy, draft, firstWorkspaceFolder, readCommandsFile, fileService, commands, notifications]);

	const inputCls = 'w-full @@vibe-chat-like-shell text-xs px-2 py-1';
	const labelCls = 'flex flex-col gap-1';
	const labelTitleCls = 'text-[11px] text-vibe-fg-2 font-medium';
	const hintCls = 'text-[10px] text-vibe-fg-3';
	const errCls = 'text-[10px] text-red-400';

	return (
		<div className='flex flex-col gap-3'>
			<p className='text-xs text-vibe-fg-3'>{workspaceS.pcGroupIntro}</p>

			<div className='text-xs text-vibe-fg-2'>
				{workspaceS.pcCountLabel(snapshot.length)}
				<span className='text-vibe-fg-1 font-medium'>{workspaceS.pcPinnedCount(pinnedCount)}</span>
			</div>

			<div className='@@vibe-chat-like-shell px-3 py-2 flex flex-col gap-1'>
				<span className='text-xs text-vibe-fg-3'>{workspaceS.pcToolbarPositionLabel}</span>
				{radio('titlebar', workspaceS.pcToolbarPositionTitlebar)}
				{radio('statusbar', workspaceS.pcToolbarPositionStatusbar)}
				{radio('hidden', workspaceS.pcToolbarPositionHidden)}
				<div className='flex items-center gap-2 mt-2 pt-2 border-t border-vibe-border-1'>
					<label htmlFor='vibeide-pc-max-pinned' className='text-xs text-vibe-fg-2'>{workspaceS.pcMaxPinnedLabel}</label>
					<input
						id='vibeide-pc-max-pinned'
						type='number'
						min={1}
						max={20}
						step={1}
						className='@@vibe-chat-like-control text-xs px-2 py-0.5 text-vibe-fg-2 w-16'
						value={maxPinnedDraft}
						disabled={position === 'hidden'}
						onChange={e => setMaxPinnedDraft(e.target.value)}
						onBlur={() => { void commitMaxPinned(); }}
						onKeyDown={e => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
					/>
					<span className='text-[10px] text-vibe-fg-3'>{workspaceS.pcMaxPinnedHint}</span>
				</div>
			</div>

			<div className='flex flex-wrap gap-2'>
				<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => void commandService.executeCommand('vibeide.commands.openConfigFile')}>
					{workspaceS.pcOpenJson}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => void commandService.executeCommand('vibeide.commands.importTasksJson')}>
					{workspaceS.pcImportTasks}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => void commandService.executeCommand('vibeide.commands.importFromUrl')}>
					{workspaceS.pcImportUrl}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => void commandService.executeCommand('vibeide.commands.reload')}>
					{workspaceS.pcReload}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => void commandService.executeCommand('vibeide.commands.runFromPalette')}>
					{workspaceS.pcOpenPalette}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => setAddOpen(o => !o)}>
					{addOpen ? workspaceS.pcAddFormToggleOpen : workspaceS.pcAddFormToggleClosed}
				</VibeButtonBgDarken>
			</div>

			{/* Add form (collapsible) */}
			{addOpen && (
				<div className='@@vibe-chat-like-shell px-3 py-3 flex flex-col gap-2'>
					<div className='text-xs text-vibe-fg-1 font-medium'>{workspaceS.pcAddFormTitle}</div>
					<div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
						<label className={labelCls}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldId}</span>
							<input
								className={inputCls}
								value={draft.id}
								onChange={e => setDraft(d => ({ ...d, id: e.target.value }))}
								placeholder='lint'
								autoComplete='off'
								spellCheck={false}
							/>
							{validation.errors.id
								? <span className={errCls}>{fieldErrorLabel(validation.errors.id)}</span>
								: <span className={hintCls}>{workspaceS.pcAddFieldIdHint}</span>}
						</label>
						<label className={labelCls}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldName}</span>
							<input
								className={inputCls}
								value={draft.name}
								onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
								placeholder='Run lint'
							/>
							{validation.errors.name
								? <span className={errCls}>{fieldErrorLabel(validation.errors.name)}</span>
								: <span className={hintCls}>{workspaceS.pcAddFieldNameHint}</span>}
						</label>
						<label className={`${labelCls} md:col-span-2`}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldDescription}</span>
							<input
								className={inputCls}
								value={draft.description}
								onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
								placeholder='Запустить ESLint на проекте'
							/>
						</label>
						<label className={labelCls}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldCommand}</span>
							<input
								className={inputCls}
								value={draft.command}
								onChange={e => setDraft(d => ({ ...d, command: e.target.value }))}
								placeholder='npm'
								autoComplete='off'
								spellCheck={false}
							/>
							{validation.errors.command
								? <span className={errCls}>{fieldErrorLabel(validation.errors.command)}</span>
								: <span className={hintCls}>{workspaceS.pcAddFieldCommandHint}</span>}
						</label>
						<label className={labelCls}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldCwd}</span>
							<input
								className={inputCls}
								value={draft.cwd}
								onChange={e => setDraft(d => ({ ...d, cwd: e.target.value }))}
								placeholder='scripts'
								autoComplete='off'
								spellCheck={false}
							/>
							{validation.errors.cwd
								? <span className={errCls}>{fieldErrorLabel(validation.errors.cwd)}</span>
								: <span className={hintCls}>{workspaceS.pcAddFieldCwdHint}</span>}
						</label>
						<label className={`${labelCls} md:col-span-2`}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldArgs}</span>
							<textarea
								className={`${inputCls} font-mono min-h-[64px]`}
								value={draft.argsText}
								onChange={e => setDraft(d => ({ ...d, argsText: e.target.value }))}
								placeholder={'run\nlint'}
								spellCheck={false}
							/>
							<span className={hintCls}>{workspaceS.pcAddFieldArgsHint}</span>
						</label>
						<label className={labelCls}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldTerminal}</span>
							<select
								className={inputCls}
								value={draft.terminal}
								onChange={e => setDraft(d => ({ ...d, terminal: e.target.value as ProjectCommandTerminal | '' }))}
							>
								<option value=''>{workspaceS.pcAddTerminalDefault}</option>
								<option value='integrated'>{workspaceS.pcAddTerminalIntegrated}</option>
								<option value='external'>{workspaceS.pcAddTerminalExternal}</option>
								<option value='background'>{workspaceS.pcAddTerminalBackground}</option>
							</select>
						</label>
						<label className={labelCls}>
							<span className={labelTitleCls}>{workspaceS.pcAddFieldOrder}</span>
							<input
								className={inputCls}
								value={draft.orderText}
								onChange={e => setDraft(d => ({ ...d, orderText: e.target.value }))}
								placeholder='10'
								inputMode='numeric'
							/>
							{validation.errors.order
								? <span className={errCls}>{fieldErrorLabel(validation.errors.order)}</span>
								: <span className={hintCls}>{workspaceS.pcAddFieldOrderHint}</span>}
						</label>
						<label className='flex items-center gap-2 cursor-pointer select-none md:col-span-2'>
							<input
								type='checkbox'
								checked={draft.pinned}
								onChange={e => setDraft(d => ({ ...d, pinned: e.target.checked }))}
							/>
							<span className='text-xs text-vibe-fg-2'>{workspaceS.pcAddFieldPinned}</span>
						</label>
					</div>

					{/* Live JSON preview */}
					<div className='flex flex-col gap-1'>
						<span className={labelTitleCls}>{workspaceS.pcAddPreviewTitle}</span>
						<pre
							className='@@vibe-chat-like-shell font-mono text-[11px] p-2 whitespace-pre overflow-x-auto text-vibe-fg-2'
							style={{ maxHeight: 200 }}
						>
							{previewCommand ? previewProjectCommandJson(previewCommand) : '// заполните id, name и команду…'}
						</pre>
					</div>

					<div className='flex gap-2'>
						<VibeButtonBgDarken
							className={`px-3 py-1 text-xs ${(!validation.isValid || saveBusy) ? 'opacity-50 cursor-not-allowed' : ''}`}
							disabled={!validation.isValid || saveBusy}
							onClick={() => void onSaveAdd()}
						>
							{workspaceS.pcAddSave}
						</VibeButtonBgDarken>
						<VibeButtonBgDarken
							className='px-3 py-1 text-xs'
							onClick={() => { setDraft(ADD_COMMAND_DRAFT_EMPTY); setAddOpen(false); }}
						>
							{workspaceS.pcAddCancel}
						</VibeButtonBgDarken>
					</div>
				</div>
			)}

			{/* Filter + table */}
			<div className='flex flex-col gap-2'>
				<div className='flex items-center justify-between gap-2'>
					<span className='text-xs text-vibe-fg-1 font-medium'>{workspaceS.pcTableTitle}</span>
					<input
						className={`${inputCls} max-w-xs`}
						value={filter}
						onChange={e => setFilter(e.target.value)}
						placeholder={workspaceS.pcTableFilterPlaceholder}
					/>
				</div>
				{snapshot.length === 0 ? (
					<p className='text-xs text-vibe-fg-3'>{workspaceS.pcTableEmpty}</p>
				) : filtered.length === 0 ? (
					<p className='text-xs text-vibe-fg-3'>{workspaceS.pcTableEmptyFiltered}</p>
				) : (
					<div className='@@vibe-chat-like-shell overflow-x-auto'>
						<table className='w-full text-xs text-vibe-fg-2'>
							<thead>
								<tr className='text-[11px] text-vibe-fg-3 uppercase tracking-wide'>
									<th className='text-left px-1 py-1 w-7'></th>
									<th className='text-left px-2 py-1'>{workspaceS.pcTableColId}</th>
									<th className='text-left px-2 py-1'>{workspaceS.pcTableColName}</th>
									<th className='text-left px-2 py-1'>{workspaceS.pcTableColCommand}</th>
									<th className='text-left px-2 py-1'>{workspaceS.pcTableColOrder}</th>
									<th className='text-right px-2 py-1'>{workspaceS.pcTableColActions}</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map(c => {
									const argSuffix = (c.args && c.args.length > 0) ? ' ' + c.args.join(' ') : '';
									const line = `${c.command}${argSuffix}`;
									const isPinned = c.pinned === true;
									return (
										<tr key={c.id} className='border-t border-vibe-border-1 hover:bg-vibe-bg-2/30'>
											<td className='px-1 py-1 align-middle'>
												<button
													type='button'
													className={`@@vibe-pin-toggle codicon codicon-pinned ${isPinned ? '@@vibe-pin-toggle--active' : ''}`}
													title={isPinned ? workspaceS.pcRowUnpinTip : workspaceS.pcRowPinTip}
													aria-label={isPinned ? workspaceS.pcRowUnpin : workspaceS.pcRowPin}
													onClick={() => void onPinToggleRow(c)}
												/>
											</td>
											<td className='px-2 py-1 font-mono'>{c.id}</td>
											<td className='px-2 py-1'>{c.name}</td>
											<td className='px-2 py-1 font-mono truncate' style={{ maxWidth: 280 }} title={line}>{line}</td>
											<td className='px-2 py-1'>{typeof c.order === 'number' ? c.order : ''}</td>
											<td className='px-2 py-1'>
												<div className='flex justify-end gap-1 flex-nowrap'>
													<button
														type='button'
														className='@@vibe-pill-button px-2 py-0.5 text-[11px]'
														title={workspaceS.pcRowRunTip}
														onClick={() => void onRunRow(c)}
													>{workspaceS.pcRowRun}</button>
													<button
														type='button'
														className='@@vibe-pill-button px-2 py-0.5 text-[11px]'
														title={workspaceS.pcRowCopyTip}
														onClick={() => void onCopyRow(c)}
													>{workspaceS.pcRowCopy}</button>
													<button
														type='button'
														className='@@vibe-pill-button px-2 py-0.5 text-[11px]'
														title={workspaceS.pcRowEditTip}
														onClick={() => void commandService.executeCommand('vibeide.commands.editById', c.id)}
													>{workspaceS.pcRowEdit}</button>
													<button
														type='button'
														className='@@vibe-pill-button px-2 py-0.5 text-[11px] text-red-400'
														onClick={() => void onDeleteRow(c)}
													>{workspaceS.pcRowDelete}</button>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
};

const VibeWorkspaceReadmeForm = ({ rootUri, onBackToForms }: { rootUri: URI; onBackToForms: () => void }) => {
	const accessor = useAccessor();
	const forms = accessor.get('IVibeWorkspaceFormsService');
	const commandService = accessor.get('ICommandService');

	const [readmeText, setReadmeText] = useState('');
	const [readmeTooLarge, setReadmeTooLarge] = useState(false);

	const loadReadme = useCallback(async () => {
		const r = await forms.loadReadme(rootUri);
		setReadmeTooLarge(!!r.skippedTooLarge);
		setReadmeText(r.skippedTooLarge ? '' : r.content);
	}, [forms, rootUri]);

	useEffect(() => { void loadReadme(); }, [loadReadme]);

	return (
		<div className='mt-1 flex flex-col gap-3 max-w-3xl'>
			<button type='button' className='text-xs text-vibe-fg-3 hover:brightness-110 self-start' onClick={() => onBackToForms()}>
				{workspaceS.backToForms}
			</button>
			<h3 className='text-sm font-medium text-vibe-fg-1'>{workspaceS.readmeH}</h3>
			<p className='text-xs text-vibe-fg-3'>
				{workspaceS.readmeIntro}
			</p>
			{readmeTooLarge ? (
				<p className='text-xs text-amber-500'>
					{workspaceS.readmeTooLarge(MAX_VIBE_RULES_FORM_BYTES / 1024)}
				</p>
			) : (
				<div
					className='@@vibe-chat-like-shell w-full min-h-[200px] max-h-[70vh] overflow-y-auto text-xs p-3 text-vibe-fg-2'
				>
					<ChatMarkdownRender string={readmeText || '_(empty)_'} chatMessageLocation={undefined} codeURI={joinPath(rootUri, '.vibe', 'README.md')} />
				</div>
			)}
			<div className='flex gap-2 flex-wrap items-center'>
				<button
					type='button'
					className='text-xs text-vibe-fg-3 hover:brightness-110'
					onClick={() => void loadReadme()}
				>
					{workspaceS.refreshPreview}
				</button>
				<button
					type='button'
					className='text-xs text-vibe-fg-3 hover:brightness-110'
					onClick={() => void commandService.executeCommand('vscode.open', joinPath(rootUri, '.vibe', 'README.md'))}
				>
					{workspaceS.editInEditor}
				</button>
			</div>
		</div>
	);
};
