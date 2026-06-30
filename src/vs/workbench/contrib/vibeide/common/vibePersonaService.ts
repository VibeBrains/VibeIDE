/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';

export interface VibePersona {
	vibeVersion?: string;
	verbosity?: 'verbose' | 'normal' | 'concise';
	formality?: 'formal' | 'technical' | 'casual';
	language?: string;
	ask_before_assume?: boolean;
	proactive_suggestions?: boolean;
}

const DEFAULT_PERSONA: VibePersona = {
	vibeVersion: '1.0.0',
	verbosity: 'normal',
	formality: 'technical',
	language: 'en',
	ask_before_assume: false,
	proactive_suggestions: false,
};

export const IVibePersonaService = createDecorator<IVibePersonaService>('vibePersonaService');

export interface IVibePersonaService {
	readonly _serviceBrand: undefined;

	/** Get current persona settings */
	getPersona(): VibePersona;

	/** Check if agent should ask clarifying questions */
	shouldAskBeforeAssume(): boolean;

	/** Check if agent should offer proactive suggestions */
	shouldOfferProactiveSuggestions(): boolean;

	/** Get verbosity level */
	getVerbosity(): 'verbose' | 'normal' | 'concise';
}

/**
 * VibeIDE Agent Persona: reads .vibe/persona.json to configure agent communication style.
 * Teams can define: verbosity, formality, language, ask_before_assume.
 *
 * Service boundary contract: see `references/v1/persona-vs-modes.md`. Persona is a
 * communication-style overlay; capability fencing (tools / MCP / model preset / system
 * prompt) lives in `VibeCustomModesService`. The two services do not duplicate.
 */
class VibePersonaService extends Disposable implements IVibePersonaService {
	declare readonly _serviceBrand: undefined;

	private _persona: VibePersona = { ...DEFAULT_PERSONA };

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._load();
	}

	private async _load(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const uri = joinPath(folders[0].uri, '.vibe', 'persona.json');
		try {
			const content = await this._fileService.readFile(uri);
			const loaded = JSON.parse(content.value.toString()) as VibePersona;
			this._persona = { ...DEFAULT_PERSONA, ...loaded };
			vibeLog.debug('Persona', `Loaded: verbosity=${this._persona.verbosity}, ask_before_assume=${this._persona.ask_before_assume}`);
		} catch (e) {
			if (!(e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				vibeLog.warn('Persona', 'Failed to load .vibe/persona.json:', e);
			}
			// Use defaults
		}
	}

	getPersona(): VibePersona {
		return { ...this._persona };
	}

	shouldAskBeforeAssume(): boolean {
		return this._persona.ask_before_assume ?? DEFAULT_PERSONA.ask_before_assume!;
	}

	shouldOfferProactiveSuggestions(): boolean {
		return this._persona.proactive_suggestions ?? DEFAULT_PERSONA.proactive_suggestions!;
	}

	getVerbosity(): 'verbose' | 'normal' | 'concise' {
		return this._persona.verbosity ?? 'normal';
	}
}

registerSingleton(IVibePersonaService, VibePersonaService, InstantiationType.Delayed);
