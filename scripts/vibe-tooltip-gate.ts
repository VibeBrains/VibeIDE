#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Подсказки React-части VibeIDE — общая vibe-tooltip, а не нативный `title`
 *
 * Атрибут `title` на HTML-элементе (`<button title=…>`, `<span title=…>`) — находка:
 * Chromium показывает его, только когда курсор около секунды стоит неподвижно, и на маленьком значке
 * подсказка вызывается через раз. Замена — `{...tooltipProps(text)}` из `react/src/util/tooltipProps.ts`
 *
 * Свойство `title` компонента (`<BottomChildren title=…>`) не находка: это его заголовок, а не подсказка
 * Поэтому разбор идёт компилятором TypeScript, а не по строкам — у HTML-элемента имя тега с маленькой буквы
 *
 * Использование:
 *   node scripts/vibe-tooltip-gate.ts <файлы…>   заданные файлы — lint-staged передаёт проиндексированные
 *   node scripts/vibe-tooltip-gate.ts --all      все TSX React-части (npm run tooltip-check)
 */

// `scripts/package.json` закрепляет CommonJS, поэтому здесь require(), как у соседей
const cp: typeof import('child_process') = require('child_process');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const ts: typeof import('typescript') = require('typescript');

const ROOT = path.join(__dirname, '..');
const SCOPE = 'src/vs/workbench/contrib/vibeide/browser/react/src/';
/** Сборка и тесты, которые только цитируют атрибут */
const EXCLUDED: readonly RegExp[] = [/\/react\/out\//, /\/node_modules\//, /\/test\//];
/** Элементы, у которых `title` — доступное имя содержимого, а не подсказка */
const TITLE_IS_NOT_A_HINT: ReadonlySet<string> = new Set(['iframe']);

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly tag: string;
}

function isOwned(file: string): boolean {
	const rel = file.split(path.sep).join('/');
	return rel.startsWith(SCOPE) && rel.endsWith('.tsx') && !EXCLUDED.some(rule => rule.test(rel));
}

/** Имя HTML-элемента или undefined для компонента (`Foo`, `foo.Bar`) */
function intrinsicTagOf(element: import('typescript').JsxOpeningLikeElement): string | undefined {
	const tag = element.tagName;
	return ts.isIdentifier(tag) && /^[a-z]/.test(tag.text) ? tag.text : undefined;
}

function check(file: string): Finding[] {
	const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const findings: Finding[] = [];
	const visit = (node: import('typescript').Node): void => {
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			const tag = intrinsicTagOf(node);
			if (tag && !TITLE_IS_NOT_A_HINT.has(tag)) {
				for (const attribute of node.attributes.properties) {
					if (ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === 'title') {
						const { line } = source.getLineAndCharacterOfPosition(attribute.getStart(source));
						findings.push({ file, line: line + 1, tag });
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return findings;
}

const args = process.argv.slice(2);
const files = args.includes('--all')
	? cp.execFileSync('git', ['ls-files', SCOPE], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
	: args.map(file => path.relative(ROOT, path.resolve(file)));
const findings = files.filter(isOwned).filter(file => fs.existsSync(path.join(ROOT, file))).flatMap(check);

if (findings.length > 0) {
	console.error(`❌ Нативная подсказка title на HTML-элементе: ${findings.length}`);
	for (const finding of findings) {
		console.error(`  ${finding.file}:${finding.line}  <${finding.tag} title=…>`);
	}
	console.error('Замена: {...tooltipProps(text)} из react/src/util/tooltipProps.ts. Почему: docs/knowledge/ui/tooltips.md');
	process.exit(1);
}
console.log(`✅ Подсказки: нативных title на HTML-элементах нет (файлов проверено: ${files.filter(isOwned).length}).`);
