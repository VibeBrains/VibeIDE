/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *
 *  VibeIDE integration layer for Project Manager extension.
 *  Uses ONLY public VS Code Extension API — source code NOT modified.
 *  GPL-3.0 applies to project-manager.vsix only, not this file.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Called from VibeIDE's activation context after Project Manager loads.
 * Sets up integration hooks via public Extension API.
 */
export async function activateProjectManagerBridge(): Promise<void> {
	// 1. After `vibe init`: auto-register current project in PM
	await registerCurrentProject();

	// 2. Set projectsLocation to VSCodeSyncFiles-synced folder
	await configureProjectsLocation();
}

/**
 * Register current workspace as a PM project with 'vibe' tag.
 * Called by `vibe init` CLI and on first workspace open with .vibe/.
 */
async function registerCurrentProject(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) return;

	const rootPath = workspaceFolders[0].uri.fsPath;
	const vibePath = path.join(rootPath, '.vibe');

	// Only register if this is a VibeIDE project
	if (!fs.existsSync(vibePath)) return;

	// Use PM's built-in command to add project
	try {
		await vscode.commands.executeCommand('projectManager.addProject');
	} catch {
		// PM may not be loaded yet — silently skip
	}
}

/**
 * Configure PM's projectsLocation to a VSCodeSyncFiles-managed folder.
 * This ensures project list is the same on all devices.
 */
async function configureProjectsLocation(): Promise<void> {
	const config = vscode.workspace.getConfiguration('projectManager');
	const currentLocation = config.get<string>('projectsLocation');

	// Only set if not already configured
	if (!currentLocation) {
		// Use VS Code's global storage path (synced by VSCodeSyncFiles)
		const globalStoragePath = process.env['VSCODE_APPDATA'] ||
			process.env['APPDATA'] ||
			process.env['HOME'] || '';

		if (globalStoragePath) {
			const pmLocation = path.join(globalStoragePath, 'VibeIDE', 'ProjectManager');
			fs.mkdirSync(pmLocation, { recursive: true });
			await config.update('projectsLocation', pmLocation, vscode.ConfigurationTarget.Global);
		}
	}
}
