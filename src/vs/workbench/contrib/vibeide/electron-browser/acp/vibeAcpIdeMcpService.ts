/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's MCP server for external agents, from the window's side
 *
 * The socket is in the main process (`electron-main/acp/vibeAcpIdeMcpMainService.ts`). A tool call comes from there as
 * an event for the window that issued the token, and is answered here with what this window's editor shows: the
 * open file with the unsaved edits, the selection, the tabs, the markers of the language servers
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isEqual, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { isCodeEditor, isDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IVibeIgnoreService } from '../../browser/vibeIgnoreService.js';
import { editorWorkingSet } from '../../browser/editorWorkingSet.js';
import { ACP_EMBED_MAX_CHARS_DEFAULT, ACP_EMBED_MAX_CHARS_KEY } from '../../common/acp/acpPromptContext.js';
import { ACP_IDE_TOOLS_KEY } from '../../common/acp/acpRegistryConfiguration.js';
import {
	IDE_TOOL_OPEN_FILE,
	IDE_TOOL_PROBLEMS,
	IIdeEditorFacts,
	IIdeMcpToolResult,
	IIdeProblem,
	IdeProblemsOutcome,
	formatOpenFile,
	formatProblems,
} from '../../common/acp/acpIdeMcp.js';
import { IIdeMcpCall, IIdeMcpIssued, IVibeAcpIdeMcpMain, VIBE_ACP_IDE_MCP_CHANNEL } from '../../common/acp/acpIdeMcpTypes.js';
import { JsonValue } from '../../common/acp/acpProtocol.js';
import { IVibeAcpIdeMcpService } from '../../common/acp/vibeAcpIdeMcpService.js';
import { ISecretDetectionService } from '../../common/secretDetectionService.js';
import { vibeLog } from '../../common/vibeLog.js';

export class VibeAcpIdeMcpService extends Disposable implements IVibeAcpIdeMcpService {
	declare readonly _serviceBrand: undefined;

	private readonly _main: IVibeAcpIdeMcpMain;
	/** New on every load of the window, so the main process can tell this instance from the one before a reload */
	private readonly _instanceId = generateUuid();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@INativeHostService private readonly _nativeHost: INativeHostService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibeIgnoreService private readonly _ignore: IVibeIgnoreService,
		@ISecretDetectionService private readonly _secrets: ISecretDetectionService,
	) {
		super();
		this._main = ProxyChannel.toService<IVibeAcpIdeMcpMain>(mainProcessService.getChannel(VIBE_ACP_IDE_MCP_CHANNEL));
		// Every window hears every call; only the instance the token was issued to answers
		this._register(this._main.onToolCall(call => {
			if (call.instanceId === this._instanceId) { void this._answer(call); }
		}));
	}

	async issue(): Promise<IIdeMcpIssued | undefined> {
		if (this._configuration.getValue<boolean>(ACP_IDE_TOOLS_KEY) === false) { return undefined; }
		return this._main.issue(this._nativeHost.windowId, this._instanceId);
	}

	revoke(token: string): Promise<void> {
		return this._main.revoke(token);
	}

	private async _answer(call: IIdeMcpCall): Promise<void> {
		let result: IIdeMcpToolResult;
		try {
			result = this._run(call.tool, call.args);
		} catch (err) {
			vibeLog.warn('ACP', `инструмент редактора ${call.tool} не отработал: ${err instanceof Error ? err.message : String(err)}`);
			result = { text: `Не удалось прочитать редактор: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
		await this._main.completeToolCall(call.callId, result);
	}

	private _run(tool: string, args: Record<string, JsonValue>): IIdeMcpToolResult {
		// The text leaves the machine for the agent's vendor: a key in the open file is masked the way it is in the prompt
		const redact = (text: string) => this._secrets.detectSecrets(text).redactedText;
		switch (tool) {
			case IDE_TOOL_OPEN_FILE: {
				const maxChars = this._configuration.getValue<number>(ACP_EMBED_MAX_CHARS_KEY) ?? ACP_EMBED_MAX_CHARS_DEFAULT;
				return { text: formatOpenFile(this._editorFacts(), maxChars, redact) };
			}
			case IDE_TOOL_PROBLEMS:
				return { text: redact(formatProblems(this._problems(typeof args['path'] === 'string' ? args['path'] : undefined))) };
			default:
				return { text: `Неизвестный инструмент: ${tool}`, isError: true };
		}
	}

	private _editorFacts(): IIdeEditorFacts {
		// A diff shows two editors, and the one the person edits is the modified side
		const control = this._editorService.activeTextEditorControl;
		const editor = isCodeEditor(control) ? control : isDiffEditor(control) ? control.getModifiedEditor() : undefined;
		const model = editor?.getModel();
		const workingSet = editorWorkingSet(this._editorService, this._modelService, 'tabs');
		const isOpenable = (uri: URI) => uri.scheme === Schemas.file && !this._ignore.isIgnored(uri);

		const activeUri = model && isOpenable(model.uri) ? model.uri : undefined;
		const otherTabs = workingSet.openFiles
			.filter(uri => isOpenable(uri) && !(activeUri && isEqual(uri, activeUri)))
			.map(uri => uri.fsPath);
		if (!editor || !model || !activeUri) {
			return { otherTabs };
		}
		const selection = editor.getSelection();
		const selected = selection && !selection.isEmpty()
			? {
				// A selection that ends at the start of a line does not include that line
				startLine: selection.startLineNumber,
				endLine: selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber,
				text: model.getValueInRange(selection),
			}
			: undefined;
		return {
			activeFile: { path: activeUri.fsPath, languageId: model.getLanguageId(), text: model.getValue(), ...(selected ? { selection: selected } : {}) },
			otherTabs,
		};
	}

	private _problems(path: string | undefined): IdeProblemsOutcome {
		const uri = path ? this._resolve(path) : editorWorkingSet(this._editorService, this._modelService, 'tabs').activeFile;
		if (!uri || uri.scheme !== Schemas.file) {
			return { kind: 'noFile' };
		}
		if (this._ignore.isIgnored(uri)) {
			return { kind: 'closed', path: uri.fsPath };
		}
		const model = this._modelService.getModel(uri);
		const isOpen = editorWorkingSet(this._editorService, this._modelService, 'tabs').openFiles.some(open => isEqual(open, uri));
		if (!isOpen || !model) {
			return { kind: 'notOpen', path: uri.fsPath };
		}
		const problems: IIdeProblem[] = [];
		for (const marker of this._markerService.read({ resource: uri })) {
			const severity = marker.severity === MarkerSeverity.Error ? 'error' : marker.severity === MarkerSeverity.Warning ? 'warning' : marker.severity === MarkerSeverity.Info ? 'info' : undefined;
			// A hint is not something the person sees as a problem
			if (!severity) { continue; }
			const lineText = marker.startLineNumber >= 1 && marker.startLineNumber <= model.getLineCount() ? model.getLineContent(marker.startLineNumber) : '';
			problems.push({ line: marker.startLineNumber, severity, message: marker.message, ...(marker.source ? { source: marker.source } : {}), lineText });
		}
		problems.sort((a, b) => a.line - b.line);
		return { kind: 'found', path: uri.fsPath, problems };
	}

	/** A path as the agent writes it: absolute, or from the root of the first folder */
	private _resolve(path: string): URI | undefined {
		if (/^([a-zA-Z]:[\\/]|\/)/.test(path)) {
			return URI.file(path);
		}
		const root = this._workspace.getWorkspace().folders[0]?.uri;
		return root ? joinPath(root, path) : undefined;
	}
}

registerSingleton(IVibeAcpIdeMcpService, VibeAcpIdeMcpService, InstantiationType.Delayed);
