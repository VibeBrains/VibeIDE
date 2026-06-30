/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { localize } from '../../../../nls.js';

export interface ExtensionCapabilities {
	extensionId: string;
	name: string;
	capabilities: string[]; // e.g. ['filesystem', 'network', 'shell', 'clipboard']
	riskLevel: 'low' | 'medium' | 'high';
}

// High-risk capability patterns (similar to mobile OS permissions)
const HIGH_RISK_CAPS = ['shell', 'process', 'terminal', 'exec'];
const MEDIUM_RISK_CAPS = ['network', 'http', 'fetch', 'websocket'];

export const IVibeExtensionPermissionsService = createDecorator<IVibeExtensionPermissionsService>('vibeExtensionPermissionsService');

export interface IVibeExtensionPermissionsService {
	readonly _serviceBrand: undefined;
	getExtensionCapabilities(extensionId: string): ExtensionCapabilities | null;
	showPermissionsOnInstall(extensionId: string): void;
	readonly onPermissionsShown: Event<ExtensionCapabilities>;
}

/**
 * VibeIDE Extension Permissions UI.
 * Shows capability declarations when extension is installed — like mobile OS permissions.
 * Integrates with Extension security scanner.
 */
class VibeExtensionPermissionsService extends Disposable implements IVibeExtensionPermissionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onPermissionsShown = this._register(new Emitter<ExtensionCapabilities>());
	readonly onPermissionsShown = this._onPermissionsShown.event;

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IExtensionService private readonly _extensionService: IExtensionService,
	) {
		super();

		// Show permissions on new extension installs
		this._register(this._extensionService.onDidChangeExtensions(() => {
			// Phase 2: detect newly installed extensions and show permissions
		}));
	}

	getExtensionCapabilities(extensionId: string): ExtensionCapabilities | null {
		const ext = this._extensionService.extensions.find(
			e => e.identifier.value.toLowerCase() === extensionId.toLowerCase()
		);
		if (!ext) { return null; }

		// Analyze extension manifest for capabilities
		const caps: string[] = [];
		const extensionKind = Array.isArray(ext.extensionKind) ? ext.extensionKind : ext.extensionKind ? [ext.extensionKind] : [];

		if (extensionKind.includes('workspace')) { caps.push('filesystem'); }
		if (ext.contributes?.commands?.some(c => c.command.includes('terminal'))) { caps.push('terminal'); }

		const riskLevel = caps.some(c => HIGH_RISK_CAPS.includes(c)) ? 'high'
			: caps.some(c => MEDIUM_RISK_CAPS.includes(c)) ? 'medium' : 'low';

		return {
			extensionId,
			name: ext.displayName || extensionId,
			capabilities: caps,
			riskLevel,
		};
	}

	showPermissionsOnInstall(extensionId: string): void {
		const caps = this.getExtensionCapabilities(extensionId);
		if (!caps) { return; }

		if (caps.riskLevel !== 'low') {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeExtensionPermissions',
					'Extension {0} requests: {1}. Risk level: {2}.',
					caps.name,
					caps.capabilities.join(', ') || 'standard capabilities',
					caps.riskLevel.toUpperCase()
				),
			});
		}

		this._onPermissionsShown.fire(caps);
		vibeLog.debug('ExtPermissions', `${extensionId}: ${caps.riskLevel} risk`);
	}
}

registerSingleton(IVibeExtensionPermissionsService, VibeExtensionPermissionsService, InstantiationType.Delayed);
