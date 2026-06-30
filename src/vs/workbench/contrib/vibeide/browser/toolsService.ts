/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { isAbsolute as pathIsAbsolute } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVibeConstraintsService, ConstraintViolationError } from '../common/vibeConstraintsService.js';
import { IVibeExternalAccessService, ExternalAccessRequiredError } from '../common/vibeExternalAccessService.js';
import { IVibePromptGuardService } from '../common/vibePromptGuardService.js';
import { IVibePerFilePermissionsService } from '../common/vibePerFilePermissionsService.js';
import { IVibeIgnoreService } from './vibeIgnoreService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { ITerminalToolService } from './terminalToolService.js';
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js';
import { IVibeideModelService } from '../common/vibeideModelService.js';
import { IRepoIndexerService } from './repoIndexerService.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { DocumentSymbol } from '../../../../editor/common/languages.js';
import { IVibeideCommandBarService } from './vibeideCommandBarService.js';
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { timeout } from '../../../../base/common/async.js';
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME, READ_FILE_DEFAULT_LINE_LIMIT, READ_FILE_LARGE_FILE_CHARS, READ_FILE_LARGE_FILE_WINDOW_CHARS, READ_FILE_MAX_LINE_LIMIT, ORIGINAL, DIVIDER, FINAL } from '../common/prompt/prompts.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRequestService, asJson, asTextOrError } from '../../../../platform/request/common/request.js';
import { IWebContentExtractorService } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { LRUCache } from '../../../../base/common/map.js';
import { OfflinePrivacyGate } from '../common/offlinePrivacyGate.js';
import { INLShellParserService } from '../common/nlShellParserService.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';

import { IVibeAgentTerritorialLockService } from './vibeAgentTerritorialLockService.js';
import { IAuditLogService } from '../common/auditLogService.js';

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { formatProvenanceMarker, shouldMarkProvenance } from '../common/vibeAiProvenanceConfiguration.js';
import { IGitAutoStashService } from '../common/gitAutoStashService.js';
import { decideAutoStash } from '../common/autoStashPolicy.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { detectShellMisuse, ToolValidationError, truncateHeadTail, looksLikeShellAwaitingInput, formatTerminalTimeoutNotice, clampLineWindowToCharBudget } from '../common/toolHardening.js';
import { IShellHardeningService } from './shellHardeningService.js';

// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] };
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>; interruptTool?: () => void }> };
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string };

/**
 * Permissive view over a single text-search result. Search backends have returned
 * slightly different shapes across versions (modern `rangeLocations` vs legacy
 * `range`/`rangeStart*`), so each field is optional and probed defensively at runtime.
 */
interface TextSearchResultProbe {
	preview?: { text?: string };
	rangeLocations?: { source?: { startLineNumber?: number; startColumn?: number } }[];
	rangeStartLineNumber?: number;
	rangeStartColumn?: number;
	range?: { startLineNumber?: number; startColumn?: number };
}

/** Subset of the DuckDuckGo Instant Answer API JSON response that the web-search tool reads. */
interface DuckDuckGoInstantAnswer {
	AbstractText?: string;
	Heading?: string;
	AbstractURL?: string;
	RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined';
};

const validateStr = (argName: string, value: unknown) => {
	if (value === null) { throw new Error(`Invalid LLM output: ${argName} was null.`); }
	if (typeof value !== 'string') { throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`); }
	return value;
};


/**
 * Validates a URI string and converts it to a URI object.
 * Now includes workspace validation for safety in Agent Mode.
 */
const validateURI = (uriStr: unknown, workspaceContextService?: IWorkspaceContextService, requireWorkspace: boolean = true, accessKind: 'read' | 'write' = 'read', isAllowedOutside?: (uri: URI) => boolean) => {
	if (uriStr === null) { throw new Error(`Invalid LLM output: uri was null.`); }
	if (typeof uriStr !== 'string') { throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`); }

	let uri: URI;
	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	if (uriStr.includes('://')) {
		try {
			uri = URI.parse(uriStr);
		} catch (e) {
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`);
		}
	} else {
		// No scheme present, treat as file path
		uri = URI.file(uriStr);

		// If we have a workspace and the path is relative, resolve against workspace root.
		// On Windows, absolute paths are like `D:\proj\...` — they do NOT start with `/`; without
		// an absolute-path check we'd join(workspaceRoot, fullPath) → doubled fsPath bug.
		if (workspaceContextService && !pathIsAbsolute(uriStr)) {
			const workspace = workspaceContextService.getWorkspace();
			if (workspace.folders.length > 0) {
				// Resolve relative path against workspace root
				uri = joinPath(workspace.folders[0].uri, uriStr);
			}
		}
		// If path is absolute (starts with /), check if it's actually within workspace
		// This handles cases where LLM returns paths like "/carepilot-api/src" that should be relative
		else if (workspaceContextService && uriStr.startsWith('/')) {
			const workspace = workspaceContextService.getWorkspace();
			for (const folder of workspace.folders) {
				const workspacePath = folder.uri.fsPath;
				// Check if the absolute path is actually within this workspace folder
				// by checking if workspace path is a prefix
				if (uriStr.startsWith(workspacePath)) {
					// Path is already correctly absolute within workspace
					break;
				}
				// Check if path starts with workspace folder name (common LLM mistake)
				const workspaceFolderName = folder.name || folder.uri.path.split('/').pop() || '';
				if (uriStr.startsWith(`/${workspaceFolderName}/`) || uriStr === `/${workspaceFolderName}`) {
					// Treat as relative path - remove leading slash and folder name
					const relativePath = uriStr.replace(`/${workspaceFolderName}`, '').replace(/^\//, '');
					uri = joinPath(folder.uri, relativePath);
					break;
				}
			}
		}
	}

	// Workspace-boundary enforcement. Whether reads/writes outside the open
	// workspace are allowed is config-driven (the caller passes the resolved
	// `requireWorkspace`); `accessKind` only selects which setting key the
	// denial message names, so the user can copy-paste it into Settings search.
	if (requireWorkspace && workspaceContextService) {
		const isInWorkspace = workspaceContextService.isInsideWorkspace(uri);
		// O.13 — a user-pre-authorized external folder (Variant A) bypasses the block. Otherwise
		// throw the TYPED error: the tool-dispatch layer (Variant B) catches it, prompts the user
		// async, and re-validates on approval. Uncaught → access is denied (fail-closed).
		if (!isInWorkspace && !isAllowedOutside?.(uri)) {
			throw new ExternalAccessRequiredError(uri, accessKind);
		}
	}

	return uri;
};

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) { return null; }
	return validateStr(argName, str);
};


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) { return 1; }
	const parsedInt = Number.parseInt(pageNumberUnknown + '');
	if (!Number.isInteger(parsedInt)) { throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`); }
	if (parsedInt < 1) { throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`); }
	return parsedInt;
};

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number') { return numStr; }
	if (isFalsy(numStr)) { return opts.default; }

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '');
		if (!Number.isInteger(parsedInt)) { return opts.default; }
		return parsedInt;
	}

	return opts.default;
};

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) { throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`); }
	const terminalId = terminalIdUnknown + '';
	return terminalId;
};

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') { return true; }
		if (b === 'false') { return false; }
	}
	if (typeof b === 'boolean') {
		return b;
	}
	return opts.default;
};


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim();
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) { return true; }
	return false;
};

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	private readonly _webSearchCache = new LRUCache<string, { results: Array<{ title: string; snippet: string; url: string }>; timestamp: number }>(100);
	private readonly _browseCache = new LRUCache<string, { content: string; title?: string; url: string; metadata?: { publishedDate?: string }; timestamp: number }>(100);
	private readonly _cacheTTL = 60 * 60 * 1000; // 1 hour
	private readonly _offlineGate: OfflinePrivacyGate;
	// Tracks which files were read in this session so edit_file can require a prior read
	// (Claude-Code-style "must read before edit" guard). Persists for the lifetime of the singleton.
	private readonly _filesReadInSession = new Set<string>();
	// Tracks pending background commands so kill_background_command can address them.
	private readonly _backgroundCommands = new Map<string, { persistentTerminalId: string; command: string; startedAt: number }>();

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVibeideModelService vibeideModelService: IVibeideModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVibeideCommandBarService private readonly commandBarService: IVibeideCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@INotificationService private readonly notificationService: INotificationService,
		@IRequestService private readonly requestService: IRequestService,
		@IWebContentExtractorService private readonly webContentExtractorService: IWebContentExtractorService,
		@IRepoIndexerService private readonly repoIndexerService: IRepoIndexerService,
		@INLShellParserService private readonly nlShellParserService: INLShellParserService,
		@ISecretDetectionService private readonly secretDetectionService: ISecretDetectionService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IVibeConstraintsService private readonly vibeConstraintsService: IVibeConstraintsService,
		@IVibePromptGuardService private readonly vibePromptGuardService: IVibePromptGuardService,
		@IVibePerFilePermissionsService private readonly vibePermissionsService: IVibePerFilePermissionsService,
		@IVibeAgentTerritorialLockService private readonly _agentTerritorialLockService: IVibeAgentTerritorialLockService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IGitAutoStashService private readonly _gitAutoStashService: IGitAutoStashService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IShellHardeningService private readonly _shellHardeningService: IShellHardeningService,
		@IVibeExternalAccessService private readonly _externalAccess: IVibeExternalAccessService,
		@IVibeIgnoreService vibeIgnoreService: IVibeIgnoreService,
	) {
		this._offlineGate = new OfflinePrivacyGate();
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		// Time-cap a fileSearch so a best-effort "locate this file by basename" lookup on a
		// hallucinated/missing path can't hang the Extension Host scanning a huge repo with an
		// uncancellable search. model-stalls #013: read_file on a non-existent path froze the EH
		// ~9.4 min via `fileSearch(..., CancellationToken.None)`. On OUR timeout it returns the
		// partial result if the backend yields one, or an empty result if the backend throws on
		// cancellation — either way the caller treats it as "not found" and fails fast.
		// Scan time-budget (ms), user-configurable via `vibeide.agent.scanTimeoutMs`. Shared by the
		// broad file-search tools (glob / search_pathnames_only) and get_dir_tree. Clamped defensively.
		const scanTimeoutMs = () => Math.max(1_000, Math.min(120_000, this._configurationService.getValue<number>('vibeide.agent.scanTimeoutMs') ?? 10_000));

		// Search-backend (ripgrep) hardening: rg can fail INTERMITTENTLY even when present — a
		// realtime AV/EDR scan holds a lock on rg.exe and the spawn throws `ENOENT` (observed on a
		// corporate machine in a clean session). Two defenses, both config-driven (no hardcode):
		//   (1) auto-retry the spawn `vibeide.tools.searchBackendRetries` times with a short delay;
		//   (2) on exhaustion, surface a CLEAR error instead of an empty result, so the model treats
		//       it as "backend down, retry / navigate" rather than "no matches" and stops thrashing.
		const SEARCH_BACKEND_RETRIES_DEFAULT = 1;
		const SEARCH_BACKEND_RETRY_DELAY_MS_DEFAULT = 150;
		const searchBackendRetries = () => Math.max(0, Math.min(5, this._configurationService.getValue<number>('vibeide.tools.searchBackendRetries') ?? SEARCH_BACKEND_RETRIES_DEFAULT));
		const searchBackendRetryDelayMs = () => Math.max(0, Math.min(5_000, this._configurationService.getValue<number>('vibeide.tools.searchBackendRetryDelayMs') ?? SEARCH_BACKEND_RETRY_DELAY_MS_DEFAULT));

		// read_file output-size limits — `vibeide.tools.*` with the prompts.ts constant as default
		// and a defensive clamp. These govern how much file content one read injects into the model's
		// context = direct token cost; exposed so users on tight or very large context windows can tune.
		const readFileDefaultLineLimit = () => Math.max(1, Math.min(100_000, this._configurationService.getValue<number>('vibeide.tools.readFileDefaultLineLimit') ?? READ_FILE_DEFAULT_LINE_LIMIT));
		const readFileMaxLineLimit = () => Math.max(1, Math.min(1_000_000, this._configurationService.getValue<number>('vibeide.tools.readFileMaxLineLimit') ?? READ_FILE_MAX_LINE_LIMIT));
		const readFileMaxCharsPerPage = () => Math.max(10_000, Math.min(5_000_000, this._configurationService.getValue<number>('vibeide.tools.readFileMaxCharsPerPage') ?? MAX_FILE_CHARS_PAGE));
		const largeFileThresholdChars = () => Math.max(10_000, Math.min(5_000_000, this._configurationService.getValue<number>('vibeide.tools.largeFileThresholdChars') ?? READ_FILE_LARGE_FILE_CHARS));
		const largeFileWindowChars = () => Math.max(5_000, Math.min(2_000_000, this._configurationService.getValue<number>('vibeide.tools.largeFileWindowChars') ?? READ_FILE_LARGE_FILE_WINDOW_CHARS));
		const isSearchBackendUnavailable = (e: unknown): boolean => {
			const msg = e instanceof Error ? e.message : String(e ?? '');
			return /ENOENT|spawn|ripgrep|\brg(\.exe)?\b/i.test(msg);
		};
		const SEARCH_BACKEND_UNAVAILABLE_MSG = 'Поисковый backend (ripgrep) временно недоступен — вероятно, антивирус/EDR держит блокировку на rg.exe. Повтори ЭТОТ ЖЕ запрос; если повторяется — поиск по содержимому сейчас недоступен, используй read_file/ls_dir для навигации.';
		const withSearchRetry = async <T,>(run: () => Promise<T>): Promise<T> => {
			const max = searchBackendRetries();
			for (let attempt = 0; ; attempt++) {
				try { return await run(); }
				catch (e) {
					if (isSearchBackendUnavailable(e) && attempt < max) {
						await new Promise<void>(resolve => setTimeout(resolve, searchBackendRetryDelayMs()));
						continue;
					}
					throw e;
				}
			}
		};

		const fileSearchCapped = async (query: Parameters<typeof searchService.fileSearch>[0], timeoutMs = scanTimeoutMs()) => {
			const cts = new CancellationTokenSource();
			let timedOut = false;
			const timer = setTimeout(() => { timedOut = true; cts.cancel(); }, timeoutMs);
			try { return await withSearchRetry(() => searchService.fileSearch(query, cts.token)); }
			catch (e) {
				// Some search backends THROW on cancellation rather than returning partial
				// results. On OUR timeout that is expected — return an empty result so the
				// caller fails fast ("not found") instead of surfacing a raw cancel error.
				// limitHit:true on timeout so callers can tell "search too broad / timed out" apart from
				// "genuinely no matches" and hint the model to narrow (D.21).
				if (timedOut) { return { results: [], messages: [], limitHit: true }; }
				// Backend down (rg spawn failed after retries) — surface a clear, actionable error
				// instead of a raw `ENOENT`, so the model retries/navigates rather than thrashing.
				if (isSearchBackendUnavailable(e)) { throw new Error(SEARCH_BACKEND_UNAVAILABLE_MSG); }
				throw e;
			}
			finally { clearTimeout(timer); cts.dispose(); }
		};

		// Upper bound on glob matches. A broad pattern (**/*) on a large repo otherwise enumerates the
		// whole tree; capping makes the backend stop early and return fast. 10 pages of MAX_CHILDREN_URIs_PAGE.
		const GLOB_MAX_RESULTS = MAX_CHILDREN_URIs_PAGE * 10;

		// Workspace-boundary policy — config-driven (see vibeAgentBehaviorConfiguration.ts).
		// Reads default-allowed (`allowReadOutsideWorkspace`=true), writes default-blocked
		// (`allowWriteOutsideWorkspace`=false). The helpers resolve the "must stay inside
		// workspace" flag at call time and tag the access kind for the denial message.
		const requireWorkspaceForRead = (): boolean =>
			this._configurationService.getValue<boolean>('vibeide.agent.allowReadOutsideWorkspace') === false;
		const requireWorkspaceForWrite = (): boolean =>
			this._configurationService.getValue<boolean>('vibeide.agent.allowWriteOutsideWorkspace') !== true;
		const isAllowedOutside = (u: URI) => this._externalAccess.isAllowed(u);
		const validateReadURI = (u: unknown) => validateURI(u, workspaceContextService, requireWorkspaceForRead(), 'read', isAllowedOutside);
		const validateWriteURI = (u: unknown) => validateURI(u, workspaceContextService, requireWorkspaceForWrite(), 'write', isAllowedOutside);
		const validateOptionalReadURI = (u: unknown) => isFalsy(u) ? null : validateReadURI(u);

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown, line_limit: lineLimitUnknown, with_line_numbers: withLineNumbersUnknown } = params;
				const uri = validateReadURI(uriStr);
				const pageNumber = validatePageNum(pageNumberUnknown);

				let startLine = validateNumber(startLineUnknown, { default: null });
				let endLine = validateNumber(endLineUnknown, { default: null });

				if (startLine !== null && startLine < 1) { startLine = null; }
				if (endLine !== null && endLine < 1) { endLine = null; }

				let lineLimit = validateNumber(lineLimitUnknown, { default: null });
				if (lineLimit !== null) {
					if (lineLimit < 1) { lineLimit = null; }
					else { const maxLineLimit = readFileMaxLineLimit(); if (lineLimit > maxLineLimit) { lineLimit = maxLineLimit; } }
				}

				// Default true — numbered output is strictly more useful for subsequent edit_file calls.
				const withLineNumbers = validateBoolean(withLineNumbersUnknown, { default: true });

				return { uri, startLine, endLine, pageNumber, lineLimit, withLineNumbers };
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params;

				// Tool description marks `uri` as Optional ("Leave this as empty or
				// '' to search all folders"). If the model omits it, default to the
				// first workspace folder rather than fail validation — otherwise
				// minimax-style models that take the "leave empty" wording literally
				// get stuck in a retry loop. Empty string treated the same.
				let uri: URI;
				if (uriStr === undefined || uriStr === '') {
					const folders = workspaceContextService?.getWorkspace().folders;
					if (!folders?.length) {
						throw new Error('Cannot default `ls_dir` to workspace root: no workspace folder open.');
					}
					uri = folders[0].uri;
				} else {
					uri = validateReadURI(uriStr);
				}
				const pageNumber = validatePageNum(pageNumberUnknown);
				return { uri, pageNumber };
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params;
				// Same default-to-workspace-root policy as ls_dir — `uri` is
				// documented as optional for top-level overviews.
				let uri: URI;
				if (uriStr === undefined || uriStr === '') {
					const folders = workspaceContextService?.getWorkspace().folders;
					if (!folders?.length) {
						throw new Error('Cannot default `get_dir_tree` to workspace root: no workspace folder open.');
					}
					uri = folders[0].uri;
				} else {
					uri = validateReadURI(uriStr);
				}
				return { uri };
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params;

				const queryStr = validateStr('query', queryUnknown);
				const pageNumber = validatePageNum(pageNumberUnknown);
				const includePattern = validateOptionalStr('include_pattern', includeUnknown);

				return { query: queryStr, includePattern, pageNumber };

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params;
				const queryStr = validateStr('query', queryUnknown);
				const pageNumber = validatePageNum(pageNumberUnknown);
				const searchInFolder = validateOptionalReadURI(searchInFolderUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				};
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateReadURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			glob: (params: RawToolParamsObj) => {
				const { pattern: patternUnknown, search_in_folder: folderUnknown, page_number: pageNumberUnknown } = params;
				const pattern = validateStr('pattern', patternUnknown);
				const searchInFolder = validateOptionalReadURI(folderUnknown);
				const pageNumber = validatePageNum(pageNumberUnknown);
				return { pattern, searchInFolder, pageNumber };
			},

			grep: (params: RawToolParamsObj) => {
				const {
					pattern: patternUnknown,
					glob: globUnknown,
					file_type: fileTypeUnknown,
					search_in_folder: folderUnknown,
					output_mode: outputModeUnknown,
					context_before: contextBeforeUnknown,
					context_after: contextAfterUnknown,
					case_insensitive: caseInsensitiveUnknown,
					multiline: multilineUnknown,
					head_limit: headLimitUnknown,
					page_number: pageNumberUnknown,
				} = params;
				const pattern = validateStr('pattern', patternUnknown);
				// Reject match-everything patterns: over a large workspace they scan every line and can
				// freeze the extension host for minutes (grep '.*' was observed at ~234s). Force a concrete query.
				const grepNorm = pattern.trim();
				if (grepNorm === '' || ['.', '.*', '.+', '.*?', '.+?', '^', '$', '^$', '^.*$', '^.*', '.*$', '(.*)', '(.+)', '[\\s\\S]*', '[\\s\\S]+'].includes(grepNorm)) {
					throw new ToolValidationError({
						code: 'grep_pattern_too_broad',
						message: `The grep pattern ${JSON.stringify(pattern)} matches (almost) every line and would scan the entire workspace. Use a concrete substring or an anchored regex instead.`,
						hint: 'e.g. "function foo", "TODO:", or "\\bclassName\\b". To list files by name use the glob tool.',
					});
				}
				const globPat = validateOptionalStr('glob', globUnknown);
				const fileType = validateOptionalStr('file_type', fileTypeUnknown);
				const searchInFolder = validateOptionalReadURI(folderUnknown);
				const outputModeRaw = (typeof outputModeUnknown === 'string' ? outputModeUnknown : 'content').toLowerCase();
				const outputMode = (outputModeRaw === 'files_with_matches' || outputModeRaw === 'count' ? outputModeRaw : 'content') as 'content' | 'files_with_matches' | 'count';
				const contextBefore = Math.max(0, validateNumber(contextBeforeUnknown, { default: 0 }) ?? 0);
				const contextAfter = Math.max(0, validateNumber(contextAfterUnknown, { default: 0 }) ?? 0);
				const caseInsensitive = validateBoolean(caseInsensitiveUnknown, { default: false });
				const multiline = validateBoolean(multilineUnknown, { default: false });
				let headLimit = validateNumber(headLimitUnknown, { default: 250 }) ?? 250;
				if (headLimit < 1) { headLimit = 1; }
				if (headLimit > 10_000) { headLimit = 10_000; }
				const pageNumber = validatePageNum(pageNumberUnknown);
				return { pattern, glob: globPat, fileType, searchInFolder, outputMode, contextBefore, contextAfter, caseInsensitive, multiline, headLimit, pageNumber };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params;
				const uri = validateReadURI(uriUnknown);
				return { uri };
			},

			open_file: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params;
				const uri = validateReadURI(uriUnknown);
				return { uri };
			},

			go_to_definition: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, line: lineUnknown, column: columnUnknown } = params;
				const uri = validateReadURI(uriUnknown);
				const line = validateNumber(lineUnknown, { default: null });
				const column = validateNumber(columnUnknown, { default: null });
				if (line === null || line < 1) { throw new Error(`Invalid LLM output: line must be a positive integer, got ${lineUnknown}`); }
				if (column === null || column < 1) { throw new Error(`Invalid LLM output: column must be a positive integer, got ${columnUnknown}`); }
				return { uri, line, column };
			},

			find_references: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, line: lineUnknown, column: columnUnknown } = params;
				const uri = validateReadURI(uriUnknown);
				const line = validateNumber(lineUnknown, { default: null });
				const column = validateNumber(columnUnknown, { default: null });
				if (line === null || line < 1) { throw new Error(`Invalid LLM output: line must be a positive integer, got ${lineUnknown}`); }
				if (column === null || column < 1) { throw new Error(`Invalid LLM output: column must be a positive integer, got ${columnUnknown}`); }
				return { uri, line, column };
			},

			search_symbols: (params: RawToolParamsObj) => {
				const { query: queryUnknown, uri: uriUnknown } = params;
				const query = validateStr('query', queryUnknown);
				const uri = uriUnknown ? validateReadURI(uriUnknown) : null;
				return { query, uri };
			},

			automated_code_review: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params;
				const uri = validateReadURI(uriUnknown);
				return { uri };
			},

			generate_tests: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, function_name: functionNameUnknown, test_framework: testFrameworkUnknown } = params;
				const uri = validateWriteURI(uriUnknown);
				const functionName = validateOptionalStr('function_name', functionNameUnknown) ?? undefined;
				const testFramework = validateOptionalStr('test_framework', testFrameworkUnknown) ?? undefined;
				return { uri, functionName, testFramework };
			},

			rename_symbol: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, line: lineUnknown, column: columnUnknown, new_name: newNameUnknown } = params;
				const uri = validateWriteURI(uriUnknown);
				const line = validateNumber(lineUnknown, { default: null });
				const column = validateNumber(columnUnknown, { default: null });
				if (line === null || line < 1) { throw new Error(`Invalid LLM output: line must be a positive integer, got ${lineUnknown}`); }
				if (column === null || column < 1) { throw new Error(`Invalid LLM output: column must be a positive integer, got ${columnUnknown}`); }
				const newName = validateStr('new_name', newNameUnknown);
				return { uri, line, column, newName };
			},

			extract_function: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, start_line: startLineUnknown, end_line: endLineUnknown, function_name: functionNameUnknown } = params;
				const uri = validateWriteURI(uriUnknown);
				const startLine = validateNumber(startLineUnknown, { default: null });
				const endLine = validateNumber(endLineUnknown, { default: null });
				if (startLine === null || startLine < 1) { throw new Error(`Invalid LLM output: start_line must be a positive integer, got ${startLineUnknown}`); }
				if (endLine === null || endLine < 1) { throw new Error(`Invalid LLM output: end_line must be a positive integer, got ${endLineUnknown}`); }
				const functionName = validateStr('function_name', functionNameUnknown);
				if (endLine < startLine) {
					throw new Error(`Invalid LLM output: end_line (${endLine}) must be >= start_line (${startLine})`);
				}
				return { uri, startLine, endLine, functionName };
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params;
				const uri = validateWriteURI(uriUnknown);
				const uriStr = validateStr('uri', uriUnknown);
				const isFolder = checkIfIsFolder(uriStr);
				return { uri, isFolder };
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params;
				const uri = validateWriteURI(uriUnknown);
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false });
				const uriStr = validateStr('uri', uriUnknown);
				const isFolder = checkIfIsFolder(uriStr);
				return { uri, isRecursive, isFolder };
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params;
				const uri = validateWriteURI(uriStr);
				const newContent = validateStr('newContent', newContentUnknown);
				return { uri, newContent };
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown, old_string: oldStringUnknown, new_string: newStringUnknown } = params;
				const uri = validateWriteURI(uriStr);
				// Flat str_replace form (preferred for weaker models): two plain string params. Collapse
				// into a single SEARCH/REPLACE block so the existing apply path is reused unchanged. A
				// missing new_string means "delete old_string" → empty replacement.
				// Treat a blank search_replace_blocks as "not provided": models routinely emit every
				// schema field and fill the unused one with "" instead of omitting it — that empty string
				// would otherwise skip this branch and fail apply with a "no valid Search/Replace block".
				const noBlocks = searchReplaceBlocksUnknown === null || searchReplaceBlocksUnknown === undefined
					|| (typeof searchReplaceBlocksUnknown === 'string' && searchReplaceBlocksUnknown.trim() === '');
				if (typeof oldStringUnknown === 'string' && noBlocks) {
					const newString = typeof newStringUnknown === 'string' ? newStringUnknown : '';
					const searchReplaceBlocks = `${ORIGINAL}\n${oldStringUnknown}\n${DIVIDER}\n${newString}\n${FINAL}`;
					return { uri, searchReplaceBlocks };
				}
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown);
				return { uri, searchReplaceBlocks };
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown, timeout_ms: timeoutMsUnknown, run_in_background: runInBackgroundUnknown } = params;
				const command = validateStr('command', commandUnknown);
				// Anti-shell contract: bounce commands that duplicate dedicated tools (read_file/grep/glob/edit_file/…).
				// Prevents the model from collapsing into shell pipes and hanging the IDE on large stdout.
				const misuse = detectShellMisuse(command, this._shellHardeningService.getConfig());
				if (misuse) {
					throw new ToolValidationError({
						code: 'shell_misuse',
						message: `Command "${command.split('\n')[0].slice(0, 120)}" duplicates the ${misuse.suggestedTool} tool. ${misuse.hint}`,
						hint: misuse.hint,
						suggestedTool: misuse.suggestedTool,
					});
				}
				const cwd = validateOptionalStr('cwd', cwdUnknown);
				const terminalId = generateUuid();
				let timeoutMs = validateNumber(timeoutMsUnknown, { default: null });
				if (timeoutMs !== null) {
					if (timeoutMs < 1_000) { timeoutMs = 1_000; }
					else if (timeoutMs > 600_000) { timeoutMs = 600_000; } // 10 min hard cap (matches Claude-Code Bash)
				}
				const runInBackground = validateBoolean(runInBackgroundUnknown, { default: false });
				return { command, cwd, terminalId, timeoutMs, runInBackground };
			},
			run_nl_command: (params: RawToolParamsObj) => {
				const { nl_input: nlInputUnknown, cwd: cwdUnknown } = params;
				const nlInput = validateStr('nl_input', nlInputUnknown);
				const cwd = validateOptionalStr('cwd', cwdUnknown);
				const terminalId = generateUuid();
				return { nlInput, cwd, terminalId };
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown, timeout_ms: timeoutMsUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const misuse = detectShellMisuse(command, this._shellHardeningService.getConfig());
				if (misuse) {
					throw new ToolValidationError({
						code: 'shell_misuse',
						message: `Command "${command.split('\n')[0].slice(0, 120)}" duplicates the ${misuse.suggestedTool} tool. ${misuse.hint}`,
						hint: misuse.hint,
						suggestedTool: misuse.suggestedTool,
					});
				}
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown);
				let timeoutMs = validateNumber(timeoutMsUnknown, { default: null });
				if (timeoutMs !== null) {
					if (timeoutMs < 1_000) { timeoutMs = 1_000; }
					else if (timeoutMs > 600_000) { timeoutMs = 600_000; }
				}
				return { command, persistentTerminalId, timeoutMs };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown);
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},
			kill_background_command: (params: RawToolParamsObj) => {
				const { background_id: backgroundIdUnknown } = params;
				const backgroundId = validateStr('background_id', backgroundIdUnknown);
				return { backgroundId };
			},
			read_background_output: (params: RawToolParamsObj) => {
				const { background_id: backgroundIdUnknown } = params;
				const backgroundId = validateStr('background_id', backgroundIdUnknown);
				return { backgroundId };
			},

			// ---

			web_search: (params: RawToolParamsObj) => {
				const { query: queryUnknown, k: kUnknown, refresh: refreshUnknown } = params;
				const query = validateStr('query', queryUnknown);
				const k = validateNumber(kUnknown, { default: 5 });
				if (k === null) {
					throw new Error('Invalid k parameter for web_search');
				}
				const validK = Math.min(Math.max(1, k), 10); // clamp between 1 and 10
				let refresh = false;
				if (refreshUnknown && typeof refreshUnknown === 'string') {
					refresh = refreshUnknown.toLowerCase() === 'true';
				}
				return { query, k: validK, refresh };
			},

			browse_url: (params: RawToolParamsObj) => {
				const { url: urlUnknown, refresh: refreshUnknown } = params;
				const url = validateStr('url', urlUnknown);
				// Basic URL validation
				if (!url.startsWith('http://') && !url.startsWith('https://')) {
					throw new Error(`Invalid URL format: ${url}. URL must start with http:// or https://`);
				}
				try {
					new URL(url); // Validate URL format
				} catch (e) {
					throw new Error(`Invalid URL format: ${url}. Error: ${e}`);
				}
				let refresh = false;
				if (refreshUnknown && typeof refreshUnknown === 'string') {
					refresh = refreshUnknown.toLowerCase() === 'true';
				}
				return { url, refresh };
			},

			vibe_complete: (params: RawToolParamsObj) => {
				// `summary` is best-effort — the call itself is the completion signal, so a
				// missing/non-string summary must not reject the call (that would re-stall the loop).
				const summaryUnknown = (params as { summary?: unknown }).summary;
				const summary = typeof summaryUnknown === 'string' ? summaryUnknown : '';
				return { summary };
			},

		};

		// VibeIDE D.12: writing to a path that is an existing *directory* previously
		// surfaced a raw FileService "...is actually a directory" stack (logged twice
		// via the bulk-edit create+reload path) and an opaque agent failure. Fail fast
		// with a structured, actionable error before any write side effect.
		const assertTargetNotDirectory = async (uri: URI, action: string): Promise<void> => {
			let isDir = false;
			try { isDir = (await fileService.stat(uri)).isDirectory; } catch { return; } // absent → nothing to guard
			if (isDir) {
				throw new ToolValidationError({
					code: 'target_is_directory',
					message: `Cannot ${action} ${uri.fsPath}: that path is an existing directory, not a file.`,
					hint: 'Use a file path (add a filename under this directory), or delete_file_or_folder if you meant to remove the directory.',
				});
			}
		};

		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber, lineLimit, withLineNumbers }) => {
				// .vibe/ignore guard: refuse to read files the project excluded from the agent (e.g.
				// minified single-line bundles that balloon the context window). Fail-safe with a clear
				// hint instead of silently dumping hundreds of thousands of tokens.
				if (vibeIgnoreService.isIgnored(uri)) {
					throw new Error(`Файл «${uri.fsPath}» закрыт правилом .vibe/ignore — чтение пропущено, чтобы не раздувать контекст. Если эта область нужна, читай несжатую/-debug версию (она многострочная и адресуется по строкам) или временно убери правило из .vibe/ignore.`);
				}
				// Directory guard (0.13.23): read_file on a directory previously threw a
				// cryptic FileOperationError ("...is actually a directory") the model
				// could not act on (observed: agent called read_file on `.vibe`, a folder,
				// and stalled). Following opencode/kilocode (the reference behaviour — they
				// return the listing as a SUCCESS result, not an error → no wasted error
				// round-trip), return the directory entries as the tool result so the agent
				// reads the files inside (study / compare / update). resolve() failure
				// (path missing) falls through to the existing not-found handling below.
				{
					const entry = await fileService.resolve(uri).catch(() => null);
					if (entry?.isDirectory) {
						const names = (entry.children ?? [])
							.map(c => `${c.name}${c.isDirectory ? '/' : ''}`)
							.sort((a, b) => a.localeCompare(b));
						const listing = names.length ? names.join('\n') : '(empty directory)';
						const dirContents = `"${uri.fsPath}" is a DIRECTORY, not a file. Entries (${names.length}):\n${listing}\n\nNext: call read_file on a specific file listed above, or get_dir_tree on this path for a recursive view.`;
						const dirLineCount = dirContents.split('\n').length;
						return { result: { fileContents: dirContents, totalFileLen: dirContents.length, hasNextPage: false, totalNumLines: dirLineCount, linesReturned: dirLineCount, startLineReturned: 1, endLineReturned: dirLineCount, truncatedByLineLimit: false } };
					}
				}
				// VibeIDE: Large file policy — warn on files >200KB (first page only)
				if (pageNumber === 1 && startLine === null && endLine === null) {
					try {
						const stat = await fileService.stat(uri);
						const LARGE_FILE_BYTES = 200 * 1024; // 200KB
						if (stat.size > LARGE_FILE_BYTES) {
							vibeLog.warn('LargeFilePolicy', `File ${uri.fsPath} is ${Math.round(stat.size / 1024)}KB. Reading large files consumes significant context tokens. Consider adding to .vibe/ignore if not needed.`);
						}
					} catch { /* stat failed — ignore, proceed with read */ }
				}
				// Content acquisition (0.13.24): read RAW via fileService instead of
				// creating a full editor TextModel. `vibeideModelService.initializeModel`
				// → `createModelReference` spins up a Monaco model (tokenization +
				// language-detection worker + Extension-Host onDidOpenTextDocument), which
				// blocked the EH on read_file — the [VibeIDE/llmTurn] trace showed every
				// turn fast until a read_file, then EH-unresponsive + crash-recovery while
				// ls_dir/get_dir_tree (raw fileService reads) never hung. Matches
				// opencode/kilocode/continue (all read raw). An already-open VibeIDE model
				// is still reused (reflects unsaved edits, no creation cost).
				const toLf = (s: string) => s.replace(/\r\n/g, '\n');
				let fullText: string | null = null;
				const openModel = vibeideModelService.getModel(uri).model; // existing-only; does NOT create
				if (openModel) {
					fullText = openModel.getValue(EndOfLinePreference.LF);
				} else {
					try { fullText = toLf((await fileService.readFile(uri)).value.toString()); }
					catch { fullText = null; }
				}
				if (fullText === null) {
					// Fallback: locate the file within the workspace by basename (grep-like), then raw-read.
					const requestedName = uri.fsPath.split(/[/\\]/).pop() || uri.fsPath;
					try {
						const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
							filePattern: requestedName,
							sortByScore: true,
						});
						const data = await fileSearchCapped(query);
						const fallback = data.results[0]?.resource;
						if (fallback) {
							uri = fallback;
							fullText = toLf((await fileService.readFile(uri)).value.toString());
						}
					} catch { /* ignore and throw original error if still null */ }
					if (fullText === null) { throw new Error(`File not found at the given path (and no file with that name exists in the workspace). The path is likely wrong — use search_for_files or grep to locate the correct file by name, then retry with the path it returns.`); }
				}

				const allLines = fullText.split('\n');
				const totalNumLines = allLines.length;

				// Line-based slice (Claude-Code style): start_line + line_limit drives the window.
				// Falls back to legacy whole-file path when caller passes neither.
				const effectiveLineLimit = lineLimit ?? readFileDefaultLineLimit();
				const isLineRangeMode = startLine !== null || endLine !== null || lineLimit !== null;

				let startLineReturned: number;
				let endLineReturned: number;
				let truncatedByLineLimit = false;

				if (isLineRangeMode || pageNumber === 1) {
					// Window-by-lines first; pageNumber still applies for very long requested ranges.
					const requestedStart = startLine ?? 1;
					const requestedEnd = endLine ?? Math.min(totalNumLines, requestedStart + effectiveLineLimit - 1);
					const windowEnd = Math.min(requestedEnd, requestedStart + effectiveLineLimit - 1, totalNumLines);
					if (windowEnd < requestedEnd) { truncatedByLineLimit = true; }
					startLineReturned = Math.max(1, requestedStart);
					endLineReturned = Math.max(startLineReturned, windowEnd);
				}
				else {
					// pageNumber > 1: legacy char-window kicks in (handled below).
					startLineReturned = 1;
					endLineReturned = totalNumLines;
				}

				// Large-file guard: a FULL default read (no explicit range) of a >200KB file can fit the
				// 2k-line limit (long lines) yet blow a huge chunk of the context in one tool result.
				// Shrink the window to the char budget and flag it partial so the nav hint steers the
				// model to start_line continuation / grep instead. Explicit-range reads are untouched.
				if (!isLineRangeMode && pageNumber === 1 && fullText.length > largeFileThresholdChars()) {
					const cappedEnd = clampLineWindowToCharBudget(allLines, startLineReturned, endLineReturned, largeFileWindowChars());
					if (cappedEnd < endLineReturned) {
						endLineReturned = cappedEnd;
						truncatedByLineLimit = true;
					}
				}

				let contents: string;
				if (isLineRangeMode || pageNumber === 1) {
					// Line window on the raw string (1-based inclusive) — mirrors Monaco's
					// getValueInRange(L1C1..LnC_max, LF): the selected lines joined by \n.
					contents = allLines.slice(startLineReturned - 1, endLineReturned).join('\n');
				}
				else {
					contents = fullText;
				}

				// Byte-level paginate as a hard cap (huge minified files etc).
				const maxCharsPerPage = readFileMaxCharsPerPage();
				const fromIdx = maxCharsPerPage * (pageNumber - 1);
				const toIdx = maxCharsPerPage * pageNumber - 1;
				let fileContents = contents.slice(fromIdx, toIdx + 1);
				const hasNextPage = (contents.length - 1) - toIdx >= 1 || truncatedByLineLimit;
				const totalFileLen = contents.length;
				const linesReturned = endLineReturned - startLineReturned + 1;

				// VibeIDE: Prompt injection guard — sanitize file content before LLM context
				const guardResult = this.vibePromptGuardService.sanitizeFileContent(fileContents, uri.fsPath);
				if (guardResult.warnings.length > 0) {
					fileContents = guardResult.sanitized;
				}

				// Apply line-number prefixes (1-based, tab-separated — `cat -n` style).
				if (withLineNumbers && (isLineRangeMode || pageNumber === 1)) {
					const lines = fileContents.split('\n');
					// Last split element is empty if the slice ended with '\n' — keep it as terminator.
					const labelled: string[] = [];
					for (let i = 0; i < lines.length; i++) {
						const ln = startLineReturned + i;
						if (ln > endLineReturned + 1) { break; }
						if (i === lines.length - 1 && lines[i] === '' && fileContents.endsWith('\n')) {
							labelled.push('');
						} else {
							labelled.push(`${ln}\t${lines[i]}`);
						}
					}
					fileContents = labelled.join('\n');
				}

				// Mark the call so edit_file can later require "must read first".
				this._markFileRead(uri);

				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines, linesReturned, startLineReturned, endLineReturned, truncatedByLineLimit } };
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber);
				return { result: dirResult };
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri, { budgetMs: scanTimeoutMs() });
				return { result: { str } };
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
					maxResults: GLOB_MAX_RESULTS,
				});
				const data = await fileSearchCapped(query);

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource);

				const hasNextPage = (data.results.length - 1) - toIdx >= 1;
				return { result: { uris, hasNextPage, limitHit: !!data.limitHit } };
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				// Try indexer first for non-regex, whole-workspace queries
				let indexedUris: URI[] | null = null;
				if (!isRegex && searchInFolder === null) {
					try {
						const k = MAX_CHILDREN_URIs_PAGE * pageNumber;
						const results = await this.repoIndexerService.query(queryStr, k);
						if (results && results.length) {
							// `query` returns FORMATTED result blobs ("File: <path>:<lines>\nSymbols: …\n
							// Content preview: …"), NOT bare paths. Wrapping the whole blob in URI.file()
							// produced garbage "uris" — click-to-open in the chat tried to open the entire
							// blob as a path (FileOperationError) and the model saw a malformed result.
							// Extract the real file path from each blob's `File:` header and de-dupe by file.
							const seen = new Set<string>();
							const parsed: URI[] = [];
							for (const blob of results) {
								const firstLine = blob.split('\n', 1)[0] ?? '';
								const m = firstLine.match(/^File:\s*(.+)$/);
								if (!m) { continue; }
								const pathOnly = m[1].trim().replace(/:\d+(?:-\d+)?$/, ''); // drop trailing :start[-end] citation
								if (!pathOnly) { continue; }
								let u: URI;
								try { u = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(pathOnly) ? URI.parse(pathOnly) : URI.file(pathOnly); }
								catch { continue; }
								if (!seen.has(u.fsPath)) { seen.add(u.fsPath); parsed.push(u); }
							}
							if (parsed.length) { indexedUris = parsed; }
						}
					} catch { /* ignore and fall back */ }
				}

				if (indexedUris && indexedUris.length) {
					const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
					const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
					const paged = indexedUris.slice(fromIdx, toIdx + 1);
					const hasNextPage = (indexedUris.length - 1) - toIdx >= 1;
					return { result: { queryStr, uris: paged, hasNextPage } };
				}

				// Fallback: ripgrep-backed text search
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder];

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders, { maxResults: GLOB_MAX_RESULTS });

				// EH-freeze guard (same class as D.19 glob/search_pathnames): raw uncancellable textSearch
				// on a huge tree could hang the Extension Host for minutes. Time-cap via scanTimeoutMs().
				const sfCts = new CancellationTokenSource();
				const sfTimer = setTimeout(() => sfCts.cancel(), scanTimeoutMs());
				let data: Awaited<ReturnType<typeof searchService.textSearch>>;
				try { data = await withSearchRetry(() => searchService.textSearch(query, sfCts.token)); }
				catch (e) {
					// Backend down (rg spawn failed after retries) → clear error, NOT a silent empty
					// result (which the model misreads as "nothing exists" and keeps re-searching).
					// Genuine cancellation/timeout errors don't match the detector → still fail-fast as empty.
					if (isSearchBackendUnavailable(e)) { throw new Error(SEARCH_BACKEND_UNAVAILABLE_MSG); }
					data = { results: [], messages: [] };
				}
				finally { clearTimeout(sfTimer); sfCts.dispose(); }

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource);

				const hasNextPage = (data.results.length - 1) - toIdx >= 1;
				return { result: { queryStr, uris, hasNextPage } };
			},
			glob: async ({ pattern, searchInFolder, pageNumber }) => {
				const folders = searchInFolder === null
					? workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder];
				// Bound the search: a broad pattern (**/*) on a large repo otherwise scans the whole tree
				// under an UNCANCELLABLE search and freezes the Extension Host for minutes (observed:
				// glob **/* on a large repo hung the EH > 10 min). Cap total matches so the backend stops
				// early, and time-cap the search (fileSearchCapped, 10s) as a safety net.
				const query = queryBuilder.file(folders, {
					includePattern: pattern,
					expandPatterns: true,
					sortByScore: false,
					maxResults: GLOB_MAX_RESULTS,
				});
				const data = await fileSearchCapped(query);
				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
				const all = data.results.map(r => r.resource);
				const uris = all.slice(fromIdx, toIdx + 1);
				const hasNextPage = (all.length - 1) - toIdx >= 1;
				return { result: { uris, hasNextPage, totalMatches: all.length, limitHit: !!data.limitHit } };
			},

			grep: async ({ pattern, glob: globPat, fileType, searchInFolder, outputMode, contextBefore, contextAfter, caseInsensitive, multiline, headLimit, pageNumber }) => {
				const folders = searchInFolder === null
					? workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder];
				// File-type → glob convenience expansion (subset of common ripgrep types).
				const typeToGlob: Record<string, string> = {
					js: '**/*.{js,jsx,mjs,cjs}', ts: '**/*.{ts,tsx}', py: '**/*.py',
					rust: '**/*.rs', go: '**/*.go', java: '**/*.java', md: '**/*.md',
					json: '**/*.json', yaml: '**/*.{yml,yaml}', css: '**/*.{css,scss,less}',
					html: '**/*.{html,htm}',
				};
				const includePattern = globPat ?? (fileType && typeToGlob[fileType.toLowerCase()]) ?? undefined;
				// VS Code search has a single `surroundingContext` knob (not split before/after).
				const surroundingContext = outputMode === 'content' ? Math.max(contextBefore, contextAfter) : 0;
				const textQuery = queryBuilder.text({
					pattern,
					isRegExp: true,
					isCaseSensitive: !caseInsensitive,
					isMultiline: multiline,
				}, folders, {
					includePattern,
					expandPatterns: true,
					surroundingContext: surroundingContext || undefined,
					maxResults: headLimit,
				});
				// Hard cap the search so a valid-but-broad pattern over a huge repo cannot hang the EH.
				// D.38: use the same configurable budget as the other scan tools (`scanTimeoutMs()`) instead
				// of a lone hardcoded 15s — one knob (`vibeide.agent.scanTimeoutMs`) governs all searches.
				const grepTimeoutMs = scanTimeoutMs();
				let grepCancelledByTimeout = false;
				const grepCts = new CancellationTokenSource();
				const grepTimer = setTimeout(() => { grepCancelledByTimeout = true; grepCts.cancel(); }, grepTimeoutMs);
				// Actionable hint shared by both cancel paths (throw vs partial-return). A bare
				// "Canceled" error makes the model re-issue the SAME broad grep and grind on a
				// huge repo (model-stalls #011) — tell it to narrow scope instead.
				const grepTimeoutHint = `grep was cancelled after ${Math.round(grepTimeoutMs / 1000)}s — the search scope is too large to scan in time. Narrow it: pass "search_in_folder" to limit the directory, use a more specific "pattern", or set "glob"/"file_type" to fewer files. (pattern: ${JSON.stringify(pattern)})`;
				let data: Awaited<ReturnType<typeof searchService.textSearch>>;
				try {
					data = await withSearchRetry(() => searchService.textSearch(textQuery, grepCts.token));
				} catch (e) {
					if (grepCancelledByTimeout) { throw new Error(grepTimeoutHint); }
					// Backend down (rg spawn failed after retries) — clear, actionable error instead of raw ENOENT.
					if (isSearchBackendUnavailable(e)) { throw new Error(SEARCH_BACKEND_UNAVAILABLE_MSG); }
					throw e;
				} finally {
					clearTimeout(grepTimer);
					grepCts.dispose();
				}
				// Some search backends return partial results on cancel instead of throwing;
				// still surface the truncation so the model narrows rather than trusting an
				// incomplete "few/no matches" result.
				if (grepCancelledByTimeout) { throw new Error(grepTimeoutHint); }

				const matches: Array<{ uri: URI; line: number; column: number; preview: string }> = [];
				const files: Array<{ uri: URI; count?: number }> = [];
				let totalMatches = 0;
				for (const fileMatch of data.results) {
					if (Array.isArray(fileMatch.results)) {
						let perFile = 0;
						for (const r of fileMatch.results) {
							// Search backends return slightly different result shapes across versions
							// (`rangeLocations` vs legacy `range`/`rangeStart*`); probe each optional field.
							const probe = r as TextSearchResultProbe;
							const previewObj = probe.preview;
							if (!previewObj) { continue; }
							perFile++;
							totalMatches++;
							const rangeArr = Array.isArray(probe.rangeLocations) ? probe.rangeLocations[0] : null;
							const startLine = (
								rangeArr?.source?.startLineNumber
								?? probe.rangeStartLineNumber
								?? probe.range?.startLineNumber
								?? 1
							);
							const startCol = (
								rangeArr?.source?.startColumn
								?? probe.rangeStartColumn
								?? probe.range?.startColumn
								?? 1
							);
							if (outputMode === 'content' && matches.length < headLimit) {
								const previewText = typeof previewObj.text === 'string' ? previewObj.text : String(previewObj);
								matches.push({ uri: fileMatch.resource, line: startLine, column: startCol, preview: truncateHeadTail(previewText, 500) });
							}
						}
						files.push({ uri: fileMatch.resource, count: perFile });
					}
				}

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1);
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1;
				if (outputMode === 'content') {
					const paged = matches.slice(fromIdx, toIdx + 1);
					const hasNextPage = (matches.length - 1) - toIdx >= 1;
					return { result: { mode: outputMode, matches: paged, files: [], hasNextPage, totalMatches } };
				}
				const pagedFiles = files.slice(fromIdx, toIdx + 1);
				const hasNextPage = (files.length - 1) - toIdx >= 1;
				return { result: { mode: outputMode, matches: [], files: pagedFiles, hasNextPage, totalMatches } };
			},

			search_in_file: async ({ uri, query, isRegex }) => {
				// .vibe/ignore guard (same policy as read_file) — don't let the agent search excluded
				// files and then read the matched lines back into context.
				if (vibeIgnoreService.isIgnored(uri)) {
					throw new Error(`Файл «${uri.fsPath}» закрыт правилом .vibe/ignore — поиск пропущен. Используй несжатую/-debug версию или убери правило из .vibe/ignore.`);
				}
				await vibeideModelService.initializeModel(uri);
				let { model } = await vibeideModelService.getModelSafe(uri);
				if (model === null) {
					// Fallback: try to locate the file within the workspace by basename (grep-like)
					const requestedName = uri.fsPath.split(/[/\\]/).pop() || uri.fsPath;
					try {
						const query_ = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
							filePattern: requestedName,
							sortByScore: true,
						});
						const data = await fileSearchCapped(query_);
						const fallback = data.results[0]?.resource;
						if (fallback) {
							uri = fallback;
							await vibeideModelService.initializeModel(uri);
							model = (await vibeideModelService.getModelSafe(uri)).model;
						}
					} catch { /* ignore and throw original error if still null */ }
					if (model === null) { throw new Error(`File not found at the given path (and no file with that name exists in the workspace). The path is likely wrong — use search_for_files or grep to locate the correct file by name, then retry with the path it returns.`); }
				}
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = [];
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000);
				const { lintErrors } = this._getLintErrors(uri);
				return { result: { lintErrors } };
			},

			open_file: async ({ uri }) => {
				// Verify file exists
				const exists = await fileService.exists(uri);
				if (!exists) {
					throw new Error(`File does not exist: ${uri.fsPath}`);
				}
				// Open the file in the editor
				await this.editorService.openEditor({
					resource: uri,
					options: { pinned: false }
				});
				return { result: {} };
			},

			go_to_definition: async ({ uri, line, column }) => {
				await vibeideModelService.initializeModel(uri);
				const { model } = await vibeideModelService.getModelSafe(uri);
				if (model === null) {
					throw new Error(`File does not exist: ${uri.fsPath}`);
				}

				const position = new Position(line, column);
				const definitionProviders = this.languageFeaturesService.definitionProvider.ordered(model);

				const locations: Array<{ uri: URI; startLine: number; startColumn: number; endLine: number; endColumn: number }> = [];

				for (const provider of definitionProviders) {
					const definitions = await provider.provideDefinition(model, position, CancellationToken.None);
					if (!definitions) { continue; }

					const defs = Array.isArray(definitions) ? definitions : [definitions];
					for (const def of defs) {
						if (def.uri && def.range) {
							locations.push({
								uri: def.uri,
								startLine: def.range.startLineNumber,
								startColumn: def.range.startColumn,
								endLine: def.range.endLineNumber,
								endColumn: def.range.endColumn,
							});
						}
					}
				}

				if (locations.length === 0) {
					throw new Error(`No definition found at line ${line}, column ${column} in ${uri.fsPath}`);
				}

				return { result: { locations } };
			},

			find_references: async ({ uri, line, column }) => {
				await vibeideModelService.initializeModel(uri);
				const { model } = await vibeideModelService.getModelSafe(uri);
				if (model === null) {
					throw new Error(`File does not exist: ${uri.fsPath}`);
				}

				const position = new Position(line, column);
				const referenceProviders = this.languageFeaturesService.referenceProvider.ordered(model);

				const locations: Array<{ uri: URI; startLine: number; startColumn: number; endLine: number; endColumn: number }> = [];

				for (const provider of referenceProviders) {
					const references = await provider.provideReferences(model, position, { includeDeclaration: true }, CancellationToken.None);
					if (!references) { continue; }

					for (const ref of references) {
						if (ref.uri && ref.range) {
							locations.push({
								uri: ref.uri,
								startLine: ref.range.startLineNumber,
								startColumn: ref.range.startColumn,
								endLine: ref.range.endLineNumber,
								endColumn: ref.range.endColumn,
							});
						}
					}
				}

				return { result: { locations } };
			},

			search_symbols: async ({ query, uri }) => {
				const symbols: Array<{ name: string; kind: string; uri: URI; startLine: number; startColumn: number; endLine: number; endColumn: number }> = [];

				if (uri) {
					// Search in specific file
					await vibeideModelService.initializeModel(uri);
					const { model } = await vibeideModelService.getModelSafe(uri);
					if (model === null) {
						throw new Error(`File does not exist: ${uri.fsPath}`);
					}

					const symbolProviders = this.languageFeaturesService.documentSymbolProvider.ordered(model);
					for (const provider of symbolProviders) {
						const docSymbols = await provider.provideDocumentSymbols(model, CancellationToken.None);
						if (!docSymbols) { continue; }

						const processSymbol = (sym: DocumentSymbol, parentName = '') => {
							const fullName = parentName ? `${parentName}.${sym.name}` : sym.name;
							if (fullName.toLowerCase().includes(query.toLowerCase())) {
								symbols.push({
									name: fullName,
									kind: sym.kind?.toString() || 'unknown',
									uri: uri,
									startLine: sym.range.startLineNumber,
									startColumn: sym.range.startColumn,
									endLine: sym.range.endLineNumber,
									endColumn: sym.range.endColumn,
								});
							}
							if (sym.children) {
								for (const child of sym.children) {
									processSymbol(child, fullName);
								}
							}
						};

						const syms = Array.isArray(docSymbols) ? docSymbols : [docSymbols];
						for (const sym of syms) {
							processSymbol(sym);
						}
					}
				} else {
					// Search across workspace - use file search to find files, then search symbols in each
					const query_ = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
						filePattern: '*.{ts,js,py,java,go,rs,cpp,c,cs}',
						sortByScore: true,
					});
					const fileSearchResults = await fileSearchCapped(query_);
					const filesToSearch = fileSearchResults.results.slice(0, 50).map(r => r.resource); // Limit to 50 files for performance

					for (const fileUri of filesToSearch) {
						try {
							await vibeideModelService.initializeModel(fileUri);
							const { model } = await vibeideModelService.getModelSafe(fileUri);
							if (model === null) { continue; }

							const symbolProviders = this.languageFeaturesService.documentSymbolProvider.ordered(model);
							for (const provider of symbolProviders) {
								const docSymbols = await provider.provideDocumentSymbols(model, CancellationToken.None);
								if (!docSymbols) { continue; }

								const processSymbol = (sym: DocumentSymbol, parentName = '') => {
									const fullName = parentName ? `${parentName}.${sym.name}` : sym.name;
									if (fullName.toLowerCase().includes(query.toLowerCase())) {
										symbols.push({
											name: fullName,
											kind: sym.kind?.toString() || 'unknown',
											uri: fileUri,
											startLine: sym.range.startLineNumber,
											startColumn: sym.range.startColumn,
											endLine: sym.range.endLineNumber,
											endColumn: sym.range.endColumn,
										});
									}
									if (sym.children) {
										for (const child of sym.children) {
											processSymbol(child, fullName);
										}
									}
								};

								const syms = Array.isArray(docSymbols) ? docSymbols : [docSymbols];
								for (const sym of syms) {
									processSymbol(sym);
								}
							}
						} catch {
							// Skip files that can't be processed
							continue;
						}
					}
				}

				return { result: { symbols } };
			},

			automated_code_review: async ({ uri }) => {
				await vibeideModelService.initializeModel(uri);
				const { model } = await vibeideModelService.getModelSafe(uri);
				if (model === null) {
					throw new Error(`File does not exist: ${uri.fsPath}`);
				}

				const content = model.getValue(EndOfLinePreference.LF);
				const issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; line: number; column: number; suggestion?: string }> = [];

				// Get lint errors
				await timeout(1000);
				const { lintErrors } = this._getLintErrors(uri);
				if (lintErrors) {
					for (const error of lintErrors) {
						issues.push({
							severity: error.code?.startsWith('E') ? 'error' : 'warning',
							message: error.message,
							line: error.startLineNumber,
							column: 1,
							suggestion: `Fix: ${error.message}`,
						});
					}
				}

				// Basic code quality checks
				const lines = content.split('\n');
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const lineNum = i + 1;

					// Check for long lines
					if (line.length > 120) {
						issues.push({
							severity: 'info',
							message: `Line ${lineNum} is too long (${line.length} characters). Consider breaking it into multiple lines.`,
							line: lineNum,
							column: 1,
							suggestion: 'Break long lines into multiple lines for better readability.',
						});
					}

					// Check for TODO/FIXME comments
					if (line.match(/TODO|FIXME|XXX|HACK/i)) {
						issues.push({
							severity: 'info',
							message: `Line ${lineNum} contains a TODO/FIXME comment: ${line.trim().substring(0, 50)}`,
							line: lineNum,
							column: 1,
							suggestion: 'Address the TODO/FIXME comment or remove it if no longer needed.',
						});
					}

					// Check for console.log (common in production code)
					if (line.includes('console.log') && !uri.fsPath.includes('test') && !uri.fsPath.includes('spec')) {
						issues.push({
							severity: 'warning',
							message: `Line ${lineNum} contains console.log. Consider removing debug statements in production code.`,
							line: lineNum,
							column: 1,
							suggestion: 'Remove console.log or use a proper logging framework.',
						});
					}
				}

				return { result: { issues } };
			},

			generate_tests: async ({ uri, functionName, testFramework }) => {
				await vibeideModelService.initializeModel(uri);
				const { model } = await vibeideModelService.getModelSafe(uri);
				if (model === null) {
					throw new Error(`File does not exist: ${uri.fsPath}`);
				}

				const fileExtension = uri.fsPath.split('.').pop()?.toLowerCase() || '';

				// Detect test framework from file extension and project structure
				let detectedFramework = testFramework;
				if (!detectedFramework) {
					if (fileExtension === 'ts' || fileExtension === 'js') {
						detectedFramework = 'jest'; // Default for JS/TS
					} else if (fileExtension === 'py') {
						detectedFramework = 'pytest';
					} else if (fileExtension === 'java') {
						detectedFramework = 'junit';
					} else {
						detectedFramework = 'generic';
					}
				}

				// For now, return a placeholder test structure
				// In a real implementation, this would use an LLM to generate actual tests
				const testFileName = uri.fsPath.replace(/\.(ts|js|py|java)$/, '.test.$1');
				const testFileUri = URI.file(testFileName);

				let testCode = '';
				if (functionName) {
					testCode = `// Generated test for function: ${functionName}\n`;
					testCode += `// Framework: ${detectedFramework}\n\n`;
					testCode += `// TODO: Implement actual test cases for ${functionName}\n`;
					testCode += `// This is a placeholder - implement real test logic\n`;
				} else {
					testCode = `// Generated tests for file: ${uri.fsPath}\n`;
					testCode += `// Framework: ${detectedFramework}\n\n`;
					testCode += `// TODO: Implement test cases for all exported functions/classes\n`;
					testCode += `// This is a placeholder - implement real test logic\n`;
				}

				return { result: { testCode, testFileUri } };
			},

			rename_symbol: async ({ uri, line, column, newName }) => {
				await vibeideModelService.initializeModel(uri);
				const { model } = await vibeideModelService.getModelSafe(uri);
				if (model === null) {
					throw new Error(`File does not exist: ${uri.fsPath}`);
				}

				// Find all references first
				const position = new Position(line, column);
				const referenceProviders = this.languageFeaturesService.referenceProvider.ordered(model);
				const allReferences: Array<{ uri: URI; range: Range }> = [];

				// Get definition location
				const definitionProviders = this.languageFeaturesService.definitionProvider.ordered(model);
				for (const provider of definitionProviders) {
					const definitions = await provider.provideDefinition(model, position, CancellationToken.None);
					if (definitions) {
						const defs = Array.isArray(definitions) ? definitions : [definitions];
						for (const def of defs) {
							if (def.uri && def.range) {
								const range = Range.lift(def.range);
								if (range) {
									allReferences.push({ uri: def.uri, range });
								}
							}
						}
					}
				}

				// Get all references
				for (const provider of referenceProviders) {
					const references = await provider.provideReferences(model, position, { includeDeclaration: true }, CancellationToken.None);
					if (references) {
						for (const ref of references) {
							if (ref.uri && ref.range) {
								const range = Range.lift(ref.range);
								if (range) {
									allReferences.push({ uri: ref.uri, range });
								}
							}
						}
					}
				}

				// Get old symbol name from definition
				let oldName = '';
				if (allReferences.length > 0) {
					const firstRef = allReferences[0];
					await vibeideModelService.initializeModel(firstRef.uri);
					const { model: refModel } = await vibeideModelService.getModelSafe(firstRef.uri);
					if (refModel) {
						const rangeText = refModel.getValueInRange(firstRef.range, EndOfLinePreference.LF);
						oldName = rangeText.trim();
					}
				}

				if (!oldName) {
					throw new Error(`Could not determine symbol name at line ${line}, column ${column}`);
				}

				// Collect all changes
				const changes: Array<{ uri: URI; oldText: string; newText: string; line: number; column: number }> = [];
				for (const ref of allReferences) {
					await vibeideModelService.initializeModel(ref.uri);
					const { model: refModel } = await vibeideModelService.getModelSafe(ref.uri);
					if (refModel) {
						const rangeText = refModel.getValueInRange(ref.range, EndOfLinePreference.LF);
						if (rangeText.trim() === oldName) {
							changes.push({
								uri: ref.uri,
								oldText: rangeText,
								newText: newName,
								line: ref.range.startLineNumber,
								column: ref.range.startColumn,
							});
						}
					}
				}

				return { result: { changes } };
			},

			extract_function: async ({ uri, startLine, endLine, functionName }) => {
				await vibeideModelService.initializeModel(uri);
				const { model } = await vibeideModelService.getModelSafe(uri);
				if (model === null) {
					throw new Error(`File does not exist: ${uri.fsPath}`);
				}

				const totalLines = model.getLineCount();
				if (startLine > totalLines || endLine > totalLines) {
					throw new Error(`Line range ${startLine}-${endLine} is out of bounds (file has ${totalLines} lines)`);
				}

				// Get the code to extract
				const range = new Range(startLine, 1, endLine, Number.MAX_SAFE_INTEGER);
				const codeToExtract = model.getValueInRange(range, EndOfLinePreference.LF);

				// Determine indentation from the first line
				const firstLine = model.getLineContent(startLine);
				const indentMatch = firstLine.match(/^(\s*)/);
				const baseIndent = indentMatch ? indentMatch[1] : '';
				const functionIndent = baseIndent;

				// Create function signature (simplified - in real implementation would analyze parameters)
				const newFunctionCode = `${functionIndent}function ${functionName}() {\n${codeToExtract.split('\n').map(line => `${functionIndent}  ${line}`).join('\n')}\n${functionIndent}}\n`;

				// Create replacement (function call)
				const replacementCode = `${baseIndent}${functionName}();\n`;

				return { result: { newFunctionCode, replacementCode, insertLine: startLine } };
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (!isFolder) {
					await assertTargetNotDirectory(uri, 'create file');
					await this._checkAdvisoryTerritorialLocks(uri);
				}
				// Pre-flight: if creating a file, ensure the parent directory exists.
				// Without this the underlying createFile fails with an obscure FS error;
				// surface a structured error the model can act on (suggest mkdir / create folder).
				if (!isFolder) {
					const parentUri = URI.from({
						scheme: uri.scheme,
						authority: uri.authority,
						path: uri.path.replace(/[/\\][^/\\]*$/, '') || '/',
					});
					try {
						const parentStat = await fileService.stat(parentUri);
						if (!parentStat.isDirectory) {
							throw new ToolValidationError({
								code: 'parent_not_directory',
								message: `Cannot create ${uri.fsPath}: parent path ${parentUri.fsPath} exists but is not a directory.`,
								hint: 'Pick a different location or delete the colliding entry.',
							});
						}
					} catch (e) {
						if (e instanceof ToolValidationError) { throw e; }
						throw new ToolValidationError({
							code: 'parent_dir_missing',
							message: `Cannot create ${uri.fsPath}: parent directory ${parentUri.fsPath} does not exist.`,
							hint: 'Create the parent directory first by calling create_file_or_folder with a trailing "/" on the path.',
							suggestedTool: 'create_file_or_folder',
						});
					}
				}
				if (isFolder) { await fileService.createFolder(uri); }
				else {
					await fileService.createFile(uri);
					// Newly-created file is implicitly "known" content — allow subsequent edit_file without a re-read.
					this._markFileRead(uri);
				}
				return { result: {} };
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive });
				return { result: {} };
			},

			rewrite_file: async ({ uri, newContent }) => {
				await assertTargetNotDirectory(uri, 'write file');
				await vibeideModelService.initializeModel(uri);
				const streamState = this.commandBarService.getStreamState(uri);
				if (streamState === 'streaming') {
					// Only block if actually streaming to the same file - allow if streaming to different file
					throw new Error(`Cannot edit file ${uri.fsPath}: Another operation is currently streaming changes to this file. Please wait for it to complete or cancel it first.`);
				}
				// VibeIDE: Deterministic constraint enforcement before any file write
				try {
					this.vibeConstraintsService.checkWriteAllowed(uri.fsPath);
				} catch (e) {
					if (e instanceof ConstraintViolationError) {
						throw new Error(`[VibeIDE] Write blocked by .vibe/constraints.json: ${e.message}`);
					}
					throw e;
				}
				// VibeIDE: Per-file permissions check (.vibe/permissions.json)
				if (!this.vibePermissionsService.canWrite(uri.fsPath)) {
					throw new Error(`[VibeIDE] Write blocked by .vibe/permissions.json: ${uri.fsPath} is not in allow_write list`);
				}
				await this._checkAdvisoryTerritorialLocks(uri);
				// Auto-stash before rewrite (roadmap §L988): preserve dirty working tree before agent overwrites.
				const _stashDecisionRw = decideAutoStash({
					setting: this._gitAutoStashService.getMode(),
					dirtyFiles: this._textFileService.isDirty(uri) ? [uri.fsPath] : [],
					editTargets: [uri.fsPath],
				});
				if (_stashDecisionRw.kind === 'stash') {
					await this._gitAutoStashService.createStash(uri.fsPath);
				}
				// rewrite_file must create the file when missing AND have a resolvable editor model —
				// otherwise instantlyRewriteFile finds no model (`if (!model) return`) and silently does
				// nothing while the tool reports success (empty file). Two failure modes, both via the
				// existence cache in initializeModel:
				//  (A) the initializeModel at the top of this handler stat'd the absent path and cached
				//      `exists:false`; after createFile, a re-init reads that stale entry and skips the model.
				//  (B) the file was created by an earlier create_file_or_folder that left a stale
				//      `exists:false`, so the model is never resolved here at all.
				// Fix: create if missing, then UNCONDITIONALLY invalidate the cache + re-init, and require a
				// model before writing — a missing model becomes a loud tool_error, never silent success.
				// (User reports 2026-05-29 "Wrote does not create on first try" and 2026-06-10 "rewrite_file
				// reported success but the files were empty".)
				if (!(await fileService.exists(uri))) {
					await fileService.createFile(uri);
				}
				vibeideModelService.invalidateExistenceCache(uri);
				await vibeideModelService.initializeModel(uri);
				const modelForRewrite = vibeideModelService.getModel(uri).model;
				if (!modelForRewrite) {
					throw new Error(`Could not open an editable model for ${uri.fsPath} — the rewrite was NOT applied (no content written). The path may be unreadable or locked. Retry; if it persists, verify the path.`);
				}
				// Truncation guard: refuse to overwrite a SUBSTANTIAL existing file with content that is a
				// small fraction of it — almost always means the model re-emitted the whole file but its
				// output was cut off mid-stream, silently shrinking the file (data loss). New/empty files
				// (existingLen 0) never trip this. Incident 2026-06-11: minimax rewrote large files down to
				// ~11 lines, then resorted to throwaway patch scripts. Tunable / disengageable via config.
				if (this._configurationService.getValue<boolean>('vibeide.tools.rewriteFileTruncationGuard') ?? true) {
					const existingLen = modelForRewrite.getValueLength();
					const newLen = newContent.length;
					const minChars = Math.max(0, this._configurationService.getValue<number>('vibeide.tools.rewriteFileTruncationMinChars') ?? 2000);
					const ratio = Math.min(1, Math.max(0, this._configurationService.getValue<number>('vibeide.tools.rewriteFileTruncationRatio') ?? 0.3));
					if (existingLen >= minChars && newLen < existingLen * ratio) {
						const pct = Math.round((newLen / Math.max(1, existingLen)) * 100);
						throw new ToolValidationError({
							code: 'rewrite_truncation_suspected',
							message: `Refusing to overwrite ${uri.fsPath}: the current file is ${existingLen} chars but new_content is only ${newLen} (${pct}% of it). This usually means the content was truncated mid-output.`,
							hint: `Re-send the COMPLETE intended file content, or use edit_file for a targeted change. If this large reduction is intentional, set vibeide.tools.rewriteFileTruncationGuard to false.`,
							suggestedTool: 'edit_file',
						});
					}
				}
				await editCodeService.callBeforeApplyOrEdit(uri);
				// AI provenance marker (opt-in via vibeide.aiProvenance.markGeneratedCode).
				let effectiveContent = newContent;
				if (shouldMarkProvenance(this._configurationService.getValue('vibeide.aiProvenance.markGeneratedCode'))) {
					const ext = uri.path.split('.').pop() ?? '';
					const marker = formatProvenanceMarker(ext, 'vibeide-agent', new Date().toISOString());
					if (!effectiveContent.startsWith(marker)) {
						effectiveContent = marker + '\n' + effectiveContent;
					}
				}
				editCodeService.instantlyRewriteFile({ uri, newContent: effectiveContent });
				// After rewrite we know the exact content — subsequent edit_file does not need a re-read.
				this._markFileRead(uri);
				// Persist to disk and verify. instantlyRewriteFile triggers a save as a
				// floating promise, so a save failure would otherwise be swallowed while the
				// tool still reports success — the editor model holds the new content but disk
				// stays stale. Save explicitly and surface a tool_error if the file is still dirty.
				await vibeideModelService.saveModel(uri);
				if (this._textFileService.isDirty(uri)) {
					throw new Error(`Applied changes to ${uri.fsPath} in the editor but could not save them to disk (the file is still unsaved). It may be read-only, locked by another process, or blocked by a save participant. Verify the file and retry.`);
				}
				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000);
					const { lintErrors } = this._getLintErrors(uri);
					return { lintErrors };
				});
				return { result: lintErrorsPromise };
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await assertTargetNotDirectory(uri, 'edit file');
				// VibeIDE: Deterministic constraint enforcement before any file edit
				try {
					this.vibeConstraintsService.checkWriteAllowed(uri.fsPath);
				} catch (e) {
					if (e instanceof ConstraintViolationError) {
						throw new Error(`[VibeIDE] Edit blocked by .vibe/constraints.json: ${e.message}`);
					}
					throw e;
				}
				// Pre-flight: SEARCH/REPLACE editing without prior knowledge of the file content
				// is almost certainly hallucinated. Require a read_file call in this session for
				// pre-existing files. Skip for files we just created (not yet on disk).
				const fileExistsForEdit = await fileService.exists(uri);
				if (fileExistsForEdit && !this._hasBeenRead(uri)) {
					throw new ToolValidationError({
						code: 'edit_without_read',
						message: `Refusing to edit ${uri.fsPath}: it has not been read in this session. SEARCH/REPLACE blocks against unseen file content are unreliable.`,
						hint: 'Call read_file first, then issue edit_file using the exact text you observed.',
						suggestedTool: 'read_file',
					});
				}
				await this._checkAdvisoryTerritorialLocks(uri);
				// Same stale-existence-cache guard as rewrite_file: invalidate + re-init so the model
				// resolves for a just-created file, and require it before applying edits — a missing
				// model must surface as a tool_error, not a silent no-op against an empty buffer.
				vibeideModelService.invalidateExistenceCache(uri);
				await vibeideModelService.initializeModel(uri);
				if (!vibeideModelService.getModel(uri).model) {
					throw new Error(`Could not open an editable model for ${uri.fsPath} — the edit was NOT applied. The path may be missing, unreadable, or locked. Read the file and retry.`);
				}
				const streamState = this.commandBarService.getStreamState(uri);
				if (streamState === 'streaming') {
					// Only block if actually streaming to the same file - allow if streaming to different file
					throw new Error(`Cannot edit file ${uri.fsPath}: Another operation is currently streaming changes to this file. Please wait for it to complete or cancel it first.`);
				}
				// Auto-stash before edit (roadmap §L988): preserve dirty working tree before agent applies search-replace.
				const _stashDecisionEd = decideAutoStash({
					setting: this._gitAutoStashService.getMode(),
					dirtyFiles: this._textFileService.isDirty(uri) ? [uri.fsPath] : [],
					editTargets: [uri.fsPath],
				});
				if (_stashDecisionEd.kind === 'stash') {
					await this._gitAutoStashService.createStash(uri.fsPath);
				}
				await editCodeService.callBeforeApplyOrEdit(uri);
				const applyInfo = editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks });
				// Indentation mismatch surfaced as an informative note (NOT an error — the edit applied).
				// Tells the model the tool auto-aligned its block so it does not misread a ragged diff as a
				// tool "trim" bug and spiral retrying. See helpers/reindentSearchReplace.ts.
				let indentationNote: string | null = null;
				if (applyInfo.indentAdjustments.length > 0) {
					const widths = Array.from(new Set(applyInfo.indentAdjustments.map(a => a.fileIndentWidth))).sort((a, b) => a - b);
					indentationNote = `Отступ твоего old_string/new_string не совпал с файлом (отступ якорной строки: ${widths.join('/')} пробел(ов)) — я УЖЕ автоматически выровнял блок по файлу, правка применена корректно. НЕ присылай повторные правки только ради пробелов/отступа и не перечитывай файл по кругу из-за этого: посмотри diff ОДИН раз. Если отступ в diff ВСЁ ЕЩЁ неверный — пришли new_string с ТОЧНЫМ отступом КАЖДОЙ строки (включая первую) ИЛИ используй rewrite_file для всего блока.`;
				}
				// File content has just been mutated — re-mark as read so chained edits still pass the guard.
				this._markFileRead(uri);
				// Persist to disk and verify (see rewrite_file): a failed save must surface as a
				// tool_error rather than a silent success with stale on-disk content.
				await vibeideModelService.saveModel(uri);
				if (this._textFileService.isDirty(uri)) {
					throw new Error(`Applied edits to ${uri.fsPath} in the editor but could not save them to disk (the file is still unsaved). It may be read-only, locked by another process, or blocked by a save participant. Verify the file and retry.`);
				}

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000);
					const { lintErrors } = this._getLintErrors(uri);
					return { lintErrors, indentationNote };
				});

				return { result: lintErrorsPromise };
			},
			// ---
			run_command: async ({ command, cwd, terminalId, timeoutMs, runInBackground }) => {
				// Check for dangerous commands and warn
				const dangerLevel = this._detectCommandDanger(command);
				if (dangerLevel === 'high') {
					this.notificationService.warn(`⚠️ High-risk command detected: ${command}\nThis command may cause data loss or system changes. Please review carefully.`);
				} else if (dangerLevel === 'medium') {
					this.notificationService.info(`⚠️ Potentially risky command: ${command}\nReview before execution.`);
				}

				// Background mode: spin up a persistent (but hidden) terminal, kick off the command,
				// and return immediately with a backgroundId. The caller polls via read_background_output
				// or kills via kill_background_command.
				if (runInBackground) {
					const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd });
					const backgroundId = generateUuid();
					// Fire-and-forget; collect output later via read_terminal.
					void this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId, timeoutMs: timeoutMs ?? 600_000 });
					this._backgroundCommands.set(backgroundId, { persistentTerminalId, command, startedAt: Date.now() });
					return {
						result: Promise.resolve({
							result: `Command started in background. Use read_background_output with background_id="${backgroundId}" to fetch output, or kill_background_command to stop it.`,
							resolveReason: { type: 'done' as const, exitCode: 0 },
							backgroundId,
						}),
					};
				}

				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId, timeoutMs: timeoutMs ?? undefined });
				return { result: resPromise, interruptTool: interrupt };
			},
			run_nl_command: async ({ nlInput, cwd, terminalId }) => {
				// Parse natural language to shell command.
				const parsed = await this.nlShellParserService.parseNLToShell(nlInput, cwd, CancellationToken.None);

				// Anti-shell contract still applies AFTER parsing — the parser may have produced
				// a `cat`/`grep`/`findstr` form which we want to redirect to dedicated tools.
				const misuse = detectShellMisuse(parsed.command);
				if (misuse) {
					throw new ToolValidationError({
						code: 'shell_misuse',
						message: `Parsed command "${parsed.command.slice(0, 120)}" duplicates the ${misuse.suggestedTool} tool. ${misuse.hint}`,
						hint: misuse.hint,
						suggestedTool: misuse.suggestedTool,
					});
				}

				// L1053 — chat-mode confirm dialog UI. Service sets
				// `requiresConfirmation = estimatedRisk !== 'low'`; both medium (ambiguous)
				// and high (destructive) need an explicit confirm before execute.
				if (parsed.requiresConfirmation) {
					const isHigh = parsed.estimatedRisk === 'high';
					const { confirmed } = await this.dialogService.confirm({
						type: isHigh ? 'warning' : 'info',
						message: isHigh ? `Destructive command detected` : `Review command before running`,
						detail: `"${parsed.command}"\n\n${parsed.explanation || ''}\n\n${isHigh
							? 'This command may cause irreversible data loss. Proceed only if you are sure.'
							: 'Risk is ambiguous — confirm intent before execution.'}`,
						primaryButton: isHigh ? 'Run anyway' : 'Run',
					});
					if (!confirmed) {
						const abortMsg = `[Aborted by user: ${isHigh ? 'destructive' : 'ambiguous'} command not confirmed]`;
						return {
							result: Promise.resolve({
								result: abortMsg,
								resolveReason: { type: 'done' as const, exitCode: 1 },
								parsedCommand: parsed.command,
								explanation: parsed.explanation,
							}),
						};
					}
				}

				// Execute the parsed command.
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(parsed.command, { type: 'temporary', cwd, terminalId });

				// Wrap result to include parsed command info and mask secrets
				const maskedResPromise = resPromise.then(async (res) => {
					// Mask secrets in the result
					const secretResult = this.secretDetectionService.detectSecrets(res.result);
					const maskedResult = secretResult.hasSecrets ? secretResult.redactedText : res.result;

					return {
						result: maskedResult,
						resolveReason: res.resolveReason,
						parsedCommand: parsed.command,
						explanation: parsed.explanation,
					};
				});

				return { result: maskedResPromise, interruptTool: interrupt };
			},
			run_persistent_command: async ({ command, persistentTerminalId, timeoutMs }) => {
				// Check for dangerous commands and warn
				const dangerLevel = this._detectCommandDanger(command);
				if (dangerLevel === 'high') {
					this.notificationService.warn(`⚠️ High-risk command detected: ${command}\nThis command may cause data loss or system changes. Please review carefully.`);
				} else if (dangerLevel === 'medium') {
					this.notificationService.info(`⚠️ Potentially risky command: ${command}\nReview before execution.`);
				}
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId, timeoutMs: timeoutMs ?? undefined });
				return { result: resPromise, interruptTool: interrupt };
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd });
				return { result: { persistentTerminalId } };
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId);
				return { result: {} };
			},
			kill_background_command: async ({ backgroundId }) => {
				const entry = this._backgroundCommands.get(backgroundId);
				if (!entry) {
					return { result: { killed: false, backgroundId } };
				}
				try {
					await this.terminalToolService.killPersistentTerminal(entry.persistentTerminalId);
				} catch { /* already gone — treat as killed */ }
				this._backgroundCommands.delete(backgroundId);
				return { result: { killed: true, backgroundId } };
			},
			read_background_output: async ({ backgroundId }) => {
				const entry = this._backgroundCommands.get(backgroundId);
				if (!entry) {
					throw new ToolValidationError({
						code: 'unknown_background_id',
						message: `No background command with id "${backgroundId}". It may have been killed or never started.`,
						hint: 'Start a command with run_command + run_in_background=true to obtain a background_id.',
					});
				}
				const isRunning = this.terminalToolService.persistentTerminalExists(entry.persistentTerminalId);
				let output = '';
				try {
					output = await this.terminalToolService.readTerminal(entry.persistentTerminalId);
				} catch (e) {
					output = `(failed to read background terminal: ${(e as Error)?.message ?? e})`;
				}
				// Apply head+tail cap so we never blow the chat with a multi-MB tail.
				output = truncateHeadTail(output, 80_000);
				return { result: { backgroundId, output, isRunning } };
			},

			// ---

			web_search: async ({ query, k, refresh }) => {
				// Check offline/privacy mode (centralized gate)
				this._offlineGate.ensureNotOfflineOrPrivacy('Web search', false);

				const cacheKey = `search:${query}:${k}`;
				const cached = this._webSearchCache.get(cacheKey);
				if (!refresh && cached && Date.now() - cached.timestamp < this._cacheTTL) {
					return { result: { results: cached.results } };
				}

				const maxResults = k ?? 5;
				let lastError: Error | null = null;
				const errors: string[] = [];

				// Try multiple search methods with retries
				// Methods that use webContentExtractorService run in main process and bypass CORS
				const searchMethods: Array<{ name: string; method: () => Promise<Array<{ title: string; snippet: string; url: string }>> }> = [
					// Method 1: DuckDuckGo Instant Answer API (fast, direct API - may hit CORS but worth trying first)
					{
						name: 'DuckDuckGo Instant Answer API',
						method: async () => {
							const instantUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
							try {
								const response = await this.requestService.request({
									type: 'GET',
									url: instantUrl,
									timeout: 10000,
									callSite: 'vibeToolsDDGInstant',
								}, CancellationToken.None);

								const json = await asJson<DuckDuckGoInstantAnswer>(response);
								const results: Array<{ title: string; snippet: string; url: string }> = [];

								if (json?.AbstractText) {
									results.push({
										title: json.Heading || query,
										snippet: json.AbstractText,
										url: json.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
									});
								}

								if (json?.RelatedTopics && Array.isArray(json.RelatedTopics)) {
									for (const topic of json.RelatedTopics.slice(0, maxResults - results.length)) {
										if (topic?.Text && topic?.FirstURL) {
											results.push({
												title: topic.Text.split(' - ')[0] || topic.Text.substring(0, 100),
												snippet: topic.Text,
												url: topic.FirstURL,
											});
										}
									}
								}

								if (results.length === 0) {
									throw new Error('No results from DuckDuckGo Instant Answer API');
								}

								return results;
							} catch (error) {
								const errorMsg = error instanceof Error ? error.message : String(error);
								// Check if it's a CORS or network error
								if (errorMsg.includes('CORS') || errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError')) {
									throw new Error(`Network/CORS error: ${errorMsg}. The DuckDuckGo API may be blocked.`);
								}
								throw error;
							}
						}
					},
					// Method 2: DuckDuckGo HTML search via webContentExtractorService (reliable, bypasses CORS)
					{
						name: 'DuckDuckGo HTML via webContentExtractorService',
						method: async () => {
							const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
							try {
								const uri = URI.parse(searchUrl);
								const extracted = await this.webContentExtractorService.extract([uri]);

								if (!extracted || extracted.length === 0 || extracted[0]?.status !== 'ok' || !extracted[0].result) {
									throw new Error('Failed to extract DuckDuckGo search results');
								}

								const content = extracted[0].result;
								const results: Array<{ title: string; snippet: string; url: string }> = [];

								// Helper function to extract real URL from DuckDuckGo redirect
								const extractRealUrl = (url: string): string | null => {
									if (!url || !url.startsWith('http')) { return null; }

									// Check if it's a DuckDuckGo redirect URL
									if (url.includes('duckduckgo.com/l/')) {
										try {
											const urlObj = new URL(url);
											const uddgParam = urlObj.searchParams.get('uddg');
											if (uddgParam) {
												return decodeURIComponent(uddgParam);
											}
										} catch (e) {
											// If URL parsing fails, try regex extraction
											const uddgMatch = url.match(/uddg=([^&]+)/);
											if (uddgMatch) {
												try {
													return decodeURIComponent(uddgMatch[1]);
												} catch (e2) {
													// Ignore decode errors
												}
											}
										}
									}

									// Not a redirect, return as-is
									return url;
								};

								// Strategy 1: Parse markdown links [text](url) - most reliable
								const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
								const markdownLinks: Array<{ url: string; title: string; index: number }> = [];
								let match;
								markdownLinkRegex.lastIndex = 0;

								while ((match = markdownLinkRegex.exec(content)) !== null && markdownLinks.length < maxResults * 2) {
									const rawUrl = match[2].trim();
									const title = match[1].trim();

									// Skip empty titles or URLs
									if (!title || !rawUrl) { continue; }

									// Extract real URL (handles DuckDuckGo redirects)
									const realUrl = extractRealUrl(rawUrl);
									if (!realUrl) { continue; }

									// Filter out DuckDuckGo internal links and invalid URLs
									if (realUrl.startsWith('http://') || realUrl.startsWith('https://')) {
										if (!realUrl.includes('duckduckgo.com') &&
											!realUrl.includes('duck.com') &&
											!realUrl.startsWith('#') &&
											realUrl.length < 500) {
											markdownLinks.push({ url: realUrl, title, index: match.index });
											if (markdownLinks.length >= maxResults) {
												break;
											}
										}
									}
								}

								// Sort by position in content
								markdownLinks.sort((a, b) => a.index - b.index);

								for (let i = 0; i < Math.min(markdownLinks.length, maxResults); i++) {
									const link = markdownLinks[i];

									// Try to extract snippet from content around the link
									let snippet = '';
									const linkPattern = `[${link.title}](${link.url})`;
									const linkIndex = content.indexOf(linkPattern, link.index);
									if (linkIndex >= 0) {
										const start = Math.max(0, linkIndex - 100);
										const end = Math.min(content.length, linkIndex + linkPattern.length + 200);
										const context = content.substring(start, end)
											.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
											.replace(/<[^>]*>/g, ' ')
											.replace(/\s+/g, ' ')
											.trim();
										snippet = context.substring(0, 200);
									}

									results.push({
										title: link.title,
										snippet: snippet || 'No snippet available',
										url: link.url,
									});
								}

								// Strategy 2: Fallback - extract URLs directly if we don't have enough results
								if (results.length < maxResults) {
									const existingUrls = new Set(results.map(r => r.url));
									const urlRegex = /https?:\/\/[^\s<>"'\n\r\)]+/gi;
									const urlMatches: Array<{ url: string; index: number }> = [];

									urlRegex.lastIndex = 0;
									const needed = maxResults - results.length;
									while ((match = urlRegex.exec(content)) !== null && urlMatches.length < needed * 2) {
										const rawUrl = match[0].replace(/[.,;:!?]+$/, '');

										// Extract real URL from DuckDuckGo redirect if needed
										const realUrl = extractRealUrl(rawUrl);
										if (!realUrl) { continue; }

										if (realUrl.length > 10 && realUrl.length < 500 &&
											!realUrl.includes('duckduckgo.com') &&
											!realUrl.includes('duck.com') &&
											!existingUrls.has(realUrl)) {
											urlMatches.push({ url: realUrl, index: match.index });
											if (urlMatches.length >= needed) {
												break;
											}
										}
									}

									urlMatches.sort((a, b) => a.index - b.index);

									for (let i = 0; i < Math.min(urlMatches.length, needed); i++) {
										const { url, index } = urlMatches[i];

										// Extract context around URL for title/snippet
										const start = Math.max(0, index - 100);
										const end = Math.min(content.length, index + url.length + 200);
										const context = content.substring(start, end)
											.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
											.replace(/<[^>]*>/g, ' ')
											.replace(/\s+/g, ' ')
											.trim();

										// Extract title from before URL
										const beforeUrl = content.substring(start, index).trim();
										const words = beforeUrl.split(/\s+/).filter(w => w.length > 2);
										const title = words.length > 0
											? words.slice(-5).join(' ').substring(0, 100)
											: url;

										// Extract snippet from after URL
										const afterUrl = content.substring(index + url.length, end).trim();
										const snippet = afterUrl.substring(0, 200) || context.substring(0, 200) || 'No snippet available';

										results.push({
											title: title || url,
											snippet: snippet,
											url: url,
										});
									}
								}

								if (results.length === 0) {
									// Provide diagnostic info
									const contentPreview = content.substring(0, 1000).replace(/\s+/g, ' ');
									const hasUrls = /https?:\/\//i.test(content);
									const hasMarkdownLinks = /\[.*?\]\(.*?\)/.test(content);

									throw new Error(
										`No results found in DuckDuckGo search. ` +
										`Content length: ${content.length}, ` +
										`Has URLs: ${hasUrls}, ` +
										`Has markdown links: ${hasMarkdownLinks}, ` +
										`Preview: ${contentPreview.substring(0, 300)}...`
									);
								}

								return results;
							} catch (error) {
								throw error;
							}
						}
					},
				];

				// Try each method (with single retry only for transient errors)
				for (const { name, method } of searchMethods) {
					for (let attempt = 0; attempt < 2; attempt++) {
						try {
							const results = await method();
							const resultData = { results };
							this._webSearchCache.set(cacheKey, { ...resultData, timestamp: Date.now() });
							return { result: resultData };
						} catch (error) {
							const errorMsg = error instanceof Error ? error.message : String(error);
							errors.push(`${name}: ${errorMsg}`);
							lastError = error instanceof Error ? error : new Error(String(error));

							// Only retry on transient errors (network/timeout), not parsing errors
							const isTransientError = errorMsg.includes('timeout') ||
								errorMsg.includes('network') ||
								errorMsg.includes('CORS') ||
								errorMsg.includes('Failed to fetch');

							if (attempt < 1 && isTransientError) {
								// Shorter wait before retry (500ms instead of 1000ms)
								await new Promise(resolve => setTimeout(resolve, 500));
							} else {
								// Don't retry parsing errors or if we've already retried
								break;
							}
						}
					}
				}

				// All methods failed
				const errorMessage = lastError?.message || 'Unknown error';
				const allErrors = errors.length > 0 ? errors.join('; ') : errorMessage;
				throw new Error(`Web search failed: ${allErrors}. This could be due to network issues or all search services being temporarily unavailable. Please check your internet connection and try again.`);
			},

			browse_url: async ({ url, refresh }) => {
				// Check offline/privacy mode (centralized gate)
				this._offlineGate.ensureNotOfflineOrPrivacy('URL browsing', false);

				const cacheKey = `browse:${url}`;
				const cached = this._browseCache.get(cacheKey);
				if (!refresh && cached && Date.now() - cached.timestamp < this._cacheTTL) {
					return { result: { content: cached.content, title: cached.title, url: cached.url, metadata: cached.metadata } };
				}

				try {
					const uri = URI.parse(url);
					const useHeadless = this.vibeideSettingsService.state.globalSettings.useHeadlessBrowsing !== false; // Default to true

					// Try using web content extractor first if headless browsing is enabled (better for complex pages)
					if (useHeadless) {
						try {
							const extracted = await this.webContentExtractorService.extract([uri]);
							const first = extracted?.[0];
							if (first?.status === 'ok') {
								const content = first.result;
								// Try to extract title from URL or content
								const titleMatch = content.match(/^[^\n]{0,200}/);
								const title = titleMatch ? titleMatch[0].trim().substring(0, 100) : undefined;

								const resultData = { content, title, url, metadata: {} };
								this._browseCache.set(cacheKey, { ...resultData, timestamp: Date.now() });
								return { result: resultData };
							} else if (first?.status === 'redirect' && !refresh) {
								return this.callTool.browse_url({
									url: first.toURI.toString(),
									refresh
								});
							}
							// fallthrough for error status
						} catch (extractorError) {
							// Fallback to direct fetch if extractor fails
						}
					}

					// Fallback: fetch and extract text manually (always available as backup)
					const response = await this.requestService.request({
						type: 'GET',
						url,
						timeout: 15000,
						callSite: 'vibeToolsWebFetch',
					}, CancellationToken.None);

					const html = await asTextOrError(response);
					if (!html) {
						throw new Error('Failed to fetch page content');
					}

					// Simple HTML to text extraction
					let text = html
						.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
						.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
						.replace(/<[^>]+>/g, ' ')
						.replace(/\s+/g, ' ')
						.trim();

					// Extract title
					const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
					const title = titleMatch ? titleMatch[1].trim() : undefined;

					// Limit content size
					if (text.length > 50000) {
						text = text.substring(0, 50000) + '... (content truncated)';
					}

					const resultData = { content: text, title, url, metadata: {} };
					this._browseCache.set(cacheKey, { ...resultData, timestamp: Date.now() });
					return { result: resultData };
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					throw new Error(`Failed to browse URL ${url}: ${errorMessage}. Please check the URL and your internet connection.`);
				}
			},
			vibe_complete: async ({ summary }) => {
				// No-op control signal: the agent loop short-circuits on this call and ends the
				// run BEFORE dispatch reaches here. Implemented for type-completeness / safety.
				return { result: { summary } };
			},
		};


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : '';

		// Cap individual search-tool outputs so a single greedy result (e.g. `grep "**/*"`
		// matching 700+ files) can't blow up the LLM context and crash aggregator-proxied
		// models. Cap is read fresh per-call so a config change applies immediately.
		// Uses head+tail truncation: model sees the start and the end with a `[truncated]`
		// marker in the middle, which preserves enough signal to refine the next call.
		const truncateSearchOutput = (s: string): string => {
			const cap = Math.max(1000, Math.min(50000,
				this._configurationService.getValue<number>('vibeide.tools.searchMaxChars') ?? 8000
			));
			return truncateHeadTail(s, cap);
		};

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, readFileMaxCharsPerPage());
		};

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				const window = result.startLineReturned && result.endLineReturned
					? `lines ${result.startLineReturned}-${result.endLineReturned} of ${result.totalNumLines}`
					: `${result.totalNumLines} lines`;
				// Navigation hint at the TOP (before the body) so the model reads it first — mirrors
				// opencode/kilo/roo/crush. Goal: stop the read→forget→re-read loop by pointing the model
				// at ranged continuation and at grep/search_in_file instead of re-reading the whole file.
				const nav = result.truncatedByLineLimit
					? `⚠️ Partial read (${window}). To continue: read_file with start_line=${result.endLineReturned + 1}. To jump to specific content, prefer grep/search_in_file over re-reading the whole file.\n`
					: result.hasNextPage
						? `⚠️ Partial read (${window}; ${result.totalFileLen} chars on this page, file has more). Continue with page_number, or use grep/search_in_file to jump to content — avoid re-reading the whole file.\n`
						: '';
				return `${nav}${params.uri.fsPath} (${window})\n\`\`\`\n${result.fileContents}\n\`\`\``;
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result);
				return truncateSearchOutput(dirTreeStr); // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return truncateSearchOutput(result.str);
			},
			search_pathnames_only: (params, result) => {
				const capNote = result.limitHit ? `\n(results capped — refine the query or include_pattern)` : '';
				if (result.uris.length === 0 && result.limitHit) {
					return `Pathname search timed out (scope too large). Refine the query or pass include_pattern.`;
				}
				return truncateSearchOutput(result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage) + capNote);
			},
			search_for_files: (params, result) => {
				return truncateSearchOutput(result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage));
			},
			glob: (params, result) => {
				if (result.uris.length === 0) {
					// D.21: distinguish "search too broad / timed out" (limitHit) from genuinely empty,
					// so the model narrows instead of re-issuing the same broad pattern in a loop.
					return result.limitHit
						? `Search for "${params.pattern}" was too broad to finish in time. Narrow the pattern (e.g. a subfolder) or pass search_in_folder.`
						: `No files match pattern "${params.pattern}".`;
				}
				const capNote = result.limitHit ? `\n(results capped — more matches exist; narrow the pattern or pass search_in_folder)` : '';
				const header = `Matched ${result.totalMatches}${result.limitHit ? '+' : ''} file${result.totalMatches === 1 ? '' : 's'} for "${params.pattern}":\n`;
				return truncateSearchOutput(header + result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage) + capNote);
			},
			grep: (params, result) => {
				if (result.totalMatches === 0) {
					return `No matches for "${params.pattern}".`;
				}
				if (result.mode === 'files_with_matches') {
					return truncateSearchOutput(`${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'} across ${result.files.length} file${result.files.length === 1 ? '' : 's'}:\n` +
						result.files.map(f => f.uri.fsPath).join('\n') + nextPageStr(result.hasNextPage));
				}
				if (result.mode === 'count') {
					return truncateSearchOutput(`${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'} across ${result.files.length} file${result.files.length === 1 ? '' : 's'}:\n` +
						result.files.map(f => `${f.uri.fsPath}: ${f.count ?? 0}`).join('\n') + nextPageStr(result.hasNextPage));
				}
				return truncateSearchOutput(`${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'}:\n` +
					result.matches.map(m => `${m.uri.fsPath}:${m.line}:${m.column}\n${m.preview}`).join('\n\n') + nextPageStr(result.hasNextPage));
			},
			search_in_file: (params, result) => {
				const { model } = vibeideModelService.getModel(params.uri);
				if (!model) { return '<Error getting string of result>'; }
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF);
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``;
				}).join('\n\n');
				return lines;
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.';
			},
			open_file: (params, _result) => {
				return `File opened: ${params.uri.fsPath}`;
			},
			go_to_definition: (params, result) => {
				if (result.locations.length === 0) {
					return `No definition found at line ${params.line}, column ${params.column} in ${params.uri.fsPath}`;
				}
				return result.locations.map((loc, i) =>
					`Definition ${i + 1}: ${loc.uri.fsPath}:${loc.startLine}:${loc.startColumn}`
				).join('\n');
			},
			find_references: (params, result) => {
				if (result.locations.length === 0) {
					return `No references found for symbol at line ${params.line}, column ${params.column} in ${params.uri.fsPath}`;
				}
				return `Found ${result.locations.length} reference(s):\n${result.locations.map((loc, i) =>
					`${i + 1}. ${loc.uri.fsPath}:${loc.startLine}:${loc.startColumn}`
				).join('\n')}`;
			},
			search_symbols: (params, result) => {
				if (result.symbols.length === 0) {
					return `No symbols found matching "${params.query}"${params.uri ? ` in ${params.uri.fsPath}` : ' in workspace'}`;
				}
				return `Found ${result.symbols.length} symbol(s):\n${result.symbols.map((sym, i) =>
					`${i + 1}. ${sym.name} (${sym.kind}) - ${sym.uri.fsPath}:${sym.startLine}:${sym.startColumn}`
				).join('\n')}`;
			},
			automated_code_review: (params, result) => {
				if (result.issues.length === 0) {
					return `No issues found in ${params.uri.fsPath}. Code looks good!`;
				}
				const bySeverity = { error: [] as typeof result.issues, warning: [] as typeof result.issues, info: [] as typeof result.issues };
				for (const issue of result.issues) {
					bySeverity[issue.severity].push(issue);
				}
				let output = `Code review for ${params.uri.fsPath}:\n\n`;
				if (bySeverity.error.length > 0) {
					output += `Errors (${bySeverity.error.length}):\n${bySeverity.error.map(i => `  Line ${i.line}: ${i.message}${i.suggestion ? `\n    Suggestion: ${i.suggestion}` : ''}`).join('\n')}\n\n`;
				}
				if (bySeverity.warning.length > 0) {
					output += `Warnings (${bySeverity.warning.length}):\n${bySeverity.warning.map(i => `  Line ${i.line}: ${i.message}${i.suggestion ? `\n    Suggestion: ${i.suggestion}` : ''}`).join('\n')}\n\n`;
				}
				if (bySeverity.info.length > 0) {
					output += `Info (${bySeverity.info.length}):\n${bySeverity.info.map(i => `  Line ${i.line}: ${i.message}${i.suggestion ? `\n    Suggestion: ${i.suggestion}` : ''}`).join('\n')}`;
				}
				return output;
			},
			generate_tests: (params, result) => {
				return `Generated test file: ${result.testFileUri.fsPath}\n\nTest code:\n\`\`\`\n${result.testCode}\n\`\`\``;
			},
			rename_symbol: (params, result) => {
				if (result.changes.length === 0) {
					return `No changes made. Could not find symbol to rename at line ${params.line}, column ${params.column} in ${params.uri.fsPath}`;
				}
				return `Renamed symbol to "${params.newName}" in ${result.changes.length} location(s):\n${result.changes.map((c, i) =>
					`${i + 1}. ${c.uri.fsPath}:${c.line}:${c.column}`
				).join('\n')}`;
			},
			extract_function: (params, result) => {
				return `Extracted function "${params.functionName}" from lines ${params.startLine}-${params.endLine}.\n\nNew function:\n\`\`\`\n${result.newFunctionCode}\n\`\`\`\n\nReplacement code:\n\`\`\`\n${result.replacementCode}\n\`\`\``;
			},
			// ---
			create_file_or_folder: (params, result) => {
				if (params.isFolder) {
					return `Folder created at ${params.uri.fsPath}.`;
				}
				// Be explicit that the file is EMPTY. Models otherwise read "successfully
				// created" as "created with the content I intended" and move on without
				// ever writing it — the file stays 0 bytes until the user notices.
				return `Empty file created at ${params.uri.fsPath}. It has NO content yet (0 bytes). To write its contents, call rewrite_file with this uri now — do not assume the file contains anything until you have written it.`;
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`;
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.vibeideSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '');

				const indentNote = result.indentationNote ? `\n${result.indentationNote}` : '';
				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${indentNote}`;
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.vibeideSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '');

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`;
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, backgroundId } = result;
				if (backgroundId) {
					return `${result_}\n(background_id=${backgroundId})`;
				}
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`;
				}
				// normal command — inactivity timeout TERMINATES the command (temporary terminal is
				// disposed via interrupt()), so the output is PARTIAL. Make non-completion explicit so
				// the agent doesn't treat it as a finished step (roadmap #1640).
				if (resolveReason.type === 'timeout') {
					const usedTimeoutMs = params.timeoutMs ?? MAX_TERMINAL_INACTIVE_TIME * 1000;
					const awaitingInput = looksLikeShellAwaitingInput(typeof result_ === 'string' ? result_ : '');
					return `${result_}\n${formatTerminalTimeoutNotice(Math.round(usedTimeoutMs / 1000), awaitingInput)}`;
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`);
			},
			run_nl_command: (params, result) => {
				const { resolveReason, result: result_, parsedCommand, explanation } = result;
				const commandInfo = `Parsed command: \`${parsedCommand}\`\n${explanation}\n\n`;
				// success
				if (resolveReason.type === 'done') {
					return `${commandInfo}${result_}\n(exit code ${resolveReason.exitCode})`;
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					const awaitingInput = looksLikeShellAwaitingInput(typeof result_ === 'string' ? result_ : '');
					const tail = awaitingInput
						? ' The shell was waiting for more input (a ">>" continuation prompt) — most likely an unterminated quote or here-string. Do NOT retry the same command; to write file contents use the rewrite_file or edit_file tool instead of building the file line-by-line in the shell.'
						: ' To try with more time, open a persistent terminal and run the command there.';
					return `${commandInfo}${result_}\nTerminal command ran, but was automatically killed by VibeIDE after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully.${tail}`;
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`);
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result;
				const { persistentTerminalId } = params;
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`;
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					const awaitingInput = looksLikeShellAwaitingInput(typeof result_ === 'string' ? result_ : '');
					const suffix = awaitingInput
						? ` The shell is waiting for more input (a ">>" continuation prompt) and will not proceed on its own — most likely an unterminated quote or here-string. Cancel it with kill_persistent_terminal and use rewrite_file/edit_file to write file contents instead of building the file line-by-line in the shell.`
						: '';
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.${suffix}`;
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`);
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
			kill_background_command: (_params, result) => {
				return result.killed
					? `Killed background command "${result.backgroundId}".`
					: `No active background command with id "${result.backgroundId}" — it may have already exited.`;
			},
			read_background_output: (_params, result) => {
				const status = result.isRunning ? 'still running' : 'finished';
				return `Background command "${result.backgroundId}" (${status}):\n\`\`\`\n${result.output}\n\`\`\``;
			},

			// ---

			web_search: (params, result) => {
				if (result.results.length === 0) {
					return `No search results found for "${params.query}".`;
				}
				return result.results.map((r, i) =>
					`${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
				).join('\n\n');
			},

			browse_url: (params, result) => {
				const titleStr = result.title ? `Title: ${result.title}\n\n` : '';
				const metadataStr = result.metadata?.publishedDate ? `Published: ${result.metadata.publishedDate}\n\n` : '';
				return `${titleStr}${metadataStr}Content from ${result.url}:\n\n${result.content.substring(0, 10000)}${result.content.length > 10000 ? '\n\n... (content truncated)' : ''}`;
			},
			vibe_complete: (_params, result) => {
				// Normally unreached (loop short-circuits before dispatch); harmless otherwise.
				return result.summary ? `Ход завершён. Итог: ${result.summary}` : 'Ход завершён.';
			},
		};



	}

	/** Roadmap § B.2: advisory territorial locks (.vibe/agent-locks.json) — supervised blocks, auto → audit */
	private async _checkAdvisoryTerritorialLocks(uri: URI): Promise<void> {
		const conflict = await this._agentTerritorialLockService.evaluateWrite(uri);
		if (!conflict) {
			return;
		}
		const autopilot = this.vibeideSettingsService.state.globalSettings.chatAgentAutopilot === true;
		const autoEdits = this.vibeideSettingsService.state.globalSettings.autoApprove.edits === true;
		const holders = conflict.holders.join(', ');
		const patterns = conflict.patterns.join(', ');
		const detail = `holders=${holders}; patterns=${patterns}`;
		if (autopilot || autoEdits) {
			if (this._auditLogService.isEnabled()) {
				void this._auditLogService.append({
					ts: Date.now(),
					action: 'advisory_territorial_lock',
					ok: true,
					files: [uri.fsPath],
					meta: { holders: conflict.holders, patterns: conflict.patterns },
				});
			}
			vibeLog.warn('tools', `Advisory territorial lock (auto edit, audit): ${detail}`);
			return;
		}
		throw new Error(`[VibeIDE] Advisory territorial lock — write blocked in supervised mode (${detail}). Adjust .vibe/agent-locks.json or use an approved/auto edit workflow.`);
	}

	/**
	 * Detects dangerous terminal commands that may cause data loss or system changes.
	 * Returns 'high' for extremely dangerous commands, 'medium' for potentially risky, or 'low' for safe.
	 */
	private _detectCommandDanger(command: string): 'high' | 'medium' | 'low' {
		const normalizedCmd = command.trim().toLowerCase();

		// High-risk commands: data loss, system modification, privilege escalation
		const highRiskPatterns = [
			/rm\s+-rf/,           // Recursive force delete
			/rm\s+-r\s+/,
			/dd\s+if=/,           // Disk operations
			/sudo\s+(rm|del|format|mkfs|fdisk)/, // Sudo with destructive ops
			/chmod\s+.*777/,       // Dangerous permissions
			/chown\s+-R/,         // Recursive ownership changes
			/format\s+/,
			/fdisk\s+/,
			/parted\s+/,
			/curl\s+.*\|?\s*sh\s*$/, // Piping to shell
			/wget\s+.*\|?\s*sh\s*$/,
			/echo\s+.*\|?\s*sh\s*$/,
			/\$\(curl\s+/,
			/\$\(wget\s+/,
			/uninstall/,
			/purge\s+/,
			/npm\s+uninstall\s+-g/,
			/pip\s+uninstall/,
			/git\s+reset\s+--hard/,
			/git\s+clean\s+-fd/,
			/git\s+push\s+--force/,
			/git\s+push\s+-f/,
		];

		// Medium-risk commands: potentially risky but context-dependent
		const mediumRiskPatterns = [
			/sudo\s+/,            // Privilege escalation
			/chmod\s+/,           // Permission changes
			/chown\s+/,           // Ownership changes
			/rm\s+/,              // Delete (but not recursive)
			/del\s+/,             // Windows delete
			/rmdir\s+/,           // Directory removal
			/unlink\s+/,          // File unlinking
			/mv\s+.*\s+\.\.\//,   // Moving files outside workspace
			/cp\s+.*\s+\.\.\//,   // Copying files outside workspace
			/git\s+push/,         // Git push (could push to wrong remote)
			/git\s+reset/,        // Git reset
			/npm\s+install\s+-g/, // Global npm installs
			/pip\s+install\s+--user/, // User-level pip installs
			/docker\s+rm/,        // Docker container removal
			/docker\s+rmi/,       // Docker image removal
			/kubectl\s+delete/,   // Kubernetes deletion
			/systemctl\s+/,
			/service\s+/,
			/apt\s+remove/,
			/yum\s+remove/,
			/pacman\s+-R/,
		];

		for (const pattern of highRiskPatterns) {
			if (pattern.test(normalizedCmd)) {
				return 'high';
			}
		}

		for (const pattern of mediumRiskPatterns) {
			if (pattern.test(normalizedCmd)) {
				return 'medium';
			}
		}

		return 'low';
	}

	private _markFileRead(uri: URI): void {
		this._filesReadInSession.add(uri.toString());
	}

	private _hasBeenRead(uri: URI): boolean {
		return this._filesReadInSession.has(uri.toString());
	}

	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem));

		if (!lintErrors.length) { return { lintErrors: null }; }
		return { lintErrors, };
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
