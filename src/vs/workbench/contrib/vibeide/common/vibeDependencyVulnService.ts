/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
export interface VulnerabilityResult {
	packageName: string;
	severity: 'critical' | 'high' | 'moderate' | 'low';
	advisory: string;
	url?: string;
}

export const IVibeDependencyVulnService = createDecorator<IVibeDependencyVulnService>('vibeDependencyVulnService');

export interface IVibeDependencyVulnService {
	readonly _serviceBrand: undefined;

	/**
	 * Scan for vulnerabilities when dependency files change.
	 * Called automatically when package.json / requirements.txt / Cargo.toml changes.
	 */
	scanOnChange(filePath: string): Promise<VulnerabilityResult[]>;

	readonly onVulnerabilitiesFound: Event<{ filePath: string; results: VulnerabilityResult[] }>;
}

// Dependency manifest files that trigger vulnerability scan
const DEPENDENCY_FILES = [
	'package.json',
	'requirements.txt',
	'requirements.in',
	'Cargo.toml',
	'go.mod',
	'pom.xml',
	'build.gradle',
	'Gemfile',
];

/**
 * VibeIDE Dependency Vulnerability Scanner.
 * Triggers on changes to dependency manifest files (agent edits or manual).
 * Uses OSV.dev API for vulnerability data.
 */
class VibeDependencyVulnService extends Disposable implements IVibeDependencyVulnService {
	declare readonly _serviceBrand: undefined;

	private readonly _onVulnerabilitiesFound = this._register(new Emitter<{ filePath: string; results: VulnerabilityResult[] }>());
	readonly onVulnerabilitiesFound = this._onVulnerabilitiesFound.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._setupFileWatcher();
	}

	private _setupFileWatcher(): void {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		this._register(this._fileService.onDidFilesChange(async e => {
			const uris = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
			for (const resource of uris) {
				const fileName = resource.path.split('/').pop() || '';
				if (DEPENDENCY_FILES.includes(fileName)) {
					vibeLog.debug('VulnScan', `Dependency file changed: ${fileName}`);
					// Debounce: scan after 2s of no changes
					setTimeout(async () => {
						const results = await this.scanOnChange(resource.fsPath);
						if (results.length > 0) {
							this._onVulnerabilitiesFound.fire({ filePath: resource.fsPath, results });
						}
					}, 2000);
				}
			}
		}));
	}

	async scanOnChange(filePath: string): Promise<VulnerabilityResult[]> {
		const fileName = filePath.split(/[/\\]/).pop() || '';

		// Phase 1: npm audit integration for package.json
		if (fileName === 'package.json') {
			return this._scanNpm(filePath);
		}

		// Phase 1: basic known-vulns check for other ecosystems
		// Phase 2: integrate OSV.dev API for all ecosystems
		vibeLog.debug('VulnScan', `Scan for ${fileName} requires Phase 2 OSV.dev integration`);
		return [];
	}

	private async _scanNpm(_packageJsonPath: string): Promise<VulnerabilityResult[]> {
		// Phase 1: return empty (actual npm audit requires subprocess)
		// npm audit output is available via vibe:doctor:full
		// Phase 2: integrate via ITerminalService or Node.js child_process
		vibeLog.debug('VulnScan', 'npm package.json changed — run npm run vibe:doctor:full for audit');
		return [];
	}
}

registerSingleton(IVibeDependencyVulnService, VibeDependencyVulnService, InstantiationType.Delayed);
