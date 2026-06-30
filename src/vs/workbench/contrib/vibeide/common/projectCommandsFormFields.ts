/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — form-based editor per-field validator
 * (roadmap §"UX: палитра и редактор → Form-based редактор: поля
 * `name / description / icon / color / command / args / cwd / env / terminal /
 * confirm / singleton / pinned`; live-валидация по JSON Schema").
 *
 * Pure helper — `vscode`-free — so the live-input validation can be
 * unit-tested without React / `IConfigurationRegistry`. The form widget
 * passes each field's current input through this helper after each
 * keystroke and surfaces the `FieldValidationIssue` in the inline label
 * area; on save it calls `decodeProjectCommandsFile` for the full-shape
 * pass.
 *
 * Design note: this module is intentionally *more permissive* than
 * `decodeProjectCommandsFile` (which is the strict on-disk decoder) — the
 * form gates per-field while the decoder gates the document. They share
 * the id pattern but the form returns "warning" for partial inputs that
 * would still be invalid for save.
 */

import { ProjectCommand, PROJECT_COMMAND_ID_PATTERN } from './projectCommandsTypes.js';

export type ProjectCommandFieldName =
	| 'id'
	| 'name'
	| 'description'
	| 'icon'
	| 'color'
	| 'command'
	| 'args'
	| 'cwd'
	| 'env'
	| 'terminal'
	| 'confirm'
	| 'singleton'
	| 'pinned'
	| 'order'
	| 'workflowId';

export type FieldValidationSeverity = 'ok' | 'warning' | 'error';

export interface FieldValidationIssue {
	readonly severity: FieldValidationSeverity;
	readonly code: string;
	readonly message: string;
}

/** Codicon name restriction — `$(name)` form. Pure-string validator. */
const CODICON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Conservative CSS color regex — `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, named. */
const CSS_COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[0-9.]+\s*\)|[a-zA-Z]{3,30})$/;

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

/**
 * Validate a single form field. Returns one issue per call (the *worst* one)
 * to keep the live-feedback UI focused. Pure.
 */
export function validateProjectCommandField(
	field: ProjectCommandFieldName,
	value: unknown,
): FieldValidationIssue {
	switch (field) {
		case 'id': return validateId(value);
		case 'name': return validateNonEmptyString(value, 'name');
		case 'description': return validateOptionalString(value, 'description');
		case 'icon': return validateIcon(value);
		case 'color': return validateColor(value);
		case 'command': return validateNonEmptyString(value, 'command');
		case 'args': return validateArgs(value);
		case 'cwd': return validateOptionalString(value, 'cwd');
		case 'env': return validateEnv(value);
		case 'terminal': return validateTerminal(value);
		case 'confirm':
		case 'singleton':
		case 'pinned':
			return validateOptionalBoolean(value, field);
		case 'order':
			return validateOptionalNumber(value, 'order');
		case 'workflowId':
			return validateOptionalIdLike(value, 'workflowId');
	}
}

/**
 * Whole-form validation. Returns a per-field map; `ok` entries are present
 * so the form widget can render green checks for completed fields.
 */
export function validateProjectCommandForm(
	form: Partial<Record<ProjectCommandFieldName, unknown>>,
): Readonly<Record<ProjectCommandFieldName, FieldValidationIssue>> {
	const fields: ProjectCommandFieldName[] = [
		'id', 'name', 'description', 'icon', 'color', 'command', 'args',
		'cwd', 'env', 'terminal', 'confirm', 'singleton', 'pinned',
		'order', 'workflowId',
	];
	const out: Record<ProjectCommandFieldName, FieldValidationIssue> = Object.fromEntries(
		fields.map(f => [f, validateProjectCommandField(f, form[f])]),
	) as Record<ProjectCommandFieldName, FieldValidationIssue>;
	return out;
}

/**
 * Convenience: returns true iff ALL required fields pass and no error-severity
 * issues exist anywhere in the form.
 */
export function isProjectCommandFormSavable(
	results: Readonly<Record<ProjectCommandFieldName, FieldValidationIssue>>,
): boolean {
	const required: ProjectCommandFieldName[] = ['id', 'name', 'command'];
	for (const f of required) {
		if (results[f].severity !== 'ok') { return false; }
	}
	for (const f of Object.keys(results) as ProjectCommandFieldName[]) {
		if (results[f].severity === 'error') { return false; }
	}
	return true;
}

// -----------------------------------------------------------------------------
// Per-field validators
// -----------------------------------------------------------------------------

function validateId(value: unknown): FieldValidationIssue {
	if (value === undefined || value === null || value === '') {
		return { severity: 'error', code: 'id-missing', message: 'Идентификатор обязателен.' };
	}
	if (typeof value !== 'string') {
		return { severity: 'error', code: 'id-not-string', message: 'Идентификатор должен быть строкой.' };
	}
	if (!PROJECT_COMMAND_ID_PATTERN.test(value)) {
		return {
			severity: 'error',
			code: 'id-pattern',
			message: 'Только латиница, цифры, дефис; не начинаются с дефиса; до 64 символов.',
		};
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateNonEmptyString(value: unknown, field: string): FieldValidationIssue {
	if (value === undefined || value === null || value === '') {
		return { severity: 'error', code: `${field}-missing`, message: 'Поле обязательно.' };
	}
	if (typeof value !== 'string') {
		return { severity: 'error', code: `${field}-not-string`, message: 'Поле должно быть строкой.' };
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateOptionalString(value: unknown, field: string): FieldValidationIssue {
	if (value === undefined || value === null || value === '') {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (typeof value !== 'string') {
		return { severity: 'error', code: `${field}-not-string`, message: 'Поле должно быть строкой.' };
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateOptionalBoolean(value: unknown, field: string): FieldValidationIssue {
	if (value === undefined || value === null) {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (typeof value !== 'boolean') {
		return { severity: 'error', code: `${field}-not-boolean`, message: 'Должно быть `true` или `false`.' };
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateOptionalNumber(value: unknown, field: string): FieldValidationIssue {
	if (value === undefined || value === null) {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return { severity: 'error', code: `${field}-not-number`, message: 'Должно быть конечным числом.' };
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateOptionalIdLike(value: unknown, field: string): FieldValidationIssue {
	if (value === undefined || value === null || value === '') {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (typeof value !== 'string') {
		return { severity: 'error', code: `${field}-not-string`, message: 'Должно быть строкой.' };
	}
	if (!PROJECT_COMMAND_ID_PATTERN.test(value)) {
		return {
			severity: 'error',
			code: `${field}-pattern`,
			message: 'Только латиница, цифры, дефис; до 64 символов.',
		};
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateIcon(value: unknown): FieldValidationIssue {
	if (value === undefined || value === null || value === '') {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (typeof value !== 'string') {
		return { severity: 'error', code: 'icon-not-string', message: 'Иконка должна быть строкой.' };
	}
	if (!CODICON_PATTERN.test(value)) {
		return {
			severity: 'warning',
			code: 'icon-not-codicon',
			message: 'Похоже не на codicon-имя. Используйте например `play`, `git-branch`.',
		};
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateColor(value: unknown): FieldValidationIssue {
	if (value === undefined || value === null || value === '') {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (typeof value !== 'string') {
		return { severity: 'error', code: 'color-not-string', message: 'Цвет должен быть строкой.' };
	}
	if (!CSS_COLOR_PATTERN.test(value.trim())) {
		return {
			severity: 'warning',
			code: 'color-suspicious',
			message: 'Не похоже на CSS-цвет (`#rgb`, `#rrggbb`, `rgb(...)`, имя).',
		};
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateArgs(value: unknown): FieldValidationIssue {
	if (value === undefined || value === null) {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (!Array.isArray(value)) {
		return {
			severity: 'error',
			code: 'args-not-array',
			message: 'Аргументы должны быть массивом строк (а не строкой с пробелами — это shell-инъекция).',
		};
	}
	for (let i = 0; i < value.length; i++) {
		if (typeof value[i] !== 'string') {
			return {
				severity: 'error',
				code: 'args-non-string',
				message: `Аргумент #${i} должен быть строкой.`,
			};
		}
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateEnv(value: unknown): FieldValidationIssue {
	if (value === undefined || value === null) {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (typeof value !== 'object' || Array.isArray(value)) {
		return { severity: 'error', code: 'env-not-object', message: 'Env должен быть объектом ключ→значение.' };
	}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (!ENV_KEY_PATTERN.test(k)) {
			return {
				severity: 'warning',
				code: 'env-key-pattern',
				message: `Ключ "${k}" не похож на shell-идентификатор (UPPER_SNAKE).`,
			};
		}
		if (typeof v !== 'string') {
			return {
				severity: 'error',
				code: 'env-value-not-string',
				message: `Значение env."${k}" должно быть строкой.`,
			};
		}
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

function validateTerminal(value: unknown): FieldValidationIssue {
	if (value === undefined || value === null) {
		return { severity: 'ok', code: 'ok', message: '' };
	}
	if (value !== 'integrated' && value !== 'external' && value !== 'background') {
		return {
			severity: 'error',
			code: 'terminal-invalid',
			message: 'Допустимо только `integrated` / `external` / `background`.',
		};
	}
	return { severity: 'ok', code: 'ok', message: '' };
}

/**
 * Convert a successfully-validated form back to a `ProjectCommand` shape.
 * Pure — caller validates first via `validateProjectCommandForm` +
 * `isProjectCommandFormSavable` and only calls this on success.
 */
export function buildProjectCommandFromForm(
	form: Partial<Record<ProjectCommandFieldName, unknown>>,
): ProjectCommand {
	const out: ProjectCommand = {
		id: form.id as string,
		name: form.name as string,
		command: form.command as string,
	};
	if (typeof form.description === 'string' && form.description.length > 0) { (out as { description?: string }).description = form.description; }
	if (typeof form.icon === 'string' && form.icon.length > 0) { (out as { icon?: string }).icon = form.icon; }
	if (typeof form.color === 'string' && form.color.length > 0) { (out as { color?: string }).color = form.color; }
	if (Array.isArray(form.args)) { (out as { args?: readonly string[] }).args = form.args.slice(); }
	if (typeof form.cwd === 'string' && form.cwd.length > 0) { (out as { cwd?: string }).cwd = form.cwd; }
	if (form.env && typeof form.env === 'object' && !Array.isArray(form.env)) {
		(out as { env?: Record<string, string> }).env = { ...(form.env as Record<string, string>) };
	}
	if (form.terminal === 'integrated' || form.terminal === 'external' || form.terminal === 'background') {
		(out as { terminal?: 'integrated' | 'external' | 'background' }).terminal = form.terminal;
	}
	if (typeof form.confirm === 'boolean') { (out as { confirm?: boolean }).confirm = form.confirm; }
	if (typeof form.singleton === 'boolean') { (out as { singleton?: boolean }).singleton = form.singleton; }
	if (typeof form.pinned === 'boolean') { (out as { pinned?: boolean }).pinned = form.pinned; }
	if (typeof form.order === 'number' && Number.isFinite(form.order)) { (out as { order?: number }).order = form.order; }
	if (typeof form.workflowId === 'string' && form.workflowId.length > 0) { (out as { workflowId?: string }).workflowId = form.workflowId; }
	return out;
}
