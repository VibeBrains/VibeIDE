/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The text-slop detector as the product uses it: the catalogue shipped in the build, with the project's
 * `.vibe/slop.json` applied.
 *
 * The project file is read on every check, so an edit applies from the next check and nothing has to watch it.
 * Depends on platform services only: `ToolsService` injects it, and a Vibe service here would reopen the
 * dependency cycle the design-context service warns about.
 */

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { SLOP_CATALOG_JSONC } from '../slopCatalog.generated.js';
import { applySlopOverrides, compileSlopCatalog, CompiledSlopCatalog, lexicalSlopCatalog, parseSlopCatalog, parseSlopOverrides } from './slopCatalog.js';
import { analyzeTextSlop, SlopReport } from './textSlop.js';

/** The project's overrides inside the workspace folder. */
export const SLOP_PROJECT_FILE = '.vibe/slop.json';

/** A catalogue as a project sees it, with whatever went wrong reading it said out loud. */
export interface ProjectSlopCatalog {
	/** Undefined when the build carries no catalogue that parses — callers say so rather than pass silently. */
	readonly catalog: CompiledSlopCatalog | undefined;
	readonly warnings: readonly string[];
}

export interface TextSlopCheck {
	readonly report: SlopReport;
	readonly warnings: readonly string[];
}

export const IVibeTextSlopService = createDecorator<IVibeTextSlopService>('vibeTextSlopService');

export interface IVibeTextSlopService {
	readonly _serviceBrand: undefined;
	/** The catalogue with the `.vibe/slop.json` of `folder` (or of the first workspace folder) applied. */
	projectCatalog(folder?: URI): Promise<ProjectSlopCatalog>;
	/** Only the list and template rules — what one line of a page can be judged by. */
	pageCatalog(folder?: URI): Promise<CompiledSlopCatalog | undefined>;
	/** A text checked against the project's catalogue, any line endings; undefined when the build carries none. */
	check(text: string, folder?: URI): Promise<TextSlopCheck | undefined>;
}

export class VibeTextSlopService implements IVibeTextSlopService {
	declare readonly _serviceBrand: undefined;

	private _builtIn: ProjectSlopCatalog | undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) { }

	/** The shipped catalogue, parsed and compiled once: it is the same for every project and every check. */
	private _shipped(): ProjectSlopCatalog {
		if (!this._builtIn) {
			const warnings: string[] = [];
			const parsed = parseSlopCatalog(SLOP_CATALOG_JSONC, warning => warnings.push(warning));
			this._builtIn = { catalog: parsed ? compileSlopCatalog(parsed, warning => warnings.push(warning)) : undefined, warnings };
		}
		return this._builtIn;
	}

	async projectCatalog(folder?: URI): Promise<ProjectSlopCatalog> {
		const shipped = this._shipped();
		const root = folder ?? this._workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!shipped.catalog || !root) {
			return shipped;
		}
		const file = joinPath(root, ...SLOP_PROJECT_FILE.split('/'));
		let text: string;
		try {
			if (!await this._fileService.exists(file)) {
				return shipped;
			}
			text = (await this._fileService.readFile(file)).value.toString();
		} catch (error) {
			return { catalog: shipped.catalog, warnings: [...shipped.warnings, `${SLOP_PROJECT_FILE}: ${error instanceof Error ? error.message : String(error)}`] };
		}
		const warnings = [...shipped.warnings];
		const overrides = parseSlopOverrides(text, warning => warnings.push(warning));
		return { catalog: applySlopOverrides(overrides, shipped.catalog, warning => warnings.push(warning)), warnings };
	}

	async pageCatalog(folder?: URI): Promise<CompiledSlopCatalog | undefined> {
		const { catalog } = await this.projectCatalog(folder);
		return catalog ? lexicalSlopCatalog(catalog) : undefined;
	}

	async check(text: string, folder?: URI): Promise<TextSlopCheck | undefined> {
		const { catalog, warnings } = await this.projectCatalog(folder);
		return catalog ? { report: analyzeTextSlop(text, catalog), warnings } : undefined;
	}
}

registerSingleton(IVibeTextSlopService, VibeTextSlopService, InstantiationType.Delayed);
