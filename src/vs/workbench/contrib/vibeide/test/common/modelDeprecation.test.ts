/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deprecationStatus, excludedFromAutoPick, DEPRECATION_SOON_DAYS } from '../../common/modelDeprecation.js';
import { deprecationShortLabel, deprecationTooltip } from '../../common/modelDeprecationText.js';

/**
 * Vendor-announced retirement of a model.
 *
 * The point is the moment of telling: a shutdown the user meets mid-task is a failed request, the
 * same thing said while picking the model is a choice. These tests fix WHEN we say it and what we
 * refuse to decide on the user's behalf.
 */
suite('model deprecation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 2026-09-01T00:00:00Z — the clock is a parameter, so the verdict is reproducible. */
	const now = Date.UTC(2026, 8, 1);
	const day = 86_400_000;

	test('a date ahead, close, and past map onto three different verdicts', () => {
		assert.deepStrictEqual(
			deprecationStatus({ date: '2026-12-01' }, now),
			{ severity: 'announced', daysLeft: 91, replacedBy: undefined, note: undefined },
		);
		assert.deepStrictEqual(
			deprecationStatus({ date: '2026-09-20', replacedBy: 'MiniMax-M4' }, now),
			{ severity: 'soon', daysLeft: 19, replacedBy: 'MiniMax-M4', note: undefined },
		);
		assert.deepStrictEqual(
			deprecationStatus({ date: '2026-08-20' }, now),
			{ severity: 'retired', daysLeft: -12, replacedBy: undefined, note: undefined },
		);
	});

	test('the boundary day counts as soon, the day after it does not', () => {
		const onBoundary = new Date(now + DEPRECATION_SOON_DAYS * day).toISOString().slice(0, 10);
		const dayAfter = new Date(now + (DEPRECATION_SOON_DAYS + 1) * day).toISOString().slice(0, 10);
		assert.strictEqual(deprecationStatus({ date: onBoundary }, now)?.severity, 'soon');
		assert.strictEqual(deprecationStatus({ date: dayAfter }, now)?.severity, 'announced');
	});

	/**
	 * A malformed date must not swallow the announcement. The vendor did say the model is going
	 * away; dropping that because the string was unparsable would hide the half that matters.
	 */
	test('a broken or missing date still reports the announcement', () => {
		assert.deepStrictEqual(
			deprecationStatus({ date: 'скоро', note: 'из ченджлога вендора' }, now),
			{ severity: 'announced', replacedBy: undefined, note: 'из ченджлога вендора' },
		);
		assert.deepStrictEqual(
			deprecationStatus({ replacedBy: 'gpt-6' }, now),
			{ severity: 'announced', replacedBy: 'gpt-6', note: undefined },
		);
		assert.strictEqual(deprecationStatus(undefined, now), undefined);
	});

	/**
	 * Auto-pick is the one place the user is not choosing, so a model the vendor already turned off
	 * must not be handed over silently. Everything short of that stays available: a date three
	 * months out is a reason to warn, not to take the model away.
	 */
	test('only a retired model drops out of auto-pick', () => {
		assert.strictEqual(excludedFromAutoPick(deprecationStatus({ date: '2026-08-20' }, now)), true);
		assert.strictEqual(excludedFromAutoPick(deprecationStatus({ date: '2026-09-20' }, now)), false);
		assert.strictEqual(excludedFromAutoPick(deprecationStatus({ date: '2026-12-01' }, now)), false);
		assert.strictEqual(excludedFromAutoPick(undefined), false);
	});

	/**
	 * What the picker says: the vendor's date for a reader, how far it is, the successor, and that a retired model is
	 * still the user's to pick by hand
	 */
	test('the picker names the date, the distance and the successor', () => {
		const said = (deprecation: { date?: string; replacedBy?: string }) => {
			const status = deprecationStatus(deprecation, now)!;
			return { short: deprecationShortLabel(status, deprecation.date), tooltip: deprecationTooltip(status, deprecation.date) };
		};
		assert.deepStrictEqual([
			said({ date: '2026-08-16', replacedBy: 'openai/gpt-oss-20b' }),
			said({ date: '2026-09-20' }),
			said({ date: '2026-09-01' }),
			said({ replacedBy: 'deepseek-flash' }),
		], [
			{
				short: 'выключена вендором',
				tooltip: 'Вендор выключил модель 16.08.2026 — 16 дн. назад\nАвтовыбор её не берёт; выбрать вручную можно — по корпоративному договору она может работать\nЗамена — openai/gpt-oss-20b',
			},
			{ short: 'выключится 20.09.2026', tooltip: 'Вендор выключит модель 20.09.2026 — через 19 дн.' },
			{ short: 'выключится 01.09.2026', tooltip: 'Вендор выключает модель сегодня, 01.09.2026' },
			{ short: 'снимается вендором', tooltip: 'Вендор объявил, что модель снимается, дату не назвал\nЗамена — deepseek-flash' },
		]);
	});
});
