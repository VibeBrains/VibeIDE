/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'; // Added useRef import just in case it was missed, though likely already present
import { ProviderName, SettingName, displayInfoOfSettingName, providerNames, VibeideStatefulModelInfo, customSettingNamesOfProvider, RefreshableProviderName, refreshableProviderNames, displayInfoOfProviderName, nonlocalProviderNames, localProviderNames, GlobalSettingName, featureNames, displayInfoOfFeatureName, isProviderNameDisabled, FeatureName, hasDownloadButtonsOnModelsProviderNames, subTextMdOfProviderName } from '../../../../common/vibeideSettingsTypes.js';
import { remoteCatalogCapableProviderNames } from '../../../../common/remoteCatalogService.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { VibeButtonBgDarken, VibeCustomDropdownBox, VibeInputBox2, VibeSimpleInputBox, VibeSwitch } from '../util/inputs.js';
import { useAccessor, useIsDark, useIsOptedOut, useMCPServiceState, useRefreshModelListener, useRefreshModelState, useSettingsState } from '../util/services.js';
import { X, RefreshCw, Loader2, Check, Asterisk, Plus, ChevronRight, ChevronDown, ImageOff, Image, Play } from 'lucide-react';
import { joinPath } from '../../../../../../../base/common/resources.js';
import { ModelDropdown } from './ModelDropdown.js';
import { VibeWorkspaceFormsPanel } from './VibeWorkspaceForms.js';
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js';
import { WarningBox } from './WarningBox.js';
import { os } from '../../../../common/helpers/systemInfo.js';
import { IconLoading } from '../sidebar-tsx/SidebarChat.js';
import { ToolApprovalType, toolApprovalTypes } from '../../../../common/toolsServiceTypes.js';
import Severity from '../../../../../../../base/common/severity.js';
import { API_PROTOCOL_VALUES, ApiProtocolOverride, getModelCapabilities, isFreeModel, modelOverrideKeys, ModelOverrides } from '../../../../common/modelCapabilities.js';
import { TransferEditorType, TransferFilesInfo } from '../../../extensionTransferTypes.js';
import { MCPServer } from '../../../../common/mcpServiceTypes.js';
import { OPT_OUT_KEY } from '../../../../common/storageKeys.js';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { generateUuid } from '../../../../../../../base/common/uuid.js';
import { nav, modelsS, providersS, generalS, ollamaS, miscS, toolApprovalLabel, safetyS, modelDdS, notifyS } from './vibeSettingsRu.js';
import { NOTIFY_DEFAULT_SOUND_IDS } from '../../../vibeNotifySoundService.js';

type Tab =
	| 'models'
	| 'localProviders'
	| 'providers'
	| 'featureOptions'
	| 'mcp'
	| 'workspace'
	| 'general'
	| 'notifications'
	| 'safety'
	| 'all';

type AllSettingsGroupKey = Exclude<Tab, 'all'>;

/** Collapsible block for the «All Settings» tab only (default collapsed). */
const AllSettingsFold = ({
	title,
	open,
	onToggle,
	children,
}: {
	title: string;
	open: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) => (
	<div className='@@vibe-chat-like-shell overflow-hidden'>
		<button
			type='button'
			className='w-full flex items-center gap-2 px-3 py-3 text-left text-xl font-semibold text-vibe-fg-1 bg-transparent hover:bg-[var(--vscode-list-hoverBackground)] transition-colors'
			onClick={onToggle}
			aria-expanded={open}
		>
			{open ? (
				<ChevronDown size={20} className='shrink-0 opacity-80' />
			) : (
				<ChevronRight size={20} className='shrink-0 opacity-80' />
			)}
			<span>{title}</span>
		</button>
		{open ? (
			<div className='px-3 pt-2 pb-4 border-t border-vibe-border-4'>{children}</div>
		) : null}
	</div>
);


const ButtonLeftTextRightOption = ({ text, leftButton }: { text: string; leftButton?: React.ReactNode }) => {

	return <div className='flex items-center text-vibe-fg-3 px-3 py-0.5 rounded-sm overflow-hidden gap-2'>
		{leftButton ? leftButton : null}
		<span>
			{text}
		</span>
	</div>;
};

// models
const RefreshModelButton = ({ providerName }: { providerName: RefreshableProviderName }) => {

	const refreshModelState = useRefreshModelState();

	const accessor = useAccessor();
	const refreshModelService = accessor.get('IRefreshModelService');
	const metricsService = accessor.get('IMetricsService');

	const [justFinished, setJustFinished] = useState<null | 'finished' | 'error'>(null);

	useRefreshModelListener(
		useCallback((providerName2, refreshModelState) => {
			if (providerName2 !== providerName) {return;}
			const { state } = refreshModelState[providerName];
			if (!(state === 'finished' || state === 'error')) {return;}
			// now we know we just entered 'finished' state for this providerName
			setJustFinished(state);
			const tid = setTimeout(() => { setJustFinished(null); }, 2000);
			return () => clearTimeout(tid);
		}, [providerName])
	);

	const { state } = refreshModelState[providerName];

	const { title: providerTitle } = displayInfoOfProviderName(providerName);

	return <ButtonLeftTextRightOption

		leftButton={
			<button
				className='flex items-center'
				disabled={state === 'refreshing' || justFinished !== null}
				onClick={() => {
					refreshModelService.startRefreshingModels(providerName, { enableProviderOnSuccess: false, doNotFire: false });
					metricsService.capture('Click', { providerName, action: 'Refresh Models' });
				}}
			>
				{justFinished === 'finished' ? <Check className='stroke-green-500 size-3' />
					: justFinished === 'error' ? <X className='stroke-red-500 size-3' />
						: state === 'refreshing' ? <Loader2 className='size-3 animate-spin' />
							: <RefreshCw className='size-3' />}
			</button>
		}

		text={justFinished === 'finished' ? modelsS.refreshUpToDate(providerTitle)
			: justFinished === 'error' ? modelsS.refreshNotFound(providerTitle)
				: modelsS.refreshManual(providerTitle)}
	/>;
};

const RefreshableModels = () => {
	const settingsState = useSettingsState();


	const buttons = refreshableProviderNames.map(providerName => {
		if (!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings) {return null;}
		return <RefreshModelButton key={providerName} providerName={providerName} />;
	});

	return <>
		{buttons}
	</>;

};

// Refresh button for remote provider catalogs (full row on Providers tab, or compact icon next to model search)
const RefreshRemoteCatalogButton = ({ providerName, compact }: { providerName: ProviderName; compact?: boolean }) => {
	const accessor = useAccessor();
	const refreshModelService = accessor.get('IRefreshModelService');
	const metricsService = accessor.get('IMetricsService');
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [justFinished, setJustFinished] = useState<null | 'finished' | 'error'>(null);

	const { title: providerTitle } = displayInfoOfProviderName(providerName);

	const handleRefresh = async () => {
		if (isRefreshing) {return;}
		setIsRefreshing(true);
		setJustFinished(null);

		try {
			await refreshModelService.refreshRemoteCatalog(providerName, true);
			setJustFinished('finished');
			metricsService.capture('Click', { providerName, action: 'Refresh Remote Catalog' });
		} catch (error) {
			vibeLog.error('Settings', 'Failed to refresh remote catalog:', error);
			setJustFinished('error');
		} finally {
			setIsRefreshing(false);
		}
		setTimeout(() => { setJustFinished(null); }, 2000);
	};

	const icon = justFinished === 'finished' ? <Check className='stroke-green-500 size-3' />
		: justFinished === 'error' ? <X className='stroke-red-500 size-3' />
			: isRefreshing ? <Loader2 className='size-3 animate-spin' />
				: <RefreshCw className='size-3' />;

	if (compact) {
		return <button
			type='button'
			className='flex items-center justify-center shrink-0 p-2 rounded-md hover:bg-[var(--vscode-list-hoverBackground)] text-vibe-fg-2 disabled:opacity-50'
			disabled={isRefreshing}
			onClick={() => void handleRefresh()}
			data-tooltip-id='vibe-tooltip'
			data-tooltip-place='bottom'
			data-tooltip-content={modelsS.catalogRefresh(providerTitle)}
			aria-label={modelsS.catalogRefresh(providerTitle)}
		>
			{icon}
		</button>;
	}

	return <ButtonLeftTextRightOption
		leftButton={
			<button
				className='flex items-center'
				disabled={isRefreshing || justFinished !== null}
				onClick={() => void handleRefresh()}
			>
				{icon}
			</button>
		}
		text={justFinished === 'finished' ? modelsS.catalogRefreshed(providerTitle)
			: justFinished === 'error' ? modelsS.catalogFailed(providerTitle)
				: modelsS.catalogRefresh(providerTitle)}
	/>;
};

const RefreshableRemoteCatalogs = () => {
	const settingsState = useSettingsState();

	// Show refresh buttons for remote providers that are configured
	const buttons = nonlocalProviderNames.map(providerName => {
		if (!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings) {return null;}
		return <RefreshRemoteCatalogButton key={providerName} providerName={providerName} />;
	});

	// Filter out nulls
	const validButtons = buttons.filter(Boolean);
	if (validButtons.length === 0) {return null;}

	return <>
		{validButtons}
	</>;
};



export const AnimatedCheckmarkButton = ({ text, className }: { text?: string; className?: string }) => {
	const [dashOffset, setDashOffset] = useState(40);

	useEffect(() => {
		const startTime = performance.now();
		const duration = 500; // 500ms animation

		const animate = (currentTime: number) => {
			const elapsed = currentTime - startTime;
			const progress = Math.min(elapsed / duration, 1);
			const newOffset = 40 - (progress * 40);

			setDashOffset(newOffset);

			if (progress < 1) {
				requestAnimationFrame(animate);
			}
		};

		const animationId = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(animationId);
	}, []);

	return <div
		className={`flex items-center gap-1.5 w-fit
			${className ? className : `@@vibe-pill-button @@vibe-pill-button--primary text-xs items-center`}
		`}
	>
		<svg className="size-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<path
				d="M5 13l4 4L19 7"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{
					strokeDasharray: 40,
					strokeDashoffset: dashOffset
				}}
			/>
		</svg>
		{text}
	</div>;
};


const AddButton = ({ disabled, text = modelsS.add, ...props }: { disabled?: boolean; text?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {

	return <button
		disabled={disabled}
		type="button"
		className={`@@vibe-pill-button @@vibe-pill-button--primary @@vibe-focus-ring ${!disabled ? 'cursor-pointer' : ''}`}
		{...props}
	>{text}</button>;

};

// ConfirmButton prompts for a second click to confirm an action, cancels if clicking outside
const ConfirmButton = ({ children, onConfirm, className, confirmLabel }: { children: React.ReactNode; onConfirm: () => void; className?: string; confirmLabel?: string }) => {
	const [confirm, setConfirm] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!confirm) {return;}
		const handleClickOutside = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setConfirm(false);
			}
		};
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	}, [confirm]);
	return (
		<div ref={ref} className={`inline-block`}>
			<VibeButtonBgDarken className={className} onClick={() => {
				if (!confirm) {
					setConfirm(true);
				} else {
					onConfirm();
					setConfirm(false);
				}
			}}>
				{confirm ? (confirmLabel ?? modelsS.confirmReset) : children}
			</VibeButtonBgDarken>
		</div>
	);
};

// ---------------- Simplified Model Settings Dialog ------------------

// keys of ModelOverrides we allow the user to override



// This new dialog replaces the verbose UI with a single JSON override box.
const SimpleModelSettingsDialog = ({
	isOpen,
	onClose,
	modelInfo,
}: {
	isOpen: boolean;
	onClose: () => void;
	modelInfo: { modelName: string; providerName: ProviderName; type: 'autodetected' | 'custom' | 'default' } | null;
}) => {
	if (!isOpen || !modelInfo) {return null;}

	const { modelName, providerName, type } = modelInfo;
	const accessor = useAccessor();
	const settingsState = useSettingsState();
	const mouseDownInsideModal = useRef(false); // Ref to track mousedown origin
	const settingsStateService = accessor.get('IVibeideSettingsService');

	// current overrides and defaults
	const defaultModelCapabilities = getModelCapabilities(providerName, modelName, undefined);
	const currentOverrides = settingsState.overridesOfModel?.[providerName]?.[modelName] ?? undefined;
	const { recognizedModelName, isUnrecognizedModel } = defaultModelCapabilities;

	// Create the placeholder with the default values for allowed keys.
	// `apiProtocol` is a meta-override (not a VibeideStaticModelInfo field), so
	// it isn't in `modelOverrideKeys`. Surface it explicitly below the JSON
	// example as a separate hint — users discover the field without grepping.
	const partialDefaults: Partial<ModelOverrides> = {};
	for (const k of modelOverrideKeys) { if (defaultModelCapabilities[k]) {partialDefaults[k] = defaultModelCapabilities[k] as ModelOverrides[typeof k];} }
	const placeholder = JSON.stringify(partialDefaults, null, 2);

	const [overrideEnabled, setOverrideEnabled] = useState<boolean>(() => !!currentOverrides);

	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

	// First-class form control for `apiProtocol` — small enum, dropdown fits
	// the UX much better than asking the user to type "anthropic" into JSON.
	// Sentinel `''` = "use default (no override)". On save the dropdown value
	// is merged into `cleaned` LAST so it wins over any stale value the user
	// may have left in the JSON textarea.
	// Defensive: stored `apiProtocol` MAY contain a stale/malformed value
	// (older code, hand-edited settings.json) that isn't in API_PROTOCOL_VALUES
	// anymore. Filter to the valid set; an unrecognised stored value shows
	// "(default)" in the dropdown and gets cleared on first save — better than
	// showing garbage in a select control or saving an invalid string.
	const apiProtocolFromOverrides = (() => {
		const v = currentOverrides?.apiProtocol as string | undefined;
		return v && (API_PROTOCOL_VALUES as readonly string[]).includes(v) ? v as ApiProtocolOverride : '';
	})();
	const [apiProtocolSelected, setApiProtocolSelected] = useState<ApiProtocolOverride | ''>(() => apiProtocolFromOverrides);

	// reset when dialog toggles
	useEffect(() => {
		if (!isOpen) {return;}
		const cur = settingsState.overridesOfModel?.[providerName]?.[modelName];
		const storedApi = cur?.apiProtocol as string | undefined;
		const validApi: ApiProtocolOverride | '' = storedApi && (API_PROTOCOL_VALUES as readonly string[]).includes(storedApi)
			? storedApi as ApiProtocolOverride
			: '';
		setOverrideEnabled(!!cur);
		setApiProtocolSelected(validApi);
		setErrorMsg(null);
	}, [isOpen, providerName, modelName, settingsState.overridesOfModel, placeholder]);

	const onSave = async () => {
		// if disabled override, reset overrides
		if (!overrideEnabled) {
			await settingsStateService.setOverridesOfModel(providerName, modelName, undefined);
			onClose();
			return;
		}

		// enabled overrides
		// parse json
		let parsedInput: Record<string, unknown>;

		if (textAreaRef.current?.value) {
			try {
				parsedInput = JSON.parse(textAreaRef.current.value);
			} catch (e) {
				setErrorMsg(modelsS.invalidJson);
				return;
			}
		} else {
			setErrorMsg(modelsS.invalidJson);
			return;
		}

		// only keep allowed keys
		const cleaned: Partial<ModelOverrides> = {};
		for (const k of modelOverrideKeys) {
			if (!(k in parsedInput)) {continue;}
			const isEmpty = parsedInput[k] === '' || parsedInput[k] === null || parsedInput[k] === undefined;
			if (!isEmpty) {
				cleaned[k] = parsedInput[k] as ModelOverrides[typeof k];
			}
		}
		// `apiProtocol` from JSON textarea — still accept it for power users who
		// prefer JSON, but the dropdown below is the primary control. We accept
		// JSON value FIRST, then let dropdown override (dropdown last write wins,
		// because the dialog is intentional "what I see in dropdown is what I save").
		if ('apiProtocol' in parsedInput) {
			const v = parsedInput.apiProtocol;
			if (typeof v === 'string' && (API_PROTOCOL_VALUES as readonly string[]).includes(v)) {
				cleaned.apiProtocol = v as ApiProtocolOverride;
			} else if (v !== '' && v !== null && v !== undefined) {
				setErrorMsg(`apiProtocol must be one of ${API_PROTOCOL_VALUES.map(p => `"${p}"`).join(', ')}; got: ${JSON.stringify(v)}`);
				return;
			}
		}
		// Dropdown takes precedence: if user picked a value, that wins; if they
		// chose "(default)" (empty sentinel), strip apiProtocol entirely.
		if (apiProtocolSelected) {
			cleaned.apiProtocol = apiProtocolSelected;
		} else {
			cleaned.apiProtocol = undefined;
		}
		// User explicitly took control via the override dialog — clear any
		// `_autoDetected` metadata from a prior auto-downgrade so the manual
		// values aren't shadowed by the TTL check in getModelCapabilities, and
		// so the "this model was auto-downgraded" UI signal doesn't keep showing.
		// Equivalent to clicking "Pin" in the auto-downgrade safety table below.
		cleaned._autoDetected = undefined;
		cleaned._detectedAt = undefined;
		cleaned._reason = undefined;
		await settingsStateService.setOverridesOfModel(providerName, modelName, cleaned);
		onClose();
	};

	const sourcecodeOverridesLink = `https://github.com/VibeBrains/VibeIDE/blob/main/src/vs/workbench/contrib/vibeide/common/modelCapabilities.ts#L146-L172`;

	return (
		<div // Backdrop
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999999]"
			onMouseDown={() => {
				mouseDownInsideModal.current = false;
			}}
			onMouseUp={() => {
				if (!mouseDownInsideModal.current) {
					onClose();
				}
				mouseDownInsideModal.current = false;
			}}
		>
			{/* MODAL */}
			<div
				className="@@vibe-chat-like-shell p-4 max-w-xl w-full shadow-xl overflow-y-auto max-h-[90vh]"
				onClick={(e) => e.stopPropagation()} // Keep stopping propagation for normal clicks inside
				onMouseDown={(e) => {
					mouseDownInsideModal.current = true;
					e.stopPropagation();
				}}
			>
				<div className="flex justify-between items-center mb-4">
					<h3 className="text-lg font-medium">
						{modelsS.changeDefaultsTitle(modelName, displayInfoOfProviderName(providerName).title)}
					</h3>
					<button
						onClick={onClose}
						className="text-vibe-fg-3 hover:text-vibe-fg-1"
					>
						<X className="size-5" />
					</button>
				</div>

				{/* Display model recognition status */}
				<div className="text-sm text-vibe-fg-3 mb-4">
					{type === 'default' ? modelsS.modelPackaged(modelName)
						: isUnrecognizedModel
						? modelsS.modelUnknown
						: modelsS.modelRecognized(modelName, recognizedModelName)}
				</div>


				{/* override toggle */}
				<div className="flex items-center gap-2 mb-4">
					<VibeSwitch size='xs' value={overrideEnabled} onChange={setOverrideEnabled} />
					<span className="text-vibe-fg-3 text-sm">{modelsS.overrideDefaults}</span>
				</div>

				{/* Informational link */}
				{overrideEnabled && <div className="text-sm text-vibe-fg-3 mb-4">
					<ChatMarkdownRender string={modelsS.sourcecodeRef(sourcecodeOverridesLink)} chatMessageLocation={undefined} />
				</div>}

				{/* apiProtocol first-class control. Dropdown is the primary way to set
				    this override; JSON textarea below still accepts the key for power
				    users, with dropdown winning on save. Options derive from
				    API_PROTOCOL_VALUES — single source of truth shared with the
				    aiSdkAdapter router and the JSON validator. */}
				{overrideEnabled && (
					<div className="mb-3">
						<label className="text-xs text-vibe-fg-3 mb-1 block">
							<code>apiProtocol</code> — force a specific AI SDK adapter (bypass models.dev catalog)
						</label>
						<select
							className="@@vibe-chat-like-control text-sm px-2 py-1"
							value={apiProtocolSelected}
							onChange={e => setApiProtocolSelected(e.target.value as ApiProtocolOverride | '')}
						>
							<option value=''>(default — use models.dev catalog)</option>
							{API_PROTOCOL_VALUES.map(p => (
								<option key={p} value={p}>{p}</option>
							))}
						</select>
					</div>
				)}

				<textarea
					key={overrideEnabled + ''}
					ref={textAreaRef}
					className={`@@vibe-chat-like-control w-full min-h-[200px] p-2 resize-none font-mono text-sm ${!overrideEnabled ? 'text-vibe-fg-3' : ''}`}
					defaultValue={overrideEnabled && currentOverrides ? JSON.stringify(currentOverrides, null, 2) : placeholder}
					placeholder={placeholder}
					readOnly={!overrideEnabled}
				/>
				{errorMsg && (
					<div className="text-red-500 mt-2 text-sm">{errorMsg}</div>
				)}


				<div className="flex justify-end gap-2 mt-4">
					<VibeButtonBgDarken onClick={onClose} className="px-3 py-1">
						{modelsS.cancel}
					</VibeButtonBgDarken>
					<VibeButtonBgDarken
						onClick={onSave}
						variant="primary"
						className="px-3 py-1"
					>
						{modelsS.save}
					</VibeButtonBgDarken>
				</div>
			</div>
		</div>
	);
};




export const ModelDump = ({ filteredProviders }: { filteredProviders?: ProviderName[] }) => {
	const accessor = useAccessor();
	const settingsStateService = accessor.get('IVibeideSettingsService');
	const settingsState = useSettingsState();

	// State to track which model's settings dialog is open
	const [openSettingsModel, setOpenSettingsModel] = useState<{
		modelName: string;
		providerName: ProviderName;
		type: 'autodetected' | 'custom' | 'default';
	} | null>(null);

	// States for add model functionality
	const [isAddModelOpen, setIsAddModelOpen] = useState(false);
	const [showCheckmark, setShowCheckmark] = useState(false);
	const [userChosenProviderName, setUserChosenProviderName] = useState<ProviderName | null>(null);
	const [modelName, setModelName] = useState<string>('');
	const [errorString, setErrorString] = useState('');
	const [expandedByProvider, setExpandedByProvider] = useState<Partial<Record<ProviderName, boolean>>>({});
	const [modelSearchByProvider, setModelSearchByProvider] = useState<Partial<Record<ProviderName, string>>>({});
	const [showOnlyActiveByProvider, setShowOnlyActiveByProvider] = useState<Partial<Record<ProviderName, boolean>>>({});

	const refreshModelService = accessor.get('IRefreshModelService');

	/** Only providers the user has fully configured (API keys / endpoint). Default catalog entries for others stay hidden. */
	const configuredProviders = useMemo(() => {
		// Include dynamic providers (.vibe/providers.json), which are seeded into settingsOfProvider with
		// non-built-in ids, so they list here exactly like built-ins.
		const builtinSet = new Set<string>(providerNames as readonly string[]);
		const dynamicIds = (Object.keys(settingsState.settingsOfProvider) as string[]).filter(id => !builtinSet.has(id)) as ProviderName[];
		// Dynamic providers first — same precedence as the provider cards and the chat picker (the user's
		// own .vibe/providers.json providers sit at the top).
		const base = filteredProviders ?? [...dynamicIds, ...providerNames];
		return base.filter(p => !!settingsState.settingsOfProvider[p]?._didFillInProviderSettings);
	}, [filteredProviders, settingsState.settingsOfProvider]);

	const modelsByProvider = useMemo(() => {
		const out: Partial<Record<ProviderName, (VibeideStatefulModelInfo & { providerName: ProviderName })[]>> = {};
		for (const providerName of configuredProviders) {
			const providerSettings = settingsState.settingsOfProvider[providerName];
			out[providerName] = providerSettings.models.map(model => ({ ...model, providerName }));
		}
		return out;
	}, [configuredProviders, settingsState.settingsOfProvider]);

	const configuredProvidersKey = configuredProviders.join(',');

	useEffect(() => {
		let cancelled = false;
		// Deps are the joined key — NOT the array — otherwise useMemo re-runs (triggered by
		// any settings change) hand us a fresh reference each render and we burst-fetch.
		const providers = configuredProvidersKey ? configuredProvidersKey.split(',') as ProviderName[] : [];
		void (async () => {
			for (const p of providers) {
				if (cancelled) {
					break;
				}
				if ((remoteCatalogCapableProviderNames as readonly string[]).indexOf(p) === -1) {
					continue;
				}
				try {
					await refreshModelService.refreshRemoteCatalog(p, false);
				} catch {
					// ignore network / CORS errors per provider
				}
			}
		})();
		return () => { cancelled = true; };
	}, [configuredProvidersKey, refreshModelService]);

	const toggleProviderSection = (pn: ProviderName) => {
		setExpandedByProvider(prev => ({ ...prev, [pn]: !(prev[pn] ?? false) }));
	};

	const renderModelRow = (m: VibeideStatefulModelInfo & { providerName: ProviderName }) => {
		const { isHidden, type, modelName, providerName } = m;
		const value = !isHidden;
		const tooltipName = value === true ? modelsS.tooltipShowInDropdown : modelsS.tooltipHideFromDropdown;
		const detailAboutModel = type === 'autodetected' ?
			<Asterisk size={14} className="inline-block align-text-top brightness-115 stroke-[2] text-[var(--vscode-textLink-foreground)]" data-tooltip-id='vibe-tooltip' data-tooltip-place='right' data-tooltip-content={modelsS.tooltipDetectedLocally} />
			: type === 'custom' ?
				<Asterisk size={14} className="inline-block align-text-top brightness-115 stroke-[2] text-[var(--vscode-textLink-foreground)]" data-tooltip-id='vibe-tooltip' data-tooltip-place='right' data-tooltip-content={modelsS.tooltipCustomModel} />
				: undefined;
		const overrides = settingsState.overridesOfModel?.[providerName]?.[modelName];
		const hasOverrides = !!overrides;
		const modality = typeof overrides?.modality === 'string' ? overrides.modality : undefined;
		// Tri-state vision override: undefined = auto (heuristic/catalog), true = forced on, false = forced off.
		const visionOverride: boolean | undefined = typeof overrides?.supportsVision === 'boolean' ? overrides.supportsVision : undefined;
		const cycleVisionOverride = async () => {
			const cur = settingsState.overridesOfModel?.[providerName]?.[modelName];
			const curVision = cur?.supportsVision;
			// Cycle auto -> forced-on -> forced-off -> auto. Forced-on lets the user enable a brand-new
			// vision model (any provider) the name-heuristic doesn't know yet without waiting for a release;
			// forced-off blocks a model that fakes vision support and silently drops images.
			const nextVision: boolean | undefined = curVision === undefined ? true : curVision === true ? false : undefined;
			if (nextVision === undefined) {
				// Back to auto: rebuild override without supportsVision; if nothing remains, clear it.
				const next: Partial<ModelOverrides> = { ...cur };
				delete (next as { supportsVision?: boolean }).supportsVision;
				const stillHasFields = Object.keys(next).length > 0;
				// Two-step: setOverridesOfModel merges, so clearing first is the only way to drop a key.
				await settingsStateService.setOverridesOfModel(providerName, modelName, undefined);
				if (stillHasFields) {
					await settingsStateService.setOverridesOfModel(providerName, modelName, next);
				}
			} else {
				await settingsStateService.setOverridesOfModel(providerName, modelName, { supportsVision: nextVision });
			}
		};
		return <div key={`${modelName}${providerName}`}
			className={`flex items-center justify-between gap-4 hover:bg-[var(--vscode-list-hoverBackground)] py-1 px-3 rounded-xl overflow-hidden cursor-default truncate group`}
		>
			<div className={`flex flex-grow items-center gap-4 min-w-0`}>
				<span className='w-fit max-w-[400px] truncate'>{modelName}</span>
				{m.fileNote ? (
					<span
						className='shrink-0 cursor-help text-vibe-fg-4 leading-none select-none'
						data-tooltip-id='vibe-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={m.fileNote === 'override' ? modelDdS.fileNoteOverride : modelDdS.fileNoteManual}
					>✎</span>
				) : null}
				{modality && <>
					<span className='text-vibe-fg-3 opacity-50 select-none'>·</span>
					<span className='text-vibe-fg-3 opacity-60 text-xs truncate font-mono'>{modality}</span>
				</>}
				{isFreeModel(providerName, modelName) && (
					<span
						className='shrink-0 text-[10px] font-mono uppercase tracking-wide px-1.5 py-px rounded border border-current text-[var(--vscode-charts-green)] opacity-80 select-none'
						data-tooltip-id='vibe-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={modelsS.freeBadgeTooltip}
					>
						{modelsS.freeBadgeLabel}
					</span>
				)}
			</div>
			<div className="flex items-center gap-2 w-fit">
				<div className="w-5 flex items-center justify-center">
					<button
						onClick={cycleVisionOverride}
						data-tooltip-id='vibe-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={visionOverride === true ? modelsS.tooltipVisionForcedOn : visionOverride === false ? modelsS.tooltipVisionForcedOff : modelsS.tooltipVisionAuto}
						className={`${visionOverride === undefined ? 'opacity-0 group-hover:opacity-100' : ''} transition-opacity`}
					>
						{visionOverride === false
							? <ImageOff size={12} className='text-[var(--vscode-errorForeground)]' />
							: <Image size={12} className={visionOverride === true ? 'text-[var(--vscode-charts-green)]' : 'text-vibe-fg-3 opacity-50'} />}
					</button>
				</div>
				<div className="w-5 flex items-center justify-center">
					<button
						onClick={() => { setOpenSettingsModel({ modelName, providerName, type }); }}
						data-tooltip-id='vibe-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={modelsS.tooltipAdvanced}
						className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
					>
						<Plus size={12} className="text-vibe-fg-3 opacity-50" />
					</button>
				</div>
				{detailAboutModel}
				<VibeSwitch
					value={value}
					onChange={() => { settingsStateService.toggleModelHidden(providerName, modelName); }}
					size='sm'
					data-tooltip-id='vibe-tooltip'
					data-tooltip-place='right'
					data-tooltip-content={tooltipName}
				/>
				<div className={`w-5 flex items-center justify-center`}>
					{type === 'default' || type === 'autodetected' ? null : <button
						onClick={() => { settingsStateService.deleteModel(providerName, modelName); }}
						data-tooltip-id='vibe-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={modelsS.tooltipDelete}
						className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
					>
						<X size={12} className="text-vibe-fg-3 opacity-50" />
					</button>}
				</div>
			</div>
		</div>;
	};

	// Add model handler
	const handleAddModel = () => {
		if (!userChosenProviderName) {
			setErrorString(modelsS.selectProvider);
			return;
		}
		if (!modelName) {
			setErrorString(modelsS.enterModelName);
			return;
		}

		// Check if model already exists
		if (settingsState.settingsOfProvider[userChosenProviderName].models.find(m => m.modelName === modelName)) {
			setErrorString(modelsS.modelExists);
			return;
		}

		settingsStateService.addModel(userChosenProviderName, modelName);
		setShowCheckmark(true);
		setTimeout(() => {
			setShowCheckmark(false);
			setIsAddModelOpen(false);
			setUserChosenProviderName(null);
			setModelName('');
		}, 1500);
		setErrorString('');
	};

	if (configuredProviders.length === 0) {
		return <div className='text-sm text-vibe-fg-3 py-2 max-w-xl'>
			<p className='mb-2'>{modelsS.noProviders}<strong className='text-vibe-fg-2'>{modelsS.providersTabStrong}</strong>{modelsS.noProviders2}</p>
			<p className='text-xs'>{modelsS.defaultsHidden}</p>
		</div>;
	}

	return <div className=''>
		{configuredProviders.map(providerName => {
			const allModels = modelsByProvider[providerName] ?? [];
			const activeOnly = showOnlyActiveByProvider[providerName] === true;
			const afterActive = activeOnly ? allModels.filter(m => !m.isHidden) : allModels;
			const q = (modelSearchByProvider[providerName] ?? '').trim().toLowerCase();
			// AND-tokenized search: split by whitespace, every token must match either model name
			// or modality literal (e.g. "image free" → models that contain both `image` and `free`
			// across name+modality, regardless of which field each token lands in).
			const tokens = q.length === 0 ? [] : q.split(/\s+/).filter(t => t.length > 0);
			const models = tokens.length === 0
				? afterActive
				: afterActive.filter(m => {
					const name = m.modelName.toLowerCase();
					const modality = settingsState.overridesOfModel?.[providerName]?.[m.modelName]?.modality;
					const modalityLower = typeof modality === 'string' ? modality.toLowerCase() : '';
					// Virtual `free` token: matches Pollinations + `:free`-suffixed ids even if the literal "free" is not in id.
					const freeTag = isFreeModel(providerName, m.modelName) ? 'free' : '';
					return tokens.every(t => name.includes(t) || modalityLower.includes(t) || (freeTag && freeTag.includes(t)));
				});
			const expanded = expandedByProvider[providerName] ?? false;
			const providerTitle = displayInfoOfProviderName(providerName).title;
			const countInParens = q.length > 0
				? `${models.length}/${afterActive.length}`
				: `${models.length}`;
			const countTitle = (q.length > 0 || activeOnly) ? safetyS.modelsCountTotal(allModels.length) : undefined;
			return <div key={providerName} className='mb-2 @@vibe-chat-like-shell overflow-hidden'>
				<button
					type='button'
					className='w-full flex items-center gap-2 px-3 py-2 text-left text-sm bg-transparent hover:bg-[var(--vscode-list-hoverBackground)] text-vibe-fg-1'
					onClick={() => toggleProviderSection(providerName)}
				>
					{expanded ? <ChevronDown size={16} className='shrink-0 opacity-80' /> : <ChevronRight size={16} className='shrink-0 opacity-80' />}
					<span className='font-medium'>{providerTitle}</span>
					<span className='text-vibe-fg-4 text-xs' title={countTitle}>
						({countInParens})
					</span>
				</button>
				{expanded ? <div className='px-1 pb-1'>
					<div className='px-2 pt-1 pb-2 flex items-center gap-2 flex-wrap'>
						<VibeSimpleInputBox
							value={modelSearchByProvider[providerName] ?? ''}
							onChangeValue={(v) => { setModelSearchByProvider(prev => ({ ...prev, [providerName]: v })); }}
							placeholder={modelsS.modelSearchPlaceholder}
							compact={true}
							className='flex-1 min-w-0 max-w-md'
						/>
						<div className='flex items-center gap-1 shrink-0'>
							{(remoteCatalogCapableProviderNames as readonly string[]).indexOf(providerName) >= 0 ? (
								<RefreshRemoteCatalogButton compact={true} providerName={providerName} />
							) : null}
							<div
								className='flex items-center gap-1 flex-shrink-0'
								title={modelsS.modelsOnlyActiveTitle}
							>
								<VibeSwitch
									size='xs'
									value={activeOnly}
									onChange={(v) => { setShowOnlyActiveByProvider(prev => ({ ...prev, [providerName]: v })); }}
								/>
								<span className='text-vibe-fg-3 text-xs whitespace-nowrap select-none pointer-events-none'>{modelsS.modelsOnlyActiveLabel}</span>
							</div>
						</div>
					</div>
					{models.map(m => renderModelRow(m))}
				</div> : null}
			</div>;
		})}

		{/* Add Model Section */}
		{showCheckmark ? (
			<div className="mt-4">
				<AnimatedCheckmarkButton text={modelsS.added} className="@@vibe-pill-button @@vibe-pill-button--primary text-xs" />
			</div>
		) : isAddModelOpen ? (
			<div className="mt-4">
				<form className="flex items-center gap-2">

					{/* Provider dropdown */}
					<ErrorBoundary>
						<VibeCustomDropdownBox
							options={configuredProviders}
							selectedOption={userChosenProviderName}
							onChangeOption={(pn) => setUserChosenProviderName(pn)}
							getOptionDisplayName={(pn) => pn ? displayInfoOfProviderName(pn).title : modelsS.providerNamePh}
							getOptionDropdownName={(pn) => pn ? displayInfoOfProviderName(pn).title : modelsS.providerNamePh}
							getOptionsEqual={(a, b) => a === b}
							className="max-w-32 mx-2 w-full resize-none text-vibe-fg-1 placeholder:text-vibe-fg-3 py-1 px-2 @@vibe-chat-like-shell"
							arrowTouchesText={false}
						/>
					</ErrorBoundary>

					{/* Model name input */}
					<ErrorBoundary>
						<VibeSimpleInputBox
							value={modelName}
							compact={true}
							onChangeValue={setModelName}
							placeholder={modelsS.modelNamePh}
							className='max-w-32'
						/>
					</ErrorBoundary>

					{/* Add button */}
					<ErrorBoundary>
						<AddButton
							type='button'
							disabled={!modelName || !userChosenProviderName}
							onClick={handleAddModel}
						/>
					</ErrorBoundary>

					{/* X button to cancel */}
					<button
						type="button"
						onClick={() => {
							setIsAddModelOpen(false);
							setErrorString('');
							setModelName('');
							setUserChosenProviderName(null);
						}}
						className='text-vibe-fg-4'
					>
						<X className='size-4' />
					</button>
				</form>

				{errorString && (
					<div className='text-red-500 truncate whitespace-nowrap mt-1'>
						{errorString}
					</div>
				)}
			</div>
		) : (
			<div
				className="text-vibe-fg-4 flex flex-nowrap text-nowrap items-center hover:brightness-110 cursor-pointer mt-4"
				onClick={() => setIsAddModelOpen(true)}
			>
				<div className="flex items-center gap-1">
					<Plus size={16} />
					<span>{modelsS.addModel}</span>
				</div>
			</div>
		)}

		{/* Model Settings Dialog */}
		<SimpleModelSettingsDialog
			isOpen={openSettingsModel !== null}
			onClose={() => setOpenSettingsModel(null)}
			modelInfo={openSettingsModel}
		/>
	</div>;
};



// providers

const ProviderSetting = ({ providerName, settingName, subTextMd }: { providerName: ProviderName; settingName: SettingName; subTextMd: React.ReactNode }) => {

	const { title: settingTitle, placeholder, isPasswordField } = displayInfoOfSettingName(providerName, settingName);

	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const settingsState = useSettingsState();

	if (providerName === 'openRouter' && settingName === 'publicCatalog') {
		const on = settingsState.settingsOfProvider.openRouter.publicCatalog === '1';
		return <ErrorBoundary>
			<div className='my-1'>
				<ButtonLeftTextRightOption
					leftButton={<VibeSwitch
						size='xxs'
						value={on}
						onChange={(nv) => { void vibeideSettingsService.setSettingOfProvider('openRouter', 'publicCatalog', nv ? '1' : '0'); }}
					/>}
					text={providersS.openRouterPublicCatalog}
				/>
				{!subTextMd ? null : <div className='py-1 px-3 opacity-50 text-sm'>
					{subTextMd}
				</div>}
			</div>
		</ErrorBoundary>;
	}

	const settingValue = settingsState.settingsOfProvider[providerName][settingName] as string; // this should always be a string in this component
	if (typeof settingValue !== 'string') {
		vibeLog.info('Settings', 'Error: Provider setting had a non-string value.');
		return;
	}

	// Create a stable callback reference using useCallback with proper dependencies
	const handleChangeValue = useCallback((newVal: string) => {
		vibeideSettingsService.setSettingOfProvider(providerName, settingName, newVal);
	}, [vibeideSettingsService, providerName, settingName]);

	return <ErrorBoundary>
		<div className='my-1'>
			<VibeSimpleInputBox
				value={settingValue}
				onChangeValue={handleChangeValue}
				placeholder={`${settingTitle} (${placeholder})`}
				passwordBlur={isPasswordField}
				compact={true}
			/>
			{!subTextMd ? null : <div className='py-1 px-3 opacity-50 text-sm'>
				{subTextMd}
			</div>}
		</div>
	</ErrorBoundary>;
};

// const OldSettingsForProvider = ({ providerName, showProviderTitle }: { providerName: ProviderName, showProviderTitle: boolean }) => {
// 	const vibeSettingsState = useSettingsState()

// 	const needsModel = isProviderNameDisabled(providerName, vibeSettingsState) === 'addModel'

// 	// const accessor = useAccessor()
// 	// const vibeideSettingsService = accessor.get('IVibeideSettingsService')

// 	// const { enabled } = vibeSettingsState.settingsOfProvider[providerName]
// 	const settingNames = customSettingNamesOfProvider(providerName)

// 	const { title: providerTitle } = displayInfoOfProviderName(providerName)

// 	return <div className='my-4'>

// 		<div className='flex items-center w-full gap-4'>
// 			{showProviderTitle && <h3 className='text-xl truncate'>{providerTitle}</h3>}

// 			{/* enable provider switch */}
// 			{/* <VibeSwitch
// 				value={!!enabled}
// 				onChange={
// 					useCallback(() => {
// 						const enabledRef = vibeideSettingsService.state.settingsOfProvider[providerName].enabled
// 						vibeideSettingsService.setSettingOfProvider(providerName, 'enabled', !enabledRef)
// 					}, [vibeideSettingsService, providerName])}
// 				size='sm+'
// 			/> */}
// 		</div>

// 		<div className='px-0'>
// 			{/* settings besides models (e.g. api key) */}
// 			{settingNames.map((settingName, i) => {
// 				return <ProviderSetting key={settingName} providerName={providerName} settingName={settingName} />
// 			})}

// 			{needsModel ?
// 				providerName === 'ollama' ?
// 					<WarningBox text={`Please install an Ollama model. We'll auto-detect it.`} />
// 					: <WarningBox text={`Please add a model for ${providerTitle} (Models section).`} />
// 				: null}
// 		</div>
// 	</div >
// }


export const SettingsForProvider = ({ providerName, showProviderTitle, showProviderSuggestions, borderedCard = false }: { providerName: ProviderName; showProviderTitle: boolean; showProviderSuggestions: boolean; borderedCard?: boolean }) => {
	const vibeSettingsState = useSettingsState();

	const needsModel = isProviderNameDisabled(providerName, vibeSettingsState) === 'addModel';

	// const accessor = useAccessor()
	// const vibeideSettingsService = accessor.get('IVibeideSettingsService')

	// const { enabled } = vibeSettingsState.settingsOfProvider[providerName]
	const settingNames = customSettingNamesOfProvider(providerName);
	const providerFieldKeys = settingNames.filter((sn) => !(providerName === 'openRouter' && sn === 'publicCatalog'));

	const { title: providerTitle } = displayInfoOfProviderName(providerName);

	// Dynamic providers (.vibe/providers.json) carry key validation status + source on their seeded
	// entry — surfaced below the key field so the user sees whether the key actually works.
	const isDynamicProvider = !(providerNames as readonly string[]).includes(providerName as string);
	const dynSeed = isDynamicProvider ? (vibeSettingsState.settingsOfProvider as Record<string, { keyStatus?: string; keySource?: string } | undefined>)[providerName] : undefined;
	const dynKeyStatus = dynSeed?.keyStatus;
	const dynKeySource = (dynSeed?.keySource ?? 'none') as keyof typeof providersS.dynKeySrc;

	const inner = <>
		<div className='flex items-center w-full gap-4'>
			{showProviderTitle && <h3 className='text-xl truncate'>{providerTitle}</h3>}

			{/* enable provider switch */}
			{/* <VibeSwitch
				value={!!enabled}
				onChange={
					useCallback(() => {
						const enabledRef = vibeideSettingsService.state.settingsOfProvider[providerName].enabled
						vibeideSettingsService.setSettingOfProvider(providerName, 'enabled', !enabledRef)
					}, [vibeideSettingsService, providerName])}
				size='sm+'
			/> */}
		</div>

		<div className='px-0 mt-2'>
			{/* settings besides models (e.g. api key) */}
			{providerFieldKeys.map((settingName, i) => {

				return <ProviderSetting
					key={settingName}
					providerName={providerName}
					settingName={settingName}
					subTextMd={i !== providerFieldKeys.length - 1 ? null
						: <ChatMarkdownRender string={subTextMdOfProviderName(providerName)} chatMessageLocation={undefined} />}
				/>;
			})}

			{providerName === 'openRouter' ?
				<ProviderSetting
					providerName='openRouter'
					settingName={'publicCatalog' as SettingName}
					subTextMd={null}
				/> : null}

			{isDynamicProvider && dynKeyStatus ? (() => {
					const srcSuffix = (dynKeyStatus !== 'none' && dynKeyStatus !== 'pending')
						? ` · ${providersS.dynKeySrcPrefix}: ${providersS.dynKeySrc[dynKeySource] ?? providersS.dynKeySrc.none}`
						: '';
					const cfg = dynKeyStatus === 'valid' ? { t: providersS.dynKeyValid, c: 'text-emerald-400' }
						: dynKeyStatus === 'invalid' ? { t: providersS.dynKeyInvalid, c: 'text-red-400' }
							: dynKeyStatus === 'error' ? { t: providersS.dynKeyError, c: 'text-amber-400' }
								: dynKeyStatus === 'pending' ? { t: providersS.dynKeyPending, c: 'text-vibe-fg-3' }
									: dynKeyStatus === 'unverified' ? { t: providersS.dynKeyUnverified, c: 'text-vibe-fg-3' }
										: { t: providersS.dynKeyNone, c: 'text-vibe-fg-4' };
					return <div className={`text-xs mt-1 pl-2 ${cfg.c}`}>{cfg.t}{srcSuffix}</div>;
				})() : null}

				{showProviderSuggestions && needsModel ?
				providerName === 'ollama' ?
					<WarningBox className="pl-2 mb-4" text={providersS.warnOllama} />
					: <div className='mb-4 flex flex-col gap-2'>
						<WarningBox className="pl-2" text={providersS.warnAddModel(providerTitle)} />
						{(remoteCatalogCapableProviderNames as readonly string[]).includes(providerName)
							&& vibeSettingsState.settingsOfProvider[providerName]._didFillInProviderSettings ? (
							<div className='flex flex-wrap items-center gap-2 pl-2'>
								<RefreshRemoteCatalogButton compact={true} providerName={providerName} />
								<span className='text-xs text-vibe-fg-3 max-w-xl'>{providersS.catalogRetryHint}</span>
							</div>
						) : null}
					</div>
				: null}
		</div>
	</>;

	if (borderedCard) {
		return <div className='@@vibe-provider-settings-card rounded-lg bg-vibe-bg-2/35 p-4 shadow-sm'>
			{inner}
		</div>;
	}

	return <div>{inner}</div>;
};


export const VibeProviderSettings = ({ providerNames }: { providerNames: ProviderName[] }) => {
	return <div className='flex flex-col gap-3'>
		{providerNames.map(providerName =>
			<SettingsForProvider key={providerName} providerName={providerName} showProviderTitle={true} showProviderSuggestions={true} borderedCard />
		)}
	</div>;
};

/**
 * Built-in cloud providers wrapped in a collapsible. Auto-collapses (but stays one click away) when
 * the user has their own providers via .vibe/providers.json AND no built-in has a key — the long
 * built-in list is just noise then. A manual toggle always wins over the auto rule for the session.
 */
const BuiltinProvidersFold = ({ names }: { names: ProviderName[] }) => {
	const settingsState = useSettingsState();

	const anyBuiltinKey = names.some(p => settingsState.settingsOfProvider[p]?._didFillInProviderSettings);
	const builtinSet = new Set<string>(providerNames as readonly string[]);
	const hasDynamicProviders = settingsState._modelOptions.some(o => {
		const pn = o.selection.providerName as string;
		return pn !== 'auto' && !builtinSet.has(pn);
	});
	const autoCollapse = hasDynamicProviders && !anyBuiltinKey;

	// null = follow the auto rule; once the user clicks, their choice sticks for the session.
	const [userOpen, setUserOpen] = useState<boolean | null>(null);
	const open = userOpen ?? !autoCollapse;

	return <div className='@@vibe-chat-like-shell overflow-hidden'>
		<button
			type='button'
			className='w-full flex items-center gap-2 px-3 py-3 text-left text-base font-semibold text-vibe-fg-1 bg-transparent hover:bg-[var(--vscode-list-hoverBackground)] transition-colors'
			onClick={() => setUserOpen(!open)}
			aria-expanded={open}
		>
			{open ? <ChevronDown size={18} className='shrink-0 opacity-80' /> : <ChevronRight size={18} className='shrink-0 opacity-80' />}
			<span>{miscS.builtinProvidersToggle(names.length)}</span>
		</button>
		{open ? <div className='pt-2'><VibeProviderSettings providerNames={names} /></div> : null}
	</div>;
};


/**
 * Cloud providers declared in `.vibe/providers.json`. They're seeded into `settingsOfProvider` as
 * first-class entries (by the dynamic-providers service), so they render with the SAME provider card
 * as built-ins — the raw file id as the title is a deliberate signal that the provider comes from a
 * file. The API key typed here persists separately and connects the provider (then its catalog loads).
 * Renders nothing when there are no dynamic providers.
 */
const DynamicProvidersSection = () => {
	const settingsState = useSettingsState();
	const builtinSet = new Set<string>(providerNames as readonly string[]);
	const dynamicIds = Object.keys(settingsState.settingsOfProvider).filter(id => !builtinSet.has(id));
	if (dynamicIds.length === 0) { return null; }
	return <div className='mb-4'>
		<h3 className='text-base font-semibold text-vibe-fg-1 mb-2'>{providersS.dynamicProvidersTitle}</h3>
		<div className='flex flex-col gap-3'>
			{dynamicIds.map(id =>
				<SettingsForProvider key={id} providerName={id as ProviderName} showProviderTitle={true} showProviderSuggestions={true} borderedCard />
			)}
		</div>
	</div>;
};


type TabName = 'models' | 'general';
export const AutoDetectLocalModelsToggle = () => {
	const settingName: GlobalSettingName = 'autoRefreshModels';

	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const metricsService = accessor.get('IMetricsService');

	const vibeSettingsState = useSettingsState();

	// right now this is just `enabled_autoRefreshModels`
	const enabled = vibeSettingsState.globalSettings[settingName];

	return <ButtonLeftTextRightOption
		leftButton={<VibeSwitch
			size='xxs'
			value={enabled}
			onChange={(newVal) => {
				vibeideSettingsService.setGlobalSetting(settingName, newVal);
				metricsService.capture('Click', { action: 'Autorefresh Toggle', settingName, enabled: newVal });
			}}
		/>}
		text={generalS.autoDetectLocal(refreshableProviderNames.map(providerName => displayInfoOfProviderName(providerName).title).join(', '))}
	/>;


};

export const AIInstructionsBox = () => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const vibeSettingsState = useSettingsState();
	return <VibeInputBox2
		className='min-h-[81px] p-3 rounded-sm'
		initValue={vibeSettingsState.globalSettings.aiInstructions}
		placeholder={generalS.aiInstructionsPlaceholder}
		multiline
		onChangeText={(newText) => {
			vibeideSettingsService.setGlobalSetting('aiInstructions', newText);
		}}
	/>;
};

const FastApplyMethodDropdown = () => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');

	const options = useMemo(() => [true, false], []);

	const onChangeOption = useCallback((newVal: boolean) => {
		vibeideSettingsService.setGlobalSetting('enableFastApply', newVal);
	}, [vibeideSettingsService]);

	return <VibeCustomDropdownBox
		className='text-xs text-vibe-fg-3 bg-vibe-bg-1 border border-vibe-border-1 rounded-xl overflow-hidden p-0.5 px-1'
		options={options}
		selectedOption={vibeideSettingsService.state.globalSettings.enableFastApply}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => val ? generalS.fastApply : generalS.slowApply}
		getOptionDropdownName={(val) => val ? generalS.fastApply : generalS.slowApply}
		getOptionDropdownDetail={(val) => val ? generalS.fastApplyDetail : generalS.slowApplyDetail}
		getOptionsEqual={(a, b) => a === b}
	/>;

};


export const OllamaSetupInstructions = ({ sayWeAutoDetect }: { sayWeAutoDetect?: boolean }) => {
    const accessor = useAccessor();
    const terminalToolService = accessor.get('ITerminalToolService');
    const nativeHostService = accessor.get('INativeHostService');
    const notificationService = accessor.get('INotificationService');
    const refreshModelService = accessor.get('IRefreshModelService');
    const repoIndexerService = accessor.get('IRepoIndexerService');
    const vibeideSettingsService = accessor.get('IVibeideSettingsService');

    const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
    const [statusText, setStatusText] = useState<string>('');
    const [method, setMethod] = useState<'auto' | 'brew' | 'curl' | 'winget' | 'choco'>('auto');
    const [currentTerminalId, setCurrentTerminalId] = useState<string | null>(null);
    const [terminalOutput, setTerminalOutput] = useState<string>('');
    const [modelTag, setModelTag] = useState<string>('llava'); // Default to vision model for better UX
    const [isHealthy, setIsHealthy] = useState<boolean | null>(null);

    // Auto-select sensible default per OS and filter options label hints
    useEffect(() => {
        (async () => {
            try {
                const osProps = await nativeHostService.getOSProperties();
                const t = (osProps.type + '').toLowerCase();
                if (t.includes('windows')) {setMethod('winget');}
                else if (t.includes('darwin') || t.includes('mac')) {setMethod('brew');}
                else {setMethod('curl');}
            } catch {}
        })();
    }, [nativeHostService]);

    const onInstall = useCallback(async () => {
        try {
            const osProps = await nativeHostService.getOSProperties();
            const isWindows = (osProps.type + '').toLowerCase().includes('windows');
            setStatus('running');
            setStatusText(ollamaS.statusStarting);

            // open a visible persistent terminal to show progress
            const persistentTerminalId = await terminalToolService.createPersistentTerminal({ cwd: null });
            setCurrentTerminalId(persistentTerminalId);
            // Best-effort: ensure terminal panel is visible
            try {
                const commandService = accessor.get('ICommandService');
                await commandService.executeCommand('workbench.action.terminal.focus');
            } catch { }
            await terminalToolService.focusPersistentTerminal(persistentTerminalId);

            let installCmd = '';
            if (isWindows) {
                const m = method === 'choco' ? 'choco install ollama -y'
                    : method === 'winget' || method === 'auto' ? 'winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements'
                        : 'winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements';
                installCmd = `powershell -ExecutionPolicy Bypass -Command "${m}; Start-Sleep -Seconds 2; Start-Process -WindowStyle Hidden ollama serve"`;
            } else {
                // Deterministic per-OS installers, independent of workspace cwd
                const osName = (osProps.type + '').toLowerCase();
                if (osName.includes('darwin') || osName.includes('mac')) {
                    // macOS: never use Linux curl. Prefer app or Homebrew cask, bootstrap brew if needed.
                    installCmd = 'bash -lc "set -e; \
                      if [ -d /Applications/Ollama.app ]; then \\\n+                        echo [VibeIDE] Found /Applications/Ollama.app; open -a Ollama; \\\n+                      else \\\n+                        if [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ]; then \\\n+                          eval \"$([ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew shellenv || /usr/local/bin/brew shellenv)\"; \\\n+                        else \\\n+                          echo [VibeIDE] Bootstrapping Homebrew...; /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"; \\\n+                          eval \"$([ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew shellenv || /usr/local/bin/brew shellenv)\"; \\\n+                        fi; \\\n+                        echo [VibeIDE] Installing Ollama via Homebrew Cask...; brew install --cask ollama || true; open -a Ollama; \\\n+                      fi; \\\n+                      echo [VibeIDE] Health check...; sleep 2; curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo [VibeIDE] Ollama running || echo [VibeIDE] Ollama not reachable yet; \
                    "';
                } else {
                    // Linux: official script only
                    installCmd = 'bash -lc "set -e; echo [VibeIDE] Installing Ollama (Linux); curl -fsSL https://ollama.com/install.sh | sh; (ollama serve >/dev/null 2>&1 &) || true; sleep 2; echo [VibeIDE] Health check; curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo [VibeIDE] Ollama running || echo [VibeIDE] Ollama not reachable yet;"';
                }
            }

            setStatusText(ollamaS.statusRunningInstaller);
            const { resPromise } = await terminalToolService.runCommand(installCmd, { type: 'persistent', persistentTerminalId });
            resPromise.catch(() => { /* ignore */ });

            // Configure default endpoint and refresh models
            vibeideSettingsService.setSettingOfProvider('ollama', 'endpoint', 'http://127.0.0.1:11434');
            refreshModelService.startRefreshingModels('ollama', { enableProviderOnSuccess: true, doNotFire: false });
            setStatus('running');
            setStatusText(ollamaS.statusLaunched);
            notificationService.info(ollamaS.notifStarted);
        } catch (e) {
            notificationService.error(ollamaS.notifFail);
            setStatus('error');
            setStatusText(ollamaS.failStartShort);
        }
    }, [terminalToolService, nativeHostService, notificationService, refreshModelService, vibeideSettingsService, method]);

    const onOpenTerminal = useCallback(async () => {
        if (currentTerminalId) {
            await terminalToolService.focusPersistentTerminal(currentTerminalId);
        } else {
            // Fallback: just open/focus terminal panel
            try {
                const commandService = accessor.get('ICommandService');
                await commandService.executeCommand('workbench.action.terminal.focus');
            } catch { }
        }
    }, [currentTerminalId, terminalToolService]);

    // Poll terminal output to show embedded, read-only log under the button
    useEffect(() => {
        let tid: any;
        const poll = async () => {
            if (!currentTerminalId) {return;}
            try {
                const output = await terminalToolService.readTerminal(currentTerminalId);
                setTerminalOutput(output);
            } catch { }
        };
        if (currentTerminalId) {
            poll();
            tid = setInterval(poll, 1500);
        }
        return () => { if (tid) {clearInterval(tid);} };
    }, [currentTerminalId, terminalToolService]);

    // Lightweight health poller for nicer UX
    useEffect(() => {
        let tid: any;
        const ping = async () => {
            try {
                const res = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
                setIsHealthy(res.ok);
                if (res.ok && status === 'running') {
                    setStatus('done');
                    setStatusText(ollamaS.statusRunning);
                }
            } catch {
                setIsHealthy(false);
            }
        };
        if (status === 'running' || status === 'done') {
            ping();
            tid = setInterval(ping, 3000);
        }
        return () => { if (tid) {clearInterval(tid);} };
    }, [status]);

    return <div className='prose-p:my-0 prose-ol:list-decimal prose-p:py-0 prose-ol:my-0 prose-ol:py-0 prose-span:my-0 prose-span:py-0 text-vibe-fg-3 text-sm list-decimal select-text'>
        <div className='flex items-center gap-3'>
            <ChatMarkdownRender string={ollamaS.header} chatMessageLocation={undefined} />
            <select
                className='text-xs bg-vibe-bg-1 text-vibe-fg-1 border border-vibe-border-1 rounded px-1 py-0.5'
                value={method}
                onChange={(e) => setMethod(e.target.value as 'auto' | 'brew' | 'curl' | 'winget' | 'choco')}
                title={ollamaS.installMethodTitle}
            >
                <option value='auto'>{ollamaS.optAuto}</option>
                <option value='brew'>{ollamaS.optBrew}</option>
                <option value='curl'>{ollamaS.optCurl}</option>
                <option value='winget'>{ollamaS.optWinget}</option>
                <option value='choco'>{ollamaS.optChoco}</option>
            </select>
            <button
                className='px-2 py-1 bg-vibe-bg-2 text-vibe-fg-1 border border-vibe-border-1 rounded hover:brightness-110 disabled:opacity-60'
                onClick={onInstall}
                disabled={status === 'running'}
            >{status === 'running' ? ollamaS.btnInstalling : ollamaS.btnInstall}</button>
            {status === 'error' && (
                <button
                    className='px-2 py-1 bg-vibe-bg-1 text-vibe-fg-3 border border-vibe-border-2 rounded hover:brightness-110'
                    onClick={() => { setStatus('idle'); setStatusText(''); setTerminalOutput(''); setIsHealthy(null); }}
                >{ollamaS.btnRetry}</button>
            )}
            {isHealthy !== null && (
                <span className={`text-xs px-2 py-0.5 rounded border ${isHealthy ? 'border-green-500 text-green-500' : 'border-vibe-border-2 text-vibe-fg-3'}`}>
                    {isHealthy ? ollamaS.healthy : ollamaS.waiting}
                </span>
            )}
        </div>
        {/* Inline Auto-tune toggle */}
        <div className=' pl-6 mt-2 flex items-center gap-2'>
            <div className='flex items-center gap-2'>
                <VibeSwitch
                    size='xxs'
                    value={!!vibeideSettingsService.state.globalSettings.enableAutoTuneOnPull}
                    onChange={(v) => vibeideSettingsService.setGlobalSetting('enableAutoTuneOnPull', !!v)}
                />
                <span className='text-vibe-fg-3 text-xs'>{ollamaS.autoTune}</span>
            </div>
            <div className='flex items-center gap-2 ml-4'>
                <VibeSwitch
                    size='xxs'
                    value={!!vibeideSettingsService.state.globalSettings.enableRepoIndexer}
                    onChange={(v) => vibeideSettingsService.setGlobalSetting('enableRepoIndexer', !!v)}
                />
                <span className='text-vibe-fg-3 text-xs'>{ollamaS.repoIndexer}</span>
            </div>
        </div>
        {/* Web browsing settings */}
        <div className=' pl-6 mt-2 flex items-center gap-2'>
            <div className='flex items-center gap-2'>
                <VibeSwitch
                    size='xxs'
                    value={vibeideSettingsService.state.globalSettings.useHeadlessBrowsing !== false}
                    onChange={(v) => vibeideSettingsService.setGlobalSetting('useHeadlessBrowsing', v)}
                />
                <span className='text-vibe-fg-3 text-xs'>{ollamaS.headlessBrowse}</span>
                <span className='text-vibe-fg-4 text-xs' title={ollamaS.headlessTitle}>
                    (i)
                </span>
            </div>
        </div>
        {status !== 'idle' && (
            <div className=' pl-6 text-vibe-fg-3'>{statusText}</div>
        )}
        {!!terminalOutput && (
            <div className=' pl-6 mt-2'>
                <div className='flex items-center gap-2 mb-1'>
                    <button
                        className='px-2 py-0.5 bg-vibe-bg-1 text-vibe-fg-3 border border-vibe-border-2 rounded hover:brightness-110'
                        onClick={async () => { try { await navigator.clipboard.writeText(terminalOutput); } catch {} }}
                    >{ollamaS.btnCopyLog}</button>
                    <button
                        className='px-2 py-0.5 bg-vibe-bg-1 text-vibe-fg-3 border border-vibe-border-2 rounded hover:brightness-110'
                        onClick={() => setTerminalOutput('')}
                    >{ollamaS.btnClear}</button>
                </div>
                <div className='border border-vibe-border-2 bg-vibe-bg-1 rounded p-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap'>
                    {terminalOutput}
                </div>
            </div>
        )}
        <div className=' pl-6 mt-2 flex items-center gap-2 whitespace-nowrap'>
            <span className='text-vibe-fg-3 text-xs'>{ollamaS.pullModel}</span>
            <select
                className='text-xs bg-vibe-bg-1 text-vibe-fg-1 border border-vibe-border-1 rounded px-1 py-0.5 shrink-0'
                value={modelTag}
                onChange={(e) => setModelTag(e.target.value)}
            >
                <optgroup label={ollamaS.groupCode}>
                    <option value='llama3.1'>llama3.1</option>
                    <option value='llama3.2'>llama3.2</option>
                    <option value='qwen2.5-coder'>qwen2.5-coder</option>
                    <option value='deepseek-coder'>deepseek-coder</option>
                </optgroup>
                <optgroup label={ollamaS.groupVision}>
                    <option value='llava'>llava (Vision)</option>
                    <option value='bakllava'>bakllava (Vision)</option>
                    <option value='llava:13b'>llava:13b (Vision, Better Quality)</option>
                    <option value='llava:7b'>llava:7b (Vision, Faster)</option>
                    <option value='bakllava:7b'>bakllava:7b (Vision)</option>
                </optgroup>
                <optgroup label={ollamaS.groupGeneral}>
                    <option value='llama3'>llama3</option>
                    <option value='mistral'>mistral</option>
                    <option value='mixtral'>mixtral</option>
                    <option value='qwen'>qwen</option>
                </optgroup>
            </select>
            <button
                className='px-2 py-1 bg-vibe-bg-2 text-vibe-fg-1 border border-vibe-border-1 rounded hover:brightness-110 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed'
                disabled={!modelTag || status === 'running'}
                onClick={async () => {
                    if (!modelTag) {
                        notificationService.warn(ollamaS.warnSelectPull);
                        return;
                    }

                    try {
                        setStatus('running');
                        setStatusText(ollamaS.pulling(modelTag));

                        // Check if current terminal exists, create new one if not
                        let terminalId = currentTerminalId;
                        if (!terminalId || !terminalToolService.persistentTerminalExists(terminalId)) {
                            terminalId = await terminalToolService.createPersistentTerminal({ cwd: null });
                            setCurrentTerminalId(terminalId);
                        }
                        await terminalToolService.focusPersistentTerminal(terminalId);

                        const { resPromise } = await terminalToolService.runCommand(`ollama pull ${modelTag}`, { type: 'persistent', persistentTerminalId: terminalId });

                        // Handle command result with proper error reporting
                        resPromise
                            .then(async ({ result, resolveReason }) => {
                                // Check if command completed successfully
                                if (resolveReason.type === 'done') {
                                    // Check exit code - 0 means success
                                    if (resolveReason.exitCode === 0) {
                                        // Also check result text for error indicators (ollama pull may exit with 0 but show errors)
                                        const resultText = result || '';
                                        if (resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('failed')) {
                                            setStatus('error');
                                            setStatusText(ollamaS.pullFailed(modelTag));
                                            notificationService.error(ollamaS.pullFailedNotif(modelTag));
                                            return;
                                        }

                                        // Success - update status and refresh models
                                        setStatus('done');
                                        setStatusText(ollamaS.pullOk(modelTag));
                                        notificationService.info(ollamaS.pullOkNotif(modelTag));

                                        // Refresh models after a short delay
                                        setTimeout(() => {
                                            refreshModelService.startRefreshingModels('ollama', { enableProviderOnSuccess: true, doNotFire: false });
                                            // Auto-tune: only if enabled in global settings
                                            try {
                                                if (vibeideSettingsService.state.globalSettings.enableAutoTuneOnPull) {
                                                    const mt = (modelTag || '').toLowerCase();
                                                    const looksFIM = mt.includes('coder') || mt.includes('starcoder') || mt.includes('code');
                                                    vibeideSettingsService.setOverridesOfModel('ollama', modelTag, {
                                                        supportsFIM: looksFIM,
                                                        contextWindow: looksFIM ? 128_000 : 64_000,
                                                        reservedOutputTokenSpace: 8_192,
                                                        supportsSystemMessage: 'system-role'
                                                    });
                                                    if (looksFIM) {
                                                        // Autocomplete defaults to FIM model
                                                        vibeideSettingsService.setGlobalSetting('enableAutocomplete', true);
                                                        vibeideSettingsService.setModelSelectionOfFeature('Autocomplete', { providerName: 'ollama', modelName: modelTag });
                                                        // Apply should use coder model by default
                                                        vibeideSettingsService.setModelSelectionOfFeature('Apply', { providerName: 'ollama', modelName: modelTag });
                                                    } else {
                                                        // Non-coder: prefer for Chat
                                                        vibeideSettingsService.setModelSelectionOfFeature('Chat', { providerName: 'ollama', modelName: modelTag });
                                                    }
                                                }
                                            } catch (e) {
                                                vibeLog.error('Settings', 'Auto-tune error:', e);
                                            }
                                            // Lightweight: warm project index placeholder (runs in background)
                                            try {
                                                if (vibeideSettingsService.state.globalSettings.enableRepoIndexer) {
                                                    notificationService.info(ollamaS.warmIndex);
                                                    repoIndexerService.warmIndex(undefined).then(() => {
                                                        notificationService.info(ollamaS.warmIndexDone);
                                                    }).catch(() => { });
                                                }
                                            } catch { }
                                        }, 3000);
                                    } else {
                                        // Non-zero exit code indicates failure
                                        const resultText = result || 'Unknown error';
                                        setStatus('error');
                                        setStatusText(ollamaS.pullExitErr(modelTag, resolveReason.exitCode));
                                        notificationService.error(ollamaS.pullExitNotif(modelTag, resultText));
                                    }
                                } else if (resolveReason.type === 'timeout') {
                                    // Command timed out (pull can take a while, this is expected for large models)
                                    // Still try to refresh models - the pull might be continuing in background
                                    setStatus('done');
                                    setStatusText(ollamaS.pullLong(modelTag));
                                    notificationService.info(ollamaS.pullStartedNotif(modelTag));
                                    // Refresh models after a delay - the model might appear when ready
                                    setTimeout(() => {
                                        refreshModelService.startRefreshingModels('ollama', { enableProviderOnSuccess: true, doNotFire: false });
                                    }, 5000);
                                }
                            })
                            .catch((error) => {
                                setStatus('error');
                                const errorMsg = error?.message || String(error) || 'Unknown error';
                                setStatusText(ollamaS.pullErr(modelTag, errorMsg));
                                notificationService.error(ollamaS.pullErrNotif(modelTag, errorMsg));
                                vibeLog.error('Settings', 'Pull error:', error);
                            });
                    } catch (error) {
                        setStatus('error');
                        const errorMsg = error?.message || String(error) || 'Unknown error';
                        setStatusText(ollamaS.pullStartErr(modelTag, errorMsg));
                        notificationService.error(ollamaS.pullStartErrNotif(modelTag, errorMsg));
                        vibeLog.error('Settings', 'Pull setup error:', error);
                    }
                }}
            >{ollamaS.btnPull}</button>
            <button
                className='px-2 py-1 bg-red-600/80 text-white border border-red-500/80 rounded hover:brightness-110 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed'
                disabled={!modelTag || status === 'running'}
                onClick={async () => {
                    if (!modelTag) {
                        notificationService.warn(ollamaS.warnSelectDelete);
                        return;
                    }

                    const ok = window.confirm(ollamaS.confirmDelete(modelTag));
                    if (!ok) {return;}

                    try {
                        setStatus('running');
                        setStatusText(ollamaS.deleting(modelTag));

                        // Check if current terminal exists, create new one if not
                        let terminalId = currentTerminalId;
                        if (!terminalId || !terminalToolService.persistentTerminalExists(terminalId)) {
                            terminalId = await terminalToolService.createPersistentTerminal({ cwd: null });
                            setCurrentTerminalId(terminalId);
                        }
                        await terminalToolService.focusPersistentTerminal(terminalId);

                        const { resPromise } = await terminalToolService.runCommand(`ollama rm ${modelTag}`, { type: 'persistent', persistentTerminalId: terminalId });

                        // Handle command result with proper error reporting
                        resPromise
                            .then(async ({ result, resolveReason }) => {
                                // Check if command completed successfully
                                if (resolveReason.type === 'done') {
                                    // Check exit code - 0 means success
                                    if (resolveReason.exitCode === 0) {
                                        // Success - update status and refresh models
                                        setStatus('done');
                                        setStatusText(ollamaS.deleteOk(modelTag));
                                        notificationService.info(ollamaS.deleteOkNotif(modelTag));

                                        // Refresh models after a short delay
                                        setTimeout(() => {
                                            refreshModelService.startRefreshingModels('ollama', { enableProviderOnSuccess: true, doNotFire: false });
                                        }, 2000);
                                    } else {
                                        // Non-zero exit code indicates failure
                                        const resultText = result || 'Unknown error';
                                        setStatus('error');
                                        setStatusText(ollamaS.deleteFailed(modelTag, resolveReason.exitCode));
                                        notificationService.error(ollamaS.deleteFailedNotif(modelTag, resultText));
                                    }
                                } else if (resolveReason.type === 'timeout') {
                                    // Command timed out (shouldn't happen for delete, but handle it)
                                    setStatus('error');
                                    setStatusText(ollamaS.deleteTimeout(modelTag));
                                    notificationService.warn(ollamaS.deleteTimeoutNotif(modelTag));
                                    // Still try to refresh models in case it did complete
                                    setTimeout(() => {
                                        refreshModelService.startRefreshingModels('ollama', { enableProviderOnSuccess: true, doNotFire: false });
                                    }, 2000);
                                }
                            })
                            .catch((error) => {
                                setStatus('error');
                                const errorMsg = error?.message || String(error) || 'Unknown error';
                                setStatusText(ollamaS.deleteErr(modelTag, errorMsg));
                                notificationService.error(ollamaS.deleteErrNotif(modelTag, errorMsg));
                                vibeLog.error('Settings', 'Delete error:', error);
                            });
                    } catch (error) {
                        setStatus('error');
                        const errorMsg = error?.message || String(error) || 'Unknown error';
                        setStatusText(ollamaS.deleteStartErr(modelTag, errorMsg));
                        notificationService.error(ollamaS.deleteStartErrNotif(modelTag, errorMsg));
                        vibeLog.error('Settings', 'Delete setup error:', error);
                    }
                }}
            >{ollamaS.btnDelete}</button>
        </div>
        <div className=' pl-6'><ChatMarkdownRender string={ollamaS.step1} chatMessageLocation={undefined} /></div>
        <div className=' pl-6'><ChatMarkdownRender string={ollamaS.step2} chatMessageLocation={undefined} /></div>
        {sayWeAutoDetect && <div className=' pl-6'><ChatMarkdownRender string={ollamaS.autoDetectNote} chatMessageLocation={undefined} /></div>}
    </div>;
};


const RedoOnboardingButton = ({ className }: { className?: string }) => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	return <div
		className={`text-vibe-fg-4 flex flex-nowrap text-nowrap items-center hover:brightness-110 cursor-pointer ${className}`}
		onClick={() => { vibeideSettingsService.setGlobalSetting('isOnboardingComplete', false); }}
	>
		{miscS.redoOnboarding}
	</div>;

};


export const ToolApprovalTypeSwitch = ({ approvalType, size, desc }: { approvalType: ToolApprovalType; size: "xxs" | "xs" | "sm" | "sm+" | "md"; desc: string }) => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const vibeSettingsState = useSettingsState();
	const metricsService = accessor.get('IMetricsService');

	const onToggleAutoApprove = useCallback((approvalType: ToolApprovalType, newValue: boolean) => {
		vibeideSettingsService.setGlobalSetting('autoApprove', {
			...vibeideSettingsService.state.globalSettings.autoApprove,
			[approvalType]: newValue
		});
		metricsService.capture('Tool Auto-Accept Toggle', { enabled: newValue });
	}, [vibeideSettingsService, metricsService]);

	return <>
		<VibeSwitch
			size={size}
			value={vibeSettingsState.globalSettings.autoApprove[approvalType] ?? false}
			onChange={(newVal) => onToggleAutoApprove(approvalType, newVal)}
		/>
		<span className="text-vibe-fg-3 text-xs">{desc}</span>
	</>;
};



export const OneClickSwitchButton = ({ fromEditor = 'VS Code', className = '' }: { fromEditor?: TransferEditorType; className?: string }) => {
	const accessor = useAccessor();
	const extensionTransferService = accessor.get('IExtensionTransferService');

	const [transferState, setTransferState] = useState<{ type: 'done'; error?: string } | { type: | 'loading' | 'justfinished' }>({ type: 'done' });



	const onClick = async () => {
		if (transferState.type !== 'done') {return;}

		setTransferState({ type: 'loading' });

		const errAcc = await extensionTransferService.transferExtensions(os, fromEditor);

		// Even if some files were missing, consider it a success if no actual errors occurred
		const hadError = !!errAcc;
		if (hadError) {
			setTransferState({ type: 'done', error: errAcc });
		}
		else {
			setTransferState({ type: 'justfinished' });
			setTimeout(() => { setTransferState({ type: 'done' }); }, 3000);
		}
	};

	return <>
		<VibeButtonBgDarken className={`max-w-48 p-4 ${className}`} disabled={transferState.type !== 'done'} onClick={onClick}>
			{transferState.type === 'done' ? miscS.transferFrom(fromEditor)
				: transferState.type === 'loading' ? <span className='text-nowrap flex flex-nowrap items-center gap-1'>{miscS.transferring}<IconLoading state="processing" inline /></span>
					: transferState.type === 'justfinished' ? <AnimatedCheckmarkButton text={miscS.settingsTransferred} className='bg-none' />
						: null
			}
		</VibeButtonBgDarken>
		{transferState.type === 'done' && transferState.error ? <WarningBox text={transferState.error} /> : null}
	</>;
};


// full settings

// MCP Server component
const MCPServerComponent = ({ name, server }: { name: string; server: MCPServer }) => {
	const accessor = useAccessor();
	const mcpService = accessor.get('IMCPService');

	const vibeSettings = useSettingsState();
	const isOn = vibeSettings.mcpUserStateOfName[name]?.isOn;

	const removeUniquePrefix = (name: string) => name.split('_').slice(1).join('_');

	return (
		<div className="border border-vibe-border-2 bg-vibe-bg-1 py-3 px-4 rounded-sm my-2">
			<div className="flex items-center justify-between">
				{/* Left side - status and name */}
				<div className="flex items-center gap-2">
					{/* Status indicator */}
					<div className={`w-2 h-2 rounded-full
						${server.status === 'success' ? 'bg-green-500'
							: server.status === 'error' ? 'bg-red-500'
								: server.status === 'loading' ? 'bg-yellow-500'
									: server.status === 'offline' ? 'bg-vibe-fg-3'
										: ''}
					`}></div>

					{/* Server name */}
					<div className="text-sm font-medium text-vibe-fg-1">{name}</div>
				</div>

				{/* Right side - power toggle switch */}
				<VibeSwitch
					value={isOn ?? false}
					size='xs'
					disabled={server.status === 'error'}
					onChange={() => mcpService.toggleServerIsOn(name, !isOn)}
				/>
			</div>

			{/* Tools section */}
			{isOn && (
				<div className="mt-3">
					<div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
						{(server.tools ?? []).length > 0 ? (
							(server.tools ?? []).map((tool: { name: string; description?: string }) => (
								<span
									key={tool.name}
									className="px-2 py-0.5 bg-vibe-bg-2 text-vibe-fg-3 rounded-sm text-xs"

									data-tooltip-id='vibe-tooltip'
									data-tooltip-content={tool.description || ''}
									data-tooltip-class-name='vibe-max-w-[300px]'
								>
									{removeUniquePrefix(tool.name)}
								</span>
							))
						) : (
							<span className="text-xs text-vibe-fg-3">{miscS.mcpNoTools}</span>
						)}
					</div>
				</div>
			)}

			{/* Command badge */}
			{isOn && server.command && (
				<div className="mt-3">
					<div className="text-xs text-vibe-fg-3 mb-1">{miscS.mcpCommand}</div>
					<div className="px-2 py-1 bg-vibe-bg-2 text-xs font-mono overflow-x-auto whitespace-nowrap text-vibe-fg-2 rounded-sm">
						{server.command}
					</div>
				</div>
			)}

			{/* Error message if present */}
			{server.error && (
				<div className="mt-3">
					<WarningBox text={server.error} />
				</div>
			)}
		</div>
	);
};

// Main component that renders the list of servers
const MCPServersList = () => {
	const mcpServiceState = useMCPServiceState();

	let content: React.ReactNode;
	if (mcpServiceState.error) {
		content = <div className="text-vibe-fg-3 text-sm mt-2">
			{mcpServiceState.error}
		</div>;
	}
	else {
		const entries = Object.entries(mcpServiceState.mcpServerOfName);
		if (entries.length === 0) {
			content = <div className="text-vibe-fg-3 text-sm mt-2">
				{miscS.mcpNoServers}
			</div>;
		}
		else {
			content = entries.map(([name, server]) => (
				<MCPServerComponent key={name} name={name} server={server} />
			));
		}
	}

	return <div className="my-2">{content}</div>;
};

/** Must be static class strings on JSX `className` so scope-tailwind prefixifies (constants are not rewritten). */
const FeatureOptionsSectionCard = ({ children, wide }: { children: React.ReactNode; wide?: boolean }) => (
	<div className={wide
		? `@@vibe-provider-settings-card rounded-lg bg-vibe-bg-2/35 p-4 shadow-sm w-full`
		: `@@vibe-provider-settings-card rounded-lg bg-vibe-bg-2/35 p-4 shadow-sm`
	}>{children}</div>
);

const FeatureOptionsSettingsBody = () => {
	const settingsState = useSettingsState();
	const vibeideSettingsService = useAccessor().get('IVibeideSettingsService');
	return (
		<div className='flex flex-col gap-3 my-4'>
			<ErrorBoundary>
				{/* FIM */}
				<FeatureOptionsSectionCard>
					<h4 className={`text-base`}>{displayInfoOfFeatureName('Autocomplete')}</h4>
					<div className='text-sm text-vibe-fg-3 mt-1'>
						<span>
							{miscS.fimExperimental}{' '}
						</span>
						<span
							className='hover:brightness-110'
							data-tooltip-id='vibe-tooltip'
							data-tooltip-content={miscS.fimTooltip}
							data-tooltip-class-name='vibe-max-w-[20px]'
						>
							{miscS.fimOnly}
						</span>
					</div>

					<div className='my-2'>
						{/* Enable Switch */}
						<ErrorBoundary>
							<div className='flex items-center gap-x-2 my-2'>
								<VibeSwitch
									size='xs'
									value={settingsState.globalSettings.enableAutocomplete}
									onChange={(newVal) => vibeideSettingsService.setGlobalSetting('enableAutocomplete', newVal)}
								/>
								<span className='text-vibe-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.enableAutocomplete ? miscS.enabled : miscS.disabled}</span>
							</div>
						</ErrorBoundary>

						{/* Model Dropdown */}
						<ErrorBoundary>
							<div className={`my-2 ${!settingsState.globalSettings.enableAutocomplete ? 'hidden' : ''}`}>
								<ModelDropdown featureName={'Autocomplete'} className='text-xs text-vibe-fg-3 bg-vibe-bg-1 border border-vibe-border-1 rounded-xl overflow-hidden p-0.5 px-1' />
							</div>
						</ErrorBoundary>

					</div>

				</FeatureOptionsSectionCard>
			</ErrorBoundary>

			{/* Apply */}
			<ErrorBoundary>

				<FeatureOptionsSectionCard wide>
					<h4 className={`text-base`}>{displayInfoOfFeatureName('Apply')}</h4>
					<div className='text-sm text-vibe-fg-3 mt-1'>{miscS.applyDesc}</div>

					<div className='my-2'>
						{/* Sync to Chat Switch */}
						<div className='flex items-center gap-x-2 my-2'>
							<VibeSwitch
								size='xs'
								value={settingsState.globalSettings.syncApplyToChat}
								onChange={(newVal) => vibeideSettingsService.setGlobalSetting('syncApplyToChat', newVal)}
							/>
							<span className='text-vibe-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.syncApplyToChat ? miscS.sameAsChat : miscS.differentModel}</span>
						</div>

						{/* Model Dropdown */}
						<div className={`my-2 ${settingsState.globalSettings.syncApplyToChat ? 'hidden' : ''}`}>
							<ModelDropdown featureName={'Apply'} className='text-xs text-vibe-fg-3 bg-vibe-bg-1 border border-vibe-border-1 rounded-xl overflow-hidden p-0.5 px-1' />
						</div>
					</div>


					<div className='my-2'>
						{/* Fast Apply Method Dropdown */}
						<div className='flex items-center gap-x-2 my-2'>
							<FastApplyMethodDropdown />
						</div>
					</div>

				</FeatureOptionsSectionCard>
			</ErrorBoundary>




			{/* Tools Section */}
			<FeatureOptionsSectionCard>
				<h4 className={`text-base`}>{miscS.toolsTitle}</h4>
				<div className='text-sm text-vibe-fg-3 mt-1'>{miscS.toolsDesc}</div>

				<div className='my-2'>
					{/* Auto Accept Switch */}
					<ErrorBoundary>
						{[...toolApprovalTypes].map((approvalType) => {
							return <div key={approvalType} className="flex items-center gap-x-2 my-2">
								<ToolApprovalTypeSwitch size='xs' approvalType={approvalType} desc={toolApprovalLabel(approvalType)} />
							</div>;
						})}

					</ErrorBoundary>

					{/* Tool Lint Errors Switch */}
					<ErrorBoundary>

						<div className='flex items-center gap-x-2 my-2'>
							<VibeSwitch
								size='xs'
								value={settingsState.globalSettings.includeToolLintErrors}
								onChange={(newVal) => vibeideSettingsService.setGlobalSetting('includeToolLintErrors', newVal)}
							/>
							<span className='text-vibe-fg-3 text-xs pointer-events-none'>{miscS.fixLint}</span>
						</div>
					</ErrorBoundary>

					{/* Auto Accept LLM Changes Switch */}
					<ErrorBoundary>
						<div className='flex items-center gap-x-2 my-2'>
							<VibeSwitch
								size='xs'
								value={settingsState.globalSettings.autoAcceptLLMChanges}
								onChange={(newVal) => vibeideSettingsService.setGlobalSetting('autoAcceptLLMChanges', newVal)}
							/>
							<span className='text-vibe-fg-3 text-xs pointer-events-none'>{miscS.autoAcceptLlm}</span>
						</div>
					</ErrorBoundary>
				</div>
			</FeatureOptionsSectionCard>

			{/* YOLO Mode Section */}
			<ErrorBoundary>
				<FeatureOptionsSectionCard>
					<h4 className={`text-base`}>{miscS.yoloTitle}</h4>
					<div className='text-sm text-vibe-fg-3 mt-1'>
						{miscS.yoloDesc}
					</div>

					<div className='my-2'>
						{/* Enable YOLO Mode Switch */}
						<ErrorBoundary>
							<div className='flex items-center gap-x-2 my-2'>
								<VibeSwitch
									size='xs'
									value={settingsState.globalSettings.enableYOLOMode ?? false}
									onChange={(newVal) => vibeideSettingsService.setGlobalSetting('enableYOLOMode', newVal)}
								/>
								<span className='text-vibe-fg-3 text-xs pointer-events-none'>
									{settingsState.globalSettings.enableYOLOMode ? miscS.enabled : miscS.disabled}
								</span>
							</div>
						</ErrorBoundary>

						{/* Risk Threshold (only show when enabled) */}
						{settingsState.globalSettings.enableYOLOMode && (
							<div className='my-4 space-y-3'>
								<div>
									<label className='text-sm text-vibe-fg-2 mb-1 block'>
										{miscS.riskThreshold} {(settingsState.globalSettings.yoloRiskThreshold ?? 0.2).toFixed(2)}
									</label>
									<div className='text-xs text-vibe-fg-3 mb-2'>
										{miscS.riskHelp}
									</div>
									<input
										type='range'
										min='0'
										max='1'
										step='0.05'
										value={settingsState.globalSettings.yoloRiskThreshold ?? 0.2}
										onChange={(e) => vibeideSettingsService.setGlobalSetting('yoloRiskThreshold', parseFloat(e.target.value))}
										className='w-full'
									/>
								</div>

								<div>
									<label className='text-sm text-vibe-fg-2 mb-1 block'>
										{miscS.confidenceThreshold} {(settingsState.globalSettings.yoloConfidenceThreshold ?? 0.7).toFixed(2)}
									</label>
									<div className='text-xs text-vibe-fg-3 mb-2'>
										{miscS.confidenceHelp}
									</div>
									<input
										type='range'
										min='0'
										max='1'
										step='0.05'
										value={settingsState.globalSettings.yoloConfidenceThreshold ?? 0.7}
										onChange={(e) => vibeideSettingsService.setGlobalSetting('yoloConfidenceThreshold', parseFloat(e.target.value))}
										className='w-full'
									/>
								</div>
							</div>
						)}
					</div>
				</FeatureOptionsSectionCard>
			</ErrorBoundary>



			<FeatureOptionsSectionCard wide>
				<h4 className={`text-base`}>{miscS.chatDisplayTitle}</h4>
				<div className='text-sm text-vibe-fg-3 mt-1'>{miscS.chatDisplayDesc}</div>

				<div className='my-2'>
					{/* Show chat timestamps switch — single source of truth for all message/checkpoint timestamps */}
					<ErrorBoundary>
						<div className='flex items-center gap-x-2 my-2'>
							<VibeSwitch
								size='xs'
								value={settingsState.globalSettings.showChatTimestamps !== false}
								onChange={(newVal) => vibeideSettingsService.setGlobalSetting('showChatTimestamps', newVal)}
							/>
							<span className='text-vibe-fg-3 text-xs pointer-events-none'>{miscS.showChatTimestamps}</span>
						</div>
					</ErrorBoundary>
				</div>
			</FeatureOptionsSectionCard>

			<FeatureOptionsSectionCard wide>
				<h4 className={`text-base`}>{miscS.editorTitle}</h4>
				<div className='text-sm text-vibe-fg-3 mt-1'>{miscS.editorDesc}</div>

				<div className='my-2'>
					{/* Auto Accept Switch */}
					<ErrorBoundary>
						<div className='flex items-center gap-x-2 my-2'>
							<VibeSwitch
								size='xs'
								value={settingsState.globalSettings.showInlineSuggestions}
								onChange={(newVal) => vibeideSettingsService.setGlobalSetting('showInlineSuggestions', newVal)}
							/>
							<span className='text-vibe-fg-3 text-xs pointer-events-none'>{miscS.showSuggestions}</span>
						</div>
					</ErrorBoundary>
				</div>
			</FeatureOptionsSectionCard>

			{/* SCM */}
			<ErrorBoundary>

				<FeatureOptionsSectionCard wide>
					<h4 className={`text-base`}>{displayInfoOfFeatureName('SCM')}</h4>
					<div className='text-sm text-vibe-fg-3 mt-1'>{miscS.scmDesc}</div>

					<div className='my-2'>
						{/* Sync to Chat Switch */}
						<div className='flex items-center gap-x-2 my-2'>
							<VibeSwitch
								size='xs'
								value={settingsState.globalSettings.syncSCMToChat}
								onChange={(newVal) => vibeideSettingsService.setGlobalSetting('syncSCMToChat', newVal)}
							/>
							<span className='text-vibe-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.syncSCMToChat ? miscS.sameAsChat : miscS.differentModel}</span>
						</div>

						{/* Model Dropdown */}
						<div className={`my-2 ${settingsState.globalSettings.syncSCMToChat ? 'hidden' : ''}`}>
							<ModelDropdown featureName={'SCM'} className='text-xs text-vibe-fg-3 bg-vibe-bg-1 border border-vibe-border-1 rounded-xl overflow-hidden p-0.5 px-1' />
						</div>
					</div>

				</FeatureOptionsSectionCard>
			</ErrorBoundary>
		</div>
	);
};

// -----------------------------------------------------------------------------
// Safety & Diagnostics panel (roadmap §L.6 L1055 / L1056 / L991 / L992 / L1057)
// — radio for auto-stash mode + model-routing link + live PerfPanel +
// session-MemoryPanel.
// -----------------------------------------------------------------------------

const AUTOSTASH_MODES = ['always', 'dirty-only', 'never'] as const;
type AutostashMode = typeof AUTOSTASH_MODES[number];
const AUTOSTASH_KEY = 'vibeide.safety.autostash.mode';

// L991 — Performance Guardrails React panel.
// Reads .vibe/perf-guardrails-events.jsonl from the active workspace folder via
// IFileService, aggregates the last 24h via aggregatePerfGuardrails, renders a
// per-rule table. Refresh is manual to keep this off the render hot path.
const PerfGuardrailsPanel = () => {
	const accessor = useAccessor();
	const fileService = accessor.get('IFileService');
	const workspaceService = accessor.get('IWorkspaceContextService');
	const notificationService = accessor.get('INotificationService');

	type Row = {
		rule: string;
		tripCount: number;
		maxObservedValue: number;
		avgObservedValue: number;
		thresholdValue: number;
		topContext: string;
	};
	const [rows, setRows] = useState<Row[]>([]);
	const [empty, setEmpty] = useState<boolean>(true);
	const [err, setErr] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setErr(null);
		try {
			const folder = workspaceService.getWorkspace().folders[0];
			if (!folder) {
				setRows([]); setEmpty(true); return;
			}
			const uri = joinPath(folder.uri, '.vibe', 'perf-guardrails-events.jsonl');
			let text = '';
			try {
				const buf = await fileService.readFile(uri);
				text = buf.value.toString();
			} catch {
				setRows([]); setEmpty(true); return;
			}
			const events: any[] = [];
			for (const line of text.split(/\r\n|\r|\n/)) {
				const trimmed = line.trim();
				if (!trimmed) {continue;}
				try {
					events.push(JSON.parse(trimmed));
				} catch { /* skip malformed */ }
			}
			const { aggregatePerfGuardrails } = await import('../../../../common/perfGuardrailsAggregator.js');
			const now = Date.now();
			const dash = aggregatePerfGuardrails(events, now - 24 * 60 * 60 * 1000, now);
			setRows(dash.rules.map(r => ({
				rule: r.rule,
				tripCount: r.tripCount,
				maxObservedValue: r.maxObservedValue,
				avgObservedValue: r.avgObservedValue,
				thresholdValue: r.thresholdValue,
				topContext: r.topContext,
			})));
			setEmpty(dash.rules.length === 0);
		} catch (e: any) {
			setErr(e?.message ?? String(e));
		}
	}, [fileService, workspaceService]);

	useEffect(() => { void refresh(); }, [refresh]);

	return (
		<div className='max-w-[800px]'>
			<h2 className='text-xl mb-2'>{safetyS.perfPanelTitle}</h2>
			<h4 className='text-vibe-fg-3 mb-4'>{safetyS.perfPanelIntro}</h4>
			<div className='flex gap-2 mb-2'>
				<VibeButtonBgDarken className='px-4 py-1 max-w-fit' onClick={() => { void refresh(); }}>
					{safetyS.perfPanelRefresh}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken
					className='px-4 py-1 max-w-fit'
					onClick={() => {
						notificationService.notify({
							severity: Severity.Info,
							message: safetyS.perfPanelRunDoctorMsg,
						});
					}}
				>
					{safetyS.perfPanelOpenOutput}
				</VibeButtonBgDarken>
			</div>
			{err ? <div className='text-vibe-fg-3 text-xs mb-2'>error: {err}</div> : null}
			{empty ? (
				<div className='text-vibe-fg-3 text-sm'>{safetyS.perfPanelEmpty}</div>
			) : (
				<table className='text-vibe-fg-1 text-sm w-full border-collapse'>
					<thead>
						<tr className='text-left text-vibe-fg-3'>
							<th className='px-2 py-1'>{safetyS.perfPanelColRule}</th>
							<th className='px-2 py-1'>{safetyS.perfPanelColTrips}</th>
							<th className='px-2 py-1'>{safetyS.perfPanelColAvg}</th>
							<th className='px-2 py-1'>{safetyS.perfPanelColMax}</th>
							<th className='px-2 py-1'>{safetyS.perfPanelColThreshold}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(r => (
							<tr key={r.rule}>
								<td className='px-2 py-1'>{r.rule}{r.topContext ? <span className='text-vibe-fg-3'> · {r.topContext}</span> : null}</td>
								<td className='px-2 py-1'>{r.tripCount}</td>
								<td className='px-2 py-1'>{r.avgObservedValue.toFixed(1)}</td>
								<td className='px-2 py-1'>{r.maxObservedValue.toFixed(1)}</td>
								<td className='px-2 py-1'>{r.thresholdValue.toFixed(1)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
};

// L992 / L1057 — Session-memory React panel.
// Pulls in-memory snapshot from IVibeSessionMemoryService for the current
// chat thread; manual refresh button so we don't subscribe to every append.
// R.4.1 — Project rules panel: lists discovered rule sources (.vibe/rules.md, AGENTS.md,
// .vibe/rules/**, .cursor/rules/** — .md/.mdc), with an enable/disable toggle (per-workspace,
// honored in the prompt combine) and click-to-preview of the (frontmatter-stripped, sanitized) body.
const ProjectRulesPanel = () => {
	const accessor = useAccessor();
	const rulesSvc = accessor.get('IVibeProjectRulesService');

	type Src = { relativePath: string; content: string; sizeBytes: number; wasRedacted: boolean; alwaysApply?: boolean; triggers?: string[]; globs?: string[] };
	// Activation mode badge (surfaces the R.7/R.2/R.3 engine): how a rule decides to apply.
	const ruleMode = (r: Src): string => {
		if (r.alwaysApply === true) { return safetyS.rulesModeAlways; }
		if (r.triggers && r.triggers.length > 0) { return safetyS.rulesModeTrigger; }
		if (r.globs && r.globs.length > 0) { return safetyS.rulesModeGlob; }
		if (r.alwaysApply === false) { return safetyS.rulesModeAgent; }
		return safetyS.rulesModeAlways;
	};
	const [rows, setRows] = useState<Src[]>([]);
	const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
	const [expanded, setExpanded] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			await rulesSvc.reloadRules(); // await so the list reflects the freshly-scanned sources
			const sources = rulesSvc.getLoadedSources() as Src[];
			setRows(sources);
			const m: Record<string, boolean> = {};
			for (const s of sources) { m[s.relativePath] = rulesSvc.isRuleEnabled(s.relativePath); }
			setEnabledMap(m);
		} catch {
			setRows([]);
		}
	}, [rulesSvc]);

	useEffect(() => { void refresh(); }, [refresh]);

	const toggle = (path: string) => {
		const next = !(enabledMap[path] ?? true);
		try { rulesSvc.setRuleEnabled(path, next); } catch { /* tolerated */ }
		setEnabledMap(prev => ({ ...prev, [path]: next }));
	};

	const empty = rows.length === 0;
	const totalKb = Math.round(rows.reduce((a, r) => a + r.sizeBytes, 0) / 1024);
	const disabledCount = rows.filter(r => !(enabledMap[r.relativePath] ?? true)).length;
	return (
		<div className='max-w-[800px]'>
			<h2 className='text-xl mb-2'>{safetyS.rulesPanelTitle}</h2>
			<h4 className='text-vibe-fg-3 mb-4'>{safetyS.rulesPanelIntro}</h4>
			<div className='flex gap-2 mb-2 items-center'>
				<VibeButtonBgDarken className='px-4 py-1 max-w-fit' onClick={refresh}>
					{safetyS.rulesPanelReload}
				</VibeButtonBgDarken>
				{!empty && <span className='text-vibe-fg-3 text-xs'>{safetyS.rulesPanelSummary(rows.length, totalKb, disabledCount)}</span>}
			</div>
			{empty ? (
				<div className='text-vibe-fg-3 text-sm'>{safetyS.rulesPanelEmpty}</div>
			) : (
				<table className='text-vibe-fg-1 text-sm w-full border-collapse'>
					<thead>
						<tr className='text-left text-vibe-fg-3'>
							<th className='px-2 py-1'>{safetyS.rulesPanelColEnabled}</th>
							<th className='px-2 py-1'>{safetyS.rulesPanelColSource}</th>
							<th className='px-2 py-1'>{safetyS.rulesPanelColSize}</th>
						</tr>
					</thead>
					<tbody>
						{rows.flatMap(r => {
							const on = enabledMap[r.relativePath] ?? true;
							const isOpen = expanded === r.relativePath;
							const trs = [
								<tr key={r.relativePath}>
									<td className='px-2 py-1 align-top'>
										<button
											type='button'
											className={`px-2 py-0.5 rounded-sm ${on ? 'bg-vibe-bg-3 hover:bg-vibe-bg-4' : 'bg-vibe-bg-2 text-vibe-fg-3 hover:bg-vibe-bg-3'}`}
											onClick={() => toggle(r.relativePath)}
										>
											{on ? safetyS.rulesPanelOn : safetyS.rulesPanelOff}
										</button>
									</td>
									<td
										className='px-2 py-1 align-top break-all cursor-pointer text-vibe-fg-1 hover:underline'
										onClick={() => setExpanded(isOpen ? null : r.relativePath)}
									>
										{r.relativePath}
										<span className='ml-2 text-vibe-fg-4 text-xs'>· {ruleMode(r)}</span>
										{r.wasRedacted ? ` ${safetyS.rulesPanelRedacted}` : ''}
									</td>
									<td className='px-2 py-1 align-top whitespace-nowrap text-vibe-fg-3'>{r.sizeBytes} B</td>
								</tr>,
							];
							if (isOpen) {
								trs.push(
									<tr key={`${r.relativePath}::preview`}>
										<td colSpan={3} className='px-2 pb-2 align-top'>
											<pre className='text-xs text-vibe-fg-2 whitespace-pre-wrap break-all bg-vibe-bg-2 p-2 rounded-sm max-h-[300px] overflow-auto'>{r.content}</pre>
										</td>
									</tr>
								);
							}
							return trs;
						})}
					</tbody>
				</table>
			)}
			<div className='text-vibe-fg-3 text-xs mt-2'>{safetyS.rulesPanelDocsLink}</div>
		</div>
	);
};

const SessionMemoryPanel = () => {
	const accessor = useAccessor();
	const sessionMemory = accessor.get('IVibeSessionMemoryService');
	const chatThreadService = accessor.get('IChatThreadService');
	const notificationService = accessor.get('INotificationService');

	type Entry = { id: string; kind: string; content: string; updatedAt: number };
	const [rows, setRows] = useState<Entry[]>([]);
	const [empty, setEmpty] = useState<boolean>(true);

	const refresh = useCallback(() => {
		try {
			const thread = chatThreadService.getCurrentThread();
			const threadId = thread?.id;
			if (!threadId) { setRows([]); setEmpty(true); return; }
			const entries = sessionMemory.getRecent(threadId, 100);
			setRows(entries.map(e => ({ id: e.id, kind: e.kind, content: e.content, updatedAt: e.updatedAt ?? e.createdAt ?? Date.now() })));
			setEmpty(entries.length === 0);
		} catch {
			setRows([]); setEmpty(true);
		}
	}, [sessionMemory, chatThreadService]);

	useEffect(() => { refresh(); }, [refresh]);

	const formatAge = (updatedAt: number): string => {
		const dt = Math.max(0, Date.now() - updatedAt);
		const m = Math.floor(dt / 60000);
		if (m < 1) {return safetyS.ageLessThanMin;}
		if (m < 60) {return safetyS.ageMinutes(m);}
		const h = Math.floor(m / 60);
		if (h < 24) {return safetyS.ageHours(h);}
		const d = Math.floor(h / 24);
		return safetyS.ageDays(d);
	};

	return (
		<div className='max-w-[800px]'>
			<h2 className='text-xl mb-2'>{safetyS.memoryPanelTitle}</h2>
			<h4 className='text-vibe-fg-3 mb-4'>{safetyS.memoryPanelIntro}</h4>
			<div className='flex gap-2 mb-2'>
				<VibeButtonBgDarken className='px-4 py-1 max-w-fit' onClick={refresh}>
					{safetyS.memoryPanelReload}
				</VibeButtonBgDarken>
				<VibeButtonBgDarken
					className='px-4 py-1 max-w-fit'
					onClick={() => {
						notificationService.notify({
							severity: Severity.Info,
							message: safetyS.memoryPanelClearConfirm,
						});
					}}
				>
					{safetyS.memoryPanelClear}
				</VibeButtonBgDarken>
			</div>
			<div className='text-vibe-fg-3 text-xs mb-2'>{safetyS.memoryPanelDocsLink}</div>
			{empty ? (
				<div className='text-vibe-fg-3 text-sm'>{safetyS.memoryPanelEmpty}</div>
			) : (
				<table className='text-vibe-fg-1 text-sm w-full border-collapse'>
					<thead>
						<tr className='text-left text-vibe-fg-3'>
							<th className='px-2 py-1'>{safetyS.memoryPanelColKind}</th>
							<th className='px-2 py-1'>{safetyS.memoryPanelColAge}</th>
							<th className='px-2 py-1'>{safetyS.memoryPanelColPreview}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(r => (
							<tr key={r.id}>
								<td className='px-2 py-1 align-top'>{r.kind}</td>
								<td className='px-2 py-1 align-top whitespace-nowrap'>{formatAge(r.updatedAt)}</td>
								<td className='px-2 py-1 align-top break-all'>{r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
};

// O.10 — Auto-detected tool-call overrides diagnostics panel.
// Lists models that the runtime auto-downgrade pipeline (chatThreadService
// agent loop, roadmap O.1–O.7) has flipped to XML-fallback mode after
// detecting repeated tool-call quirks. User actions:
//   - Revert: clears the override entirely (next call retries native FC).
//   - Pin:    strips `_autoDetected`/`_detectedAt` metadata, converting
//             to a manual override (immune to TTL, never auto-expires).
const AutoDowngradeOverridesPanel = () => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const notificationService = accessor.get('INotificationService');
	const settingsState = useSettingsState();

	// AUTO_DOWNGRADE_TTL_MS lives in modelCapabilities; duplicate the constant
	// here (synchronisation risk is low — it changes ~never).
	const AUTO_DOWNGRADE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

	type Row = {
		providerName: ProviderName;
		modelName: string;
		reason: 'numeric-tool-name' | 'missing-required-field' | 'wrong-tool-name' | 'other';
		detectedAt: number;
	};

	const rows: Row[] = [];
	const overrides = settingsState.overridesOfModel;
	if (overrides) {
		for (const providerName of Object.keys(overrides) as (keyof typeof overrides)[]) {
			const byModel = overrides[providerName];
			if (!byModel) {continue;}
			for (const modelName of Object.keys(byModel)) {
				const o = byModel[modelName] as { _autoDetected?: boolean; _detectedAt?: number; _reason?: Row['reason'] } | undefined;
				if (!o || !o._autoDetected) {continue;}
				rows.push({
					providerName,
					modelName,
					reason: o._reason ?? 'other',
					detectedAt: typeof o._detectedAt === 'number' ? o._detectedAt : 0,
				});
			}
		}
	}
	rows.sort((a, b) => b.detectedAt - a.detectedAt);

	const reasonText = (r: Row['reason']): string => {
		switch (r) {
			case 'numeric-tool-name': return safetyS.autoDowngradeReasonNumeric;
			case 'missing-required-field': return safetyS.autoDowngradeReasonMissingField;
			case 'wrong-tool-name': return safetyS.autoDowngradeReasonWrongName;
			case 'other': return safetyS.autoDowngradeReasonOther;
		}
	};

	const formatAge = (ts: number): string => {
		if (!ts) {return '—';}
		const ageMs = Date.now() - ts;
		const mins = Math.floor(ageMs / 60_000);
		if (mins < 1) {return safetyS.ageLessThanMin;}
		if (mins < 60) {return safetyS.ageMinutes(mins);}
		const hours = Math.floor(mins / 60);
		if (hours < 24) {return safetyS.ageHours(hours);}
		return safetyS.ageDays(Math.floor(hours / 24));
	};
	const formatTTL = (ts: number): string => {
		if (!ts) {return '—';}
		const remainingMs = ts + AUTO_DOWNGRADE_TTL_MS - Date.now();
		if (remainingMs <= 0) {return safetyS.autoDowngradeTTLExpired;}
		const mins = Math.floor(remainingMs / 60_000);
		if (mins < 60) {return safetyS.ageMinutes(mins);}
		const hours = Math.floor(mins / 60);
		if (hours < 24) {return safetyS.ageHours(hours);}
		return safetyS.ageDays(Math.floor(hours / 24));
	};

	const onRevert = useCallback(async (providerName: ProviderName, modelName: string) => {
		try {
			await vibeideSettingsService.setOverridesOfModel(providerName, modelName, undefined);
		} catch (e: any) {
			notificationService.notify({ severity: Severity.Error, message: `Revert failed: ${e?.message ?? e}` });
		}
	}, [vibeideSettingsService, notificationService]);

	const onPin = useCallback(async (providerName: ProviderName, modelName: string) => {
		try {
			// Pin: keep specialToolFormat=undefined but strip metadata so TTL doesn't apply.
			// setOverridesOfModel merges shallow — we need to clear first then write fresh.
			await vibeideSettingsService.setOverridesOfModel(providerName, modelName, undefined);
			await vibeideSettingsService.setOverridesOfModel(providerName, modelName, { specialToolFormat: undefined });
		} catch (e: any) {
			notificationService.notify({ severity: Severity.Error, message: `Pin failed: ${e?.message ?? e}` });
		}
	}, [vibeideSettingsService, notificationService]);

	return (
		<div className='max-w-[900px]'>
			<h2 className='text-xl mb-2'>{safetyS.autoDowngradeTitle}</h2>
			<h4 className='text-vibe-fg-3 mb-4'>{safetyS.autoDowngradeIntro}</h4>
			{rows.length === 0 ? (
				<div className='text-vibe-fg-3 text-sm'>{safetyS.autoDowngradeEmpty}</div>
			) : (
				<table className='text-vibe-fg-1 text-sm w-full border-collapse'>
					<thead>
						<tr className='text-left text-vibe-fg-3'>
							<th className='px-2 py-1'>{safetyS.autoDowngradeColProvider}</th>
							<th className='px-2 py-1'>{safetyS.autoDowngradeColModel}</th>
							<th className='px-2 py-1'>{safetyS.autoDowngradeColReason}</th>
							<th className='px-2 py-1'>{safetyS.autoDowngradeColAge}</th>
							<th className='px-2 py-1'>{safetyS.autoDowngradeColTTL}</th>
							<th className='px-2 py-1'>{safetyS.autoDowngradeColActions}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(r => (
							<tr key={`${r.providerName}:${r.modelName}`}>
								<td className='px-2 py-1 align-top'>{displayInfoOfProviderName(r.providerName).title}</td>
								<td className='px-2 py-1 align-top break-all'>{r.modelName}</td>
								<td className='px-2 py-1 align-top'>{reasonText(r.reason)}</td>
								<td className='px-2 py-1 align-top whitespace-nowrap'>{formatAge(r.detectedAt)}</td>
								<td className='px-2 py-1 align-top whitespace-nowrap'>{formatTTL(r.detectedAt)}</td>
								<td className='px-2 py-1 align-top'>
									<div className='flex gap-2'>
										<VibeButtonBgDarken
											className='px-2 py-0.5 text-xs'
											onClick={() => { void onRevert(r.providerName, r.modelName); }}
											title={safetyS.autoDowngradeRevertHint}
										>
											{safetyS.autoDowngradeRevert}
										</VibeButtonBgDarken>
										<VibeButtonBgDarken
											className='px-2 py-0.5 text-xs'
											onClick={() => { void onPin(r.providerName, r.modelName); }}
											title={safetyS.autoDowngradePinHint}
										>
											{safetyS.autoDowngradePin}
										</VibeButtonBgDarken>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
};

const SafetyPanel = () => {
	const accessor = useAccessor();
	const configService = accessor.get('IConfigurationService');
	const commandService = accessor.get('ICommandService');
	const notificationService = accessor.get('INotificationService');

	const [mode, setMode] = useState<AutostashMode>(() => {
		const raw = configService.getValue<AutostashMode>(AUTOSTASH_KEY);
		return AUTOSTASH_MODES.includes(raw as AutostashMode) ? (raw as AutostashMode) : 'dirty-only';
	});

	useEffect(() => {
		const d = configService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(AUTOSTASH_KEY)) {return;}
			const raw = configService.getValue<AutostashMode>(AUTOSTASH_KEY);
			if (AUTOSTASH_MODES.includes(raw as AutostashMode)) {
				setMode(raw as AutostashMode);
			}
		});
		return () => d.dispose();
	}, [configService]);

	const onPick = useCallback(async (next: AutostashMode) => {
		try {
			await configService.updateValue(AUTOSTASH_KEY, next);
		} catch (e: any) {
			notificationService.notify({ severity: Severity.Error, message: `Auto-stash mode update failed: ${e?.message ?? e}` });
		}
	}, [configService, notificationService]);

	const radio = (val: AutostashMode, label: string, hint: string) => (
		<label className='flex items-start gap-x-3 my-2 cursor-pointer select-none'>
			<input
				type='radio'
				name='vibe-autostash-mode'
				checked={mode === val}
				onChange={() => onPick(val)}
				className='mt-1'
			/>
			<span className='flex flex-col'>
				<span className='text-vibe-fg-1 text-sm'>{label}</span>
				<span className='text-vibe-fg-3 text-xs'>{hint}</span>
			</span>
		</label>
	);

	return (
		<div className='flex flex-col gap-12'>
			<div>
				<h2 className='text-3xl mb-2'>{safetyS.sectionTitle}</h2>
				<h4 className='text-vibe-fg-3 mb-4'>{safetyS.sectionDesc}</h4>
			</div>

			<div className='max-w-[600px]'>
				<h2 className='text-xl mb-2'>{safetyS.autostashTitle}</h2>
				<h4 className='text-vibe-fg-3 mb-4'>{safetyS.autostashDesc}</h4>
				<ErrorBoundary>
					{radio('always', safetyS.autostashAlways, safetyS.autostashAlwaysHint)}
					{radio('dirty-only', safetyS.autostashDirtyOnly, safetyS.autostashDirtyOnlyHint)}
					{radio('never', safetyS.autostashNever, safetyS.autostashNeverHint)}
				</ErrorBoundary>
			</div>

			<div className='max-w-[600px]'>
				<h2 className='text-xl mb-2'>{safetyS.modelRoutingTitle}</h2>
				<h4 className='text-vibe-fg-3 mb-4'>{safetyS.modelRoutingDesc}</h4>
				<VibeButtonBgDarken
					className='px-4 py-1 max-w-fit'
					onClick={() => { commandService.executeCommand('workbench.action.files.openFileFolder'); }}
				>
					{safetyS.modelRoutingEditFile}
				</VibeButtonBgDarken>
			</div>

			<ErrorBoundary>
				<PerfGuardrailsPanel />
			</ErrorBoundary>

			<ErrorBoundary>
				<SessionMemoryPanel />
			</ErrorBoundary>

			<ErrorBoundary>
				<ProjectRulesPanel />
			</ErrorBoundary>

			<ErrorBoundary>
				<AutoDowngradeOverridesPanel />
			</ErrorBoundary>
		</div>
	);
};

// Notification-sound picker (phone-like): pick + click-preview a default, browse a custom file with
// pick-time validation, set volume, toggle per-event triggers. Reads/writes `vibeide.notify.sound.*`.
const NOTIFY_KEY = 'vibeide.notify.sound';
type NotifySoundState = {
	enabled: boolean; sound: string; customPath: string; volume: number;
	muteWhenFocused: boolean; onComplete: boolean; onStalled: boolean; onAwaitingUser: boolean;
};

const NotificationSoundPanel = () => {
	const accessor = useAccessor();
	const configService = accessor.get('IConfigurationService');
	const notifySoundService = accessor.get('IVibeNotifySoundService');
	const fileDialogService = accessor.get('IFileDialogService');
	const notificationService = accessor.get('INotificationService');

	const read = useCallback((): NotifySoundState => {
		const rawVol = configService.getValue<number>(`${NOTIFY_KEY}.volume`);
		const volume = typeof rawVol === 'number' && isFinite(rawVol) ? Math.min(1, Math.max(0, rawVol)) : 0.6;
		// All booleans default ON — only an explicit `false` disables (matches the config defaults).
		return {
			enabled: configService.getValue<boolean>(`${NOTIFY_KEY}.enabled`) !== false,
			sound: configService.getValue<string>(`${NOTIFY_KEY}.sound`) ?? 'taskCompleted',
			customPath: configService.getValue<string>(`${NOTIFY_KEY}.customPath`) ?? '',
			volume,
			muteWhenFocused: configService.getValue<boolean>(`${NOTIFY_KEY}.muteWhenFocused`) !== false,
			onComplete: configService.getValue<boolean>(`${NOTIFY_KEY}.onComplete`) !== false,
			onStalled: configService.getValue<boolean>(`${NOTIFY_KEY}.onStalled`) !== false,
			onAwaitingUser: configService.getValue<boolean>(`${NOTIFY_KEY}.onAwaitingUser`) !== false,
		};
	}, [configService]);

	const [st, setSt] = useState<NotifySoundState>(read);

	useEffect(() => {
		const d = configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(NOTIFY_KEY)) { setSt(read()); }
		});
		return () => d.dispose();
	}, [configService, read]);

	const set = useCallback(async (subKey: string, value: unknown) => {
		try {
			await configService.updateValue(`${NOTIFY_KEY}.${subKey}`, value);
		} catch (e: any) {
			notificationService.notify({ severity: Severity.Error, message: `${notifyS.sectionTitle}: ${e?.message ?? e}` });
		}
	}, [configService, notificationService]);

	const pickDefault = (id: string) => { void set('sound', id); notifySoundService.preview(id); };

	const browseCustom = useCallback(async () => {
		const picked = await fileDialogService.showOpenDialog({
			title: notifyS.browseDialogTitle,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: 'Аудио', extensions: ['mp3', 'ogg', 'wav'] }],
		});
		const uri = picked?.[0];
		if (!uri) { return; }
		const path = uri.fsPath;
		const result = await notifySoundService.validateCustomFile(path);
		if (!result.ok) {
			notificationService.notify({ severity: Severity.Warning, message: notifyS.customRejected(result.reason ?? '') });
			return;
		}
		await set('customPath', path);
		await set('sound', 'custom');
		notifySoundService.preview(undefined, path);
		notificationService.info(notifyS.customAccepted);
	}, [fileDialogService, notifySoundService, notificationService, set]);

	const soundRow = (id: string, label: string, selected: boolean, onSelect: () => void, onPreview: () => void, extra?: React.ReactNode) => (
		<div
			key={id}
			className={`flex items-center justify-between gap-3 px-3 py-2 rounded-md cursor-pointer select-none border ${selected ? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-list-hoverBackground)]' : 'border-transparent hover:bg-[var(--vscode-list-hoverBackground)]'}`}
			onClick={onSelect}
		>
			<div className='flex items-center gap-2 min-w-0'>
				<span className={`shrink-0 size-3 rounded-full border ${selected ? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-focusBorder)]' : 'border-vibe-fg-3'}`} />
				<span className='text-sm text-vibe-fg-1 truncate'>{label}</span>
				{extra}
			</div>
			<button
				type='button'
				className='shrink-0 p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] text-vibe-fg-2'
				onClick={(e) => { e.stopPropagation(); onPreview(); }}
				data-tooltip-id='vibe-tooltip'
				data-tooltip-place='left'
				data-tooltip-content={notifyS.previewTooltip}
				aria-label={notifyS.previewTooltip}
			>
				<Play size={14} />
			</button>
		</div>
	);

	const eventCheckbox = (subKey: 'onComplete' | 'onStalled' | 'onAwaitingUser', label: string) => (
		<label className='flex items-center gap-2 cursor-pointer select-none'>
			<input type='checkbox' checked={st[subKey]} onChange={(e) => set(subKey, e.target.checked)} />
			<span className='text-sm text-vibe-fg-2'>{label}</span>
		</label>
	);

	return (
		<div className='max-w-[600px]'>
			<h2 className='text-3xl mb-2'>{notifyS.sectionTitle}</h2>
			<h4 className='text-vibe-fg-3 mb-4'>{notifyS.sectionDesc}</h4>

			<div className='flex items-center gap-x-2 mb-4'>
				<VibeSwitch size='xs' value={st.enabled} onChange={(v) => set('enabled', v)} />
				<span className='text-vibe-fg-2 text-sm pointer-events-none'>{notifyS.enabledLabel}</span>
			</div>

			<div className={`flex flex-col gap-6 ${st.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
				{/* Sound picker */}
				<div>
					<h3 className='text-base font-medium text-vibe-fg-1 mb-1'>{notifyS.soundTitle}</h3>
					<p className='text-xs text-vibe-fg-3 mb-2'>{notifyS.soundHint}</p>
					<div className='flex flex-col gap-1'>
						{NOTIFY_DEFAULT_SOUND_IDS.map(id =>
							soundRow(id, notifyS.soundNames[id] ?? id, st.sound === id, () => pickDefault(id), () => notifySoundService.preview(id))
						)}
						{soundRow(
							'custom',
							notifyS.customLabel,
							st.sound === 'custom',
							() => { if (st.customPath) { void set('sound', 'custom'); notifySoundService.preview('custom'); } else { void browseCustom(); } },
							() => notifySoundService.preview('custom'),
							<span className='text-xs text-vibe-fg-4 truncate max-w-[220px]'>{st.customPath || notifyS.customNotSet}</span>
						)}
					</div>
					<div className='flex items-center gap-3 mt-2'>
						<VibeButtonBgDarken className='px-3 py-1 text-xs' onClick={() => void browseCustom()}>
							{notifyS.browseBtn}
						</VibeButtonBgDarken>
						<span className='text-xs text-vibe-fg-3'>{notifyS.customRules}</span>
					</div>
				</div>

				{/* Volume */}
				<div>
					<h3 className='text-base font-medium text-vibe-fg-1 mb-2'>{notifyS.volumeTitle}</h3>
					<div className='flex items-center gap-3'>
						<input
							type='range'
							min={0}
							max={1}
							step={0.05}
							value={st.volume}
							onChange={(e) => set('volume', Number(e.target.value))}
							className='w-48'
						/>
						<span className='text-xs text-vibe-fg-3 w-10 text-right tabular-nums'>{Math.round(st.volume * 100)}%</span>
					</div>
				</div>

				{/* Mute when focused */}
				<div className='flex items-center gap-x-2'>
					<VibeSwitch size='xs' value={st.muteWhenFocused} onChange={(v) => set('muteWhenFocused', v)} />
					<span className='text-vibe-fg-2 text-sm pointer-events-none'>{notifyS.muteWhenFocusedLabel}</span>
				</div>

				{/* Events */}
				<div>
					<h3 className='text-base font-medium text-vibe-fg-1 mb-2'>{notifyS.eventsTitle}</h3>
					<div className='flex flex-col gap-2'>
						{eventCheckbox('onComplete', notifyS.onCompleteLabel)}
						{eventCheckbox('onStalled', notifyS.onStalledLabel)}
						{eventCheckbox('onAwaitingUser', notifyS.onAwaitingUserLabel)}
					</div>
				</div>
			</div>
		</div>
	);
};

export const Settings = () => {
	const isDark = useIsDark();
	// --- sidebar nav ---
	const [selectedSection, setSelectedSection] =
		useState<Tab>('workspace');

	const navItems: { tab: Tab; label: string }[] = [
		{ tab: 'workspace', label: nav.workspace },
		{ tab: 'models', label: nav.models },
		{ tab: 'localProviders', label: nav.localProviders },
		{ tab: 'providers', label: nav.providers },
		{ tab: 'featureOptions', label: nav.featureOptions },
		{ tab: 'general', label: nav.general },
		{ tab: 'notifications', label: nav.notifications },
		{ tab: 'safety', label: nav.safety },
		{ tab: 'mcp', label: nav.mcp },
		{ tab: 'all', label: nav.all },
	];
	const shouldShowTab = (tab: Tab) => selectedSection === 'all' || selectedSection === tab;
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const environmentService = accessor.get('IEnvironmentService');
	const nativeHostService = accessor.get('INativeHostService');
	const settingsState = useSettingsState();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const chatThreadsService = accessor.get('IChatThreadService');
	const notificationService = accessor.get('INotificationService');
	const mcpService = accessor.get('IMCPService');
	const storageService = accessor.get('IStorageService');
	const metricsService = accessor.get('IMetricsService');
	const isOptedOut = useIsOptedOut();

	const [allSettingsExpanded, setAllSettingsExpanded] = useState<Partial<Record<AllSettingsGroupKey, boolean>>>({});
	const toggleAllSettingsGroup = (key: AllSettingsGroupKey) => {
		setAllSettingsExpanded(p => ({ ...p, [key]: !p[key] }));
	};

	const onDownload = (t: 'Chats' | 'Settings') => {
		let dataStr: string;
		let downloadName: string;
		if (t === 'Chats') {
			// Export chat threads
			dataStr = JSON.stringify(chatThreadsService.state, null, 2);
			downloadName = 'vibe-chats.json';
		}
		else if (t === 'Settings') {
			// Export user settings
			dataStr = JSON.stringify(vibeideSettingsService.state, null, 2);
			downloadName = 'vibe-settings.json';
		}
		else {
			dataStr = '';
			downloadName = '';
		}

		const blob = new Blob([dataStr], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = downloadName;
		a.click();
		URL.revokeObjectURL(url);
	};


	// Add file input refs
	const fileInputSettingsRef = useRef<HTMLInputElement>(null);
	const fileInputChatsRef = useRef<HTMLInputElement>(null);

	const [s, ss] = useState(0);

	const handleUpload = (t: 'Chats' | 'Settings') => (e: React.ChangeEvent<HTMLInputElement>,) => {
		const files = e.target.files;
		if (!files) {return;}
		const file = files[0];
		if (!file) {return;}

		const reader = new FileReader();
		reader.onload = () => {
			try {
				const json = JSON.parse(reader.result as string);

				if (t === 'Chats') {
					chatThreadsService.dangerousSetState(json as Parameters<typeof chatThreadsService.dangerousSetState>[0]);
				}
				else if (t === 'Settings') {
					vibeideSettingsService.dangerousSetState(json as Parameters<typeof vibeideSettingsService.dangerousSetState>[0]);
				}

				notificationService.info(miscS.importedOk(t === 'Chats' ? miscS.chats : miscS.settings));
			} catch (err) {
				notificationService.notify({ message: miscS.importFail(t === 'Chats' ? miscS.chats : miscS.settings), source: err + '', severity: Severity.Error, });
			}
		};
		reader.readAsText(file);
		e.target.value = '';

		ss(s => s + 1);
	};

	const renderGeneralInner = () => (
		<>
								{/* One-Click Switch section */}
								<div>
									<ErrorBoundary>
										<h2 className='text-3xl mb-2'>{miscS.oneClickTitle}</h2>
						<h4 className='text-vibe-fg-3 mb-4'>{miscS.transferEditorIn}</h4>

										<div className='flex flex-col gap-2'>
											<OneClickSwitchButton className='w-48' fromEditor="VS Code" />
											<OneClickSwitchButton className='w-48' fromEditor="Cursor" />
											<OneClickSwitchButton className='w-48' fromEditor="Windsurf" />
										</div>
									</ErrorBoundary>
								</div>

								{/* Import/Export section */}
								<div>
									<h2 className='text-3xl mb-2'>{miscS.importExportTitle}</h2>
							<h4 className='text-vibe-fg-3 mb-4'>{miscS.transferVibe}</h4>
									<div className='flex flex-col gap-8'>
										{/* Settings Subcategory */}
										<div className='flex flex-col gap-2 max-w-48 w-full'>
											<input key={2 * s} ref={fileInputSettingsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Settings')} />
											<VibeButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputSettingsRef.current?.click(); }}>
												{miscS.importSettings}
											</VibeButtonBgDarken>
											<VibeButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Settings')}>
												{miscS.exportSettings}
											</VibeButtonBgDarken>
											<ConfirmButton className='px-4 py-1 w-full' onConfirm={() => { vibeideSettingsService.resetState(); }}>
												{miscS.resetSettings}
											</ConfirmButton>
										</div>

										{/* Chats Subcategory */}
										<div className='flex flex-col gap-2 max-w-48 w-full'>
											<input key={2 * s + 1} ref={fileInputChatsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Chats')} />
											<VibeButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputChatsRef.current?.click(); }}>
												{miscS.importChats}
											</VibeButtonBgDarken>
											<VibeButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Chats')}>
												{miscS.exportChats}
											</VibeButtonBgDarken>
											<ConfirmButton className='px-4 py-1 w-full' onConfirm={() => { chatThreadsService.resetState(); }}>
												{miscS.resetChats}
											</ConfirmButton>
										</div>
									</div>
								</div>



								{/* Built-in Settings section */}
								<div>
									<h2 className={`text-3xl mb-2`}>{miscS.builtinTitle}</h2>
									<h4 className={`text-vibe-fg-3 mb-4`}>{miscS.builtinDesc}</h4>

									<ErrorBoundary>
										<div className='flex flex-col gap-2 justify-center max-w-48 w-full'>
											<VibeButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openSettings'); }}>
												{miscS.generalSettings}
											</VibeButtonBgDarken>
											<VibeButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openGlobalKeybindings'); }}>
												{miscS.keyboardSettings}
											</VibeButtonBgDarken>
											<VibeButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.selectTheme'); }}>
												{miscS.themeSettings}
											</VibeButtonBgDarken>
											<VibeButtonBgDarken className='px-4 py-1' onClick={() => { nativeHostService.showItemInFolder(environmentService.logsHome.fsPath); }}>
												{miscS.openLogs}
											</VibeButtonBgDarken>
										</div>
									</ErrorBoundary>
								</div>


								{/* Metrics section */}
								<div className='max-w-[600px]'>
									<h2 className={`text-3xl mb-2`}>{miscS.metricsTitle}</h2>
							<h4 className={`text-vibe-fg-3 mb-4`}>{miscS.metricsDesc}</h4>

									<div className='my-2'>
										{/* Disable All Metrics Switch */}
										<ErrorBoundary>
											<div className='flex items-center gap-x-2 my-2'>
												<VibeSwitch
													size='xs'
													value={isOptedOut}
													onChange={(newVal) => {
														storageService.store(OPT_OUT_KEY, newVal, StorageScope.APPLICATION, StorageTarget.MACHINE);
														metricsService.capture(`Set metrics opt-out to ${newVal}`, {}); // this only fires if it's enabled, so it's fine to have here
													}}
												/>
												<span className='text-vibe-fg-3 text-xs pointer-events-none'>{miscS.metricsOptOut}</span>
											</div>
										</ErrorBoundary>
									</div>
								</div>

								{/* AI Instructions section */}
								<div className='max-w-[600px]'>
									<h2 className={`text-3xl mb-2`}>{miscS.aiInstrTitle}</h2>
									<h4 className={`text-vibe-fg-3 mb-4`}>
										<ChatMarkdownRender inPTag={true} string={miscS.aiInstrMd.trim()} chatMessageLocation={undefined} />
									</h4>
									<ErrorBoundary>
										<AIInstructionsBox />
									</ErrorBoundary>
									{/* --- Disable System Message Toggle --- */}
									<div className='my-4'>
										<ErrorBoundary>
											<div className='flex items-center gap-x-2'>
												<VibeSwitch
													size='xs'
													value={!!settingsState.globalSettings.disableSystemMessage}
													onChange={(newValue) => {
														vibeideSettingsService.setGlobalSetting('disableSystemMessage', newValue);
													}}
												/>
												<span className='text-vibe-fg-3 text-xs pointer-events-none'>
													{miscS.disableSysMsg}
												</span>
											</div>
										</ErrorBoundary>
										<div className='text-vibe-fg-3 text-xs mt-1'>
								{miscS.disableSysMsgHint}
										</div>
									</div>
								</div>
		</>
	);


	return (
		<div
			className={`@@vibe-scope @@vibe-settings-scroll-root ${isDark ? 'dark' : ''}`}
			style={{
				height: '100%',
				width: '100%',
				overflow: 'auto',
				backgroundColor: 'var(--vscode-editor-background)',
			}}
		>
			<div className="flex flex-col md:flex-row w-full gap-6 max-w-[900px] mx-auto mb-32" style={{ minHeight: '80vh' }}>
				{/* --- SIDEBAR --- */}

				<aside className="md:w-1/4 w-full p-6 shrink-0">
					{/* vertical tab list */}
					<div className="flex flex-col gap-2 mt-12">
						{navItems.map(({ tab, label }) => (
							<button
								key={tab}
								type="button"
								onClick={() => {
									if (tab === 'all') {
										setSelectedSection('all');
										window.scrollTo({ top: 0, behavior: 'smooth' });
									} else {
										setSelectedSection(tab);
									}
								}}
								className={`@@vibe-pill-button @@vibe-focus-ring w-full text-left ${selectedSection === tab ? '@@vibe-pill-button--active font-medium' : ''}`}
							>
								{label}
							</button>
						))}
					</div>
				</aside>

				{/* --- MAIN PANE --- */}
				<main className="flex-1 p-6 select-none">



					<div className='max-w-3xl'>

						<h1 className='text-2xl w-full'>{miscS.pageTitle}</h1>

						<div className='w-full h-[1px] my-2' />



						{/* All sections in flex container (tight stack on «All Settings») */}
						<div className='flex flex-col gap-1'>
							<div className={shouldShowTab('workspace') ? `` : 'hidden'}>
								<ErrorBoundary>
									{selectedSection === 'all' ? (
										<AllSettingsFold
											title={nav.workspace}
											open={!!allSettingsExpanded.workspace}
											onToggle={() => toggleAllSettingsGroup('workspace')}
										>
											<h3 className='text-vibe-fg-3 mb-6 text-base'>{miscS.workspaceIntro}</h3>
											<VibeWorkspaceFormsPanel />
										</AllSettingsFold>
									) : (
										<>
											<h2 className='text-3xl mb-2'>{nav.workspace}</h2>
											<h3 className='text-vibe-fg-3 mb-6 text-base'>{miscS.workspaceIntro}</h3>
											<VibeWorkspaceFormsPanel />
										</>
									)}
								</ErrorBoundary>
							</div>

							{/* Models */}
							<div className={shouldShowTab('models') ? `` : 'hidden'}>
								<ErrorBoundary>
									{selectedSection === 'all' ? (
										<AllSettingsFold
											title={nav.models}
											open={!!allSettingsExpanded.models}
											onToggle={() => toggleAllSettingsGroup('models')}
										>
											<div className='flex flex-col gap-2 mb-2'>
												<RedoOnboardingButton />
												<button
													type='button'
													className='@@vibe-pill-button @@vibe-focus-ring text-xs px-3 py-1.5 self-start'
													onClick={() => setSelectedSection('workspace')}
												>
													{miscS.projectAiBtn}
												</button>
											</div>
											<ModelDump />
											<div className='w-full h-[1px] my-4' />
											<AutoDetectLocalModelsToggle />
											<RefreshableModels />
										</AllSettingsFold>
									) : (
										<>
											<div className='flex flex-col gap-2 mb-2'>
												<RedoOnboardingButton />
												<button
													type='button'
													className='@@vibe-pill-button @@vibe-focus-ring text-xs px-3 py-1.5 self-start'
													onClick={() => setSelectedSection('workspace')}
												>
													{miscS.projectAiBtn}
												</button>
											</div>
											<h2 className={`text-3xl mb-2`}>{nav.models}</h2>
											<ModelDump />
											<div className='w-full h-[1px] my-4' />
											<AutoDetectLocalModelsToggle />
											<RefreshableModels />
										</>
									)}
								</ErrorBoundary>
							</div>

							{/* Local Providers section */}
							<div className={shouldShowTab('localProviders') ? `` : 'hidden'}>
								<ErrorBoundary>
									{selectedSection === 'all' ? (
										<AllSettingsFold
											title={nav.localProviders}
											open={!!allSettingsExpanded.localProviders}
											onToggle={() => toggleAllSettingsGroup('localProviders')}
										>
											<h3 className={`text-vibe-fg-3 mb-2`}>{miscS.localProvBlurb}</h3>
											<div className='opacity-80 mb-4'>
												<OllamaSetupInstructions sayWeAutoDetect={true} />
											</div>
											<VibeProviderSettings providerNames={localProviderNames} />
										</AllSettingsFold>
									) : (
										<>
											<h2 className={`text-3xl mb-2`}>{nav.localProviders}</h2>
											<h3 className={`text-vibe-fg-3 mb-2`}>{miscS.localProvBlurb}</h3>
											<div className='opacity-80 mb-4'>
												<OllamaSetupInstructions sayWeAutoDetect={true} />
											</div>
											<VibeProviderSettings providerNames={localProviderNames} />
										</>
									)}
								</ErrorBoundary>
							</div>

							{/* Main Providers section */}
							<div className={shouldShowTab('providers') ? `` : 'hidden'}>
								<ErrorBoundary>
									{selectedSection === 'all' ? (
										<AllSettingsFold
											title={nav.providers}
											open={!!allSettingsExpanded.providers}
											onToggle={() => toggleAllSettingsGroup('providers')}
										>
											<h3 className={`text-vibe-fg-3 mb-2`}>{miscS.mainProvBlurb}</h3>
											<DynamicProvidersSection />
											<BuiltinProvidersFold names={nonlocalProviderNames} />
											<div className='w-full h-[1px] my-4' />
											<RefreshableRemoteCatalogs />
										</AllSettingsFold>
									) : (
										<>
											<h2 className={`text-3xl mb-2`}>{nav.providers}</h2>
											<h3 className={`text-vibe-fg-3 mb-2`}>{miscS.mainProvBlurb}</h3>
											<DynamicProvidersSection />
											<BuiltinProvidersFold names={nonlocalProviderNames} />
											<div className='w-full h-[1px] my-4' />
											<RefreshableRemoteCatalogs />
										</>
									)}
								</ErrorBoundary>
							</div>

							{/* Feature Options section */}
							<div className={shouldShowTab('featureOptions') ? `` : 'hidden'}>
								<ErrorBoundary>
									{selectedSection === 'all' ? (
										<AllSettingsFold
											title={nav.featureOptions}
											open={!!allSettingsExpanded.featureOptions}
											onToggle={() => toggleAllSettingsGroup('featureOptions')}
										>
											<FeatureOptionsSettingsBody />
										</AllSettingsFold>
									) : (
										<>
											<h2 className={`text-3xl mb-2`}>{nav.featureOptions}</h2>
											<FeatureOptionsSettingsBody />
										</>
									)}
								</ErrorBoundary>
							</div>

							{/* General section */}
							<div className={shouldShowTab('general') ? `` : 'hidden'}>
								{selectedSection === 'all' ? (
									<AllSettingsFold
										title={nav.general}
										open={!!allSettingsExpanded.general}
										onToggle={() => toggleAllSettingsGroup('general')}
									>
										<div className='flex flex-col gap-12'>
											{renderGeneralInner()}
										</div>
									</AllSettingsFold>
								) : (
									<div className='flex flex-col gap-12'>
										{renderGeneralInner()}
									</div>
								)}
							</div>



							{/* Notifications section */}
								<div className={shouldShowTab('notifications') ? `` : 'hidden'}>
									<ErrorBoundary>
										{selectedSection === 'all' ? (
											<AllSettingsFold
												title={nav.notifications}
												open={!!allSettingsExpanded.notifications}
												onToggle={() => toggleAllSettingsGroup('notifications')}
											>
												<NotificationSoundPanel />
											</AllSettingsFold>
										) : (
											<NotificationSoundPanel />
										)}
									</ErrorBoundary>
								</div>

								{/* Safety & Diagnostics section */}
							<div className={shouldShowTab('safety') ? `` : 'hidden'}>
								<ErrorBoundary>
									{selectedSection === 'all' ? (
										<AllSettingsFold
											title={nav.safety}
											open={!!allSettingsExpanded.safety}
											onToggle={() => toggleAllSettingsGroup('safety')}
										>
											<SafetyPanel />
										</AllSettingsFold>
									) : (
										<SafetyPanel />
									)}
								</ErrorBoundary>
							</div>

							{/* MCP section */}
							<div className={shouldShowTab('mcp') ? `` : 'hidden'}>
								<ErrorBoundary>
									{selectedSection === 'all' ? (
										<AllSettingsFold
											title={nav.mcp}
											open={!!allSettingsExpanded.mcp}
											onToggle={() => toggleAllSettingsGroup('mcp')}
										>
											<h4 className={`text-vibe-fg-3 mb-4`}>
												<ChatMarkdownRender inPTag={true} string={miscS.mcpBlurb} chatMessageLocation={undefined} />
											</h4>
											<div className='my-2'>
												<VibeButtonBgDarken className='px-4 py-1 w-full max-w-48' onClick={async () => { await mcpService.revealMCPConfigFile(); }}>
													{miscS.addMcp}
												</VibeButtonBgDarken>
											</div>

											<ErrorBoundary>
												<MCPServersList />
											</ErrorBoundary>
										</AllSettingsFold>
									) : (
										<>
											<h2 className='text-3xl mb-2'>{nav.mcp}</h2>
											<h4 className={`text-vibe-fg-3 mb-4`}>
												<ChatMarkdownRender inPTag={true} string={miscS.mcpBlurb} chatMessageLocation={undefined} />
											</h4>
											<div className='my-2'>
												<VibeButtonBgDarken className='px-4 py-1 w-full max-w-48' onClick={async () => { await mcpService.revealMCPConfigFile(); }}>
													{miscS.addMcp}
												</VibeButtonBgDarken>
											</div>

											<ErrorBoundary>
												<MCPServersList />
											</ErrorBoundary>
										</>
									)}
								</ErrorBoundary>
							</div>




						</div>

					</div>
				</main>
			</div>
		</div>
	);
};
