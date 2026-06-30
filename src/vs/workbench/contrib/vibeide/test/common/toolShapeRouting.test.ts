/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { detectToolByParamShape } from '../../common/prompt/toolAliases.js';

suite('detectToolByParamShape — shape→tool routing (model-stalls #010)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

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

	// roadmap 3226 / #014: {pattern[, search_in_folder, page_number]} under a non-pattern tool
	// → glob vs grep by pattern syntax.
	suite('{pattern} → glob / grep (3226)', () => {
		test('path-glob markers → glob (the #014 case)', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: '**/nginx.conf' }, 'read_file'), 'glob');
			assert.strictEqual(detectToolByParamShape({ pattern: '*.ts', search_in_folder: 'src' }, 'read_file'), 'glob');
			assert.strictEqual(detectToolByParamShape({ pattern: 'src/**/*.tsx' }, 'read_file'), 'glob');
			assert.strictEqual(detectToolByParamShape({ pattern: '**/{Dockerfile,docker-compose.yml}' }, 'read_file'), 'glob');
		});

		test('regex-only metachars → grep', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: '^foo$' }, 'read_file'), 'grep');
			assert.strictEqual(detectToolByParamShape({ pattern: 'foo.*bar' }, 'read_file'), 'grep');
			assert.strictEqual(detectToolByParamShape({ pattern: 'foo\\d+' }, 'read_file'), 'grep');
			assert.strictEqual(detectToolByParamShape({ pattern: 'TODO|FIXME' }, 'read_file'), 'grep');
		});

		test('plain literal → grep (conservative default)', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: 'TODO' }, 'read_file'), 'grep');
			assert.strictEqual(detectToolByParamShape({ pattern: 'nginx.conf' }, 'read_file'), 'grep');
		});

		test('never re-routes FROM glob/grep (they own pattern)', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: '**/*.ts' }, 'glob'), undefined);
			assert.strictEqual(detectToolByParamShape({ pattern: 'foo.*' }, 'grep'), undefined);
		});

		test('rich grep shape (extra keys) is NOT hijacked', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: 'foo', output_mode: 'content', file_type: 'ts' }, 'read_file'), undefined);
		});

		test('{pattern} with uri present is left alone (not a search shape)', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: '*.ts', uri: 'a.ts' }, 'read_file'), undefined);
		});

		test('empty / non-string pattern is not a match', () => {
			assert.strictEqual(detectToolByParamShape({ pattern: '' }, 'read_file'), undefined);
			assert.strictEqual(detectToolByParamShape({ pattern: 42 }, 'read_file'), undefined);
		});
	});

	suite('ambiguous / unhandled shapes pass through (undefined)', () => {
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

		// roadmap 3195: {uri} with a trailing path-separator → ls_dir (directory), from a
		// non-uri tool. Trailing slash is the ONLY directory signal (no "extensionless = dir").
		suite('{uri} directory → ls_dir', () => {
			test('trailing / from a non-uri tool → ls_dir', () => {
				assert.strictEqual(detectToolByParamShape({ uri: 'src/components/' }, 'glob'), 'ls_dir');
				assert.strictEqual(detectToolByParamShape({ uri: 'd:\\proj\\src\\' }, 'grep'), 'ls_dir');
				assert.strictEqual(detectToolByParamShape({ uri: 'src/', page_number: '2' }, 'search_for_files'), 'ls_dir');
			});

			test('no trailing slash → read_file, not ls_dir', () => {
				assert.strictEqual(detectToolByParamShape({ uri: 'src/main.ts' }, 'glob'), 'read_file');
				// extensionless file path (no trailing slash) must NOT become ls_dir
				assert.strictEqual(detectToolByParamShape({ uri: 'LICENSE' }, 'grep'), 'read_file');
				assert.strictEqual(detectToolByParamShape({ uri: 'src/Makefile' }, 'grep'), 'read_file');
			});

			test('trailing slash + read-pagination → read_file (ls_dir branch declines, read_file branch keeps its pre-existing behavior)', () => {
				// start_line means a read intent; the ls_dir branch requires keys ⊆ {uri,page_number}
				// so it declines, and the (unchanged) read_file branch catches {uri,start_line}.
				assert.strictEqual(detectToolByParamShape({ uri: 'src/', start_line: '1' }, 'grep'), 'read_file');
			});

			test('legitimate ls_dir / uri-owning tools are NOT hijacked', () => {
				// ls_dir owns uri (not in NON_URI_TOOLS) → passes through untouched
				assert.strictEqual(detectToolByParamShape({ uri: 'src/' }, 'ls_dir'), undefined);
				assert.strictEqual(detectToolByParamShape({ uri: 'src/' }, 'get_dir_tree'), undefined);
			});
		});

		// roadmap 1712 (safe subset): nl_input is owned solely by run_nl_command → unambiguous.
		suite('{nl_input} → run_nl_command', () => {
			test('{nl_input} under a wrong tool → run_nl_command', () => {
				assert.strictEqual(detectToolByParamShape({ nl_input: 'list git branches' }, 'run_command'), 'run_nl_command');
				assert.strictEqual(detectToolByParamShape({ nl_input: 'run tests', cwd: 'd:/p' }, 'read_file'), 'run_nl_command');
			});
			test('already run_nl_command → undefined (no reroute)', () => {
				assert.strictEqual(detectToolByParamShape({ nl_input: 'x' }, 'run_nl_command'), undefined);
			});
			test('empty / non-string nl_input is not a match', () => {
				assert.strictEqual(detectToolByParamShape({ nl_input: '' }, 'run_command'), undefined);
				assert.strictEqual(detectToolByParamShape({ nl_input: 42 }, 'run_command'), undefined);
			});
			test('nl_input mixed with a foreign key → not a match', () => {
				assert.strictEqual(detectToolByParamShape({ nl_input: 'x', command: 'y' }, 'read_file'), undefined);
			});
		});
	});
});
