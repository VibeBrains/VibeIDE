/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { detectShellMisuse, truncateHeadTail, countLines, ToolValidationError, looksLikeShellAwaitingInput, formatTerminalTimeoutNotice, clampLineWindowToCharBudget } from '../../common/toolHardening.js';

suite('ToolHardening', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('detectShellMisuse — file readers', () => {
		test('flags Get-Content', () => {
			const m = detectShellMisuse('Get-Content C:\\foo\\bar.md');
			assert.ok(m);
			assert.strictEqual(m!.suggestedTool, 'read_file');
		});

		test('flags Get-Content alias gc', () => {
			const m = detectShellMisuse('gc somefile.txt');
			assert.ok(m);
			assert.strictEqual(m!.kind, 'read_file');
		});

		test('flags type', () => {
			assert.ok(detectShellMisuse('type README.md'));
		});

		test('flags cat with file', () => {
			assert.ok(detectShellMisuse('cat src/main.ts'));
		});

		test('flags head/tail when not piped', () => {
			assert.ok(detectShellMisuse('head -n 50 src/main.ts'));
			assert.ok(detectShellMisuse('tail -100 logs/app.log'));
		});

		test('does NOT flag head/tail in a pipeline (legit shell hygiene)', () => {
			assert.strictEqual(detectShellMisuse('git log | head -20'), null);
		});
	});

	suite('detectShellMisuse — listing', () => {
		test('flags recursive ls', () => {
			const m = detectShellMisuse('ls -la');
			assert.ok(m);
			assert.strictEqual(m!.suggestedTool, 'ls_dir');
		});

		test('flags dir /s', () => {
			const m = detectShellMisuse('dir /s C:\\proj');
			assert.ok(m);
		});

		test('flags tree', () => {
			const m = detectShellMisuse('tree -L 3');
			assert.ok(m);
			assert.strictEqual(m!.suggestedTool, 'get_dir_tree');
		});

		test('does NOT flag a single-file dir/ls', () => {
			assert.strictEqual(detectShellMisuse('dir package.json'), null);
		});

		// File-existence idiom: `dir /s /b "<path>\file.ext"` is bounded output.
		// Used by aggregator-proxied models (Nemotron/qwen via openCodeGo/zen) as
		// a "does this file exist anywhere under here?" probe. Should be allowed.
		test('does NOT flag dir /s /b with specific file (extension at path end)', () => {
			assert.strictEqual(
				detectShellMisuse('dir /s /b "c:\\Repo\\Promed\\.cursor\\notes\\process.md" 2>nul || echo "File not found"'),
				null,
			);
			assert.strictEqual(detectShellMisuse('dir /s /b file.txt'), null);
		});

		test('still flags dir /s on a directory (no extension on tail token)', () => {
			assert.ok(detectShellMisuse('dir /s C:\\proj'));
			assert.ok(detectShellMisuse('dir /s /b D:\\repo'));
		});

		test('does NOT flag dir /b on a single file (bare format alone is not recursive)', () => {
			assert.strictEqual(detectShellMisuse('dir /b file.md'), null);
		});

		// D.39: shell-wrapper bypass — the real command is quoted inside cmd/c, powershell -c, bash -c.
		// Head-of-command is the wrapper (`cmd`), so rules must re-check the inner command.
		test('flags tree wrapped in cmd /c (the 67s-freeze bypass)', () => {
			const m = detectShellMisuse('cmd /c "tree /F /A c:\\Repo\\Promed\\.vibe"');
			assert.ok(m);
			assert.strictEqual(m!.suggestedTool, 'get_dir_tree');
		});

		test('flags recursive dir wrapped in cmd /c', () => {
			assert.ok(detectShellMisuse('cmd /c "dir /s C:\\proj"'));
		});

		test('flags grep-like wrapped in bash -c / powershell -Command', () => {
			assert.ok(detectShellMisuse("bash -c 'grep -r foo .'"));
			assert.ok(detectShellMisuse('powershell -Command "Get-Content big.log"'));
		});

		test('wrapper exemptions still hold (cmd /c with bounded file-existence probe)', () => {
			assert.strictEqual(detectShellMisuse('cmd /c "dir /s /b file.txt"'), null);
		});

		test('does NOT flag a legitimate wrapped command (npm build)', () => {
			assert.strictEqual(detectShellMisuse('cmd /c "npm run build"'), null);
		});
	});

	suite('detectShellMisuse — workspace config overrides', () => {
		test('allowedPatterns short-circuits default rules', () => {
			// `grep -r foo .` would normally flag (search_content rule)
			assert.ok(detectShellMisuse('grep -r foo .'));
			// With workspace allowlist entry, it passes through.
			assert.strictEqual(
				detectShellMisuse('grep -r foo .', { allowedPatterns: ['^grep\\s+'] }),
				null,
			);
		});

		test('disableDefaultRules turns off a specific rule by id', () => {
			assert.ok(detectShellMisuse('grep -r foo .'));
			assert.strictEqual(
				detectShellMisuse('grep -r foo .', { disableDefaultRules: ['search_content'] }),
				null,
			);
			// Other rules still active when only one is disabled.
			assert.ok(detectShellMisuse('cat foo.md', { disableDefaultRules: ['search_content'] }));
		});

		test('extraRules adds workspace-specific blocks after defaults', () => {
			const cfg = {
				extraRules: [{
					id: 'block_yarn_install',
					bareName: '^yarn$',
					requires: { tailMatches: '^install\\b' },
					kind: 'edit_file' as const,
					suggestedTool: 'package_manager',
					hint: 'Use the package_manager tool for {bareName}.',
				}],
			};
			assert.ok(detectShellMisuse('yarn install', cfg));
			// Default rules still pass-through when extra rule doesn't match.
			assert.strictEqual(detectShellMisuse('yarn build', cfg), null);
		});

		test('invalid allowedPatterns regex is silently skipped (does not throw)', () => {
			// Unbalanced bracket — should not crash detection.
			const result = detectShellMisuse('grep foo .', { allowedPatterns: ['[invalid('] });
			assert.ok(result); // grep still flagged by default rule
		});
	});

	suite('detectShellMisuse — search', () => {
		test('flags grep', () => {
			const m = detectShellMisuse('grep -r "foo" src/');
			assert.ok(m);
			assert.strictEqual(m!.suggestedTool, 'grep');
		});

		test('flags ripgrep (rg)', () => {
			assert.ok(detectShellMisuse('rg "TODO" --type ts'));
		});

		test('flags findstr', () => {
			assert.ok(detectShellMisuse('findstr /S /I "needle" *.txt'));
		});

		test('flags Select-String / sls', () => {
			assert.ok(detectShellMisuse('Select-String -Pattern "x" -Path *.ts'));
			assert.ok(detectShellMisuse('sls "x" file.txt'));
		});

		test('flags find -name', () => {
			const m = detectShellMisuse('find . -name "*.ts"');
			assert.ok(m);
			assert.strictEqual(m!.suggestedTool, 'glob');
		});
	});

	suite('detectShellMisuse — in-place editors', () => {
		test('flags sed -i', () => {
			const m = detectShellMisuse('sed -i "s/foo/bar/g" file.txt');
			assert.ok(m);
			assert.strictEqual(m!.suggestedTool, 'edit_file');
		});

		test('does NOT flag sed without -i', () => {
			assert.strictEqual(detectShellMisuse('sed "s/x/y/" file.txt | head -5'), null);
		});
	});

	suite('detectShellMisuse — file writers', () => {
		test('flags Set-Content head-of-command', () => {
			const m = detectShellMisuse('Set-Content -Path config.json -Value "{}"');
			assert.ok(m);
			assert.strictEqual(m!.kind, 'write_file');
			assert.strictEqual(m!.suggestedTool, 'rewrite_file');
		});

		test('flags Add-Content and Out-File', () => {
			assert.ok(detectShellMisuse('Add-Content -Path log.txt -Value "x"'));
			assert.ok(detectShellMisuse('Out-File -FilePath out.txt -InputObject $x'));
		});

		// The real budget-burn case (model-stalls #015): minimax built a .ps1
		// line-by-line via `powershell -Command "...Add-Content..."`, an
		// unterminated here-string hung the terminal, repeated until timeout.
		test('flags write cmdlet wrapped in powershell -Command', () => {
			const m = detectShellMisuse('powershell -NoProfile -Command "Set-Content -Path d:/p/main.php -Value $c"');
			assert.ok(m);
			assert.strictEqual(m!.kind, 'write_file');
			assert.ok(detectShellMisuse('pwsh -c "Add-Content file.ps1 -Value foo"'));
		});

		// Anti-false-positive: reading via a shell wrapper is NOT a write. Since D.39 the wrapper
		// is unwrapped and the inner Get-Content IS still flagged — but as a READ misuse.
		test('flags Get-Content wrapped in powershell as read misuse (not write)', () => {
			const m = detectShellMisuse('powershell -Command "Get-Content d:/p/main.php"');
			assert.ok(m);
			assert.strictEqual(m!.kind, 'read_file');
		});

		// Anti-false-positive: legit remote deploy (read local, pipe to remote tee)
		// has no local write cmdlet in the tail — must pass through.
		test('does NOT flag read-and-pipe-to-remote-tee deploy', () => {
			assert.strictEqual(
				detectShellMisuse(`powershell -NoProfile -Command "Get-Content 'd:/p/x.php' | ssh user@host 'sudo tee /var/www/x.php > /dev/null'"`),
				null,
			);
		});

		// Anti-false-positive: executing a script file is not writing one.
		test('does NOT flag powershell -File (script execution)', () => {
			assert.strictEqual(detectShellMisuse('powershell -NoProfile -ExecutionPolicy Bypass -File "d:/p/deploy.ps1"'), null);
		});
	});

	suite('detectShellMisuse — passthrough', () => {
		test('git is allowed', () => {
			assert.strictEqual(detectShellMisuse('git status'), null);
			assert.strictEqual(detectShellMisuse('git log --oneline -20'), null);
		});

		test('npm/pnpm/yarn are allowed', () => {
			assert.strictEqual(detectShellMisuse('npm run build'), null);
			assert.strictEqual(detectShellMisuse('pnpm test --watch'), null);
		});

		test('docker / kubectl are allowed', () => {
			assert.strictEqual(detectShellMisuse('docker compose up'), null);
		});

		test('PowerShell call-operator prefix is stripped before matching', () => {
			assert.ok(detectShellMisuse('& Get-Content foo.md'));
		});

		test('env-var prefix is stripped', () => {
			assert.ok(detectShellMisuse('DEBUG=1 cat config.yaml'));
		});
	});

	suite('truncateHeadTail', () => {
		test('returns unchanged when under cap', () => {
			assert.strictEqual(truncateHeadTail('hello', 100), 'hello');
		});

		test('truncates with marker when over cap', () => {
			const big = 'a'.repeat(1000);
			const out = truncateHeadTail(big, 100);
			assert.ok(out.length <= 100);
			assert.ok(out.includes('[truncated]'));
		});

		test('keeps head and tail content (heuristic)', () => {
			const s = 'HEAD' + 'x'.repeat(500) + 'TAIL';
			const out = truncateHeadTail(s, 80);
			assert.ok(out.startsWith('HEAD'));
			assert.ok(out.endsWith('TAIL'));
		});
	});

	suite('looksLikeShellAwaitingInput', () => {
		test('detects trailing PowerShell >> continuation prompt (model-stalls #015)', () => {
			assert.strictEqual(looksLikeShellAwaitingInput('PS D:\\proj> Add-Content ...\n>>'), true);
			assert.strictEqual(looksLikeShellAwaitingInput('PS D:\\proj> foo\n>>\n'), true);
		});

		test('detects single > (POSIX/unclosed-quote continuation)', () => {
			assert.strictEqual(looksLikeShellAwaitingInput('echo "unterminated\n>'), true);
		});

		test('ignores > inside normal output (only whole-line chevrons match)', () => {
			assert.strictEqual(looksLikeShellAwaitingInput('echo hi > file.txt\ndone\n(exit code 0)'), false);
			assert.strictEqual(looksLikeShellAwaitingInput('a -> b -> c'), false);
		});

		test('false for empty / normal completed output', () => {
			assert.strictEqual(looksLikeShellAwaitingInput(''), false);
			assert.strictEqual(looksLikeShellAwaitingInput('Build succeeded\n'), false);
		});

		test('does not match 4+ chevrons (not a real prompt)', () => {
			assert.strictEqual(looksLikeShellAwaitingInput('>>>>'), false);
		});
	});

	suite('formatTerminalTimeoutNotice (roadmap #1640)', () => {
		test('signals non-completion explicitly (not an ambiguous "timed out")', () => {
			const msg = formatTerminalTimeoutNotice(30, false);
			assert.ok(/did NOT finish/i.test(msg), 'must state the command did not finish');
			assert.ok(/PARTIAL/i.test(msg), 'must flag the output as partial');
			assert.ok(/do NOT assume/i.test(msg), 'must warn against assuming success');
			assert.ok(msg.includes('30s'), 'includes the elapsed seconds');
		});

		test('non-awaiting tail offers timeout_ms / background remediation', () => {
			const msg = formatTerminalTimeoutNotice(60, false);
			assert.ok(msg.includes('timeout_ms'));
			assert.ok(msg.includes('run_in_background'));
		});

		test('awaiting-input tail points to the >> continuation cause + rewrite_file', () => {
			const msg = formatTerminalTimeoutNotice(120, true);
			assert.ok(msg.includes('>>'));
			assert.ok(/rewrite_file|edit_file/.test(msg));
			// still leads with the non-completion signal regardless of branch
			assert.ok(/did NOT finish/i.test(msg));
		});
	});

	suite('countLines', () => {
		test('zero for empty', () => {
			assert.strictEqual(countLines(''), 0);
		});

		test('1 for single-line no newline', () => {
			assert.strictEqual(countLines('hello'), 1);
		});

		test('counts \\n correctly', () => {
			assert.strictEqual(countLines('a\nb\nc'), 3);
			assert.strictEqual(countLines('a\nb\nc\n'), 4);
		});
	});

	suite('ToolValidationError', () => {
		test('carries code/hint/suggestedTool', () => {
			const e = new ToolValidationError({ code: 'X', message: 'm', hint: 'h', suggestedTool: 't' });
			assert.strictEqual(e.code, 'X');
			assert.strictEqual(e.hint, 'h');
			assert.strictEqual(e.suggestedTool, 't');
			assert.strictEqual(e.name, 'ToolValidationError');
			assert.ok(e instanceof Error);
		});
	});

	suite('clampLineWindowToCharBudget', () => {
		test('window already within budget is unchanged', () => {
			const lines = ['aaa', 'bbb', 'ccc'];
			assert.strictEqual(clampLineWindowToCharBudget(lines, 1, 3, 100), 3);
		});

		test('shrinks the window at a line boundary to fit the budget', () => {
			// 10 lines of 10 chars; joined cost = 10 + 9*11 chars. Budget 35 fits lines 1-3 (10+11+11=32).
			const lines = Array.from({ length: 10 }, () => 'x'.repeat(10));
			assert.strictEqual(clampLineWindowToCharBudget(lines, 1, 10, 35), 3);
		});

		test('keeps at least the first line even when it alone exceeds the budget', () => {
			const lines = ['y'.repeat(1000), 'z'];
			assert.strictEqual(clampLineWindowToCharBudget(lines, 1, 2, 50), 1);
		});

		test('respects a non-1 start line', () => {
			const lines = ['aaaa', 'bbbb', 'cccc', 'dddd'];
			// From line 2: 4 + 5 = 9 chars for lines 2-3; line 4 (+5) would exceed 10.
			assert.strictEqual(clampLineWindowToCharBudget(lines, 2, 4, 10), 3);
		});

		test('clamps endLine beyond the array length', () => {
			const lines = ['a', 'b'];
			assert.strictEqual(clampLineWindowToCharBudget(lines, 1, 99, 1000), 2);
		});
	});
});
