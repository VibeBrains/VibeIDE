/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { VIBE_DEFAULT_SCHEME, vibeDefaultContent } from '../common/vibeDefaults.js';

/**
 * Serves the release's version of a `.vibe/` default file under the read-only `vibe-default:` scheme,
 * so «Показать различия» can hand a real URI to the stock diff editor. The alternative — auto-merging
 * arbitrary markdown/JSON — is guesswork that silently eats user edits; a diff lets the user merge.
 *
 * `vibe-default:/skills/foo/SKILL.md` ⇄ manifest path `skills/foo/SKILL.md`.
 */
export class VibeDefaultsContentProvider extends Disposable implements ITextModelContentProvider, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeDefaultsContent';

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(VIBE_DEFAULT_SCHEME, this));
	}

	/** Manifest path for a `vibe-default:` URI (leading slash dropped). */
	static toResource(path: string): URI {
		return URI.from({ scheme: VIBE_DEFAULT_SCHEME, path: `/${path}` });
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this._modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const contents = vibeDefaultContent(resource.path.replace(/^\//, ''));
		if (contents === undefined) {
			return null; // not a file this release ships — let the resolver fail loudly
		}
		// Language by filename so the diff is highlighted like the real file (md/json/py/…).
		return this._modelService.createModel(contents, this._languageService.createByFilepathOrFirstLine(resource), resource);
	}
}

// AfterRestored: nothing resolves a `vibe-default:` URI until the user opens a diff, so this must not
// block startup — but it must be live before any «Показать различия» click can land.
registerWorkbenchContribution2(VibeDefaultsContentProvider.ID, VibeDefaultsContentProvider, WorkbenchPhase.AfterRestored);
