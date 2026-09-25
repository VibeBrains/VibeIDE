/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Храповик нейрослопа по документации: число находок детектора в `docs/**` и `README.md` не растёт.
 *
 * Документацию пишут и люди, и агенты; детектор (`common/textSlop`) у продукта есть, а своя документация им не
 * проверялась. Переписывать всё разом незачем — храповик только не даёт становиться хуже: больше находок, чем в
 * базе, — отказ со списком худших файлов; меньше — база опускается сама, и следующий коммит держит новую планку.
 * VibeIDEA держит так же (`vibe-plugins/tools/checkVibeSlop.sh`).
 *
 * Запуск: `npx tsx scripts/vibe-slop-ratchet.ts` (pre-commit — при правке `.md`). Каталог — встроенный, плюс
 * `scripts/slopHouseStyle.json` — отключения под дом-стиль документации, формат `.vibe/slop.json`. Отдельную находку
 * в тексте снимает `<!-- slop-ignore ID — причина -->`.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { compileShippedSlopCatalog, runSlopRequest } from '../src/vs/workbench/contrib/vibeide/common/textSlop/textSlopWorker.js';

const ROOT = join(__dirname, '..');
const BASELINE = join(ROOT, 'scripts', 'slopRatchet.txt');
const HOUSE_STYLE = join(ROOT, 'scripts', 'slopHouseStyle.json');
/** Worst files named on a refusal — enough to know where to look, not a report of everything */
const WORST_SHOWN = 15;

function markdownUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			out.push(...markdownUnder(path));
		} else if (name.toLowerCase().endsWith('.md')) {
			out.push(path);
		}
	}
	return out;
}

const files = [join(ROOT, 'README.md'), ...markdownUnder(join(ROOT, 'docs'))];
const shipped = compileShippedSlopCatalog();
if (!shipped.catalog) {
	console.error(`❌ Каталог примет нейрослопа не читается: ${shipped.warnings.join('; ')}`);
	process.exit(2);
}
const overrides = readFileSync(HOUSE_STYLE, 'utf8');
const texts = files.map(file => readFileSync(file, 'utf8'));
const reply = runSlopRequest({ overrides, texts }, shipped);
if (!reply.reports) {
	console.error('❌ Детектор не вернул отчётов');
	process.exit(2);
}
if (reply.warnings.length > 0) {
	console.error(`⚠️  ${reply.warnings.join('\n⚠️  ')}`);
}
const perFile = files.map((file, i) => ({ file: relative(ROOT, file), count: reply.reports![i].findings.length }));
const total = perFile.reduce((sum, f) => sum + f.count, 0);
console.log(`SLOP_FINDINGS=${total}`);

const baseline = Number(readFileSync(BASELINE, 'utf8').trim());
if (!Number.isFinite(baseline)) {
	console.error(`❌ Базы храповика нет или она не число: ${relative(ROOT, BASELINE)}`);
	process.exit(2);
}
if (total > baseline) {
	console.error(`❌ Нейрослоп в документации вырос: ${total} находок против ${baseline} в базе.`);
	console.error('Худшие файлы (проверить — инструментом vibe_text_slop_check или действием «Нейрослоп в тексте»):');
	for (const f of perFile.filter(f => f.count > 0).sort((a, b) => b.count - a.count).slice(0, WORST_SHOWN)) {
		console.error(`  ${f.count}\t${f.file}`);
	}
	console.error('Порядок правки — навык anti-slop. Находку, которая намеренна, снимает <!-- slop-ignore ID — причина -->.');
	process.exit(1);
}
if (total < baseline) {
	writeFileSync(BASELINE, `${total}\n`);
	console.log(`✅ Находок стало меньше: ${baseline} → ${total}, база опущена (${relative(ROOT, BASELINE)} — закоммитьте её).`);
} else {
	console.log(`✅ Нейрослоп в документации не вырос: ${total}.`);
}
