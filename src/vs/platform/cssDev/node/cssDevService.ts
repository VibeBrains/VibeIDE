/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { join } from '../../../base/common/path.js';
import { relative } from '../../../base/common/path.js';
import { FileAccess } from '../../../base/common/network.js';
import { StopWatch } from '../../../base/common/stopwatch.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';

export const ICSSDevelopmentService = createDecorator<ICSSDevelopmentService>('ICSSDevelopmentService');

export interface ICSSDevelopmentService {
	_serviceBrand: undefined;
	isEnabled: boolean;
	getCssModules(): Promise<string[]>;
}

export class CSSDevelopmentService implements ICSSDevelopmentService {

	declare _serviceBrand: undefined;

	private _cssModules?: Promise<string[]>;

	constructor(
		@IEnvironmentService private readonly envService: IEnvironmentService,
		@ILogService private readonly logService: ILogService
	) { }

	get isEnabled(): boolean {
		return !this.envService.isBuilt;
	}

	getCssModules(): Promise<string[]> {
		this._cssModules ??= this.computeCssModules();
		return this._cssModules;
	}

	private async computeCssModules(): Promise<string[]> {
		if (!this.isEnabled) {
			return [];
		}

		const sw = StopWatch.create();

		// _VSCODE_FILE_ROOT = import.meta.dirname of bootstrap-esm.js which lives in out/,
		// so FileAccess.asFileUri('').fsPath already resolves to the out/ directory.
		// Do NOT append 'out' again -- that would produce the non-existent out/out/vs path.
		const outDir = FileAccess.asFileUri('').fsPath;
		const outVs = join(outDir, 'vs');

		if (!existsSync(outVs)) {
			this.logService.warn('[CSS_DEV] out/vs not found -- run full compile (gulp copies CSS next to JS).');
			return [];
		}

		// Use Node.js fs/promises instead of @vscode/ripgrep -- avoids binary availability
		// issues on Windows where rg.exe may not be present after npm install.
		try {
			const { readdir } = await import('fs/promises');
			const results: string[] = [];

			const walk = async (dir: string): Promise<void> => {
				const entries = await readdir(dir, { withFileTypes: true });
				await Promise.all(entries.map(async entry => {
					const fullPath = join(dir, entry.name);
					if (entry.isDirectory()) {
						await walk(fullPath);
					} else if (entry.name.endsWith('.css')) {
						const rel = relative(outDir, fullPath).replace(/\\/g, '/');
						if (rel.startsWith('vs/')) {
							results.push(rel);
						}
					}
				}));
			};

			await walk(outVs);
			results.sort();
			this.logService.info('[CSS_DEV] DONE, ' + results.length + ' css modules (' + Math.round(sw.elapsed()) + 'ms)');
			return results;
		} catch (err) {
			this.logService.error('[CSS_DEV] FAILED to compute CSS data', err);
			return [];
		}
	}
}
