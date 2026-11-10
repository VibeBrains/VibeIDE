#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Гейт: docs/tools.md совпадает с реестром инструментов агента.
 *
 * Список инструментов, их категории согласия и описания живут в коде — в `builtinToolDefs`.
 * Документ нужен человеку и агенту, поэтому он не пишется руками: расхождение означает, что
 * инструмент добавили или переименовали, а читающий видит старый список. Гейт сверяет файл
 * с рендером и падает при расхождении, не трогая рабочее дерево.
 *
 * Использование:
 *   npx tsx scripts/vibe-tools-doc.ts           сверить docs/tools.md (по умолчанию)
 *   npx tsx scripts/vibe-tools-doc.ts --write   перезаписать docs/tools.md
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
	renderToolsDocMarkdown, toolsDocRows,
} from '../src/vs/workbench/contrib/vibeide/common/prompt/tools/toolsDoc.js';

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'docs', 'tools.md');
const expected = renderToolsDocMarkdown();

if (process.argv.includes('--write')) {
	writeFileSync(OUT, expected, 'utf8');
	console.log(`✅ docs/tools.md записан: ${toolsDocRows().length} инструментов.`);
} else {
	const actual = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
	if (actual === expected) {
		console.log(`✅ docs/tools.md совпадает с реестром: ${toolsDocRows().length} инструментов.`);
	} else {
		console.error('❌ docs/tools.md расходится с реестром инструментов (builtinToolDefs).');
		console.error(actual
			? '   Код изменился, а документ — нет. Починка: npx tsx scripts/vibe-tools-doc.ts --write'
			: '   Документа нет. Починка: npx tsx scripts/vibe-tools-doc.ts --write');
		process.exit(1);
	}
}
