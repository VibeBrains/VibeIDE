/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import '../styles.css'
import { Tooltip } from 'react-tooltip';
import 'react-tooltip/dist/react-tooltip.css';
import { useIsDark } from '../util/services.js';
import { tooltipS } from '../vibe-settings-tsx/vibeSettingsRu.js';

/**
 * Creates a configured global tooltip component with consistent styling
 * To use:
 * 1. Mount a Tooltip with some id eg id='vibe-tooltip'
 * 2. Add data-tooltip-id="vibe-tooltip" and data-tooltip-content="Your tooltip text" to any element
 */
export const VibeTooltip = () => {


	const isDark = useIsDark()

	return (

		// use native colors so we don't have to worry about @@vibe-scope styles
		// --vibe-bg-1: var(--vscode-input-background);
		// --vibe-bg-1-alt: var(--vscode-badge-background);
		// --vibe-bg-2: var(--vscode-sideBar-background);
		// --vibe-bg-2-alt: color-mix(in srgb, var(--vscode-sideBar-background) 30%, var(--vscode-editor-background) 70%);
		// --vibe-bg-3: var(--vscode-editor-background);

		// --vibe-fg-0: color-mix(in srgb, var(--vscode-tab-activeForeground) 90%, black 10%);
		// --vibe-fg-1: var(--vscode-editor-foreground);
		// --vibe-fg-2: var(--vscode-input-foreground);
		// --vibe-fg-3: var(--vscode-input-placeholderForeground);
		// /* --vibe-fg-4: var(--vscode-tab-inactiveForeground); */
		// --vibe-fg-4: var(--vscode-list-deemphasizedForeground);

		// --vibe-warning: var(--vscode-charts-yellow);

		// --vibe-border-1: var(--vscode-commandCenter-activeBorder);
		// --vibe-border-2: var(--vscode-commandCenter-border);
		// --vibe-border-3: var(--vscode-commandCenter-inactiveBorder);
		// --vibe-border-4: var(--vscode-editorGroup-border);

		<>
			<style>
				{`
				#vibe-tooltip, #vibe-tooltip-orange, #vibe-tooltip-green, #vibe-tooltip-ollama-settings, #vibe-tooltip-provider-info {
					font-size: 12px;
					padding: 0px 8px;
					border-radius: 6px;
					z-index: 999999;
					max-width: 300px;
					word-wrap: break-word;
				}

				#vibe-tooltip {
					background-color: var(--vscode-editor-background);
					color: var(--vscode-input-foreground);
				}

				#vibe-tooltip-orange {
					background-color: #F6762A;
					color: white;
				}

				#vibe-tooltip-green {
					background-color: #228B22;
					color: white;
				}

				#vibe-tooltip-ollama-settings, #vibe-tooltip-provider-info {
					background-color: var(--vscode-editor-background);
					color: var(--vscode-input-foreground);
				}

				.react-tooltip-arrow {
					z-index: -1 !important; /* Keep arrow behind content (somehow this isnt done automatically) */
				}
				`}
			</style>


			<Tooltip
				id="vibe-tooltip"
				// border='1px solid var(--vscode-editorGroup-border)'
				border='1px solid rgba(100,100,100,.2)'
				opacity={1}
				delayShow={50}
				// Dismiss orphaned tooltips: chat anchors mount/unmount during streaming,
				// so a `mouseleave` may never fire and the tooltip sticks. Closing on
				// scroll / click / resize / Esc clears it. (react-tooltip v6)
				globalCloseEvents={{ escape: true, scroll: true, resize: true, clickOutsideAnchor: true }}
			/>
			<Tooltip
				id="vibe-tooltip-orange"
				border='1px solid rgba(200,200,200,.3)'
				opacity={1}
				delayShow={50}
				globalCloseEvents={{ escape: true, scroll: true, resize: true, clickOutsideAnchor: true }}
			/>
			<Tooltip
				id="vibe-tooltip-green"
				border='1px solid rgba(200,200,200,.3)'
				opacity={1}
				delayShow={50}
				globalCloseEvents={{ escape: true, scroll: true, resize: true, clickOutsideAnchor: true }}
			/>
			<Tooltip
				id="vibe-tooltip-ollama-settings"
				border='1px solid rgba(100,100,100,.2)'
				opacity={1}
				openEvents={{ mouseover: true, click: true, focus: true }}
				place='right'
				style={{ pointerEvents: 'all', userSelect: 'text', fontSize: 11 }}
			>
				<div style={{ padding: '8px 10px' }}>
					<div style={{ opacity: 0.8, textAlign: 'center', fontWeight: 'bold', marginBottom: 8 }}>
						{tooltipS.starterModelsTitle}
					</div>
					<div style={{ marginBottom: 4 }}>
						<span style={{ opacity: 0.8 }}>{tooltipS.forChat}{` `}</span>
						<span style={{ opacity: 0.8, fontWeight: 'bold' }}>gemma3</span>
					</div>
					<div style={{ marginBottom: 4 }}>
						<span style={{ opacity: 0.8 }}>{tooltipS.forAutocomplete}{` `}</span>
						<span style={{ opacity: 0.8, fontWeight: 'bold' }}>qwen2.5-coder</span>
					</div>
					<div style={{ marginBottom: 0 }}>
						<span style={{ opacity: 0.8 }}>{tooltipS.useLargest}</span>
					</div>
				</div>
			</Tooltip>

			<Tooltip
				id="vibe-tooltip-provider-info"
				border='1px solid rgba(100,100,100,.2)'
				opacity={1}
				delayShow={50}
				globalCloseEvents={{ escape: true, scroll: true, resize: true, clickOutsideAnchor: true }}
				style={{ pointerEvents: 'all', userSelect: 'text', fontSize: 11, maxWidth: '280px', paddingTop:'8px', paddingBottom:'8px' }}
			/>
		</>
	);
};
