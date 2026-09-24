/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skips a suite when it runs in the Electron renderer
 *
 * `scripts/test.sh` — the runner CI uses — loads `test/node/**` into a renderer too
 * A suite that needs Node for real (undici internals, a package subpath the renderer cannot resolve, a script
 * outside `out/`) fails there, and a static import of such a module fails at load and takes the whole run down
 * Call it first in `suiteSetup` and import the Node-only modules dynamically after it; `npm run test-node` runs them
 */
export function skipInElectronRenderer(context: Mocha.Context): void {
	const proc = (globalThis as { process?: { type?: string } }).process;
	if (proc?.type === 'renderer') {
		context.skip();
	}
}
