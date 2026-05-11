// MUST stay in sync with src/vs/workbench/contrib/vibeide/common/releaseManifestUnifier.ts
'use strict';

const VALID_PLATFORMS = ['win32', 'darwin', 'linux'];
const VALID_ARCHS = ['x64', 'arm64'];
const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * @param {unknown} raw
 * @returns {{ ok: true; value: object } | { ok: false; reason: string }}
 */
function decodeArtefact(raw) {
	if (raw == null || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };
	const obj = /** @type {Record<string, unknown>} */ (raw);
	if (!VALID_PLATFORMS.includes(obj.platform)) return { ok: false, reason: 'platform-invalid' };
	if (!VALID_ARCHS.includes(obj.arch)) return { ok: false, reason: 'arch-invalid' };
	if (typeof obj.fileName !== 'string' || obj.fileName.length === 0) return { ok: false, reason: 'fileName-missing' };
	if (typeof obj.sha256 !== 'string' || !SHA256_RE.test(obj.sha256)) return { ok: false, reason: 'sha256-invalid' };
	if (typeof obj.sizeBytes !== 'number' || !Number.isFinite(obj.sizeBytes) || obj.sizeBytes < 0) return { ok: false, reason: 'sizeBytes-invalid' };
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
 * @param {{ vibeVersion: string; releasedAt: number; artefacts: unknown[] }} input
 * @returns {{ manifest: object; skipped: Array<{ index: number; reason: string }> }}
 */
function composeUnifiedManifest(input) {
	const skipped = [];
	const valid = [];
	if (!Array.isArray(input.artefacts)) {
		return {
			manifest: { vibeVersion: input.vibeVersion, releasedAt: input.releasedAt, artefacts: [] },
			skipped: [{ index: -1, reason: 'artefacts-not-an-array' }],
		};
	}
	for (let i = 0; i < input.artefacts.length; i++) {
		const decoded = decodeArtefact(input.artefacts[i]);
		if (!decoded.ok) { skipped.push({ index: i, reason: decoded.reason }); continue; }
		valid.push(decoded.value);
	}
	valid.sort((a, b) =>
		a.platform.localeCompare(b.platform) ||
		a.arch.localeCompare(b.arch) ||
		a.fileName.localeCompare(b.fileName)
	);
	return { manifest: { vibeVersion: input.vibeVersion, releasedAt: input.releasedAt, artefacts: valid }, skipped };
}

/**
 * @param {object} manifest
 * @param {'win32'|'darwin'|'linux'} platform
 * @param {'x64'|'arm64'} arch
 */
function findArtefact(manifest, platform, arch) {
	return manifest.artefacts.find(a => a.platform === platform && a.arch === arch);
}

// Self-tests (run with: node release-manifest-unifier.cjs --test)
if (process.argv.includes('--test')) {
	const assert = require('node:assert');
	const valid = { platform: 'win32', arch: 'x64', fileName: 'VibeIDE-Setup.exe', sha256: 'a'.repeat(64), sizeBytes: 1234 };
	const r1 = composeUnifiedManifest({ vibeVersion: '1.0.0', releasedAt: 1, artefacts: [valid] });
	assert.strictEqual(r1.manifest.artefacts.length, 1);
	assert.strictEqual(r1.skipped.length, 0);
	const r2 = composeUnifiedManifest({ vibeVersion: '1.0.0', releasedAt: 1, artefacts: [{ platform: 'invalid' }] });
	assert.strictEqual(r2.skipped.length, 1);
	const r3 = composeUnifiedManifest({ vibeVersion: '1.0.0', releasedAt: 1, artefacts: 'nope' });
	assert.strictEqual(r3.skipped[0].reason, 'artefacts-not-an-array');
	const found = findArtefact(r1.manifest, 'win32', 'x64');
	assert.ok(found);
	assert.ok(!findArtefact(r1.manifest, 'darwin', 'arm64'));
	console.log('release-manifest-unifier.cjs: 4 tests passed');
}

module.exports = { composeUnifiedManifest, findArtefact, decodeArtefact };
