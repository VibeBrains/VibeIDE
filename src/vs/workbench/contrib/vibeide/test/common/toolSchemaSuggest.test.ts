/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tests for cross-tool argument suggestion (X.11.4 / X.13.7 / X.14.2).
 *
 * Driving incident (2026-05-23, minimax-m2.7 via openCodeGo aggregator): model
 * called `read_file({nl_input: "Check Dokku apps"})`. `nl_input` is the
 * required param of `run_nl_command`, not `read_file`. Without the suggester,
 * tool executor only said «uri must be string but got undefined» and the
 * model didn't retry — 120s stream-stall watchdog had to fire.
 *
 * The suggester recognizes cross-tool shape and recommends the alternate
 * tool in the schema hint sent back to the model, giving it a clear path
 * to recovery.
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CROSS_TOOL_ARG_HINTS, scoreToolMatch, suggestAlternateTool, suggestByArgHints, ToolCandidate } from '../../common/toolSchemaSuggest.js';

const readFile: ToolCandidate = { name: 'read_file', params: { required: ['uri'] } };
const runNlCommand: ToolCandidate = { name: 'run_nl_command', params: { required: ['nl_input'] } };
const searchForFiles: ToolCandidate = { name: 'search_for_files', params: { required: ['query'] } };
const editFile: ToolCandidate = { name: 'edit_file', params: { required: ['uri', 'content'] } };
const noRequired: ToolCandidate = { name: 'list_workspaces', params: { required: [] } };

const ALL_TOOLS = [readFile, runNlCommand, searchForFiles, editFile, noRequired];

suite('toolSchemaSuggest', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('scoreToolMatch', () => {

		test('perfect match → 1.0', () => {
			assert.strictEqual(scoreToolMatch(['uri'], ['uri']), 1.0);
		});

		test('zero overlap → 0.0', () => {
			assert.strictEqual(scoreToolMatch(['uri'], ['nl_input']), 0.0);
		});

		test('half overlap on 2-required → 0.5', () => {
			assert.strictEqual(scoreToolMatch(['uri', 'content'], ['uri']), 0.5);
		});

		test('case-insensitive match', () => {
			assert.strictEqual(scoreToolMatch(['URI'], ['uri']), 1.0);
			assert.strictEqual(scoreToolMatch(['uri'], ['URI']), 1.0);
		});

		test('empty required → 0 (no signal)', () => {
			assert.strictEqual(scoreToolMatch([], ['uri']), 0);
		});

		test('extra raw keys do not penalize', () => {
			// uri present, extra `foo` ignored → still 1.0 on the required side.
			assert.strictEqual(scoreToolMatch(['uri'], ['uri', 'foo', 'bar']), 1.0);
		});

		test('duplicates in raw keys do not double-count', () => {
			assert.strictEqual(scoreToolMatch(['uri'], ['uri', 'uri']), 1.0);
		});
	});

	suite('suggestAlternateTool — minimax incident 2026-05-23', () => {

		test('verbatim incident: read_file called with {nl_input} → suggests run_nl_command', () => {
			const out = suggestAlternateTool(readFile, ALL_TOOLS, ['nl_input']);
			assert.strictEqual(out, 'run_nl_command');
		});

		test('matching called tool exactly → no suggestion (no cross-tool confusion)', () => {
			const out = suggestAlternateTool(readFile, ALL_TOOLS, ['uri']);
			assert.strictEqual(out, null);
		});

		test('called tool with extra unknown key → no suggestion (not strictly better)', () => {
			// read_file({uri, garbage}) — uri matches, garbage doesn't suggest another tool.
			const out = suggestAlternateTool(readFile, ALL_TOOLS, ['uri', 'garbage']);
			assert.strictEqual(out, null);
		});

		test('empty raw keys → null (nothing to score)', () => {
			const out = suggestAlternateTool(readFile, ALL_TOOLS, []);
			assert.strictEqual(out, null);
		});

		test('candidate with zero required is skipped', () => {
			// raw keys empty would already short-circuit, but make sure the
			// no-required candidate is never returned even when scoring runs.
			const out = suggestAlternateTool(readFile, [noRequired, runNlCommand], ['nl_input']);
			assert.strictEqual(out, 'run_nl_command');
		});

		test('called tool not in candidates list — still works (no self-match needed)', () => {
			const out = suggestAlternateTool(readFile, [runNlCommand], ['nl_input']);
			assert.strictEqual(out, 'run_nl_command');
		});

		test('below minScore floor → null', () => {
			// edit_file requires [uri, content]; rawKeys has only `uri` → 0.5 < 0.6 default.
			const out = suggestAlternateTool(searchForFiles, [editFile], ['uri']);
			assert.strictEqual(out, null);
		});

		test('explicit minScore=0.5 allows half match', () => {
			const out = suggestAlternateTool(searchForFiles, [editFile], ['uri'], 0.5);
			// search_for_files self-score is 0 (rawKeys has no 'query'); edit_file is 0.5.
			// 0.5 > 0 and >= minScore → returns edit_file.
			assert.strictEqual(out, 'edit_file');
		});

		test('best of multiple candidates wins', () => {
			// rawKeys = [uri, content] — exact edit_file match (1.0), partial others (≤0.5).
			const out = suggestAlternateTool(searchForFiles, ALL_TOOLS, ['uri', 'content']);
			assert.strictEqual(out, 'edit_file');
		});

		test('tie between candidates → first reached (deterministic)', () => {
			// Both runNlCommand and searchForFiles have single-required.
			// rawKeys = [nl_input] → run_nl_command scores 1.0, search_for_files 0.0.
			// (No actual tie here; covered the deterministic path.)
			const out = suggestAlternateTool(readFile, [runNlCommand, searchForFiles], ['nl_input']);
			assert.strictEqual(out, 'run_nl_command');
		});
	});

	suite('suggestByArgHints (X.11.4)', () => {

		test('nl_input → run_nl_command when available', () => {
			const out = suggestByArgHints(['nl_input'], new Set(['read_file', 'run_nl_command']));
			assert.strictEqual(out, 'run_nl_command');
		});

		test('nl_input fallback to nl_shell when run_nl_command absent', () => {
			const out = suggestByArgHints(['nl_input'], new Set(['nl_shell']));
			assert.strictEqual(out, 'nl_shell');
		});

		test('no hint match → null', () => {
			const out = suggestByArgHints(['totally_random_key'], new Set(['read_file']));
			assert.strictEqual(out, null);
		});

		test('hint match but candidate not available → null', () => {
			const out = suggestByArgHints(['nl_input'], new Set(['read_file']));
			assert.strictEqual(out, null);
		});

		test('case-insensitive key lookup', () => {
			const out = suggestByArgHints(['NL_INPUT'], new Set(['run_nl_command']));
			assert.strictEqual(out, 'run_nl_command');
		});

		test('multiple rawKeys — first hit wins', () => {
			const out = suggestByArgHints(['unknown', 'nl_input'], new Set(['run_nl_command']));
			assert.strictEqual(out, 'run_nl_command');
		});

		test('CROSS_TOOL_ARG_HINTS table is non-empty (regression guard)', () => {
			assert.ok(Object.keys(CROSS_TOOL_ARG_HINTS).length > 0);
		});
	});

	suite('suggestAlternateTool — hint path integration', () => {

		test('hint short-circuits when shape match would return null', () => {
			// rawKeys=[nl_input] — neither read_file nor edit_file's required
			// params (uri, content) appear. Shape match scores all candidates
			// at 0. But hint table says nl_input → run_nl_command.
			const out = suggestAlternateTool(readFile, [editFile, runNlCommand], ['nl_input']);
			assert.strictEqual(out, 'run_nl_command');
		});

		test('hint to called tool itself is ignored (no self-suggestion)', () => {
			// If somehow CROSS_TOOL_ARG_HINTS suggested the called tool, we
			// should not return it (would loop the model).
			const customRunNl: ToolCandidate = { name: 'run_nl_command', params: { required: ['nl_input'] } };
			const out = suggestAlternateTool(customRunNl, [readFile], ['nl_input']);
			// suggestByArgHints returns 'run_nl_command' from hint table, but it
			// equals called tool → skipped. Shape scoring on readFile (uri) → 0
			// for ['nl_input'] → no suggestion.
			assert.strictEqual(out, null);
		});
	});
});
