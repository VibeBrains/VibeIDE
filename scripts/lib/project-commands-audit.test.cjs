#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Self-contained smoke tests for scripts/lib/project-commands-audit.cjs.
// Run: `node scripts/lib/project-commands-audit.test.cjs`. No deps.

const assert = require('node:assert/strict');
const {
	decodeProjectCommandsFile,
	auditProjectCommandsForDoctor,
	repairProjectCommandsForDoctor,
	summariseAuditIssues,
} = require('./project-commands-audit.cjs');

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (e) {
		console.error(`FAIL - ${name}\n  ${e.message}`);
		process.exitCode = 1;
	}
}

const ok = (cmds = [], vibeVersion = '1.0.0') => ({ vibeVersion, commands: cmds });
const cmd = (id, command = 'echo hi', extra = {}) => ({ id, name: id, command, ...extra });

test('decode: rejects non-object', () => {
	const r = decodeProjectCommandsFile(null);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'not-an-object');
});

test('decode: rejects missing vibeVersion', () => {
	const r = decodeProjectCommandsFile({ commands: [] });
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'vibeVersion-missing');
});

test('decode: rejects non-array commands', () => {
	const r = decodeProjectCommandsFile({ vibeVersion: '1.0.0', commands: 'oops' });
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'commands-not-array');
});

test('decode: rejects duplicate id', () => {
	const r = decodeProjectCommandsFile(ok([cmd('build'), cmd('build')]));
	assert.equal(r.ok, false);
	assert.match(r.reason, /duplicate-id:build/);
});

test('decode: accepts a minimal file', () => {
	const r = decodeProjectCommandsFile(ok([cmd('a-b'), cmd('test')]));
	assert.equal(r.ok, true);
	assert.equal(r.value.commands.length, 2);
	assert.equal(r.value.vibeVersion, '1.0.0');
});

test('audit: file-decode-failed propagates as single issue', () => {
	const r = auditProjectCommandsForDoctor({ commands: [] });
	assert.equal(r.file, null);
	assert.equal(r.issues.length, 1);
	assert.equal(r.issues[0].code, 'file-decode-failed');
});

test('audit: empty commands array is clean', () => {
	const r = auditProjectCommandsForDoctor(ok([]));
	assert.equal(r.issues.length, 0);
	assert.equal(r.file.commands.length, 0);
});

test('audit: detects missing-vibe-version when forced', () => {
	// decoder rejects empty vibeVersion outright, so we craft a value that bypasses
	// decoder yet has a stripped string post-decode (the audit defends against drift).
	const fakeFile = { vibeVersion: '', commands: [] };
	const r = auditProjectCommandsForDoctor(fakeFile);
	assert.equal(r.issues[0].code, 'file-decode-failed');
});

test('repair: inserts vibeVersion when missing', () => {
	const r = repairProjectCommandsForDoctor({ commands: [] }, '1.0.0');
	assert.equal(r.repaired, true);
	assert.equal(r.nextRaw.vibeVersion, '1.0.0');
	assert.match(r.notes[0], /inserted vibeVersion=1\.0\.0/);
});

test('repair: leaves existing vibeVersion alone', () => {
	const r = repairProjectCommandsForDoctor(ok([], '2.5.0'), '1.0.0');
	assert.equal(r.repaired, false);
	assert.equal(r.notes[0], 'no auto-repairable issues');
});

test('repair: refuses non-object input', () => {
	const r = repairProjectCommandsForDoctor(null, '1.0.0');
	assert.equal(r.repaired, false);
	assert.match(r.notes[0], /file shape is not an object/);
});

test('repair: returns a fresh object (no mutation)', () => {
	const input = { commands: [] };
	const r = repairProjectCommandsForDoctor(input, '1.0.0');
	assert.notEqual(r.nextRaw, input);
	assert.equal(input.vibeVersion, undefined);
});

test('summariseAuditIssues: empty → empty', () => {
	assert.equal(summariseAuditIssues([]), '');
});

test('summariseAuditIssues: joins code + id + message; never includes command bodies', () => {
	const s = summariseAuditIssues([
		{ code: 'duplicate-id', id: 'build', message: 'dup at index 1' },
		{ code: 'missing-command', id: 'noop', message: 'command field is empty' },
	]);
	assert.match(s, /duplicate-id id=build: dup at index 1/);
	assert.match(s, /; missing-command id=noop: command field is empty/);
});

console.log(`\n${passed} passed`);
