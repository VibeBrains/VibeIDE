/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as path from 'path';
import * as task from './gulp/task.ts';

const root = path.dirname(path.dirname(import.meta.dirname));

/**
 * Produce `src/vs/workbench/contrib/vibeide/browser/react/out/*` bundles required by
 * TypeScript imports from the workbench (not in git; must run before client compile / tsgo).
 */
export const buildVibeideBrowserReactTask = task.define('build-vibeide-browser-react', () => {
	return new Promise<void>((resolve, reject) => {
		const reactDir = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'browser', 'react');
		const buildJs = path.join(reactDir, 'build.js');
		const proc = cp.spawn(process.execPath, [buildJs], {
			cwd: reactDir,
			stdio: 'inherit',
			env: process.env,
		});
		proc.on('error', reject);
		proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`VibeIDE React bundle failed with exit code ${code}`))));
	});
});
