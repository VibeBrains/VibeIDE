/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Каждое событие аудита обязано называть, КТО его вызвал.
 *
 * Поле `actor` обязательно в типе, поэтому пропуск ловит и тайпчек — но только там, где объект
 * собирается литералом. Спред (`append({ ...base, action })`) и приведение типов эту проверку
 * обходят, а в аудите молчаливый пропуск дороже обычного: запись без актора не отвечает на
 * единственный вопрос, ради которого журнал читают после инцидента — это сделал человек или
 * агент от его имени.
 *
 * Проверка грубее компилятора и тем полезна: она смотрит на текст вызова `append(...)` и требует
 * `actor:` внутри. Заодно стережёт возврат мёртвого поля `user`, которое пролежало объявленным и
 * ни разу не заполненным с первого импорта форка.
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const AREA = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');

function* sources(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'test') { continue; }
			yield* sources(full);
		} else if (entry.name.endsWith('.ts')) {
			yield full;
		}
	}
}

const problems: string[] = [];
for (const file of sources(AREA)) {
	const text = fs.readFileSync(file, 'utf8');
	const rel = path.relative(ROOT, file);

	if (/\buser\?:\s*string/.test(text) && rel.endsWith('auditLogService.ts')) {
		problems.push(`${rel}: поле \`user\` вернулось в AuditEvent — оно было объявлено и ни разу не заполнено; актора называет \`actor\``);
	}

	// Every `…audit….append({ … })` call must name its actor. The body is matched non-greedily up
	// to the closing brace of the argument object, which is enough for the flat literals we write.
	for (const call of text.matchAll(/(?:_audit|_auditLogService|auditLogService)\s*\.append\(\{(.{0,900}?)\}\)/gs)) {
		if (!/\bactor:\s*'/.test(call[1])) {
			const action = call[1].match(/action:\s*([^,\n]+)/);
			const line = text.slice(0, call.index).split('\n').length;
			problems.push(`${rel}:${line}: событие аудита без \`actor\` (action: ${action ? action[1].trim() : '?'}) — назовите human/agent/subagent/system`);
		}
	}
}

if (problems.length) {
	console.error('❌ Аудит-события:');
	for (const p of problems) { console.error(`   ${p}`); }
	console.error(`\n   всего: ${problems.length}`);
	process.exit(1);
}
console.log('✅ Аудит-события: у каждого назван актор.');
