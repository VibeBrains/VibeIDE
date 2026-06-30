/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Crash-clustering pure helper (roadmap W.48).
 *
 * Given a tail of `WatchdogLine`s, groups crash entries by signature
 * `proc + reason + rss-bucket(100MB)`. Returns the count per signature and the
 * timestamp of the most recent occurrence. Caller (pre-flight contribution)
 * uses the count to decide whether to surface a «recurring bug» message vs a
 * one-off informational toast.
 *
 * Pure / no IO — suitable for tests (W.37).
 */

import type { WatchdogCrashEntry, WatchdogLine } from './vibeIdleWatchdogTypes.js';

export interface CrashCluster {
	readonly signature: string;
	readonly count: number;
	readonly lastSeen: string;
	readonly proc: string;
	readonly reason: string | undefined;
}

const RSS_BUCKET_MB = 100;

function isCrash(line: WatchdogLine): line is WatchdogCrashEntry {
	return (line as { type?: string }).type === 'crash';
}

function signatureFor(crash: WatchdogCrashEntry, rssBucketMB: number = RSS_BUCKET_MB): string {
	// The `lastTickRef` itself is too unique (timestamp); we want to cluster by
	// the «kind of crash», not the exact moment. The proc + reason + rough rss
	// bucket from the last sample produce a stable hash for recurring patterns.
	const bucket = Math.round((crash as { _bucketMb?: number })._bucketMb ?? 0 / rssBucketMB);
	return `${crash.proc}|${crash.reason ?? 'unknown'}|${bucket}`;
}

export function clusterCrashes(lines: readonly WatchdogLine[]): readonly CrashCluster[] {
	const map = new Map<string, { count: number; lastSeen: string; proc: string; reason: string | undefined }>();
	for (const line of lines) {
		if (!isCrash(line)) { continue; }
		const sig = signatureFor(line);
		const existing = map.get(sig);
		if (existing) {
			existing.count += 1;
			if (line.ts > existing.lastSeen) { existing.lastSeen = line.ts; }
		} else {
			map.set(sig, { count: 1, lastSeen: line.ts, proc: line.proc, reason: line.reason });
		}
	}
	return Array.from(map.entries()).map(([signature, v]) => ({ signature, ...v }));
}

/**
 * Heuristic: a crash is «recurring» when ≥3 crashes share the same signature
 * within the supplied window. Used by pre-flight contribution to upgrade the
 * notification severity from Info to Warning and add «report as VibeIDE issue»
 * action.
 */
export function isRecurringPattern(clusters: readonly CrashCluster[], signature: string, threshold = 3): boolean {
	const cluster = clusters.find(c => c.signature === signature);
	return cluster !== undefined && cluster.count >= threshold;
}
