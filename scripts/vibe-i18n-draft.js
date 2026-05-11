#!/usr/bin/env node
/**
 * vibe-i18n-draft — LLM-assisted draft translations for VibeIDE
 *
 * Usage:
 *   node scripts/vibe-i18n-draft.js --locale <tag> [--model <model>]
 *       [--out-dir <path>] [--batch-size <n>] [--dry-run]
 *       [--ollama-url <url>] [--lmstudio-url <url>]
 *
 * Reads vibeide.nls.metadata.json + vibeide.nls.<locale>.json, generates
 * draft translations for [NEEDS_TRANSLATION] keys via Ollama / LM Studio,
 * and writes them back with [DRAFT_LLM] markers for human review.
 *
 * Never commits automatically.  Reviewers remove the [DRAFT_LLM] prefix to
 * accept, or replace the whole string to correct.
 *
 * (roadmap §L510 — vibe-i18n-draft.js with Ollama fetch)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const { selectKeysForLLMDraft, buildI18nDraftRequest, parseI18nDraftResponse, applyI18nDraftMarkers } = require('./lib/i18n-llm-draft.cjs');

const LOCALE_NAMES = {
	ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese',
	ja: 'Japanese', ko: 'Korean', 'zh-cn': 'Chinese (Simplified)',
	'zh-tw': 'Chinese (Traditional)', it: 'Italian', pl: 'Polish',
	tr: 'Turkish', nl: 'Dutch', cs: 'Czech', uk: 'Ukrainian',
};

const args = process.argv.slice(2);

function argVal(flag) {
	const idx = args.indexOf(flag);
	return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

const locale = argVal('--locale');
if (!locale) {
	console.error('[vibe-i18n-draft] --locale <tag> is required.');
	process.exit(1);
}

const model = argVal('--model') ?? 'llama3';
const batchSize = parseInt(argVal('--batch-size') ?? '20', 10);
const DRY_RUN = args.includes('--dry-run');
const ollamaUrl = argVal('--ollama-url') ?? 'http://localhost:11434';
const lmStudioUrl = argVal('--lmstudio-url') ?? 'http://localhost:1234';
const useOllama = !args.includes('--lmstudio');

let outDir = path.join(process.cwd(), 'out');
if (argVal('--out-dir')) outDir = path.resolve(argVal('--out-dir'));

const localeName = LOCALE_NAMES[locale.toLowerCase()] ?? locale;

// ── Load files ─────────────────────────────────────────────────────────────

const metadataPath = path.join(outDir, 'vibeide.nls.metadata.json');
if (!fs.existsSync(metadataPath)) {
	console.error(`[vibe-i18n-draft] metadata not found: ${metadataPath}`);
	console.error(`Run 'npm run nls-extract:vibeide' first.`);
	process.exit(1);
}

const bundlePath = path.join(outDir, `vibeide.nls.${locale}.json`);
const rawMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
const metadataEnglish = new Map();
for (const [, moduleData] of Object.entries(rawMeta)) {
	if (moduleData?.keys && moduleData?.messages) {
		for (let i = 0; i < moduleData.keys.length; i++) {
			metadataEnglish.set(moduleData.keys[i], moduleData.messages[i]);
		}
	}
}

let currentLocale = new Map();
if (fs.existsSync(bundlePath)) {
	currentLocale = new Map(Object.entries(JSON.parse(fs.readFileSync(bundlePath, 'utf-8'))));
}

// ── Select candidates ──────────────────────────────────────────────────────

const candidates = selectKeysForLLMDraft(metadataEnglish, currentLocale);
if (candidates.length === 0) {
	console.log(`[vibe-i18n-draft] No keys need translation for ${locale}. All done!`);
	process.exit(0);
}

console.log(`[vibe-i18n-draft] ${candidates.length} keys need draft translation for ${locale}.`);
if (DRY_RUN) {
	console.log(`[vibe-i18n-draft] DRY RUN — first 10 candidates:`);
	candidates.slice(0, 10).forEach(c => console.log(`  ${c.key}: "${c.englishSource.slice(0, 80)}"`));
	process.exit(0);
}

// ── Send batches to LLM ────────────────────────────────────────────────────

async function fetchOllama(prompt, systemPrompt) {
	const body = JSON.stringify({
		model,
		prompt: `${systemPrompt}\n\n${prompt}`,
		stream: false,
	});
	return httpPost(`${ollamaUrl}/api/generate`, body);
}

async function fetchLMStudio(prompt, systemPrompt) {
	const body = JSON.stringify({
		model,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: prompt },
		],
		stream: false,
	});
	const raw = await httpPost(`${lmStudioUrl}/v1/chat/completions`, body);
	const parsed = JSON.parse(raw);
	return parsed?.choices?.[0]?.message?.content ?? '';
}

function httpPost(url, body) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const lib = parsed.protocol === 'https:' ? https : http;
		const req = lib.request({
			hostname: parsed.hostname,
			port: parsed.port,
			path: parsed.pathname + parsed.search,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
		}, (res) => {
			let data = '';
			res.on('data', chunk => { data += chunk; });
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
				} else {
					resolve(data);
				}
			});
		});
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

(async () => {
	let totalDrafted = 0;
	let bundle = new Map(currentLocale);

	for (let offset = 0; offset < candidates.length; offset += batchSize) {
		const batch = candidates.slice(offset, offset + batchSize);
		const req = buildI18nDraftRequest({
			candidates: batch,
			targetLocaleTag: locale,
			targetLocaleName: localeName,
			model,
			batchSize,
		});

		console.log(`[vibe-i18n-draft] Batch ${Math.floor(offset / batchSize) + 1}/${Math.ceil(candidates.length / batchSize)}: ${batch.length} keys…`);

		let rawResponse;
		try {
			if (useOllama) {
				const raw = await fetchOllama(req.userPrompt, req.systemPrompt);
				const parsed = JSON.parse(raw);
				rawResponse = parsed?.response ?? raw;
			} else {
				rawResponse = await fetchLMStudio(req.userPrompt, req.systemPrompt);
			}
		} catch (err) {
			console.error(`[vibe-i18n-draft] LLM request failed: ${err.message}`);
			console.error(`Is ${useOllama ? 'Ollama' : 'LM Studio'} running? Try: ollama serve`);
			process.exit(1);
		}

		const parseResult = parseI18nDraftResponse(rawResponse);
		if (parseResult.kind === 'no-json') {
			console.warn(`[vibe-i18n-draft] Batch response was not JSON — skipping batch.`);
			continue;
		}
		if (parseResult.kind === 'shape-mismatch') {
			console.warn(`[vibe-i18n-draft] Shape mismatch: ${parseResult.detail} — skipping batch.`);
			continue;
		}

		bundle = applyI18nDraftMarkers(bundle, parseResult.translations);
		totalDrafted += parseResult.translations.size;
		console.log(`[vibe-i18n-draft]   → ${parseResult.translations.size} draft(s) applied.`);
	}

	// Write updated bundle
	const output = Object.fromEntries([...bundle.keys()].sort().map(k => [k, bundle.get(k)]));
	fs.writeFileSync(bundlePath, JSON.stringify(output, null, '\t'), 'utf-8');

	console.log(`\n[vibe-i18n-draft] Done. ${totalDrafted} draft(s) written to ${bundlePath}.`);
	console.log(`[vibe-i18n-draft] Review [DRAFT_LLM] entries before removing the prefix to accept.`);
})();
