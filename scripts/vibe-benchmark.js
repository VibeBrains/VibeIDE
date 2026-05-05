#!/usr/bin/env node
/**
 * vibe benchmark — benchmark LLM models: latency/quality/cost
 *
 * Usage:
 *   node scripts/vibe-benchmark.js --provider ollama --model llama3
 *   node scripts/vibe-benchmark.js --offline  (Ollama micro-benchmark only)
 */

'use strict';

const http = require('http');
const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const MODEL = args.find(a => a.startsWith('--model='))?.split('=')[1]
	|| (args.includes('--model') ? args[args.indexOf('--model') + 1] : 'llama3');

async function benchmarkOllama(model) {
	const PROMPT = 'Write a hello world function in Python. Be concise.';
	console.log(`\n⚡ Benchmarking Ollama model: ${model}\n`);

	const start = Date.now();
	let tokenCount = 0;

	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ model, prompt: PROMPT, stream: true });
		const req = http.request({
			hostname: 'localhost',
			port: 11434,
			path: '/api/generate',
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
		}, res => {
			let buffer = '';
			let firstTokenMs = null;
			let totalResponse = '';

			res.on('data', chunk => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const data = JSON.parse(line);
						if (data.response) {
							if (firstTokenMs === null) firstTokenMs = Date.now() - start;
							totalResponse += data.response;
							tokenCount++;
						}
						if (data.done) {
							const elapsed = Date.now() - start;
							const tps = Math.round(tokenCount / (elapsed / 1000));
							console.log(`✅ Model: ${model}`);
							console.log(`   Time to first token: ${firstTokenMs}ms`);
							console.log(`   Total time: ${elapsed}ms`);
							console.log(`   Tokens generated: ~${tokenCount}`);
							console.log(`   Speed: ~${tps} tokens/sec`);
							console.log(`\n📊 Expected response time for typical task:`);
							console.log(`   Short (50 tokens): ~${Math.round(50 / tps * 1000)}ms`);
							console.log(`   Medium (200 tokens): ~${Math.round(200 / tps * 1000)}ms`);
							console.log(`   Long (500 tokens): ~${Math.round(500 / tps * 1000)}ms`);
							resolve({ tps, firstTokenMs, elapsed });
						}
					} catch { /* skip invalid JSON */ }
				}
			});
			res.on('error', reject);
		});
		req.on('error', (e) => {
			console.error(`❌ Cannot connect to Ollama at localhost:11434`);
			console.error(`   Make sure Ollama is running: ollama serve`);
			reject(e);
		});
		req.write(body);
		req.end();
	});
}

async function main() {
	if (OFFLINE) {
		await benchmarkOllama(MODEL);
		return;
	}

	console.log(`\n🏆 VibeIDE Model Benchmark\n`);
	console.log('Available benchmarks:');
	console.log('  --offline --model <name>  Ollama local model micro-benchmark');
	console.log('  (Phase 2: cloud provider benchmarks with quality scores)');
	console.log('\nRunning Ollama benchmark with default model...');
	await benchmarkOllama(MODEL);
}

main().catch(e => {
	if (e.code !== 'ECONNREFUSED') console.error(e.message);
});
