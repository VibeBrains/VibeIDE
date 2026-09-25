/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Детектор нейрослопа из командной строки — тот же каталог и тот же счёт, что у инструмента агента и гейта хода.
 *
 * Запуск: `npx tsx scripts/vibe-text-slop.ts [--overrides <файл в формате .vibe/slop.json>] <файл | ->`
 * Код выхода: 0 — текст проходит, 1 — не проходит, 2 — проверить не удалось (нет файла, каталог не читается).
 * Им проверяет заметки к релизу `scripts/vibe-release-lint.js`.
 */

import { readFileSync } from 'fs';
import { compileShippedSlopCatalog, runSlopRequest } from '../src/vs/workbench/contrib/vibeide/common/textSlop/textSlopWorker.js';
import { renderSlopReport } from '../src/vs/workbench/contrib/vibeide/common/textSlop/slopRender.js';

const args = process.argv.slice(2);
const overridesAt = args.indexOf('--overrides');
const overridesFile = overridesAt >= 0 ? args[overridesAt + 1] : undefined;
// Without --overrides its index is -1, and `i !== overridesAt + 1` would drop the file argument itself
const target = args.filter((_, i) => overridesAt < 0 || (i !== overridesAt && i !== overridesAt + 1))[0];
if (!target) {
	console.error('Использование: vibe-text-slop.ts [--overrides <файл>] <файл | ->');
	process.exit(2);
}
let text: string;
let overrides: string | undefined;
try {
	text = readFileSync(target === '-' ? 0 : target, 'utf8');
	overrides = overridesFile ? readFileSync(overridesFile, 'utf8') : undefined;
} catch (error) {
	console.error(`Не прочитать: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}
const reply = runSlopRequest({ texts: [text], ...(overrides !== undefined ? { overrides } : {}) }, compileShippedSlopCatalog());
const report = reply.reports?.[0];
if (!report) {
	console.error(`Каталог примет нейрослопа не читается: ${reply.warnings.join('; ')}`);
	process.exit(2);
}
console.log(renderSlopReport(report, reply.warnings));
process.exit(report.passed ? 0 : 1);
