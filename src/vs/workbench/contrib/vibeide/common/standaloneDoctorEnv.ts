/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Standalone doctor environment probe — pure helper for the future
 * `npx vibe-doctor` standalone CLI (roadmap §1133).
 *
 * This module captures the minimal set of host-environment facts that a
 * standalone CLI needs to render before delegating to the in-repo
 * `scripts/vibe-doctor.js` (when running inside the repo) or running its own
 * lightweight checks (when running outside).
 *
 * Pure: no `fs`/`child_process` imports. Caller injects probes via the
 * `EnvProbes` interface. Decisions / formatting live here so they're testable.
 *
 * @i18n-scan-skip-file — output goes to terminal / CI logs only (English).
 * Localising these `title` literals would force `nls.js` into a module that
 * is intentionally vscode-free for standalone-CLI packaging.
 */

export interface EnvProbes {
	/** Node.js version string, e.g. "20.11.1". */
	readonly nodeVersion: string;
	/** Whether `npm` is on PATH and resolvable. */
	readonly npmAvailable: boolean;
	/** Whether `git` is on PATH. */
	readonly gitAvailable: boolean;
	/** Whether the cwd looks like the VibeIDE repo (has package.json with vibeVersion). */
	readonly insideVibeideRepo: boolean;
	/** Whether VibeIDE app is detected on the system (electron binary or installed app). */
	readonly vibeideAppInstalled: boolean;
	/** Operating system identifier: 'darwin' | 'linux' | 'win32' | other. */
	readonly platform: string;
	/** Architecture: 'x64' | 'arm64' | other. */
	readonly arch: string;
}

export type Severity = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
	readonly id: string;
	readonly title: string;
	readonly severity: Severity;
	readonly message: string;
	/** Suggested next action; may be undefined when severity === 'ok'. */
	readonly remediation?: string;
}

const MIN_NODE_MAJOR = 20;

export function runStandaloneChecks(env: EnvProbes): DoctorCheck[] {
	const checks: DoctorCheck[] = [];

	checks.push(checkNode(env));
	checks.push(checkNpm(env));
	checks.push(checkGit(env));
	checks.push(checkRepoVsApp(env));
	checks.push(checkPlatform(env));

	return checks;
}

function checkNode(env: EnvProbes): DoctorCheck {
	const major = parseMajor(env.nodeVersion);
	if (major === null) {
		return {
			id: 'node.version',
			title: 'Node.js version',
			severity: 'error',
			message: `Could not parse Node version "${env.nodeVersion}".`,
			remediation: 'Install Node.js 20+ from https://nodejs.org/.',
		};
	}
	if (major < MIN_NODE_MAJOR) {
		return {
			id: 'node.version',
			title: 'Node.js version',
			severity: 'error',
			message: `Node ${env.nodeVersion} is too old (requires >=${MIN_NODE_MAJOR}).`,
			remediation: `Upgrade Node.js to ${MIN_NODE_MAJOR}+ from https://nodejs.org/.`,
		};
	}
	return {
		id: 'node.version',
		title: 'Node.js version',
		severity: 'ok',
		message: `Node ${env.nodeVersion} (>=${MIN_NODE_MAJOR}).`,
	};
}

function checkNpm(env: EnvProbes): DoctorCheck {
	if (!env.npmAvailable) {
		return {
			id: 'npm.available',
			title: 'npm on PATH',
			severity: 'warn',
			message: '`npm` is not resolvable on PATH.',
			remediation: 'Reinstall Node.js (npm ships with it) or fix PATH.',
		};
	}
	return {
		id: 'npm.available',
		title: 'npm on PATH',
		severity: 'ok',
		message: '`npm` resolved.',
	};
}

function checkGit(env: EnvProbes): DoctorCheck {
	if (!env.gitAvailable) {
		return {
			id: 'git.available',
			title: 'git on PATH',
			severity: 'warn',
			message: '`git` is not resolvable on PATH.',
			remediation: 'Install git from https://git-scm.com/ — required for some VibeIDE flows (worktrees, lock files).',
		};
	}
	return {
		id: 'git.available',
		title: 'git on PATH',
		severity: 'ok',
		message: '`git` resolved.',
	};
}

function checkRepoVsApp(env: EnvProbes): DoctorCheck {
	if (env.insideVibeideRepo) {
		return {
			id: 'repo.context',
			title: 'Run context',
			severity: 'ok',
			message: 'Running inside the VibeIDE repository — full diagnostics available via scripts/vibe-doctor.js.',
		};
	}
	if (env.vibeideAppInstalled) {
		return {
			id: 'repo.context',
			title: 'Run context',
			severity: 'ok',
			message: 'VibeIDE app detected on the system — standalone checks only; open the IDE for full doctor.',
		};
	}
	return {
		id: 'repo.context',
		title: 'Run context',
		severity: 'warn',
		message: 'Neither VibeIDE repo nor installed app detected.',
		remediation: 'Install VibeIDE from https://github.com/borodatych/VibeIDE/releases or clone the repo.',
	};
}

function checkPlatform(env: EnvProbes): DoctorCheck {
	const supportedPlatforms = ['darwin', 'linux', 'win32'];
	if (!supportedPlatforms.includes(env.platform)) {
		return {
			id: 'platform',
			title: 'Operating system',
			severity: 'warn',
			message: `Platform "${env.platform}" is not in the tested matrix (${supportedPlatforms.join(', ')}).`,
			remediation: 'VibeIDE may still work — file an issue if you hit a regression.',
		};
	}
	return {
		id: 'platform',
		title: 'Operating system',
		severity: 'ok',
		message: `${env.platform}/${env.arch}`,
	};
}

function parseMajor(version: string): number | null {
	const m = /^v?(\d+)\./.exec(version);
	if (!m) { return null; }
	return Number.parseInt(m[1], 10);
}

export interface RenderOptions {
	readonly colorize?: boolean;
}

export function renderChecks(checks: ReadonlyArray<DoctorCheck>, opts: RenderOptions = {}): string {
	const colorize = opts.colorize ?? false;
	const lines: string[] = [];
	for (const c of checks) {
		const tag = colorize ? colorizeSeverity(c.severity) : `[${c.severity.toUpperCase()}]`;
		lines.push(`${tag} ${c.title}: ${c.message}`);
		if (c.remediation && c.severity !== 'ok') {
			lines.push(`       → ${c.remediation}`);
		}
	}
	return lines.join('\n');
}

function colorizeSeverity(s: Severity): string {
	switch (s) {
		case 'ok': return '[32m[OK][0m';
		case 'warn': return '[33m[WARN][0m';
		case 'error': return '[31m[ERROR][0m';
	}
}

/** Aggregate severity: error if any error, else warn if any warn, else ok. */
export function aggregateSeverity(checks: ReadonlyArray<DoctorCheck>): Severity {
	if (checks.some(c => c.severity === 'error')) { return 'error'; }
	if (checks.some(c => c.severity === 'warn')) { return 'warn'; }
	return 'ok';
}
