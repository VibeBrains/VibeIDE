/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Keep only the sherpa-onnx native package matching the build target.
 *
 * `sherpa-onnx-node` declares every native package as an optional dependency, and npm installs
 * all of them regardless of the host. A packaged app would otherwise carry libraries it can
 * never load — worse, a Linux arm64 package that still contains `sherpa-onnx-linux-x64` makes
 * RPM's automatic dependency scanner record `ld-linux-x86-64.so.2`. Mirrors the ripgrep and
 * os-proxy-resolver filters in the `deps` stream of `gulpfile.vscode.ts`.
 */

/** Native packages published by `sherpa-onnx-node`. */
export const sherpaOnnxPlatforms = [
	'darwin-arm64', 'darwin-x64',
	'linux-arm64', 'linux-x64',
	'win-ia32', 'win-x64',
];

/**
 * Build platform/arch names differ from the package names: Windows packages use `win`, and
 * the VS Code build uses `armhf` where Node reports `arm`.
 */
function toSherpaOnnxPlatform(platform: string, arch: string): string {
	const targetPlatform = platform === 'win32' ? 'win' : platform;
	const targetArch = arch === 'armhf' ? 'arm' : arch;
	return `${targetPlatform}-${targetArch}`;
}

/** Glob list keeping every file except sherpa-onnx native packages built for other targets. */
export function getSherpaOnnxExcludeFilter(platform: string, arch: string): string[] {
	const target = toSherpaOnnxPlatform(platform, arch);
	return [
		'**',
		...sherpaOnnxPlatforms
			.filter(candidate => candidate !== target)
			.map(candidate => `!**/node_modules/sherpa-onnx-${candidate}/**`),
	];
}
