/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';
import * as yaml from 'js-yaml';

suite('linux arm64 build workflow', () => {
	const workflowPath = path.join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'release.yml');
	const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as {
		jobs: Record<string, {
			strategy?: { matrix?: { arch?: string[] } };
			steps?: Array<{
				name?: string;
				run?: string;
				env?: Record<string, string>;
			}>;
		}>;
	};

	test('build-linux targets x64 and arm64', () => {
		const job = workflow.jobs['build-linux'];
		assert.ok(job, 'build-linux job must exist');
		assert.deepStrictEqual(job.strategy?.matrix?.arch, ['x64', 'arm64']);
	});

	test('build-linux install step cross-compiles arm64 native modules', () => {
		const job = workflow.jobs['build-linux'];
		const installStep = job.steps?.find(step => step.name === 'Install dependencies');
		assert.ok(installStep, 'Install dependencies step must exist');

		const env = installStep.env;
		assert.ok(env, 'Install step must have env');
		assert.strictEqual(env['npm_config_arch'], "${{ matrix.arch == 'arm64' && 'arm64' || 'x64' }}",
			'npm_config_arch must follow the target architecture');
		assert.strictEqual(env['CC'], "${{ matrix.arch == 'arm64' && 'aarch64-linux-gnu-gcc' || 'gcc' }}",
			'CC must use the aarch64 cross compiler for arm64');
		assert.strictEqual(env['CXX'], "${{ matrix.arch == 'arm64' && 'aarch64-linux-gnu-g++' || 'g++' }}",
			'CXX must use the aarch64 cross compiler for arm64');

		const run = installStep.run ?? '';
		assert.ok(run.includes('gcc-aarch64-linux-gnu'), 'Install step must install gcc-aarch64-linux-gnu');
		assert.ok(run.includes('g++-aarch64-linux-gnu'), 'Install step must install g++-aarch64-linux-gnu');
		assert.ok(run.includes('matrix.arch') && run.includes('arm64'), 'Cross compiler install must be conditional on arm64 matrix');
	});
});
