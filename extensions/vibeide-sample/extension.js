// VibeIDE sample extension — calls one accessor from each VibeIDE proposed namespace
// and surfaces a notification with the result. Acceptance proof for the
// `vibeideReadonly` proposal in src/vscode-dts/vscode.proposed.vibeideReadonly.d.ts.
//
// JS-only sample: we cast through `any` so this file can be loaded without
// any typings shim. TypeScript consumers should add the proposed dts to
// `enabledApiProposals` and access vscode.vibeide directly.
//
// i18n: this file lives under extensions/, so per the L515 split decision
// (references/v1/l10n-vs-nls-decision.md) user-facing strings use
// vscode.l10n.t(). Bundle path is declared in package.json:l10n.

'use strict';

const vscode = require('vscode');

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
	const showCommand = vscode.commands.registerCommand('vibeideSample.show', async () => {
		const vibeide = /** @type {any} */ (vscode).vibeide;
		if (!vibeide) {
			await vscode.window.showWarningMessage(
				vscode.l10n.t('VibeIDE proposed API not present. Run inside VibeIDE 0.3.0 or later, and add "vibeideReadonly" to enabledApiProposals in your manifest.'),
			);
			return;
		}

		try {
			const status = await vibeide.agent.status();
			const skills = await vibeide.skills.list();
			const folder = vscode.workspace.workspaceFolders?.[0];
			const target = folder ? folder.uri.fsPath : '';
			const allowed = target
				? await vibeide.constraints.queryAllowed({ tool: 'write', target })
				: null;

			const lines = [
				vscode.l10n.t('Mode: {0}', status.mode),
				vscode.l10n.t('Running: {0}', String(status.running)),
				vscode.l10n.t('Skills: {0}', String(skills.length)),
				vscode.l10n.t('Edit allowed at workspace root: {0}', allowed === null ? vscode.l10n.t('no workspace') : allowed ? vscode.l10n.t('yes') : vscode.l10n.t('no')),
			];
			await vscode.window.showInformationMessage(lines.join(' · '));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await vscode.window.showErrorMessage(vscode.l10n.t('VibeIDE sample: {0}', message));
		}
	});

	const planSub = (() => {
		const vibeide = /** @type {any} */ (vscode).vibeide;
		if (!vibeide || !vibeide.plans) {
			return { dispose() { } };
		}
		try {
			return vibeide.plans.subscribeToEvents((evt) => {
				console.log('[vibeide-sample] plan event:', evt.type, evt.planId);
			});
		} catch {
			return { dispose() { } };
		}
	})();

	context.subscriptions.push(showCommand, planSub);
}

function deactivate() { /* no-op */ }

module.exports = { activate, deactivate };
