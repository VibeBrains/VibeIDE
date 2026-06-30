/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { IVibeProviderCapabilityService } from './vibeProviderCapabilityService.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import {
	buildNextEditPrompt,
	parseNextEditCompletion,
	type EditWindowContext,
	type RecentEdit,
} from './nextEditLLMPrompt.js';
import {
	detectCursorJumpTheme,
	trimEditLog,
	type EditEvent,
} from './cursorJumpThemeDetector.js';
import {
	buildNextEditGhostText,
	pickBestJumpCandidate,
	type JumpCandidate,
} from './nextEditGhostText.js';

export interface NextEditPrediction {
	filePath: string;
	lineNumber: number;
	predictedEdit: string;
	confidence: number;
	taskContext?: string;
	/** 1-based column where the ghost text replaces (rename mode). */
	startColumn?: number;
	/** Short label describing the suggested next edit (e.g. "Next rename → fooBar"). */
	hintLabel?: string;
}

export const IVibeNextEditPredictionService = createDecorator<IVibeNextEditPredictionService>('vibeNextEditPredictionService');

export interface IVibeNextEditPredictionService {
	readonly _serviceBrand: undefined;

	isAvailable(): boolean;

	predict(filePath: string, line: number, taskContext?: string): Promise<NextEditPrediction | null>;

	recordAcceptance(prediction: NextEditPrediction): void;

	readonly onPredictionReady: Event<NextEditPrediction>;
}

const MAX_EDIT_LOG_ENTRIES = 64;
const MAX_RENAME_IDENT_CHARS = 64;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const LLM_TIMEOUT_MS = 12_000;
const LLM_MAX_CONTEXT_LINES = 60;
const LLM_MAX_CONTEXT_CHARS = 4000;
/** Skip snapshot-based diff classification for files larger than this. */
const MAX_SNAPSHOT_BYTES = 200_000;

class VibeNextEditPredictionService extends Disposable implements IVibeNextEditPredictionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onPredictionReady = this._register(new Emitter<NextEditPrediction>());
	readonly onPredictionReady = this._onPredictionReady.event;

	private _capabilityCache: { modelId: string; capable: boolean } | null = null;

	private readonly _editLog: EditEvent[] = [];
	private _lastEdit: RecentEdit | null = null;
	private _activeRequestId: string | null = null;
	private readonly _decorationsByModelUri = new Map<string, string[]>();
	private readonly _previousContentByUri = new Map<string, string>();

	constructor(
		@IVibeProviderCapabilityService private readonly _capabilityService: IVibeProviderCapabilityService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@IModelService private readonly _modelService: IModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
	) {
		super();
		this._register(this._settingsService.onDidChangeState(() => {
			this._capabilityCache = null;
		}));
		this._registerEditLogWatcher();
	}

	isAvailable(): boolean {
		if (!this._settingsService.state.globalSettings.enableAutocomplete) {
			return false;
		}
		const modelSel = this._settingsService.state.modelSelectionOfFeature?.['Autocomplete'];
		const modelId = typeof modelSel === 'object' && modelSel !== null
			? (modelSel as { modelName?: string }).modelName ?? ''
			: '';

		if (!modelId) { return false; }

		if (this._capabilityCache?.modelId === modelId) {
			return this._capabilityCache.capable;
		}

		const capable = this._capabilityService.supports(modelId, 'nextEditPrediction')
			|| this._capabilityService.supports(modelId, 'extendedThinking');

		this._capabilityCache = { modelId, capable };
		vibeLog.debug('NextEdit', `capability probe for ${modelId}: ${capable}`);
		return capable;
	}

	async predict(filePath: string, line: number, taskContext?: string): Promise<NextEditPrediction | null> {
		if (!this.isAvailable()) { return null; }

		// L1026: theme-based jump first — if user is in the middle of a coherent
		// rename/signature-change streak, we can predict the next site cheaply
		// without an LLM round-trip.
		const themePrediction = this._tryThemePrediction(filePath, taskContext);
		if (themePrediction) {
			this._emitAndRender(themePrediction);
			return themePrediction;
		}

		// L1025: fall back to LLM-driven prediction.
		const llmPrediction = await this._tryLLMPrediction(filePath, line, taskContext);
		if (llmPrediction) {
			this._emitAndRender(llmPrediction);
			return llmPrediction;
		}

		return null;
	}

	recordAcceptance(prediction: NextEditPrediction): void {
		vibeLog.debug('NextEdit', `accepted at ${prediction.filePath}:${prediction.lineNumber} (confidence=${prediction.confidence})`);
		this._clearDecorationsForUri(prediction.filePath);
	}

	// -----------------------------------------------------------------------
	// Edit-log tracking
	// -----------------------------------------------------------------------

	private _registerEditLogWatcher(): void {
		this._register(this._modelService.onModelAdded(model => {
			const store = new DisposableStore();
			const uriStr = model.uri.toString();
			// Seed snapshot for the rename-heuristic. Skip large files to bound memory.
			const initialValue = model.getValue();
			if (initialValue.length <= MAX_SNAPSHOT_BYTES) {
				this._previousContentByUri.set(uriStr, initialValue);
			}
			store.add(model.onDidChangeContent(e => {
				if (e.changes.length === 0) { return; }
				const change = e.changes[0];
				const previous = this._previousContentByUri.get(uriStr);
				const oldText = (previous && change.rangeLength > 0)
					? previous.substr(change.rangeOffset, change.rangeLength)
					: '';
				const newText = change.text ?? '';
				const event = this._classifyEdit(model.uri, oldText, newText);
				this._appendEditEvent(event);
				this._lastEdit = {
					fileUri: uriStr,
					oldText: oldText.slice(0, 400),
					newText: newText.slice(0, 400),
					atOffsetMs: 0,
				};
				// Re-snapshot for the NEXT change (still bounded).
				const nextValue = model.getValue();
				if (nextValue.length <= MAX_SNAPSHOT_BYTES) {
					this._previousContentByUri.set(uriStr, nextValue);
				} else {
					this._previousContentByUri.delete(uriStr);
				}
			}));
			store.add(model.onWillDispose(() => {
				this._previousContentByUri.delete(uriStr);
				store.dispose();
			}));
			this._register(store);
		}));
		this._register(this._modelService.onModelRemoved(model => {
			this._previousContentByUri.delete(model.uri.toString());
		}));
	}

	private _classifyEdit(uri: URI, oldText: string, newText: string): EditEvent {
		const ts = Date.now();
		const stripped = newText.trim();
		const old = oldText.trim();
		// Heuristic: small identifier swap = rename.
		if (
			old.length > 0 && old.length <= MAX_RENAME_IDENT_CHARS
			&& stripped.length > 0 && stripped.length <= MAX_RENAME_IDENT_CHARS
			&& IDENTIFIER_RE.test(old) && IDENTIFIER_RE.test(stripped)
			&& old !== stripped
		) {
			return {
				timestamp: ts,
				fileUri: uri.toString(),
				kind: 'rename',
				subject: old,
				subjectReplacement: stripped,
			};
		}
		// Heuristic: edit inside a function signature — detected only when both
		// sides include parentheses with comma-separated args. Best-effort.
		if (/\([^)]*,[^)]*\)/.test(newText) || /\([^)]*,[^)]*\)/.test(oldText)) {
			const subjectMatch = newText.match(/([A-Za-z_$][\w$]*)\s*\(/);
			if (subjectMatch) {
				return {
					timestamp: ts,
					fileUri: uri.toString(),
					kind: 'signature-change',
					subject: subjectMatch[1],
				};
			}
		}
		return { timestamp: ts, fileUri: uri.toString(), kind: 'other' };
	}

	private _appendEditEvent(event: EditEvent): void {
		this._editLog.push(event);
		// Cap by both count and time window.
		if (this._editLog.length > MAX_EDIT_LOG_ENTRIES) {
			this._editLog.splice(0, this._editLog.length - MAX_EDIT_LOG_ENTRIES);
		}
		const trimmed = trimEditLog(this._editLog, Date.now());
		if (trimmed.length !== this._editLog.length) {
			this._editLog.length = 0;
			this._editLog.push(...trimmed);
		}
	}

	// -----------------------------------------------------------------------
	// Theme-based prediction
	// -----------------------------------------------------------------------

	private _tryThemePrediction(filePath: string, taskContext: string | undefined): NextEditPrediction | null {
		const theme = detectCursorJumpTheme(this._editLog);
		if (theme.kind !== 'theme-detected') { return null; }

		const recentlyTouchedUris = this._collectRecentlyTouchedUris();
		const excludedUris = new Set<string>([URI.file(filePath).toString()]);
		const candidates = this._gatherCandidates(theme.subject);
		if (candidates.length === 0) { return null; }

		const best = pickBestJumpCandidate(candidates, recentlyTouchedUris, excludedUris);
		if (!best) { return null; }

		const ghost = buildNextEditGhostText(
			theme.theme === 'rename'
				? { kind: 'rename', subject: theme.subject, subjectReplacement: theme.subjectReplacement }
				: { kind: 'signature-change', subject: theme.subject },
			best,
		);
		if (!ghost.ghostText && !ghost.hintLabel) { return null; }

		return {
			filePath: URI.parse(best.uri).fsPath,
			lineNumber: best.line,
			predictedEdit: ghost.ghostText,
			confidence: Math.min(0.95, 0.5 + theme.eventCount * 0.1),
			taskContext,
			startColumn: ghost.startColumn,
			hintLabel: ghost.hintLabel,
		};
	}

	private _collectRecentlyTouchedUris(): string[] {
		const seen = new Set<string>();
		const ordered: string[] = [];
		for (let i = this._editLog.length - 1; i >= 0; i--) {
			const uri = this._editLog[i].fileUri;
			if (seen.has(uri)) { continue; }
			seen.add(uri);
			ordered.push(uri);
		}
		return ordered;
	}

	private _gatherCandidates(subject: string): JumpCandidate[] {
		if (!subject) { return []; }
		const matchRe = new RegExp(`\\b${escapeRegExp(subject)}\\b`);
		const out: JumpCandidate[] = [];
		for (const m of this._modelService.getModels()) {
			const lines = m.getLinesContent();
			for (let i = 0; i < lines.length; i++) {
				if (matchRe.test(lines[i])) {
					out.push({
						uri: m.uri.toString(),
						line: i + 1,
						matchText: subject,
						lineContext: lines[i].slice(0, 200),
					});
					break; // first match per file is enough for ranking
				}
			}
		}
		return out;
	}

	// -----------------------------------------------------------------------
	// LLM-based prediction
	// -----------------------------------------------------------------------

	private async _tryLLMPrediction(filePath: string, line: number, taskContext: string | undefined): Promise<NextEditPrediction | null> {
		const featureName = 'Autocomplete' as const;
		const modelSelection = this._settingsService.resolveAutoModelSelection(
			this._settingsService.state.modelSelectionOfFeature[featureName]
		);
		if (!modelSelection || modelSelection.providerName === 'auto') {
			vibeLog.debug('vibeNextEditPrediction', localize('vibeide.nextEdit.noModel', '[VibeIDE NextEdit] модель для функции Autocomplete не определена'));
			return null;
		}

		const targetUri = this._matchModelUriByPath(filePath);
		if (!targetUri) { return null; }
		const model = this._modelService.getModel(targetUri);
		if (!model) { return null; }

		const window = this._buildEditWindowContext(model.uri, line, model.getLinesContent());
		if (!window) { return null; }

		const prompt = buildNextEditPrompt({
			currentWindow: window,
			lastEdit: this._lastEdit ?? undefined,
			maxContextChars: LLM_MAX_CONTEXT_CHARS,
			modelHint: 'chat',
		});

		// Abort any in-flight prediction before starting a new one.
		if (this._activeRequestId) {
			this._llmMessageService.abort(this._activeRequestId);
			this._activeRequestId = null;
		}

		const candidate = await new Promise<NextEditPrediction | null>((resolve) => {
			let resolved = false;
			let lastText = '';
			const settle = (value: NextEditPrediction | null) => {
				if (resolved) { return; }
				resolved = true;
				this._activeRequestId = null;
				clearTimeout(timeoutHandle);
				resolve(value);
			};

			const timeoutHandle = setTimeout(() => {
				if (this._activeRequestId) {
					this._llmMessageService.abort(this._activeRequestId);
				}
				vibeLog.debug('NextEdit', 'LLM request timed out');
				settle(null);
			}, LLM_TIMEOUT_MS);

			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: prompt.userPrompt }],
				separateSystemMessage: prompt.systemPrompt || undefined,
				chatMode: null,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				logging: { loggingName: 'NextEditPrediction' },
				onText: ({ fullText }) => {
					lastText = fullText;
				},
				onFinalMessage: ({ fullText }) => {
					const parsed = parseNextEditCompletion(fullText || lastText, window.fileUri);
					if (parsed.kind !== 'ok') {
						vibeLog.debug('NextEdit', `LLM parse failed: ${parsed.kind === 'shape-mismatch' ? parsed.reason : parsed.kind}`);
						settle(null);
						return;
					}
					const targetLine = Math.max(1, window.cursorLine0 + 1 + parsed.candidate.lineDelta);
					const targetCol = Math.max(1, window.cursorColumn0 + 1 + parsed.candidate.columnDelta);
					settle({
						filePath: URI.parse(parsed.candidate.fileUri).fsPath,
						lineNumber: targetLine,
						predictedEdit: parsed.candidate.insertion,
						confidence: 0.7,
						taskContext,
						startColumn: targetCol,
						hintLabel: localize('vibeide.nextEdit.suggestedLabel', 'Предлагаемое следующее изменение'),
					});
				},
				onError: ({ message }) => {
					vibeLog.debug('NextEdit', `LLM error: ${message}`);
					settle(null);
				},
				onAbort: () => settle(null),
			});
			this._activeRequestId = requestId;
		});

		return candidate;
	}

	private _matchModelUriByPath(filePath: string): URI | null {
		// Prefer exact file-URI match; fall back to path-tail match for cases
		// where the caller passed a workspace-relative path.
		const target = URI.file(filePath);
		const exact = this._modelService.getModel(target);
		if (exact) { return target; }
		for (const m of this._modelService.getModels()) {
			if (m.uri.fsPath === filePath || m.uri.path.endsWith(filePath)) {
				return m.uri;
			}
		}
		return null;
	}

	private _buildEditWindowContext(uri: URI, line: number, allLines: string[]): EditWindowContext | null {
		const total = allLines.length;
		if (total === 0) { return null; }
		const cursor = Math.max(1, Math.min(line, total));
		const half = Math.floor(LLM_MAX_CONTEXT_LINES / 2);
		const startLine = Math.max(1, cursor - half);
		const endLine = Math.min(total, cursor + half);
		const contextLines = allLines.slice(startLine - 1, endLine);
		return {
			fileUri: uri.toString(),
			languageId: this._modelService.getModel(uri)?.getLanguageId() ?? '',
			contextLines,
			cursorLine0: cursor - startLine,
			cursorColumn0: 0,
		};
	}

	// -----------------------------------------------------------------------
	// Ghost-text rendering
	// -----------------------------------------------------------------------

	private _emitAndRender(prediction: NextEditPrediction): void {
		this._onPredictionReady.fire(prediction);
		if (!prediction.predictedEdit || prediction.predictedEdit.length === 0) { return; }
		this._renderGhostText(prediction);
	}

	private _renderGhostText(prediction: NextEditPrediction): void {
		const targetUri = this._matchModelUriByPath(prediction.filePath);
		if (!targetUri) { return; }
		const model = this._modelService.getModel(targetUri);
		if (!model) { return; }
		const totalLines = model.getLineCount();
		if (prediction.lineNumber < 1 || prediction.lineNumber > totalLines) { return; }

		const lineContent = model.getLineContent(prediction.lineNumber);
		const col = prediction.startColumn ?? (lineContent.length + 1);
		const range = new Range(prediction.lineNumber, col, prediction.lineNumber, col);

		const newDecorations: IModelDeltaDecoration[] = [{
			range,
			options: {
				description: 'vibeide-next-edit-ghost',
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				after: {
					content: prediction.predictedEdit,
					inlineClassName: 'vibeide-next-edit-ghost-text',
				},
			},
		}];

		const uriStr = model.uri.toString();
		const old = this._decorationsByModelUri.get(uriStr) ?? [];
		const newIds = model.deltaDecorations(old, newDecorations);
		this._decorationsByModelUri.set(uriStr, newIds);
	}

	private _clearDecorationsForUri(filePath: string): void {
		const targetUri = this._matchModelUriByPath(filePath);
		if (!targetUri) { return; }
		const model = this._modelService.getModel(targetUri);
		if (!model) { return; }
		const uriStr = model.uri.toString();
		const old = this._decorationsByModelUri.get(uriStr);
		if (!old || old.length === 0) { return; }
		model.deltaDecorations(old, []);
		this._decorationsByModelUri.delete(uriStr);
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

registerSingleton(IVibeNextEditPredictionService, VibeNextEditPredictionService, InstantiationType.Delayed);
