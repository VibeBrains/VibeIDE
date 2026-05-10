/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// CLI helper consumed by scripts/vibe-doctor.js — mirrors the schema/audit/repair
// surface of the TS pure helpers so the diagnostics script stays zero-dep.
//
// MUST stay in sync with:
//   - src/vs/workbench/contrib/vibeide/common/projectCommandsTypes.ts
//     (decodeProjectCommandsFile, decodeProjectCommand, PROJECT_COMMAND_ID_PATTERN)
//   - src/vs/workbench/contrib/vibeide/common/projectCommandsCli.ts
//     (auditProjectCommandsForDoctor, repairProjectCommandsForDoctor)

const PROJECT_COMMAND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function decodeProjectCommand(raw) {
	if (raw == null || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const o = raw;
	if (typeof o.id !== 'string' || !PROJECT_COMMAND_ID_PATTERN.test(o.id)) {
		return { ok: false, reason: 'id-invalid' };
	}
	if (typeof o.name !== 'string' || o.name.length === 0) {
		return { ok: false, reason: 'name-missing' };
	}
	if (typeof o.command !== 'string' || o.command.length === 0) {
		return { ok: false, reason: 'command-missing' };
	}
	if (o.terminal !== undefined && o.terminal !== 'integrated' && o.terminal !== 'external' && o.terminal !== 'background') {
		return { ok: false, reason: 'terminal-invalid' };
	}
	if (o.args !== undefined && (!Array.isArray(o.args) || !o.args.every((a) => typeof a === 'string'))) {
		return { ok: false, reason: 'args-invalid' };
	}
	if (o.env !== undefined) {
		if (o.env === null || typeof o.env !== 'object') {
			return { ok: false, reason: 'env-invalid' };
		}
		for (const [k, v] of Object.entries(o.env)) {
			if (typeof v !== 'string') {
				return { ok: false, reason: `env.${k}-not-string` };
			}
		}
	}
	const cmd = { id: o.id, name: o.name, command: o.command };
	if (typeof o.description === 'string') cmd.description = o.description;
	if (typeof o.icon === 'string') cmd.icon = o.icon;
	if (typeof o.color === 'string') cmd.color = o.color;
	if (Array.isArray(o.args)) cmd.args = o.args.slice();
	if (typeof o.cwd === 'string') cmd.cwd = o.cwd;
	if (o.env && typeof o.env === 'object') cmd.env = { ...o.env };
	if (o.terminal === 'integrated' || o.terminal === 'external' || o.terminal === 'background') cmd.terminal = o.terminal;
	if (typeof o.shell === 'boolean') cmd.shell = o.shell;
	if (typeof o.confirm === 'boolean') cmd.confirm = o.confirm;
	if (typeof o.singleton === 'boolean') cmd.singleton = o.singleton;
	if (typeof o.pinned === 'boolean') cmd.pinned = o.pinned;
	if (typeof o.order === 'number' && Number.isFinite(o.order)) cmd.order = o.order;
	if (typeof o.workflowId === 'string') cmd.workflowId = o.workflowId;
	return { ok: true, value: cmd };
}

function decodeProjectCommandsFile(raw) {
	if (raw == null || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const o = raw;
	if (typeof o.vibeVersion !== 'string' || o.vibeVersion.length === 0) {
		return { ok: false, reason: 'vibeVersion-missing' };
	}
	if (!Array.isArray(o.commands)) {
		return { ok: false, reason: 'commands-not-array' };
	}
	const commands = [];
	const seen = new Set();
	for (let i = 0; i < o.commands.length; i++) {
		const decoded = decodeProjectCommand(o.commands[i]);
		if (!decoded.ok) {
			return { ok: false, reason: `commands[${i}]:${decoded.reason}` };
		}
		if (seen.has(decoded.value.id)) {
			return { ok: false, reason: `commands[${i}]:duplicate-id:${decoded.value.id}` };
		}
		seen.add(decoded.value.id);
		commands.push(decoded.value);
	}
	return { ok: true, value: { vibeVersion: o.vibeVersion, commands } };
}

function auditProjectCommandsForDoctor(raw) {
	const decoded = decodeProjectCommandsFile(raw);
	const issues = [];
	if (!decoded.ok) {
		issues.push({ code: 'file-decode-failed', message: `decoder reason: ${decoded.reason}` });
		return { issues, file: null };
	}
	const file = decoded.value;
	if (typeof file.vibeVersion !== 'string' || file.vibeVersion.length === 0) {
		issues.push({ code: 'missing-vibe-version', message: 'vibeVersion is missing or empty' });
	}
	const seen = new Map();
	for (let i = 0; i < file.commands.length; i++) {
		const c = file.commands[i];
		const seenAt = seen.get(c.id);
		if (seenAt !== undefined) {
			issues.push({ code: 'duplicate-id', id: c.id, message: `duplicate id at index ${seenAt} and later` });
		} else {
			seen.set(c.id, i);
		}
		if (!PROJECT_COMMAND_ID_PATTERN.test(c.id)) {
			issues.push({ code: 'invalid-id-pattern', id: c.id, message: `id does not match ${PROJECT_COMMAND_ID_PATTERN.source}` });
		}
		if (typeof c.command !== 'string' || c.command.length === 0) {
			issues.push({ code: 'missing-command', id: c.id, message: 'command field is empty' });
		}
	}
	return { issues, file };
}

function repairProjectCommandsForDoctor(raw, vibeVersion) {
	if (raw === null || typeof raw !== 'object') {
		return { repaired: false, nextRaw: raw, notes: ['file shape is not an object — manual fix required'] };
	}
	const next = { ...raw };
	const notes = [];
	if (typeof next.vibeVersion !== 'string' || next.vibeVersion.length === 0) {
		next.vibeVersion = vibeVersion;
		notes.push(`inserted vibeVersion=${vibeVersion}`);
	}
	if (notes.length === 0) {
		return { repaired: false, nextRaw: raw, notes: ['no auto-repairable issues'] };
	}
	return { repaired: true, nextRaw: next, notes };
}

// Audit-friendly summary for vibe-doctor — never leaks `command`/`env` bodies.
// Caller passes `issues` from `auditProjectCommandsForDoctor` and gets a single
// human-readable string suitable for a `check()` Error message.
function summariseAuditIssues(issues) {
	if (!issues.length) return '';
	const lines = issues.map((i) => {
		const idHint = i.id ? ` id=${i.id}` : '';
		return `${i.code}${idHint}: ${i.message}`;
	});
	return lines.join('; ');
}

module.exports = {
	PROJECT_COMMAND_ID_PATTERN,
	decodeProjectCommandsFile,
	auditProjectCommandsForDoctor,
	repairProjectCommandsForDoctor,
	summariseAuditIssues,
};
