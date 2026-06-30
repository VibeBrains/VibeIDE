/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/** GitHub release asset from release-manifest.json (CI: scripts/vibe-release-manifest.mjs). */
export type VibeideVerifiedDownload = {
	url: string;
	sha256: string;
	fileName: string;
};

export type VibeideCheckUpdateResponse = {
	message: string;
	action?: 'reinstall' | 'restart' | 'download' | 'apply';
	/** When set, Reinstall downloads this file in main process and verifies SHA-256 before revealing in folder. */
	verifiedDownload?: VibeideVerifiedDownload;
} | {
	message: null;
	actions?: undefined;
} | null;


