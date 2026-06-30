/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/



import { useAccessor, useActiveURI, useIsDark, useSettingsState } from '../util/services.js';

import '../styles.css';
import { VIBEIDE_CTRL_K_ACTION_ID, VIBEIDE_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { Circle, MoreVertical } from 'lucide-react';
import { useEffect, useState } from 'react';

import { VibeideSelectionHelperProps } from '../../../../../../contrib/vibeide/browser/vibeideSelectionHelperWidget.js';
import { VIBEIDE_OPEN_SETTINGS_ACTION_ID } from '../../../vibeideSettingsPane.js';
import { selectionHelperS } from '../vibe-settings-tsx/vibeSettingsRu.js';


export const VibeSelectionHelperMain = (props: VibeideSelectionHelperProps) => {

	const isDark = useIsDark();

	return <div
		className={`@@vibe-scope @@vibe-react-input-surfaces ${isDark ? 'dark' : ''}`}
	>
		<VibeSelectionHelper {...props} />
	</div>;
};



const VibeSelectionHelper = ({ rerenderKey }: VibeideSelectionHelperProps) => {


	const accessor = useAccessor();
	const keybindingService = accessor.get('IKeybindingService');
	const commandService = accessor.get('ICommandService');

	const ctrlLKeybind = keybindingService.lookupKeybinding(VIBEIDE_CTRL_L_ACTION_ID);
	const ctrlKKeybind = keybindingService.lookupKeybinding(VIBEIDE_CTRL_K_ACTION_ID);

	const dividerHTML = <div className='w-[0.5px] bg-vibe-border-3'></div>;

	const [reactRerenderCount, setReactRerenderKey] = useState(rerenderKey);
	const [clickState, setClickState] = useState<'init' | 'clickedOption' | 'clickedMore'>('init');

	useEffect(() => {
		const disposable = commandService.onWillExecuteCommand(e => {
			if (e.commandId === VIBEIDE_CTRL_L_ACTION_ID || e.commandId === VIBEIDE_CTRL_K_ACTION_ID) {
				setClickState('clickedOption');
			}
		});

		return () => {
			disposable.dispose();
		};
	}, [commandService, setClickState]);


	// rerender when the key changes
	if (reactRerenderCount !== rerenderKey) {
		setReactRerenderKey(rerenderKey);
		setClickState('init');
	}
	// useEffect(() => {
	// }, [rerenderKey, reactRerenderCount, setReactRerenderKey, setClickState])

	// if the user selected an option, close


	if (clickState === 'clickedOption') {
		return null;
	}

	const defaultHTML = <>
		{ctrlLKeybind &&
			<div
				className='
					flex items-center px-2 py-1.5
					cursor-pointer
				'
				onClick={() => {
					commandService.executeCommand(VIBEIDE_CTRL_L_ACTION_ID);
					setClickState('clickedOption');
				}}
			>
				<span>{selectionHelperS.addToChat}</span>
				<span className='ml-1 px-1 rounded bg-[var(--vscode-keybindingLabel-background)] text-[var(--vscode-keybindingLabel-foreground)] border border-[var(--vscode-keybindingLabel-border)]'>
					{ctrlLKeybind.getLabel()}
				</span>
			</div>
		}
		{ctrlLKeybind && ctrlKKeybind &&
			dividerHTML
		}
		{ctrlKKeybind &&
			<div
				className='
					flex items-center px-2 py-1.5
					cursor-pointer
				'
				onClick={() => {
					commandService.executeCommand(VIBEIDE_CTRL_K_ACTION_ID);
					setClickState('clickedOption');
				}}
			>
				<span className='ml-1'>{selectionHelperS.editInline}</span>
				<span className='ml-1 px-1 rounded bg-[var(--vscode-keybindingLabel-background)] text-[var(--vscode-keybindingLabel-foreground)] border border-[var(--vscode-keybindingLabel-border)]'>
					{ctrlKKeybind.getLabel()}
				</span>
			</div>
		}

		{dividerHTML}

		<div
			className='
				flex items-center px-0.5
				cursor-pointer
			'
			onClick={() => {
				setClickState('clickedMore');
			}}
		>
			<MoreVertical className="w-4" />
		</div>
	</>;


	const moreOptionsHTML = <>
		<div
			className='
				flex items-center px-2 py-1.5
				cursor-pointer
			'
			onClick={() => {
				commandService.executeCommand(VIBEIDE_OPEN_SETTINGS_ACTION_ID);
				setClickState('clickedOption');
			}}
		>
			{selectionHelperS.disableSuggestions}
		</div>

		{dividerHTML}

		<div
			className='
				flex items-center px-0.5
				cursor-pointer
			'
			onClick={() => {
				setClickState('init');
			}}
		>
			<MoreVertical className="w-4" />
		</div>
	</>;

	return <div className='
		pointer-events-auto select-none
		z-[1000]
		rounded-sm shadow-md flex flex-nowrap text-nowrap
		border border-vibe-border-3 bg-vibe-bg-2
		transition-all duration-200
	'>
		{clickState === 'init' ? defaultHTML
			: clickState === 'clickedMore' ? moreOptionsHTML
				: <></>
		}
	</div>;
};
