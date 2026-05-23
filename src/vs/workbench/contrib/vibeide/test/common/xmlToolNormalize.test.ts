/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

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
import {
	normalizeAlternativeToolSyntax,
	SELF_CLOSING_PARTIAL_RE,
	stripUnclaimedToolTags,
} from '../../common/xmlToolNormalize.js';

suite('XML tool normalization (v0.13.10)', () => {

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
			assert.match(out, /<path>\/foo\.ts<\/path>/);
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
			assert.match(out, /<path>d:\\foo\.md<\/path>/);
			assert.match(out, /<\/read_file>/);
		});

		test('self-closing with multiple attributes', () => {
			const input = '<read_file path="x.ts" offset="1" limit="30" />';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<path>x\.ts<\/path>/);
			assert.match(out, /<offset>1<\/offset>/);
			assert.match(out, /<limit>30<\/limit>/);
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
			assert.match(out, /<list_files>/);
			assert.doesNotMatch(out, /｜｜/, `DSML markers should be gone, got: ${out.slice(0, 200)}`);
			assert.doesNotMatch(out, /<tool_calls>/, `outer wrapper should be stripped, got: ${out.slice(0, 200)}`);
		});

		test('ASCII-pipe DSML variant also stripped', () => {
			// Hypothetical future vendor using ASCII `|` instead of fullwidth `｜`.
			const input = '<|FOO|invoke name="read_file"><|FOO|parameter name="path">x</|FOO|parameter></|FOO|invoke>';
			const out = normalizeAlternativeToolSyntax(input);
			assert.match(out, /<read_file>/);
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
});
