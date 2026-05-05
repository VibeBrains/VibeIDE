/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { localize } from '../../../../nls.js';
import { asText } from '../../../../platform/request/common/request.js';

/**
 * VibeIDE Extension Security Scanner.
 * When extension installed from Open VSX: check via socket.dev API.
 * Open VSX does NOT do manual review — we fill the gap.
 */
export class VibeExtensionSecurityScannerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeExtensionSecurityScanner';

	private readonly SCANNED_KEY = 'vibeide.scannedExtensions';
	private _scannedIds: Set<string>;

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IRequestService private readonly _requestService: IRequestService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		const stored = this._storageService.get(this.SCANNED_KEY, StorageScope.APPLICATION) || '[]';
		this._scannedIds = new Set(JSON.parse(stored));

		// Scan when extensions change
		this._register(this._extensionService.onDidChangeExtensions(() => {
			this._scanNewExtensions();
		}));
	}

	private async _scanNewExtensions(): Promise<void> {
		const extensions = this._extensionService.extensions;
		const newExts = extensions.filter(e => !this._scannedIds.has(e.identifier.value));

		for (const ext of newExts.slice(0, 3)) { // Limit to avoid rate limiting
			await this._scanExtension(ext.identifier.value, ext.displayName || ext.identifier.value);
			this._scannedIds.add(ext.identifier.value);
		}

		this._storageService.store(this.SCANNED_KEY, JSON.stringify([...this._scannedIds]),
			StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private async _scanExtension(id: string, name: string): Promise<void> {
		try {
			// Use socket.dev API for security scanning
			const [publisher, extName] = id.split('.');
			const url = `https://socket.dev/api/v0/report/npm/${publisher}.${extName}`;

			const response = await this._requestService.request(
				{ url, type: 'GET', callSite: 'vibeide-extension-socket-scan' },
				CancellationToken.None
			);

			if (response.res.statusCode === 200) {
				const text = await asText(response);
				const data = text ? JSON.parse(text) : null;

				if (data?.issues?.length > 0) {
					const critical = data.issues.filter((i: any) => i.severity === 'critical' || i.severity === 'high');
					if (critical.length > 0) {
						this._notificationService.notify({
							severity: Severity.Warning,
							message: localize(
								'vibeExtScan',
								'⚠️ Extension {0} flagged by security scan: {1} issue(s). Review before use.',
								name, critical.length
							),
						});
					}
				}
			}
		} catch {
			// Scan failed — silently skip (don't block extension install)
		}
	}
}

registerWorkbenchContribution2(
	VibeExtensionSecurityScannerContribution.ID,
	VibeExtensionSecurityScannerContribution,
	WorkbenchPhase.AfterRestored
);
