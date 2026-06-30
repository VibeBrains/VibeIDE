/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — form-based editor with JSON toggle (roadmap §L316).
 *
 * Reads / writes `.vibe/commands.json` from the first workspace folder.
 * Two rendering modes, toggled by a button at the top:
 *
 *  • Form mode (default): list of commands → click to edit; per-field
 *    inputs validated via `validateProjectCommandField`. The save button
 *    is disabled while any field has severity `error`.
 *  • JSON mode: raw textarea for the whole document; parsed with
 *    `safeParseConfigJson` + `decodeProjectCommandsFile` on save.
 *
 * Save side-effects (both modes):
 *  • Sanitizer (`sanitizeProjectCommand`) rejects shell-metachar / zero-width
 *    / Bidi-override / control-char issues with an inline error.
 *  • Secret-aware (`findSuspiciousLiteralSecrets`, roadmap L914) blocks save
 *    when command/args/env look like plaintext credentials and points the
 *    user at `${secret:KEY}` placeholders.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeButtonBgDarken, VibeSimpleInputBox, VibeSwitch } from '../util/inputs.js';
import { joinPath } from '../../../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';
import {
	ProjectCommand,
	ProjectCommandsFile,
	decodeProjectCommandsFile,
} from '../../../../common/projectCommandsTypes.js';
import {
	ProjectCommandFieldName,
	validateProjectCommandField,
} from '../../../../common/projectCommandsFormFields.js';
import { safeParseConfigJson } from '../../../../common/vibeConfigJsonParser.js';
import {
	sanitizeProjectCommand,
	describeIssue,
} from '../../../../common/projectCommandsSanitizer.js';
import { findSuspiciousLiteralSecrets } from '../../../../common/projectCommandSecretsResolver.js';
import { commandsEditorS } from './vibeSettingsRu.js';
import Severity from '../../../../../../../base/common/severity.js';

const COMMANDS_REL_PATH = ['.vibe', 'commands.json'] as const;

type Mode = 'form' | 'json';

type EditableCommand = Partial<Record<ProjectCommandFieldName, unknown>> & { id: string };

function emptyCommand(): EditableCommand {
	return {
		id: '',
		name: '',
		command: '',
	};
}

function serialize(file: ProjectCommandsFile): string {
	return JSON.stringify(file, null, '\t') + '\n';
}

/** Pure: project a typed ProjectCommand into the form's editable shape. */
function toEditable(c: ProjectCommand): EditableCommand {
	const out: EditableCommand = { id: c.id, name: c.name, command: c.command };
	if (c.description !== undefined) {out.description = c.description;}
	if (c.icon !== undefined) {out.icon = c.icon;}
	if (c.color !== undefined) {out.color = c.color;}
	if (c.args !== undefined) {out.args = c.args;}
	if (c.cwd !== undefined) {out.cwd = c.cwd;}
	if (c.env !== undefined) {out.env = c.env;}
	if (c.terminal !== undefined) {out.terminal = c.terminal;}
	if (c.confirm !== undefined) {out.confirm = c.confirm;}
	if (c.singleton !== undefined) {out.singleton = c.singleton;}
	if (c.pinned !== undefined) {out.pinned = c.pinned;}
	if (c.order !== undefined) {out.order = c.order;}
	if (c.workflowId !== undefined) {out.workflowId = c.workflowId;}
	return out;
}

/** Pure: build the on-disk ProjectCommand from the form draft (drops empties). */
function fromEditable(e: EditableCommand): ProjectCommand {
	const out: ProjectCommand = {
		id: String(e.id ?? ''),
		name: String(e.name ?? ''),
		command: String(e.command ?? ''),
	};
	if (typeof e.description === 'string' && e.description.length > 0) {out.description = e.description;}
	if (typeof e.icon === 'string' && e.icon.length > 0) {out.icon = e.icon;}
	if (typeof e.color === 'string' && e.color.length > 0) {out.color = e.color;}
	if (Array.isArray(e.args) && e.args.length > 0) {out.args = e.args as readonly string[];}
	if (typeof e.cwd === 'string' && e.cwd.length > 0) {out.cwd = e.cwd;}
	if (e.env && typeof e.env === 'object') {out.env = e.env as Readonly<Record<string, string>>;}
	if (e.terminal === 'integrated' || e.terminal === 'external' || e.terminal === 'background') {out.terminal = e.terminal;}
	if (e.confirm === true) {out.confirm = true;}
	if (e.singleton === true) {out.singleton = true;}
	if (e.pinned === true) {out.pinned = true;}
	if (typeof e.order === 'number' && Number.isFinite(e.order)) {out.order = e.order;}
	if (typeof e.workflowId === 'string' && e.workflowId.length > 0) {out.workflowId = e.workflowId;}
	return out;
}

export const CommandsEditorPanel: React.FC = () => {
	const accessor = useAccessor();
	const fileService = accessor.get('IFileService');
	const workspace = accessor.get('IWorkspaceContextService');
	const notify = accessor.get('INotificationService');
	const commandService = accessor.get('ICommandService');

	const folder = useMemo(() => workspace.getWorkspace().folders[0]?.uri, [workspace]);
	const fileUri = useMemo(() => folder ? joinPath(folder, ...COMMANDS_REL_PATH) : null, [folder]);

	const [mode, setMode] = useState<Mode>('form');
	const [commands, setCommands] = useState<EditableCommand[]>([]);
	const [vibeVersion, setVibeVersion] = useState<string>('1.0.0');
	const [jsonDraft, setJsonDraft] = useState<string>('');
	const [activeIdx, setActiveIdx] = useState<number | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = useCallback(async () => {
		if (!fileUri) {
			setLoadError(commandsEditorS.noWorkspace);
			return;
		}
		setBusy(true);
		try {
			let raw = '';
			try {
				const buf = await fileService.readFile(fileUri);
				raw = buf.value.toString();
			} catch {
				// missing file → empty draft, will be created on save.
			}
			setJsonDraft(raw || serialize({ vibeVersion: '1.0.0', commands: [] }));
			if (!raw) {
				setCommands([]);
				setVibeVersion('1.0.0');
				setLoadError(null);
				return;
			}
			const parsed = safeParseConfigJson(raw);
			if (!parsed.ok) {
				setLoadError(`${commandsEditorS.loadParseFailed}: ${parsed.reason}`);
				setCommands([]);
				return;
			}
			const decoded = decodeProjectCommandsFile(parsed.value);
			if (!decoded.ok) {
				setLoadError(`${commandsEditorS.loadDecodeFailed}: ${decoded.reason}`);
				setCommands([]);
				return;
			}
			setVibeVersion(decoded.value.vibeVersion);
			setCommands(decoded.value.commands.map(toEditable));
			setLoadError(null);
		} finally {
			setBusy(false);
		}
	}, [fileUri, fileService]);

	useEffect(() => { void reload(); }, [reload]);

	// Validation: per-field issues for the currently-active form command.
	const activeIssues = useMemo(() => {
		if (mode !== 'form' || activeIdx === null) {return null;}
		const cmd = commands[activeIdx];
		if (!cmd) {return null;}
		const issues: Partial<Record<ProjectCommandFieldName, string>> = {};
		const fields: ProjectCommandFieldName[] = ['id', 'name', 'command', 'cwd', 'icon', 'color', 'terminal'];
		for (const f of fields) {
			const issue = validateProjectCommandField(f, cmd[f]);
			if (issue.severity === 'error') {
				issues[f] = issue.message;
			}
		}
		return issues;
	}, [mode, activeIdx, commands]);

	const hasFormErrors = useMemo(() => {
		if (mode !== 'form') {return false;}
		for (const cmd of commands) {
			const idIssue = validateProjectCommandField('id', cmd.id);
			const nameIssue = validateProjectCommandField('name', cmd.name);
			const cmdIssue = validateProjectCommandField('command', cmd.command);
			if (idIssue.severity === 'error' || nameIssue.severity === 'error' || cmdIssue.severity === 'error') {
				return true;
			}
		}
		return false;
	}, [mode, commands]);

	// L914 / sanitizer pre-check: returns first blocking issue or null.
	const checkSaveBlock = useCallback((file: ProjectCommandsFile): string | null => {
		const seen = new Set<string>();
		for (const c of file.commands) {
			if (seen.has(c.id)) {
				return commandsEditorS.duplicateId(c.id);
			}
			seen.add(c.id);
			const sanRes = sanitizeProjectCommand(c);
			if (!sanRes.ok) {
				return `${c.name || c.id}: ${describeIssue(sanRes.issues[0])}`;
			}
			const suspects = findSuspiciousLiteralSecrets({ command: c.command, args: c.args, cwd: c.cwd, env: c.env });
			if (suspects.length > 0) {
				return commandsEditorS.secretSuspect(c.name || c.id, suspects[0].pathHint);
			}
		}
		return null;
	}, []);

	const saveFromForm = useCallback(async () => {
		if (!fileUri) {return;}
		const file: ProjectCommandsFile = {
			vibeVersion: vibeVersion || '1.0.0',
			commands: commands.map(fromEditable),
		};
		const decoded = decodeProjectCommandsFile(file);
		if (!decoded.ok) {
			notify.notify({ severity: Severity.Error, message: `${commandsEditorS.saveDecodeFailed}: ${decoded.reason}` });
			return;
		}
		const block = checkSaveBlock(decoded.value);
		if (block !== null) {
			notify.notify({ severity: Severity.Warning, message: block });
			return;
		}
		setBusy(true);
		try {
			await fileService.writeFile(fileUri, VSBuffer.fromString(serialize(decoded.value)));
			await commandService.executeCommand('vibeide.commands.reload');
			notify.notify({ severity: Severity.Info, message: commandsEditorS.saveDone });
		} finally {
			setBusy(false);
		}
	}, [fileUri, vibeVersion, commands, fileService, notify, commandService, checkSaveBlock]);

	const saveFromJson = useCallback(async () => {
		if (!fileUri) {return;}
		const parsed = safeParseConfigJson(jsonDraft);
		if (!parsed.ok) {
			notify.notify({ severity: Severity.Error, message: `${commandsEditorS.jsonParseFailed}: ${parsed.reason}` });
			return;
		}
		const decoded = decodeProjectCommandsFile(parsed.value);
		if (!decoded.ok) {
			notify.notify({ severity: Severity.Error, message: `${commandsEditorS.saveDecodeFailed}: ${decoded.reason}` });
			return;
		}
		const block = checkSaveBlock(decoded.value);
		if (block !== null) {
			notify.notify({ severity: Severity.Warning, message: block });
			return;
		}
		setBusy(true);
		try {
			await fileService.writeFile(fileUri, VSBuffer.fromString(serialize(decoded.value)));
			await commandService.executeCommand('vibeide.commands.reload');
			// Sync form state.
			setVibeVersion(decoded.value.vibeVersion);
			setCommands(decoded.value.commands.map(toEditable));
			notify.notify({ severity: Severity.Info, message: commandsEditorS.saveDone });
		} finally {
			setBusy(false);
		}
	}, [fileUri, jsonDraft, fileService, notify, commandService, checkSaveBlock]);

	const onToggleMode = useCallback(() => {
		if (mode === 'form') {
			// Form → JSON: regenerate draft from current form state.
			const file: ProjectCommandsFile = {
				vibeVersion: vibeVersion || '1.0.0',
				commands: commands.map(fromEditable),
			};
			setJsonDraft(serialize(file));
			setMode('json');
		} else {
			// JSON → Form: try to parse current draft into form state.
			const parsed = safeParseConfigJson(jsonDraft);
			if (parsed.ok) {
				const decoded = decodeProjectCommandsFile(parsed.value);
				if (decoded.ok) {
					setVibeVersion(decoded.value.vibeVersion);
					setCommands(decoded.value.commands.map(toEditable));
					setLoadError(null);
				} else {
					setLoadError(`${commandsEditorS.toggleDecodeFailed}: ${decoded.reason}`);
				}
			} else {
				setLoadError(`${commandsEditorS.toggleParseFailed}: ${parsed.reason}`);
			}
			setMode('form');
		}
	}, [mode, vibeVersion, commands, jsonDraft]);

	const onAddCommand = useCallback(() => {
		const draft = emptyCommand();
		setCommands(prev => [...prev, draft]);
		setActiveIdx(commands.length);
	}, [commands.length]);

	const onDeleteCommand = useCallback((idx: number) => {
		setCommands(prev => prev.filter((_, i) => i !== idx));
		setActiveIdx(null);
	}, []);

	const onFieldChange = useCallback((idx: number, field: ProjectCommandFieldName, value: unknown) => {
		setCommands(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));
	}, []);

	if (!folder) {
		return <div className='p-3 text-vibe-fg-3'>{commandsEditorS.noWorkspace}</div>;
	}

	return (
		<div className='flex flex-col gap-3 p-3'>
			<div className='flex items-center gap-2'>
				<h3 className='text-lg font-semibold text-vibe-fg-1 flex-1'>{commandsEditorS.title}</h3>
				<VibeButtonBgDarken onClick={onToggleMode} disabled={busy}>
					{mode === 'form' ? commandsEditorS.toggleToJson : commandsEditorS.toggleToForm}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken onClick={() => void reload()} disabled={busy}>
					{commandsEditorS.reload}
				</VibeButtonBgDarken>
			</div>
			{loadError ? (
				<div className='text-vibe-warning-fg text-sm border border-vibe-warning-fg/40 rounded p-2'>{loadError}</div>
			) : null}
			{mode === 'json' ? (
				<>
					<textarea
						value={jsonDraft}
						onChange={e => setJsonDraft(e.target.value)}
						spellCheck={false}
						className='w-full min-h-[320px] font-mono text-xs bg-vibe-bg-2 text-vibe-fg-1 border border-vibe-border-3 rounded p-2'
					/>
					<div className='flex gap-2'>
						<VibeButtonBgDarken onClick={() => void saveFromJson()} disabled={busy}>
							{commandsEditorS.save}
						</VibeButtonBgDarken>
					</div>
				</>
			) : (
				<div className='flex gap-3'>
					<div className='w-1/3 flex flex-col gap-1'>
						{commands.map((c, i) => (
							<button
								key={`${c.id}-${i}`}
								type='button'
								onClick={() => setActiveIdx(i)}
								className={`text-left px-2 py-1 rounded border ${activeIdx === i ? 'bg-vibe-bg-3 border-vibe-border-1' : 'border-vibe-border-4'}`}
							>
								<div className='text-vibe-fg-1 text-sm'>{String(c.name || c.id || commandsEditorS.unnamed)}</div>
								<div className='text-vibe-fg-3 text-xs'>{String(c.id || '')}</div>
							</button>
						))}
						<VibeButtonBgDarken onClick={onAddCommand} disabled={busy}>{commandsEditorS.addCommand}</VibeButtonBgDarken>
					</div>
					<div className='flex-1 flex flex-col gap-2'>
						{activeIdx !== null && commands[activeIdx] ? (
							<CommandForm
								cmd={commands[activeIdx]}
								issues={activeIssues ?? {}}
								onChange={(field, value) => onFieldChange(activeIdx, field, value)}
								onDelete={() => onDeleteCommand(activeIdx)}
							/>
						) : (
							<div className='text-vibe-fg-3 text-sm'>{commandsEditorS.selectOrAdd}</div>
						)}
						<div className='flex gap-2 mt-2'>
							<VibeButtonBgDarken onClick={() => void saveFromForm()} disabled={busy || hasFormErrors}>
								{commandsEditorS.save}
							</VibeButtonBgDarken>
							{hasFormErrors ? (
								<span className='text-vibe-warning-fg text-xs self-center'>{commandsEditorS.fixErrors}</span>
							) : null}
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

interface CommandFormProps {
	cmd: EditableCommand;
	issues: Partial<Record<ProjectCommandFieldName, string>>;
	onChange: (field: ProjectCommandFieldName, value: unknown) => void;
	onDelete: () => void;
}

const CommandForm: React.FC<CommandFormProps> = ({ cmd, issues, onChange, onDelete }) => {
	const argsText = useMemo(
		() => Array.isArray(cmd.args) ? (cmd.args as string[]).join('\n') : '',
		[cmd.args],
	);
	const envText = useMemo(() => {
		if (!cmd.env || typeof cmd.env !== 'object') {return '';}
		return Object.entries(cmd.env as Record<string, string>)
			.map(([k, v]) => `${k}=${v}`).join('\n');
	}, [cmd.env]);

	return (
		<div className='flex flex-col gap-2'>
			<LabeledField label={commandsEditorS.fieldId} error={issues.id}>
				<VibeSimpleInputBox value={String(cmd.id ?? '')} onChangeValue={v => onChange('id', v)} placeholder='' />
			</LabeledField>
			<LabeledField label={commandsEditorS.fieldName} error={issues.name}>
				<VibeSimpleInputBox value={String(cmd.name ?? '')} onChangeValue={v => onChange('name', v)} placeholder='' />
			</LabeledField>
			<LabeledField label={commandsEditorS.fieldCommand} error={issues.command}>
				<VibeSimpleInputBox value={String(cmd.command ?? '')} onChangeValue={v => onChange('command', v)} placeholder='' />
			</LabeledField>
			<LabeledField label={commandsEditorS.fieldDescription}>
				<VibeSimpleInputBox value={String(cmd.description ?? '')} onChangeValue={v => onChange('description', v)} placeholder='' />
			</LabeledField>
			<LabeledField label={commandsEditorS.fieldArgs}>
				<textarea
					value={argsText}
					onChange={e => onChange('args', e.target.value.split('\n').filter(s => s.length > 0))}
					rows={3}
					className='w-full font-mono text-xs bg-vibe-bg-2 text-vibe-fg-1 border border-vibe-border-3 rounded p-2'
				/>
			</LabeledField>
			<LabeledField label={commandsEditorS.fieldCwd} error={issues.cwd}>
				<VibeSimpleInputBox value={String(cmd.cwd ?? '')} onChangeValue={v => onChange('cwd', v)} placeholder='' />
			</LabeledField>
			<LabeledField label={commandsEditorS.fieldEnv}>
				<textarea
					value={envText}
					onChange={e => {
						const next: Record<string, string> = {};
						for (const line of e.target.value.split('\n')) {
							const eq = line.indexOf('=');
							if (eq > 0) {
								next[line.slice(0, eq).trim()] = line.slice(eq + 1);
							}
						}
						onChange('env', next);
					}}
					rows={3}
					className='w-full font-mono text-xs bg-vibe-bg-2 text-vibe-fg-1 border border-vibe-border-3 rounded p-2'
				/>
			</LabeledField>
			<div className='flex items-center gap-4'>
				<LabeledSwitch label={commandsEditorS.fieldPinned} value={cmd.pinned === true} onChange={v => onChange('pinned', v)} />
				<LabeledSwitch label={commandsEditorS.fieldSingleton} value={cmd.singleton === true} onChange={v => onChange('singleton', v)} />
				<LabeledSwitch label={commandsEditorS.fieldConfirm} value={cmd.confirm === true} onChange={v => onChange('confirm', v)} />
			</div>
			<div className='mt-2'>
				<VibeButtonBgDarken onClick={onDelete}>{commandsEditorS.deleteCommand}</VibeButtonBgDarken>
			</div>
		</div>
	);
};

const LabeledField: React.FC<{ label: string; error?: string; children: React.ReactNode }> = ({ label, error, children }) => (
	<label className='flex flex-col gap-1'>
		<span className='text-vibe-fg-3 text-xs'>{label}</span>
		{children}
		{error ? <span className='text-vibe-warning-fg text-xs'>{error}</span> : null}
	</label>
);

const LabeledSwitch: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({ label, value, onChange }) => (
	<label className='flex items-center gap-2'>
		<VibeSwitch value={value} onChange={onChange} />
		<span className='text-vibe-fg-2 text-xs'>{label}</span>
	</label>
);
