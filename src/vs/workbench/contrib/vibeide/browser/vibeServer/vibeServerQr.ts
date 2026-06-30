/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Renders the LAN URL as a scannable QR code in a small webview (roadmap VS.6). Pure presentation
 * over {@link encodeQrMatrix}; no scripts in the webview (CSP allows only inline style + the SVG).
 */

import { localize } from '../../../../../nls.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ACTIVE_GROUP } from '../../../../services/editor/common/editorService.js';
import { IWebviewWorkbenchService } from '../../../webviewPanel/browser/webviewWorkbenchService.js';
import { encodeQrMatrix } from '../../common/vibeQrEncode.js';
import { IVibeServerService } from './vibeServerService.js';

const MODULE_PX = 8;
const QUIET_MODULES = 4;

function qrSvg(matrix: boolean[][]): string {
	const n = matrix.length;
	const total = (n + QUIET_MODULES * 2) * MODULE_PX;
	const rects: string[] = [];
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (matrix[r][c]) {
				const x = (c + QUIET_MODULES) * MODULE_PX;
				const y = (r + QUIET_MODULES) * MODULE_PX;
				rects.push(`<rect x="${x}" y="${y}" width="${MODULE_PX}" height="${MODULE_PX}" fill="#000"/>`);
			}
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/>${rects.join('')}</svg>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] ?? ch));
}

/** Builds and reveals the QR webview for the running server's LAN URL. */
export async function openLanQr(accessor: ServicesAccessor): Promise<void> {
	const vibeServerService = accessor.get(IVibeServerService);
	const notificationService = accessor.get(INotificationService);
	const webviewWorkbenchService = accessor.get(IWebviewWorkbenchService);

	const lanUrl = await vibeServerService.getLanUrl();
	if (!lanUrl) {
		notificationService.info(localize('vibeServer.qr.unavailable', "Vibe Server не запущен или адрес в сети не определён."));
		return;
	}

	let svg: string;
	try {
		svg = qrSvg(encodeQrMatrix(lanUrl));
	} catch {
		notificationService.info(localize('vibeServer.qr.tooLong', "Адрес слишком длинный для QR — используйте «Адрес для телефона (LAN)»."));
		return;
	}

	const title = localize('vibeServer.qr.title', "Vibe Server — QR");
	const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
	body { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
	.qr { background: #fff; padding: 12px; border-radius: 8px; }
	.hint { font-size: 13px; color: var(--vscode-descriptionForeground); text-align: center; }
	.url { font-size: 13px; word-break: break-all; }
</style></head>
<body>
	<div class="qr">${svg}</div>
	<div class="url">${escapeHtml(lanUrl)}</div>
	<div class="hint">${escapeHtml(localize('vibeServer.qr.scan', "Отсканируйте телефоном в одной сети. Нужен host=0.0.0.0 и доступ через брандмауэр."))}</div>
</body></html>`;

	const input = webviewWorkbenchService.openWebview(
		{
			title,
			options: { retainContextWhenHidden: true },
			contentOptions: { allowScripts: false },
			extension: undefined,
		},
		'vibeide.vibeServerQr',
		title,
		undefined,
		{ group: ACTIVE_GROUP, preserveFocus: false },
	);
	input.webview.setHtml(html);
}
