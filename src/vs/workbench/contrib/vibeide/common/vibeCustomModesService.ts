/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';


export interface CustomMode {
	id: string;
	name: string;
	description: string;
	systemPromptExtension: string; // Added to base system prompt
	allowedTools?: string[];        // null = all tools allowed
	trustScore?: 'manual' | 'supervised' | 'auto';
	isBuiltin: boolean;
	sha256?: string; // For community modes
}

const BUILTIN_MODES: CustomMode[] = [
	{
		id: 'architect',
		name: 'Architect',
		description: localize('vibeide.customModes.architect.desc', 'Режим высокоуровневого проектирования и планирования'),
		systemPromptExtension: 'You are in Architect mode. Focus on high-level design, architecture decisions, and planning. Avoid implementing details. Ask clarifying questions about requirements.',
		allowedTools: ['read_file', 'ls_dir', 'web_search'],
		trustScore: 'supervised',
		isBuiltin: true,
	},
	{
		id: 'coder',
		name: 'Coder',
		description: localize('vibeide.customModes.coder.desc', 'Режим реализации и написания кода'),
		systemPromptExtension: 'You are in Coder mode. Focus on implementing code efficiently. Write clean, well-tested code. Follow existing patterns.',
		allowedTools: undefined, // All tools
		trustScore: 'auto',
		isBuiltin: true,
	},
	{
		id: 'debugger',
		name: 'Debugger',
		description: localize('vibeide.customModes.debugger.desc', 'Режим расследования и исправления ошибок'),
		systemPromptExtension: 'You are in Debugger mode. Focus on identifying root causes. Start by reading relevant code, then propose minimal targeted fixes. Explain your reasoning.',
		allowedTools: ['read_file', 'ls_dir', 'run_command'],
		trustScore: 'manual',
		isBuiltin: true,
	},
];

export const IVibeCustomModesService = createDecorator<IVibeCustomModesService>('vibeCustomModesService');

export interface IVibeCustomModesService {
	readonly _serviceBrand: undefined;

	getAllModes(): CustomMode[];
	getMode(id: string): CustomMode | undefined;
	getActiveMode(): CustomMode | null;
	setActiveMode(id: string | null): void;
	importCommunityMode(url: string): Promise<{ mode: CustomMode; sha256: string }>;
	readonly onModeChanged: Event<CustomMode | null>;
}

class VibeCustomModesService extends Disposable implements IVibeCustomModesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onModeChanged = this._register(new Emitter<CustomMode | null>());
	readonly onModeChanged = this._onModeChanged.event;

	private _modes: CustomMode[] = [...BUILTIN_MODES];
	private _activeMode: CustomMode | null = null;

	constructor(
	) {
		super();
	}

	getAllModes(): CustomMode[] { return [...this._modes]; }
	getMode(id: string): CustomMode | undefined { return this._modes.find(m => m.id === id); }
	getActiveMode(): CustomMode | null { return this._activeMode; }

	setActiveMode(id: string | null): void {
		this._activeMode = id ? (this._modes.find(m => m.id === id) ?? null) : null;
		vibeLog.info('CustomModes', `Active: ${this._activeMode?.name ?? 'none'}`);
		this._onModeChanged.fire(this._activeMode);
	}

	async importCommunityMode(url: string): Promise<{ mode: CustomMode; sha256: string }> {
		const response = await fetch(url);
		const text = await response.text();
		const hash = Array.from(
			new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
		).map(b => b.toString(16).padStart(2, '0')).join('');

		const mode = JSON.parse(text) as CustomMode;
		mode.isBuiltin = false;
		mode.sha256 = hash;

		vibeLog.info('CustomModes', `Imported community mode: ${mode.name} (SHA-256: ${hash.slice(0, 8)})`);
		this._modes.push(mode);
		return { mode, sha256: hash };
	}
}

registerSingleton(IVibeCustomModesService, VibeCustomModesService, InstantiationType.Eager);
