/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_READY_TIMEOUT_MS,
	VibeServerEntry,
	effectiveReadyCheck,
	effectiveReadyTimeoutMs,
	parseServersFile,
	planStartOrder,
	selectWithDependencies,
} from '../../common/vibeServer/vibeServersFile.js';

/** Minimal valid entry; individual tests override what they exercise. */
function entry(id: string, over: Partial<VibeServerEntry> = {}): VibeServerEntry {
	return { id, command: 'npm start', ...over };
}

suite('VibeServersFile — parseServersFile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses the BuzzBang stack (JSONC comments tolerated)', () => {
		const result = parseServersFile(`{
			// dev stack
			"version": 1,
			"servers": [
				{ "id": "colima", "kind": "task", "command": "colima start", "readyCheck": "exit", "skipIf": "docker info" },
				{ "id": "api", "dir": "api", "command": "yarn dev", "port": 3000, "readyTimeoutMs": 180000,
				  "dependsOn": ["colima"], "pathPrepend": ["/opt/homebrew/opt/node@20/bin"],
				  "previewPath": "/dashboard", "stopCommand": "docker compose down" },
				{ "id": "admin", "dir": "admin", "command": "npm start", "port": 4200, "readyTimeoutMs": 420000 },
				{ "id": "app", "dir": "app", "command": "npm start -- --port 8100", "port": 8100, "readyTimeoutMs": 420000 }
			]
		}`);

		assert.deepStrictEqual(
			{
				ok: result.ok,
				warnings: result.warnings,
				ids: result.servers.map(s => s.id),
				api: result.servers.find(s => s.id === 'api'),
			},
			{
				ok: true,
				warnings: [],
				ids: ['colima', 'api', 'admin', 'app'],
				api: {
					id: 'api', name: undefined, kind: 'service', active: true, dir: 'api',
					command: 'yarn dev', port: 3000, readyCheck: undefined, readyPath: undefined,
					readyPattern: undefined, readyTimeoutMs: 180000, dependsOn: ['colima'],
					skipIf: undefined, env: undefined, envFile: undefined,
					pathPrepend: ['/opt/homebrew/opt/node@20/bin'], autoStart: false,
					previewPath: '/dashboard', stopCommand: 'docker compose down', note: undefined,
				},
			},
		);
	});

	test('top-level problems return ok:false without servers', () => {
		assert.deepStrictEqual(
			[parseServersFile(undefined).ok, parseServersFile('').ok, parseServersFile('{ nope }').ok, parseServersFile('{"servers":{}}').ok],
			[false, false, false, false],
		);
	});

	test('malformed entries are skipped, valid neighbours survive', () => {
		const result = parseServersFile(`{"servers":[
			{ "command": "x" },
			{ "id": "no-command" },
			{ "id": "port-check-without-port", "command": "x", "readyCheck": "port" },
			{ "id": "log-check-without-pattern", "command": "x", "readyCheck": "log" },
			{ "id": "dup", "command": "x" },
			{ "id": "dup", "command": "y" },
			{ "id": "good", "command": "npm start", "port": 3000 }
		]}`);

		assert.deepStrictEqual(
			{ ok: result.ok, ids: result.servers.map(s => s.id), warnings: result.warnings.length },
			{ ok: true, ids: ['dup', 'good'], warnings: 5 },
		);
	});

	test('readiness defaults: task→exit, service with port→port, service without→spawn', () => {
		assert.deepStrictEqual(
			[
				effectiveReadyCheck(entry('t', { kind: 'task' })),
				effectiveReadyCheck(entry('s', { port: 3000 })),
				effectiveReadyCheck(entry('s')),
				effectiveReadyCheck(entry('s', { port: 3000, readyCheck: 'http' })),
				effectiveReadyTimeoutMs(entry('s')),
				effectiveReadyTimeoutMs(entry('s', { readyTimeoutMs: 420000 })),
			],
			['exit', 'port', 'spawn', 'http', DEFAULT_READY_TIMEOUT_MS, 420000],
		);
	});
});

suite('VibeServersFile — planStartOrder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('independent services share one wave; dependants follow', () => {
		const plan = planStartOrder([
			entry('api', { dependsOn: ['colima'] }),
			entry('colima', { kind: 'task' }),
			entry('admin'),
			entry('app'),
		]);

		assert.deepStrictEqual(
			{ waves: plan.waves.map(w => [...w].sort()), excluded: plan.excluded },
			{ waves: [['admin', 'app', 'colima'], ['api']], excluded: [] },
		);
	});

	test('unknown dependency excludes the entry and cascades to its dependants', () => {
		const plan = planStartOrder([
			entry('api', { dependsOn: ['ghost'] }),
			entry('worker', { dependsOn: ['api'] }),
			entry('admin'),
		]);

		assert.deepStrictEqual(
			{ waves: plan.waves, excluded: [...plan.excluded].sort((a, b) => a.id.localeCompare(b.id)) },
			{
				waves: [['admin']],
				excluded: [
					{ id: 'api', reason: 'зависит от неизвестного сервиса "ghost"' },
					{ id: 'worker', reason: 'зависит от "api", который исключён' },
				],
			},
		);
	});

	test('inactive dependency excludes its dependant (never starts without prerequisite)', () => {
		const plan = planStartOrder([
			entry('db', { active: false }),
			entry('api', { dependsOn: ['db'] }),
		]);

		assert.deepStrictEqual(
			{ waves: plan.waves, excluded: plan.excluded },
			{ waves: [], excluded: [{ id: 'api', reason: 'зависит от неизвестного сервиса "db"' }] },
		);
	});

	test('dependency cycle excludes the whole cycle, unrelated entries still start', () => {
		const plan = planStartOrder([
			entry('a', { dependsOn: ['b'] }),
			entry('b', { dependsOn: ['a'] }),
			entry('solo'),
		]);

		assert.deepStrictEqual(
			{ waves: plan.waves, excluded: [...plan.excluded].map(e => e.id).sort(), reason: plan.excluded[0]?.reason },
			{ waves: [['solo']], excluded: ['a', 'b'], reason: 'циклическая зависимость' },
		);
	});

	test('deep chain produces one entry per wave', () => {
		const plan = planStartOrder([
			entry('third', { dependsOn: ['second'] }),
			entry('first'),
			entry('second', { dependsOn: ['first'] }),
		]);

		assert.deepStrictEqual(plan.waves, [['first'], ['second'], ['third']]);
	});

	test('empty stack plans nothing', () => {
		assert.deepStrictEqual(planStartOrder([]), { waves: [], excluded: [] });
	});
});

suite('VibeServersFile — selectWithDependencies', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pulls the target plus its transitive dependencies, drops siblings', () => {
		const stack = [
			entry('colima', { kind: 'task' }),
			entry('api', { dependsOn: ['colima'] }),
			entry('admin'),
			entry('app', { dependsOn: ['api'] }),
		];

		assert.deepStrictEqual(
			{
				app: selectWithDependencies(stack, 'app').map(s => s.id),
				admin: selectWithDependencies(stack, 'admin').map(s => s.id),
				unknown: selectWithDependencies(stack, 'ghost').map(s => s.id),
			},
			{
				// File order preserved; `admin` (a sibling of the chain) is excluded.
				app: ['colima', 'api', 'app'],
				admin: ['admin'],
				unknown: [],
			},
		);
	});

	test('selection feeds planStartOrder into correct waves', () => {
		const stack = [
			entry('colima', { kind: 'task' }),
			entry('api', { dependsOn: ['colima'] }),
			entry('app', { dependsOn: ['api'] }),
			entry('admin'),
		];
		const plan = planStartOrder(selectWithDependencies(stack, 'app'));

		assert.deepStrictEqual(
			{ waves: plan.waves, excluded: plan.excluded },
			{ waves: [['colima'], ['api'], ['app']], excluded: [] },
		);
	});

	test('unknown dependency of the target survives into planStartOrder as an exclusion', () => {
		const stack = [entry('app', { dependsOn: ['ghost'] })];
		const plan = planStartOrder(selectWithDependencies(stack, 'app'));

		assert.deepStrictEqual(
			{ waves: plan.waves, excluded: plan.excluded },
			{ waves: [], excluded: [{ id: 'app', reason: 'зависит от неизвестного сервиса "ghost"' }] },
		);
	});
});
