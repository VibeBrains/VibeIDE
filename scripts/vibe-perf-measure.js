#!/usr/bin/env node
/**
 * vibe-perf-measure — VibeIDE Performance SLA measurement tool
 *
 * Usage:
 *   node scripts/vibe-perf-measure.js --cold-start [--runs 5]
 *   node scripts/vibe-perf-measure.js --memory [--wait 15]
 *   node scripts/vibe-perf-measure.js --compile-time
 *   node scripts/vibe-perf-measure.js --all [--output docs/v1/perf-results.json]
 *   node scripts/vibe-perf-measure.js --help
 *
 * SLA targets:
 *   Cold start:       ≤ 5 000 ms  (critical: > 8 000 ms)
 *   Memory idle:      ≤ 600 MB    (critical: > 900 MB)
 *   Memory + project: ≤ 600 MB   (critical: > 1 024 MB)
 *   Compile cold:     ≤ 300 s     (critical: > 600 s)
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

const HELP = args.includes('--help') || args.includes('-h');
const DO_COLD_START = args.includes('--cold-start') || args.includes('--all');
const DO_MEMORY = args.includes('--memory') || args.includes('--all');
const DO_COMPILE = args.includes('--compile-time') || args.includes('--all');
const RUNS = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1]
	|| (args.includes('--runs') ? args[args.indexOf('--runs') + 1] : '5'), 10);
const MEMORY_WAIT = parseInt(args.find(a => a.startsWith('--wait='))?.split('=')[1]
	|| (args.includes('--wait') ? args[args.indexOf('--wait') + 1] : '15'), 10);
const OUTPUT_FILE = args.find(a => a.startsWith('--output='))?.split('=')[1]
	|| (args.includes('--output') ? args[args.indexOf('--output') + 1] : null);

// SLA thresholds (ms / MB)
const SLA = {
	coldStart: { target: 5000, critical: 8000 },
	memoryIdle: { target: 600, critical: 900 },
	memoryProject: { target: 600, critical: 1024 },
	compileTime: { target: 300, critical: 600 },
};

if (HELP || (!DO_COLD_START && !DO_MEMORY && !DO_COMPILE)) {
	console.log(`
VibeIDE Performance SLA Measurement Tool

Usage:
  node scripts/vibe-perf-measure.js [options]

Options:
  --cold-start        Measure app cold start time (requires display/Electron)
  --memory            Measure renderer process memory (requires running app)
  --compile-time      Measure npm run compile duration
  --all               Run all measurements
  --runs <N>          Number of cold-start runs (default: 5)
  --wait <S>          Seconds to wait before memory snapshot (default: 15)
  --output <file>     Write JSON results to file
  --help              Show this help

SLA Targets:
  Cold start:           ≤ ${SLA.coldStart.target}ms    (critical: ${SLA.coldStart.critical}ms)
  Memory idle:          ≤ ${SLA.memoryIdle.target}MB   (critical: ${SLA.memoryIdle.critical}MB)
  Memory + project:     ≤ ${SLA.memoryProject.target}MB (critical: ${SLA.memoryProject.critical}MB)
  Compile (cold):       ≤ ${SLA.compileTime.target}s   (critical: ${SLA.compileTime.critical}s)
`);
	process.exit(0);
}

function slaStatus(value, sla) {
	if (value <= sla.target) return '✅';
	if (value <= sla.critical) return '⚠️ ';
	return '❌';
}

function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getSystemInfo() {
	return {
		date: new Date().toISOString().split('T')[0],
		os: `${os.type()} ${os.release()} (${os.arch()})`,
		cpu: os.cpus()[0]?.model || 'unknown',
		cpuCount: os.cpus().length,
		ramMB: Math.round(os.totalmem() / 1024 / 1024),
		nodeVersion: process.version,
		platform: process.platform,
	};
}

function getElectronVersion() {
	try {
		const pkgPath = path.join(ROOT, 'node_modules', 'electron', 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		return pkg.version;
	} catch {
		return 'unknown';
	}
}

function getVibeVersion() {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
		return pkg.version;
	} catch {
		return 'unknown';
	}
}

async function measureCompileTime() {
	console.log('\n🔨 Measuring compile time (npm run compile)...');
	console.log('   This may take several minutes on first run.\n');

	const start = Date.now();
	try {
		execSync('npm run compile', {
			cwd: ROOT,
			stdio: 'pipe',
			timeout: 900_000, // 15 min max
		});
		const elapsed = Math.round((Date.now() - start) / 1000);
		const status = slaStatus(elapsed, SLA.compileTime);
		console.log(`${status} Compile time: ${elapsed}s (target ≤ ${SLA.compileTime.target}s)`);
		return { elapsedSeconds: elapsed, status: elapsed <= SLA.compileTime.target ? 'ok' : elapsed <= SLA.compileTime.critical ? 'warn' : 'fail' };
	} catch (err) {
		console.error('❌ Compile failed:', err.message);
		return { elapsedSeconds: null, status: 'error', error: err.message };
	}
}

function getRendererPids(appName) {
	try {
		if (process.platform === 'win32') {
			const out = execSync(`tasklist /FI "IMAGENAME eq ${appName}.exe" /FO CSV /NH`, { encoding: 'utf8' });
			return out.trim().split('\n')
				.filter(l => l.includes(appName))
				.map(l => parseInt(l.split(',')[1].replace(/"/g, ''), 10))
				.filter(Boolean);
		} else {
			const out = execSync(`pgrep -f "${appName}.*renderer" 2>/dev/null || pgrep -f "${appName}" 2>/dev/null`, { encoding: 'utf8' });
			return out.trim().split('\n').map(Number).filter(Boolean);
		}
	} catch {
		return [];
	}
}

function getProcessMemoryMB(pid) {
	try {
		if (process.platform === 'win32') {
			const out = execSync(
				`powershell -NoProfile -Command "Get-Process -Id ${pid} | Select-Object -ExpandProperty WorkingSet64"`,
				{ encoding: 'utf8', timeout: 5000 }
			);
			return Math.round(parseInt(out.trim(), 10) / 1024 / 1024);
		} else {
			const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8', timeout: 5000 });
			return Math.round(parseInt(out.trim(), 10) / 1024);
		}
	} catch {
		return null;
	}
}

async function measureMemory() {
	console.log('\n💾 Memory measurement mode');
	console.log('   Ensure VibeIDE is running (empty window, Welcome screen closed).');
	console.log(`   Waiting ${MEMORY_WAIT}s before snapshot...\n`);

	await new Promise(r => setTimeout(r, MEMORY_WAIT * 1000));

	const pids = getRendererPids('vibeide');
	if (pids.length === 0) {
		console.warn('⚠️  No vibeide process found. Is the app running?');
		return { idleRSS: null, status: 'error', error: 'process not found' };
	}

	const memories = pids.map(pid => getProcessMemoryMB(pid)).filter(Boolean);
	const totalMB = memories.reduce((a, b) => a + b, 0);

	const status = slaStatus(totalMB, SLA.memoryIdle);
	console.log(`${status} Memory (${pids.length} process(es)): ${totalMB} MB RSS (target ≤ ${SLA.memoryIdle.target} MB)`);
	console.log(`   PIDs: ${pids.join(', ')}`);
	memories.forEach((m, i) => console.log(`   PID ${pids[i]}: ${m} MB`));

	return {
		idleRSS: totalMB,
		pids,
		status: totalMB <= SLA.memoryIdle.target ? 'ok' : totalMB <= SLA.memoryIdle.critical ? 'warn' : 'fail',
	};
}

async function measureColdStart() {
	console.log(`\n⚡ Cold start measurement (${RUNS} runs)...`);
	console.log('   NOTE: This requires a graphical environment (DISPLAY/Wayland/Windows).\n');

	const codeScript = process.platform === 'win32'
		? path.join(ROOT, 'scripts', 'code.bat')
		: path.join(ROOT, 'scripts', 'code.sh');

	if (!fs.existsSync(codeScript)) {
		console.warn(`⚠️  Launch script not found: ${codeScript}`);
		console.warn('   Cannot measure cold start automatically in this environment.');
		console.warn('   Please measure manually — see docs/v1/performance-sla.md §2.1\n');
		return { timesMs: [], median: null, status: 'skipped', reason: 'no-display' };
	}

	const times = [];

	for (let i = 0; i < RUNS; i++) {
		process.stdout.write(`   Run ${i + 1}/${RUNS}... `);
		const start = Date.now();

		try {
			// Launch with --wait flag and measure to process exit (approx window open time)
			execSync(`"${codeScript}" --no-sandbox --disable-gpu --wait 2>/dev/null`, {
				timeout: 30_000,
				stdio: 'pipe',
			});
			const elapsed = Date.now() - start;
			times.push(elapsed);
			console.log(`${elapsed}ms`);
		} catch (err) {
			console.log(`SKIP (${err.message.slice(0, 60)})`);
		}

		// Brief pause between runs
		if (i < RUNS - 1) await new Promise(r => setTimeout(r, 2000));
	}

	if (times.length === 0) {
		console.warn('\n⚠️  All cold-start runs failed (likely no display). Skipping.');
		return { timesMs: [], median: null, status: 'skipped', reason: 'all-runs-failed' };
	}

	const med = median(times);
	const status = slaStatus(med, SLA.coldStart);
	console.log(`\n${status} Cold start median: ${med}ms (target ≤ ${SLA.coldStart.target}ms)`);
	console.log(`   Runs: [${times.join(', ')}]ms`);

	return {
		timesMs: times,
		median: med,
		status: med <= SLA.coldStart.target ? 'ok' : med <= SLA.coldStart.critical ? 'warn' : 'fail',
	};
}

async function main() {
	console.log('╔════════════════════════════════════════╗');
	console.log('║   VibeIDE Performance SLA Measurement   ║');
	console.log('╚════════════════════════════════════════╝');

	const sysInfo = getSystemInfo();
	const electronVersion = getElectronVersion();
	const vibeVersion = getVibeVersion();

	console.log(`\nSystem: ${sysInfo.os}`);
	console.log(`CPU:    ${sysInfo.cpu} (${sysInfo.cpuCount} cores)`);
	console.log(`RAM:    ${sysInfo.ramMB} MB`);
	console.log(`Node:   ${sysInfo.nodeVersion}   Electron: ${electronVersion}   VibeIDE: ${vibeVersion}`);

	const results = {
		timestamp: new Date().toISOString(),
		system: { ...sysInfo, electronVersion, vibeVersion },
		sla: {},
	};

	if (DO_COMPILE) {
		results.sla.compileTime = await measureCompileTime();
	}

	if (DO_COLD_START) {
		results.sla.coldStart = await measureColdStart();
	}

	if (DO_MEMORY) {
		results.sla.memory = await measureMemory();
	}

	// Summary
	console.log('\n══════════════════════════════════════════');
	console.log('Summary:');
	let hasFail = false;
	for (const [key, val] of Object.entries(results.sla)) {
		const icon = val.status === 'ok' ? '✅' : val.status === 'warn' ? '⚠️ ' : val.status === 'skipped' ? '⏭️ ' : '❌';
		console.log(`  ${icon} ${key}: ${val.status}`);
		if (val.status === 'fail') hasFail = true;
	}

	if (OUTPUT_FILE) {
		const outPath = path.resolve(ROOT, OUTPUT_FILE);
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
		console.log(`\n📄 Results written to: ${OUTPUT_FILE}`);
	}

	console.log('\nSee docs/v1/performance-sla.md for full methodology and thresholds.');

	process.exit(hasFail ? 1 : 0);
}

main().catch(err => {
	console.error('Fatal error:', err);
	process.exit(2);
});
