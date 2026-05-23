#!/usr/bin/env node
// Roadmap W.12 — companion script for the nightly memory-regression workflow.
// Reads the latest `.jsonl` in the supplied directory, computes
// `max(rss after warmup) - min(rss after warmup)` for `proc:'main'` samples,
// fails (exit 1) if the delta exceeds IDLE_RSS_GROWTH_THRESHOLD_MB.

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
	console.error(`watchdog dir not found: ${dir}`);
	process.exit(2);
}

const warmupSec = Number(process.env.WARMUP_SEC ?? '300');
const thresholdMb = Number(process.env.IDLE_RSS_GROWTH_THRESHOLD_MB ?? '50');

const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
if (files.length === 0) {
	console.error(`no .jsonl files in ${dir}`);
	process.exit(2);
}
const filePath = path.join(dir, files[0]);
const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
const samples = [];
for (const ln of lines) {
	try {
		const obj = JSON.parse(ln);
		if (obj.type === 'sample' && obj.proc === 'main' && obj.uptimeSec >= warmupSec) {
			samples.push(obj);
		}
	} catch { /* skip malformed */ }
}
if (samples.length < 2) {
	console.error(`not enough post-warmup main samples (${samples.length})`);
	process.exit(2);
}
const min = Math.min(...samples.map(s => s.rss));
const max = Math.max(...samples.map(s => s.rss));
const deltaMb = (max - min) / (1024 * 1024);
console.log(`samples=${samples.length} min=${(min / 1024 / 1024).toFixed(1)}MB max=${(max / 1024 / 1024).toFixed(1)}MB delta=${deltaMb.toFixed(1)}MB threshold=${thresholdMb}MB`);
if (deltaMb > thresholdMb) {
	console.error(`FAIL: rss growth ${deltaMb.toFixed(1)} MB exceeds ${thresholdMb} MB threshold`);
	process.exit(1);
}
console.log('PASS');
