#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Проверка «в сборке нет вендорных AI-поверхностей апстрима».
 *
 * VibeIDE — форк VS Code со своим агентским стеком. Апстрим встраивает Copilot всё глубже:
 * расширение, агент-хост с CLI-харнессами, онбординг, телеметрия, облачная диктовка. При
 * каждом обновлении базы это возвращается — не конфликтом, который заметен, а новыми файлами
 * и новыми регистрациями в файлах, которые мы не трогали.
 *
 * Проверка падает, если вернулось хоть что-то из четырёх классов:
 *   1. Каталоги и файлы вендорных подсистем.
 *   2. Вендорные пакеты в зависимостях.
 *   3. Регистрации, которые включают Copilot-поверхности в UI.
 *   4. Сетевые адреса вендорных сервисов в конфигурации продукта.
 *
 * Поимённые запреты ловят только то, что уже знаем по имени: переименованный файл проходит мимо.
 * Так `chat.contribution.ts` стал `chat.shared.contribution.ts`, и регистрации вернулись бы зелёным.
 * Поэтому сверху — три снимка в build/vendorFreeBaseline.json, и падает всё, чего в снимке нет:
 *   5. Строки-импорты barrel-файлов воркбенча.
 *   6. Инвентарь регистраций по всему src, кроме нашего кода и тестов.
 *   7. Вхождения вендорных строк (внутренние адреса Copilot, серверные режимы роутера).
 * Новое вхождение — не обязательно беда, но решение о нём принимает человек: --update переписывает снимок,
 * и дифф снимка в коммите показывает, что именно приехало с апстримом.
 *   8. С --artifact <путь> — скан собранного приложения на вендорные пакеты, включая содержимое .asar:
 *      бинарь Copilot CLI приезжает при упаковке мимо dependencies, и исходники его не видят.
 *
 * Использование:
 *   node scripts/vibe-copilot-free-check.mjs
 *   node scripts/vibe-copilot-free-check.mjs --json
 *   node scripts/vibe-copilot-free-check.mjs --update
 *   node scripts/vibe-copilot-free-check.mjs --artifact <путь к .app или папке сборки>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 1. Каталоги и файлы, которых в форке быть не должно. */
const FORBIDDEN_PATHS = [
	['extensions/copilot', 'встроенное расширение GitHub Copilot'],
	['src/vs/sessions', 'окно Agent Sessions апстрима'],
	['build/lib/copilot.ts', 'сборочный модуль Copilot'],
	['build/azure-pipelines/copilot', 'конвейеры сборки Copilot'],
	['build/agent-sdk', 'payload-пакеты вендорных агент-SDK'],
	['build/dictation-runtime', 'рантайм облачной диктовки Foundry Local'],
	['src/vs/platform/agentHost/node/copilot', 'харнесс Copilot CLI'],
	['src/vs/platform/agentHost/node/claude', 'харнесс Claude CLI'],
	['src/vs/platform/agentHost/node/codex', 'харнесс Codex CLI'],
	['src/vs/platform/localTranscription/node', 'реализация диктовки на Foundry Local'],
	['.github/workflows/copilot-setup-steps.yml', 'workflow подготовки Copilot'],
	['.github/ISSUE_TEMPLATE/copilot_bug_report.md', 'шаблон issue про Copilot'],
	['test/smoke/src/areas/chat/copilotCli.test.ts', 'smoke-тесты харнесса Copilot CLI'],
];

/** 2. Пакеты, которые тянут вендорный код в продукт. */
const FORBIDDEN_PACKAGES = [
	'@github/copilot',
	'@github/copilot-sdk',
	'@vscode/copilot-api',
	'@anthropic-ai/claude-agent-sdk',
	'@openai/codex',
	'foundry-local-sdk',
];

/**
 * 3. Регистрации, включающие Copilot-поверхности. Ключ — файл, значение — что в нём не должно
 * быть исполняемым. Строка считается нарушением, только если она не закомментирована: наши
 * вырезки сделаны комментариями с пометкой, и именно их возврат к жизни нужно ловить.
 */
const FORBIDDEN_REGISTRATIONS = [
	['src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts', 'ChatSetupContribution', 'мастер настройки Copilot'],
	['src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts', 'ChatStatusBarEntry', 'индикатор Copilot в статусной строке'],
	['src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts', 'agentSessions.contribution', 'вклад Agent Sessions'],
	['src/vs/workbench/workbench.common.main.ts', 'agentsVoice.contribution', 'голосовой режим Copilot'],
	['src/vs/workbench/workbench.common.main.ts', 'onboarding.contribution', 'онбординг апстрима'],
	['src/vs/workbench/workbench.desktop.main.ts', 'survey.contribution', 'опросы апстрима'],
];

/** 4. Сетевые адреса вендорных сервисов в product.json. */
const FORBIDDEN_PRODUCT_VALUES = [
	['voiceWsUrl', 'облачный сервис распознавания речи'],
	['agentSdks', 'штамп версий вендорных агент-SDK'],
	['dictationRuntime', 'штамп рантайма облачной диктовки'],
	['copilotVersions', 'штамп версий Copilot'],
];

const violations = [];
const add = (rule, what, why) => violations.push({ rule, what, why });

// --- 1 ---
for (const [rel, why] of FORBIDDEN_PATHS) {
	if (fs.existsSync(path.join(ROOT, rel))) {
		add('путь', rel, why);
	}
}

// --- 2 ---
for (const manifest of ['package.json', 'remote/package.json', 'build/package.json']) {
	const file = path.join(ROOT, manifest);
	if (!fs.existsSync(file)) { continue; }
	const json = JSON.parse(fs.readFileSync(file, 'utf8'));
	const deps = { ...json.dependencies, ...json.devDependencies, ...json.optionalDependencies };
	for (const pkg of FORBIDDEN_PACKAGES) {
		if (deps?.[pkg]) {
			add('зависимость', `${manifest}: ${pkg}@${deps[pkg]}`, 'вендорный пакет в зависимостях');
		}
	}
}

// --- 3 ---
const isCommented = line => /^\s*(\/\/|\*|\/\*)/.test(line);
for (const [rel, needle, why] of FORBIDDEN_REGISTRATIONS) {
	const file = path.join(ROOT, rel);
	if (!fs.existsSync(file)) { continue; }
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	lines.forEach((line, i) => {
		if (line.includes(needle) && !isCommented(line)) {
			add('регистрация', `${rel}:${i + 1} → ${needle}`, why);
		}
	});
}

// --- 4 ---
const productPath = path.join(ROOT, 'product.json');
if (fs.existsSync(productPath)) {
	const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
	for (const [key, why] of FORBIDDEN_PRODUCT_VALUES) {
		if (product[key] !== undefined) {
			add('product.json', key, why);
		}
	}
	// Ключ defaultChatAgent удалять нельзя (апстрим разыменовывает его без проверок),
	// но он обязан быть обезврежен: без GitHub-адресов и без Copilot-команд.
	const agent = product.defaultChatAgent;
	if (agent) {
		for (const [field, value] of Object.entries(agent)) {
			if (typeof value !== 'string') { continue; }
			if (/api\.github\.com|aka\.ms|githubcopilot|github\.copilot/i.test(value)) {
				add('defaultChatAgent', `${field} = ${value}`, 'адрес или команда вендорного сервиса');
			}
		}
	}
}

// --- 5–7: снимки ---

const BASELINE_PATH = path.join(ROOT, 'build/vendorFreeBaseline.json');

/** Barrel-файлы: через них апстрим подключает подсистемы целиком, одной строкой импорта. */
const BARRELS = [
	'src/vs/workbench/workbench.common.main.ts',
	'src/vs/workbench/workbench.desktop.main.ts',
	'src/vs/workbench/contrib/terminal/terminal.all.ts',
	'src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts',
];

const REGISTRATION_RE = /registerWorkbenchContribution2|registerSingleton\(|registerAction2\(|registerConfiguration\(/;

/**
 * Строки вендорных сервисов. Адреса хостов здесь нет намеренно: их стережёт privacy-ci-check.
 * hydraFusion и autoTier — серверный роутер Copilot и его управляемая настройка (VS Code 1.140).
 */
const VENDOR_STRINGS = ['copilot_internal', 'mcp_registry', 'hydraFusion', 'autoTier'];

/** Наш код и тесты в инвентарь не входят: снимок стережёт то, что приезжает с апстримом. */
const isOurs = rel => /vibe/i.test(rel) || /\/test\//.test(rel) || /\.test\.ts$/.test(rel);

const gitFiles = (...pathspecs) => execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	.split('\0').filter(Boolean);

function snapshot() {
	const barrels = {};
	for (const rel of BARRELS) {
		const file = path.join(ROOT, rel);
		barrels[rel] = fs.existsSync(file)
			? fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l.startsWith('import ')).sort()
			: [];
	}
	const registrations = new Set();
	const strings = new Set();
	for (const rel of gitFiles('src/**/*.ts', 'extensions/**/*.ts', 'product.json')) {
		const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		if (!isOurs(rel) && rel.startsWith('src/')) {
			for (const line of text.split('\n')) {
				if (REGISTRATION_RE.test(line) && !isCommented(line)) {
					registrations.add(`${rel}#${line.trim()}`);
				}
			}
		}
		if (!isOurs(rel)) {
			for (const needle of VENDOR_STRINGS) {
				if (text.toLowerCase().includes(needle.toLowerCase())) {
					strings.add(`${rel}#${needle}`);
				}
			}
		}
	}
	return { barrels, registrations: [...registrations].sort(), strings: [...strings].sort() };
}

const current = snapshot();

if (process.argv.includes('--update')) {
	const note = 'Снимок вендорных поверхностей апстрима: импорты barrel-файлов, регистрации вне нашего кода, вхождения вендорных строк. Пишет vibe-copilot-free-check.mjs --update; каждая новая строка — решение человека: вырезать, заглушить или принять.';
	fs.writeFileSync(BASELINE_PATH, JSON.stringify({ note, ...current }, null, '\t') + '\n');
	console.log(`📸 Снимок записан: ${path.relative(ROOT, BASELINE_PATH)} — barrel-импортов ${Object.values(current.barrels).flat().length}, регистраций ${current.registrations.length}, вендорных строк ${current.strings.length}`);
	process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
	add('снимок', path.relative(ROOT, BASELINE_PATH), 'снимка нет — запустите с --update и проверьте его глазами');
} else {
	const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
	for (const [rel, imports] of Object.entries(current.barrels)) {
		const known = new Set(baseline.barrels?.[rel] ?? []);
		for (const line of imports.filter(l => !known.has(l))) {
			add('barrel', `${rel}: ${line}`, 'новый импорт в barrel-файле — подсистема подключается целиком');
		}
	}
	const knownRegistrations = new Set(baseline.registrations ?? []);
	for (const entry of current.registrations.filter(e => !knownRegistrations.has(e))) {
		add('регистрация (снимок)', entry, 'новая регистрация вне нашего кода');
	}
	const knownStrings = new Set(baseline.strings ?? []);
	for (const entry of current.strings.filter(e => !knownStrings.has(e))) {
		add('вендорная строка', entry, 'новое вхождение строки вендорного сервиса');
	}
}

// --- 8: собранное приложение ---

/** Пакеты, которых в собранном приложении быть не должно; mxc-bin — бинарь, который тянет Copilot CLI. */
const ARTIFACT_FORBIDDEN = ['node_modules/@github/copilot', 'node_modules/foundry-local', 'node_modules/@openai/codex', 'mxc-bin'];

/** Пути файлов внутри .asar: заголовок — JSON-дерево после двух полей pickle, тела не читаются. */
function asarPaths(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const sizes = Buffer.alloc(8);
		if (fs.readSync(fd, sizes, 0, 8, 0) < 8) { return []; }
		const headerPickle = Buffer.alloc(sizes.readUInt32LE(4));
		fs.readSync(fd, headerPickle, 0, headerPickle.length, 8);
		const json = JSON.parse(headerPickle.subarray(8, 8 + headerPickle.readUInt32LE(4)).toString('utf8'));
		const out = [];
		const walk = (node, prefix) => {
			for (const [name, child] of Object.entries(node.files ?? {})) {
				const rel = prefix ? `${prefix}/${name}` : name;
				out.push(rel);
				walk(child, rel);
			}
		};
		walk(json, '');
		return out;
	} catch {
		return [];
	} finally {
		fs.closeSync(fd);
	}
}

const artifactIdx = process.argv.indexOf('--artifact');
if (artifactIdx !== -1) {
	const target = process.argv[artifactIdx + 1];
	if (!target || !fs.existsSync(target)) {
		add('артефакт', String(target), 'путь к собранному приложению не найден');
	} else {
		const hits = new Set();
		const check = (rel, where) => {
			const normalized = rel.split(path.sep).join('/');
			for (const needle of ARTIFACT_FORBIDDEN) {
				if (normalized.includes(needle)) { hits.add(`${where}: ${needle}`); }
			}
		};
		const walk = dir => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				check(path.relative(target, full), path.relative(target, full));
				if (entry.isDirectory() && !entry.isSymbolicLink()) {
					walk(full);
				} else if (entry.isFile() && entry.name.endsWith('.asar')) {
					for (const inner of asarPaths(full)) {
						check(`node_modules/${inner}`, `${path.relative(target, full)}!${inner}`);
					}
				}
			}
		};
		walk(target);
		for (const hit of [...hits].sort()) {
			add('артефакт', hit, 'вендорный пакет в собранном приложении');
		}
	}
}

// --- Отчёт ---
if (process.argv.includes('--json')) {
	console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
} else {
	console.log('🚫 Проверка: вендорных AI-поверхностей апстрима нет');
	console.log('─'.repeat(60));
	if (violations.length === 0) {
		console.log('✅ Чисто: ни одна из вендорных поверхностей не вернулась.');
	} else {
		for (const v of violations) {
			console.log(`❌ [${v.rule}] ${v.what}`);
			console.log(`      ${v.why}`);
		}
		console.log(`\nНарушений: ${violations.length}.`);
		console.log('Каждое означает, что обновление базы вернуло вырезанное — проверьте, что именно.');
	}
}

process.exit(violations.length > 0 ? 1 : 0);
