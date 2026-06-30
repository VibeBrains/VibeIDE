/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Discord → roadmap bug-intake helpers — pure module.
 *
 * Roadmap §94. Maintainer runs a CLI that fetches messages from a Discord
 * forum/thread (Bot Token auth), this module:
 *   - decodes Discord REST API message envelopes
 *   - dedups against existing GitHub Issues + roadmap entries by canonical title
 *   - composes the Markdown checkbox + body for `docs/roadmap.md`
 *
 * Pure: caller does the Discord HTTP fetch and the GitHub Issues fetch, then
 * passes their JSON arrays in. Helper returns the decision: which messages
 * become new roadmap items, which are duplicates, which are malformed.
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface DiscordMessage {
	readonly id: string;
	readonly author: { readonly id: string; readonly username: string };
	readonly content: string;
	readonly timestamp: string; // ISO 8601
	readonly channelId: string;
	readonly attachments?: ReadonlyArray<{ readonly url: string; readonly filename: string }>;
}

export interface GithubIssue {
	readonly number: number;
	readonly title: string;
	readonly state: 'open' | 'closed';
	readonly url: string;
}

export interface RoadmapItem {
	readonly title: string;
	readonly source: 'discord' | 'github' | 'manual';
	readonly externalRef?: string;
}

export type IngestVerdict =
	| { readonly kind: 'new'; readonly canonicalTitle: string; readonly markdown: string; readonly source: DiscordMessage }
	| { readonly kind: 'duplicate'; readonly canonicalTitle: string; readonly matchedIssue?: GithubIssue; readonly matchedRoadmapItem?: RoadmapItem; readonly source: DiscordMessage }
	| { readonly kind: 'malformed'; readonly reason: 'too-short' | 'no-body' | 'pii-suspected' | 'attachment-only'; readonly source: DiscordMessage };

const MIN_BODY_CHARS = 20;
const MAX_TITLE_CHARS = 80;
const PII_PATTERNS: ReadonlyArray<RegExp> = [
	/\b\d{3}-\d{2}-\d{4}\b/,           // SSN-shaped
	/\b\d{16}\b/,                       // PAN-shaped
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // email
	/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,     // IPv4
];

export function ingestDiscordMessages(
	messages: ReadonlyArray<DiscordMessage>,
	existingIssues: ReadonlyArray<GithubIssue>,
	existingRoadmap: ReadonlyArray<RoadmapItem>,
): ReadonlyArray<IngestVerdict> {
	const issueByTitle = new Map<string, GithubIssue>();
	for (const issue of existingIssues) {
		issueByTitle.set(canonicaliseTitle(issue.title), issue);
	}
	const roadmapByTitle = new Map<string, RoadmapItem>();
	for (const item of existingRoadmap) {
		roadmapByTitle.set(canonicaliseTitle(item.title), item);
	}

	const verdicts: IngestVerdict[] = [];
	for (const msg of messages) {
		verdicts.push(classify(msg, issueByTitle, roadmapByTitle));
	}
	return verdicts;
}

function classify(
	msg: DiscordMessage,
	issueByTitle: Map<string, GithubIssue>,
	roadmapByTitle: Map<string, RoadmapItem>,
): IngestVerdict {
	const trimmed = msg.content.trim();
	if (trimmed.length === 0 && (msg.attachments?.length ?? 0) > 0) {
		return { kind: 'malformed', reason: 'attachment-only', source: msg };
	}
	if (trimmed.length < MIN_BODY_CHARS) {
		return { kind: 'malformed', reason: 'too-short', source: msg };
	}
	for (const re of PII_PATTERNS) {
		if (re.test(trimmed)) {
			return { kind: 'malformed', reason: 'pii-suspected', source: msg };
		}
	}

	const canonicalTitle = canonicaliseTitle(extractTitle(trimmed));

	const matchedIssue = issueByTitle.get(canonicalTitle);
	const matchedRoadmapItem = roadmapByTitle.get(canonicalTitle);
	if (matchedIssue || matchedRoadmapItem) {
		return { kind: 'duplicate', canonicalTitle, matchedIssue, matchedRoadmapItem, source: msg };
	}

	return {
		kind: 'new',
		canonicalTitle,
		markdown: composeMarkdown(msg, canonicalTitle),
		source: msg,
	};
}

export function canonicaliseTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[`*_~()[\]{}.,;:!?'"—–-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_TITLE_CHARS);
}

function extractTitle(content: string): string {
	const firstLine = content.split(/\r?\n/)[0] ?? content;
	return firstLine.slice(0, MAX_TITLE_CHARS);
}

function composeMarkdown(msg: DiscordMessage, canonicalTitle: string): string {
	const dateIso = msg.timestamp.slice(0, 10);
	const author = msg.author.username;
	const lines = [
		`- [ ] **${escapeMarkdown(canonicalTitle)}** — from Discord (${author}, ${dateIso}).`,
		`  Source message: ${msg.id} (channel ${msg.channelId}).`,
	];
	if (msg.attachments && msg.attachments.length > 0) {
		lines.push(`  Attachments: ${msg.attachments.length}`);
	}
	return lines.join('\n');
}

function escapeMarkdown(s: string): string {
	return s.replace(/[\\`*_{}\[\]()#+\-.!]/g, m => `\\${m}`);
}

export interface IngestSummary {
	readonly newCount: number;
	readonly duplicateCount: number;
	readonly malformedCount: number;
	readonly malformedByReason: Readonly<Record<'too-short' | 'no-body' | 'pii-suspected' | 'attachment-only', number>>;
}

export function summariseIngest(verdicts: ReadonlyArray<IngestVerdict>): IngestSummary {
	const malformedByReason = { 'too-short': 0, 'no-body': 0, 'pii-suspected': 0, 'attachment-only': 0 };
	let newCount = 0;
	let duplicateCount = 0;
	let malformedCount = 0;
	for (const v of verdicts) {
		if (v.kind === 'new') { newCount++; }
		else if (v.kind === 'duplicate') { duplicateCount++; }
		else { malformedCount++; malformedByReason[v.reason]++; }
	}
	return { newCount, duplicateCount, malformedCount, malformedByReason };
}
