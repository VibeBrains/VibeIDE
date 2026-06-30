/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Release manifest unifier (N.0) — pure helper.
 *
 * `release-windows.ps1` already produces a `manifest.json` for the
 * Windows artefacts. When `release-macos.sh` and `release-linux.sh` ship,
 * we want a single unified manifest so the auto-updater can resolve a
 * download by `(platform, arch)` without parsing per-platform variants.
 *
 * Schema (target):
 *   {
 *     "vibeVersion": "0.2.0",
 *     "releasedAt": 1750000000000,
 *     "artefacts": [
 *       { "platform": "win32", "arch": "x64",   "fileName": "VibeIDE-Setup-0.2.0.exe",      "sha256": "…", "sizeBytes": 123456 },
 *       { "platform": "darwin","arch": "arm64", "fileName": "VibeIDE-0.2.0-arm64.dmg",       "sha256": "…", "sizeBytes": … },
 *       …
 *     ]
 *   }
 *
 * vscode-free: no imports beyond standard lib.
 */

export type ReleasePlatform = 'win32' | 'darwin' | 'linux';
export type ReleaseArch = 'x64' | 'arm64';

export interface ReleaseArtefact {
	platform: ReleasePlatform;
	arch: ReleaseArch;
	fileName: string;
	sha256: string;
	sizeBytes: number;
}

export interface UnifiedReleaseManifest {
	vibeVersion: string;
	releasedAt: number;
	artefacts: ReadonlyArray<ReleaseArtefact>;
}

export interface ManifestComposeInput {
	vibeVersion: string;
	releasedAt: number;
	artefacts: ReadonlyArray<unknown>;
}

export interface ManifestComposeResult {
	manifest: UnifiedReleaseManifest;
	skipped: ReadonlyArray<{ index: number; reason: string }>;
}

/**
 * Compose a unified manifest from raw inputs (each script feeds in its
 * platform-specific list of artefacts). Pure — silently drops malformed
 * artefacts and reports them via `skipped` so the wrapper can warn.
 *
 * Stable ordering: by platform then arch ascending. Multiple artefacts
 * for the same (platform, arch) are kept in input order — the wrapper
 * decides whether to dedupe.
 */
export function composeUnifiedManifest(input: ManifestComposeInput): ManifestComposeResult {
	const skipped: { index: number; reason: string }[] = [];
	const valid: ReleaseArtefact[] = [];

	if (!Array.isArray(input.artefacts)) {
		return {
			manifest: { vibeVersion: input.vibeVersion, releasedAt: input.releasedAt, artefacts: [] },
			skipped: [{ index: -1, reason: 'artefacts-not-an-array' }],
		};
	}

	for (let i = 0; i < input.artefacts.length; i++) {
		const item = input.artefacts[i];
		const decoded = decodeArtefact(item);
		if (!decoded.ok) {
			skipped.push({ index: i, reason: decoded.reason });
			continue;
		}
		valid.push(decoded.value);
	}

	valid.sort((a, b) =>
		a.platform.localeCompare(b.platform)
		|| a.arch.localeCompare(b.arch)
		|| a.fileName.localeCompare(b.fileName)
	);

	return {
		manifest: {
			vibeVersion: input.vibeVersion,
			releasedAt: input.releasedAt,
			artefacts: valid,
		},
		skipped,
	};
}

function decodeArtefact(raw: unknown): { ok: true; value: ReleaseArtefact } | { ok: false; reason: string } {
	if (raw === null || raw === undefined || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const obj = raw as Record<string, unknown>;
	if (obj.platform !== 'win32' && obj.platform !== 'darwin' && obj.platform !== 'linux') {
		return { ok: false, reason: 'platform-invalid' };
	}
	if (obj.arch !== 'x64' && obj.arch !== 'arm64') {
		return { ok: false, reason: 'arch-invalid' };
	}
	if (typeof obj.fileName !== 'string' || obj.fileName.length === 0) {
		return { ok: false, reason: 'fileName-missing' };
	}
	if (typeof obj.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(obj.sha256)) {
		return { ok: false, reason: 'sha256-invalid' };
	}
	if (typeof obj.sizeBytes !== 'number' || !Number.isFinite(obj.sizeBytes) || obj.sizeBytes < 0) {
		return { ok: false, reason: 'sizeBytes-invalid' };
	}
	return {
		ok: true,
		value: {
			platform: obj.platform,
			arch: obj.arch,
			fileName: obj.fileName,
			sha256: obj.sha256.toLowerCase(),
			sizeBytes: obj.sizeBytes,
		},
	};
}

/**
 * Look up the artefact for a given (platform, arch). Returns undefined
 * when no match. Used by the auto-updater on each platform.
 */
export function findArtefact(
	manifest: UnifiedReleaseManifest,
	platform: ReleasePlatform,
	arch: ReleaseArch,
): ReleaseArtefact | undefined {
	return manifest.artefacts.find(a => a.platform === platform && a.arch === arch);
}
