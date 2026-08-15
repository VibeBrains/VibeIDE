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
 * Использование:
 *   node scripts/vibe-copilot-free-check.mjs
 *   node scripts/vibe-copilot-free-check.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
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
