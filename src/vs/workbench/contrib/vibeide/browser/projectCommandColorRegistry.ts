/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getColorRegistry } from '../../../../platform/theme/common/colorUtils.js';
import { resolveProjectCommandColorId } from '../common/projectCommandColor.js';

let knownIds: Set<string> | undefined;

/**
 * Colour ids registered by the workbench. Built once on first use: the registry
 * is populated by module side effects at startup and does not shrink, and both
 * command surfaces re-render on every commands change.
 */
function isRegisteredColorId(id: string): boolean {
	if (!knownIds) {
		knownIds = new Set(getColorRegistry().getColors().map(c => c.id));
	}
	return knownIds.has(id);
}

/** Theme colour id declared by a project command, or `undefined` if unusable. */
export function projectCommandColorId(color: string | undefined): string | undefined {
	return resolveProjectCommandColorId(color, isRegisteredColorId);
}
