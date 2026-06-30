/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	validateProjectCommandField,
	validateProjectCommandForm,
	isProjectCommandFormSavable,
	buildProjectCommandFromForm,
} from '../../common/projectCommandsFormFields.js';
import { decodeProjectCommandsFile } from '../../common/projectCommandsTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Project Commands — form-based editor field validator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('id validation', () => {
		test('valid id → ok', () => {
			assert.strictEqual(validateProjectCommandField('id', 'build-react').severity, 'ok');
		});
		test('empty / undefined → error id-missing', () => {
			assert.strictEqual(validateProjectCommandField('id', '').code, 'id-missing');
			assert.strictEqual(validateProjectCommandField('id', undefined).code, 'id-missing');
		});
		test('non-string → error', () => {
			assert.strictEqual(validateProjectCommandField('id', 42).severity, 'error');
		});
		test('uppercase / spaces → pattern error', () => {
			assert.strictEqual(validateProjectCommandField('id', 'Build').code, 'id-pattern');
			assert.strictEqual(validateProjectCommandField('id', 'a b').code, 'id-pattern');
		});
	});

	suite('required fields', () => {
		test('name empty → error', () => {
			assert.strictEqual(validateProjectCommandField('name', '').severity, 'error');
		});
		test('command empty → error', () => {
			assert.strictEqual(validateProjectCommandField('command', '').severity, 'error');
		});
	});

	suite('optional strings', () => {
		test('description omitted → ok', () => {
			assert.strictEqual(validateProjectCommandField('description', undefined).severity, 'ok');
		});
		test('description non-string → error', () => {
			assert.strictEqual(validateProjectCommandField('description', 42).severity, 'error');
		});
	});

	suite('icon / color', () => {
		test('valid codicon name → ok', () => {
			assert.strictEqual(validateProjectCommandField('icon', 'play').severity, 'ok');
			assert.strictEqual(validateProjectCommandField('icon', 'git-branch').severity, 'ok');
		});
		test('icon with $() brackets → warning', () => {
			assert.strictEqual(validateProjectCommandField('icon', '$(play)').severity, 'warning');
		});
		test('valid CSS color → ok', () => {
			assert.strictEqual(validateProjectCommandField('color', '#ff0').severity, 'ok');
			assert.strictEqual(validateProjectCommandField('color', '#ffaa00').severity, 'ok');
			assert.strictEqual(validateProjectCommandField('color', 'rebeccapurple').severity, 'ok');
		});
		test('garbage color → warning', () => {
			assert.strictEqual(validateProjectCommandField('color', 'oops!!').severity, 'warning');
		});
		test('color empty → ok', () => {
			assert.strictEqual(validateProjectCommandField('color', '').severity, 'ok');
		});
	});

	suite('args', () => {
		test('array of strings → ok', () => {
			assert.strictEqual(validateProjectCommandField('args', ['a', 'b']).severity, 'ok');
		});
		test('plain string → error (no shell injection escape hatch)', () => {
			assert.strictEqual(validateProjectCommandField('args', 'a b c').code, 'args-not-array');
		});
		test('array with non-string → error with index', () => {
			const r = validateProjectCommandField('args', ['a', 42]);
			assert.strictEqual(r.code, 'args-non-string');
			assert.ok(r.message.includes('#1'));
		});
		test('omitted → ok', () => {
			assert.strictEqual(validateProjectCommandField('args', undefined).severity, 'ok');
		});
	});

	suite('env', () => {
		test('valid env → ok', () => {
			assert.strictEqual(validateProjectCommandField('env', { FOO: 'bar' }).severity, 'ok');
		});
		test('env array → error', () => {
			assert.strictEqual(validateProjectCommandField('env', ['FOO=bar']).code, 'env-not-object');
		});
		test('lowercase key → warning', () => {
			assert.strictEqual(validateProjectCommandField('env', { lower: 'bar' }).severity, 'warning');
		});
		test('non-string value → error', () => {
			assert.strictEqual(validateProjectCommandField('env', { FOO: 42 }).code, 'env-value-not-string');
		});
	});

	suite('terminal', () => {
		test('canonical → ok', () => {
			assert.strictEqual(validateProjectCommandField('terminal', 'integrated').severity, 'ok');
			assert.strictEqual(validateProjectCommandField('terminal', 'external').severity, 'ok');
			assert.strictEqual(validateProjectCommandField('terminal', 'background').severity, 'ok');
		});
		test('unknown → error', () => {
			assert.strictEqual(validateProjectCommandField('terminal', 'inline').code, 'terminal-invalid');
		});
		test('omitted → ok', () => {
			assert.strictEqual(validateProjectCommandField('terminal', undefined).severity, 'ok');
		});
	});

	suite('booleans + numbers + workflowId', () => {
		test('confirm bool → ok', () => {
			assert.strictEqual(validateProjectCommandField('confirm', true).severity, 'ok');
			assert.strictEqual(validateProjectCommandField('confirm', false).severity, 'ok');
		});
		test('confirm string → error', () => {
			assert.strictEqual(validateProjectCommandField('confirm', 'true').severity, 'error');
		});
		test('order finite number → ok', () => {
			assert.strictEqual(validateProjectCommandField('order', 5).severity, 'ok');
		});
		test('order NaN → error', () => {
			assert.strictEqual(validateProjectCommandField('order', NaN).severity, 'error');
		});
		test('workflowId pattern enforced', () => {
			assert.strictEqual(validateProjectCommandField('workflowId', 'release-flow').severity, 'ok');
			assert.strictEqual(validateProjectCommandField('workflowId', 'BAD ID').severity, 'error');
		});
	});

	suite('whole-form validation', () => {
		test('valid form → all ok + savable', () => {
			const form = { id: 'a', name: 'A', command: 'echo' };
			const r = validateProjectCommandForm(form);
			assert.strictEqual(r.id.severity, 'ok');
			assert.strictEqual(r.name.severity, 'ok');
			assert.strictEqual(r.command.severity, 'ok');
			assert.strictEqual(isProjectCommandFormSavable(r), true);
		});

		test('missing id → not savable', () => {
			const form = { name: 'A', command: 'echo' };
			const r = validateProjectCommandForm(form);
			assert.strictEqual(isProjectCommandFormSavable(r), false);
		});

		test('any error → not savable', () => {
			const form = { id: 'a', name: 'A', command: 'echo', terminal: 'inline' };
			const r = validateProjectCommandForm(form);
			assert.strictEqual(isProjectCommandFormSavable(r), false);
		});

		test('warning-only → savable', () => {
			const form = { id: 'a', name: 'A', command: 'echo', icon: '$(play)' }; // $() warns
			const r = validateProjectCommandForm(form);
			assert.strictEqual(isProjectCommandFormSavable(r), true);
		});
	});

	suite('buildProjectCommandFromForm', () => {
		test('round-trip through decoder', () => {
			const form = { id: 'a', name: 'A', command: 'echo', args: ['hello'], pinned: true, order: 0 };
			const cmd = buildProjectCommandFromForm(form);
			const r = decodeProjectCommandsFile({ vibeVersion: '1.0.0', commands: [cmd] });
			assert.strictEqual(r.ok, true);
		});

		test('omits absent optional fields', () => {
			const cmd = buildProjectCommandFromForm({ id: 'a', name: 'A', command: 'echo' });
			assert.ok(!Object.hasOwn(cmd, 'description'));
			assert.ok(!Object.hasOwn(cmd, 'args'));
			assert.ok(!Object.hasOwn(cmd, 'env'));
		});

		test('clones array/object — non-mutating', () => {
			const args = ['a', 'b'];
			const env = { FOO: 'bar' };
			const cmd = buildProjectCommandFromForm({ id: 'a', name: 'A', command: 'echo', args, env });
			(cmd as { args?: string[] }).args!.push('mutated');
			assert.strictEqual(args.length, 2);
		});
	});
});
