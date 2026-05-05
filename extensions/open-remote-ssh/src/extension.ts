/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Register command: openremotessh.openEmptyWindow
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.openEmptyWindow', async () => {
			// This command should open a new window to connect to a host
			// For now, we'll just show a message or trigger the connection flow
			const host = await vscode.window.showInputBox({
				prompt: 'Enter SSH host to connect to',
				placeHolder: 'user@hostname'
			});
			if (host) {
				await vscode.commands.executeCommand('workbench.action.remote.showQuickPick');
			}
		})
	);

	// Register command: openremotessh.openEmptyWindowInCurrentWindow
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.openEmptyWindowInCurrentWindow', async () => {
			const host = await vscode.window.showInputBox({
				prompt: 'Enter SSH host to connect to',
				placeHolder: 'user@hostname'
			});
			if (host) {
				await vscode.commands.executeCommand('workbench.action.remote.showQuickPick');
			}
		})
	);

	// Register command: openremotessh.openConfigFile
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.openConfigFile', async () => {
			await openSSHConfigFile();
		})
	);

	// Register command: openremotessh.showLog
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.showLog', async () => {
			// Show the output channel for SSH logs
			const outputChannel = vscode.window.createOutputChannel('Remote - SSH');
			outputChannel.show();
		})
	);

	// Register command: openremotessh.explorer.add
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.add', async () => {
			// Add new SSH host - open the config file
			await openSSHConfigFile();
		})
	);

	// Register command: openremotessh.explorer.configure
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.configure', async () => {
			// Configure SSH - open the config file
			await openSSHConfigFile();
		})
	);

	// Register command: openremotessh.explorer.refresh
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.refresh', async () => {
			// Refresh the SSH hosts view
			await vscode.commands.executeCommand('workbench.views.remote.refresh');
		})
	);

	// Register command: openremotessh.explorer.emptyWindowInNewWindow
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.emptyWindowInNewWindow', async (host?: string) => {
			if (host) {
				// Connect to the specified host in a new window
				await vscode.commands.executeCommand('workbench.action.remote.showQuickPick');
			}
		})
	);

	// Register command: openremotessh.explorer.emptyWindowInCurrentWindow
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.emptyWindowInCurrentWindow', async (host?: string) => {
			if (host) {
				// Connect to the specified host in the current window
				await vscode.commands.executeCommand('workbench.action.remote.showQuickPick');
			}
		})
	);

	// Register command: openremotessh.explorer.reopenFolderInCurrentWindow
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.reopenFolderInCurrentWindow', async (folder?: vscode.Uri) => {
			if (folder) {
				await vscode.commands.executeCommand('vscode.openFolder', folder, false);
			}
		})
	);

	// Register command: openremotessh.explorer.reopenFolderInNewWindow
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.reopenFolderInNewWindow', async (folder?: vscode.Uri) => {
			if (folder) {
				await vscode.commands.executeCommand('vscode.openFolder', folder, true);
			}
		})
	);

	// Register command: openremotessh.explorer.deleteFolderHistoryItem
	context.subscriptions.push(
		vscode.commands.registerCommand('openremotessh.explorer.deleteFolderHistoryItem', async (_item?: any) => {
			// Remove item from recent list
			// This would typically interact with the recent folders list
		})
	);
}

async function openSSHConfigFile(): Promise<void> {
	const config = vscode.workspace.getConfiguration('remote.SSH');
	const configFile = config.get<string>('configFile', '');

	let configPath: string;
	if (configFile && configFile.trim() !== '') {
		configPath = configFile;
	} else {
		// Default SSH config file location
		const homeDir = os.homedir();
		configPath = path.join(homeDir, '.ssh', 'config');
	}

	// Ensure the .ssh directory exists
	const sshDir = path.dirname(configPath);
	if (!fs.existsSync(sshDir)) {
		try {
			fs.mkdirSync(sshDir, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to create .ssh directory: ${error}`);
			return;
		}
	}

	// Create the config file if it doesn't exist
	if (!fs.existsSync(configPath)) {
		try {
			fs.writeFileSync(configPath, '', { mode: 0o600 });
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to create SSH config file: ${error}`);
			return;
		}
	}

	// Open the config file
	const uri = vscode.Uri.file(configPath);
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);
}

export function deactivate(): void {
	// Cleanup if needed
}

