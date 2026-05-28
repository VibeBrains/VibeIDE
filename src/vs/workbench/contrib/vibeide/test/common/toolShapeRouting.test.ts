/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { detectToolByParamShape } from '../../common/prompt/toolAliases.js';

suite('detectToolByParamShape — shape→tool routing (model-stalls #010)', () => {

	suite('re-routes a clear misname (the observed #010 cases)', () => {
		test('run_command <- {uri} -> read_file', () => {
			assert.strictEqual(detectToolByParamShape({ uri: 'd:\\proj\\Dockerfile' }, 'run_command'), 'read_file');
		});

		test('read_file <- {query, search_in_folder} -> search_for_files', () => {
			assert.strictEqual(detectToolByParamShape({ query: '.dockerignore', search_in_folder: 'd:\\proj' }, 'read_file'), 'search_for_files');
		});

		test('read_file <- {command} -> run_command', () => {
			assert.strictEqual(detectToolByParamShape({ command: 'npm test' }, 'read_file'), 'run_command');
		});

		test('grep <- {command, cwd, timeout_ms} -> run_command', () => {
			assert.strictEqual(detectToolByParamShape({ command: 'ls', cwd: 'd:\\p', timeout_ms: 5000 }, 'grep'), 'run_command');
		});

		test('read_file <- {command, run_in_background} -> run_command', () => {
			assert.strictEqual(detectToolByParamShape({ command: 'npm run dev', run_in_background: true }, 'read_file'), 'run_command');
		});

		test('run_command <- {uri, start_line, end_line} -> read_file (paginated read shape)', () => {
			assert.strictEqual(detectToolByParamShape({ uri: 'src/a.ts', start_line: 1, end_line: 50 }, 'run_command'), 'read_file');
		});
	});

	suite('NEVER hijacks a legitimate call (the regression guarded against)', () => {
		test('search_pathnames_only <- {query, search_in_folder} -> undefined', () => {
			// query is owned by several search tools; this is a valid call, not a misname.
			assert.strictEqual(detectToolByParamShape({ query: 'foo', search_in_folder: 'src' }, 'search_pathnames_only'), undefined);
		});

		test('search_symbols <- {query} -> undefined', () => {
			assert.strictEqual(detectToolByParamShape({ query: 'MyClass' }, 'search_symbols'), undefined);
		});

		test('search_for_files <- {query, search_in_folder} -> undefined (already correct)', () => {
			assert.strictEqual(detectToolByParamShape({ query: 'foo', search_in_folder: 'src' }, 'search_for_files'), undefined);
		});

		test('run_persistent_command <- {command} -> undefined (owns command)', () => {
			assert.strictEqual(detectToolByParamShape({ command: 'tail -f log' }, 'run_persistent_command'), undefined);
		});

		test('run_command <- {command} -> undefined (already correct)', () => {
			assert.strictEqual(detectToolByParamShape({ command: 'npm test' }, 'run_command'), undefined);
		});

		test('read_file <- {uri, start_line} -> undefined (already correct, uri-owning)', () => {
			assert.strictEqual(detectToolByParamShape({ uri: 'a.ts', start_line: 1 }, 'read_file'), undefined);
		});

		test('ls_dir <- {uri} -> undefined (uri-owning, bare uri is ambiguous)', () => {
			assert.strictEqual(detectToolByParamShape({ uri: 'src' }, 'ls_dir'), undefined);
		});

		test('get_dir_tree <- {uri} -> undefined (uri-owning)', () => {
			assert.strictEqual(detectToolByParamShape({ uri: 'src' }, 'get_dir_tree'), undefined);
		});

		test('search_in_file <- {uri, query} -> undefined (query WITH uri, not file-search)', () => {
			assert.strictEqual(detectToolByParamShape({ uri: 'a.ts', query: 'foo' }, 'search_in_file'), undefined);
		});
	});

	suite('ambiguous / unhandled shapes pass through (undefined)', () => {
		test('{pattern, search_in_folder} -> undefined (grep vs glob ambiguous, not handled)', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: '*.ts', search_in_folder: 'src' }, 'read_file'), undefined);
		});

		test('{query, uri} -> undefined ({query} but uri present blocks search routing)', () => {
			assert.strictEqual(detectToolByParamShape({ query: 'foo', uri: 'a.ts' }, 'read_file'), undefined);
		});

		test('extra unknown key blocks run_command shape', () => {
			assert.strictEqual(detectToolByParamShape({ command: 'ls', surprise: 1 }, 'read_file'), undefined);
		});

		test('empty params -> undefined', () => {
			assert.strictEqual(detectToolByParamShape({}, 'read_file'), undefined);
		});

		test('non-object params -> undefined', () => {
			assert.strictEqual(detectToolByParamShape(undefined, 'read_file'), undefined);
		});

		test('empty-string required field is not a match', () => {
			assert.strictEqual(detectToolByParamShape({ command: '' }, 'read_file'), undefined);
			assert.strictEqual(detectToolByParamShape({ uri: '' }, 'run_command'), undefined);
			assert.strictEqual(detectToolByParamShape({ query: '' }, 'read_file'), undefined);
		});

		test('non-string required field is not a match', () => {
			assert.strictEqual(detectToolByParamShape({ command: 123 }, 'read_file'), undefined);
			assert.strictEqual(detectToolByParamShape({ uri: 42 }, 'run_command'), undefined);
		});
	});
});
