// Copyright 2026 VibeIDE Team. MIT License.
// CJS mirror of common/completionOutcomeStats.ts — MUST stay in sync.
// Used by: vibe-doctor.js --completion-stats
'use strict';

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isValid(e) {
	if (!e || typeof e !== 'object') return false;
	const o = /** @type {Record<string,unknown>} */ (e);
	return typeof o.timestamp === 'number'
		&& Number.isFinite(o.timestamp)
		&& typeof o.modelId === 'string'
		&& o.modelId.length > 0
		&& (o.outcome === 'accept' || o.outcome === 'reject' || o.outcome === 'ignore')
		&& typeof o.suggestionLength === 'number'
		&& Number.isFinite(o.suggestionLength)
		&& o.suggestionLength >= 0;
}

/**
 * @param {unknown[]} events
 * @param {number} periodStart
 * @param {number} periodEnd
 */
function aggregateCompletionEvents(events, periodStart, periodEnd) {
	const buckets = new Map();
	let totalInPeriod = 0;
	let acceptsInPeriod = 0;

	for (const event of events) {
		if (!isValid(event)) continue;
		const e = /** @type {any} */ (event);
		if (e.timestamp < periodStart || e.timestamp > periodEnd) continue;
		totalInPeriod++;
		if (e.outcome === 'accept') acceptsInPeriod++;

		const b = buckets.get(e.modelId) ?? {
			totalEvents: 0, accepts: 0, rejects: 0, ignores: 0,
			suggestionLengthSum: 0,
			latencySum: 0, latencyCount: 0,
			acceptedLengthSum: 0, acceptedLengthCount: 0, acceptedSuggestionLengthSum: 0,
		};
		b.totalEvents++;
		b.suggestionLengthSum += e.suggestionLength;
		if (e.outcome === 'accept') b.accepts++;
		else if (e.outcome === 'reject') b.rejects++;
		else b.ignores++;
		if (typeof e.latencyMs === 'number' && Number.isFinite(e.latencyMs)) {
			b.latencySum += e.latencyMs;
			b.latencyCount++;
		}
		if (e.outcome === 'accept' && typeof e.acceptedLength === 'number' && Number.isFinite(e.acceptedLength)) {
			b.acceptedLengthSum += e.acceptedLength;
			b.acceptedLengthCount++;
			b.acceptedSuggestionLengthSum += e.suggestionLength;
		}
		buckets.set(e.modelId, b);
	}

	const rows = [];
	for (const [modelId, b] of buckets.entries()) {
		const acceptRate = b.totalEvents === 0 ? 0 : b.accepts / b.totalEvents;
		const rejectRate = b.totalEvents === 0 ? 0 : b.rejects / b.totalEvents;
		const avgSuggestionLength = b.totalEvents === 0 ? 0 : b.suggestionLengthSum / b.totalEvents;
		const avgLatencyMs = b.latencyCount === 0 ? null : b.latencySum / b.latencyCount;
		const keepRate = b.acceptedLengthCount === 0 || b.acceptedSuggestionLengthSum === 0
			? null
			: b.acceptedLengthSum / b.acceptedSuggestionLengthSum;
		rows.push({ modelId, totalEvents: b.totalEvents, accepts: b.accepts, rejects: b.rejects, ignores: b.ignores, acceptRate, rejectRate, avgSuggestionLength, avgLatencyMs, keepRate });
	}

	rows.sort((a, b) =>
		b.acceptRate - a.acceptRate
		|| b.totalEvents - a.totalEvents
		|| a.modelId.localeCompare(b.modelId)
	);

	return {
		periodStart, periodEnd,
		totalEvents: totalInPeriod,
		overallAcceptRate: totalInPeriod === 0 ? 0 : acceptsInPeriod / totalInPeriod,
		rows,
	};
}

/**
 * Render a markdown leaderboard from an aggregated summary.
 * @param {ReturnType<typeof aggregateCompletionEvents>} summary
 */
function renderCompletionStatsMd(summary) {
	const pct = (n) => `${(n * 100).toFixed(1)}%`;
	const ms = (n) => n === null ? '—' : `${Math.round(n)} ms`;
	const lines = [
		`## Completion Outcome Stats (24h window)\n`,
		`Total events: **${summary.totalEvents}** | Overall accept rate: **${pct(summary.overallAcceptRate)}**\n`,
	];
	if (summary.rows.length === 0) {
		lines.push('No completion events recorded. The IDE-side storage hook appends to `.vibe/completion-events.jsonl`.');
	} else {
		lines.push('| Model | Events | Accept | Reject | Ignore | Keep Rate | Avg Latency |');
		lines.push('|---|---|---|---|---|---|---|');
		for (const r of summary.rows) {
			lines.push(`| \`${r.modelId}\` | ${r.totalEvents} | ${pct(r.acceptRate)} | ${pct(r.rejectRate)} | ${pct(1 - r.acceptRate - r.rejectRate)} | ${r.keepRate === null ? '—' : pct(r.keepRate)} | ${ms(r.avgLatencyMs)} |`);
		}
	}
	return lines.join('\n');
}

// Self-tests (run when invoked directly: node completion-outcome-stats.cjs --test)
if (process.argv.includes('--test')) {
	let passed = 0;
	let failed = 0;

	function test(name, fn) {
		try { fn(); console.log(`  ✅ ${name}`); passed++; }
		catch (e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
	}
	function eq(a, b) { if (a !== b) throw new Error(`expected ${b}, got ${a}`); }

	const now = Date.now();
	const events = [
		{ timestamp: now, modelId: 'claude', outcome: 'accept', suggestionLength: 40, acceptedLength: 40, latencyMs: 120 },
		{ timestamp: now, modelId: 'claude', outcome: 'reject', suggestionLength: 30 },
		{ timestamp: now, modelId: 'gpt4', outcome: 'ignore', suggestionLength: 20 },
	];

	test('filters out-of-window events', () => {
		const r = aggregateCompletionEvents(events, now + 1000, now + 2000);
		eq(r.totalEvents, 0);
	});
	test('counts accepts correctly', () => {
		const r = aggregateCompletionEvents(events, now - 1, now + 1);
		eq(r.rows.find(x => x.modelId === 'claude').accepts, 1);
	});
	test('sorts by acceptRate desc', () => {
		const r = aggregateCompletionEvents(events, now - 1, now + 1);
		eq(r.rows[0].modelId, 'claude');
	});
	test('overall accept rate', () => {
		const r = aggregateCompletionEvents(events, now - 1, now + 1);
		eq(Math.round(r.overallAcceptRate * 3), 1);
	});
	test('rejects malformed event', () => {
		const r = aggregateCompletionEvents([{ timestamp: 'bad' }], 0, Infinity);
		eq(r.totalEvents, 0);
	});

	console.log(`\ncompletion-outcome-stats.cjs: ${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

module.exports = { aggregateCompletionEvents, renderCompletionStatsMd };
