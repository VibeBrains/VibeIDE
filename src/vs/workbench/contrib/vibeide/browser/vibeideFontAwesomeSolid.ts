/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Font Awesome 6 Free Solid (single shared webfont). Vendor files under browser/media/fonts/.
 * @see FONTAWESOME-LICENSE.txt next to fa-solid-900.woff2
 */

import { ThemeIcon } from '../../../../base/common/themables.js';
import { FileAccess } from '../../../../base/common/network.js';
import { registerIcon, getIconRegistry } from '../../../../platform/theme/common/iconRegistry.js';

export const vibeideFontAwesomeSolidFontId = 'vibeide-fontawesome-solid-900';

/** Registers FA Solid once; repeated calls return the same definition (icon registry dedupes by id). */
export function vibeideFontAwesomeSolidDefinition() {
	return getIconRegistry().registerIconFont(vibeideFontAwesomeSolidFontId, {
		weight: '900',
		src: [{
			location: FileAccess.asBrowserUri('vs/workbench/contrib/vibeide/browser/media/fonts/fa-solid-900.woff2'),
			format: 'woff2'
		}]
	});
}

/** Register a themable icon backed by the vendored FA Solid face (`glyph` = single BMP private-use char). */
export function registerVibeideFaSolidIcon(id: string, glyph: string, description: string): ThemeIcon {
	const definition = vibeideFontAwesomeSolidDefinition();
	return registerIcon(id, {
		fontCharacter: glyph,
		font: {
			id: vibeideFontAwesomeSolidFontId,
			definition
		}
	}, description);
}
