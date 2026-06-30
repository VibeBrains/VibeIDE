/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pre-flight previous-crash notification (roadmap W.14).
 *
 * On startup, fetches the tail of the latest `.jsonl` from the watchdog through
 * the IPC proxy. If a `type:'crash'` entry exists within the last 24 hours and
 * no `first-tick` for the same process follows it, surfaces an informational
 * notification with actions:
 *   — Bundle crash report
 *   — Dismiss
 *
 * Quietly does nothing when no crash is found, when the watchdog is disabled,
 * or when reading the tail fails. Hides itself behind a 5-second delay so that
 * the IDE finishes loading before any toast appears.
 *
 * @see common/vibeIdleWatchdogProxy.ts — `readRecentTail` / `bundleCrashReport`.
 */

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IVibeIdleWatchdogProxy } from '../common/vibeIdleWatchdogProxy.js';
import type { WatchdogCrashEntry, WatchdogLine } from '../common/vibeIdleWatchdogTypes.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const PREFLIGHT_DELAY_MS = 5_000;
const SLOPE_SNAPSHOT_KEY = 'vibeide.diagnostics.idleWatchdog.snapshotRenderersOnCommitSlope';

function isCrash(line: WatchdogLine): line is WatchdogCrashEntry {
	return (line as { type?: string }).type === 'crash';
}

function findUnresolvedCrash(lines: readonly WatchdogLine[]): WatchdogCrashEntry | undefined {
	const now = Date.now();
	let candidate: WatchdogCrashEntry | undefined;
	for (const line of lines) {
		const ts = Date.parse((line as { ts?: string }).ts ?? '');
		if (!Number.isFinite(ts) || now - ts > TWENTY_FOUR_HOURS_MS) { continue; }
		if (isCrash(line)) {
			candidate = line;
		} else if (candidate && (line as { type?: string }).type === 'sample') {
			// A `first-tick` (note='first-tick') sample following the crash indicates
			// that the affected process restarted successfully — clear the candidate.
			const sample = line as { note?: string; proc?: string };
			if (sample.note === 'first-tick' && sample.proc === candidate.proc) {
				candidate = undefined;
			}
		}
	}
	return candidate;
}

export class VibeIdleWatchdogPreFlightContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeIdleWatchdogPreFlight';

	private readonly _delayTimer = this._register(new MutableDisposable());

	constructor(
		@IVibeIdleWatchdogProxy private readonly _watchdog: IVibeIdleWatchdogProxy,
		@INotificationService private readonly _notifications: INotificationService,
		@IFileDialogService private readonly _fileDialog: IFileDialogService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._scheduleCheck();
	}

	private _scheduleCheck(): void {
		const handle = setTimeout(() => { void this._runCheck(); }, PREFLIGHT_DELAY_MS);
		this._delayTimer.value = { dispose: () => clearTimeout(handle) };
	}

	private async _runCheck(): Promise<void> {
		let lines: readonly WatchdogLine[] = [];
		try {
			lines = await this._watchdog.readRecentTail(200);
		} catch {
			return;
		}
		const crash = findUnresolvedCrash(lines);
		if (!crash) { return; }

		const procLabel = this._procLabel(crash.proc);
		const reason = crash.reason ?? 'unknown';
		const lastTickRef = crash.lastTickRef ?? '—';

		const primary = [
			{
				id: 'vibeide.watchdog.preFlight.bundle',
				label: localize('vibeide.watchdog.preFlight.bundle', 'Собрать crash report'),
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => { void this._bundleCrashReport(); },
			},
		];

		// W.56/W.55 — for a renderer death, offer to arm the commit-slope heap
		// snapshot so the NEXT balloon dumps the culprit's retained objects. Only
		// when it isn't already on (heavy, opt-in). Closes the «видим OOM, не видим
		// причину» loop straight from the crash notification.
		const slopeSnapshotOn = this._configuration.getValue<boolean>(SLOPE_SNAPSHOT_KEY) === true;
		if (crash.proc === 'renderer' && !slopeSnapshotOn) {
			primary.push({
				id: 'vibeide.watchdog.preFlight.armDiag',
				label: localize('vibeide.watchdog.preFlight.armDiag', 'Вооружить диагностику памяти'),
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => { void this._armMemoryDiagnostics(); },
			});
		}

		primary.push({
			id: 'vibeide.watchdog.preFlight.dismiss',
			label: localize('vibeide.watchdog.preFlight.dismiss', 'Пропустить'),
			tooltip: '',
			class: undefined,
			enabled: true,
			run: () => { /* no-op */ },
		});

		this._notifications.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.watchdog.preFlight.message',
				'VibeIDE: предыдущая сессия завершилась аварией {0} (причина: {1}, последний tick: {2}). Собрать crash report для анализа?',
				procLabel,
				reason,
				lastTickRef,
			),
			actions: { primary },
		});
	}

	private async _armMemoryDiagnostics(): Promise<void> {
		try {
			await this._configuration.updateValue(SLOPE_SNAPSHOT_KEY, true, ConfigurationTarget.APPLICATION);
			this._notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.watchdog.preFlight.armDiagDone',
					'Диагностика памяти включена: при следующем росте commit-памяти renderer будет снят heap snapshot для анализа причины. Снимок сохраняется локально.',
				),
			});
		} catch (e) {
			this._notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.watchdog.preFlight.armDiagFailed', 'Не удалось включить диагностику памяти: {0}', e instanceof Error ? e.message : String(e)),
			});
		}
	}

	private _procLabel(proc: string): string {
		switch (proc) {
			case 'renderer': return 'окна редактора';
			case 'exthost': return 'расширений';
			case 'gpu': return 'GPU';
			case 'utility': return 'служебного процесса';
			default: return proc;
		}
	}

	private async _bundleCrashReport(): Promise<void> {
		const defaultFolder = await this._fileDialog.defaultFilePath('file');
		// `URI.joinPath` handles platform path separator correctly; pre-W.22 used
		// string concatenation `defaultUri.fsPath + '/vibeide-crash-report.zip'`
		// which produced `C:\Users\foo/vibeide-crash-report.zip` on Windows — broke
		// the save dialog's default filename suggestion.
		const defaultUri = defaultFolder ? joinPath(defaultFolder, 'vibeide-crash-report.zip') : undefined;
		const target = await this._fileDialog.showSaveDialog({
			title: localize('vibeide.watchdog.preFlight.saveTitle', 'Сохранить crash report'),
			defaultUri,
			filters: [{ name: 'ZIP', extensions: ['zip'] }],
		});
		if (!target) { return; }
		try {
			const result = await this._watchdog.bundleCrashReport(target.fsPath);
			this._notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.watchdog.preFlight.bundleDone',
					'Crash report сохранён ({0} файл(ов), {1} МБ): {2}',
					result.fileCount,
					(result.sizeBytes / (1024 * 1024)).toFixed(1),
					result.outputPath,
				),
			});
		} catch (e) {
			this._notifications.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeide.watchdog.preFlight.bundleFailed',
					'Не удалось собрать crash report: {0}',
					e instanceof Error ? e.message : String(e),
				),
			});
		}
	}
}

registerWorkbenchContribution2(
	VibeIdleWatchdogPreFlightContribution.ID,
	VibeIdleWatchdogPreFlightContribution,
	WorkbenchPhase.Eventually,
);
