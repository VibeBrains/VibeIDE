/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeButtonBgDarken } from '../util/inputs.js';
import { joinPath } from '../../../../../../../base/common/resources.js';
import { URI } from '../../../../../../../base/common/uri.js';
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
			description: 'Опишите многошаговый сценарий для агента.',
			steps: [{ name: 'Шаг 1', description: 'Что сделать на этом шаге.' }],
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
		{ id: 'rules', label: 'Правила (.vibe/rules.md)' },
		{ id: 'agents', label: 'Агенты (AGENTS.md)' },
		{ id: 'goals', label: 'Цели (.vibe/goals.md)' },
		{ id: 'prompts', label: 'Промпты (.vibe/prompts)' },
		{ id: 'workflows', label: 'Workflows (.vibe/workflows)' },
		{ id: 'skills', label: 'Навыки (.vibe/skills)' },
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
				{jsonBasenamesSorted.length ? (
					<div className='flex flex-wrap gap-2 items-center'>
						{jsonBasenamesSorted.map(jn => {
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
						<summary className='cursor-pointer text-vibe-fg-2 select-none'>Пример разметки (скелет для копирования)</summary>
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
						Каталог под <code className='text-vibe-fg-2'>.vibe/skills/</code> с файлом <code className='text-vibe-fg-2'>SKILL.md</code>.
						Поле <code className='text-vibe-fg-2'>name</code> в YAML — id для <code className='text-vibe-fg-2'>/skill:</code> (может отличаться от папки).
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
					<details open className='text-xs @@vibe-chat-like-shell px-2 py-1'>
						<summary className='cursor-pointer text-vibe-fg-2 select-none mb-2'>{workspaceS.rootJsonDocFold}</summary>
						<div className='text-xs text-vibe-fg-3 border-t border-vibe-border-1 pt-2 max-h-[22rem] overflow-y-auto prose prose-sm prose-p:my-1 prose-ul:my-1 prose-ul:list-disc prose-ul:pl-4 prose-code:before:content-none prose-code:after:content-none select-text'>
							<ChatMarkdownRender inPTag={true} string={workspaceRootJsonDocMarkdown(selRootJsonName)} chatMessageLocation={undefined} />
						</div>
					</details>
					<details className='text-xs text-vibe-fg-3 @@vibe-chat-like-shell px-2 py-1'>
						<summary className='cursor-pointer text-vibe-fg-2 select-none'>Пример (скелет для копирования)</summary>
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
