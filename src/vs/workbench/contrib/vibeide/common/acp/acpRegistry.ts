/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The ACP Registry — a curated directory of agents that speak ACP — read as data.
 *
 * The registry is fetched as one JSON file from a CDN, and versions in it are bumped by an hourly job
 * that follows npm, PyPI and GitHub releases. That is exactly why importing from it is a supply-chain
 * channel, and why three rules hold here:
 *
 * - A package runs at the exact version the registry named (`pkg@1.2.3`, `pkg==1.2.3`), never «latest»:
 *   what the person approved is what runs, and a version that changes under the same entry is what the
 *   hourly job would otherwise do to them.
 * - A binary is installed only with the `sha256` the registry lists — and in practice almost half of the
 *   builds list none. Without it the download could be anything; such a build is refused with a reason,
 *   not installed on trust.
 * - `npx` gets no `--yes`: npm assumes it itself when stdin is not a terminal, and an ACP agent's stdin
 *   is the protocol pipe. The flag would only make Config Guard flag our own entry.
 *
 * The module is pure: parsing, choosing a build, building the entry. Downloading and unpacking live in
 * the main process, writing the file in the window.
 */

import { URI } from '../../../../../base/common/uri.js';
import { npmPinned, pythonPinned } from '../vibeConfigGuard.js';
import { VibeAgentEntry } from './vibeAgentsFile.js';

export const ACP_REGISTRY_DEFAULT_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export type AcpPlatformTarget = 'darwin-aarch64' | 'darwin-x86_64' | 'linux-aarch64' | 'linux-x86_64' | 'windows-aarch64' | 'windows-x86_64';

/** A package the agent runs from: `package` carries the exact version. */
export interface IAcpRegistryPackage {
	readonly package: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

/** One platform build of a binary agent: an archive (or the bare executable) and the command inside it. */
export interface IAcpRegistryBinary {
	readonly archive: string;
	readonly sha256?: string;
	readonly cmd: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export interface IAcpRegistryAgent {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly license?: string;
	readonly licenseUrl?: string;
	readonly website?: string;
	readonly repository?: string;
	readonly authors: readonly string[];
	readonly npx?: IAcpRegistryPackage;
	readonly uvx?: IAcpRegistryPackage;
	readonly binary?: Readonly<Partial<Record<AcpPlatformTarget, IAcpRegistryBinary>>>;
}

export type AcpArchiveFormat = 'zip' | 'tar.gz' | 'raw';

/** Why an agent cannot be added from the registry on this machine. A code, not a phrase: the window words it. */
export type AcpInstallRefusal = 'noDistribution' | 'noBuildForPlatform' | 'noChecksum' | 'unsupportedArchive' | 'unpinnedPackage' | 'unsafeCommandPath';

export type AcpInstallPlan =
	| { readonly kind: 'package'; readonly runner: 'npx' | 'uvx'; readonly spec: IAcpRegistryPackage }
	| { readonly kind: 'binary'; readonly target: AcpPlatformTarget; readonly format: AcpArchiveFormat; readonly binary: IAcpRegistryBinary & { readonly sha256: string } }
	| { readonly kind: 'refused'; readonly reason: AcpInstallRefusal };

const TARGETS: readonly AcpPlatformTarget[] = ['darwin-aarch64', 'darwin-x86_64', 'linux-aarch64', 'linux-x86_64', 'windows-aarch64', 'windows-x86_64'];

/** Archives the registry allows but nothing in the product unpacks: `tar` handles gzip only. */
const UNSUPPORTED_ARCHIVE_SUFFIXES: readonly string[] = ['.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.7z', '.rar'];

/** A SHA-256 digest as the registry writes it: 64 hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Node's platform and arch → the registry's target name; nothing for a platform the registry does not build for. */
export function platformTargetOf(platform: string, arch: string): AcpPlatformTarget | undefined {
	const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : undefined;
	const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
	return os && cpu ? `${os}-${cpu}` as AcpPlatformTarget : undefined;
}

/**
 * The registry file, tolerantly: a malformed entry is skipped with a complaint, the rest stays usable.
 * Only what the product acts on is read; unknown fields are ignored so a newer registry does not break it.
 */
export function parseAcpRegistry(json: unknown): { readonly agents: readonly IAcpRegistryAgent[]; readonly problems: readonly string[] } {
	const raw = asRecord(json)?.['agents'];
	if (!Array.isArray(raw)) {
		return { agents: [], problems: ['в файле реестра нет массива "agents"'] };
	}
	const agents: IAcpRegistryAgent[] = [];
	const problems: string[] = [];
	for (const [index, item] of raw.entries()) {
		const record = asRecord(item);
		const id = stringOf(record?.['id']);
		const version = stringOf(record?.['version']);
		if (!record || !id || !version) {
			problems.push(`запись №${index + 1}: нет "id" или "version" — пропущена`);
			continue;
		}
		const distribution = asRecord(record['distribution']);
		const npx = packageOf(distribution?.['npx']);
		const uvx = packageOf(distribution?.['uvx']);
		const binary = binaryOf(distribution?.['binary']);
		agents.push({
			id,
			name: stringOf(record['name']) ?? id,
			version,
			description: stringOf(record['description']) ?? '',
			...optional('license', stringOf(record['license'])),
			...optional('licenseUrl', stringOf(record['license_url'])),
			...optional('website', stringOf(record['website'])),
			...optional('repository', stringOf(record['repository'])),
			authors: Array.isArray(record['authors']) ? record['authors'].filter((author): author is string => typeof author === 'string') : [],
			...(npx ? { npx } : {}),
			...(uvx ? { uvx } : {}),
			...(binary ? { binary } : {}),
		});
	}
	return { agents, problems };
}

export function archiveFormatOf(archiveUrl: string): AcpArchiveFormat | undefined {
	const path = archiveUrl.split(/[?#]/)[0].toLowerCase();
	if (UNSUPPORTED_ARCHIVE_SUFFIXES.some(suffix => path.endsWith(suffix))) {
		return undefined;
	}
	if (path.endsWith('.zip')) {
		return 'zip';
	}
	if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) {
		return 'tar.gz';
	}
	return 'raw';
}

/**
 * How this agent gets onto this machine. A pinned `npx` package first — nothing to download or verify
 * on our side — then a binary with a checksum, then a pinned `uvx` package, which needs `uv` installed.
 * When nothing fits, the refusal of the binary is reported, since it is the likeliest thing expected.
 */
export function installPlanOf(agent: IAcpRegistryAgent, target: AcpPlatformTarget | undefined): AcpInstallPlan {
	if (agent.npx && npmPinned(agent.npx.package)) {
		return { kind: 'package', runner: 'npx', spec: agent.npx };
	}
	const binaryPlan = agent.binary ? binaryPlanOf(agent.binary, target) : undefined;
	if (binaryPlan?.kind === 'binary') {
		return binaryPlan;
	}
	if (agent.uvx && pythonPinned(agent.uvx.package)) {
		return { kind: 'package', runner: 'uvx', spec: agent.uvx };
	}
	if (binaryPlan) {
		return binaryPlan;
	}
	return { kind: 'refused', reason: agent.npx || agent.uvx ? 'unpinnedPackage' : 'noDistribution' };
}

/**
 * The `agents.json` entry for a plan. A binary needs the absolute path it was installed under; the
 * entry remembers the registry id and version, which is how the pane recognises it for updates.
 */
export function agentEntryOf(agent: IAcpRegistryAgent, plan: AcpInstallPlan, installedCommand?: string): VibeAgentEntry | undefined {
	const registry = { id: agent.id, version: agent.version };
	if (plan.kind === 'package') {
		return {
			id: agent.id,
			name: agent.name,
			command: plan.runner,
			args: [plan.spec.package, ...plan.spec.args],
			...(Object.keys(plan.spec.env).length > 0 ? { env: { ...plan.spec.env } } : {}),
			registry,
		};
	}
	if (plan.kind === 'binary' && installedCommand) {
		return {
			id: agent.id,
			name: agent.name,
			command: installedCommand,
			...(plan.binary.args.length > 0 ? { args: [...plan.binary.args] } : {}),
			...(Object.keys(plan.binary.env).length > 0 ? { env: { ...plan.binary.env } } : {}),
			registry,
		};
	}
	return undefined;
}

/** A newer registry version for an entry that came from the registry; nothing for a hand-written entry. */
export function registryUpdateOf(entry: VibeAgentEntry, agents: readonly IAcpRegistryAgent[]): { readonly agent: IAcpRegistryAgent; readonly from: string; readonly to: string } | undefined {
	const origin = entry.registry;
	if (!origin) {
		return undefined;
	}
	const agent = agents.find(item => item.id === origin.id);
	if (!agent || compareVersions(agent.version, origin.version) <= 0) {
		return undefined;
	}
	return { agent, from: origin.version, to: agent.version };
}

/** Semantic versions compared by number; a part that is not a number compares as text. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(/[.+-]/);
	const right = b.split(/[.+-]/);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i] ?? '0';
		const y = right[i] ?? '0';
		const nx = Number(x);
		const ny = Number(y);
		const diff = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
		if (diff !== 0) {
			return Math.sign(diff);
		}
	}
	return 0;
}

function binaryPlanOf(builds: Readonly<Partial<Record<AcpPlatformTarget, IAcpRegistryBinary>>>, target: AcpPlatformTarget | undefined): AcpInstallPlan {
	const build = target ? builds[target] : undefined;
	if (!target || !build) {
		return { kind: 'refused', reason: 'noBuildForPlatform' };
	}
	if (!build.sha256 || !SHA256_HEX.test(build.sha256)) {
		return { kind: 'refused', reason: 'noChecksum' };
	}
	const format = archiveFormatOf(build.archive);
	if (!format) {
		return { kind: 'refused', reason: 'unsupportedArchive' };
	}
	if (!isSafeRelativeCommand(build.cmd)) {
		return { kind: 'refused', reason: 'unsafeCommandPath' };
	}
	return { kind: 'binary', target, format, binary: { ...build, sha256: build.sha256.toLowerCase() } };
}

/** The command inside an archive must stay inside it: relative, no `..`, no drive or root. */
function isSafeRelativeCommand(cmd: string): boolean {
	const normalized = cmd.replace(/\\/g, '/');
	return !!normalized && !normalized.startsWith('/') && !/^[a-z]:/i.test(normalized) && !normalized.split('/').includes('..');
}

function packageOf(value: unknown): IAcpRegistryPackage | undefined {
	const record = asRecord(value);
	const spec = stringOf(record?.['package']);
	return record && spec ? { package: spec, args: stringsOf(record['args']), env: stringMapOf(record['env']) } : undefined;
}

function binaryOf(value: unknown): Partial<Record<AcpPlatformTarget, IAcpRegistryBinary>> | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	const builds: Partial<Record<AcpPlatformTarget, IAcpRegistryBinary>> = {};
	for (const target of TARGETS) {
		const build = asRecord(record[target]);
		const archive = stringOf(build?.['archive']);
		const cmd = stringOf(build?.['cmd']);
		if (build && archive && cmd) {
			builds[target] = { archive, cmd, args: stringsOf(build['args']), env: stringMapOf(build['env']), ...optional('sha256', stringOf(build['sha256'])) };
		}
	}
	return Object.keys(builds).length > 0 ? builds : undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const stringOf = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() ? value.trim() : undefined;

const stringsOf = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function stringMapOf(value: unknown): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [key, item] of Object.entries(asRecord(value) ?? {})) {
		if (typeof item === 'string') {
			map[key] = item;
		}
	}
	return map;
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
	return (value !== undefined ? { [key]: value } : {}) as { [P in K]?: string };
}

/** The licence link of a registry agent when it is an http(s) address; anything else is not opened — the registry is somebody else's data */
export function licenseLinkOf(agent: Pick<IAcpRegistryAgent, 'licenseUrl'>): URI | undefined {
	if (!agent.licenseUrl) {
		return undefined;
	}
	try {
		const uri = URI.parse(agent.licenseUrl, true);
		return uri.scheme === 'https' || uri.scheme === 'http' ? uri : undefined;
	} catch {
		return undefined;
	}
}
