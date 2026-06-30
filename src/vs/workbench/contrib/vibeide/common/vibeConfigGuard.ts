/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeConfigGuard — pure static analysis of the two UNTRUSTED machine-config surfaces VibeIDE
 * loads from a (possibly third-party) workspace: `.vibe/providers.json` (dynamic LLM providers)
 * and `mcp.json` (MCP servers). It COMPLEMENTS — never duplicates — the existing guards:
 *   • secret detection on outgoing messages       → vibeide.secretDetection
 *   • prompt-injection / unicode guard on rules    → vibePromptGuardService
 *
 * Scope here is config-as-code risk those two don't cover: plaintext / attacker-controlled model
 * endpoints, secrets hardcoded into committed config, and command-injection / supply-chain in MCP
 * server commands.
 *
 * No I/O, no config reads, no VS Code deps → unit-testable from test/common/. The caller (the
 * providers / MCP services) owns enablement (vibeide.configGuard.enabled), strictness
 * (vibeide.configGuard.mode), logging and notification.
 */

import { VibeProviderEntry } from './vibeProvidersFile.js';
import { MCPConfigFileEntryJSON } from './mcpServiceTypes.js';

export type ConfigGuardSeverity = 'critical' | 'high' | 'medium';

export interface ConfigGuardFinding {
	/** Stable rule identifier (English; used in logs/tests/config). */
	readonly ruleId: string;
	readonly severity: ConfigGuardSeverity;
	/** The provider id / MCP server name the finding belongs to. */
	readonly subject: string;
	/** User-facing one-liner (Russian). */
	readonly message: string;
}

// --- shared secret / URL heuristics -----------------------------------------------------------

/** Vendor key shapes that are unambiguous secrets wherever they appear. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
	/sk-[A-Za-z0-9_-]{16,}/,            // OpenAI / Anthropic
	/AKIA[0-9A-Z]{16}/,                 // AWS access key id
	/gh[pousr]_[A-Za-z0-9]{20,}/,       // GitHub PAT / OAuth
	/xox[baprs]-[A-Za-z0-9-]{10,}/,     // Slack
	/AIza[0-9A-Za-z_-]{20,}/,           // Google API key
];

/** Field NAMES expected to carry credentials — a literal value there is a leak. */
const SECRET_KEYISH_NAME = /(authorization|api[-_]?key|x-api-key|token|secret|password|passwd|access[-_]?key|bearer)/i;

/** Value forms that are references/placeholders, NOT a real embedded secret. */
const VALUE_IS_REFERENCE = /^\s*(?:bearer\s+)?(?:\$\{?[a-z_][a-z0-9_]*\}?|<[^>]*>|\*{2,}|x{3,}|change[-_]?me|your[-_].*|placeholder|todo)\s*$/i;

function looksOpaque(value: string): boolean {
	const v = value.replace(/^\s*bearer\s+/i, '').trim();
	return v.length >= 16 && /^[A-Za-z0-9_\-.=+/]+$/.test(v);
}

/** True when `value` (under field `name`) is a literal embedded secret rather than a reference. */
function isEmbeddedSecret(name: string, value: string): boolean {
	if (typeof value !== 'string' || !value.trim()) { return false; }
	if (SECRET_VALUE_PATTERNS.some(re => re.test(value))) { return true; }
	if (VALUE_IS_REFERENCE.test(value)) { return false; }
	return SECRET_KEYISH_NAME.test(name) && looksOpaque(value);
}

interface UrlInfo { readonly scheme: string; readonly host: string; readonly hasUserinfo: boolean }

function parseUrl(raw: string): UrlInfo | undefined {
	try {
		const u = new URL(raw);
		return { scheme: u.protocol.replace(/:$/, '').toLowerCase(), host: u.hostname.toLowerCase(), hasUserinfo: !!(u.username || u.password) };
	} catch {
		return undefined;
	}
}

const isLocalHost = (h: string): boolean => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1' || h === '[::1]';
const isRawIPv4 = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/** String-valued own entries of an arbitrary object (defensive against malformed config). */
function stringEntries(o: unknown): [string, string][] {
	if (!o || typeof o !== 'object') { return []; }
	const out: [string, string][] = [];
	for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
		if (typeof v === 'string') { out.push([k, v]); }
	}
	return out;
}

// --- providers.json ---------------------------------------------------------------------------

/**
 * Scan `.vibe/providers.json` entries. Catches: plaintext http:// model endpoints (key + traffic in
 * the clear), raw-IP endpoints (no domain trust anchor), and secrets hardcoded into the committed
 * file (baseURL userinfo, header / query literals) instead of apiKeyEnv / apiKeyRef.
 */
export function scanProviderConfig(entries: readonly VibeProviderEntry[]): ConfigGuardFinding[] {
	const findings: ConfigGuardFinding[] = [];
	for (const e of entries) {
		if (!e || typeof e.id !== 'string') { continue; }
		const id = e.id;

		const baseURL = typeof e.baseURL === 'string' ? e.baseURL.trim() : '';
		if (baseURL) {
			const info = parseUrl(baseURL);
			if (info) {
				if (info.scheme === 'http' && !isLocalHost(info.host)) {
					findings.push({
						ruleId: 'provider-endpoint-non-https', severity: 'critical', subject: id,
						message: `Провайдер «${id}»: baseURL использует незашифрованный http:// — трафик к модели и API-ключ идут открытым текстом.`,
					});
				}
				if (isRawIPv4(info.host) && !isLocalHost(info.host)) {
					findings.push({
						ruleId: 'provider-endpoint-raw-ip', severity: 'high', subject: id,
						message: `Провайдер «${id}»: baseURL указывает на сырой IP-адрес (${info.host}) вместо доменного имени — убедитесь, что endpoint доверенный.`,
					});
				}
				if (info.hasUserinfo) {
					findings.push({
						ruleId: 'provider-hardcoded-secret', severity: 'critical', subject: id,
						message: `Провайдер «${id}»: baseURL содержит логин/пароль (user:pass@) — учётные данные хранятся в открытом виде в конфиге.`,
					});
				}
			}
		}

		for (const [name, value] of stringEntries(e.headers)) {
			if (isEmbeddedSecret(name, value)) {
				findings.push({
					ruleId: 'provider-hardcoded-secret', severity: 'critical', subject: id,
					message: `Провайдер «${id}»: заголовок «${name}» содержит секрет в открытом виде — используйте apiKeyEnv или apiKeyRef вместо литерала.`,
				});
				break; // one header finding per entry is enough signal
			}
		}
		for (const [name, value] of stringEntries(e.query)) {
			if (isEmbeddedSecret(name, value)) {
				findings.push({
					ruleId: 'provider-hardcoded-secret', severity: 'critical', subject: id,
					message: `Провайдер «${id}»: query-параметр «${name}» содержит секрет в открытом виде — вынесите ключ в apiKeyEnv/apiKeyRef.`,
				});
				break;
			}
		}
	}
	return findings;
}

// --- mcp.json ---------------------------------------------------------------------------------

const CRITICAL_ENV_OVERRIDES = new Set(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH']);
const DISABLED_SECURITY_FLAGS = ['--no-sandbox', '--disable-web-security', '--disable-gpu-sandbox', '--disable-setuid-sandbox', '--allow-running-insecure-content', '--ignore-certificate-errors'];
const REMOTE_PIPE = /\b(?:curl|wget|iwr|invoke-webrequest)\b[\s\S]*?\|\s*(?:sh|bash|zsh|dash|python[0-9.]*|node|pwsh|powershell|iex)\b/i;
const SHELL_BASENAMES = /(?:^|[/\\])(?:sh|bash|zsh|dash|ksh)$/i;
const SHELL_METACHARS = /[`$;|&<>]/;

function basename(p: string): string {
	const m = /[^/\\]+$/.exec(p.trim());
	return m ? m[0] : p.trim();
}

/** Describe an npx supply-chain concern (auto-install / unpinned version), or undefined if clean. */
function npxConcern(args: readonly string[]): string | undefined {
	const hasYes = args.some(a => a === '-y' || a === '--yes');
	// First non-flag token is the package spec (skip -y/--yes and -p/--package <value> pairs).
	let pkg: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '-y' || a === '--yes') { continue; }
		if (a === '-p' || a === '--package') { i++; pkg = args[i]; break; }
		if (a.startsWith('-')) { continue; }
		pkg = a; break;
	}
	let unpinned = false;
	if (pkg) {
		const at = pkg.startsWith('@') ? pkg.indexOf('@', 1) : pkg.indexOf('@');
		const version = at >= 0 ? pkg.slice(at + 1) : '';
		unpinned = at < 0 || version === '' || version.toLowerCase() === 'latest';
	}
	if (hasYes && unpinned) { return `auto-установка без подтверждения (-y) и без фиксации версии (${pkg ?? '?'})`; }
	if (hasYes) { return `auto-установка пакета без подтверждения (-y)`; }
	if (unpinned && pkg) { return `пакет без фиксации версии (${pkg}) — может подтянуть вредоносное обновление`; }
	return undefined;
}

/**
 * Scan `mcp.json` server entries. Catches command-injection / supply-chain in stdio servers
 * (`curl|sh`, `sh -c`, `npx -y`/unpinned, sandbox-disabling flags, shell metacharacters), env-based
 * code-substitution and hardcoded secrets, and plaintext / credential-bearing remote URLs. Server-
 * side concerns from upstream rule sets (bind 0.0.0.0, wildcard CORS) are intentionally OUT of scope:
 * VibeIDE is the MCP *client*, it connects — it does not bind a listener.
 */
export function scanMcpConfig(servers: Record<string, MCPConfigFileEntryJSON> | undefined): ConfigGuardFinding[] {
	const findings: ConfigGuardFinding[] = [];
	if (!servers || typeof servers !== 'object') { return findings; }

	for (const [name, raw] of Object.entries(servers)) {
		if (!raw || typeof raw !== 'object') { continue; }
		const cmd = typeof raw.command === 'string' ? raw.command : '';
		const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
		const cmdline = [cmd, ...args].join(' ');

		const remote = REMOTE_PIPE.test(cmdline);
		if (remote) {
			findings.push({
				ruleId: 'mcp-remote-command', severity: 'critical', subject: name,
				message: `MCP-сервер «${name}»: команда скачивает и исполняет удалённый скрипт (curl|sh) — произвольное выполнение кода при старте.`,
			});
		}
		if (SHELL_BASENAMES.test(cmd) && args.includes('-c')) {
			findings.push({
				ruleId: 'mcp-shell-wrapper', severity: 'high', subject: name,
				message: `MCP-сервер «${name}»: запуск через «${basename(cmd)} -c …» — обёртка обходит разделение аргументов и упрощает инъекцию команд.`,
			});
		}
		if (args.some(a => DISABLED_SECURITY_FLAGS.some(f => a.includes(f)))) {
			findings.push({
				ruleId: 'mcp-disabled-security', severity: 'critical', subject: name,
				message: `MCP-сервер «${name}»: аргументы отключают защиту (--no-sandbox / --disable-web-security и т.п.).`,
			});
		}

		// npx supply-chain — applies whether npx is the command or wrapped in args.
		let npxArgs: string[] | undefined;
		if (basename(cmd).toLowerCase() === 'npx') {
			npxArgs = [...args];
		} else {
			const idx = args.findIndex(a => basename(a).toLowerCase() === 'npx');
			if (idx >= 0) { npxArgs = args.slice(idx + 1); }
		}
		if (npxArgs) {
			const concern = npxConcern(npxArgs);
			if (concern) {
				findings.push({ ruleId: 'mcp-npx-no-pin', severity: 'medium', subject: name, message: `MCP-сервер «${name}»: ${concern}.` });
			}
		}

		// Shell metacharacters — skip when the remote-pipe rule already covers this line.
		if (!remote && args.some(a => SHELL_METACHARS.test(a))) {
			findings.push({
				ruleId: 'mcp-shell-metacharacters', severity: 'medium', subject: name,
				message: `MCP-сервер «${name}»: аргументы содержат shell-метасимволы (\`$ ; | & < >\`) — риск инъекции команд.`,
			});
		}

		for (const [k, v] of stringEntries(raw.env)) {
			if (CRITICAL_ENV_OVERRIDES.has(k.toUpperCase())) {
				findings.push({
					ruleId: 'mcp-env-override-critical', severity: 'critical', subject: name,
					message: `MCP-сервер «${name}»: env переопределяет критичную переменную «${k}» — вектор подмены загружаемого кода.`,
				});
			} else if (isEmbeddedSecret(k, v)) {
				findings.push({
					ruleId: 'mcp-hardcoded-env-secret', severity: 'critical', subject: name,
					message: `MCP-сервер «${name}»: env «${k}» содержит секрет в открытом виде — используйте ссылку на переменную окружения, а не литерал.`,
				});
			}
		}

		const url = typeof raw.url === 'string' ? raw.url : (raw.url ? String(raw.url) : '');
		if (url) {
			const info = parseUrl(url);
			if (info) {
				if (info.scheme === 'http' && !isLocalHost(info.host)) {
					findings.push({
						ruleId: 'mcp-url-non-https', severity: 'high', subject: name,
						message: `MCP-сервер «${name}»: url использует незашифрованный http:// — данные и токены передаются открытым текстом.`,
					});
				}
				if (info.hasUserinfo) {
					findings.push({
						ruleId: 'mcp-url-credentials', severity: 'high', subject: name,
						message: `MCP-сервер «${name}»: url содержит логин/пароль (user:pass@) — учётные данные в открытом виде в конфиге.`,
					});
				}
			}
		}
	}
	return findings;
}
