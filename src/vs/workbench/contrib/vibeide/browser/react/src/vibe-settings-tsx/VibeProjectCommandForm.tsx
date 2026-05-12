/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — standalone form (Add or Edit a single command).
 *
 * Mounted by `VibeProjectCommandFormPane` as a full editor surface (looks like
 * a modal pane). Self-contained: reads existing commands snapshot from
 * `IVibeCustomCommandsService`, writes through `IFileService`, closes itself
 * via the `close` command passed in `props`.
 *
 * Pure validation and serialisation live in `projectCommandsAddFormPolicy`
 * (`validateAddCommandDraft`, `buildProjectCommandFromDraft`,
 * `appendCommandToFile`, `replaceCommandInFile`). The component is a thin
 * controller around those helpers.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeButtonBgDarken } from '../util/inputs.js';
import { joinPath } from '../../../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';
import {
	ADD_COMMAND_DRAFT_EMPTY,
	ADD_COMMAND_ERROR,
	AddCommandDraft,
	appendCommandToFile,
	buildProjectCommandFromDraft,
	previewProjectCommandJson,
	replaceCommandInFile,
	validateAddCommandDraft,
} from '../../../../common/projectCommandsAddFormPolicy.js';
import {
	decodeProjectCommandsFile,
	ProjectCommandTerminal,
	ProjectCommandsFile,
} from '../../../../common/projectCommandsTypes.js';
import { safeParseConfigJson } from '../../../../common/vibeConfigJsonParser.js';
import { workspaceS } from './vibeSettingsRu.js';

export type VibeProjectCommandFormMode = 'add' | 'edit';

export interface VibeProjectCommandFormProps {
	readonly mode: VibeProjectCommandFormMode;
	/** For edit: the original id (immutable in the form). For add: empty. */
	readonly commandIdForEdit?: string;
	/** Prefilled draft (edit mode). Undefined for add ⇒ use ADD_COMMAND_DRAFT_EMPTY. */
	readonly initialDraft?: AddCommandDraft;
}

export const VibeProjectCommandForm: React.FC<VibeProjectCommandFormProps> = (props) => {
	const accessor = useAccessor();
	const commands = accessor.get('IVibeCustomCommandsService');
	const fileService = accessor.get('IFileService');
	const workspace = accessor.get('IWorkspaceContextService');
	const notifications = accessor.get('INotificationService');
	const commandService = accessor.get('ICommandService');

	const { mode, commandIdForEdit } = props;
	const isEdit = mode === 'edit';

	const [draft, setDraft] = useState<AddCommandDraft>(props.initialDraft ?? ADD_COMMAND_DRAFT_EMPTY);
	const [saveBusy, setSaveBusy] = useState(false);

	// Snapshot of existing ids — used for duplicate validation in add mode.
	// In edit mode we exclude the current id from the duplicate check so the
	// user can rename a command (changing id ⇒ "new" id is verified against
	// the rest of the set).
	const [snapshot, setSnapshot] = useState(() => commands.getCommands());
	useEffect(() => {
		const d = commands.onDidChangeCommands(e => setSnapshot(e.commands));
		return () => d.dispose();
	}, [commands]);

	const existingIds = useMemo(() => {
		const s = new Set(snapshot.map(c => c.id));
		if (isEdit && commandIdForEdit) s.delete(commandIdForEdit);
		return s;
	}, [snapshot, isEdit, commandIdForEdit]);

	const validation = useMemo(() => validateAddCommandDraft(draft, existingIds), [draft, existingIds]);

	const previewCommand = useMemo(() => {
		if (!draft.id.trim() || !draft.name.trim() || !draft.command.trim()) return null;
		try { return buildProjectCommandFromDraft(draft); } catch { return null; }
	}, [draft]);

	const errLabel = useCallback((code: string | null): string | null => {
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

	const closeEditor = useCallback(async () => {
		try {
			await commandService.executeCommand('workbench.action.closeActiveEditor');
		} catch { /* ignore */ }
	}, [commandService]);

	const onSave = useCallback(async () => {
		if (!validation.isValid || saveBusy) return;
		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({ severity: 2 /* Warning */, message: workspaceS.pcAddNoWorkspace });
			return;
		}
		setSaveBusy(true);
		try {
			const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
			let existing: ProjectCommandsFile = { vibeVersion: '1.0.0', commands: [] };
			try {
				const buf = await fileService.readFile(commandsUri);
				const parsed = safeParseConfigJson(buf.value.toString());
				if (parsed.ok) {
					const decoded = decodeProjectCommandsFile(parsed.value);
					if (decoded.ok) existing = decoded.value;
				}
			} catch {
				// File missing — start fresh below.
			}
			const newCmd = buildProjectCommandFromDraft(draft);
			let serialized: string;
			if (isEdit && commandIdForEdit) {
				const replaced = replaceCommandInFile(existing, commandIdForEdit, newCmd);
				if (!replaced) {
					notifications.notify({ severity: 2 /* Warning */, message: workspaceS.pcEditMissing });
					setSaveBusy(false);
					return;
				}
				serialized = replaced.serialized;
			} else {
				serialized = appendCommandToFile(existing, newCmd).serialized;
			}
			await fileService.writeFile(commandsUri, VSBuffer.fromString(serialized));
			await commands.reload();
			notifications.notify({
				severity: 3 /* Info */,
				message: isEdit ? workspaceS.pcEditDone(newCmd.name) : workspaceS.pcAddDone(newCmd.name),
			});
			await closeEditor();
		} catch (e) {
			notifications.notify({
				severity: 1 /* Error */,
				message: workspaceS.pcSaveFailed(String((e as Error)?.message ?? e)),
			});
		} finally {
			setSaveBusy(false);
		}
	}, [validation.isValid, saveBusy, workspace, notifications, fileService, draft, isEdit, commandIdForEdit, commands, closeEditor]);

	const updateField = <K extends keyof AddCommandDraft>(key: K, value: AddCommandDraft[K]) => {
		setDraft(d => ({ ...d, [key]: value }));
	};

	const labelCls = 'text-xs text-vibe-fg-2';
	const hintCls = 'text-[10px] text-vibe-fg-3';
	const errCls = 'text-[10px] text-red-400';
	// Command-center search style: shared shell sets bg / border / corner radius
	// from VS Code design tokens; inner <input> is transparent so the wrapper
	// owns the look. Inner sizing keeps the chat-search rhythm: px-2 py-1, text-xs.
	const fieldShellCls = 'flex items-center gap-1.5 px-2 py-1 @@vibe-command-center-search';
	const fieldInputCls = 'flex-1 bg-transparent text-xs text-vibe-fg-2 outline-none placeholder:text-vibe-fg-4 min-w-0';

	// Field row factory — keeps the markup uniform: label on its own line, then
	// the wrapped input, then either an error or a hint. Each row is a top-level
	// child of the main column, so the form is strictly vertical.
	const renderField = (
		key: keyof AddCommandDraft,
		label: string,
		opts: {
			required?: boolean;
			placeholder?: string;
			disabled?: boolean;
			hint?: string;
			err?: string | null;
			textarea?: boolean;
		},
	) => {
		const id = `vibeide-pc-form-${String(key)}`;
		const value = (draft as any)[key] as string;
		const errMsg = errLabel(opts.err ?? null);
		return (
			<div className='flex flex-col gap-1'>
				<label htmlFor={id} className={labelCls}>{label}{opts.required ? ' *' : ''}</label>
				<div className={fieldShellCls}>
					{opts.textarea ? (
						<textarea
							id={id}
							className={`${fieldInputCls} min-h-[64px] font-mono resize-y`}
							value={value}
							disabled={opts.disabled}
							placeholder={opts.placeholder}
							onChange={e => updateField(key, e.target.value as AddCommandDraft[typeof key])}
							spellCheck={false}
						/>
					) : (
						<input
							id={id}
							type='text'
							className={fieldInputCls}
							value={value}
							disabled={opts.disabled}
							placeholder={opts.placeholder}
							onChange={e => updateField(key, e.target.value as AddCommandDraft[typeof key])}
						/>
					)}
				</div>
				{errMsg ? <span className={errCls}>{errMsg}</span> : opts.hint ? <span className={hintCls}>{opts.hint}</span> : null}
			</div>
		);
	};

	return (
		<div className='@@vibe-scope flex flex-col gap-3 max-w-2xl mx-auto px-6 py-5'>
			<div className='flex items-center justify-between'>
				<h2 className='text-base text-vibe-fg-1 font-medium'>
					{isEdit ? workspaceS.pcFormEditTitle(commandIdForEdit ?? '') : workspaceS.pcFormAddTitle}
				</h2>
				<button
					type='button'
					className='text-xs text-vibe-fg-3 hover:brightness-110 px-2 py-1 rounded @@vibe-command-center-search'
					onClick={() => { void closeEditor(); }}
				>{workspaceS.pcFormCancel}</button>
			</div>

			<p className='text-xs text-vibe-fg-3'>{workspaceS.pcFormIntro}</p>

			{renderField('id', workspaceS.pcFieldId, {
				required: true,
				placeholder: 'lint, deploy-dev',
				disabled: isEdit,
				hint: workspaceS.pcFieldIdHint,
				err: validation.errors.id,
			})}
			{renderField('name', workspaceS.pcFieldName, {
				required: true,
				placeholder: 'Run lint',
				err: validation.errors.name,
			})}
			{renderField('description', workspaceS.pcFieldDescription, {
				placeholder: workspaceS.pcFieldDescriptionPlaceholder,
			})}
			{renderField('command', workspaceS.pcFieldCommand, {
				required: true,
				placeholder: 'npm',
				err: validation.errors.command,
			})}
			{renderField('argsText', workspaceS.pcFieldArgs, {
				placeholder: 'run\nlint',
				hint: workspaceS.pcFieldArgsHint,
				textarea: true,
			})}
			{renderField('cwd', workspaceS.pcFieldCwd, {
				placeholder: workspaceS.pcFieldCwdPlaceholder,
				hint: workspaceS.pcFieldCwdHint,
				err: validation.errors.cwd,
			})}

			<div className='flex flex-col gap-1'>
				<label className={labelCls}>{workspaceS.pcFieldTerminal}</label>
				<div className={fieldShellCls}>
					<select
						className={`${fieldInputCls} appearance-none cursor-pointer`}
						value={draft.terminal ?? ''}
						onChange={e => updateField('terminal', e.target.value as ProjectCommandTerminal | '')}
					>
						<option value=''>{workspaceS.pcTerminalDefault}</option>
						<option value='integrated'>{workspaceS.pcTerminalIntegrated}</option>
						<option value='external'>{workspaceS.pcTerminalExternal}</option>
						<option value='background'>{workspaceS.pcTerminalBackground}</option>
					</select>
				</div>
			</div>

			<label className='flex items-center gap-2 cursor-pointer select-none text-xs text-vibe-fg-2 py-1'>
				<input
					type='checkbox'
					checked={draft.pinned}
					onChange={e => updateField('pinned', e.target.checked)}
				/>
				<span>{workspaceS.pcFieldPinned}</span>
			</label>

			{renderField('orderText', workspaceS.pcFieldOrder, {
				placeholder: '0',
				hint: workspaceS.pcFieldOrderHint,
				err: validation.errors.order,
			})}

			{previewCommand ? (
				<details className='@@vibe-chat-like-shell px-3 py-2 text-xs'>
					<summary className='cursor-pointer text-vibe-fg-2 select-none'>{workspaceS.pcFormPreviewToggle}</summary>
					<pre className='mt-2 max-h-48 overflow-auto font-mono text-[11px] text-vibe-fg-3 whitespace-pre-wrap border-t border-vibe-border-1 pt-2'>{previewProjectCommandJson(previewCommand)}</pre>
				</details>
			) : null}

			<div className='flex items-center gap-2 mt-2 border-t border-vibe-border-1 pt-3'>
				<VibeButtonBgDarken
					className='px-4 py-1.5 text-xs'
					onClick={() => { void onSave(); }}
					disabled={!validation.isValid || saveBusy}
				>
					{saveBusy
						? workspaceS.pcFormSaveBusy
						: (isEdit ? workspaceS.pcFormSaveEdit : workspaceS.pcFormSaveAdd)}
				</VibeButtonBgDarken>
				<button
					type='button'
					className='text-xs text-vibe-fg-3 hover:brightness-110 px-3 py-1.5'
					onClick={() => { void closeEditor(); }}
					disabled={saveBusy}
				>{workspaceS.pcFormCancel}</button>
				{!validation.isValid ? <span className='text-[10px] text-amber-400'>{workspaceS.pcFormHasErrors}</span> : null}
			</div>
		</div>
	);
};
