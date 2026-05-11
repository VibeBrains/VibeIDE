/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE contributors. MIT License.
 *  Built-in extension: custom editor chrome for .vibe/plans/*.plan.md (readonly dashboard + raw MD).
 *
 *  i18n: this file lives under extensions/, so per the L515 split decision
 *  (references/v1/l10n-vs-nls-decision.md) user-facing strings use
 *  vscode.l10n.t(). Bundle path is declared in package.json:l10n.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const path = require('path');

const VIEW_TYPE = 'vibeide.planDashboard';

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	const provider = new PlanDashboardProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
			supportsMultipleEditorsPerDocument: false,
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('vibeide.planDashboard.openAsText', async (uri) => {
			const target = uri instanceof vscode.Uri ? uri : getActivePlanResourceUri();
			if (!target) {
				vscode.window.showWarningMessage(vscode.l10n.t('Open a .plan.md tab first.'));
				return;
			}
			await vscode.commands.executeCommand('vscode.openWith', target, 'default', vscode.ViewColumn.Active);
		}),
	);
}

function deactivate() { }

/**
 * @returns {vscode.Uri | undefined}
 */
function getActivePlanResourceUri() {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	const input = tab?.input;
	if (input && typeof input === 'object' && 'uri' in input) {
		const u = /** @type {{ uri?: vscode.Uri }} */ (input).uri;
		if (u && u.scheme === 'file' && u.fsPath.endsWith('.plan.md')) {
			return u;
		}
	}
	return undefined;
}

class PlanDashboardProvider {
	/** @param {vscode.Uri} extensionUri */
	constructor(extensionUri) {
		this.extensionUri = extensionUri;
	}

	/**
	 * @param {vscode.Uri} uri
	 * @param {vscode.CustomDocumentOpenContext} _openContext
	 * @param {vscode.CancellationToken} _token
	 * @returns {Promise<{ uri: vscode.Uri, dispose: () => void }>}
	 */
	async openCustomDocument(uri, _openContext, _token) {
		return { uri, dispose: () => { } };
	}

	/**
	 * @param {{ uri: vscode.Uri }} document
	 * @param {vscode.WebviewPanel} webviewPanel
	 * @param {vscode.CancellationToken} _token
	 */
	async resolveCustomEditor(document, webviewPanel, _token) {
		const uri = document.uri;
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		const refresh = async () => {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder('utf-8').decode(bytes);
			const fm = parseFrontmatter(text);
			const machine = parseMachineJson(text);
			const planIdEarly = machine?.planId || fm.planId || '';
			let bindingSnap = { count: 0, threadIds: /** @type {string[]} */ ([]) };
			if (planIdEarly) {
				try {
					const snap = await vscode.commands.executeCommand('vibeide.plans.bindingSnapshot', planIdEarly);
					if (snap && typeof snap.count === 'number') {
						bindingSnap = { count: snap.count, threadIds: snap.threadIds || [] };
					}
				} catch {
					/* extension command missing outside full product */
				}
			}
			webviewPanel.webview.html = buildDashboardHtml(webviewPanel.webview.cspSource, text, uri, bindingSnap);
		};

		await refresh();

		const sub = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
			if (msg?.type === 'openRaw') {
				await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Active);
			}
			if (msg?.type === 'refresh') {
				await refresh();
			}
			if (msg?.type === 'continueHint') {
				await vscode.window.showInformationMessage(
					vscode.l10n.t('Continue execution from Agent chat (startup notification «Continue Plan» or Execute in Agent from Plan mode).'),
				);
			}
			if (msg?.type === 'explainRisk') {
				await vscode.commands.executeCommand('vibeide.plans.explainRisk', uri);
			}
		});

		const folderUri = vscode.Uri.file(path.dirname(uri.fsPath));
		const base = path.basename(uri.fsPath);
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folderUri, base));
		watcher.onDidChange(() => void refresh());
		watcher.onDidCreate(() => void refresh());

		webviewPanel.onDidDispose(() => {
			sub.dispose();
			watcher.dispose();
		});
	}
}

/**
 * @param {string} text
 */
function parseFrontmatter(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) {
		return { planId: '', status: '', raw: '' };
	}
	const fm = m[1];
	const pick = (key) => {
		const r = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm);
		return r ? r[1].trim().replace(/^["']|["']$/g, '') : '';
	};
	return {
		planId: pick('planId'),
		status: pick('status'),
		raw: fm,
	};
}

/**
 * @param {string} text
 */
function parseMachineJson(text) {
	const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
	if (!jsonMatch) {
		return null;
	}
	try {
		const obj = JSON.parse(jsonMatch[1]);
		if (obj && obj.planKind === 'vibeide.agent-plan') {
			return obj;
		}
	} catch {
		return null;
	}
	return null;
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * @param {string} cspSource
 * @param {string} text
 * @param {vscode.Uri} uri
 * @param {{ count: number; threadIds: string[] }} bindingSnap
 */
function buildDashboardHtml(cspSource, text, uri, bindingSnap) {
	const fm = parseFrontmatter(text);
	const machine = parseMachineJson(text);
	const status = machine?.status || fm.status || 'draft';
	const planId = machine?.planId || fm.planId || '(unknown)';
	const boundThread = machine?.boundThreadId ? String(machine.boundThreadId) : '';
	const steps = Array.isArray(machine?.steps) ? machine.steps : [];

	let activeModelLine = '';
	const aml = fm.raw.match(/^[ \t]*#[ \t]*activeModel:\s*(.+)$/m);
	if (aml) {
		activeModelLine = aml[1].trim();
	}

	const stepRows = steps.length
		? steps
			.map((s) => {
				const n = s.stepNumber ?? '?';
				const d = escapeHtml(s.description ?? '');
				const stRaw = String(s.status ?? '');
				const st = escapeHtml(stRaw);
				const chk =
					stRaw === 'done' ? '✓' : stRaw === 'skipped' ? '⊘' : stRaw === 'error' ? '✗' : stRaw === 'paused' ? '⏸' : '○';
				const ariaStep = escapeHtml(vscode.l10n.t('Step {0}, {1}: {2}', String(n), stRaw, (s.description ?? '').slice(0, 300)));
				return `<li role="listitem" aria-label="${ariaStep}"><span class="chk" aria-hidden="true">${chk}</span> <strong>#${escapeHtml(String(n))}</strong> — ${d} <span class="st">${st}</span></li>`;
			})
			.join('')
		: `<li class="muted" role="listitem">${escapeHtml(vscode.l10n.t('(No machine steps JSON yet — manual template or legacy plan.)'))}</li>`;

	const nonce = String(Date.now());

	const boundSessions = typeof bindingSnap?.count === 'number' ? bindingSnap.count : 0;

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>VibeIDE Plan</title>
	<style>
		body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 16px; margin: 0; }
		h1 { font-size: 15px; margin: 0 0 8px 0; }
		.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; text-transform: uppercase; }
		.meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 8px 0 16px; word-break: break-all; }
		ul { list-style: none; padding: 0; margin: 0; }
		li { padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border); }
		li.muted { color: var(--vscode-descriptionForeground); border: none; }
		.chk { display: inline-block; width: 1.2em; }
		.st { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 6px; }
		.row { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
		button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; font-family: inherit; }
		button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
		.model { font-size: 12px; margin-top: 12px; color: var(--vscode-descriptionForeground); }
		.session-warn { color: var(--vscode-editorWarning-foreground); font-weight: 600; }
	</style>
</head>
<body>
	<main role="main" aria-labelledby="plan-dash-h1">
	<h1 id="plan-dash-h1">${escapeHtml(vscode.l10n.t('Plan dashboard'))}</h1>
	<div><span class="badge">${escapeHtml(status)}</span></div>
	<div class="meta">planId: ${escapeHtml(planId)}${boundThread ? ` · boundThreadId: ${escapeHtml(boundThread)}` : ''}<br/>
	<span class="${boundSessions > 1 ? 'session-warn' : ''}">${escapeHtml(vscode.l10n.t('Referenced by {0} agent session(s)', String(boundSessions)))}</span>${boundSessions > 1 ? escapeHtml(vscode.l10n.t(' — multiple executors risk step drift.')) : ''}<br/>${escapeHtml(uri.fsPath)}</div>
	<h2 id="plan-steps-heading" style="font-size:13px;margin:16px 0 8px">${escapeHtml(vscode.l10n.t('Steps'))}</h2>
	<ul role="list" aria-labelledby="plan-steps-heading">${stepRows}</ul>
	${activeModelLine ? `<div class="model"><strong>activeModel</strong> ${escapeHtml(vscode.l10n.t('(frontmatter comment): {0}', activeModelLine))}</div>` : `<div class="model muted">${vscode.l10n.t('Model routing: set <code># activeModel: …</code> in YAML frontmatter (see template).')}</div>`}
	<div class="row">
		<button type="button" id="raw" aria-label="${escapeHtml(vscode.l10n.t('Open raw Markdown for this plan'))}">${escapeHtml(vscode.l10n.t('Open raw Markdown'))}</button>
		<button type="button" id="cont" class="secondary" aria-label="${escapeHtml(vscode.l10n.t('Continue or run plan from agent chat'))}">${escapeHtml(vscode.l10n.t('Continue / Run…'))}</button>
		<button type="button" id="risk" class="secondary" aria-label="${escapeHtml(vscode.l10n.t('Explain risk for this plan'))}">${escapeHtml(vscode.l10n.t('Explain risk'))}</button>
		<button type="button" id="reload" class="secondary" aria-label="${escapeHtml(vscode.l10n.t('Reload plan from disk'))}">${escapeHtml(vscode.l10n.t('Reload'))}</button>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('raw').onclick = () => vscode.postMessage({ type: 'openRaw' });
		document.getElementById('cont').onclick = () => vscode.postMessage({ type: 'continueHint' });
		document.getElementById('risk').onclick = () => vscode.postMessage({ type: 'explainRisk' });
		document.getElementById('reload').onclick = () => vscode.postMessage({ type: 'refresh' });
	</script>
	</main>
</body>
</html>`;
}

module.exports = { activate, deactivate };
