/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Launch announcement spec (roadmap §889) — pure helper.
 *
 * Public launch coordination touches a fixed set of channels. Each channel
 * has format constraints (HN title length, Reddit subreddit rules, Twitter
 * thread cadence) that historically tripped first-time announcers. This
 * helper validates the announcement payload against per-channel rules
 * before the operator hits "Post".
 *
 * Pure: caller passes the announcement object, helper returns ok/issues.
 * vscode-free.
 */

export interface LaunchAnnouncement {
	readonly title: string;
	readonly summary: string;
	readonly url: string; // primary landing URL (e.g. https://github.com/borodatych/VibeIDE)
	readonly downloadUrl?: string; // direct download link to signed binaries
	readonly screenshots?: ReadonlyArray<string>;
	readonly version: string; // e.g. "0.4.0"
}

export type Channel = 'hn' | 'reddit-rprogramming' | 'reddit-rvscode' | 'twitter' | 'discord' | 'mastodon' | 'lobsters';

export interface ChannelIssue {
	readonly channel: Channel;
	readonly severity: 'error' | 'warning';
	readonly message: string;
}

export type ChannelValidation =
	| { readonly ok: true; readonly issues: ReadonlyArray<ChannelIssue> /* warnings only */ }
	| { readonly ok: false; readonly issues: ReadonlyArray<ChannelIssue> };

const CHANNEL_RULES: Record<Channel, {
	readonly maxTitleChars: number;
	readonly maxBodyChars: number;
	readonly requiresScreenshots: boolean;
	readonly forbidsLinkInTitle: boolean;
	readonly notes: string;
}> = {
	'hn': {
		maxTitleChars: 80,
		maxBodyChars: 0, // HN posts are link-only or text-only; this helper validates Show HN link form
		requiresScreenshots: false,
		forbidsLinkInTitle: true,
		notes: 'Title format: "Show HN: <project> – <one-sentence pitch>". No URL in title; URL goes in the link field.',
	},
	'reddit-rprogramming': {
		maxTitleChars: 300,
		maxBodyChars: 40000,
		requiresScreenshots: false,
		forbidsLinkInTitle: false,
		notes: 'r/programming: 7-day rule for self-promotion; usually one post per major release.',
	},
	'reddit-rvscode': {
		maxTitleChars: 300,
		maxBodyChars: 40000,
		requiresScreenshots: true,
		forbidsLinkInTitle: false,
		notes: 'r/vscode rules: must show a screenshot of the IDE; cannot be pure marketing.',
	},
	'twitter': {
		maxTitleChars: 280, // first tweet
		maxBodyChars: 0,
		requiresScreenshots: false,
		forbidsLinkInTitle: false,
		notes: 'First tweet must include the URL; thread allowed up to 25 tweets per the publish helper guidelines.',
	},
	'discord': {
		maxTitleChars: 80,
		maxBodyChars: 4000,
		requiresScreenshots: false,
		forbidsLinkInTitle: false,
		notes: 'Pin in #announcements; embed preview generates from the URL automatically.',
	},
	'mastodon': {
		maxTitleChars: 0,
		maxBodyChars: 500,
		requiresScreenshots: false,
		forbidsLinkInTitle: false,
		notes: '500-char post combining title + summary + URL; choose an instance with a programming community (e.g. mastodon.social, fosstodon.org).',
	},
	'lobsters': {
		maxTitleChars: 100,
		maxBodyChars: 2000,
		requiresScreenshots: false,
		forbidsLinkInTitle: true,
		notes: 'Tag "show" + "vscode" + "ai"; account must be invite-vouched.',
	},
};

const URL_IN_TITLE_RE = /https?:\/\/|www\./i;

export function validateAnnouncement(
	announcement: LaunchAnnouncement,
	channels: ReadonlyArray<Channel>,
): ChannelValidation {
	const issues: ChannelIssue[] = [];

	for (const channel of channels) {
		const rules = CHANNEL_RULES[channel];
		if (!rules) {
			issues.push({ channel, severity: 'error', message: `Unknown channel "${channel}".` });
			continue;
		}

		if (rules.maxTitleChars > 0 && announcement.title.length > rules.maxTitleChars) {
			issues.push({ channel, severity: 'error', message: `title is ${announcement.title.length} chars; ${channel} caps at ${rules.maxTitleChars}.` });
		}
		if (rules.maxBodyChars > 0 && announcement.summary.length > rules.maxBodyChars) {
			issues.push({ channel, severity: 'error', message: `summary is ${announcement.summary.length} chars; ${channel} caps at ${rules.maxBodyChars}.` });
		}
		if (rules.forbidsLinkInTitle && URL_IN_TITLE_RE.test(announcement.title)) {
			issues.push({ channel, severity: 'error', message: `${channel} forbids URLs in the title; URL goes in the link field.` });
		}
		if (rules.requiresScreenshots && (!announcement.screenshots || announcement.screenshots.length === 0)) {
			issues.push({ channel, severity: 'error', message: `${channel} requires at least one screenshot.` });
		}
	}

	const errors = issues.filter(i => i.severity === 'error');
	return errors.length > 0 ? { ok: false, issues } : { ok: true, issues };
}

export function describeChannelValidation(result: ChannelValidation): string {
	const lines: string[] = [];
	const errors = result.issues.filter(i => i.severity === 'error');
	const warnings = result.issues.filter(i => i.severity === 'warning');
	lines.push(`Launch announcement: ${result.ok ? 'OK' : 'FAILED'} (${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
	for (const issue of result.issues) {
		const tag = issue.severity === 'error' ? 'ERROR' : 'WARN ';
		lines.push(`  [${tag}] ${issue.channel}: ${issue.message}`);
	}
	return lines.join('\n');
}

/**
 * Render a per-channel preview that's safe to copy into the channel's UI.
 * Pure formatting — does not POST anywhere.
 */
export function renderChannelPreview(announcement: LaunchAnnouncement, channel: Channel): string {
	switch (channel) {
		case 'hn':
			return [
				`Title: Show HN: VibeIDE — ${stripUrls(announcement.title)}`,
				`URL:   ${announcement.url}`,
				'',
				'(HN posts are link-only by default; first comment from author can include the summary below.)',
				'',
				announcement.summary,
			].join('\n');
		case 'reddit-rprogramming':
		case 'reddit-rvscode':
			return [
				`# ${announcement.title}`,
				'',
				announcement.summary,
				'',
				`**Project:** ${announcement.url}`,
				announcement.downloadUrl ? `**Download:** ${announcement.downloadUrl}` : '',
				announcement.screenshots && announcement.screenshots.length > 0
					? `\n**Screenshots:**\n${announcement.screenshots.map(s => `- ${s}`).join('\n')}`
					: '',
			].filter(Boolean).join('\n');
		case 'twitter':
			return [
				`${announcement.title}`,
				'',
				`${announcement.summary.slice(0, 200)}…`,
				'',
				announcement.url,
				`#vscode #ai #vibeide #v${announcement.version}`,
			].join('\n');
		case 'discord':
			return [
				`📢 **${announcement.title}**`,
				'',
				announcement.summary,
				'',
				`Download v${announcement.version}: ${announcement.downloadUrl ?? announcement.url}`,
				`Repo: ${announcement.url}`,
			].join('\n');
		case 'mastodon':
			// 500-char limit — compact form.
			return `${announcement.title}\n\n${announcement.summary.slice(0, 350)}\n\n${announcement.url}\n#vscode #ai`;
		case 'lobsters':
			return [
				`Title: ${stripUrls(announcement.title)}`,
				`URL:   ${announcement.url}`,
				`Tags:  show, vscode, ai`,
				'',
				announcement.summary,
			].join('\n');
	}
}

function stripUrls(s: string): string {
	return s.replace(URL_IN_TITLE_RE, '').replace(/\s+/g, ' ').trim();
}
