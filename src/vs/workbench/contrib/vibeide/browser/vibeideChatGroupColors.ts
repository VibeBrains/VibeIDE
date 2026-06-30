/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { localize } from '../../../../nls.js';

// Registers theme-aware color tokens for the VibeIDE chat editor group marker.
// VS Code exposes each token as --vscode-<id-with-dots-as-dashes> CSS custom property,
// so vibe-neon.css can reference them without hardcoding hex values.

export const VIBEIDE_CHAT_GROUP_ACTIVE_BORDER = registerColor(
	'vibeide.chatGroup.activeBorder',
	{ dark: '#fc28a8', light: '#9900cc', hcDark: '#ffffff', hcLight: '#000000' },
	localize('vibeide.chatGroup.activeBorder', 'Цвет рамки, маркирующей группу редакторов чата VibeIDE.')
);

export const VIBEIDE_CHAT_GROUP_TABS_BACKGROUND = registerColor(
	'vibeide.chatGroup.tabsBackground',
	{ dark: '#1d0e30', light: '#f5eeff', hcDark: null, hcLight: null },
	localize('vibeide.chatGroup.tabsBackground', 'Цвет фона заголовков вкладок группы редакторов чата VibeIDE.')
);

export const VIBEIDE_CHAT_GROUP_GLOW_COLOR = registerColor(
	'vibeide.chatGroup.glowColor',
	{ dark: '#fc28a833', light: '#9900cc22', hcDark: null, hcLight: null },
	localize('vibeide.chatGroup.glowColor', 'Цвет неонового свечения рамки группы редакторов чата VibeIDE (только для неоновых тем).')
);
