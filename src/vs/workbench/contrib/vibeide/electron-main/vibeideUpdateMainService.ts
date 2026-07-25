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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IHeaders } from '../../../../base/parts/request/common/request.js';
import { localize } from '../../../../nls.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';

import { IVibeideUpdateService } from '../common/vibeideUpdateService.js';
import { VibeideCheckUpdateResponse, VibeideVerifiedDownload } from '../common/vibeideUpdateServiceTypes.js';
import { isBuildUpToDateVersusTag, pickNewestRelease, pickNewestReleaseForPlatform, ReleaseArch, ReleaseCandidate, ReleasePlatform } from '../common/releasePlatformAssets.js';

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
	readonly draft?: boolean;
	readonly prerelease?: boolean;
}

/** GitHub API response: either one release or array of releases */
type GithubReleaseApiPayload = IGithubRelease | IGithubRelease[] | unknown;

/** Running platform/arch in the shape the release-selection helpers expect, or null when unknown. */
function getRunningReleaseTarget(): { platform: ReleasePlatform; arch: ReleaseArch } | null {
	const arch: ReleaseArch = process.arch === 'arm64' ? 'arm64' : 'x64';
	if (isWindows) {
		return { platform: 'win32', arch };
	}
	if (isMacintosh) {
		return { platform: 'darwin', arch };
	}
	if (isLinux) {
		return { platform: 'linux', arch };
	}
	return null;
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

	private _releaseApiCache: { releaseUrl: string; etag: string; data: readonly IGithubRelease[]; fetchedAt: number } | undefined;
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
			// A page of releases, not just the newest one: releases are not always cross-platform,
			// so the newest tag may carry no build for this OS while an older one does. Selecting
			// per-platform (below) needs history to look back through.
			const releaseUrl = 'https://api.github.com/repos/VibeBrains/VibeIDE/releases?per_page=10';

			const now = Date.now();
			let data: readonly IGithubRelease[];

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
					const resolved = Array.isArray(jsonData)
						? (jsonData as IGithubRelease[])
						: [jsonData as IGithubRelease];

					if (resolved.length === 0 || !resolved.some(r => r?.tag_name)) {
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

			const options = { allowPrerelease: channel !== 'stable' } as const;
			const candidates: ReleaseCandidate[] = data
				.filter(r => typeof r?.tag_name === 'string')
				.map(r => ({
					tagName: r.tag_name as string,
					assetNames: (r.assets ?? []).map(a => a?.name).filter((n): n is string => typeof n === 'string'),
					draft: r.draft,
					prerelease: r.prerelease,
				}));

			const target = getRunningReleaseTarget();
			// Newest release that ships a build for THIS OS — the only one worth offering. Falls back
			// to the newest overall when the platform is unknown (no rules to apply).
			const forMe = target
				? pickNewestReleaseForPlatform(candidates, target.platform, target.arch, options)
				: pickNewestRelease(candidates, options);
			const newestOverall = pickNewestRelease(candidates, options);

			const myVersion = this._productService.version;
			const hasUpdateForMe = !!forMe && !isBuildUpToDateVersusTag(myVersion, forMe.tagName);
			// A newer release exists, but it carries no build for this OS (e.g. a macOS-only patch
			// seen from Windows). Saying "update available" there sends the user to a page with no
			// file they can install.
			const newerIsOtherPlatformOnly = !hasUpdateForMe
				&& !!newestOverall
				&& !isBuildUpToDateVersusTag(myVersion, newestOverall.tagName);

			const msgAvailable = localize('vibeide.update.availableReinstall', 'Доступна новая версия VibeIDE! Выполните переустановку (автообновления отключены для этой ОС) — это займёт секунду!');
			const msgUpToDate = localize('vibeide.update.upToDate', 'VibeIDE обновлён до последней версии!');
			const msgOtherPlatformOnly = localize('vibeide.update.otherPlatformOnly', 'Вышла версия {0}, но сборки для вашей операционной системы в ней нет — у вас установлена самая свежая доступная. Следите за обновлениями.', newestOverall?.tagName ?? '');

			if (hasUpdateForMe) {
				const picked = data.find(r => r.tag_name === forMe?.tagName);
				let verified: VibeideVerifiedDownload | undefined;
				try {
					verified = picked ? (await this._resolveVerifiedDownload(picked) ?? undefined) : undefined;
				} catch {
					verified = undefined;
				}
				if (verified) {
					return { message: msgAvailable, action: 'reinstall', verifiedDownload: verified } as const;
				}
				return { message: msgAvailable, action: 'reinstall' } as const;
			}

			if (!explicit) {
				return { message: null } as const;
			}
			return { message: newerIsOtherPlatformOnly ? msgOtherPlatformOnly : msgUpToDate } as const;
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
