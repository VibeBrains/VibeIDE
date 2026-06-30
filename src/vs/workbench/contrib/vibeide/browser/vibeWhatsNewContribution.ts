/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «Что нового» — on startup, if the running `vibeVersion` has curated highlights (see
 * `common/vibeWhatsNew.ts`) AND the user hasn't dismissed THIS version with the checkbox, show a
 * modal. Closing WITHOUT the checkbox (ESC / «Понятно») leaves it to re-appear next launch; ticking
 * «Больше не показывать» records the version so it stops — until the next update bumps the version.
 *
 * State lives in `IStorageService` (APPLICATION scope → per-install, survives workspace switches).
 */

import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IVibeModalService } from '../common/vibeModalService.js';
import { getWhatsNewForVersion } from '../common/vibeWhatsNew.js';

/** APPLICATION-scope key holding the `vibeVersion` the user acknowledged with «don't show again». */
const ACKNOWLEDGED_VERSION_KEY = 'vibeide.whatsNew.acknowledgedVersion';

export class VibeWhatsNewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideWhatsNew';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@IVibeModalService private readonly modalService: IVibeModalService,
	) {
		super();
		void this._maybeShowWhatsNew();
	}

	private async _maybeShowWhatsNew(): Promise<void> {
		try {
			const version = this.productService.vibeVersion;
			if (!version) { return; }

			// No curated highlights for this version → nothing to announce (e.g. a silent patch).
			const body = getWhatsNewForVersion(version);
			if (!body) { return; }

			// Show on EVERY launch until the user dismisses THIS version with the checkbox.
			const acknowledged = this.storageService.get(ACKNOWLEDGED_VERSION_KEY, StorageScope.APPLICATION);
			if (acknowledged === version) { return; }

			const result = await this.modalService.showModal({
				title: `Что нового в VibeIDE ${version}`,
				body,
				bodyMarkdown: true,
				size: 'large',
				icon: 'megaphone',
				checkbox: { label: 'Больше не показывать для этой версии' },
				buttons: [{ id: 'ok', label: 'Понятно', role: 'primary' }],
			});

			// Record the version only when the checkbox was ticked (honoured on any close path).
			if (result.checked) {
				this.storageService.store(ACKNOWLEDGED_VERSION_KEY, version, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
		} catch (e) {
			// Diagnostic-only — a What's New failure must never block startup.
			vibeLog.warn('whatsNew', '[WhatsNew] failed to present', e);
		}
	}
}

registerWorkbenchContribution2(VibeWhatsNewContribution.ID, VibeWhatsNewContribution, WorkbenchPhase.AfterRestored);
