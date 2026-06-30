/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Crash report bundler (roadmap W.11).
 *
 * Collects the most recent diagnostic artefacts into a single ZIP so the user
 * can share a snapshot of an incident in one file. Contents:
 *
 *   logs/vibe-idle-watchdog/2026-MM-DD.jsonl × last 3 days
 *   logs/vibe-idle-watchdog/snapshots/*.heapsnapshot × up to 3, not older than 3 days
 *   logs/YYYYMMDDTHHmmss/main.log + window1/renderer.log + window1/exthost/exthost.log × last 5 sessions
 *   system-info.json — { os, cpus, totalmem, freemem, versions, vibeVersion }
 *
 * Workspace paths in `system-info.json` are anonymised (replaced with `<workspace>`).
 *
 * @see common/vibeIdleWatchdogTypes.ts — `WatchdogBundleResult`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import * as yazl from 'yazl';
import product from '../../../../platform/product/common/product.js';
import type { WatchdogBundleResult } from '../common/vibeIdleWatchdogTypes.js';

const MAX_DAYS = 3;
const MAX_SESSIONS = 5;
const MAX_SNAPSHOTS = 3;
const PER_SESSION_INTERESTING_FILES = ['main.log'];

function listJsonlFiles(watchdogDir: string): string[] {
	try {
		if (!fs.existsSync(watchdogDir)) { return []; }
		return fs.readdirSync(watchdogDir)
			.filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
			.sort()
			.reverse()
			.slice(0, MAX_DAYS)
			.map(f => path.join(watchdogDir, f));
	} catch {
		return [];
	}
}

function listSnapshots(snapshotsDir: string): string[] {
	try {
		if (!fs.existsSync(snapshotsDir)) { return []; }
		// Freshness gate mirrors the jsonl window (MAX_DAYS): a bundle documents the CURRENT
		// incident, and a week-old 130MB+ heapsnapshot from a long-fixed investigation only
		// bloats every export (observed: two May snapshots riding along in June bundles,
		// 45MB per zip). Belt to the service-side age pruning's braces.
		const cutoffMs = Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000;
		return fs.readdirSync(snapshotsDir)
			.filter(f => f.endsWith('.heapsnapshot'))
			.map(f => ({ name: f, full: path.join(snapshotsDir, f), mtime: fs.statSync(path.join(snapshotsDir, f)).mtimeMs }))
			.filter(x => x.mtime >= cutoffMs)
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, MAX_SNAPSHOTS)
			.map(x => x.full);
	} catch {
		return [];
	}
}

function listRecentSessions(logsRoot: string): string[] {
	try {
		if (!fs.existsSync(logsRoot)) { return []; }
		return fs.readdirSync(logsRoot)
			.filter(f => /^\d{8}T\d{6}$/.test(f))
			.sort()
			.reverse()
			.slice(0, MAX_SESSIONS)
			.map(f => path.join(logsRoot, f));
	} catch {
		return [];
	}
}

function gatherSessionFiles(sessionDir: string): string[] {
	const out: string[] = [];
	for (const name of PER_SESSION_INTERESTING_FILES) {
		const full = path.join(sessionDir, name);
		if (fs.existsSync(full)) { out.push(full); }
	}
	// Multi-window setups create `window1/`, `window2/`, ... per workbench window.
	// Pre-W.22 hardcoded `window1` and silently dropped renderer.log of windows 2+,
	// which were exactly where the original 2026-05-22/23 incident's renderer died.
	try {
		const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^window\d+$/.test(entry.name)) { continue; }
			const windowDir = path.join(sessionDir, entry.name);
			const rendererLog = path.join(windowDir, 'renderer.log');
			if (fs.existsSync(rendererLog)) { out.push(rendererLog); }
			const exthostLog = path.join(windowDir, 'exthost', 'exthost.log');
			if (fs.existsSync(exthostLog)) { out.push(exthostLog); }
		}
	} catch {
		// Unreadable session dir — best-effort; skip.
	}
	return out;
}

interface AnonymisedSystemInfo {
	readonly capturedAt: string;
	readonly platform: string;
	readonly arch: string;
	readonly osRelease: string;
	readonly cpuCount: number;
	readonly cpuModel: string;
	readonly totalMemoryBytes: number;
	readonly freeMemoryBytes: number;
	readonly versions: Readonly<Record<string, string | undefined>>;
	readonly vibeVersion?: string;
	readonly productNameShort?: string;
}

function buildSystemInfo(): AnonymisedSystemInfo {
	const cpus = os.cpus();
	return {
		capturedAt: new Date().toISOString(),
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		cpuCount: cpus.length,
		cpuModel: cpus[0]?.model ?? 'unknown',
		totalMemoryBytes: os.totalmem(),
		freeMemoryBytes: os.freemem(),
		versions: process.versions,
		vibeVersion: product.vibeVersion,
		productNameShort: product.nameShort,
	};
}

export async function bundleCrashReport(userDataPath: string, destPath: string): Promise<WatchdogBundleResult> {
	const watchdogDir = path.join(userDataPath, 'logs', 'vibe-idle-watchdog');
	const snapshotsDir = path.join(watchdogDir, 'snapshots');
	const logsRoot = path.join(userDataPath, 'logs');

	const jsonlFiles = listJsonlFiles(watchdogDir);
	const snapshotFiles = listSnapshots(snapshotsDir);
	const sessionDirs = listRecentSessions(logsRoot);

	return await new Promise<WatchdogBundleResult>((resolve, reject) => {
		const zip = new yazl.ZipFile();
		let fileCount = 0;

		for (const f of jsonlFiles) {
			zip.addFile(f, path.posix.join('watchdog', path.basename(f)));
			fileCount += 1;
		}
		for (const f of snapshotFiles) {
			zip.addFile(f, path.posix.join('snapshots', path.basename(f)));
			fileCount += 1;
		}
		for (const session of sessionDirs) {
			const sessionName = path.basename(session);
			for (const f of gatherSessionFiles(session)) {
				const rel = path.relative(session, f).split(path.sep).join('/');
				zip.addFile(f, path.posix.join('sessions', sessionName, rel));
				fileCount += 1;
			}
		}
		const systemInfo = buildSystemInfo();
		zip.addBuffer(Buffer.from(JSON.stringify(systemInfo, null, 2), 'utf-8'), 'system-info.json');
		fileCount += 1;

		zip.outputStream.pipe(fs.createWriteStream(destPath))
			.on('close', () => {
				try {
					const sizeBytes = fs.statSync(destPath).size;
					resolve({ outputPath: destPath, sizeBytes, fileCount });
				} catch (e) {
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			})
			.on('error', (err: Error) => reject(err));
		zip.end();
	});
}
