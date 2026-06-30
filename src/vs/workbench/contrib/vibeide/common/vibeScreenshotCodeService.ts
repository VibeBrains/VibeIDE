/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibePrivacyStripperService } from './vibePrivacyStripperService.js';

export const IVibeScreenshotCodeService = createDecorator<IVibeScreenshotCodeService>('vibeScreenshotCodeService');

export interface ScreenshotContext {
	imageData: string; // base64
	mimeType: string;
	isPrivacyModeEnabled: boolean;
	destinationProvider?: string; // where image will be sent
}

export interface IVibeScreenshotCodeService {
	readonly _serviceBrand: undefined;

	/**
	 * Prepare screenshot for code generation workflow.
	 * Shows privacy warning about where image goes.
	 * In privacy mode: only local vision models allowed.
	 */
	prepareScreenshot(context: ScreenshotContext): {
		allowed: boolean;
		warning?: string;
		requiresPrivacyConsent?: boolean;
	};

	/** Get warning message for first-time image send */
	getFirstSendWarning(providerName: string, isPrivacyMode: boolean): string;
}

/**
 * VibeIDE Screenshot → Code Workflow.
 * Explicit UX for vision pipeline with privacy warnings.
 * In privacy mode: only local vision models.
 */
class VibeScreenshotCodeService extends Disposable implements IVibeScreenshotCodeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibePrivacyStripperService private readonly _privacyStripper: IVibePrivacyStripperService,
	) {
		super();
	}

	prepareScreenshot(context: ScreenshotContext): {
		allowed: boolean;
		warning?: string;
		requiresPrivacyConsent?: boolean;
	} {
		const isCloudProvider = context.destinationProvider &&
			!['ollama', 'lmstudio', 'local'].includes(context.destinationProvider.toLowerCase());

		if (context.isPrivacyModeEnabled && isCloudProvider) {
			const msg = `Privacy mode is enabled. Images cannot be sent to ${context.destinationProvider}. Use a local vision model (Ollama) or disable privacy mode.`;
			return {
				allowed: false,
				warning: this._privacyStripper.strip(msg),
			};
		}

		if (isCloudProvider) {
			return {
				allowed: true,
				requiresPrivacyConsent: true,
				warning: this._privacyStripper.strip(this.getFirstSendWarning(context.destinationProvider!, false)),
			};
		}

		return { allowed: true };
	}

	getFirstSendWarning(providerName: string, isPrivacyMode: boolean): string {
		if (isPrivacyMode) {
			return `⚠️ Privacy mode: this image will NOT be sent to ${providerName}. Only local vision models are available.`;
		}
		return `⚠️ This screenshot will be sent to ${providerName} for processing. Ensure it contains no sensitive information (passwords, API keys, confidential data). Enable Privacy mode to use local-only vision.`;
	}
}

registerSingleton(IVibeScreenshotCodeService, VibeScreenshotCodeService, InstantiationType.Eager);
