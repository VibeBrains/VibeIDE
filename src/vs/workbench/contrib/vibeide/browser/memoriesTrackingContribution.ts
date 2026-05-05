/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IMemoriesService } from '../common/memoriesService.js';
import { URI } from '../../../../base/common/uri.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';

/**
 * Tracks file opens and adds them to memories as recent files
 */
export class MemoriesTrackingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.memoriesTracking';

	private readonly _trackFileOpenScheduler: RunOnceScheduler;
	private _lastTrackedUri: URI | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IMemoriesService private readonly memoriesService: IMemoriesService,
	) {
		super();

		// Debounce file tracking to avoid excessive writes (500ms delay)
		this._trackFileOpenScheduler = this._register(new RunOnceScheduler(
			() => this._trackFileOpen(),
			500
		));

		// Track when files are opened
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const activeEditor = this.editorService.activeEditor;
			if (activeEditor?.resource && activeEditor.resource.scheme === 'file') {
				this._lastTrackedUri = activeEditor.resource;
				this._trackFileOpenScheduler.schedule();
			}
		}));
	}

	private async _trackFileOpen(): Promise<void> {
		if (!this.memoriesService.isEnabled()) {
			return;
		}

		if (!this._lastTrackedUri) {
			return;
		}

		try {
			const uri = this._lastTrackedUri;
			const workspace = this.editorService.activeEditor?.resource;

			// Only track files in workspace (not external files)
			if (workspace && uri.scheme === 'file') {
				const fileName = uri.path.split('/').pop() || uri.path;
				await this.memoriesService.addMemory(
					'recentFile',
					uri.fsPath,
					`Recently accessed: ${fileName}`,
					[fileName, uri.path.split('/').slice(-2).join('/')], // Tags: filename and parent dir
					uri
				);
			}
		} catch (error) {
			// Silently fail - memories tracking is non-critical
			console.debug('[MemoriesTracking] Failed to track file:', error);
		}
	}
}

registerWorkbenchContribution2(MemoriesTrackingContribution.ID, MemoriesTrackingContribution, WorkbenchPhase.AfterRestored);

