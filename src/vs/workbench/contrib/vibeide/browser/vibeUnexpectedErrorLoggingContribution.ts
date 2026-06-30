/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeUnexpectedErrorLoggingContribution.
 *
 * Global unexpected errors flow through core `onUnexpectedError` → the user sees a generic
 * "Произошла неизвестная ошибка. Подробности — в журнале" notification, but the actual
 * message/stack was NOT written to a place the user can easily retrieve (the renderer console
 * shows it, but the "copy logs" affordance reads the ILogService journal). This contribution
 * registers an additional listener on the shared error handler and writes the full detail to
 * the log so "Подробности — в журнале" actually holds them.
 *
 * Non-invasive: `addListener` runs ALONGSIDE the existing default handler (which still rethrows
 * for telemetry); we only observe. The listener swallows its own failures so the error sink can
 * never throw recursively.
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { errorHandler } from '../../../../base/common/errors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';

class VibeUnexpectedErrorLoggingContribution extends Disposable {

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(toDisposable(errorHandler.addListener(err => {
			try {
				if (!err) { return; }
				let detail: string;
				if (err instanceof Error) {
					detail = err.stack || `${err.name}: ${err.message}`;
				} else if (typeof err === 'string') {
					detail = err;
				} else if (typeof Event !== 'undefined' && err instanceof Event) {
					// DOM Event (e.g. a resource-load `error` on <script>/<img>, or an
					// ErrorEvent). JSON.stringify on these yields a useless `{"isTrusted":true}`
					// because their fields are non-enumerable — extract the useful bits by hand.
					const ev = err as Event & { message?: unknown; filename?: unknown; error?: unknown; target?: { src?: unknown; href?: unknown } | null };
					const parts: string[] = [`Event(${ev.type ?? 'unknown'})`];
					if (ev.message) { parts.push(String(ev.message)); }
					const src = ev.filename || ev.target?.src || ev.target?.href;
					if (src) { parts.push(`src=${src}`); }
					if (ev.error instanceof Error) { parts.push(ev.error.stack || `${ev.error.name}: ${ev.error.message}`); }
					detail = parts.join(' ');
				} else {
					try { detail = JSON.stringify(err); } catch { detail = String(err); }
				}
				// Known, already-handled noise — do NOT log as "unexpected": the bundled
				// @xterm/addon-ligatures ships only an `.mjs` whose runtime load resolves to undefined;
				// xtermTerminal catches it and disables ligatures gracefully (one warn), but the
				// resource-load Event / TypeError still reaches this global handler on every terminal
				// mount. Match on the addon name (stable across both the Event and TypeError forms).
				if (detail.includes('LigaturesAddon') || detail.includes('addon-ligatures')) { return; }
				// Benign async-diff race: the core diff provider throws "no diff result available" when the
				// model is disposed/changed before its async computation finishes (transient edit/diff
				// previews tear down faster than the worker resolves). Harmless — the preview just doesn't
				// render — but it surfaced here as repeated [VibeIDE/unexpected] noise. NOTE: the distinct
				// "TextModel disposed before DiffEditorWidget model got reset" click-crash is a SEPARATE
				// string and is NOT muted by this.
				if (detail.includes('no diff result available')) { return; }
				this._logService.error(`[VibeIDE/unexpected] ${detail}`);
			} catch {
				// The error sink must never throw — a failure here would recurse through onUnexpectedError.
			}
		})));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	VibeUnexpectedErrorLoggingContribution,
	LifecyclePhase.Restored
);
