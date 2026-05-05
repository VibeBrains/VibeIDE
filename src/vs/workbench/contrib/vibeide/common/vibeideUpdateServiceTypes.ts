/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

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


