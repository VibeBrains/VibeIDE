/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import { useEffect, useState, useMemo } from 'react';
import { useAccessor, useIsDark, useSettingsState } from '../util/services.js';
import { Brain, Check, ChevronRight, DollarSign, ExternalLink, Lock, X } from 'lucide-react';
import { displayInfoOfProviderName, ProviderName, providerNames, localProviderNames, featureNames, FeatureName, isFeatureNameDisabled } from '../../../../common/vibeideSettingsTypes.js';
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js';
import { OllamaSetupInstructions, OneClickSwitchButton, SettingsForProvider, ModelDump } from '../vibe-settings-tsx/Settings.js';
import { ColorScheme } from '../../../../../../../platform/theme/common/theme.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { FileAccess } from '../../../../../../../base/common/network.js';
import { onboardingS, tabNames, type TabName } from './vibeOnboardingRu.js';

const OVERRIDE_VALUE = false;

const getHeroLogoUri = () => FileAccess.asBrowserUri('vs/workbench/browser/media/vibeide-logo.png').toString(true);

const welcomeHighlights = onboardingS.welcomeHighlights;

const welcomeStats = onboardingS.welcomeStats;

export const VibeOnboarding = () => {

	const vibeSettingsState = useSettingsState();
	const isOnboardingComplete = vibeSettingsState.globalSettings.isOnboardingComplete || OVERRIDE_VALUE;

	const isDark = useIsDark();

	return (
		<div className={`@@vibe-scope ${isDark ? 'dark' : ''}`}>
			<div
				className={`
					@@vibe-onboarding-neon @@vibe-onboarding-backdrop
					fixed inset-0 z-[99999] flex items-start justify-center px-6 py-12
					backdrop-blur-[28px]
					overflow-y-auto
					transition-all duration-700 ease-in-out
					${isOnboardingComplete ? 'opacity-0 translate-y-4 pointer-events-none' : 'opacity-100 pointer-events-auto'}
				`}
			>
				<ErrorBoundary>
					<div className="w-full max-w-[1200px] py-6">
						<VibeOnboardingContent />
					</div>
				</ErrorBoundary>
			</div>
		</div>
	);
};

const VibeHeroIcon = () => {
	const heroLogoUri = useMemo(() => getHeroLogoUri(), []);
	return (
		<div className="w-full max-w-[220px] aspect-square rounded-2xl overflow-hidden @@vibe-onboarding-hero-logo">
			<img
				src={heroLogoUri}
				alt={onboardingS.heroLogoAlt}
				className="w-full h-full object-contain opacity-95"
				draggable={false}
				onError={(e) => {
					vibeLog.error('VibeOnboarding', 'Failed to load VibeIDE logo:', heroLogoUri);
					// Fallback: try direct path
					const fallbackUri = FileAccess.asBrowserUri('vs/workbench/browser/media/vibeide-logo.png').toString(true);
					if (fallbackUri !== heroLogoUri) {
						(e.target as HTMLImageElement).src = fallbackUri;
					}
				}}
			/>
		</div>
	);
};

const FADE_DURATION_MS = 2000;

const FadeIn = ({ children, className, delayMs = 0, durationMs, ...props }: { children: React.ReactNode; delayMs?: number; durationMs?: number; className?: string } & React.HTMLAttributes<HTMLDivElement>) => {

	const [opacity, setOpacity] = useState(0);

	const effectiveDurationMs = durationMs ?? FADE_DURATION_MS;

	useEffect(() => {

		const timeout = setTimeout(() => {
			setOpacity(1);
		}, delayMs);

		return () => clearTimeout(timeout);
	}, [setOpacity, delayMs]);


	return (
		<div className={className} style={{ opacity, transition: `opacity ${effectiveDurationMs}ms ease-in-out` }} {...props}>
			{children}
		</div>
	);
};

// Onboarding

// =============================================
//  New AddProvidersPage Component and helpers
// =============================================

const tabLabelRu: Record<TabName, string> = onboardingS.tabLabel;

// Data for cloud providers tab
const cloudProviders: ProviderName[] = ['googleVertex', 'liteLLM', 'microsoftAzure', 'awsBedrock', 'openAICompatible'];

// Data structures for provider tabs
const providerNamesOfTab: Record<TabName, ProviderName[]> = {
	// OpenCode Go (`openCodeGo`) is subscription-only — NOT free. It lands in Paid via the complement below.
	Free: ['openCodeZen', 'openRouter', 'gemini', 'pollinations'],
	Local: localProviderNames,
	Paid: providerNames.filter(pn => !(['openCodeZen', 'gemini', 'openRouter', 'pollinations', ...localProviderNames, ...cloudProviders] as string[]).includes(pn)) as ProviderName[],
	'Cloud/Other': cloudProviders,
};

const descriptionOfTab: Record<TabName, string> = onboardingS.tabDescription;


const featureNameMap: ReadonlyArray<{ display: string; featureName: FeatureName }> = onboardingS.featureLabel;

const AddProvidersPage = ({ pageIndex, setPageIndex }: { pageIndex: number; setPageIndex: (index: number) => void }) => {
	const [currentTab, setCurrentTab] = useState<TabName>('Free');
	const settingsState = useSettingsState();
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Clear error message after 5 seconds
	useEffect(() => {
		let timeoutId: NodeJS.Timeout | null = null;

		if (errorMessage) {
			timeoutId = setTimeout(() => {
				setErrorMessage(null);
			}, 5000);
		}

		// Cleanup function to clear the timeout if component unmounts or error changes
		return () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	}, [errorMessage]);

	return (
		<div className="flex flex-col gap-8 w-full min-h-[75vh] max-w-[1000px] mx-auto">
			<div className="space-y-2 text-center md:text-left">
				<p className="text-xs uppercase tracking-[0.35em] text-vibe-fg-4">{onboardingS.step2Label}</p>
				<h2 className="text-4xl font-light text-vibe-fg-0">{onboardingS.step2Title}</h2>
				<p className="text-base text-vibe-fg-3 max-w-2xl mx-auto md:mx-0">
					{onboardingS.step2Lead}
				</p>
			</div>

			<div className="flex flex-col md:flex-row flex-1 gap-6">
				{/* Left rail */}
				<div className="md:w-1/3 w-full flex flex-col gap-6 p-6 rounded-[28px] border border-vibe-border-3 bg-vibe-bg-2/70 shadow-[0_35px_90px_rgba(0,0,0,0.35)] h-full overflow-y-auto">
					<div className="flex flex-wrap md:flex-col gap-2">
						{[...tabNames, 'Cloud/Other'].map(tab => (
							<button
								type="button"
								key={tab}
								className={`
									@@vibe-pill-button @@vibe-focus-ring w-full text-left text-sm font-medium
									${currentTab === tab ? '@@vibe-pill-button--active' : ''}
								`}
								onClick={() => {
									setCurrentTab(tab as TabName);
									setErrorMessage(null);
								}}
							>
								{tabLabelRu[tab as TabName]}
							</button>
						))}
					</div>

					<div className="grid gap-3 mt-2 text-sm">
						<p className="uppercase text-[11px] tracking-[0.4em] text-vibe-fg-4">{onboardingS.featureCoverage}</p>
						{featureNameMap.map(({ display, featureName }) => {
							const hasModel = settingsState.modelSelectionOfFeature[featureName] !== null;
							return (
								<div key={featureName} className="flex items-center justify-between rounded-2xl border border-vibe-border-4/80 bg-vibe-bg-3/60 px-4 py-3">
									<span>{display}</span>
									{hasModel ? (
										<span className="inline-flex items-center gap-1 text-emerald-400 text-xs font-medium">
											<Check className="w-4 h-4" /> {onboardingS.statusConnected}
										</span>
									) : (
										<span className="text-xs text-vibe-fg-4">{onboardingS.statusPending}</span>
									)}
								</div>
							);
						})}
					</div>
				</div>

				{/* Content */}
				<div className="flex-1 flex flex-col rounded-[32px] border border-vibe-border-3 bg-vibe-bg-1/70 backdrop-blur-xl shadow-[0_45px_120px_rgba(0,0,0,0.45)] p-6">
					<div className="w-full max-w-xl mx-auto text-center mb-8">
						<p className="text-lg md:text-xl font-light text-vibe-fg-1 leading-relaxed">
							{descriptionOfTab[currentTab]}
						</p>
					</div>

					<div className="space-y-6 overflow-y-auto pr-1 flex-1">
						{providerNamesOfTab[currentTab].map((providerName) => (
							<div key={providerName} className="rounded-2xl border border-vibe-border-3/80 bg-vibe-bg-3/60 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
								<div className="flex items-center justify-between mb-3">
									<div className="text-xl font-medium text-vibe-fg-0 flex items-center gap-2">
										{onboardingS.addProviderTitle(displayInfoOfProviderName(providerName).title)}
										{(providerName === 'openCodeZen' || providerName === 'openCodeGo' || providerName === 'gemini' || providerName === 'openRouter' || providerName === 'pollinations') && (
											<span
												data-tooltip-id="vibe-tooltip-provider-info"
												data-tooltip-place="right"
												className="text-xs @@vibe-onboarding-accent-link"
												data-tooltip-content={onboardingS.providerTooltip(providerName)}
											>
												{onboardingS.moreInfo}
											</span>
										)}
									</div>
									{providerName === 'ollama' && (
										<span className="inline-flex items-center gap-1 text-xs text-vibe-fg-3">
											<Lock size={12} /> {onboardingS.localBadge}
										</span>
									)}
								</div>

								<SettingsForProvider providerName={providerName} showProviderTitle={false} showProviderSuggestions={true} />

								{providerName === 'ollama' && (
									<div className="mt-4 rounded-xl border border-vibe-border-4/80 bg-black/20">
										<OllamaSetupInstructions />
									</div>
								)}
							</div>
						))}
					</div>

					{(currentTab === 'Local' || currentTab === 'Cloud/Other') && (
						<div className="w-full mt-6 rounded-2xl border border-vibe-border-4/80 bg-vibe-bg-2/70 p-6">
							<div className="flex items-center gap-2 mb-4">
								<div className="text-xl font-medium">{onboardingS.modelsHeading}</div>
							</div>

							{currentTab === 'Local' && (
								<div className="text-sm text-vibe-fg-3 mb-4">{onboardingS.localModelsHint}</div>
							)}

							{currentTab === 'Local' && <ModelDump filteredProviders={localProviderNames} />}
							{currentTab === 'Cloud/Other' && <ModelDump filteredProviders={cloudProviders} />}
						</div>
					)}

					<div className="flex flex-col gap-3 items-end w-full mt-6">
						{errorMessage && (
							<div className="w-full text-sm rounded-2xl border border-vibe-warning/30 bg-vibe-warning/15 text-vibe-warning px-4 py-3 text-right">
								{errorMessage}
							</div>
						)}
						<div className="flex items-center gap-2">
							<PreviousButton onClick={() => setPageIndex(pageIndex - 1)} />
							<NextButton
								onClick={() => {
									const isDisabled = isFeatureNameDisabled('Chat', settingsState);
									if (!isDisabled) {
										setPageIndex(pageIndex + 1);
										setErrorMessage(null);
									} else {
										setErrorMessage(onboardingS.connectModelPrompt);
									}
								}}
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
// =============================================
// 	OnboardingPage
// 		title:
// 			div
// 				"Welcome to Void"
// 			image
// 		content:<></>
// 		title
// 		content
// 		prev/next

// 	OnboardingPage
// 		title:
// 			div
// 				"How would you like to use Void?"
// 		content:
// 			ModelQuestionContent
// 				|
// 					div
// 						"I want to:"
// 					div
// 						"Use the smartest models"
// 						"Keep my data fully private"
// 						"Save money"
// 						"I don't know"
// 				| div
// 					| div
// 						"We recommend using "
// 						"Set API"
// 					| div
// 						""
// 					| div
//
// 		title
// 		content
// 		prev/next
//
// 	OnboardingPage
// 		title
// 		content
// 		prev/next

const NextButton = ({ onClick, ...props }: { onClick: () => void } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	const { disabled, className = '', ...buttonProps } = props;

	return (
		<button
			type="button"
			onClick={disabled ? undefined : onClick}
			onDoubleClick={onClick}
			className={`
				@@vibe-pill-button @@vibe-pill-button--primary @@vibe-focus-ring inline-flex items-center gap-2 px-6 py-2.5 font-semibold tracking-tight
				${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
				${className}
			`}
			{...disabled && {
				'data-tooltip-id': 'vibe-tooltip',
				"data-tooltip-content": onboardingS.requiredFieldsTooltip,
				"data-tooltip-place": 'top',
			}}
			{...buttonProps}
		>
			{onboardingS.nextBtn}
			<ChevronRight className="w-4 h-4" />
		</button>
	);
};

const PreviousButton = ({ onClick, ...props }: { onClick: () => void } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	return (
		<button
			type="button"
			onClick={onClick}
			className="@@vibe-pill-button @@vibe-pill-button--secondary @@vibe-focus-ring px-5 py-2.5 cursor-pointer"
			{...props}
		>
			{onboardingS.previousBtn}
		</button>
	);
};



const OnboardingPageShell = ({ top, bottom, content, hasMaxWidth = true, className = '', }: {
	top?: React.ReactNode;
	bottom?: React.ReactNode;
	content?: React.ReactNode;
	hasMaxWidth?: boolean;
	className?: string;
}) => {
	return (
		<div className={`min-h-[70vh] w-full ${className}`}>
			<div className={`
				text-lg flex flex-col gap-6 w-full h-full mx-auto px-8 py-10
				rounded-[32px] border border-vibe-border-3 bg-vibe-bg-2/70 backdrop-blur-xl
				shadow-[0_30px_90px_rgba(0,0,0,0.45)]
				${hasMaxWidth ? 'max-w-[720px]' : ''}
				max-h-[calc(100vh-6rem)]
				overflow-y-auto
			`}>
				{top && <FadeIn className='w-full mb-auto'>{top}</FadeIn>}
				{content && <FadeIn className='w-full my-auto'>{content}</FadeIn>}
				{bottom && <div className='w-full pt-6'>{bottom}</div>}
			</div>
		</div>
	);
};

const WelcomePage = ({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) => {
	return (
		<div className="space-y-8">
			<div className="rounded-[32px] border border-vibe-border-2 bg-vibe-bg-2/90 backdrop-blur-2xl shadow-[0_60px_140px_rgba(0,0,0,0.75)] px-10 py-12">
				<div className="flex flex-col lg:flex-row gap-10 items-center">
					<div className="flex-1 flex flex-col gap-6 text-center lg:text-left">
						<p className="text-xs uppercase tracking-[0.45em] text-vibe-fg-4">{onboardingS.welcomeKicker}</p>
						<div>
							<h1 className="text-4xl sm:text-5xl font-light @@vibe-onboarding-welcome-title max-w-xl mx-auto lg:mx-0">{onboardingS.heroTitle}</h1>
							<p className="text-base text-vibe-fg-2 mt-3 max-w-xl mx-auto lg:mx-0">
								{onboardingS.heroLead}
							</p>
						</div>
						<div className="flex flex-wrap gap-3 justify-center lg:justify-start">
							{welcomeHighlights.map((highlight) => (
								<span key={highlight} className="@@vibe-pill-button pointer-events-none select-none text-xs tracking-[0.25em] uppercase text-vibe-fg-3 justify-center">
									{highlight}
								</span>
							))}
						</div>
						<div className="flex flex-wrap gap-3 justify-center lg:justify-start">
							<PrimaryActionButton ringSize='xl' onClick={onNext}>{onboardingS.startSetup}</PrimaryActionButton>
							<SecondaryActionButton onClick={onSkip}>{onboardingS.skipBtn}</SecondaryActionButton>
						</div>
					</div>
					<div className="flex-1 w-full flex flex-col items-center gap-6">
						<div className="relative w-full max-w-sm aspect-square">
							<div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-transparent blur-3xl rounded-[32px]" />
							<div className="relative w-full h-full rounded-[28px] border border-vibe-border-2 bg-vibe-bg-3/80 shadow-[0_45px_110px_rgba(0,0,0,0.7)] flex items-center justify-center p-6">
								<VibeHeroIcon />
							</div>
						</div>
						<div className="grid grid-cols-2 gap-4 w-full max-w-sm">
							{welcomeStats.map(({ label, value, detail }) => (
								<div key={label} className="rounded-2xl border border-vibe-border-3 bg-vibe-bg-3/80 p-4 text-center text-vibe-fg-2">
									<p className="text-[11px] uppercase tracking-[0.4em] text-vibe-fg-4">{label}</p>
									<p className="text-lg font-medium text-vibe-fg-0 mt-2">{value}</p>
									<p className="text-xs text-vibe-fg-3 mt-1">{detail}</p>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

const OllamaDownloadOrRemoveModelButton = ({ modelName, isModelInstalled, sizeGb }: { modelName: string; isModelInstalled: boolean; sizeGb: number | false | 'not-known' }) => {
	// for now just link to the ollama download page
	return <a
		href={`https://ollama.com/library/${modelName}`}
		target="_blank"
		rel="noopener noreferrer"
		className="flex items-center justify-center text-vibe-fg-2 hover:text-vibe-fg-1"
	>
		<ExternalLink className="w-3.5 h-3.5" />
	</a>;

};


const YesNoText = ({ val }: { val: boolean | null }) => {

	return <div
		className={
			val === true ? "text text-emerald-500"
				: val === false ? 'text-rose-600'
					: "text text-amber-300"
		}
	>
		{
			val === true ? "Yes"
				: val === false ? 'No'
					: "Yes*"
		}
	</div>;

};



const abbreviateNumber = (num: number): string => {
	if (num >= 1000000) {
		// For millions
		return Math.floor(num / 1000000) + 'M';
	} else if (num >= 1000) {
		// For thousands
		return Math.floor(num / 1000) + 'K';
	} else {
		// For numbers less than 1000
		return num.toString();
	}
};





const PrimaryActionButton = ({ children, className = '', ringSize, ...props }: { children: React.ReactNode; ringSize?: undefined | 'xl' | 'screen' } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	const sizingClass = ringSize === 'xl'
		? 'px-10 py-4 text-lg'
		: ringSize === 'screen'
			? 'px-16 py-8 text-2xl w-full'
			: 'px-5 py-2.5 text-base';

	return (
		<button
			type='button'
			className={`
				@@vibe-pill-button @@vibe-pill-button--primary @@vibe-focus-ring inline-flex items-center justify-center gap-2 font-semibold tracking-tight cursor-pointer group
				${sizingClass}
				${className}
			`}
			{...props}
		>
			{children}
			<ChevronRight
				className="transition-transform duration-300 ease-in-out group-hover:translate-x-1 group-active:translate-x-1"
			/>
		</button>
	);
};

const SecondaryActionButton = ({ children, className = '', ...props }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button
		type="button"
		className={`
			@@vibe-pill-button @@vibe-pill-button--secondary @@vibe-focus-ring inline-flex items-center justify-center gap-2 px-5 py-2.5 cursor-pointer
			${className}
		`}
		{...props}
	>
		{children}
	</button>
);


type WantToUseOption = 'smart' | 'private' | 'cheap' | 'all';

const VibeOnboardingContent = () => {


	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const vibeMetricsService = accessor.get('IMetricsService');

	const vibeSettingsState = useSettingsState();

	const [pageIndex, setPageIndex] = useState(0);


	// page 1 state
	const [wantToUseOption, setWantToUseOption] = useState<WantToUseOption>('smart');

	// Replace the single selectedProviderName with four separate states
	// page 2 state - each tab gets its own state
	const [selectedIntelligentProvider, setSelectedIntelligentProvider] = useState<ProviderName>('anthropic');
	const [selectedPrivateProvider, setSelectedPrivateProvider] = useState<ProviderName>('ollama');
	const [selectedAffordableProvider, setSelectedAffordableProvider] = useState<ProviderName>('gemini');
	const [selectedAllProvider, setSelectedAllProvider] = useState<ProviderName>('anthropic');

	// Helper function to get the current selected provider based on active tab
	const getSelectedProvider = (): ProviderName => {
		switch (wantToUseOption) {
			case 'smart': return selectedIntelligentProvider;
			case 'private': return selectedPrivateProvider;
			case 'cheap': return selectedAffordableProvider;
			case 'all': return selectedAllProvider;
		}
	};

	// Helper function to set the selected provider for the current tab
	const setSelectedProvider = (provider: ProviderName) => {
		switch (wantToUseOption) {
			case 'smart': setSelectedIntelligentProvider(provider); break;
			case 'private': setSelectedPrivateProvider(provider); break;
			case 'cheap': setSelectedAffordableProvider(provider); break;
			case 'all': setSelectedAllProvider(provider); break;
		}
	};

	const providerNamesOfWantToUseOption: { [wantToUseOption in WantToUseOption]: ProviderName[] } = {
		smart: ['anthropic', 'openAI', 'gemini', 'openRouter', 'minimax'],
		private: ['ollama', 'vLLM', 'openAICompatible', 'lmStudio'],
		cheap: ['gemini', 'deepseek', 'openRouter', 'pollinations', 'ollama', 'vLLM'],
		all: providerNames,
	};


	const selectedProviderName = getSelectedProvider();
	const didFillInProviderSettings = selectedProviderName && vibeSettingsState.settingsOfProvider[selectedProviderName]._didFillInProviderSettings;
	const isApiKeyLongEnoughIfApiKeyExists = selectedProviderName && vibeSettingsState.settingsOfProvider[selectedProviderName].apiKey ? vibeSettingsState.settingsOfProvider[selectedProviderName].apiKey.length > 15 : true;
	const isAtLeastOneModel = selectedProviderName && vibeSettingsState.settingsOfProvider[selectedProviderName].models.length >= 1;

	const didFillInSelectedProviderSettings = !!(didFillInProviderSettings && isApiKeyLongEnoughIfApiKeyExists && isAtLeastOneModel);

	const skipOnboarding = (reason: string) => {
		vibeideSettingsService.setGlobalSetting('isOnboardingComplete', true);
		vibeMetricsService.capture('Skipped Onboarding', { reason, pageIndex, wantToUseOption, selectedProviderName });
	};

	const prevAndNextButtons = <div className="max-w-[600px] w-full mx-auto flex flex-col items-end">
		<div className="flex items-center gap-2">
			<PreviousButton
				onClick={() => { setPageIndex(pageIndex - 1); }}
			/>
			<NextButton
				onClick={() => { setPageIndex(pageIndex + 1); }}
			/>
		</div>
	</div>;


	const lastPagePrevAndNextButtons = <div className="max-w-[600px] w-full mx-auto flex flex-col items-end">
		<div className="flex items-center gap-2">
			<PreviousButton
				onClick={() => { setPageIndex(pageIndex - 1); }}
			/>
			<SecondaryActionButton onClick={() => skipOnboarding('final-step-skip')}>{onboardingS.skipBtn}</SecondaryActionButton>
			<PrimaryActionButton
				onClick={() => {
					vibeideSettingsService.setGlobalSetting('isOnboardingComplete', true);
					vibeMetricsService.capture('Completed Onboarding', { selectedProviderName, wantToUseOption });
				}}
				ringSize={vibeSettingsState.globalSettings.isOnboardingComplete ? 'screen' : undefined}
			>{onboardingS.startInVibe}</PrimaryActionButton>
		</div>
	</div>;


	// cannot be md
	const basicDescOfWantToUseOption: { [wantToUseOption in WantToUseOption]: string } = {
		smart: onboardingS.tagSmart,
		private: onboardingS.tagPrivate,
		cheap: onboardingS.tagCheap,
		all: "",
	};

	// can be md
	const detailedDescOfWantToUseOption: { [wantToUseOption in WantToUseOption]: string } = {
		smart: onboardingS.tagAgent,
		private: onboardingS.tagPrivateDetail,
		cheap: onboardingS.tagCheapDetail,
		all: "",
	};

	// Modified: initialize separate provider states on initial render instead of watching wantToUseOption changes
	useEffect(() => {
		if (selectedIntelligentProvider === undefined) {
			setSelectedIntelligentProvider(providerNamesOfWantToUseOption['smart'][0]);
		}
		if (selectedPrivateProvider === undefined) {
			setSelectedPrivateProvider(providerNamesOfWantToUseOption['private'][0]);
		}
		if (selectedAffordableProvider === undefined) {
			setSelectedAffordableProvider(providerNamesOfWantToUseOption['cheap'][0]);
		}
		if (selectedAllProvider === undefined) {
			setSelectedAllProvider(providerNamesOfWantToUseOption['all'][0]);
		}
	}, []);

	// reset the page to page 0 if the user redos onboarding
	useEffect(() => {
		if (!vibeSettingsState.globalSettings.isOnboardingComplete) {
			setPageIndex(0);
		}
	}, [setPageIndex, vibeSettingsState.globalSettings.isOnboardingComplete]);


	const contentOfIdx: { [pageIndex: number]: React.ReactNode } = {
		0: <WelcomePage onNext={() => setPageIndex(1)} onSkip={() => skipOnboarding('welcome-skip')} />,

		1: <OnboardingPageShell hasMaxWidth={false}
			content={
				<AddProvidersPage pageIndex={pageIndex} setPageIndex={setPageIndex} />
			}
		/>,
		2: <OnboardingPageShell

			content={
				<div>
					<div className="text-4xl sm:text-5xl font-light text-center @@vibe-onboarding-section-title max-w-lg mx-auto">{onboardingS.settingsAndThemes}</div>

					<div className="mt-8 text-center flex flex-col items-center gap-4 w-full max-w-md mx-auto">
						<h4 className="text-vibe-fg-3 mb-4">{onboardingS.transferFromOther}</h4>
						<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="VS Code" />
						<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="Cursor" />
						<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="Windsurf" />
					</div>
				</div>
			}
			bottom={lastPagePrevAndNextButtons}
		/>,
	};


	return <div key={pageIndex} className="w-full h-[80vh] text-left mx-auto flex flex-col items-center justify-center">
		<ErrorBoundary>
			{contentOfIdx[pageIndex]}
		</ErrorBoundary>
	</div>;

};
