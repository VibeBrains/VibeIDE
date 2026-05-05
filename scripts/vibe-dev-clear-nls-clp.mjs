/*---------------------------------------------------------------------------------------------
 *  Clears %UserData%/clp so the next Electron start rebuilds nls.messages.json from fresh
 *  out/nls.keys.json + bundled language pack. Mirrors getUserDataPath (dev profile only).
 *  Invoked from vibe-dev.bat after successful vibe-nls-extract.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

/** @param {string} productNameShort */
function devUserDataProfileSlug(productNameShort) {
	const slug = String(productNameShort)
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return slug.length > 0 ? slug : 'vscode';
}

/**
 * @param {string} productFolderName
 * @returns {string}
 */
function getDefaultUserDataPath(productFolderName) {
	switch (process.platform) {
		case 'win32': {
			const appDataPath = process.env.APPDATA;
			if (appDataPath) {
				return path.join(appDataPath, productFolderName);
			}
			const userProfile = process.env.USERPROFILE;
			if (typeof userProfile !== 'string') {
				throw new Error('Windows: APPDATA and USERPROFILE are unset');
			}
			return path.join(userProfile, 'AppData', 'Roaming', productFolderName);
		}
		case 'darwin':
			return path.join(os.homedir(), 'Library', 'Application Support', productFolderName);
		default:
			return path.join(
				process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
				productFolderName
			);
	}
}

function resolveDevUserDataPath() {
	const portablePath = process.env.VSCODE_PORTABLE;
	if (portablePath) {
		return path.join(portablePath, 'user-data');
	}

	const product = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'product.json'), 'utf8'));
	if (process.env.VSCODE_DEV === '1' || process.env.VSCODE_DEV === 'true') {
		try {
			const overrides = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'product.overrides.json'), 'utf8'));
			Object.assign(product, overrides);
		} catch {
			/* optional file */
		}
	}
	let nameShort = product.nameShort ?? 'code-oss-dev';
	// Root main.ts + product.ts: under VSCODE_DEV the display nameShort is `${nameShort} Dev`,
	// which changes getUserDataPath / NLS clp to …/vibeide-dev-dev (not …/vibeide-dev).
	if (process.env.VSCODE_DEV === '1' || process.env.VSCODE_DEV === 'true') {
		nameShort = `${nameShort} Dev`;
	}
	const slug = devUserDataProfileSlug(nameShort);
	const productName = `${slug}-dev`;

	const appDataOverride = process.env.VSCODE_APPDATA;
	if (appDataOverride) {
		return path.join(appDataOverride, productName);
	}

	return getDefaultUserDataPath(productName);
}

const userDataPath = resolveDevUserDataPath();
const clpDir = path.join(userDataPath, 'clp');

if (fs.existsSync(clpDir)) {
	fs.rmSync(clpDir, { recursive: true, force: true });
	console.log(`[vibe-dev] cleared NLS language-pack cache: ${clpDir}`);
} else {
	console.log(`[vibe-dev] no NLS cache folder (ok): ${clpDir}`);
}
