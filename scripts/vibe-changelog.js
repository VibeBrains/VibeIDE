#!/usr/bin/env node
/**
 * vibe changelog — generate CHANGELOG from git history + audit log
 * Separates AI-assisted changes from manual changes.
 * Markdown output: Russian UI; commit subjects unchanged.
 *
 * Usage:
 *   node scripts/vibe-changelog.js
 *   node scripts/vibe-changelog.js --since v1.0.0
 *   node scripts/vibe-changelog.js --first-release v0.1.0
 *   node scripts/vibe-changelog.js --format markdown|json
 */

'use strict';

const { execSync } = require('child_process');

const args = process.argv.slice(2);
const FIRST_RELEASE_IDX = args.indexOf('--first-release');
const FIRST_RELEASE_VER = FIRST_RELEASE_IDX >= 0 ? args[FIRST_RELEASE_IDX + 1] : null;
const SINCE = args.find(a => a.startsWith('--since='))?.split('=')[1]
	|| (args.includes('--since') ? args[args.indexOf('--since') + 1] : null);
const FORMAT = args.find(a => a.startsWith('--format='))?.split('=')[1]
	|| (args.includes('--format') ? args[args.indexOf('--format') + 1] : 'markdown');

/** Same block as README.md — «Поддержать проект» (GitHub Releases render HTML). */
function supportFooterMarkdown() {
	return `

---

## Поддержать проект

Если VibeIDE оказался полезным — буду рад благодарности 🙏

<a href="https://raw.githubusercontent.com/borodatych/VSCodeSyncFiles/main/media/QR-Code.jpg" target="_blank" rel="noopener noreferrer">
  <img src="https://raw.githubusercontent.com/borodatych/VSCodeSyncFiles/main/media/QR-Code.jpg" width="120" alt="QR-код для поддержки проекта" />
</a>
`;
}

function firstReleaseMarkdown(version) {
	const v = version || 'v?';
	return `## VibeIDE ${v}

Первый релиз или нет предыдущего тега — полный список изменений см. в коммитах на ветке \`main\`.
${supportFooterMarkdown()}`;
}

function getCommits(since) {
	const range = since ? `${since}..HEAD` : '--max-count=50';
	try {
		const log = execSync(`git log ${range} --pretty=format:"%H|%s|%an|%ae|%ad" --date=short`, {
			encoding: 'utf-8', timeout: 10000
		});
		return log.trim().split('\n').filter(Boolean).map(line => {
			const [hash, subject, author, email, date] = line.split('|');
			const isAI = email?.includes('agent@vibeide') || subject?.includes('Co-authored-by: VibeIDE');
			const isAISubject = subject?.match(/^(feat|fix|chore|refactor|security).*VibeIDE/i);
			return { hash, subject, author, email, date, isAI: !!(isAI || isAISubject) };
		});
	} catch (e) {
		return [];
	}
}

function categorizeCommit(subject) {
	if (subject?.startsWith('feat')) return '✨ Новое';
	if (subject?.startsWith('fix')) return '🐛 Исправления';
	if (subject?.startsWith('security')) return '🔒 Безопасность';
	if (subject?.startsWith('refactor')) return '♻️ Рефакторинг';
	if (subject?.startsWith('perf')) return '🚀 Производительность';
	if (subject?.startsWith('docs')) return '📚 Документация';
	if (subject?.startsWith('build') || subject?.startsWith('ci')) return '📦 Сборка и CI';
	return '🔧 Прочее';
}

function generateMarkdown(commits) {
	const humanCommits = commits.filter(c => !c.isAI);
	const aiCommits = commits.filter(c => c.isAI);

	const sections = {};
	for (const commit of commits) {
		const cat = categorizeCommit(commit.subject);
		if (!sections[cat]) sections[cat] = [];
		sections[cat].push(commit);
	}

	let output = `# История изменений\n\n`;
	if (SINCE) output += `Изменения после тега ${SINCE}\n\n`;
	output += `Сформировано: ${new Date().toISOString().split('T')[0]}\n\n`;
	output += `---\n\n`;

	for (const [category, catCommits] of Object.entries(sections)) {
		output += `## ${category}\n\n`;
		for (const c of catCommits) {
			const aiTag = c.isAI ? ' \`[с AI]\`' : '';
			output += `- ${c.subject}${aiTag} (${c.date}, ${c.hash.slice(0, 7)})\n`;
		}
		output += '\n';
	}

	output += `---\n\n`;
	output += `**Итого:** ${commits.length} коммитов — `;
	output += `${humanCommits.length} вручную, ${aiCommits.length} с участием AI\n`;
	output += supportFooterMarkdown();

	return output;
}

// Main
if (FIRST_RELEASE_VER && FORMAT === 'markdown') {
	console.log(firstReleaseMarkdown(FIRST_RELEASE_VER));
	process.exit(0);
}

const commits = getCommits(SINCE);

if (commits.length === 0) {
	if (FORMAT === 'json') {
		console.log('[]');
	} else {
		console.log(`# История изменений\n\nВ выбранном диапазоне коммитов нет.\n${supportFooterMarkdown()}`);
	}
	process.exit(0);
}

if (FORMAT === 'json') {
	console.log(JSON.stringify(commits, null, 2));
} else {
	console.log(generateMarkdown(commits));
}
