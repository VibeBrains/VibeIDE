#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Каждое правило в каталоге квирков — утверждение о поведении чужого сервера: «эта модель
 * игнорирует reasoning_effort», «этот провайдер отвергает продолжение без reasoning-заглушки».
 * Такие утверждения стареют молча — вендор меняет сервер и никому не сообщает.
 *
 * Проверка требует происхождения (`source`) у НОВЫХ правил. Исторические черновики перечислены
 * в `resources/model-quirks-drafts.txt` и не роняют сборку: они долг, а не повод остановить
 * работу. Список закрыт — добавить туда строку нельзя, не объяснив это в ревью.
 *
 * Отдельно предупреждает о правилах, чьё наблюдение старше года: не ошибка, но повод перепроверить.
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const CATALOGUE = path.join(ROOT, 'resources', 'model-quirks.json');
const DRAFTS = path.join(ROOT, 'resources', 'model-quirks-drafts.txt');
const STALE_AFTER_DAYS = 365;

/** Shape read from the catalogue — only the fields this check judges. */
interface QuirkRule {
	readonly match: string;
	readonly provider?: string;
	readonly source?: string;
	readonly observedAt?: string;
}

const rules: QuirkRule[] = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8')).rules ?? [];
const allowed = new Set(
	fs.existsSync(DRAFTS)
		? fs.readFileSync(DRAFTS, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
		: []
);

const keyOf = (rule: QuirkRule) => `${rule.provider ?? '*'}::${rule.match}`;
const missing: string[] = [];
const stale: string[] = [];
const now = Date.now();

for (const rule of rules) {
	const key = keyOf(rule);
	if (!rule.source && !allowed.has(key)) { missing.push(key); }
	if (rule.observedAt) {
		const seen = Date.parse(rule.observedAt);
		if (!Number.isNaN(seen) && (now - seen) / 86_400_000 > STALE_AFTER_DAYS) {
			stale.push(`${key} — наблюдение от ${rule.observedAt}`);
		}
	}
}

console.log('🔎 Происхождение правил каталога квирков');
console.log('─'.repeat(60));
console.log(`  правил: ${rules.length}, с источником: ${rules.filter((r: QuirkRule) => r.source).length}, исторических черновиков: ${allowed.size}`);

if (stale.length) {
	console.log(`\n⚠️  Наблюдение старше года (${stale.length}) — стоит перепроверить:`);
	for (const s of stale) { console.log(`   ${s}`); }
}

if (missing.length === 0) {
	console.log('\n✅ Все новые правила несут источник.');
	process.exit(0);
}

console.log(`\n❌ Правил без источника и вне списка черновиков: ${missing.length}`);
for (const m of missing) { console.log(`   ${m}`); }
console.log('\nДобавьте в правило поле "source" — ссылку на issue, changelog вендора, коммит upstream');
console.log('или наш лог с воспроизведением. Проценты из вендорских анонсов источником не считаются:');
console.log('агентные бенчмарки меряют связку «модель + харнесс», а не поведение модели под нашим.');
process.exit(1);
