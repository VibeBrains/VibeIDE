/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { badgeBackground, badgeForeground, contrastBorder, darken, descriptionForeground, editorBackground, editorWarningForeground, focusBorder, foreground, lighten, registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';

// Colour tokens of the chat message layout
// media/vibeChatMessages.css reads them as `--vscode-vibeide-chat-<name>`
// Every default is a reference to a stock token, so a theme that knows nothing about these still gets a sensible result
// A theme whose `focusBorder` is deliberately dim (all Vibe themes) sets the bubble tokens itself
// Otherwise the bubble would be invisible

export const VIBEIDE_CHAT_USER_MESSAGE_BACKGROUND = registerColor(
	'vibeide.chat.userMessageBackground',
	{ dark: transparent(focusBorder, 0.12), light: transparent(focusBorder, 0.12), hcDark: null, hcLight: null },
	localize('vibeide.chat.userMessageBackground', 'Цвет фона сообщения пользователя в чате VibeIDE.')
);

export const VIBEIDE_CHAT_USER_MESSAGE_BORDER = registerColor(
	'vibeide.chat.userMessageBorder',
	{ dark: transparent(focusBorder, 0.55), light: transparent(focusBorder, 0.55), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('vibeide.chat.userMessageBorder', 'Цвет рамки сообщения пользователя в чате VibeIDE. В самой узкой панели это цвет полосы слева.')
);

// The label sits on the tinted bubble, not on the plain panel that `descriptionForeground` is tuned for
// Over the bubble the stock value drops under 4.5:1 in light themes that leave it unset (Light+, Solarized Light, Quiet Light)
// It does the same in some dark ones (Tomorrow Night Blue in an editor tab)
// So the default moves away from the bubble: lighter on dark, darker on light
// High contrast themes have no bubble fill, so their stock value stays
export const VIBEIDE_CHAT_USER_MESSAGE_LABEL = registerColor(
	'vibeide.chat.userMessageLabel',
	{ dark: lighten(descriptionForeground, 0.1), light: darken(descriptionForeground, 0.2), hcDark: descriptionForeground, hcLight: descriptionForeground },
	localize('vibeide.chat.userMessageLabel', 'Цвет подписи сообщения пользователя в чате VibeIDE: время и подпись «Вы».')
);

// The rule is the text colour at low strength, not `panel.border` or `widget.border`
// Those are quiet dividers by design
// `panel.border` of Light 2026 is #F0F1F2 on #FAFAFD, `widget.border` is unset in the stock dark and light themes
export const VIBEIDE_CHAT_ASSISTANT_RULE = registerColor(
	'vibeide.chat.assistantRule',
	{ dark: transparent(foreground, 0.25), light: transparent(foreground, 0.25), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('vibeide.chat.assistantRule', 'Цвет линии слева от ответа ассистента в чате VibeIDE.')
);

// The journal button in the header of the chat (media/vibeChatJournal.css)
// The badge counts the unread entries and turns to the warning colour while one of them is a warning
// Every default is a stock token, so the Vibe themes need no entry of their own: their badge and warning colours are already set

export const VIBEIDE_CHAT_JOURNAL_BADGE_BACKGROUND = registerColor(
	'vibeide.chat.journalBadgeBackground',
	{ dark: badgeBackground, light: badgeBackground, hcDark: badgeBackground, hcLight: badgeBackground },
	localize('vibeide.chat.journalBadgeBackground', 'Цвет фона счётчика непрочитанных записей на значке «Журнал» в шапке чата VibeIDE.')
);

export const VIBEIDE_CHAT_JOURNAL_BADGE_FOREGROUND = registerColor(
	'vibeide.chat.journalBadgeForeground',
	{ dark: badgeForeground, light: badgeForeground, hcDark: badgeForeground, hcLight: badgeForeground },
	localize('vibeide.chat.journalBadgeForeground', 'Цвет цифры в счётчике непрочитанных записей на значке «Журнал» в шапке чата VibeIDE.')
);

export const VIBEIDE_CHAT_JOURNAL_WARNING = registerColor(
	'vibeide.chat.journalWarning',
	{ dark: editorWarningForeground, light: editorWarningForeground, hcDark: editorWarningForeground, hcLight: editorWarningForeground },
	localize('vibeide.chat.journalWarning', 'Цвет предупреждения в журнале чата VibeIDE: фон счётчика, пока среди непрочитанных есть предупреждение, и значок предупреждения в записи.')
);

export const VIBEIDE_CHAT_JOURNAL_WARNING_FOREGROUND = registerColor(
	'vibeide.chat.journalWarningForeground',
	{ dark: editorBackground, light: editorBackground, hcDark: editorBackground, hcLight: editorBackground },
	localize('vibeide.chat.journalWarningForeground', 'Цвет цифры на счётчике цвета предупреждения (vibeide.chat.journalWarning) на значке «Журнал» в шапке чата VibeIDE.')
);
