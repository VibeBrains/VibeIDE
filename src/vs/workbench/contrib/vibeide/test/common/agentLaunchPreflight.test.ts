/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LaunchPlanFacts, evaluateLaunchPlan, renderPreflightMarkdown } from '../../common/agentLaunchPreflight.js';

const READ_ONLY_TOOLS = ['read_file', 'grep'];
const FULL_TOOLS = ['read_file', 'edit_file', 'run_command'];

function facts(overrides: Partial<LaunchPlanFacts> = {}): LaunchPlanFacts {
	return {
		subject: 'role',
		subjectName: 'Ревьюер',
		allowedTools: READ_ONLY_TOOLS,
		provider: 'minimax',
		model: 'MiniMax-M3',
		modelAllowed: true,
		workspaceName: 'my-project',
		constraintRules: [],
		permissions: {},
		autopilot: false,
		tokenQuota: 100_000,
		maxSteps: 60,
		maxWallClockSec: 300,
		verifyGateMode: 'off',
		verifyCommand: '',
		runLedgerEnabled: true,
		...overrides,
	};
}

function titles(plan: LaunchPlanFacts): string[] {
	return evaluateLaunchPlan(plan).findings.map(f => `${f.severity}:${f.title}`);
}

suite('agentLaunchPreflight — what the agent will be allowed to do', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('read-only role is launchable and says so; nothing about writes is raised', () => {
		const report = evaluateLaunchPlan(facts());
		assert.deepStrictEqual(
			[report.launchable, report.canWrite, report.canRunCommands, report.findings.map(f => f.title)],
			[true, false, false, ['Только чтение']],
		);
	});

	test('a model outside the whitelist blocks the launch, everything else only annotates it', () => {
		assert.deepStrictEqual(
			[
				evaluateLaunchPlan(facts({ modelAllowed: false })).launchable,
				evaluateLaunchPlan(facts({ allowedTools: FULL_TOOLS, autopilot: true })).launchable,
				evaluateLaunchPlan(facts()).launchable,
			],
			[false, true, true],
		);
	});

	test('a writing role raises the risks a user actually cares about', () => {
		assert.deepStrictEqual(
			titles(facts({ allowedTools: FULL_TOOLS, autopilot: true })),
			[
				'warn:Команды выполняются без запроса',
				'note:Запрет на запись не настроен',
				'note:Результат не проверяется сборкой',
			],
		);
	});

	test('configured guards silence their notes; a half-configured gate warns instead', () => {
		assert.deepStrictEqual(
			[
				titles(facts({
					allowedTools: FULL_TOOLS,
					constraintRules: [{ type: 'deny_write', pattern: 'src/secrets/**' }],
					verifyGateMode: 'enforce',
					verifyCommand: 'npm run verify',
				})),
				titles(facts({ allowedTools: FULL_TOOLS, verifyGateMode: 'enforce', verifyCommand: '   ' })),
			],
			[
				[],
				// Rights first, then how the result is checked — the order the report reads in.
				['note:Запрет на запись не настроен', 'warn:VERIFY-GATE включён, но команда не задана'],
			],
		);
	});

	test('blocked patterns merge both rule sources, deduplicated and sorted', () => {
		const report = evaluateLaunchPlan(facts({
			allowedTools: FULL_TOOLS,
			constraintRules: [
				{ type: 'deny_write', pattern: 'src/generated/**' },
				{ type: 'deny_read', pattern: '.env' },
				{ type: 'max_lines_per_function', value: 50 },
			],
			permissions: { deny_write: ['dist/**', 'src/generated/**'], deny_read: ['.env'] },
		}));

		assert.deepStrictEqual(
			[report.writeBlocked, report.readBlocked],
			[['dist/**', 'src/generated/**'], ['.env']],
		);
	});

	test('report states plainly that nothing ran, and reflects the verdict', () => {
		const blocked = facts({ modelAllowed: false });
		const markdown = renderPreflightMarkdown(blocked, evaluateLaunchPlan(blocked));
		assert.deepStrictEqual(
			[
				markdown.includes('Модель не вызывалась, файлы не менялись.'),
				markdown.includes('**Запуск невозможен**'),
				markdown.includes('роль «Ревьюер»'),
			],
			[true, true, true],
		);
	});
});
