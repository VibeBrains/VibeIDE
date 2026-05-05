#!/usr/bin/env node
'use strict';
/**
 * Resolve persisted agent plan files (.vibe/plans, recursive) by planId read from YAML frontmatter.
 * Used by vibe-session-replay.js and vibe-session-export.js.
 *
 * Example: node -e "console.log(require('./lib/vibe-plan-paths.cjs').buildPlanIdPathMap(process.cwd()))"
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} raw
 * @returns {string | undefined}
 */
function extractPlanIdFromPlanMarkdown(raw) {
	const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!m) {
		return undefined;
	}
	const pm = m[1].match(/^\s*planId:\s*["']?([0-9a-f-]{36})["']?/im);
	return pm ? pm[1].toLowerCase() : undefined;
}

/**
 * Map planId -> relative POSIX path from workspace root.
 * @param {string} workspaceRoot
 * @returns {Record<string, string>}
 */
function buildPlanIdPathMap(workspaceRoot) {
	/** @type {Record<string, string>} */
	const map = {};
	const plansDir = path.join(workspaceRoot, '.vibe', 'plans');
	if (!fs.existsSync(plansDir)) {
		return map;
	}
	/** @param {string} dir */
	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === '.leases') {
					continue;
				}
				walk(full);
			} else if (/\.plan\.md$/i.test(ent.name)) {
				let raw;
				try {
					raw = fs.readFileSync(full, 'utf8');
				} catch {
					continue;
				}
				const id = extractPlanIdFromPlanMarkdown(raw);
				if (id) {
					map[id] = path.relative(workspaceRoot, full).split(path.sep).join('/');
				}
			}
		}
	}
	walk(plansDir);
	return map;
}

/**
 * @param {any[]} events
 * @returns {Set<string>}
 */
function collectPlanIdsFromAuditEvents(events) {
	const ids = new Set();
	for (const e of events) {
		const pid = e.meta?.planId;
		if (typeof pid === 'string' && /^[0-9a-f-]{36}$/i.test(pid)) {
			ids.add(pid.toLowerCase());
		}
	}
	return ids;
}

/**
 * @param {string} raw
 * @returns {{ stepNumber: any, description: any, status: any }[] | undefined}
 */
function extractStepsFromPlanMarkdown(raw) {
	const marker = '<!-- vibe-plan-machine-context';
	const mi = raw.indexOf(marker);
	let slice = raw;
	if (mi !== -1) {
		slice = raw.slice(mi);
	}
	const fence = slice.match(/```json\s*\r?\n([\s\S]*?)```/);
	if (!fence) {
		return undefined;
	}
	try {
		const j = JSON.parse(fence[1]);
		if (!Array.isArray(j.steps)) {
			return undefined;
		}
		return j.steps.map(s => ({
			stepNumber: s.stepNumber,
			description: s.description,
			status: s.status,
		}));
	} catch {
		return undefined;
	}
}

module.exports = {
	buildPlanIdPathMap,
	collectPlanIdsFromAuditEvents,
	extractPlanIdFromPlanMarkdown,
	extractStepsFromPlanMarkdown,
};
