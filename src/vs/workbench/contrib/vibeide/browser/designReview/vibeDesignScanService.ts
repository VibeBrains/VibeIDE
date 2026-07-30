/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { DocumentSnapshot } from '../../common/designReview/designSlopRules.js';

/** Same shape the preview manager returns; duplicated here so this service depends on nothing. */
export type DesignScanOutcome =
	| { readonly ok: true; readonly snapshot: DocumentSnapshot; readonly truncated: boolean }
	| { readonly ok: false; readonly reason: 'no-preview' | 'unsupported' | 'timeout' | 'page-error'; readonly detail?: string };

export const IVibeDesignScanService = createDecorator<IVibeDesignScanService>('vibeDesignScanService');

export interface IVibeDesignScanService {
	readonly _serviceBrand: undefined;
	/** Called by whoever owns the preview; the returned disposable unregisters the source. */
	registerSource(source: () => Promise<DesignScanOutcome>): IDisposable;
	/** Measures the previewed page, or explains why it could not. */
	scan(): Promise<DesignScanOutcome>;
}

/**
 * Thin indirection between "who wants to measure the page" (the agent tool) and "who owns the
 * preview" (the Vibe Server service).
 *
 * Why it exists: injecting `IVibeServerService` into `ToolsService` closed a dependency cycle —
 * chatThreadService → subagent → runner → ToolsService → vibeServerService → chatThreadService —
 * which the compiler cannot see and which killed `workbench.contrib.vibeModalRoot` at runtime with
 * "Unable to create workbench contribution". This service has NO dependencies of its own, so it
 * cannot participate in a cycle; the preview side registers itself instead of being imported.
 */
class VibeDesignScanService extends Disposable implements IVibeDesignScanService {
	declare readonly _serviceBrand: undefined;

	private _source: (() => Promise<DesignScanOutcome>) | undefined;

	registerSource(source: () => Promise<DesignScanOutcome>): IDisposable {
		this._source = source;
		return toDisposable(() => {
			if (this._source === source) {
				this._source = undefined;
			}
		});
	}

	async scan(): Promise<DesignScanOutcome> {
		if (!this._source) {
			// No preview machinery is alive yet — indistinguishable, from the caller's side, from
			// having no preview open, and reported as such rather than as an empty result.
			return { ok: false, reason: 'no-preview' };
		}
		return this._source();
	}
}

registerSingleton(IVibeDesignScanService, VibeDesignScanService, InstantiationType.Delayed);
