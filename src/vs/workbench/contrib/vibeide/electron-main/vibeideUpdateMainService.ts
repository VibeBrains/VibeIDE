/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createHash, randomBytes } from 'crypto';
import { createWriteStream, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URL } from 'url';
import { shell } from 'electron';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import * as semver from '../../../../base/common/semver/semver.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IHeaders } from '../../../../base/parts/request/common/request.js';
import { localize } from '../../../../nls.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';

import { IVibeideUpdateService } from '../common/vibeideUpdateService.js';
import { VibeideCheckUpdateResponse, VibeideVerifiedDownload } from '../common/vibeideUpdateServiceTypes.js';

/** GitHub release-manifest.json produced by scripts/vibe-release-manifest.mjs */
interface IReleaseManifestEntry {
	readonly basename: string;
	readonly sha256: string;
}

interface IReleaseManifest {
	readonly schemaVersion?: number;
	readonly assets?: Readonly<Record<string, IReleaseManifestEntry>>;
}

/** GitHub release asset from API */
interface IGithubReleaseAsset {
	readonly name?: string;
	readonly browser_download_url?: string;
}

/** GitHub release JSON (partial) */
interface IGithubRelease {
	readonly tag_name?: string;
	readonly assets?: readonly IGithubReleaseAsset[];
}

/** GitHub API response: either one release or array of releases */
type GithubReleaseApiPayload = IGithubRelease | IGithubRelease[] | unknown;

/** GitHub release tag or product version → comparable semver string, or null. */
function normalizeSemverVersion(raw: string | undefined): string | null {
	if (!raw) {
		return null;
	}
	const trimmed = raw.trim();
	const withoutV = /^v\d/i.test(trimmed) ? trimmed.slice(1) : trimmed;
	const coerced = semver.coerce(withoutV) ?? semver.coerce(trimmed);
	return coerced ? semver.valid(coerced) : null;
}

/**
 * True when the running build is not older than the latest GitHub release tag.
 * Unparseable remote tags are treated as up-to-date (avoid false-positive nag).
 */
function isCurrentBuildUpToDateVersusGitTag(localVersion: string, remoteTagName: string): boolean {
	const remote = normalizeSemverVersion(remoteTagName);
	const local = normalizeSemverVersion(localVersion);
	if (!remote) {
		return true;
	}
	if (!local) {
		return localVersion.trim() === remoteTagName.trim();
	}
	return semver.gte(local, remote);
}

function getReleaseManifestPlatformKey(): string | null {
	if (isWindows) {
		return process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
	}
	if (isMacintosh) {
		return 'darwin-universal';
	}
	if (isLinux) {
		return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
	}
	return null;
}

function findAssetDownloadUrl(assets: readonly IGithubReleaseAsset[] | undefined, basenameTarget: string): string | null {
	if (!Array.isArray(assets)) {
		return null;
	}
	const a = assets.find(x => x?.name === basenameTarget);
	return typeof a?.browser_download_url === 'string' ? a.browser_download_url : null;
}

export class VibeideMainUpdateService extends Disposable implements IVibeideUpdateService {
	_serviceBrand: undefined;

	private _releaseApiCache: { releaseUrl: string; etag: string; data: IGithubRelease; fetchedAt: number } | undefined;
	private readonly _minAutoCheckIntervalMs = 30 * 60 * 1000;

	constructor(
		@IProductService private readonly _productService: IProductService,
		@IEnvironmentMainService private readonly _envMainService: IEnvironmentMainService,
		@IUpdateService private readonly _updateService: IUpdateService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();
	}

	async check(explicit: boolean): Promise<VibeideCheckUpdateResponse> {

		const isDevMode = !this._envMainService.isBuilt; // found in abstractUpdateService.ts

		if (isDevMode) {
			return { message: null } as const;
		}

		// if disabled and not explicitly checking, return early
		if (this._updateService.state.type === StateType.Disabled) {
			if (!explicit) {
				return { message: null } as const;
			}
		}

		this._updateService.checkForUpdates(false); // implicity check, then handle result ourselves

		if (this._updateService.state.type === StateType.Uninitialized) {
			// The update service hasn't been initialized yet
			return { message: explicit ? localize('vibeide.update.checkingSoon', 'Скоро будет выполнена проверка обновлений...') : null, action: explicit ? 'reinstall' : undefined } as const;
		}

		if (this._updateService.state.type === StateType.Idle) {
			// No updates currently available
			return { message: explicit ? localize('vibeide.update.noneFound', 'Обновлений не найдено!') : null, action: explicit ? 'reinstall' : undefined } as const;
		}

		if (this._updateService.state.type === StateType.CheckingForUpdates) {
			// Currently checking for updates
			return { message: explicit ? localize('vibeide.update.checking', 'Проверка обновлений...') : null } as const;
		}

		if (this._updateService.state.type === StateType.AvailableForDownload) {
			// Update available but requires manual download (mainly for Linux)
			return { message: localize('vibeide.update.availableDownload', 'Доступно новое обновление!'), action: 'download', } as const;
		}

		if (this._updateService.state.type === StateType.Downloading) {
			// Update is currently being downloaded
			return { message: explicit ? localize('vibeide.update.downloading', 'Идёт загрузка обновления...') : null } as const;
		}

		if (this._updateService.state.type === StateType.Downloaded) {
			// Update has been downloaded but not yet ready
			return { message: explicit ? localize('vibeide.update.readyToApply', 'Обновление готово к установке!') : null, action: 'apply' } as const;
		}

		if (this._updateService.state.type === StateType.Updating) {
			// Update is being applied
			return { message: explicit ? localize('vibeide.update.applying', 'Применение обновления...') : null } as const;
		}

		if (this._updateService.state.type === StateType.Ready) {
			// Update is ready
			return { message: localize('vibeide.update.restartToUpdate', 'Перезапустите VibeIDE для применения обновления!'), action: 'restart' } as const;
		}

		if (this._updateService.state.type === StateType.Disabled) {
			const channel = this._configurationService.getValue<'stable' | 'beta' | 'nightly'>('update.updateChannel') || 'stable';
			return await this._manualCheckGHTagIfDisabled(explicit, channel);
		}
		return null;
	}

	async downloadVerifiedReleaseAsset(assetUrl: string, expectedSha256Hex: string, fileName: string): Promise<{ ok: true } | { ok: false; message: string }> {
		const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
		const tmp = join(tmpdir(), `vibeide-${randomBytes(8).toString('hex')}-${safeName}`);
		try {
			await this._downloadToFileWithSha256(assetUrl, tmp, expectedSha256Hex);
			shell.showItemInFolder(tmp);
			return { ok: true };
		} catch (e) {
			if (existsSync(tmp)) {
				try {
					unlinkSync(tmp);
				} catch {
					// ignore
				}
			}
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}

	private async _manualCheckGHTagIfDisabled(explicit: boolean, channel: 'stable' | 'beta' | 'nightly'): Promise<VibeideCheckUpdateResponse> {
		try {
			let releaseUrl: string;
			if (channel === 'beta') {
				releaseUrl = 'https://api.github.com/repos/VibeBrains/VibeIDE/releases?per_page=1';
			} else if (channel === 'nightly') {
				releaseUrl = 'https://api.github.com/repos/VibeBrains/VibeIDE/releases?per_page=1';
			} else {
				releaseUrl = 'https://api.github.com/repos/VibeBrains/VibeIDE/releases/latest';
			}

			const now = Date.now();
			let data: IGithubRelease;

			if (!explicit && this._releaseApiCache && this._releaseApiCache.releaseUrl === releaseUrl && (now - this._releaseApiCache.fetchedAt) < this._minAutoCheckIntervalMs) {
				data = this._releaseApiCache.data;
			} else {
				const headers: IHeaders = {
					'User-Agent': 'VibeIDE-UpdateCheck',
					'Accept': 'application/vnd.github+json',
				};
				if (this._releaseApiCache?.releaseUrl === releaseUrl && this._releaseApiCache.etag) {
					headers['If-None-Match'] = this._releaseApiCache.etag;
				}

				const context = await this._requestService.request({ url: releaseUrl, type: 'GET', headers, callSite: 'vibeideUpdate' }, CancellationToken.None);
				const code = context.res.statusCode;

				if (code === 304) {
					if (!this._releaseApiCache || this._releaseApiCache.releaseUrl !== releaseUrl) {
						throw new Error('GitHub API returned 304 without local cache');
					}
					this._releaseApiCache = { ...this._releaseApiCache, fetchedAt: now };
					data = this._releaseApiCache.data;
				} else if (code === 200) {
					const jsonData: GithubReleaseApiPayload = await asJson(context);
					const resolved = channel === 'stable'
						? jsonData as IGithubRelease
						: Array.isArray(jsonData) ? (jsonData[0] as IGithubRelease) : (jsonData as IGithubRelease);

					if (!resolved || !resolved.tag_name) {
						throw new Error('Invalid release data');
					}
					data = resolved;
					const rawEtag = context.res.headers['etag'] ?? context.res.headers['ETag'];
					const etag = Array.isArray(rawEtag) ? (rawEtag[0] ?? '') : (typeof rawEtag === 'string' ? rawEtag : '');
					this._releaseApiCache = { releaseUrl, etag, data, fetchedAt: now };
				} else {
					throw new Error(`GitHub API returned ${context.res.statusCode}`);
				}
			}

			const remoteTag = data.tag_name as string;

			const myVersion = this._productService.version;
			const isUpToDate = isCurrentBuildUpToDateVersusGitTag(myVersion, remoteTag);

			let verified: VibeideVerifiedDownload | undefined;
			try {
				verified = await this._resolveVerifiedDownload(data) ?? undefined;
			} catch {
				verified = undefined;
			}

			let message: string | null;
			let action: 'reinstall' | undefined;

			const msgAvailable = localize('vibeide.update.availableReinstall', 'Доступна новая версия VibeIDE! Выполните переустановку (автообновления отключены для этой ОС) — это займёт секунду!');
			const msgUpToDate = localize('vibeide.update.upToDate', 'VibeIDE обновлён до последней версии!');

			if (explicit) {
				if (!isUpToDate) {
					message = msgAvailable;
					action = 'reinstall';
				} else {
					message = msgUpToDate;
				}
			} else {
				if (!isUpToDate) {
					message = msgAvailable;
					action = 'reinstall';
				} else {
					message = null;
				}
			}
			const effectiveVerified = !isUpToDate ? verified : undefined;
			if (effectiveVerified) {
				return { message, action, verifiedDownload: effectiveVerified } as const;
			}
			return { message, action } as const;
		}
		catch (e) {
			if (explicit) {
				return {
					message: localize('vibeide.update.fetchReleaseError', 'Произошла ошибка при получении последнего тега релиза GitHub: {0}. Повторите попытку примерно через 5 минут.', String(e)),
					action: 'reinstall',
				};
			}
			else {
				return { message: null } as const;
			}
		}
	}

	private async _resolveVerifiedDownload(data: IGithubRelease): Promise<VibeideVerifiedDownload | null> {
		const key = getReleaseManifestPlatformKey();
		if (!key || !Array.isArray(data.assets)) {
			return null;
		}
		const manifestMeta = data.assets.find(a => a?.name === 'release-manifest.json');
		const manifestUrl = manifestMeta?.browser_download_url;
		if (!manifestUrl) {
			return null;
		}
		const ctx = await this._requestService.request({ url: manifestUrl, type: 'GET', callSite: 'vibeideUpdate-manifest' }, CancellationToken.None);
		if (ctx.res.statusCode !== 200) {
			return null;
		}
		const manifestUnknown: unknown = await asJson(ctx);
		const manifest = manifestUnknown as IReleaseManifest;
		const entry = manifest?.assets?.[key];
		if (!entry?.basename || !entry?.sha256) {
			return null;
		}
		const url = findAssetDownloadUrl(data.assets, entry.basename);
		if (!url) {
			return null;
		}
		return { url, sha256: entry.sha256, fileName: entry.basename };
	}

	private async _followRedirectGet(urlStr: string, depth: number): Promise<import('http').IncomingMessage> {
		if (depth > 10) {
			throw new Error('Too many redirects');
		}
		const https = await import('https');
		return new Promise((resolve, reject) => {
			https.get(urlStr, { headers: { 'User-Agent': 'VibeIDE-Updater', 'Accept': '*/*' } }, (res) => {
				if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					const next = new URL(res.headers.location, urlStr).href;
					this._followRedirectGet(next, depth + 1).then(resolve).catch(reject);
					return;
				}
				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
					return;
				}
				resolve(res);
			}).on('error', reject);
		});
	}

	private async _downloadToFileWithSha256(url: string, filePath: string, expectedHex: string): Promise<void> {
		const res = await this._followRedirectGet(url, 0);
		const hash = createHash('sha256');
		await new Promise<void>((resolve, reject) => {
			const out = createWriteStream(filePath);
			res.on('data', (c: Buffer | string) => {
				const buf = typeof c === 'string' ? Buffer.from(c) : c;
				hash.update(buf);
				if (!out.write(buf)) {
					res.pause();
					out.once('drain', () => res.resume());
				}
			});
			res.on('end', () => out.end());
			res.on('error', reject);
			out.on('error', reject);
			out.on('finish', () => {
				const digest = hash.digest('hex');
				if (digest.toLowerCase() !== expectedHex.toLowerCase()) {
					try {
						unlinkSync(filePath);
					} catch {
						// ignore
					}
					reject(new Error('SHA256 mismatch'));
				} else {
					resolve();
				}
			});
		});
	}
}
