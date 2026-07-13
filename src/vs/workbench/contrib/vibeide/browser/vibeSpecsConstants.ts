/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export const VIBE_SPECS_VIEWLET_ID = 'workbench.view.vibeSpecs';
export const VIBE_SPECS_VIEW_ID = 'workbench.view.vibeSpecs.list';

/** Workspace-relative folder that holds spec-driven feature docs (<root>/<id>/PRODUCT.md, TECH.md). */
export const VIBE_SPECS_ROOT_SETTING = 'vibeide.specsPanel.root';
export const VIBE_SPECS_ROOT_DEFAULT = 'docs/specs';
export const VIBE_SPECS_PRODUCT_FILE = 'PRODUCT.md';
export const VIBE_SPECS_TECH_FILE = 'TECH.md';

export const enum VibeSpecsCommands {
	refresh = 'vibeide.vibeSpecs.refresh',
	newSpec = 'vibeide.vibeSpecs.newSpec',
	specFromTask = 'vibeide.vibeSpecs.specFromTask',
	implementSpec = 'vibeide.vibeSpecs.implementSpec',
}
