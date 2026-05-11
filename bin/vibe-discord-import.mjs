#!/usr/bin/env node
/**
 * VibeIDE Discord → roadmap bug-intake CLI.
 *
 * Roadmap §94. Pure helper: src/vs/workbench/contrib/vibeide/common/discordBugIngest.ts
 * (mirror this script's regex/title-canon logic with the .ts; tests on the
 * helper are canonical).
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_ID=... node bin/vibe-discord-import.mjs
 *   node bin/vibe-discord-import.mjs --dry-run
 *
 * Required env:
 *   DISCORD_BOT_TOKEN   Bot token from https://discord.com/developers/applications
 *                       Bot must have `Read Message History` + `View Channel`
 *                       scopes on the target server.
 *   DISCORD_CHANNEL_ID  Forum / thread / text channel ID to scrape.
 *
 * Optional env:
 *   GITHUB_REPO         "owner/repo" for issue dedup (default vibeideteam/vibeide).
 *   GITHUB_TOKEN        For private repos / higher rate-limit. Public repos work without.
 *
 * Output: prints to stdout one of:
 *   - "[discord-import] N new / M duplicate / K malformed" summary
 *   - per-verdict markdown blocks suitable to paste into docs/roadmap.md
 *
 * Tokens are NEVER persisted — this script only reads from env and writes to stdout.
 *
 * Status: skeleton. Wire to a real Discord fetch + GitHub Issues fetch behind
 * the env gates; the helper is fully tested standalone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MIN_BODY_CHARS = 20;
const MAX_TITLE_CHARS = 80;
const PII_PATTERNS = [
	/\b\d{3}-\d{2}-\d{4}\b/,
	/\b\d{16}\b/,
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
	/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
];

function parseArgs(argv) {
	const args = { dryRun: false, help: false, fixturesPath: null, autoAppend: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--dry-run') { args.dryRun = true; continue; }
		if (a === '--auto-append') { args.autoAppend = true; continue; }
		if (a === '--help' || a === '-h') { args.help = true; continue; }
		if (a === '--fixtures' && argv[i + 1]) { args.fixturesPath = argv[++i]; continue; }
	}
	return args;
}

function printHelp() {
	console.log(`Usage: node bin/vibe-discord-import.mjs [--dry-run] [--fixtures <path>]

Required env:
  DISCORD_BOT_TOKEN     Bot token (read message history + view channel scope).
  DISCORD_CHANNEL_ID    Forum / thread / text channel ID.

Optional:
  GITHUB_REPO           owner/repo for issue dedup (default vibeideteam/vibeide).
  GITHUB_TOKEN          For private repos.

Flags:
  --dry-run             Print verdicts but do not append to docs/roadmap.md.
  --auto-append         Append new items to docs/roadmap.md automatically.
                        Always review with "git diff docs/roadmap.md" before committing.
  --fixtures <path>     Read fake Discord messages from a JSON file instead of
                        making the live REST call. Useful for local dev.

Tokens are read from env only and never persisted.`);
}

function canonicaliseTitle(s) {
	return s
		.toLowerCase()
		.replace(/[`*_~()[\]{}.,;:!?'"]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_TITLE_CHARS);
}

function escapeMarkdown(s) {
	return s.replace(/[\\`*_{}\[\]()#+\-.!]/g, m => `\\${m}`);
}

function classify(message, issuesByTitle, roadmapByTitle) {
	const trimmed = (message.content || '').trim();
	if (trimmed.length === 0 && (message.attachments?.length ?? 0) > 0) {
		return { kind: 'malformed', reason: 'attachment-only', source: message };
	}
	if (trimmed.length < MIN_BODY_CHARS) {
		return { kind: 'malformed', reason: 'too-short', source: message };
	}
	for (const re of PII_PATTERNS) {
		if (re.test(trimmed)) {
			return { kind: 'malformed', reason: 'pii-suspected', source: message };
		}
	}
	const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
	const canonicalTitle = canonicaliseTitle(firstLine.slice(0, MAX_TITLE_CHARS));

	const matchedIssue = issuesByTitle.get(canonicalTitle);
	const matchedRoadmapItem = roadmapByTitle.get(canonicalTitle);
	if (matchedIssue || matchedRoadmapItem) {
		return { kind: 'duplicate', canonicalTitle, matchedIssue, matchedRoadmapItem, source: message };
	}

	const dateIso = (message.timestamp || '').slice(0, 10);
	const author = message.author?.username ?? 'unknown';
	const lines = [
		`- [ ] **${escapeMarkdown(canonicalTitle)}** — from Discord (${author}, ${dateIso}).`,
		`  Source message: ${message.id} (channel ${message.channelId}).`,
	];
	if (message.attachments?.length) {
		lines.push(`  Attachments: ${message.attachments.length}`);
	}
	return { kind: 'new', canonicalTitle, markdown: lines.join('\n'), source: message };
}

async function fetchDiscordMessages(token, channelId) {
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, {
		headers: { Authorization: `Bot ${token}`, 'User-Agent': 'VibeIDE-Roadmap-Importer (https://github.com/borodatych/VibeIDE, 0.1)' },
	});
	if (!res.ok) {
		throw new Error(`Discord API ${res.status}: ${await res.text().catch(() => '<no body>')}`);
	}
	const messages = await res.json();
	return messages.map(m => ({ ...m, channelId: channelId }));
}

async function fetchGithubIssues(repo, token) {
	const headers = { 'User-Agent': 'VibeIDE-Roadmap-Importer', Accept: 'application/vnd.github+json' };
	if (token) { headers.Authorization = `Bearer ${token}`; }
	const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100`, { headers });
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status}: ${await res.text().catch(() => '<no body>')}`);
	}
	return (await res.json()).filter(i => !i.pull_request);
}

function readRoadmapTitles() {
	const roadmapPath = path.join(ROOT, 'docs', 'roadmap.md');
	if (!fs.existsSync(roadmapPath)) { return []; }
	const text = fs.readFileSync(roadmapPath, 'utf8');
	const out = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^- \[[ x~]\]\s*(?:\*\*(.+?)\*\*|(.+?))(?: —|$)/.exec(line);
		if (m) { out.push({ title: m[1] ?? m[2] ?? '', source: 'manual' }); }
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help) { printHelp(); return; }

	const token = process.env.DISCORD_BOT_TOKEN;
	const channelId = process.env.DISCORD_CHANNEL_ID;
	const repo = process.env.GITHUB_REPO ?? 'vibeideteam/vibeide';
	const githubToken = process.env.GITHUB_TOKEN;

	let messages;
	if (args.fixturesPath) {
		messages = JSON.parse(fs.readFileSync(args.fixturesPath, 'utf8'));
	} else {
		if (!token || !channelId) {
			console.error('[discord-import] missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID. Run --help.');
			process.exit(2);
		}
		try {
			messages = await fetchDiscordMessages(token, channelId);
		} catch (err) {
			console.error(`[discord-import] fetch failed: ${err.message}`);
			process.exit(3);
		}
	}

	let issues = [];
	if (!args.fixturesPath) {
		try { issues = await fetchGithubIssues(repo, githubToken); } catch (err) {
			console.warn(`[discord-import] GitHub issue fetch failed (continuing without dedup): ${err.message}`);
		}
	}

	const issuesByTitle = new Map(issues.map(i => [canonicaliseTitle(i.title || ''), { number: i.number, title: i.title, state: i.state, url: i.html_url }]));
	const roadmapByTitle = new Map(readRoadmapTitles().map(r => [canonicaliseTitle(r.title), r]));

	const verdicts = messages.map(m => classify(m, issuesByTitle, roadmapByTitle));
	const counts = { new: 0, duplicate: 0, malformed: 0 };
	for (const v of verdicts) { counts[v.kind]++; }

	console.log(`[discord-import] ${counts.new} new / ${counts.duplicate} duplicate / ${counts.malformed} malformed`);

	for (const v of verdicts) {
		if (v.kind === 'new') {
			console.log('');
			console.log(v.markdown);
		} else if (v.kind === 'malformed') {
			console.log(`[discord-import] malformed (${v.reason}): "${(v.source.content || '').slice(0, 60)}"`);
		}
	}

	if (args.dryRun) {
		console.log('');
		console.log('[discord-import] --dry-run: not appending to docs/roadmap.md.');
	} else if (args.autoAppend && counts.new > 0) {
		const roadmapPath = path.join(ROOT, 'docs', 'roadmap.md');
		const newBlocks = verdicts
			.filter(v => v.kind === 'new')
			.map(v => v.markdown)
			.join('\n');
		const section = '\n\n## Discord bugs\n\n' + newBlocks + '\n';
		const existing = fs.existsSync(roadmapPath) ? fs.readFileSync(roadmapPath, 'utf8') : '';
		if (existing.includes('## Discord bugs')) {
			// Append to existing section
			fs.writeFileSync(roadmapPath, existing.replace(/## Discord bugs\n/, `## Discord bugs\n${newBlocks}\n`), 'utf8');
		} else {
			fs.appendFileSync(roadmapPath, section, 'utf8');
		}
		console.log('');
		console.log(`[discord-import] --auto-append: ${counts.new} new item(s) written to docs/roadmap.md.`);
		console.log('[discord-import] Review before committing: git diff docs/roadmap.md');
	} else if (counts.new > 0) {
		console.log('');
		console.log('[discord-import] To append: copy the new blocks above into docs/roadmap.md under "## Discord bugs".');
		console.log('[discord-import] Or rerun with --auto-append to write automatically (then review with git diff).');
	}
}

main().catch(err => { console.error(err); process.exit(1); });
