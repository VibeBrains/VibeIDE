/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Downloads and unpacks binary agents from the ACP Registry into the profile.
 *
 * The digest is computed while the bytes arrive and compared before anything is unpacked: a download
 * that does not match the registry's `sha256` never reaches the disk as an agent. Unpacking goes into a
 * staging folder that is renamed into place only when the command is found inside it, so a failed
 * install leaves nothing half-made that a later run would take for a finished one.
 */

import { net } from 'electron';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as tar from 'tar';
import { dirname, join, relative, resolve, sep } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { extract } from '../../../../../base/node/zip.js';
import { IAcpBinaryInstallRequest, IVibeAcpInstaller } from '../../common/acp/acpInstallerTypes.js';
import { vibeLog } from '../../common/vibeLog.js';

/** The registry file is a list of a few dozen agents; anything much bigger is not it. */
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;
/** Agent archives are tens of megabytes; this caps a runaway or hostile download. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
/** Generous for a slow link, finite so a stalled download does not hang the window's request forever. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Written last: its presence, with the digest inside, is what makes a folder a finished install. */
const INSTALLED_MARKER = '.vibe-installed';
/** An id or a version becomes a folder name: nothing that could climb out of the install root. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class VibeAcpInstallerMainService implements IVibeAcpInstaller {

	constructor(private readonly _root: string) { }

	async fetchRegistry(url: string): Promise<unknown> {
		assertFetchable(url);
		const chunks: Uint8Array[] = [];
		await download(url, MAX_REGISTRY_BYTES, async chunk => { chunks.push(chunk); });
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	}

	async installBinary(request: IAcpBinaryInstallRequest): Promise<string> {
		const dir = this._versionDir(request.agentId, request.version);
		const reused = await this._verifiedCommand(dir, request);
		if (reused) {
			return reused;
		}
		assertFetchable(request.archive);
		await fs.mkdir(this._root, { recursive: true });
		const staging = join(this._root, `.staging-${generateUuid()}`);
		const archivePath = join(this._root, `.download-${generateUuid()}`);
		try {
			// Written as it arrives: an archive is tens of megabytes and must not sit in memory whole.
			const file = await fs.open(archivePath, 'w');
			let sha256: string;
			try {
				sha256 = await download(request.archive, MAX_ARCHIVE_BYTES, async chunk => { await file.write(chunk); });
			} finally {
				await file.close();
			}
			if (sha256 !== request.sha256.toLowerCase()) {
				throw new Error(`контрольная сумма не совпала с реестром: ожидалась ${request.sha256}, пришла ${sha256}`);
			}
			await fs.mkdir(staging, { recursive: true });
			await unpack(archivePath, staging, request);
			const command = resolve(staging, request.cmd);
			if (!command.startsWith(staging + sep)) {
				throw new Error(`команда «${request.cmd}» указывает за пределы архива`);
			}
			await fs.access(command);
			if (!isWindows) {
				await fs.chmod(command, 0o755);
			}
			await fs.writeFile(join(staging, INSTALLED_MARKER), request.sha256.toLowerCase());
			await fs.rm(dir, { recursive: true, force: true });
			await fs.mkdir(join(this._root, request.agentId), { recursive: true });
			await fs.rename(staging, dir);
			vibeLog.info('ACP', `${request.agentId} ${request.version} установлен из реестра в ${dir}`);
			return join(dir, relative(staging, command));
		} finally {
			await fs.rm(archivePath, { force: true });
			await fs.rm(staging, { recursive: true, force: true });
		}
	}

	async removeBinary(agentId: string, version: string): Promise<void> {
		await fs.rm(this._versionDir(agentId, version), { recursive: true, force: true });
	}

	private _versionDir(agentId: string, version: string): string {
		if (!SAFE_SEGMENT.test(agentId) || !SAFE_SEGMENT.test(version)) {
			throw new Error(`недопустимые id или версия агента: «${agentId}» / «${version}»`);
		}
		return join(this._root, agentId, version);
	}

	/** A finished install of the same digest: the command path, or nothing when it must be (re)installed. */
	private async _verifiedCommand(dir: string, request: IAcpBinaryInstallRequest): Promise<string | undefined> {
		try {
			const marker = (await fs.readFile(join(dir, INSTALLED_MARKER), 'utf8')).trim();
			const command = resolve(dir, request.cmd);
			if (marker !== request.sha256.toLowerCase() || !command.startsWith(dir + sep)) {
				return undefined;
			}
			await fs.access(command);
			return command;
		} catch {
			return undefined;
		}
	}
}

/** https, or plain http to this machine only: the registry and the archives are fetched from the internet. */
function assertFetchable(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`не адрес: ${url}`);
	}
	const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
		throw new Error(`скачивание разрешено только по https: ${url}`);
	}
}

/** Stream the body into `sink`, computing its SHA-256 as the bytes arrive; refused past `limit`. */
async function download(url: string, limit: number, sink: (chunk: Uint8Array) => Promise<void>): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	try {
		const response = await net.fetch(url, { signal: controller.signal });
		if (!response.ok || !response.body) {
			throw new Error(`${url}: HTTP ${response.status}`);
		}
		const hash = createHash('sha256');
		let size = 0;
		const reader = response.body.getReader();
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			size += next.value.byteLength;
			if (size > limit) {
				controller.abort();
				throw new Error(`${url}: больше ${Math.round(limit / 1024 / 1024)} МБ — скачивание прервано`);
			}
			hash.update(next.value);
			await sink(next.value);
		}
		return hash.digest('hex');
	} finally {
		clearTimeout(timer);
	}
}

async function unpack(archivePath: string, target: string, request: IAcpBinaryInstallRequest): Promise<void> {
	switch (request.format) {
		case 'zip':
			await extract(archivePath, target, {}, CancellationToken.None);
			return;
		case 'tar.gz':
			// node-tar strips absolute paths and `..` entries unless told otherwise.
			await tar.x({ file: archivePath, cwd: target, strict: true });
			return;
		case 'raw': {
			const destination = resolve(target, request.cmd);
			await fs.mkdir(dirname(destination), { recursive: true });
			await fs.copyFile(archivePath, destination);
			return;
		}
	}
}
