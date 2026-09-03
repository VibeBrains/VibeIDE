/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { rankDefinitions, RankedCandidate, readCallShape } from '../../common/codeSymbols/codeDefinitionResolve.js';
import { CodeSymbol, CodeSymbolKind } from '../../common/codeSymbols/treeSitterSymbols.js';

/**
 * Choosing which declaration a PHP cursor means.
 *
 * The whole point is that this resolves NAMES, not types — so the tests fix two things: that the
 * surrounding text is read correctly, and that an ambiguous case stays ambiguous instead of being
 * resolved by a confident guess.
 */
suite('code definition resolve', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const sym = (name: string, kind: CodeSymbolKind, container: string[] = []): CodeSymbol =>
		({ name, kind, container, startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 });

	const candidate = (file: string, symbol: CodeSymbol): RankedCandidate => ({ file, symbol, score: 0 });

	const indexOf = (...entries: RankedCandidate[]): ReadonlyMap<string, readonly RankedCandidate[]> => {
		const map = new Map<string, RankedCandidate[]>();
		for (const entry of entries) {
			const list = map.get(entry.symbol.name);
			if (list) { list.push(entry); } else { map.set(entry.symbol.name, [entry]); }
		}
		return map;
	};

	/** The shape is read right-to-left from the identifier, so several calls on one line resolve separately. */
	test('the call shape is read from the text around the cursor', () => {
		const line = '        $total = Invoice::pay($this->rate(), new Money(1));';
		const at = (needle: string) => line.indexOf(needle);
		assert.deepStrictEqual(readCallShape(line, at('pay(')), { shape: 'static-member', owner: 'Invoice' });
		assert.deepStrictEqual(readCallShape(line, at('rate(')), { shape: 'this-member' });
		assert.deepStrictEqual(readCallShape(line, at('Money(')), { shape: 'instantiation' });
		assert.deepStrictEqual(readCallShape('helper($x);', 0), { shape: 'call' });
		assert.deepStrictEqual(readCallShape('$repo->save();', '$repo->'.length), { shape: 'instance-member' });
		assert.deepStrictEqual(readCallShape('use App\\Invoice;', 'use App\\'.length), { shape: 'plain' });
	});

	test('a named owner puts its own member first', () => {
		const index = indexOf(
			candidate('other.php', sym('pay', 'method', ['App', 'Order'])),
			candidate('invoice.php', sym('pay', 'method', ['App', 'Invoice'])),
		);
		const ranked = rankDefinitions({ word: 'pay', lineText: 'Invoice::pay();', wordStartColumn: 'Invoice::'.length }, index);
		assert.strictEqual(ranked[0].file, 'invoice.php');
		// The other class stays in the list: it is a real declaration of that name, just less likely.
		assert.strictEqual(ranked.length, 2);
	});

	test('$this resolves against the class being edited', () => {
		const index = indexOf(
			candidate('order.php', sym('rate', 'method', ['App', 'Order'])),
			candidate('invoice.php', sym('rate', 'method', ['App', 'Invoice'])),
		);
		const ranked = rankDefinitions({
			word: 'rate', lineText: '$this->rate();', wordStartColumn: '$this->'.length,
			enclosingContainer: ['App', 'Invoice'],
		}, index);
		assert.strictEqual(ranked[0].file, 'invoice.php');
	});

	/** `self::` and `parent::` name the enclosing class, not a type literally spelled out. */
	test('self:: is resolved against the enclosing class', () => {
		const index = indexOf(
			candidate('order.php', sym('make', 'method', ['App', 'Order'])),
			candidate('invoice.php', sym('make', 'method', ['App', 'Invoice'])),
		);
		const ranked = rankDefinitions({
			word: 'make', lineText: 'self::make();', wordStartColumn: 'self::'.length,
			enclosingContainer: ['App', 'Invoice'],
		}, index);
		assert.strictEqual(ranked[0].file, 'invoice.php');
	});

	test('new prefers the type, a call prefers the callable', () => {
		const index = indexOf(
			candidate('class.php', sym('Money', 'class')),
			candidate('func.php', sym('Money', 'function')),
		);
		assert.strictEqual(rankDefinitions({ word: 'Money', lineText: 'new Money(1);', wordStartColumn: 'new '.length }, index)[0].file, 'class.php');
		assert.strictEqual(rankDefinitions({ word: 'Money', lineText: 'Money(1);', wordStartColumn: 0 }, index)[0].file, 'func.php');
	});

	/**
	 * The case the feature must not lie about: a method reached through a variable whose type is
	 * unknown. Both declarations are equally plausible, and both must survive — the editor then
	 * shows a list instead of jumping somewhere arbitrary.
	 */
	test('an unknown variable type leaves the ambiguity visible', () => {
		const index = indexOf(
			candidate('a.php', sym('save', 'method', ['App', 'UserRepo'])),
			candidate('b.php', sym('save', 'method', ['App', 'OrderRepo'])),
		);
		const ranked = rankDefinitions({ word: 'save', lineText: '$repo->save();', wordStartColumn: '$repo->'.length }, index);
		assert.strictEqual(ranked.length, 2);
		assert.strictEqual(ranked[0].score, ranked[1].score, 'ни один кандидат не должен выигрывать без причины');
		// Order stays as indexed, so the same jump twice lands in the same place.
		assert.deepStrictEqual(ranked.map(r => r.file), ['a.php', 'b.php']);
	});

	test('an unknown name yields nothing rather than a guess', () => {
		const index = indexOf(candidate('a.php', sym('save', 'method', ['App', 'UserRepo'])));
		assert.deepStrictEqual(rankDefinitions({ word: 'missing', lineText: 'missing();', wordStartColumn: 0 }, index), []);
		assert.deepStrictEqual(rankDefinitions({ word: '', lineText: '', wordStartColumn: 0 }, index), []);
		assert.deepStrictEqual(rankDefinitions({ word: '$', lineText: '$;', wordStartColumn: 0 }, index), []);
	});

	/**
	 * The trap that makes a language-agnostic reader wrong: `.` means «member of» in Go, Java and
	 * Python, but string concatenation in PHP. Reading it as access there resolves `$a . helper()`
	 * against an owner that does not exist.
	 */
	test('the access operator comes from the language', () => {
		assert.deepStrictEqual(readCallShape('$total = $a . helper($x);', '$total = $a . '.length, 'php'), { shape: 'call' });
		assert.deepStrictEqual(readCallShape('invoice.Pay()', 'invoice.'.length, 'go'), { shape: 'instance-member' });
		assert.deepStrictEqual(readCallShape('Invoice.Pay()', 'Invoice.'.length, 'go'), { shape: 'static-member', owner: 'Invoice' });
		assert.deepStrictEqual(readCallShape('self.pay()', 'self.'.length, 'python'), { shape: 'this-member' });
		assert.deepStrictEqual(readCallShape('this.pay()', 'this.'.length, 'java'), { shape: 'this-member' });
		assert.deepStrictEqual(readCallShape('Invoice::pay()', 'Invoice::'.length, 'rust'), { shape: 'static-member', owner: 'Invoice' });
	});

	/** In Go and Rust a lower-case owner is usually a package or module, so its functions stay in play. */
	test('a package-qualified call keeps file-level functions plausible', () => {
		const index = indexOf(
			candidate('billing.go', sym('Charge', 'function')),
			candidate('other.go', sym('Charge', 'property', ['App', 'Invoice'])),
		);
		const ranked = rankDefinitions({ word: 'Charge', lineText: 'billing.Charge(1)', wordStartColumn: 'billing.'.length, languageId: 'go' }, index);
		assert.strictEqual(ranked[0].file, 'billing.go');
	});

	/** `$this` in PHP, `self` in Python and Rust, `this` in Java — one meaning, four spellings. */
	test('the enclosing type is found under every spelling of self', () => {
		const index = indexOf(
			candidate('order.py', sym('rate', 'method', ['Order'])),
			candidate('invoice.py', sym('rate', 'method', ['Invoice'])),
		);
		const ranked = rankDefinitions({
			word: 'rate', lineText: 'self.rate()', wordStartColumn: 'self.'.length,
			enclosingContainer: ['Invoice'], languageId: 'python',
		}, index);
		assert.strictEqual(ranked[0].file, 'invoice.py');
	});
});
