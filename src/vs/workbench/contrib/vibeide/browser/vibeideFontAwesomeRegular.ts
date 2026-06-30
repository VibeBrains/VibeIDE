/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Font Awesome 6 Free Regular (single shared webfont). Vendor files under browser/media/fonts/.
 * @see FONTAWESOME-LICENSE.txt next to fa-regular-400.woff2
 */

import { ThemeIcon } from '../../../../base/common/themables.js';
import { FileAccess } from '../../../../base/common/network.js';
import { registerIcon, getIconRegistry } from '../../../../platform/theme/common/iconRegistry.js';

export const vibeideFontAwesomeRegularFontId = 'vibeide-fontawesome-regular-400';

/** Registers FA Regular once; repeated calls return the same definition (icon registry dedupes by id). */
export function vibeideFontAwesomeRegularDefinition() {
	return getIconRegistry().registerIconFont(vibeideFontAwesomeRegularFontId, {
		weight: '400',
		src: [{
			location: FileAccess.asBrowserUri('vs/workbench/contrib/vibeide/browser/media/fonts/fa-regular-400.woff2'),
			format: 'woff2'
		}]
	});
}

/** Register a themable icon backed by the vendored FA Regular face (`glyph` = single BMP private-use char). */
export function registerVibeideFaRegularIcon(id: string, glyph: string, description: string): ThemeIcon {
	const definition = vibeideFontAwesomeRegularDefinition();
	return registerIcon(id, {
		fontCharacter: glyph,
		font: {
			id: vibeideFontAwesomeRegularFontId,
			definition
		}
	}, description);
}
