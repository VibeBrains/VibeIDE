/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `vibeide.dev.memorySnapshot` — dev-mode-only Action2 (roadmap L1037).
 *
 * First invocation captures a baseline through `process.memoryUsage()` and
 * persists it in `IStorageService` (APPLICATION scope). Second invocation
 * compares baseline vs current through the pure `classifyHeapGrowth` helper
 * (5-way verdict with both-pct-AND-bytes leak guard) and dumps the markdown
 * report to a dedicated Output channel.
 *
 * Guarded by `!IEnvironmentService.isBuilt` so a production build refuses
 * to expose the action (the Action2 still registers — guard fires inside
 * `run()`). This keeps the Command Palette free of dev-only noise in prod
 * via `precondition` AND fails closed if the precondition was bypassed.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Extensions, IOutputChannelRegistry, IOutputService } from '../../../services/output/common/output.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { HeapSnapshot, classifyHeapGrowth, decodeHeapSnapshot, renderHeapGrowthMarkdown } from '../common/heapGrowthClassifier.js';

const STORAGE_KEY = 'vibeide.dev.memorySnapshotBaseline.v1';
const CHANNEL_ID = 'vibeide-memory-snapshot';

function ensureChannel(): void {
	const reg = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels);
	if (!reg.getChannel(CHANNEL_ID)) {
		reg.registerChannel({
			id: CHANNEL_ID,
			label: localize('vibeide.memorySnapshot.channel', 'VibeIDE — Memory Snapshot'),
			log: false,
		});
	}
}

function captureCurrent(): HeapSnapshot {
	// Cast through unknown: vscode types may not have process declared in all surfaces.
	const mem = (globalThis as unknown as { process?: { memoryUsage?: () => NodeJS.MemoryUsage } }).process?.memoryUsage?.();
	return {
		capturedAtMs: Date.now(),
		heapUsedBytes: mem?.heapUsed ?? 0,
		heapTotalBytes: mem?.heapTotal ?? 0,
		externalBytes: mem?.external,
		arrayBuffersBytes: mem?.arrayBuffers,
	};
}

class VibeMemorySnapshotAction extends Action2 {
	static readonly ID = 'vibeide.dev.memorySnapshot';

	constructor() {
		super({
			id: VibeMemorySnapshotAction.ID,
			title: localize2('vibeide.dev.memorySnapshot.title', 'Снять снапшот памяти'),
			category: { value: 'VibeIDE Dev', original: 'VibeIDE Dev' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const env = accessor.get(IEnvironmentService);
		const notifications = accessor.get(INotificationService);

		// Production guard: refuse in built mode to avoid surfacing internal
		// allocation patterns to end users.
		if (env.isBuilt) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.dev.memorySnapshot.prodRefused', 'Memory snapshot — только в dev-сборке.'),
			});
			return;
		}

		const storage = accessor.get(IStorageService);
		const outputService = accessor.get(IOutputService);

		const current = captureCurrent();
		const raw = storage.get(STORAGE_KEY, StorageScope.APPLICATION, undefined);

		// First invocation → save baseline + notify.
		if (raw === undefined) {
			storage.store(STORAGE_KEY, JSON.stringify(current), StorageScope.APPLICATION, StorageTarget.MACHINE);
			notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.dev.memorySnapshot.baselineSet',
					'Memory baseline сохранён ({0} MB heapUsed). Запустите команду снова после нагрузки, чтобы увидеть классификацию.',
					(current.heapUsedBytes / 1024 / 1024).toFixed(1),
				),
			});
			return;
		}

		// Subsequent invocation → classify + dump to Output channel.
		let baseline: HeapSnapshot | null = null;
		try {
			baseline = decodeHeapSnapshot(JSON.parse(raw));
		} catch { /* corrupt baseline */ }
		if (baseline === null) {
			storage.store(STORAGE_KEY, JSON.stringify(current), StorageScope.APPLICATION, StorageTarget.MACHINE);
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.dev.memorySnapshot.baselineCorrupt', 'Сохранённый baseline повреждён, пересоздан.'),
			});
			return;
		}

		const diff = classifyHeapGrowth(baseline, current);
		const md = renderHeapGrowthMarkdown(diff);
		ensureChannel();
		const ch = outputService.getChannel(CHANNEL_ID);
		if (ch) {
			ch.append(md + '\n');
			await outputService.showChannel(CHANNEL_ID, true);
		}
		notifications.notify({
			severity: diff.classification === 'leak-suspicious' ? Severity.Warning : Severity.Info,
			message: localize(
				'vibeide.dev.memorySnapshot.classified',
				'Memory: {0} (heapUsed Δ {1} MB / {2}%).',
				diff.classification,
				(diff.deltaUsedBytes / 1024 / 1024).toFixed(1),
				(diff.deltaUsedPct * 100).toFixed(1),
			),
		});
	}
}

registerAction2(VibeMemorySnapshotAction);
