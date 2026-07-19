#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Refreshes resources/vibeide/models.dev.json from https://models.dev/api.json.
// That file ships as the bundled fallback catalog for VibeIDE's AI SDK routing on
// aggregator providers (openCode/openCodeZen). It is consumed at runtime by
// src/vs/workbench/contrib/vibeide/electron-main/llmMessage/modelsDevCatalog.ts —
// see localSnapshotCandidates() for the resolution order. Regenerate before each
// release so users behind firewalls or on flaky DNS still get correct per-model SDK
// (e.g. minimax-m2.7 → @ai-sdk/anthropic).
//
// Run: npm run update-models-dev-snapshot

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = 'https://models.dev/api.json';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'vibeide', 'models.dev.json');

const main = async () => {
	process.stdout.write(`Fetching ${URL} ...\n`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	let res;
	try {
		res = await fetch(URL, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {throw new Error(`HTTP ${res.status} ${res.statusText}`);}
	const text = await res.text();

	// Parse to validate JSON and surface an obvious problem (rather than shipping garbage).
	// Also a smoke-test for the one routing fact we care most about — if this assertion
	// ever fails, models.dev changed schema and the catalog logic needs review.
	const json = JSON.parse(text);
	const npm = json?.['opencode-go']?.models?.['minimax-m2.7']?.provider?.npm;
	if (npm !== '@ai-sdk/anthropic') {
		process.stderr.write(
			`WARNING: opencode-go/minimax-m2.7 provider.npm = ${JSON.stringify(npm)} (expected @ai-sdk/anthropic). ` +
			`models.dev may have changed schema; please review before committing.\n`,
		);
	}

	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, text, 'utf-8');
	process.stdout.write(`Wrote ${OUT} (${(text.length / 1024).toFixed(1)} KB)\n`);
};

main().catch(err => {
	process.stderr.write(`Failed: ${err?.stack ?? err}\n`);
	process.exit(1);
});
