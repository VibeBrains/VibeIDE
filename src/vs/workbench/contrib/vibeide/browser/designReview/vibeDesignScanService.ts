/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { DocumentSnapshot, ViewportLabel } from '../../common/designReview/designSlopRules.js';

/** Same shape the preview manager returns; duplicated here so this service depends on nothing. */
export type DesignScanOutcome =
	| { readonly ok: true; readonly snapshot: DocumentSnapshot; readonly truncated: boolean }
	| { readonly ok: false; readonly reason: 'no-preview' | 'unsupported' | 'timeout' | 'page-error'; readonly detail?: string };

/**
 * Why the page could not be measured, in the user's language.
 *
 * Lives next to the outcome type because every caller has to say it, and "nothing measured" must
 * never be reported as "nothing found" — two tools phrasing that differently would let the model
 * treat an unmeasured page as a clean one.
 */
export function unreachableReasonOf(outcome: Extract<DesignScanOutcome, { ok: false }>): string {
	switch (outcome.reason) {
		case 'no-preview':
			return 'превью не открыто';
		case 'unsupported':
			return 'страница вне досягаемости: в ней нет моста VibeIDE. Статическое превью несёт его всегда, dev-сервер — через прокси (`vibeide.vibeServer.bridgeProxy`), Docker-превью не несёт вовсе';
		case 'timeout':
			return 'страница не ответила';
		default:
			return `ошибка на странице: ${outcome.detail ?? 'без подробностей'}`;
	}
}

/** One finding, reduced to what the page needs to draw it. */
export interface IDesignFindingMarker {
	readonly selector: string;
	readonly rule: string;
	readonly severity: string;
}

/** What the preview owner provides: measuring the page, and marking findings on it. */
export interface IDesignScanSource {
	scan(viewport: ViewportLabel): Promise<DesignScanOutcome>;
	showFindings(items: readonly IDesignFindingMarker[]): void;
}

export const IVibeDesignScanService = createDecorator<IVibeDesignScanService>('vibeDesignScanService');

export interface IVibeDesignScanService {
	readonly _serviceBrand: undefined;
	/** Called by whoever owns the preview; the returned disposable unregisters the source. */
	registerSource(source: IDesignScanSource): IDisposable;
	/** Measures the previewed page at one viewport width, or explains why it could not. */
	scan(viewport?: ViewportLabel): Promise<DesignScanOutcome>;
	/** Draws the findings on the previewed page; an empty list clears them. No-op without a preview. */
	showFindings(items: readonly IDesignFindingMarker[]): void;
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

	private _source: IDesignScanSource | undefined;

	registerSource(source: IDesignScanSource): IDisposable {
		this._source = source;
		return toDisposable(() => {
			if (this._source === source) {
				this._source = undefined;
			}
		});
	}

	async scan(viewport: ViewportLabel = 'desktop'): Promise<DesignScanOutcome> {
		if (!this._source) {
			// No preview machinery is alive yet — indistinguishable, from the caller's side, from
			// having no preview open, and reported as such rather than as an empty result.
			return { ok: false, reason: 'no-preview' };
		}
		return this._source.scan(viewport);
	}

	showFindings(items: readonly IDesignFindingMarker[]): void {
		this._source?.showFindings(items);
	}
}

registerSingleton(IVibeDesignScanService, VibeDesignScanService, InstantiationType.Delayed);
