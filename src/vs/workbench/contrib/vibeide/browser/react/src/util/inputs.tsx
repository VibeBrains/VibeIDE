/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { forwardRef, ForwardRefExoticComponent, MutableRefObject, RefAttributes, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IInputBoxStyles, InputBox } from '../../../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { SelectBox } from '../../../../../../../base/browser/ui/selectBox/selectBox.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Checkbox } from '../../../../../../../base/browser/ui/toggle/toggle.js';

import { useAccessor } from './services.js';
import { tokenizeToString } from '../../../../../../../editor/common/languages/textToHtmlTokenizer.js';
import { createTrustedTypesPolicy } from '../../../../../../../base/browser/trustedTypes.js';

// Workbench enables a Trusted Types CSP, so raw `element.innerHTML = string` is blocked.
// Same pattern as `EditorMarkdownCodeBlockRenderer` (VS Code core): wrap the tokenized
// HTML through a named TT policy so the assignment is allowed.
//
// tsup builds several React bundles (vibe-settings-tsx, vibe-onboarding, sidebar, ...),
// and inlines this module into every bundle that imports anything from it. That means
// `createPolicy` would fire once per bundle on the same page — the second call throws
// "Policy ... already exists" under the workbench CSP. Cache the result on globalThis
// so sibling bundles see the existing policy instead of re-creating it.
type _BlockCodeTTP = Pick<TrustedTypePolicy, 'name' | 'createHTML'> | undefined;
const _vibeideBlockCodeTTP: _BlockCodeTTP = (() => {
	const g = globalThis as unknown as { __vibeideBlockCodeTTP?: _BlockCodeTTP };
	if ('__vibeideBlockCodeTTP' in g) {return g.__vibeideBlockCodeTTP;}
	const policy = createTrustedTypesPolicy('vibeideBlockCodeTokenizer', {
		createHTML(html: string) { return html; }
	});
	g.__vibeideBlockCodeTTP = policy;
	return policy;
})();
import { asCssVariable } from '../../../../../../../platform/theme/common/colorUtils.js';
import { inputBackground, inputForeground } from '../../../../../../../platform/theme/common/colorRegistry.js';
import { useFloating, autoUpdate, offset, flip, shift, size, autoPlacement } from '@floating-ui/react';
import { URI } from '../../../../../../../base/common/uri.js';
import { getBasename, getFolderName } from '../sidebar-tsx/SidebarChat.js';
import { ChevronRight, File, Folder, FolderClosed, LucideProps } from 'lucide-react';
import { StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { DiffEditorWidget } from '../../../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { extractSearchReplaceBlocks, ExtractedSearchReplaceBlock } from '../../../../common/helpers/extractCodeFromResult.js';
import { IAccessibilitySignalService } from '../../../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IEditorProgressService } from '../../../../../../../platform/progress/common/progress.js';
import { detectLanguage } from '../../../../common/helpers/languageHelpers.js';
import { inputsS } from '../vibe-settings-tsx/vibeSettingsRu.js';


type GenerateNextOptions = (optionText: string) => Promise<Option[]>;

type Option = {
	fullName: string;
	abbreviatedName: string;
	iconInMenu: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>; // type for lucide-react components
} & (
		| { leafNodeType?: undefined; nextOptions: Option[]; generateNextOptions?: undefined }
		| { leafNodeType?: undefined; nextOptions?: undefined; generateNextOptions: GenerateNextOptions }
		| { leafNodeType: 'File' | 'Folder'; uri: URI; range?: any; nextOptions?: undefined; generateNextOptions?: undefined }
	);


const isSubsequence = (text: string, pattern: string): boolean => {

	text = text.toLowerCase();
	pattern = pattern.toLowerCase();

	if (pattern === '') {return true;}
	if (text === '') {return false;}
	if (pattern.length > text.length) {return false;}

	const seq: boolean[][] = Array(pattern.length + 1)
		.fill(null)
		.map(() => Array(text.length + 1).fill(false));

	for (let j = 0; j <= text.length; j++) {
		seq[0][j] = true;
	}

	for (let i = 1; i <= pattern.length; i++) {
		for (let j = 1; j <= text.length; j++) {
			if (pattern[i - 1] === text[j - 1]) {
				seq[i][j] = seq[i - 1][j - 1];
			} else {
				seq[i][j] = seq[i][j - 1];
			}
		}
	}
	return seq[pattern.length][text.length];
};


const scoreSubsequence = (text: string, pattern: string): number => {
	if (pattern === '') {return 0;}

	text = text.toLowerCase();
	pattern = pattern.toLowerCase();

	// We'll use dynamic programming to find the longest consecutive substring
	const n = text.length;
	const m = pattern.length;

	// This will track our maximum consecutive match length
	let maxConsecutive = 0;

	// For each starting position in the text
	for (let i = 0; i < n; i++) {
		// Check for matches starting from this position
		let consecutiveCount = 0;

		// For each character in the pattern
		for (let j = 0; j < m; j++) {
			// If we have a match and we're still within text bounds
			if (i + j < n && text[i + j] === pattern[j]) {
				consecutiveCount++;
			} else {
				// Break on first non-match
				break;
			}
		}

		// Update our maximum
		maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
	}

	return maxConsecutive;
};


function getRelativeWorkspacePath(accessor: ReturnType<typeof useAccessor>, uri: URI): string {
	const workspaceService = accessor.get('IWorkspaceContextService');
	const workspaceFolders = workspaceService.getWorkspace().folders;

	if (!workspaceFolders.length) {
		return uri.fsPath; // No workspace folders, return original path
	}

	// Sort workspace folders by path length (descending) to match the most specific folder first
	const sortedFolders = [...workspaceFolders].sort((a, b) =>
		b.uri.fsPath.length - a.uri.fsPath.length
	);

	// Add trailing slash to paths for exact matching
	const uriPath = uri.fsPath.endsWith('/') ? uri.fsPath : uri.fsPath + '/';

	// Check if the URI is inside any workspace folder
	for (const folder of sortedFolders) {


		const folderPath = folder.uri.fsPath.endsWith('/') ? folder.uri.fsPath : folder.uri.fsPath + '/';
		if (uriPath.startsWith(folderPath)) {
			// Calculate the relative path by removing the workspace folder path
			let relativePath = uri.fsPath.slice(folder.uri.fsPath.length);
			// Remove leading slash if present
			if (relativePath.startsWith('/')) {
				relativePath = relativePath.slice(1);
			}
			// console.log({ folderPath, relativePath, uriPath });

			return relativePath;
		}
	}

	// URI is not in any workspace folder, return original path
	return uri.fsPath;
}



const numOptionsToShow = 100;



// TODO make this unique based on other options
const getAbbreviatedName = (relativePath: string) => {
	return getBasename(relativePath, 1);
};

const getOptionsAtPath = async (accessor: ReturnType<typeof useAccessor>, path: string[], optionText: string): Promise<Option[]> => {

	const toolsService = accessor.get('IToolsService');



	const searchForFilesOrFolders = async (t: string, searchFor: 'files' | 'folders') => {
		try {

			const searchResults = (await (await toolsService.callTool.search_pathnames_only({
				query: t,
				includePattern: null,
				pageNumber: 1,
			})).result).uris;

			if (searchFor === 'files') {
				const res: Option[] = searchResults.map(uri => {
					const relativePath = getRelativeWorkspacePath(accessor, uri);
					return {
						leafNodeType: 'File',
						uri: uri,
						iconInMenu: File,
						fullName: relativePath,
						abbreviatedName: getAbbreviatedName(relativePath),
					};
				});
				return res;
			}

			else if (searchFor === 'folders') {
				// Extract unique directory paths from the results
				const directoryMap = new Map<string, URI>();

				for (const uri of searchResults) {
					if (!uri) {continue;}

					// Get the full path and extract directories
					const relativePath = getRelativeWorkspacePath(accessor, uri);
					const pathParts = relativePath.split('/');

					// Get workspace info
					const workspaceService = accessor.get('IWorkspaceContextService');
					const workspaceFolders = workspaceService.getWorkspace().folders;

					// Find the workspace folder containing this URI
					let workspaceFolderUri: URI | undefined;
					if (workspaceFolders.length) {
						// Sort workspace folders by path length (descending) to match the most specific folder first
						const sortedFolders = [...workspaceFolders].sort((a, b) =>
							b.uri.fsPath.length - a.uri.fsPath.length
						);

						// Find the containing workspace folder
						for (const folder of sortedFolders) {
							const folderPath = folder.uri.fsPath.endsWith('/') ? folder.uri.fsPath : folder.uri.fsPath + '/';
							const uriPath = uri.fsPath.endsWith('/') ? uri.fsPath : uri.fsPath + '/';

							if (uriPath.startsWith(folderPath)) {
								workspaceFolderUri = folder.uri;
								break;
							}
						}
					}

					if (workspaceFolderUri) {
						// Add each directory and its parents to the map
						let currentPath = '';
						for (let i = 0; i < pathParts.length - 1; i++) {
							currentPath = i === 0 ? `/${pathParts[i]}` : `${currentPath}/${pathParts[i]}`;


							// Create a proper directory URI
							const directoryUri = URI.joinPath(
								workspaceFolderUri,
								currentPath.startsWith('/') ? currentPath.substring(1) : currentPath
							);

							directoryMap.set(currentPath, directoryUri);
						}
					}
				}
				// Convert map to array
				return Array.from(directoryMap.entries()).map(([relativePath, uri]) => ({
					leafNodeType: 'Folder',
					uri: uri,
					iconInMenu: Folder, // Folder
					fullName: relativePath,
					abbreviatedName: getAbbreviatedName(relativePath),
				})) satisfies Option[];
			}
		} catch (error) {
			vibeLog.error('inputs', 'Error fetching directories:', error);
			return [];
		}
	};


	const allOptions: Option[] = [
		{
			fullName: 'selection',
			abbreviatedName: 'selection',
			iconInMenu: File,
			generateNextOptions: async (_t) => {
				try {
					const editorService = accessor.get('IEditorService');
					const languageService = accessor.get('ILanguageService');
					const active = editorService.activeTextEditorControl;
					const activeResource = editorService.activeEditor?.resource;
					const sel = active?.getSelection?.();
					if (activeResource && sel && !sel.isEmpty()) {
						const basename = getAbbreviatedName(getRelativeWorkspacePath(accessor, activeResource));
						const label = `${basename}:${sel.startLineNumber}-${sel.endLineNumber}`;
						return [{
							leafNodeType: 'File',
							uri: activeResource,
							range: sel,
							iconInMenu: File,
							fullName: label,
							abbreviatedName: 'selection',
						}];
					}
				} catch {}
				return [];
			},
		},
		{
			fullName: 'recent',
			abbreviatedName: 'recent',
			iconInMenu: File,
			generateNextOptions: async (t) => {
				try {
					const historyService = accessor.get('IHistoryService');
					const items = historyService.getHistory().filter((h: any) => h.resource).map((h: any) => h.resource);
					const options = items.map((uri: URI) => {
						const relativePath = getRelativeWorkspacePath(accessor, uri);
						return {
							leafNodeType: 'File',
							uri,
							iconInMenu: File,
							fullName: relativePath,
							abbreviatedName: getAbbreviatedName(relativePath),
						} satisfies Option;
					});

					// simple filter
					return options.filter(o => isSubsequence(o.fullName, t));
				} catch {
					return [];
				}
			},
		},
		{
			fullName: 'workspace',
			abbreviatedName: 'workspace',
			iconInMenu: Folder,
			generateNextOptions: async (_t) => {
				try {
					const workspaceService = accessor.get('IWorkspaceContextService');
					return workspaceService.getWorkspace().folders.map((f: any) => ({
						leafNodeType: 'Folder',
						uri: f.uri,
						iconInMenu: Folder,
						fullName: getRelativeWorkspacePath(accessor, f.uri) || '/',
						abbreviatedName: getFolderName(getRelativeWorkspacePath(accessor, f.uri) || '/')
					})) as Option[];
				} catch { return []; }
			},
		},
		{
			fullName: 'files',
			abbreviatedName: 'files',
			iconInMenu: File,
			generateNextOptions: async (t) => (await searchForFilesOrFolders(t, 'files')) || [],
		},
		{
			fullName: 'folders',
			abbreviatedName: 'folders',
			iconInMenu: Folder,
			generateNextOptions: async (t) => (await searchForFilesOrFolders(t, 'folders')) || [],
		},
	];

	// follow the path in the optionsTree (until the last path element)

	let nextOptionsAtPath = allOptions;
	let generateNextOptionsAtPath: GenerateNextOptions | undefined = undefined;

	for (const pn of path) {

		const selectedOption = nextOptionsAtPath.find(o => o.fullName.toLowerCase() === pn.toLowerCase());

		if (!selectedOption) {return [];}

		nextOptionsAtPath = selectedOption.nextOptions!; // assume nextOptions exists until we hit the very last option (the path will never contain the last possible option)
		generateNextOptionsAtPath = selectedOption.generateNextOptions;

	}


	if (generateNextOptionsAtPath) {

		nextOptionsAtPath = await generateNextOptionsAtPath(optionText);
	}
	else if (path.length === 0 && optionText.trim().length > 0) { // (special case): directly search for both files and folders if optionsPath is empty and there's a search term
		const filesResults = await searchForFilesOrFolders(optionText, 'files') || [];
		const foldersResults = await searchForFilesOrFolders(optionText, 'folders') || [];
		nextOptionsAtPath = [...foldersResults, ...filesResults,];
	}

	const optionsAtPath = nextOptionsAtPath
		.filter(o => isSubsequence(o.fullName, optionText))
		.sort((a, b) => { // this is a hack but good for now
			const scoreA = scoreSubsequence(a.fullName, optionText);
			const scoreB = scoreSubsequence(b.fullName, optionText);
			return scoreB - scoreA;
		})
		.slice(0, numOptionsToShow); // should go last because sorting/filtering should happen on all datapoints

	return optionsAtPath;

};



export type TextAreaFns = { setValue: (v: string) => void; enable: () => void; disable: () => void };
type InputBox2Props = {
	initValue?: string | null;
	placeholder: string;
	multiline: boolean;
	enableAtToMention?: boolean;
	fnsRef?: { current: null | TextAreaFns };
	className?: string;
	appearance?: 'default' | 'chatDark';
	style?: React.CSSProperties;
	onChangeText?: (value: string) => void;
	onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
	onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
	onChangeHeight?: (newHeight: number) => void;
	onPasteFiles?: (files: File[]) => void;
	/** Render an overlay layer behind the textarea that pills slash-commands like
	 *  `/skill:name` / `/skill-name`. Caret + selection stay on the (transparent-text)
	 *  textarea; pills are painted by the overlay div in sync with text + scroll. */
	highlightSlashCommands?: boolean;
};
export const VibeInputBox2 = forwardRef<HTMLTextAreaElement, InputBox2Props>(function X({ initValue, placeholder, multiline, enableAtToMention, fnsRef, className = '', appearance = 'default', style, onKeyDown, onFocus, onBlur, onChangeText, onPasteFiles, highlightSlashCommands }, ref) {


	// mirrors whatever is in ref
	const accessor = useAccessor();

	const chatThreadService = accessor.get('IChatThreadService');
	const languageService = accessor.get('ILanguageService');

	const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
	const overlayRef = useRef<HTMLDivElement | null>(null);
	// Live mirror of textarea.value for the overlay. Kept as state (not derived from
	// the textarea each render) so highlightSlashCommands re-renders the pills as the
	// user types — textarea.value alone wouldn't trigger React reconciliation.
	const [overlayText, setOverlayText] = useState('');
	const syncOverlayScroll = useCallback(() => {
		const ta = textAreaRef.current; const ov = overlayRef.current;
		if (!ta || !ov) {return;}
		ov.scrollTop = ta.scrollTop;
		ov.scrollLeft = ta.scrollLeft;
	}, []);
	const selectedOptionRef = useRef<HTMLDivElement>(null);
	const [isMenuOpen, _setIsMenuOpen] = useState(false); // the @ to mention menu
	const setIsMenuOpen: typeof _setIsMenuOpen = (value) => {
		if (!enableAtToMention) { return; } // never open menu if not enabled
		_setIsMenuOpen(value);
	};

	// logic for @ to mention vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv
	const [optionPath, setOptionPath] = useState<string[]>([]);
	const [optionIdx, setOptionIdx] = useState<number>(0);
	const [options, setOptions] = useState<Option[]>([]);
	const [optionText, setOptionText] = useState<string>('');
	const [didLoadInitialOptions, setDidLoadInitialOptions] = useState(false);

	const currentPathRef = useRef<string>(JSON.stringify([]));

	// dont show breadcrums if first page and user hasnt typed anything
	const isTypingEnabled = true;
	const isBreadcrumbsShowing = optionPath.length === 0 && !optionText ? false : true;

	const insertTextAtCursor = (text: string) => {
		const textarea = textAreaRef.current;
		if (!textarea) {return;}

		// Focus the textarea first
		textarea.focus();

		// delete the @ and set the cursor position
		// Get cursor position
		const startPos = textarea.selectionStart;
		const endPos = textarea.selectionEnd;

		// Get the text before the cursor, excluding the @ symbol that triggered the menu
		const textBeforeCursor = textarea.value.substring(0, startPos - 1);
		const textAfterCursor = textarea.value.substring(endPos);

		// Replace the text including the @ symbol with the selected option
		textarea.value = textBeforeCursor + textAfterCursor;

		// Set cursor position after the inserted text
		const newCursorPos = textBeforeCursor.length;
		textarea.setSelectionRange(newCursorPos, newCursorPos);

		// React's onChange relies on a SyntheticEvent system
		// The best way to ensure it runs is to call callbacks directly
		if (onChangeText) {
			onChangeText(textarea.value);
		}
		adjustHeight();
	};


	const onSelectOption = async () => {

		if (!options.length) { return; }

		const option = options[optionIdx];
		const newPath = [...optionPath, option.fullName];
		const isLastOption = !option.generateNextOptions && !option.nextOptions;
		setDidLoadInitialOptions(false);
		if (isLastOption) {
			setIsMenuOpen(false);
			insertTextAtCursor(option.abbreviatedName);

			let newSelection: StagingSelectionItem;
			if (option.leafNodeType === 'File') {newSelection = {
				type: 'File',
				uri: option.uri,
				language: languageService.guessLanguageIdByFilepathOrFirstLine(option.uri) || '',
				state: { wasAddedAsCurrentFile: false },
			};}
			else if (option.leafNodeType === 'Folder') {newSelection = {
				type: 'Folder',
				uri: option.uri,
				language: undefined,
				state: undefined,
			};}
			else {throw new Error(`Unexpected leafNodeType ${option.leafNodeType}`);}

			chatThreadService.addNewStagingSelection(newSelection);
		}
		else {


			currentPathRef.current = JSON.stringify(newPath);
			const newOpts = await getOptionsAtPath(accessor, newPath, '') || [];
			if (currentPathRef.current !== JSON.stringify(newPath)) { return; }
			setOptionPath(newPath);
			setOptionText('');
			setOptionIdx(0);
			setOptions(newOpts);
			setDidLoadInitialOptions(true);
		}
	};

	const onRemoveOption = async () => {
		const newPath = [...optionPath.slice(0, optionPath.length - 1)];
		currentPathRef.current = JSON.stringify(newPath);
		const newOpts = await getOptionsAtPath(accessor, newPath, '') || [];
		if (currentPathRef.current !== JSON.stringify(newPath)) { return; }
		setOptionPath(newPath);
		setOptionText('');
		setOptionIdx(0);
		setOptions(newOpts);
	};

	const onOpenOptionMenu = async () => {
		const newPath: [] = [];
		currentPathRef.current = JSON.stringify([]);
		const newOpts = await getOptionsAtPath(accessor, [], '') || [];
		if (currentPathRef.current !== JSON.stringify([])) { return; }
		setOptionPath(newPath);
		setOptionText('');
		setIsMenuOpen(true);
		setOptionIdx(0);
		setOptions(newOpts);
	};
	const onCloseOptionMenu = () => {
		setIsMenuOpen(false);
	};

	const onNavigateUp = (step = 1, periodic = true) => {
		if (options.length === 0) {return;}
		setOptionIdx((prevIdx) => {
			const newIdx = prevIdx - step;
			return periodic ? (newIdx + options.length) % options.length : Math.max(0, newIdx);
		});
	};
	const onNavigateDown = (step = 1, periodic = true) => {
		if (options.length === 0) {return;}
		setOptionIdx((prevIdx) => {
			const newIdx = prevIdx + step;
			return periodic ? newIdx % options.length : Math.min(options.length - 1, newIdx);
		});
	};

	const onNavigateToTop = () => {
		if (options.length === 0) {return;}
		setOptionIdx(0);
	};
	const onNavigateToBottom = () => {
		if (options.length === 0) {return;}
		setOptionIdx(options.length - 1);
	};

	const debounceTimerRef = useRef<number | null>(null);

	useEffect(() => {
		// Cleanup function to cancel any pending timeouts when unmounting
		return () => {
			if (debounceTimerRef.current !== null) {
				window.clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}
		};
	}, []);

	// debounced, but immediate if text is empty
	const onPathTextChange = useCallback((newStr: string) => {


		setOptionText(newStr);

		if (debounceTimerRef.current !== null) {
			window.clearTimeout(debounceTimerRef.current);
		}

		currentPathRef.current = JSON.stringify(optionPath);

		const fetchOptions = async () => {
			const newOpts = await getOptionsAtPath(accessor, optionPath, newStr) || [];
			if (currentPathRef.current !== JSON.stringify(optionPath)) { return; }
			setOptions(newOpts);
			setOptionIdx(0);
			debounceTimerRef.current = null;
		};

		// If text is empty, run immediately without debouncing
		if (newStr.trim() === '') {
			fetchOptions();
		} else {
			// Otherwise, set a new timeout to fetch options after a delay
			debounceTimerRef.current = window.setTimeout(fetchOptions, 300);
		}
	}, [optionPath, accessor]);


	const onMenuKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {

		const isCommandKeyPressed = e.altKey || e.ctrlKey || e.metaKey;

		if (e.key === 'ArrowUp') {
			if (isCommandKeyPressed) {
				onNavigateToTop();
			} else {
				if (e.altKey) {
					onNavigateUp(10, false);
				} else {
					onNavigateUp();
				}
			}
		} else if (e.key === 'ArrowDown') {
			if (isCommandKeyPressed) {
				onNavigateToBottom();
			} else {
				if (e.altKey) {
					onNavigateDown(10, false);
				} else {
					onNavigateDown();
				}
			}
		} else if (e.key === 'ArrowLeft') {
			onRemoveOption();
		} else if (e.key === 'ArrowRight') {
			onSelectOption();
		} else if (e.key === 'Enter') {
			onSelectOption();
		} else if (e.key === 'Escape') {
			onCloseOptionMenu();
		} else if (e.key === 'Backspace') {

			if (!optionText) { // No text remaining
				if (optionPath.length === 0) {
					onCloseOptionMenu();
					return; // don't prevent defaults (backspaces the @ symbol)
				} else {
					onRemoveOption();
				}
			}
			else if (isCommandKeyPressed) { // Ctrl+Backspace
				onPathTextChange('');
			}
			else { // Backspace
				onPathTextChange(optionText.slice(0, -1));
			}
		} else if (e.key.length === 1) {
			if (isCommandKeyPressed) { // Ctrl+letter
				// do nothing
			}
			else { // letter
				if (isTypingEnabled) {
					onPathTextChange(optionText + e.key);
				}
			}
		}

		e.preventDefault();
		e.stopPropagation();

	};

	// scroll the selected optionIdx into view on optionIdx and optionText changes
	useEffect(() => {
		if (isMenuOpen && selectedOptionRef.current) {
			selectedOptionRef.current.scrollIntoView({
				behavior: 'instant',
				block: 'nearest',
				inline: 'nearest',
			});
		}
	}, [optionIdx, isMenuOpen, optionText, selectedOptionRef]);

	const measureRef = useRef<HTMLDivElement>(null);
	const gapPx = 2;
	const offsetPx = 2;
	const {
		x,
		y,
		strategy,
		refs,
		middlewareData,
		update
	} = useFloating({
		open: isMenuOpen,
		onOpenChange: setIsMenuOpen,
		placement: 'bottom',

		middleware: [
			offset({ mainAxis: gapPx, crossAxis: offsetPx }),
			flip({
				boundary: document.body,
				padding: 8
			}),
			shift({
				boundary: document.body,
				padding: 8,
			}),
			size({
				apply({ elements, rects }) {
					// Just set width on the floating element and let content handle scrolling
					Object.assign(elements.floating.style, {
						width: `${Math.max(
							rects.reference.width,
							measureRef.current?.offsetWidth ?? 0
						)}px`
					});
				},
				padding: 8,
				// Use viewport as boundary instead of any parent element
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});
	useEffect(() => {
		if (!isMenuOpen) {return;}

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current;

			// Check if reference is an HTML element before using contains
			const isReferenceHTMLElement = reference && 'contains' in reference;

			if (
				floating &&
				(!isReferenceHTMLElement || !reference.contains(target)) &&
				!floating.contains(target)
			) {
				setIsMenuOpen(false);
			}
		};

		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isMenuOpen, refs.floating, refs.reference]);
	// logic for @ to mention ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^


	const [isEnabled, setEnabled] = useState(true);

	const adjustHeight = useCallback(() => {
		const r = textAreaRef.current;
		if (!r) {return;}

		r.style.height = 'auto'; // set to auto to reset height, then set to new height

		if (r.scrollHeight === 0) {return requestAnimationFrame(adjustHeight);}
		const h = r.scrollHeight;
		const newHeight = Math.min(h + 1, 500); // plus one to avoid scrollbar appearing when it shouldn't
		r.style.height = `${newHeight}px`;

		// The highlight overlay paints the VISIBLE text while the (transparent) textarea owns the caret +
		// selection — so both MUST wrap line-for-line. They only do if their content boxes are identical.
		// Mirror the textarea's COMPUTED padding + border widths onto the overlay, and reserve the vertical
		// scrollbar's width as extra right padding when one is showing (overflow-y:auto). Any leftover
		// sub-pixel / scrollbar difference makes a word wrap in one layer but not the other — stranding the
		// caret at the end of the previous line and skewing the selection highlight (the reported bug).
		const ov = overlayRef.current;
		if (ov) {
			const cs = getComputedStyle(r);
			// Solid transparent border whose per-side WIDTH equals the textarea's computed border (0 when
			// the textarea is borderless — dark chat). border-width alone is ignored without a style.
			ov.style.borderStyle = 'solid';
			ov.style.borderColor = 'transparent';
			ov.style.borderTopWidth = cs.borderTopWidth;
			ov.style.borderBottomWidth = cs.borderBottomWidth;
			ov.style.borderLeftWidth = cs.borderLeftWidth;
			ov.style.borderRightWidth = cs.borderRightWidth;
			ov.style.paddingTop = cs.paddingTop;
			ov.style.paddingBottom = cs.paddingBottom;
			ov.style.paddingLeft = cs.paddingLeft;
			// Reserve the vertical scrollbar's width (when present) as extra right padding so the overlay's
			// text column matches the textarea's (its clientWidth already excludes the scrollbar).
			const scrollbar = r.offsetWidth - r.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
			ov.style.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + Math.max(0, scrollbar)}px`;
		}
	}, []);



	const fns: TextAreaFns = useMemo(() => ({
		setValue: (val) => {
			const r = textAreaRef.current;
			if (!r) {return;}
			r.value = val;
			setOverlayText(val);
			onChangeText?.(r.value);
			adjustHeight();
		},
		enable: () => { setEnabled(true); },
		disable: () => { setEnabled(false); },
	}), [onChangeText, adjustHeight]);



	useEffect(() => {
		if (initValue)
			{fns.setValue(initValue);}
	}, [initValue]);




	const isChatDark = appearance === 'chatDark';
	const appearanceClasses = isChatDark
		? 'text-white placeholder:text-white/40'
		: 'text-vibe-fg-1 placeholder:text-vibe-fg-3';

	const baseStyle: React.CSSProperties = isChatDark
		? {
			background: 'transparent',
			color: '#fff',
			border: 'none',
			boxShadow: 'none',
		}
		: {
			background: asCssVariable(inputBackground),
			color: asCssVariable(inputForeground),
		};

	// Caret-color must stay visible even when we make textarea text transparent for the
	// overlay-trick. Mirrors the textarea's normal foreground per appearance variant.
	const overlayCaretColor = isChatDark ? '#fff' : asCssVariable(inputForeground);
	// Why textShadow: 'none' — the neon theme applies `text-shadow: var(--vibe-neon-text-glow)`
	// to .vibe-chat-neon-scope textarea (vibeide.css). With `color: transparent` the glyph
	// disappears but text-shadow keeps rendering at the glyph positions — visible as a
	// ghosted blur of the input text. Killing the shadow on the textarea hides it; the
	// overlay (which paints the visible text) keeps its own shadow via .vibe-skill-pill.
	const textareaOverlayStyle: React.CSSProperties = highlightSlashCommands
		? { color: 'transparent', caretColor: overlayCaretColor, textShadow: 'none' }
		: {};

	const textareaEl = <textarea
			autoFocus={false}
			ref={useCallback((r: HTMLTextAreaElement | null) => {
				if (fnsRef)
					{fnsRef.current = fns;}

				refs.setReference(r);

				textAreaRef.current = r;
				if (typeof ref === 'function') {ref(r);}
				else if (ref) {ref.current = r;}
				adjustHeight();
			}, [fnsRef, fns, setEnabled, adjustHeight, ref, refs])}

			onFocus={onFocus}
			onBlur={onBlur}
			onScroll={highlightSlashCommands ? syncOverlayScroll : undefined}

			onPaste={useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
				if (!onPasteFiles) {return;}
				const items = Array.from(e.clipboardData?.items || []);
				const files: File[] = [];
				for (const item of items) {
					if (item.kind === 'file' && (item.type.startsWith('image/') || item.type === 'application/pdf')) {
						const f = item.getAsFile();
						if (f) {files.push(f);}
					}
				}
				if (files.length > 0) {
					e.preventDefault();
					onPasteFiles(files);
				}
			}, [onPasteFiles])}

			disabled={!isEnabled}

			className={`w-full resize-none max-h-[500px] overflow-y-auto ${appearanceClasses} ${className} ${highlightSlashCommands ? 'vibe-textarea-with-overlay' : ''}`}
			style={{ ...baseStyle, ...style, ...textareaOverlayStyle }}

			onInput={useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
				const latestChange = (event.nativeEvent as InputEvent).data;

				if (latestChange === '@') {
					onOpenOptionMenu();
				}

			}, [onOpenOptionMenu, accessor])}

			onChange={useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const r = textAreaRef.current;
				if (!r) {return;}
				setOverlayText(r.value);
				onChangeText?.(r.value);
				adjustHeight();
			}, [onChangeText, adjustHeight])}

			onKeyDown={useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {

				if (isMenuOpen) {
					onMenuKeyDown(e);
					return;
				}

				if (e.key === 'Backspace') { // TODO allow user to undo this.
					if (!e.currentTarget.value || (e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0)) { // if there is no text or cursor is at position 0, remove a selection
						if (e.metaKey || e.ctrlKey) { // Ctrl+Backspace = remove all
							chatThreadService.popStagingSelections(Number.MAX_SAFE_INTEGER);
						} else { // Backspace = pop 1 selection
							chatThreadService.popStagingSelections(1);
						}
						return;
					}
				}
				if (e.key === 'Enter') {
					// Shift + Enter when multiline = newline
					const shouldAddNewline = e.shiftKey && multiline;
					if (!shouldAddNewline) {e.preventDefault();} // prevent newline from being created
				}
				onKeyDown?.(e);
			}, [onKeyDown, onMenuKeyDown, multiline])}

			rows={1}
			placeholder={placeholder}
		/>;

	// Overlay layer rendering. Inherits font + padding + line-height by being placed
	// inside the same wrapper that the textarea sits in and stretching to `inset: 0`.
	// `pointer-events: none` so clicks pass straight to the textarea. The pill spans
	// use `display: inline` (not inline-block) — inline-block would shift line wrapping
	// vs. the underlying textarea where each char takes its raw advance width.
	// Inline pill style (mirrors `.vibe-skill-pill` in vibeide.css). Inline kept so
	// the highlight survives builds where the CSS bundle hasn't been re-compiled yet.
	// IMPORTANT: nothing here can change inline char-advance widths, otherwise the
	// overlay drifts vs. the textarea and the caret mis-aligns by ~one char per pill.
	// That rules out: padding, border, letter-spacing, font-size, font-variant-ligatures.
	// Use `box-shadow: inset` for the outline (zero geometry impact) and skip border.
	const skillPillInlineStyle: React.CSSProperties = {
		background: 'var(--vibe-skill-pill-bg, rgba(3, 237, 249, 0.16))',
		color: 'var(--vibe-skill-pill-fg, #03edf9)',
		borderRadius: 3,
		boxShadow: 'inset 0 0 0 1px var(--vibe-skill-pill-border, rgba(3, 237, 249, 0.40))',
		textShadow: 'var(--vibe-skill-pill-glow, none)',
	};
	const renderOverlayChildren = (text: string): React.ReactNode => {
		if (!text) {return null;}
		// Only `/skill:NAME` — backend expands no other slash form, so highlighting
		// generic `/foo` would lie about behavior (and pill paths like `/var/lib`).
		const re = /(^|\s)(\/skill:[\w.-]+)/g;
		const out: React.ReactNode[] = [];
		let lastIdx = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const cmdStart = m.index + m[1].length;
			if (cmdStart > lastIdx) {out.push(text.slice(lastIdx, cmdStart));}
			out.push(<span key={cmdStart} className="vibe-skill-pill" style={skillPillInlineStyle}>{m[2]}</span>);
			lastIdx = cmdStart + m[2].length;
		}
		if (lastIdx === 0) {return text;}
		if (lastIdx < text.length) {out.push(text.slice(lastIdx));}
		// Trailing newline guard: a final `\n` in textarea creates an extra blank line
		// that the overlay <div> doesn't reserve (textareas implicitly add it). Append
		// a zero-width char so the overlay's last line matches the textarea's height.
		if (text.endsWith('\n')) {out.push('​');}
		return <>{out}</>;
	};

	// Inline overlay styles are duplicated here (also live in vibeide.css as
	// `.vibe-textarea-overlay`) so that the trick works even if the CSS hasn't
	// been re-bundled yet. Inline wins specificity and survives missing stylesheets.
	// Overlay carries the VISIBLE text (textarea text is transparent — it only owns
	// the caret + selection). Color matches what the textarea would have rendered so
	// the user sees the same characters in the same color, just routed through a div
	// that can also paint pill spans. Inheritable text-shadow (neon glow) is left
	// alone — overlay text legitimately wants it, same as the textarea did before.
	const overlayInlineStyle: React.CSSProperties = {
		position: 'absolute',
		inset: 0,
		pointerEvents: 'none',
		userSelect: 'none',
		overflow: 'hidden',
		whiteSpace: 'pre-wrap',
		wordWrap: 'break-word',
		overflowWrap: 'break-word',
		color: overlayCaretColor,
		font: 'inherit',
		lineHeight: 'inherit',
		letterSpacing: 'inherit',
		textAlign: 'inherit' as React.CSSProperties['textAlign'],
		// border + padding are mirrored from the textarea's COMPUTED box in adjustHeight (so the two
		// layers wrap line-for-line); not set here, to avoid React re-applying a fixed value over the sync.
		boxSizing: 'border-box',
		margin: 0,
	};

	return <>
		{highlightSlashCommands ? (
			<div
				className="vibe-textarea-overlay-wrap"
				style={{ position: 'relative', width: '100%', display: 'block' }}
			>
				<div
					ref={overlayRef}
					className={`vibe-textarea-overlay ${className}`}
					aria-hidden="true"
					style={overlayInlineStyle}
				>
					{renderOverlayChildren(overlayText)}
				</div>
				{textareaEl}
			</div>
		) : textareaEl}
		{/* <div>{`idx ${optionIdx}`}</div> */}
		{isMenuOpen && (
			<div
				ref={refs.setFloating}
				className="z-[100] border-vibe-border-3 bg-vibe-bg-2-alt border rounded shadow-lg flex flex-col overflow-hidden"
				style={{
					position: strategy,
					top: y ?? 0,
					left: x ?? 0,
					width: refs.reference.current instanceof HTMLElement ? refs.reference.current.offsetWidth : 0
				}}
				onWheel={(e) => e.stopPropagation()}
			>
				{/* Breadcrumbs Header */}
				{isBreadcrumbsShowing && <div className="px-2 py-1 text-vibe-fg-1 bg-vibe-bg-2-alt border-b border-vibe-border-3 sticky top-0 bg-vibe-bg-1 z-10 select-none pointer-events-none">
					{optionText ?
						<div className="flex items-center">
							{/* {optionPath.map((path, index) => (
								<React.Fragment key={index}>
									<span>{path}</span>
									<ChevronRight size={12} className="mx-1" />
								</React.Fragment>
							))} */}
							<span>{optionText}</span>
						</div>
						: <div className='opacity-50'>{inputsS.enterTextToFilter}</div>
					}
				</div>}


				{/* Options list */}
				<div className='max-h-[400px] w-full max-w-full overflow-y-auto overflow-x-auto'>
					<div className="w-max min-w-full flex flex-col gap-0 text-nowrap flex-nowrap">
						{options.length === 0 ?
							<div className="text-vibe-fg-3 px-3 py-0.5">{inputsS.noResultsFound}</div>
							: options.map((o, oIdx) => {

								return (
									// Option
									<div
										ref={oIdx === optionIdx ? selectedOptionRef : null}
										key={o.fullName}
										className={`
											flex items-center gap-2
											px-3 py-1 cursor-pointer
											${oIdx === optionIdx ? 'bg-blue-500 text-white/80' : 'bg-vibe-bg-2-alt text-vibe-fg-1'}
										`}
										onClick={() => { onSelectOption(); }}
										onMouseMove={() => { setOptionIdx(oIdx); }}
									>
										{<o.iconInMenu size={12} />}

										<span>{o.abbreviatedName}</span>

										{o.fullName && o.fullName !== o.abbreviatedName && <span className="opacity-60 text-sm">{o.fullName}</span>}

										{o.nextOptions || o.generateNextOptions ? (
											<ChevronRight size={12} />
										) : null}

									</div>
								);
							})
						}
					</div>
				</div>
			</div>
		)}
	</>;

});


export const VibeSimpleInputBox = ({ value, onChangeValue, placeholder, className, disabled, passwordBlur, compact, ...inputProps }: {
	value: string;
	onChangeValue: (value: string) => void;
	placeholder: string;
	className?: string;
	disabled?: boolean;
	compact?: boolean;
	passwordBlur?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) => {
	// Create a ref for the input element to maintain the same DOM node between renders
	const inputRef = useRef<HTMLInputElement>(null);

	// Track if we need to restore selection
	const selectionRef = useRef<{ start: number | null; end: number | null }>({
		start: null,
		end: null
	});

	// Handle value changes without recreating the input
	useEffect(() => {
		const input = inputRef.current;
		if (input && input.value !== value) {
			// Store current selection positions
			selectionRef.current.start = input.selectionStart;
			selectionRef.current.end = input.selectionEnd;

			// Update the value
			input.value = value;

			// Restore selection if we had it before
			if (selectionRef.current.start !== null && selectionRef.current.end !== null) {
				input.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
			}
		}
	}, [value]);

	const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		onChangeValue(e.target.value);
	}, [onChangeValue]);

	return (
		<input
			ref={inputRef}
			defaultValue={value} // Use defaultValue instead of value to avoid recreation
			onChange={handleChange}
			placeholder={placeholder}
			disabled={disabled}
			className={`w-full resize-none text-vibe-fg-1 placeholder:text-vibe-fg-3
				${compact ? 'py-1 px-2' : 'py-2 px-4 '}
				@@vibe-chat-like-control
				${disabled ? 'opacity-50 cursor-not-allowed' : ''}
				${className}`}
			style={{
				...passwordBlur && { WebkitTextSecurity: 'disc' },
				background: asCssVariable(inputBackground),
				color: asCssVariable(inputForeground)
			}}
			{...inputProps}
			type={undefined} // VS Code is doing some annoyingness that breaks paste if this is defined
		/>
	);
};


export const VibeInputBox = ({ onChangeText, onCreateInstance, inputBoxRef, placeholder, isPasswordField, multiline }: {
	onChangeText: (value: string) => void;
	styles?: Partial<IInputBoxStyles>;
	onCreateInstance?: (instance: InputBox) => void | IDisposable[];
	inputBoxRef?: { current: InputBox | null };
	placeholder: string;
	isPasswordField?: boolean;
	multiline: boolean;
}) => {

	const accessor = useAccessor();

	const contextViewProvider = accessor.get('IContextViewService');
	return <WidgetComponent
		className='
			bg-vibe-bg-1
			@@vibe-force-child-placeholder-vibe-fg-1
		'
		ctor={InputBox}
		propsFn={useCallback((container) => [
			container,
			contextViewProvider,
			{
				inputBoxStyles: {
					...defaultInputBoxStyles,
					inputForeground: "var(--vscode-foreground)",
					// inputBackground: 'transparent',
					// inputBorder: 'none',
				},
				placeholder,
				tooltip: '',
				type: isPasswordField ? 'password' : undefined,
				flexibleHeight: multiline,
				flexibleMaxHeight: 500,
				flexibleWidth: false,
			}
		] as const, [contextViewProvider, placeholder, multiline])}
		dispose={useCallback((instance: InputBox) => {
			instance.dispose();
			instance.element.remove();
		}, [])}
		onCreateInstance={useCallback((instance: InputBox) => {
			const disposables: IDisposable[] = [];
			disposables.push(
				instance.onDidChange((newText) => onChangeText(newText))
			);
			if (onCreateInstance) {
				const ds = onCreateInstance(instance) ?? [];
				disposables.push(...ds);
			}
			if (inputBoxRef)
				{inputBoxRef.current = instance;}

			return disposables;
		}, [onChangeText, onCreateInstance, inputBoxRef])}
	/>;
};





export const VibeSlider = ({
	value,
	onChange,
	size = 'md',
	disabled = false,
	min = 0,
	max = 7,
	step = 1,
	className = '',
	width = 200,
}: {
	value: number;
	onChange: (value: number) => void;
	disabled?: boolean;
	size?: 'xxs' | 'xs' | 'sm' | 'sm+' | 'md';
	min?: number;
	max?: number;
	step?: number;
	className?: string;
	width?: number;
}) => {
	// Calculate percentage for position
	const percentage = ((value - min) / (max - min)) * 100;

	// Handle track click
	const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (disabled) {return;}

		const rect = e.currentTarget.getBoundingClientRect();
		const clickPosition = e.clientX - rect.left;
		const trackWidth = rect.width;

		// Calculate new value
		const newPercentage = Math.max(0, Math.min(1, clickPosition / trackWidth));
		const rawValue = min + newPercentage * (max - min);

		// Special handling to ensure max value is always reachable
		if (rawValue >= max - step / 2) {
			onChange(max);
			return;
		}

		// Normal step calculation
		const steppedValue = Math.round((rawValue - min) / step) * step + min;
		const clampedValue = Math.max(min, Math.min(max, steppedValue));

		onChange(clampedValue);
	};

	// Helper function to handle thumb dragging that respects steps and max
	const handleThumbDrag = (moveEvent: MouseEvent, track: Element) => {
		if (!track) {return;}

		const rect = (track as HTMLElement).getBoundingClientRect();
		const movePosition = moveEvent.clientX - rect.left;
		const trackWidth = rect.width;

		// Calculate new value
		const newPercentage = Math.max(0, Math.min(1, movePosition / trackWidth));
		const rawValue = min + newPercentage * (max - min);

		// Special handling to ensure max value is always reachable
		if (rawValue >= max - step / 2) {
			onChange(max);
			return;
		}

		// Normal step calculation
		const steppedValue = Math.round((rawValue - min) / step) * step + min;
		const clampedValue = Math.max(min, Math.min(max, steppedValue));

		onChange(clampedValue);
	};

	return (
		<div className={`inline-flex items-center flex-shrink-0 ${className}`}>
			{/* Outer container with padding to account for thumb overhang */}
			<div className={`relative flex-shrink-0 ${disabled ? 'opacity-25' : ''}`}
				style={{
					width,
					// Add horizontal padding equal to half the thumb width
					// paddingLeft: thumbSizePx / 2,
					// paddingRight: thumbSizePx / 2
				}}>
				{/* Track container with adjusted width */}
				<div className="relative w-full">
					{/* Invisible wider clickable area that sits above the track */}
					<div
						className="absolute w-full cursor-pointer"
						style={{
							height: '16px',
							top: '50%',
							transform: 'translateY(-50%)',
							zIndex: 1
						}}
						onClick={handleTrackClick}
					/>

					{/* Track */}
					<div
						className={`relative ${size === 'xxs' ? 'h-0.5' :
							size === 'xs' ? 'h-1' :
								size === 'sm' ? 'h-1.5' :
									size === 'sm+' ? 'h-2' : 'h-2.5'
							} bg-vibe-bg-2 rounded-full cursor-pointer`}
						onClick={handleTrackClick}
					>
						{/* Filled part of track */}
						<div
							className={`absolute left-0 ${size === 'xxs' ? 'h-0.5' :
								size === 'xs' ? 'h-1' :
									size === 'sm' ? 'h-1.5' :
										size === 'sm+' ? 'h-2' : 'h-2.5'
								} bg-vibe-fg-1 rounded-full`}
							style={{ width: `${percentage}%` }}
						/>
					</div>

					{/* Thumb */}
					<div
						className={`absolute top-1/2 transform -translate-x-1/2 -translate-y-1/2
							${size === 'xxs' ? 'h-2 w-2' :
								size === 'xs' ? 'h-2.5 w-2.5' :
									size === 'sm' ? 'h-3 w-3' :
										size === 'sm+' ? 'h-3.5 w-3.5' : 'h-4 w-4'
							}
							bg-vibe-fg-1 rounded-full shadow-md ${disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}
							border border-vibe-fg-1`}
						style={{ left: `${percentage}%`, zIndex: 2 }}  // Ensure thumb is above the invisible clickable area
						onMouseDown={(e) => {
							if (disabled) {return;}

							const track = e.currentTarget.previousElementSibling;

							const handleMouseMove = (moveEvent: MouseEvent) => {
								handleThumbDrag(moveEvent, track as Element);
							};

							const handleMouseUp = () => {
								document.removeEventListener('mousemove', handleMouseMove);
								document.removeEventListener('mouseup', handleMouseUp);
								document.body.style.cursor = '';
								document.body.style.userSelect = '';
							};

							document.body.style.userSelect = 'none';
							document.body.style.cursor = 'grabbing';
							document.addEventListener('mousemove', handleMouseMove);
							document.addEventListener('mouseup', handleMouseUp);

							e.preventDefault();
						}}
					/>
				</div>
			</div>
		</div>
	);
};



export const VibeSwitch = ({
	value,
	onChange,
	size = 'md',
	disabled = false,
	...props
}: {
	value: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
	size?: 'xxs' | 'xs' | 'sm' | 'sm+' | 'md';
}) => {
	return (
		<label className="inline-flex items-center" {...props}>
			<div
				onClick={() => !disabled && onChange(!value)}
				className={`
			cursor-pointer
			relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out
			${value ? 'bg-zinc-900 dark:bg-white' : 'bg-white dark:bg-zinc-600'}
			${disabled ? 'opacity-25' : ''}
			${size === 'xxs' ? 'h-3 w-5' : ''}
			${size === 'xs' ? 'h-4 w-7' : ''}
			${size === 'sm' ? 'h-5 w-9' : ''}
			${size === 'sm+' ? 'h-5 w-10' : ''}
			${size === 'md' ? 'h-6 w-11' : ''}
		`}
			>
				<span
					className={`
						inline-block transform rounded-full bg-white dark:bg-zinc-900 shadow transition-transform duration-200 ease-in-out
						${size === 'xxs' ? 'h-2 w-2' : ''}
						${size === 'xs' ? 'h-2.5 w-2.5' : ''}
						${size === 'sm' ? 'h-3 w-3' : ''}
						${size === 'sm+' ? 'h-3.5 w-3.5' : ''}
						${size === 'md' ? 'h-4 w-4' : ''}
						${size === 'xxs' ? (value ? 'translate-x-2.5' : 'translate-x-0.5') : ''}
						${size === 'xs' ? (value ? 'translate-x-3.5' : 'translate-x-0.5') : ''}
						${size === 'sm' ? (value ? 'translate-x-5' : 'translate-x-1') : ''}
						${size === 'sm+' ? (value ? 'translate-x-6' : 'translate-x-1') : ''}
						${size === 'md' ? (value ? 'translate-x-6' : 'translate-x-1') : ''}
					`}
				/>
			</div>
		</label>
	);
};





export const VibeCheckBox = ({ label, value, onClick, className }: { label: string; value: boolean; onClick: (checked: boolean) => void; className?: string }) => {
	const divRef = useRef<HTMLDivElement | null>(null);
	const instanceRef = useRef<Checkbox | null>(null);

	useEffect(() => {
		if (!instanceRef.current) {return;}
		instanceRef.current.checked = value;
	}, [value]);


	return <WidgetComponent
		className={className ?? ''}
		ctor={Checkbox}
		propsFn={useCallback((container: HTMLDivElement) => {
			divRef.current = container;
			return [label, value, defaultCheckboxStyles] as const;
		}, [label, value])}
		onCreateInstance={useCallback((instance: Checkbox) => {
			instanceRef.current = instance;
			divRef.current?.append(instance.domNode);
			const d = instance.onChange(() => onClick(instance.checked));
			return [d];
		}, [onClick])}
		dispose={useCallback((instance: Checkbox) => {
			instance.dispose();
			instance.domNode.remove();
		}, [])}

	/>;

};



export const VibeCustomDropdownBox = <T extends NonNullable<any>>({
	options,
	selectedOption,
	onChangeOption,
	getOptionDropdownName,
	getOptionDropdownDetail,
	getOptionDisplayName,
	getOptionsEqual,
	className,
	arrowTouchesText = true,
	matchInputWidth = false,
	gapPx = 0,
	offsetPx = -6,
	detailPresentation = 'inline',
	dropdownQuickSearch = false,
	dropdownSearchPlaceholder = '',
	dropdownSearchEmptyMessage = '',
	getOptionSearchText,
	getOptionBadge,
}: {
	options: T[];
	selectedOption: T | undefined;
	onChangeOption: (newValue: T) => void;
	getOptionDropdownName: (option: T) => string;
	getOptionDropdownDetail?: (option: T) => string;
	getOptionDisplayName: (option: T) => string;
	getOptionsEqual: (a: T, b: T) => boolean;
	className?: string;
	arrowTouchesText?: boolean;
	matchInputWidth?: boolean;
	gapPx?: number;
	offsetPx?: number;
	/** 'tooltip' — secondary text only on hover over a ? hint (reduces row clutter). */
	detailPresentation?: 'inline' | 'tooltip';
	/** Filter row at top of the menu; matches name, detail, and optional `getOptionSearchText`. */
	dropdownQuickSearch?: boolean;
	dropdownSearchPlaceholder?: string;
	/** Shown when the filter yields zero options (non-empty query). */
	dropdownSearchEmptyMessage?: string;
	getOptionSearchText?: (option: T) => string;
	/** Optional trailing badge (a `<glyph>`) rendered after the option name. The glyph carries a
	 *  native tooltip (`title`) — used to flag provenance without cluttering the row text. */
	getOptionBadge?: (option: T) => { glyph: string; tooltip: string } | undefined;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const [filterQuery, setFilterQuery] = useState('');
	const measureRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

	const defaultSearchText = useCallback((option: T) => {
		const name = getOptionDropdownName(option);
		const det = getOptionDropdownDetail?.(option) ?? '';
		return `${name} ${det}`;
	}, [getOptionDropdownName, getOptionDropdownDetail]);

	const visibleOptions = useMemo(() => {
		if (!dropdownQuickSearch) {
			return options;
		}
		const raw = filterQuery.trim().toLowerCase();
		if (!raw) {
			return options;
		}
		const textFor = getOptionSearchText ?? defaultSearchText;
		return options.filter((o) => textFor(o).toLowerCase().includes(raw));
	}, [options, filterQuery, dropdownQuickSearch, getOptionSearchText, defaultSearchText]);

	useEffect(() => {
		if (!isOpen) {
			setFilterQuery('');
		}
	}, [isOpen]);

	useLayoutEffect(() => {
		if (isOpen && dropdownQuickSearch) {
			searchInputRef.current?.focus({ preventScroll: true });
		}
	}, [isOpen, dropdownQuickSearch]);

	// Replace manual positioning with floating-ui
	const {
		x,
		y,
		strategy,
		refs,
		middlewareData,
		update
	} = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'bottom-start',

		middleware: [
			offset({ mainAxis: gapPx, crossAxis: offsetPx }),
			flip({
				boundary: document.body,
				padding: 8
			}),
			shift({
				boundary: document.body,
				padding: 8,
			}),
			size({
				apply({ availableHeight, elements, rects }) {
					const maxHeight = Math.min(availableHeight);

					Object.assign(elements.floating.style, {
						maxHeight: `${maxHeight}px`,
						overflow: 'hidden',
						// Ensure the width isn't constrained by the parent
						width: `${Math.max(
							rects.reference.width,
							measureRef.current?.offsetWidth ?? 0
						)}px`
					});
				},
				padding: 8,
				// Use viewport as boundary instead of any parent element
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});

	// After open, measureRef/layout must run before Floating sizing; otherwise width falls back to the narrow trigger and `truncate` clips labels to one glyph.
	useLayoutEffect(() => {
		if (!isOpen) {
			return;
		}
		void update();
	}, [isOpen, update, options, selectedOption, detailPresentation]);

	// if the selected option is null, set the selection to the 0th option — ONCE.
	// Guarded by a ref so it never retries: if the parent's onChangeOption doesn't make
	// `selectedOption` defined on the next render (e.g. the chosen value isn't found in the
	// parent's option list), retrying every render is an infinite setState→re-render loop.
	// With a large sibling tree (e.g. a long un-virtualized history list) that loop freezes
	// the renderer ("Окно не отвечает"). One-shot auto-select is the correct initialization.
	const didAutoSelectRef = useRef(false);
	useEffect(() => {
		if (didAutoSelectRef.current) {return;}
		if (options.length === 0) {return;}
		if (selectedOption !== undefined) {return;}
		didAutoSelectRef.current = true;
		onChangeOption(options[0]);
	}, [selectedOption, onChangeOption, options]);

	// Handle clicks outside
	useEffect(() => {
		if (!isOpen) {return;}

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current;

			// Check if reference is an HTML element before using contains
			const isReferenceHTMLElement = reference && 'contains' in reference;

			if (
				floating &&
				(!isReferenceHTMLElement || !reference.contains(target)) &&
				!floating.contains(target)
			) {
				setIsOpen(false);
			}
		};

		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isOpen, refs.floating, refs.reference]);

	if (selectedOption === undefined)
		{return null;}

	return (
		<div className={`inline-block relative ${className}`}>
			{/* Hidden measurement div */}
			<div
				ref={measureRef}
				className="opacity-0 pointer-events-none absolute -left-[999999px] -top-[999999px] flex flex-col"
				aria-hidden="true"
			>
				{options.map((option) => {
					const optionName = getOptionDropdownName(option);
					const optionDetail = getOptionDropdownDetail?.(option) || '';
					const useTooltip = detailPresentation === 'tooltip' && !!optionDetail;

					return (
						<div key={optionName + optionDetail + detailPresentation} className="flex items-center whitespace-nowrap">
							<div className="w-4 flex-shrink-0" />
							<span className="flex min-w-0 items-center gap-2">
								<span className="whitespace-nowrap">{optionName}</span>
								{useTooltip ? (
									<span className="w-4 flex-shrink-0 text-center text-[10px]">?</span>
								) : (
									<>
										<span>{optionDetail}</span>
										<span>______</span>
									</>
								)}
							</span>
						</div>
					);
				})}
			</div>

			{/* Select Button */}
			<button
				type='button'
				ref={refs.setReference}
				className="flex items-center h-4 bg-transparent whitespace-nowrap hover:brightness-90 w-full"
				onClick={() => setIsOpen(!isOpen)}
			>
				<span className={`truncate ${arrowTouchesText ? 'mr-1' : ''}`}>
					{getOptionDisplayName(selectedOption)}
				</span>
				<svg
					className={`size-3 flex-shrink-0 ${arrowTouchesText ? '' : 'ml-auto'}`}
					viewBox="0 0 12 12"
					fill="none"
				>
					<path
						d="M2.5 4.5L6 8L9.5 4.5"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>

			{/* Dropdown Menu */}
			{isOpen && (
				<div
					ref={refs.setFloating}
					className="z-[10000] min-w-max max-w-[min(90vw,24rem)] bg-vibe-bg-1 @@vibe-popup-panel rounded-xl overflow-hidden shadow-lg flex flex-col"
					style={{
						position: strategy,
						top: y ?? 0,
						left: x ?? 0,
						width: (matchInputWidth
							? (refs.reference.current instanceof HTMLElement ? refs.reference.current.offsetWidth : 0)
							: Math.max(
								(refs.reference.current instanceof HTMLElement ? refs.reference.current.offsetWidth : 0),
								(measureRef.current instanceof HTMLElement ? measureRef.current.offsetWidth : 0)
							))
					}}
					onWheel={(e) => e.stopPropagation()}
				>
					{dropdownQuickSearch ? (
						<div
							className="shrink-0 border-b border-vibe-border-3 px-2 py-1.5"
							onMouseDown={(e) => e.stopPropagation()}
						>
							<input
								ref={searchInputRef}
								type="search"
								value={filterQuery}
								onChange={(e) => setFilterQuery(e.target.value)}
								placeholder={dropdownSearchPlaceholder}
								autoComplete="off"
								autoCorrect="off"
								spellCheck={false}
								className="w-full rounded-lg bg-vibe-bg-2 border border-vibe-border-2 px-2 py-1 text-xs text-vibe-fg-2 placeholder:text-vibe-fg-4 outline-none focus:border-vibe-border-3"
								onKeyDown={(e) => e.stopPropagation()}
							/>
						</div>
					) : null}
					<div className="min-h-0 flex-1 overflow-y-auto max-h-80">

						{visibleOptions.map((option) => {
							const thisOptionIsSelected = getOptionsEqual(option, selectedOption);
							const optionName = getOptionDropdownName(option);
							const optionDetail = getOptionDropdownDetail?.(option) || '';
							const optionBadge = getOptionBadge?.(option);
							const showHint = detailPresentation === 'tooltip' && !!optionDetail;
							const rowKey = `${optionName}\0${optionDetail}`;

							return (
								<div
									key={rowKey}
									className={`flex items-center min-w-0 px-2 py-1 pr-4 cursor-pointer whitespace-nowrap
									transition-all duration-100
									@@vibe-dropdown-row
									${thisOptionIsSelected ? '@@vibe-dropdown-row--selected' : ''}
								`}
									onClick={() => {
										onChangeOption(option);
										setIsOpen(false);
										setFilterQuery('');
									}}
								>
									<div className="w-4 flex justify-center flex-shrink-0">
										{thisOptionIsSelected && (
											<svg className="size-3" viewBox="0 0 12 12" fill="none">
												<path
													d="M10 3L4.5 8.5L2 6"
													stroke="currentColor"
													strokeWidth="1.5"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										)}
									</div>
									<span className="flex min-w-0 flex-1 items-center gap-2">
										<span className="flex min-w-0 flex-1 items-center gap-1.5">
											<span className="min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{optionName}</span>
											{optionBadge ? (
												<span
													className="@@vibe-dropdown-row__badge flex-shrink-0 cursor-help leading-none select-none text-vibe-fg-4"
													title={optionBadge.tooltip}
													aria-label={optionBadge.tooltip}
													onClick={(e) => e.stopPropagation()}
													onMouseDown={(e) => e.stopPropagation()}
												>{optionBadge.glyph}</span>
											) : null}
										</span>
										{showHint ? (
											<button
												type="button"
												className="@@vibe-dropdown-row__hint flex-shrink-0 flex items-center justify-center size-4 text-[10px] leading-none rounded-full cursor-help p-0 border-0 bg-transparent font-inherit text-inherit"
												title={optionDetail}
												aria-label={optionDetail}
												onClick={(e) => e.stopPropagation()}
												onMouseDown={(e) => e.stopPropagation()}
											>
												?
											</button>
										) : (
											<span className="@@vibe-dropdown-row__detail">{optionDetail}</span>
										)}
									</span>
								</div>
							);
						})}
						{dropdownQuickSearch && filterQuery.trim() && visibleOptions.length === 0 ? (
							<div className="px-3 py-2 text-xs text-vibe-fg-4 whitespace-normal">
								{dropdownSearchEmptyMessage}
							</div>
						) : null}
					</div>

				</div>
			)}
		</div>
	);
};



export const _VibeSelectBox = <T,>({ onChangeSelection, onCreateInstance, selectBoxRef, options, className }: {
	onChangeSelection: (value: T) => void;
	onCreateInstance?: ((instance: SelectBox) => void | IDisposable[]);
	selectBoxRef?: React.MutableRefObject<SelectBox | null>;
	options: readonly { text: string; value: T }[];
	className?: string;
}) => {
	const accessor = useAccessor();
	const contextViewProvider = accessor.get('IContextViewService');

	const containerRef = useRef<HTMLDivElement | null>(null);

	return <WidgetComponent
		className={`
			@@select-child-restyle
			@@[&_select]:!vibe-text-vibe-fg-3
			@@[&_select]:!vibe-text-xs
			!text-vibe-fg-3
			${className ?? ''}
		`}
		ctor={SelectBox}
		propsFn={useCallback((container) => {
			containerRef.current = container;
			const defaultIndex = 0;
			return [
				options.map(opt => ({ text: opt.text })),
				defaultIndex,
				contextViewProvider,
				defaultSelectBoxStyles,
			] as const;
		}, [containerRef, options])}

		dispose={useCallback((instance: SelectBox) => {
			instance.dispose();
			containerRef.current?.childNodes.forEach(child => {
				containerRef.current?.removeChild(child);
			});
		}, [containerRef])}

		onCreateInstance={useCallback((instance: SelectBox) => {
			const disposables: IDisposable[] = [];

			if (containerRef.current)
				{instance.render(containerRef.current);}

			disposables.push(
				instance.onDidSelect(e => { onChangeSelection(options[e.index].value); })
			);

			if (onCreateInstance) {
				const ds = onCreateInstance(instance) ?? [];
				disposables.push(...ds);
			}
			if (selectBoxRef)
				{selectBoxRef.current = instance;}

			return disposables;
		}, [containerRef, onChangeSelection, options, onCreateInstance, selectBoxRef])}

	/>;
};

// makes it so that code in the sidebar isnt too tabbed out
const normalizeIndentation = (code: string): string => {
	const lines = code.split('\n');

	let minLeadingSpaces = Infinity;

	// find the minimum number of leading spaces
	for (const line of lines) {
		if (line.trim() === '') {continue;}
		let leadingSpaces = 0;
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (char === '\t' || char === ' ') {
				leadingSpaces += 1;
			} else { break; }
		}
		minLeadingSpaces = Math.min(minLeadingSpaces, leadingSpaces);
	}

	// remove the leading spaces
	return lines.map(line => {
		if (line.trim() === '') {return line;}

		let spacesToRemove = minLeadingSpaces;
		let i = 0;
		while (spacesToRemove > 0 && i < line.length) {
			const char = line[i];
			if (char === '\t' || char === ' ') {
				spacesToRemove -= 1;
				i++;
			} else { break; }
		}

		return line.slice(i);

	}).join('\n');

};


export type BlockCodeProps = { initValue: string; language?: string; maxHeight?: number; showScrollbars?: boolean };
export const BlockCode = ({ initValue, language, maxHeight, showScrollbars }: BlockCodeProps) => {

	initValue = normalizeIndentation(initValue);

	const MAX_HEIGHT = maxHeight ?? Infinity;
	const SHOW_SCROLLBARS = showScrollbars ?? false;
	const languageId = language || 'plaintext';

	const accessor = useAccessor();
	const languageService = accessor.get('ILanguageService');

	// Read-only chat code previews used to mount a full Monaco `CodeEditorWidget` per
	// block. With long chat histories that meant hundreds of editors live at once,
	// each registering listeners on workbench services and holding TextModel /
	// ViewModel / View trees in memory. For a non-editable preview we only need
	// syntax-highlighted HTML, which `tokenizeToString` produces in O(text) and at
	// a fraction of the memory cost. Same approach VS Code uses for hover/markdown
	// code blocks (see editorMarkdownCodeBlockRenderer + markdownDocumentRenderer).
	const innerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		let cancelled = false;
		// Debounce 50ms so streaming chunks don't trigger a re-tokenize on every keystroke
		// of content arriving from the LLM. The last value wins; intermediates are dropped.
		const t = setTimeout(() => {
			tokenizeToString(languageService, initValue, languageId).then(html => {
				if (cancelled || !innerRef.current) {return;}
				// Workbench enforces Trusted Types — assigning a raw string to innerHTML
				// throws. Route through the TT policy created at module load (or fall back
				// to the raw string for browsers without TT).
				const trusted = _vibeideBlockCodeTTP ? _vibeideBlockCodeTTP.createHTML(html) ?? html : html;
				innerRef.current.innerHTML = trusted as string;
			});
		}, 50);
		return () => { cancelled = true; clearTimeout(t); };
	}, [initValue, languageId, languageService]);

	const outerStyle: React.CSSProperties = {
		maxHeight: MAX_HEIGHT === Infinity ? undefined : MAX_HEIGHT,
		overflowY: SHOW_SCROLLBARS ? 'auto' : 'hidden',
		overflowX: 'auto',
	};

	// `.monaco-tokenized-source` is the same class VS Code uses for tokenized HTML
	// (themed via the workbench color theme, so colors stay consistent with the editor).
	// `whiteSpace: pre` preserves indentation without an explicit <pre> wrapper.
	return <div className='relative z-0 px-2 py-1 bg-vibe-bg-3' style={outerStyle}>
		<div
			ref={innerRef}
			className='monaco-tokenized-source @@bg-editor-style-override'
			style={{ whiteSpace: 'pre', fontFamily: 'var(--monaco-monospace-font)' }}
		/>
	</div>;

};


export const VibeButtonBgDarken = ({ children, disabled, onClick, className, variant = 'secondary' }: { children: React.ReactNode; disabled?: boolean; onClick: () => void; className?: string; variant?: 'primary' | 'secondary' }) => {
	return <button disabled={disabled}
		type="button"
		className={`@@vibe-pill-button @@vibe-focus-ring ${variant === 'primary' ? '@@vibe-pill-button--primary' : '@@vibe-pill-button--secondary'} overflow-hidden whitespace-nowrap flex items-center justify-center ${className || ''}`}
		onClick={onClick}
	>{children}</button>;
};

// export const VoidScrollableElt = ({ options, children }: { options: ScrollableElementCreationOptions, children: React.ReactNode }) => {
// 	const instanceRef = useRef<DomScrollableElement | null>(null);
// 	const [childrenPortal, setChildrenPortal] = useState<React.ReactNode | null>(null)

// 	return <>
// 		<WidgetComponent
// 			ctor={DomScrollableElement}
// 			propsFn={useCallback((container) => {
// 				return [container, options] as const;
// 			}, [options])}
// 			onCreateInstance={useCallback((instance: DomScrollableElement) => {
// 				instanceRef.current = instance;
// 				setChildrenPortal(createPortal(children, instance.getDomNode()))
// 				return []
// 			}, [setChildrenPortal, children])}
// 			dispose={useCallback((instance: DomScrollableElement) => {
// 				console.log('calling dispose!!!!')
// 				// instance.dispose();
// 				// instance.getDomNode().remove()
// 			}, [])}
// 		>{children}</WidgetComponent>

// 		{childrenPortal}

// 	</>
// }

// export const VoidSelectBox = <T,>({ onChangeSelection, initVal, selectBoxRef, options }: {
// 	initVal: T;
// 	selectBoxRef: React.MutableRefObject<SelectBox | null>;
// 	options: readonly { text: string, value: T }[];
// 	onChangeSelection: (value: T) => void;
// }) => {


// 	return <WidgetComponent
// 		ctor={DropdownMenu}
// 		propsFn={useCallback((container) => {
// 			return [
// 				container, {
// 					contextMenuProvider,
// 					actions: options.map(({ text, value }, i) => ({
// 						id: i + '',
// 						label: text,
// 						tooltip: text,
// 						class: undefined,
// 						enabled: true,
// 						run: () => {
// 							onChangeSelection(value);
// 						},
// 					}))

// 				}] as const;
// 		}, [options, initVal, contextViewProvider])}

// 		dispose={useCallback((instance: DropdownMenu) => {
// 			instance.dispose();
// 			// instance.element.remove()
// 		}, [])}

// 		onCreateInstance={useCallback((instance: DropdownMenu) => {
// 			return []
// 		}, [])}

// 	/>;
// };




// export const VibeCheckBox = ({ onChangeChecked, initVal, label, checkboxRef, }: {
// 	onChangeChecked: (checked: boolean) => void;
// 	initVal: boolean;
// 	checkboxRef: React.MutableRefObject<ObjectSettingCheckboxWidget | null>;
// 	label: string;
// }) => {
// 	const containerRef = useRef<HTMLDivElement>(null);


// 	useEffect(() => {
// 		if (!containerRef.current) return;

// 		// Create and mount the Checkbox using VSCode's implementation

// 		checkboxRef.current = new ObjectSettingCheckboxWidget(
// 			containerRef.current,
// 			themeService,
// 			contextViewService,
// 			hoverService,
// 		);


// 		checkboxRef.current.setValue([{
// 			key: { type: 'string', data: label },
// 			value: { type: 'boolean', data: initVal },
// 			removable: false,
// 			resetable: true,
// 		}])

// 		checkboxRef.current.onDidChangeList((list) => {
// 			onChangeChecked(!!list);
// 		})


// 		// cleanup
// 		return () => {
// 			if (checkboxRef.current) {
// 				checkboxRef.current.dispose();
// 				if (containerRef.current) {
// 					while (containerRef.current.firstChild) {
// 						containerRef.current.removeChild(containerRef.current.firstChild);
// 					}
// 				}
// 				checkboxRef.current = null;
// 			}
// 		};
// 	}, [checkboxRef, label, initVal, onChangeChecked]);

// 	return <div ref={containerRef} className="w-full" />;
// };




const SingleDiffEditor = ({ block, lang }: { block: ExtractedSearchReplaceBlock; lang: string | undefined }) => {
	const accessor = useAccessor();
	const modelService = accessor.get('IModelService');
	const instantiationService = accessor.get('IInstantiationService');
	const languageService = accessor.get('ILanguageService');

	const languageSelection = useMemo(() => languageService.createById(lang), [lang, languageService]);

	// Create models for original and modified
	const originalModel = useMemo(() =>
		modelService.createModel(block.orig, languageSelection),
		[block.orig, languageSelection, modelService]
	);
	const modifiedModel = useMemo(() =>
		modelService.createModel(block.final, languageSelection),
		[block.final, languageSelection, modelService]
	);

	// Models are disposed inside the editor effect's cleanup AFTER the widget is torn
	// down — disposing them earlier triggers `TextModel got disposed before DiffEditorWidget
	// model got reset` from DiffEditorWidget's onWillDispose listener.

	// Imperatively mount the DiffEditorWidget
	const divRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<any>(null);

	useEffect(() => {
		if (!divRef.current) {return;}
		// Create the diff editor instance
		const editor = instantiationService.createInstance(
			DiffEditorWidget,
			divRef.current,
			{
				automaticLayout: true,
				readOnly: true,
				renderSideBySide: true,
				minimap: { enabled: false },
				lineNumbers: 'off',
				scrollbar: {
					vertical: 'hidden',
					horizontal: 'auto',
					verticalScrollbarSize: 0,
					horizontalScrollbarSize: 8,
					alwaysConsumeMouseWheel: false,
					ignoreHorizontalScrollbarInContentHeight: true,
				},
				hover: { enabled: false },
				folding: false,
				selectionHighlight: false,
				renderLineHighlight: 'none',
				overviewRulerLanes: 0,
				hideCursorInOverviewRuler: true,
				overviewRulerBorder: false,
				glyphMargin: false,
				stickyScroll: { enabled: false },
				scrollBeyondLastLine: false,
				renderGutterMenu: false,
				renderIndicators: false,
			},
			{ originalEditor: { isSimpleWidget: true }, modifiedEditor: { isSimpleWidget: true } }
		);
		editor.setModel({ original: originalModel, modified: modifiedModel });

		// Calculate the height based on content
		const updateHeight = () => {
			const contentHeight = Math.max(
				originalModel.getLineCount() * 19, // approximate line height
				modifiedModel.getLineCount() * 19
			) + 19 * 2 + 1; // add padding

			// Set reasonable min/max heights
			const height = Math.min(Math.max(contentHeight, 100), 300);
			if (divRef.current) {
				divRef.current.style.height = `${height}px`;
				editor.layout();
			}
		};

		updateHeight();
		editorRef.current = editor;

		// Update height when content changes
		const disposable1 = originalModel.onDidChangeContent(() => updateHeight());
		const disposable2 = modifiedModel.onDidChangeContent(() => updateHeight());

		return () => {
			disposable1.dispose();
			disposable2.dispose();
			// Detach models before disposing the widget so DiffEditorWidget releases
			// its onWillDispose subscription cleanly.
			editor.setModel(null);
			editor.dispose();
			editorRef.current = null;
			originalModel.dispose();
			modifiedModel.dispose();
		};
	}, [originalModel, modifiedModel, instantiationService]);

	return (
		<div className="w-full bg-vibe-bg-3 @@bg-editor-style-override" ref={divRef} />
	);
};





/**
 * ToolDiffEditor mounts a native VSCode DiffEditorWidget to show a diff between original and modified code blocks.
 * Props:
 *   - uri: URI of the file (for language detection, etc)
 *   - searchReplaceBlocks: string in search/replace format (from LLM)
 *   - language?: string (optional, fallback to 'plaintext')
 */
export const VibeDiffEditor = ({ uri, searchReplaceBlocks, language }: { uri?: any; searchReplaceBlocks: string; language?: string }) => {
	const accessor = useAccessor();
	const languageService = accessor.get('ILanguageService');

	// Extract all blocks
	const blocks = extractSearchReplaceBlocks(searchReplaceBlocks);

	// Use detectLanguage for language detection if not provided
	let lang = language;
	if (!lang && blocks.length > 0) {
		lang = detectLanguage(languageService, { uri: uri ?? null, fileContents: blocks[0].orig });
	}

	// If no blocks, show empty state
	if (blocks.length === 0) {
		return <div className="w-full p-4 text-vibe-fg-4 text-sm">{inputsS.noChangesFound}</div>;
	}

	// Display all blocks
	return (
		<div className="w-full flex flex-col gap-2">
			{blocks.map((block, index) => (
				<div key={index} className="w-full">
					{blocks.length > 1 && (
						<div className="text-vibe-fg-4 text-xs mb-1 px-1 vibe-diff-block-header">
							{inputsS.diffChangeOf(index + 1, blocks.length)}
						</div>
					)}
					<SingleDiffEditor block={block} lang={lang} />
				</div>
			))}
		</div>
	);
};


