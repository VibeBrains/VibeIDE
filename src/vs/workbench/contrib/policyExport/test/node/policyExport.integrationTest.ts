/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dirname, join } from '../../../../../base/common/path.js';
import { FileAccess } from '../../../../../base/common/network.js';
import * as util from 'util';

const execFile = util.promisify(cp.execFile);

suite('PolicyExport Integration Tests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('exported policy data matches checked-in file', async function () {
		// This test launches a NESTED full Electron VS Code (`code.sh --export-policy-data`). That is
		// unreliable in headless CI runners: the nested instance shares the parent test-VS-Code's
		// user-data-dir and hangs on a lock (60s timeout). Skip it in CI — on ADO (TF_BUILD) as before,
		// and on GitHub Actions (GITHUB_ACTIONS). It still runs on a developer machine, which is where
		// `policyData.jsonc` drift is meant to be caught (run `npm run export-policy-data`).
		if (process.env['TF_BUILD'] || process.env['GITHUB_ACTIONS']) {
			this.skip();
		}

		// The canonical export launches both product entrypoints.
		this.timeout(120000);

		// FileAccess.asFileUri('') points to the 'out' directory.
		const rootPath = dirname(FileAccess.asFileUri('').fsPath);
		const exportScript = join(rootPath, 'build/lib/policies/exportPolicyData.ts');
		const fixturePath = join(rootPath, 'src/vs/workbench/contrib/policyExport/test/node/extensionPolicyFixture.json');
		await execFile('node', [exportScript, '--check', '--skip-transpile'], {
			cwd: rootPath,
			env: { ...process.env, DISTRO_PRODUCT_JSON: fixturePath, VSCODE_SKIP_PRELAUNCH: '1' },
			maxBuffer: 10 * 1024 * 1024,
		});
	});
});
