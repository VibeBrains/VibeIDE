/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Installing agents from the ACP Registry — the part that needs the network and the disk, so it lives
 * in the main process. What to install and why is decided in `acpRegistry.ts`; here it only happens.
 */

import { AcpArchiveFormat } from './acpRegistry.js';

export const VIBE_ACP_INSTALLER_CHANNEL = 'vibeide-channel-acp-installer';

export interface IAcpBinaryInstallRequest {
	readonly agentId: string;
	readonly version: string;
	readonly archive: string;
	/** Lowercase hex; the download is refused unless it matches. */
	readonly sha256: string;
	readonly format: AcpArchiveFormat;
	/** The command inside the archive, relative to its root. */
	readonly cmd: string;
}

export interface IVibeAcpInstaller {
	/** The registry file as JSON; https only, localhost aside, and size-capped. */
	fetchRegistry(url: string): Promise<unknown>;
	/** Download, verify, unpack; resolves to the absolute path of the command. Reuses a verified install. */
	installBinary(request: IAcpBinaryInstallRequest): Promise<string>;
	/** Remove one installed version — after an update has installed the next one. */
	removeBinary(agentId: string, version: string): Promise<void>;
}
