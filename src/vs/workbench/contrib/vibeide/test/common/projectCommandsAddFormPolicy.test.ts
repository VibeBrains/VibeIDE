/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	ADD_COMMAND_DRAFT_EMPTY,
	ADD_COMMAND_ERROR,
	AddCommandDraft,
	appendCommandToFile,
	buildProjectCommandFromDraft,
	parseArgsText,
	previewProjectCommandJson,
	removeCommandFromFile,
	serializeCommandsFile,
	setPinnedInFile,
	validateAddCommandDraft,
} from '../../common/projectCommandsAddFormPolicy.js';
import { decodeProjectCommandsFile, ProjectCommandsFile } from '../../common/projectCommandsTypes.js';

const baseDraft: AddCommandDraft = Object.freeze({
	...ADD_COMMAND_DRAFT_EMPTY,
	id: 'lint',
	name: 'Run lint',
	command: 'npm',
	argsText: 'run\nlint',
});

const sampleFile: ProjectCommandsFile = Object.freeze({
	vibeVersion: '1.0.0',
	commands: Object.freeze([
		{ id: 'example', name: 'Hello', command: 'echo', args: ['Hello'], pinned: true, order: 0 },
	]) as readonly any[],
}) as ProjectCommandsFile;

suite('Project Commands — Add-form policy: validation', () => {

	test('empty draft → id and name and command missing', () => {
		const r = validateAddCommandDraft(ADD_COMMAND_DRAFT_EMPTY, new Set());
		assert.strictEqual(r.errors.id, ADD_COMMAND_ERROR.idMissing);
		assert.strictEqual(r.errors.name, ADD_COMMAND_ERROR.nameMissing);
		assert.strictEqual(r.errors.command, ADD_COMMAND_ERROR.commandMissing);
		assert.strictEqual(r.isValid, false);
	});

	test('valid draft → isValid=true, all errors null', () => {
		const r = validateAddCommandDraft(baseDraft, new Set());
		assert.strictEqual(r.isValid, true);
		assert.strictEqual(r.errors.id, null);
		assert.strictEqual(r.errors.name, null);
		assert.strictEqual(r.errors.command, null);
	});

	test('id pattern: uppercase rejected', () => {
		const r = validateAddCommandDraft({ ...baseDraft, id: 'LintTask' }, new Set());
		assert.strictEqual(r.errors.id, ADD_COMMAND_ERROR.idPattern);
		assert.strictEqual(r.isValid, false);
	});

	test('id pattern: spaces / underscores / dots rejected', () => {
		for (const bad of ['my command', 'my_command', 'my.command', 'with space']) {
			const r = validateAddCommandDraft({ ...baseDraft, id: bad }, new Set());
			assert.strictEqual(r.errors.id, ADD_COMMAND_ERROR.idPattern, `expected pattern error for "${bad}"`);
		}
	});

	test('id pattern: dashes and digits accepted', () => {
		const r = validateAddCommandDraft({ ...baseDraft, id: 'deploy-dev-01' }, new Set());
		assert.strictEqual(r.errors.id, null);
	});

	test('id pattern: must not start with dash', () => {
		const r = validateAddCommandDraft({ ...baseDraft, id: '-leading-dash' }, new Set());
		assert.strictEqual(r.errors.id, ADD_COMMAND_ERROR.idPattern);
	});

	test('id pattern: max 64 chars', () => {
		const long = 'a'.repeat(65);
		const r = validateAddCommandDraft({ ...baseDraft, id: long }, new Set());
		assert.strictEqual(r.errors.id, ADD_COMMAND_ERROR.idPattern);
	});

	test('id duplicate: rejected when id already used', () => {
		const r = validateAddCommandDraft({ ...baseDraft, id: 'example' }, new Set(['example']));
		assert.strictEqual(r.errors.id, ADD_COMMAND_ERROR.idDuplicate);
		assert.strictEqual(r.isValid, false);
	});

	test('cwd: absolute Unix path rejected', () => {
		const r = validateAddCommandDraft({ ...baseDraft, cwd: '/etc' }, new Set());
		assert.strictEqual(r.errors.cwd, ADD_COMMAND_ERROR.cwdAbsolute);
	});

	test('cwd: absolute Windows path rejected', () => {
		const r = validateAddCommandDraft({ ...baseDraft, cwd: 'C:\\Windows' }, new Set());
		assert.strictEqual(r.errors.cwd, ADD_COMMAND_ERROR.cwdAbsolute);
		const r2 = validateAddCommandDraft({ ...baseDraft, cwd: 'D:/tmp' }, new Set());
		assert.strictEqual(r2.errors.cwd, ADD_COMMAND_ERROR.cwdAbsolute);
	});

	test('cwd: parent traversal rejected', () => {
		const r = validateAddCommandDraft({ ...baseDraft, cwd: '../escape' }, new Set());
		assert.strictEqual(r.errors.cwd, ADD_COMMAND_ERROR.cwdTraversal);
		const r2 = validateAddCommandDraft({ ...baseDraft, cwd: 'foo/../bar' }, new Set());
		assert.strictEqual(r2.errors.cwd, ADD_COMMAND_ERROR.cwdTraversal);
	});

	test('cwd: relative paths accepted', () => {
		for (const ok of ['scripts', 'scripts/deploy', './tools', 'a/b/c']) {
			const r = validateAddCommandDraft({ ...baseDraft, cwd: ok }, new Set());
			assert.strictEqual(r.errors.cwd, null, `expected accept for cwd "${ok}"`);
		}
	});

	test('order: empty stays valid', () => {
		const r = validateAddCommandDraft({ ...baseDraft, orderText: '' }, new Set());
		assert.strictEqual(r.errors.order, null);
	});

	test('order: integer accepted', () => {
		const r = validateAddCommandDraft({ ...baseDraft, orderText: '42' }, new Set());
		assert.strictEqual(r.errors.order, null);
	});

	test('order: non-numeric rejected', () => {
		const r = validateAddCommandDraft({ ...baseDraft, orderText: 'abc' }, new Set());
		assert.strictEqual(r.errors.order, ADD_COMMAND_ERROR.orderNotNumber);
	});

	test('order: float rejected (must be integer)', () => {
		const r = validateAddCommandDraft({ ...baseDraft, orderText: '1.5' }, new Set());
		assert.strictEqual(r.errors.order, ADD_COMMAND_ERROR.orderNotNumber);
	});
});

suite('Project Commands — Add-form policy: build', () => {

	test('build → minimal command (no optional fields)', () => {
		const cmd = buildProjectCommandFromDraft({
			...ADD_COMMAND_DRAFT_EMPTY,
			id: 'lint',
			name: 'Lint',
			command: 'npm',
		});
		assert.deepStrictEqual(cmd, { id: 'lint', name: 'Lint', command: 'npm' });
	});

	test('build → strips empty optional fields', () => {
		const cmd = buildProjectCommandFromDraft({
			...ADD_COMMAND_DRAFT_EMPTY,
			id: 'lint',
			name: 'Lint',
			description: '   ',
			command: 'npm',
			argsText: '',
			cwd: '  ',
		});
		assert.strictEqual('description' in cmd, false);
		assert.strictEqual('args' in cmd, false);
		assert.strictEqual('cwd' in cmd, false);
	});

	test('build → trims fields and parses args by newline', () => {
		const cmd = buildProjectCommandFromDraft({
			...baseDraft,
			argsText: '  run \n lint \n\n--fix\n',
			cwd: '  scripts ',
			description: '  Run ESLint  ',
		});
		assert.deepStrictEqual(cmd.args, ['run', 'lint', '--fix']);
		assert.strictEqual(cmd.cwd, 'scripts');
		assert.strictEqual(cmd.description, 'Run ESLint');
	});

	test('build → terminal=external preserved', () => {
		const cmd = buildProjectCommandFromDraft({ ...baseDraft, terminal: 'external' });
		assert.strictEqual(cmd.terminal, 'external');
	});

	test('build → pinned=true preserved, false omitted', () => {
		const pinned = buildProjectCommandFromDraft({ ...baseDraft, pinned: true });
		assert.strictEqual(pinned.pinned, true);
		const notPinned = buildProjectCommandFromDraft({ ...baseDraft, pinned: false });
		assert.strictEqual('pinned' in notPinned, false);
	});

	test('build → order=0 preserved', () => {
		const cmd = buildProjectCommandFromDraft({ ...baseDraft, orderText: '0' });
		assert.strictEqual(cmd.order, 0);
	});

	test('build → invalid order text silently dropped (validator gates this earlier)', () => {
		const cmd = buildProjectCommandFromDraft({ ...baseDraft, orderText: 'oops' });
		assert.strictEqual('order' in cmd, false);
	});

	test('build → round-trip through strict decoder', () => {
		const cmd = buildProjectCommandFromDraft(baseDraft);
		const file = { vibeVersion: '1.0.0', commands: [cmd] };
		const decoded = decodeProjectCommandsFile(JSON.parse(JSON.stringify(file)));
		assert.strictEqual(decoded.ok, true);
	});
});

suite('Project Commands — Add-form policy: preview + file mutations', () => {

	test('previewProjectCommandJson → pretty JSON, no trailing newline', () => {
		const text = previewProjectCommandJson(buildProjectCommandFromDraft(baseDraft));
		assert.ok(text.startsWith('{'));
		assert.ok(text.includes('"id": "lint"'));
		assert.ok(!text.endsWith('\n'));
	});

	test('parseArgsText: handles CRLF and trims', () => {
		assert.deepStrictEqual(parseArgsText('run\r\nlint\r\n'), ['run', 'lint']);
		assert.deepStrictEqual(parseArgsText('  a  \n\n  b  '), ['a', 'b']);
	});

	test('appendCommandToFile: preserves vibeVersion + existing entries; new goes last', () => {
		const cmd = buildProjectCommandFromDraft(baseDraft);
		const { file, serialized } = appendCommandToFile(sampleFile, cmd);
		assert.strictEqual(file.vibeVersion, '1.0.0');
		assert.strictEqual(file.commands.length, 2);
		assert.strictEqual(file.commands[0].id, 'example');
		assert.strictEqual(file.commands[1].id, 'lint');
		assert.ok(serialized.endsWith('\n'));
		// strict decoder accepts the produced text
		const decoded = decodeProjectCommandsFile(JSON.parse(serialized));
		assert.strictEqual(decoded.ok, true);
	});

	test('setPinnedInFile: returns null when id absent', () => {
		const r = setPinnedInFile(sampleFile, 'nope', true);
		assert.strictEqual(r, null);
	});

	test('setPinnedInFile: flips pinned for matching id', () => {
		const r = setPinnedInFile(sampleFile, 'example', false);
		assert.notStrictEqual(r, null);
		assert.strictEqual(r!.file.commands[0].pinned, false);
	});

	test('removeCommandFromFile: returns null when id absent', () => {
		const r = removeCommandFromFile(sampleFile, 'nope');
		assert.strictEqual(r, null);
	});

	test('removeCommandFromFile: drops matching entry', () => {
		const r = removeCommandFromFile(sampleFile, 'example');
		assert.notStrictEqual(r, null);
		assert.strictEqual(r!.file.commands.length, 0);
		assert.strictEqual(r!.file.vibeVersion, '1.0.0');
	});

	test('serializeCommandsFile: tab indent + trailing newline', () => {
		const out = serializeCommandsFile(sampleFile);
		assert.ok(out.endsWith('\n'));
		assert.ok(out.includes('\t"vibeVersion"'));
	});
});
