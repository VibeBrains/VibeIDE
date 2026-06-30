/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tests for `normalizeAlternativeToolSyntax` + `stripUnclaimedToolTags` +
 * `SELF_CLOSING_PARTIAL_RE` (v0.13.10 XML pipeline overhaul).
 *
 * Each test pinpoints one of the formats the LLM might emit. Coverage matrix:
 *
 *   | Format                                          | Test name              |
 *   |-------------------------------------------------|------------------------|
 *   | Canonical block `<read_file><path>v</path>...`  | preservesCanonical     |
 *   | Anthropic `<invoke name="X"><parameter>…`       | invokeForm             |
 *   | Anthropic + extra parameter attribute           | invokeFormExtraAttr    |
 *   | Self-closing `<read_file path="v" />`           | selfClosing            |
 *   | Self-closing with alias `<read path="v" />`     | selfClosingAlias       |
 *   | DSML fullwidth-pipe wrapper                     | dsmlFullwidth          |
 *   | DSML + extra param attr (real-world example)    | dsmlFromUserScreenshot |
 *   | Markdown `<br />` / `<img />` (non-tool tags)   | ignoresHtmlSelfClosing |
 *   | Plain text without tags                         | fastPathPassthrough    |
 *   | Mixed: text + tool call (streaming-ish)         | textBeforeAndAfter     |
 *   | Streaming partial detection                     | partialDetect          |
 *   | Safety net for paired form not parsed           | stripsLeakedPaired     |
 *   | Safety net for self-closing form not parsed     | stripsLeakedSelfClose  |
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	getNormalizeCounters,
	normalizeAlternativeToolSyntax,
	resetNormalizeCounters,
	resolveInvokeToolName,
	resolveToolNameLoose,
	SELF_CLOSING_PARTIAL_RE,
	stripUnclaimedToolTags,
} from '../../common/xmlToolNormalize.js';

suite('XML tool normalization (v0.13.10)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('normalizeAlternativeToolSyntax — preservation', () => {

		test('canonical block form is unchanged', () => {
			const input = '<read_file><path>/foo/bar.txt</path></read_file>';
			assert.strictEqual(normalizeAlternativeToolSyntax(input), input);
		});

		test('plain text without XML tags is fast-path passthrough (no allocations)', () => {
			const input = 'Hello, this is just plain text. No tools to call.';
			assert.strictEqual(normalizeAlternativeToolSyntax(input), input);
		});

		test('markdown HTML self-closing tags are NOT touched', () => {
			// Models do emit `<br />` and `<img />` in regular markdown answers;
			// the normalizer must leave them alone (not in tool-name universe).
			const input = 'Line one.<br />Line two.<br />\n<img src="diagram.png" alt="x" />\nEnd.';
			assert.strictEqual(normalizeAlternativeToolSyntax(input), input);
		});

		test('text containing < character but no tool tag passes through', () => {
			const input = 'The value is 5 < 10 and 10 > 5.';
			assert.strictEqual(normalizeAlternativeToolSyntax(input), input);
		});

		test('empty / nullish input does not throw (defensive guard)', () => {
			assert.strictEqual(normalizeAlternativeToolSyntax(''), '');
			// Type-system says string, but runtime may pass undefined/null from
			// optional-chained sources. Cast for the test only.
			assert.strictEqual(normalizeAlternativeToolSyntax(undefined as unknown as string), undefined as unknown as string);
			assert.strictEqual(normalizeAlternativeToolSyntax(null as unknown as string), null as unknown as string);
		});
	});

	suite('normalizeAlternativeToolSyntax — Anthropic invoke form', () => {

		test('basic <invoke> with <parameter> → canonical', () => {
			const input = '<invoke name="read_file"><parameter name="path">/foo.ts</parameter></invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.match(out, /<uri>\/foo\.ts<\/uri>/); // read_file param `path`→`uri` (toolAliases): canonical param is `uri`
			assert.match(out, /<\/read_file>/);
		});

		test('<invoke> with extra attribute on <parameter> still normalizes', () => {
			// Real-world case: `<parameter name="filePath" string="true">…</parameter>`.
			// Pre-W.22 the trailing `string="true"` made the regex skip the match.
			const input = '<invoke name="read_file"><parameter name="filePath" string="true">/foo.ts</parameter></invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			// Param name "filePath" should resolve to canonical alias (case-insensitive lower).
			assert.ok(out.includes('/foo.ts'), `expected /foo.ts in output, got: ${out}`);
		});

		test('alias tool name in <invoke> resolves to canonical', () => {
			// "bash" → "run_command" via TOOL_NAME_ALIASES.
			const input = '<invoke name="bash"><parameter name="command">ls</parameter></invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<run_command>/);
			assert.match(out, /<command>ls<\/command>/);
		});

		test('vendor wrapper stripped before invoke matched', () => {
			const input = '<function_calls><invoke name="read_file"><parameter name="path">x</parameter></invoke></function_calls>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.doesNotMatch(out, /<function_calls>/);
		});
	});

	suite('normalizeAlternativeToolSyntax — self-closing (v0.13.10)', () => {

		test('basic self-closing tag with one attribute', () => {
			const input = '<read_file path="d:\\foo.md" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.match(out, /<uri>d:\\foo\.md<\/uri>/); // read_file param `path`→`uri` (toolAliases)
			assert.match(out, /<\/read_file>/);
		});

		test('self-closing with multiple attributes', () => {
			const input = '<read_file path="x.ts" offset="1" limit="30" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<uri>x\.ts<\/uri>/); // read_file param `path`→`uri` (toolAliases)
			assert.match(out, /<start_line>1<\/start_line>/); // `offset`→`start_line` (toolAliases)
			assert.match(out, /<line_limit>30<\/line_limit>/); // `limit`→`line_limit` (toolAliases)
		});

		test('multiple self-closing tags in sequence (chain)', () => {
			const input = '<read_file path="a.md" /> <read_file path="b.md" /> <read_file path="c.md" />';
			const out = normalizeAlternativeToolSyntax(input);
			const reads = out.match(/<read_file>/g);
			assert.ok(reads && reads.length === 3, `expected 3 <read_file> opens, got: ${out}`);
		});

		test('self-closing with alias <read /> → canonical <read_file>', () => {
			const input = '<read path="/foo.ts" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
		});

		test('case-insensitive: <Read_File /> matches', () => {
			const input = '<Read_File path="x" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/i);
		});

		test('self-closing with no attributes is left alone (no params)', () => {
			// Empty self-closing makes no sense for tools — leave it for safety net.
			const input = 'Some text <read_file/> more text';
			const out = normalizeAlternativeToolSyntax(input);
			// `<read_file/>` doesn't match `\s+` requirement → unchanged here; safety
			// net would strip on user-visible side via stripUnclaimedToolTags.
			assert.ok(out.includes('<read_file/>') || out.includes('<read_file>'), `unexpected: ${out}`);
		});
	});

	suite('normalizeAlternativeToolSyntax — DSML fullwidth-pipe wrapper (v0.13.10)', () => {

		test('basic DSML invoke', () => {
			const input = '<｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="filePath">/foo</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.match(out, /\/foo/);
			assert.doesNotMatch(out, /｜｜/);
		});

		test('user screenshot example: full DSML tool_calls block with two invokes', () => {
			// Real model output from 2026-05-23 incident. Two tool calls inside one
			// <tool_calls> wrap, each with multiple <parameter string="…">.
			const input = `Отлично, давай начнём.

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="read_file">
<｜｜DSML｜｜parameter name="filePath" string="true">d:\\Projects\\VibeCode\\BuzzBang\\admin\\docs\\deploy.md</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
<｜｜DSML｜｜invoke name="list_files">
<｜｜DSML｜｜parameter name="target_directory" string="true">d:\\Projects\\VibeCode\\BuzzBang</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="depth" string="false">1</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="offset" string="false">0</｜｜DSML｜｜parameter>
<｜｜DSML｜｜parameter name="limit" string="false">50</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.match(out, /<ls_dir>/); // `list_files`→`ls_dir` (toolAliases): list_files is not a canonical tool
			assert.doesNotMatch(out, /｜｜/, `DSML markers should be gone, got: ${out.slice(0, 200)}`);
			assert.doesNotMatch(out, /<tool_calls>/, `outer wrapper should be stripped, got: ${out.slice(0, 200)}`);
		});

		test('ASCII-pipe DSML variant is NOT fast-pathed (documented perf limitation)', () => {
			// `<|FOO|…>` uses ASCII `|`. The DSML strip regex CAN handle it, but the fast-path
			// sniff list intentionally omits ASCII `|`: it appears in nearly every markdown
			// table / code block, so sniffing it would force the full path on almost all
			// messages. The fullwidth `｜` (U+FF5C) IS sniffed. So this hypothetical ASCII
			// variant passes through unchanged — by design, not a regression.
			const input = '<|FOO|invoke name="read_file"><|FOO|parameter name="path">x</|FOO|parameter></|FOO|invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.strictEqual(out, input);
		});
	});

	suite('normalizeAlternativeToolSyntax — malformed close tags (v0.13.11)', () => {

		test('malformed `<tool_calls<invoke ...>` — no `>` on tool_calls open', () => {
			// Real-world from deepseek-v4-pro 2026-05-23: model emits `<tool_calls<invoke ...>`
			// (no `>` after tool_calls). Pre-v0.13.11 the STRIP_WRAPPERS_RE required
			// `\s*>` and skipped the orphan `<tool_calls` open → leaked into chat.
			const input = '<tool_calls<invoke name="write_file_text"><parameter name="contents">data</parameter></invoke></tool_calls>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.doesNotMatch(out, /<tool_calls/);
			assert.match(out, /<write_file_text>/);
			assert.match(out, /<contents>data<\/contents>/);
		});

		test('malformed `</invoke</tool_calls` — no `>` on either close', () => {
			// Most pathological observed case: BOTH invoke and tool_calls close miss `>`.
			const input = '<tool_calls<invoke name="read_file"><parameter name="path">/foo</parameter></invoke</tool_calls';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.doesNotMatch(out, /tool_calls/);
			assert.doesNotMatch(out, /<invoke/);
		});

		test('malformed `</parameter` (no `>`) followed by next `<parameter>`', () => {
			const input = '<invoke name="write_file_text"><parameter name="contents">data</parameter<parameter name="uri">/foo</parameter></invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<write_file_text>/);
			assert.match(out, /<contents>data<\/contents>/);
			assert.match(out, /\/foo/);
		});

		test('user 2026-05-23 ru.json screenshot — full malformed deepseek-v4-pro output', () => {
			// Verbatim shape from the user's chat: model wrote a large JSON file via
			// write_file_text, but the wrapper opens/closes missed all `>`. JSON body
			// is shortened here for test readability — the regex doesn't care about
			// content length.
			const input = '<tool_calls<invoke name="write_file_text"><parameter name="contents" string="true">{ "FIELD_REQUIRED": "Это поле обязательно" }</parameter><parameter name="uri" string="true">d:\\Projects\\BuzzBang\\ru.json</parameter> </invoke</tool_calls';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<write_file_text>/);
			assert.match(out, /ru\.json/);
			assert.match(out, /FIELD_REQUIRED/);
			assert.doesNotMatch(out, /<tool_calls/);
			assert.doesNotMatch(out, /<\/tool_calls/);
		});

		test('whitespace between `</invoke` and next tag is tolerated', () => {
			// Edge: model emits closing without `>` but with leading whitespace
			// before next tag: `</invoke   <other_tool>`. Lookahead should skip
			// whitespace and accept the `<` of the next tag as a valid boundary.
			const input = '<invoke name="read_file"><parameter name="path">x</parameter></invoke   <other>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.doesNotMatch(out, /<invoke/);
		});

		test('multiple malformed invokes in a row (chain)', () => {
			// Model emits two tool calls back-to-back, both with malformed closes.
			const input = '<invoke name="read_file"><parameter name="path">a</parameter></invoke<invoke name="read_file"><parameter name="path">b</parameter></invoke';
			const out = normalizeAlternativeToolSyntax(input);
			const reads = out.match(/<read_file>/g);
			assert.ok(reads && reads.length === 2, `expected 2 invoke matches, got: ${out}`);
		});
	});

	suite('idempotency', () => {

		test('normalize(normalize(x)) === normalize(x) — canonical', () => {
			const input = '<read_file><path>/foo</path></read_file>';
			const once = normalizeAlternativeToolSyntax(input);
			const twice = normalizeAlternativeToolSyntax(once);
			assert.strictEqual(once, twice);
		});

		test('normalize(normalize(x)) === normalize(x) — invoke form', () => {
			const input = '<invoke name="read_file"><parameter name="path">/foo</parameter></invoke>';
			const once = normalizeAlternativeToolSyntax(input);
			const twice = normalizeAlternativeToolSyntax(once);
			assert.strictEqual(once, twice);
		});

		test('normalize(normalize(x)) === normalize(x) — self-closing', () => {
			const input = '<read_file path="/foo" />';
			const once = normalizeAlternativeToolSyntax(input);
			const twice = normalizeAlternativeToolSyntax(once);
			assert.strictEqual(once, twice);
		});

		test('normalize(normalize(x)) === normalize(x) — DSML', () => {
			const input = '<｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="path">/foo</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>';
			const once = normalizeAlternativeToolSyntax(input);
			const twice = normalizeAlternativeToolSyntax(once);
			assert.strictEqual(once, twice);
		});

		test('normalize(normalize(x)) === normalize(x) — malformed close', () => {
			const input = '<tool_calls<invoke name="read_file"><parameter name="path">x</parameter></invoke</tool_calls';
			const once = normalizeAlternativeToolSyntax(input);
			const twice = normalizeAlternativeToolSyntax(once);
			assert.strictEqual(once, twice);
		});

		test('normalize(normalize(x)) === normalize(x) — self-closing invoke combo (X.13.5)', () => {
			const input = '<invoke name="read_file" path="/foo" />';
			const once = normalizeAlternativeToolSyntax(input);
			const twice = normalizeAlternativeToolSyntax(once);
			assert.strictEqual(once, twice);
		});
	});

	suite('self-closing invoke combo (X.13.5)', () => {

		test('basic <invoke name="X" attr="v" /> → canonical', () => {
			const input = '<invoke name="read_file" path="/foo.ts" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.match(out, /<uri>\/foo\.ts<\/uri>/); // read_file param `path`→`uri` (toolAliases): canonical param is `uri`
			assert.doesNotMatch(out, /<invoke/);
		});

		test('multiple attributes are unpacked as params', () => {
			const input = '<invoke name="write_file_text" uri="/x.json" contents="data" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<write_file_text>/);
			assert.match(out, /<uri>\/x\.json<\/uri>/);
			assert.match(out, /<contents>data<\/contents>/);
		});

		test('name attribute itself is excluded from params', () => {
			// The `name="X"` is the tool name marker, not a param. Must not
			// emit `<name>X</name>` inside the canonical body.
			const input = '<invoke name="read_file" path="/foo" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.doesNotMatch(out, /<name>/);
		});

		test('alias resolution in self-closing invoke', () => {
			// `<invoke name="read" ...>` → `<read_file>` via alias.
			const input = '<invoke name="read" path="/foo" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
		});
	});

	suite('proactive fixtures (X.5) — plausible-but-unobserved formats', () => {

		// These tests assert CURRENT behavior on hypothetical vendor formats.
		// When a real vendor format lands, copy verbatim model output as a
		// new fixture and either (a) update the assertion if the format is
		// now handled, or (b) leave as «leaks through, awaiting transform».
		//
		// See `docs/knowledge/architecture/xml-tool-format-matrix.md` for
		// the full vendor coverage matrix and status of each format.

		test('GLM-style raw tool_call markdown block (NOT YET COVERED)', () => {
			// Hypothetical: Z.AI/GLM models may emit tool calls inside fenced
			// markdown code blocks. Pre-coverage, this passes through unchanged.
			const input = '```tool_call\n{"name": "read_file", "arguments": {"path": "/foo"}}\n```';
			const out = normalizeAlternativeToolSyntax(input);
			// No transform → input survives. Safety net doesn't touch JSON.
			assert.strictEqual(out, input);
		});

		test('Mistral function-call XML in `function_calls/function` namespace', () => {
			// Hypothetical Mistral wire format. The namespaced suffix
			// `function_calls` is in VENDOR_WRAPPER_NAMES, so the OUTER wrapper
			// gets stripped; inner Anthropic-style invoke is handled by the
			// invoke regex.
			const input = '<function_calls><invoke name="read_file"><parameter name="path">/foo</parameter></invoke></function_calls>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.doesNotMatch(out, /<function_calls/);
		});

		test('Llama-style special-token format (NOT YET COVERED)', () => {
			// Hypothetical: Llama 3.x special tokens. Square brackets are not
			// in our matcher universe — passes through. When observed, add
			// transform `[TOOL_CALL]...[/TOOL_CALL]` → canonical.
			const input = '[TOOL_CALL]\nread_file path=/foo\n[/TOOL_CALL]';
			const out = normalizeAlternativeToolSyntax(input);
			assert.strictEqual(out, input);
		});

		test('Cohere multi-tool batch JSON-in-XML — inner array now converted (X.16)', () => {
			const input = '<tool_calls_batch>[{"name":"read_file","arguments":{"path":"/foo"}}]</tool_calls_batch>';
			const out = normalizeAlternativeToolSyntax(input);
			// X.16: the inner JSON tool array is now converted to a canonical block. The outer
			// `tool_calls_batch` wrapper is NOT in VENDOR_WRAPPER_NAMES, so it still survives.
			assert.match(out, /<read_file>/);
			assert.match(out, /tool_calls_batch/);
		});
	});

	suite('JSON-array tool form (X.16)', () => {

		test('OpenAI-style [{name, arguments}] → canonical block', () => {
			const input = '[{"name":"read_file","arguments":{"uri":"/foo.ts"}}]';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.ok(out.includes('/foo.ts'));
			assert.doesNotMatch(out, /\[\{/); // array span consumed
		});

		test('arguments as a JSON-encoded string (OpenAI wire form)', () => {
			const input = '[{"name":"read_file","arguments":"{\\"uri\\":\\"/foo.ts\\"}"}]';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.ok(out.includes('/foo.ts'));
		});

		test('{type:"tool", tool:<canonical>, args} shape, inline in prose', () => {
			const input = 'Sure:\n[{"type":"tool","tool":"read_file","args":{"uri":"/a.ts"}}]\nДальше.';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.ok(out.includes('/a.ts'));
			assert.ok(out.startsWith('Sure:'));
			assert.ok(out.trimEnd().endsWith('Дальше.'));
		});

		test('unresolvable tool name (nemotron fs/command) is left untouched — no mis-route', () => {
			const input = '[{"type":"tool","tool":"fs","command":"read","args":{"path":"/foo"}}]';
			const out = normalizeAlternativeToolSyntax(input);
			// `fs` is not a canonical tool; the command→tool map is unverified → conservative no-op.
			assert.strictEqual(out, input);
		});

		test('plain non-tool JSON array is left untouched', () => {
			const input = 'Users: [{"name":"Alice","age":30},{"name":"Bob","age":25}]';
			const out = normalizeAlternativeToolSyntax(input);
			assert.strictEqual(out, input);
		});

		test('idempotency — JSON-array conversion is stable', () => {
			const once = normalizeAlternativeToolSyntax('[{"name":"read_file","arguments":{"uri":"/foo.ts"}}]');
			const twice = normalizeAlternativeToolSyntax(once);
			assert.strictEqual(twice, once);
		});
	});

	suite('Unicode + escaped quotes (X.15.5 / X.15.6 / X.15.8)', () => {

		test('Cyrillic param name `путь` in self-closing is captured', () => {
			const input = '<read_file путь="/foo.ts" />';
			const out = normalizeAlternativeToolSyntax(input);
			// Unicode param name flows through resolveInvokeParamName; result
			// should be a valid block with the value preserved.
			assert.match(out, /<read_file>/);
			assert.match(out, /\/foo\.ts/);
		});

		test('Chinese param name `路径` in self-closing is captured', () => {
			const input = '<read_file 路径="/foo.ts" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.match(out, /\/foo\.ts/);
		});

		test('escaped quotes in attribute value preserved', () => {
			// `"value with \"escaped\" inside"` — without escaped-quote support
			// the regex used to truncate at the first `"`. Now full value passes.
			const input = '<read_file path="hello \\"world\\"" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			// The backslash-escape sequence survives intact in the value.
			assert.match(out, /hello \\"world\\"/);
		});

		test('DSML with non-ASCII identifier inside pipes is stripped', () => {
			// X.15.6 — pipe-wrapped non-ASCII id `<｜｜中文｜｜>` is now matched.
			const input = '<｜｜中文｜｜invoke name="read_file"><｜｜中文｜｜parameter name="path">/foo</｜｜中文｜｜parameter></｜｜中文｜｜invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
			assert.doesNotMatch(out, /中文/);
		});
	});

	suite('telemetry counters (X.4)', () => {

		test('full-path counter increments on transform', () => {
			resetNormalizeCounters();
			normalizeAlternativeToolSyntax('plain text no tags');
			assert.strictEqual(getNormalizeCounters().fullPath, 0, 'fast path should not increment');
			normalizeAlternativeToolSyntax('<read_file path="/foo" />');
			assert.strictEqual(getNormalizeCounters().fullPath, 1);
		});

		test('selfClosing counter increments when self-closing transform fires', () => {
			resetNormalizeCounters();
			normalizeAlternativeToolSyntax('<read_file path="/foo" />');
			assert.ok(getNormalizeCounters().selfClosing >= 1);
		});

		test('invoke counter increments when invoke transform fires', () => {
			resetNormalizeCounters();
			normalizeAlternativeToolSyntax('<invoke name="read_file"><parameter name="path">x</parameter></invoke>');
			assert.ok(getNormalizeCounters().invoke >= 1);
		});

		test('dsml counter increments on fullwidth-pipe stripping', () => {
			resetNormalizeCounters();
			normalizeAlternativeToolSyntax('<｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="path">/foo</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>');
			assert.ok(getNormalizeCounters().dsml >= 1);
		});

		test('safetyNet counter increments on stripUnclaimedToolTags', () => {
			resetNormalizeCounters();
			stripUnclaimedToolTags('Leaked: <read_file><path>x</path></read_file>');
			assert.ok(getNormalizeCounters().safetyNetPaired >= 1);
		});

		test('reset zeros all counters', () => {
			normalizeAlternativeToolSyntax('<read_file path="/foo" />');
			resetNormalizeCounters();
			for (const [key, value] of Object.entries(getNormalizeCounters())) {
				assert.strictEqual(value, 0, `${key} should be 0 after reset`);
			}
		});
	});

	suite('stripUnclaimedToolTags — safety net', () => {

		test('paired form not claimed by parser gets placeholder', () => {
			const input = 'Here is something <read_file><path>foo</path></read_file> done.';
			const out = stripUnclaimedToolTags(input);
			assert.doesNotMatch(out, /<read_file>/);
			// Structural check (placeholder shape `\n*[localized text]*\n`) — robust
			// against future translations. Don't assert specific language.
			assert.match(out, /\*\[.+\]\*/);
		});

		test('self-closing form not claimed by parser gets placeholder (v0.13.10)', () => {
			const input = 'Here is <read_file path="x" /> done.';
			const out = stripUnclaimedToolTags(input);
			assert.doesNotMatch(out, /<read_file[^>]*\/>/);
			// Structural check (placeholder shape `\n*[localized text]*\n`) — robust
			// against future translations. Don't assert specific language.
			assert.match(out, /\*\[.+\]\*/);
		});

		test('canonical block AND self-closing in same text — both stripped', () => {
			const input = '<read_file><path>a</path></read_file> middle <read_file path="b" /> end';
			const out = stripUnclaimedToolTags(input);
			assert.doesNotMatch(out, /<read_file>/);
			assert.doesNotMatch(out, /<read_file[^>]*\/>/);
		});

		test('alias <read>...</read> is NOT stripped (common English word)', () => {
			// Per design: only canonical builtinToolNames are stripped; aliases like
			// "read" stay as-is (they appear in normal prose).
			const input = 'Please <read>this file</read>.';
			const out = stripUnclaimedToolTags(input);
			assert.strictEqual(out, input);
		});

		test('empty / no-tag input returns input unchanged', () => {
			assert.strictEqual(stripUnclaimedToolTags(''), '');
			assert.strictEqual(stripUnclaimedToolTags('Just text.'), 'Just text.');
		});

		test('truncated vendor <invoke>/<tool_calls> leak gets scrubbed (model-stalls #008, deepseek-v4-pro)', () => {
			// Verbatim shape observed leaking into chat: <tool_calls> wrapper truncated to
			// <tool_c, invoke close truncated to </inv. normalizeAlternativeToolSyntax can't
			// convert it (its invoke regex needs </invoke), and the canonical-name passes
			// don't match the <invoke> wrapper — so pre-fix it leaked raw.
			const input = 'before <tool_c <invoke name="search_content"><parameter name="pattern" string="true">allowLoginAs</parameter><parameter name="uri" string="true">d:\\Projects\\X\\config.ts</parameter> </inv </tool_c after';
			const out = stripUnclaimedToolTags(input);
			assert.doesNotMatch(out, /<invoke/i);
			assert.doesNotMatch(out, /<\/?tool_c/i);
			assert.doesNotMatch(out, /<parameter/i);
			assert.doesNotMatch(out, /<\/inv/i);
			// Surrounding prose preserved.
			assert.match(out, /^before /);
			assert.match(out, / after$/);
		});

		test('well-formed Anthropic <invoke> leak gets scrubbed too', () => {
			const input = 'x <invoke name="read_file"><parameter name="path">a.ts</parameter></invoke> y';
			const out = stripUnclaimedToolTags(input);
			assert.doesNotMatch(out, /<invoke/i);
			assert.doesNotMatch(out, /<parameter/i);
		});

		test('prose with bare angle brackets but no vendor token is NOT mangled', () => {
			// No vendor OPEN tag present → vendor scrub must not fire.
			const input = 'Compare a < b and c > d; this is fine.';
			assert.strictEqual(stripUnclaimedToolTags(input), input);
		});
	});

	suite('SELF_CLOSING_PARTIAL_RE — streaming detection', () => {

		test('matches <read_file path="d:\\... at end of buffer (no /> yet)', () => {
			const buffer = 'Some prelude text <read_file path="d:\\Projects\\foo';
			assert.match(buffer, SELF_CLOSING_PARTIAL_RE);
		});

		test('does NOT match completed <read_file> canonical open', () => {
			const buffer = 'Some text <read_file>';
			assert.doesNotMatch(buffer, SELF_CLOSING_PARTIAL_RE);
		});

		test('does NOT match plain text with no partial tool tag', () => {
			const buffer = 'Some explanation of what to do next.';
			assert.doesNotMatch(buffer, SELF_CLOSING_PARTIAL_RE);
		});

		test('does NOT match <br with attrs ending — br not in tool universe', () => {
			const buffer = 'Some text <br class="separator';
			assert.doesNotMatch(buffer, SELF_CLOSING_PARTIAL_RE);
		});

		test('matches alias <read attr="...', () => {
			const buffer = '<read filePath="/foo';
			assert.match(buffer, SELF_CLOSING_PARTIAL_RE);
		});
	});

	suite('Regression guards — minimax / direct-API paths must keep working', () => {

		test('canonical <read_file><path>X</path></read_file> still works through normalizer', () => {
			const input = 'I will read the file: <read_file><path>x.ts</path></read_file>';
			const out = normalizeAlternativeToolSyntax(input);
			// Round-trip preserved.
			assert.strictEqual(out, input);
		});

		test('text with `>` and `<` characters (HTML-looking but not tool) untouched', () => {
			const input = 'The condition is `x > 5 && y < 10`. That is the rule.';
			const out = normalizeAlternativeToolSyntax(input);
			assert.strictEqual(out, input);
		});

		test('text mentioning <read_file> as documentation does NOT alter (parser will, but normalizer is content-agnostic)', () => {
			// Edge: model explains how a tool works in prose. The normalizer doesn't
			// touch canonical form — it's the downstream parser's call to make. This
			// behaviour matches pre-v0.13.10.
			const input = 'The `<read_file>` tag is used to read files.';
			const out = normalizeAlternativeToolSyntax(input);
			assert.strictEqual(out, input);
		});
	});

	// Direct coverage for the core normKey resolver (roadmap 1719). The higher-level
	// normalizeAlternativeToolSyntax tests above exercise it indirectly; these lock the
	// concept-anchor contract: ~15 concepts, never per-spelling entries, and non-tool
	// tags MUST resolve to null so callers leave markdown (<br/>, <Input/>) untouched.
	suite('resolveToolNameLoose — concept-anchor resolution', () => {

		test('word-order / separator / case variants all collapse to read_file', () => {
			for (const spelling of ['read_file', 'FileRead', 'ReadFile', 'fileRead', 'file_read', 'READFILE', 'File-Read', 'Read_File']) {
				assert.strictEqual(resolveToolNameLoose(spelling), 'read_file', `${spelling} should resolve to read_file`);
			}
		});

		test('cross-ecosystem aliases resolve (read / bash / view)', () => {
			assert.strictEqual(resolveToolNameLoose('read'), 'read_file');
			assert.strictEqual(resolveToolNameLoose('bash'), 'run_command');
			assert.strictEqual(resolveToolNameLoose('view'), 'read_file');
		});

		// roadmap 1692: resolve well-known sibling-agent (Cline/Roo/Kilo) tool names
		// that aggregator-trained models emit. NAME-based (distinctive snake_case) — not
		// signature-based, so zero false-positive risk on prose/JSX.
		test('Cline/Roo tool names resolve to VibeIDE canonical', () => {
			assert.strictEqual(resolveToolNameLoose('write_to_file'), 'rewrite_file');
			assert.strictEqual(resolveToolNameLoose('execute_command'), 'run_command');
			assert.strictEqual(resolveToolNameLoose('list_files'), 'ls_dir');
		});

		test('write_to_file (Cline/Roo) normalizes with clean param mapping (path→uri, content→new_content)', () => {
			const out = normalizeAlternativeToolSyntax('<write_to_file path="d:/x.ts" content="hello" />');
			assert.ok(out.includes('<rewrite_file>'), `expected rewrite_file block, got: ${out}`);
			assert.ok(out.includes('<uri>d:/x.ts</uri>'), `expected uri param, got: ${out}`);
			assert.ok(out.includes('<new_content>hello</new_content>'), `expected new_content param, got: ${out}`);
			assert.ok(!out.includes('write_to_file'), `raw name should be gone, got: ${out}`);
		});

		// roadmap 1692: the SAFE boundary — signature-based recovery (resolving a tool
		// from path=/command=/pattern= attributes when the NAME is unrecognized) is
		// deliberately NOT done because those attributes are common in JSX/HTML the model
		// writes in prose. These must pass through untouched, which only holds because
		// resolution keys off the tool NAME, not the attribute signature.
		test('JSX/HTML with tool-signature attributes is left untouched (no signature hijack)', () => {
			assert.strictEqual(resolveToolNameLoose('Route'), null);
			assert.strictEqual(resolveToolNameLoose('input'), null);
			const jsx = 'Use <Route path="/users" /> for routing.';
			assert.strictEqual(normalizeAlternativeToolSyntax(jsx), jsx);
			const html = 'Add <input type="text" value="x" /> here.';
			assert.strictEqual(normalizeAlternativeToolSyntax(html), html);
		});

		test('non-tool tags resolve to null (callers leave them untouched)', () => {
			for (const tag of ['br', 'Input', 'img', 'div', 'span', 'randomtag']) {
				assert.strictEqual(resolveToolNameLoose(tag), null, `${tag} should resolve to null`);
			}
		});

		test('resolveInvokeToolName resolves tools but lowercases unknown tags', () => {
			assert.strictEqual(resolveInvokeToolName('FileRead'), 'read_file');
			assert.strictEqual(resolveInvokeToolName('SomeUnknownTag'), 'someunknowntag');
		});
	});

	// roadmap 1739 — regression lock for Fix A: the 4th XML shape, attributes on a PAIRED
	// (non-self-closing) tool tag `<read_file path="x">…</read_file>`. The handler in
	// `normalizeAlternativeToolSyntax` converts attributes → child param tags (with param
	// aliasing) for canonical tools, and bails on non-tools. Behaviour captured from the
	// real implementation (esbuild+node). The native-flip half of 1739 (forceToolCallFormat
	// auto-downgrade) is routing-layer, not this pure normalizer — tracked separately.
	suite('normalizeAlternativeToolSyntax — paired-attr extraction (Fix A / 1739)', () => {

		test('read_file paired-attr → <uri> child (path→uri alias), inner text dropped', () => {
			assert.strictEqual(
				normalizeAlternativeToolSyntax('<read_file path="x.ts">body</read_file>'),
				'<read_file><uri>x.ts</uri></read_file>'
			);
		});

		test('read_file paired-attr offset/limit → start_line/line_limit aliases', () => {
			assert.strictEqual(
				normalizeAlternativeToolSyntax('<read_file path="x.ts" offset="1" limit="30"></read_file>'),
				'<read_file><uri>x.ts</uri><start_line>1</start_line><line_limit>30</line_limit></read_file>'
			);
		});

		test('grep paired-attr → pattern + search_in_folder child tags', () => {
			assert.strictEqual(
				normalizeAlternativeToolSyntax('<grep pattern="foo" search_in_folder="src">x</grep>'),
				'<grep><pattern>foo</pattern><search_in_folder>src</search_in_folder></grep>'
			);
		});

		test('non-tool paired tag with attrs is left untouched (bail on non-tool)', () => {
			assert.strictEqual(
				normalizeAlternativeToolSyntax('<note color="red">hello</note>'),
				'<note color="red">hello</note>'
			);
		});

		test('paired alias form <read>…</read> is NOT extracted (documented asymmetry, X.0.3)', () => {
			// Self-closing `<read … />` resolves the alias, but the paired alias form is left
			// for the safety-net strip — locking the intentional asymmetry, not a desired state.
			assert.strictEqual(
				normalizeAlternativeToolSyntax('<read path="/foo.ts">x</read>'),
				'<read path="/foo.ts">x</read>'
			);
		});

		test('prose containing a bare tool word is untouched', () => {
			assert.strictEqual(
				normalizeAlternativeToolSyntax('just a sentence with <read> of memory'),
				'just a sentence with <read> of memory'
			);
		});
	});
});
