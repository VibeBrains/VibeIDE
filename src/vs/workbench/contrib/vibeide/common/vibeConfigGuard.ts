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

/** Variable names that announce a secret regardless of the value's shape. */
const SECRET_KEY_NAME_PATTERN = /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

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
/** What the caller managed to learn about the project's `.vibe/.env` before asking. */
export interface EnvFileGuardInput {
	/** Path shown to the user, e.g. `.vibe/.env`. */
	readonly path: string;
	/** Variable names found in the file. Values are deliberately NOT passed in. */
	readonly variableNames: readonly string[];
	/** Whether the file is covered by git ignore rules. */
	readonly gitIgnored: boolean;
}

/**
 * Ключи, лежащие в файле проекта, а не в хранилище ОС.
 *
 * WHY this is worth saying even though `apiKeyEnv` is the recommended alternative to a literal in
 * the config: the recommendation is about the config file, not about the whole machine. A key in a
 * project `.env` is plaintext on disk, and that is exactly what the infostealer families behind the
 * August 2026 Claude session thefts collect wholesale (Vidar, Lumma/LummaC2, StealC, RedLine,
 * Acreed on Windows; Atomic on macOS). Keys entered in settings go to Electron `safeStorage`
 * (Keychain / DPAPI / libsecret) and are not readable by a file grab.
 *
 * Severity splits on ONE question — will this key also leave the machine through git:
 * an ignored file is a local exposure, a tracked one is a published secret.
 */
export function scanEnvFileSecrets(input: EnvFileGuardInput | undefined): ConfigGuardFinding[] {
	if (!input || input.variableNames.length === 0) {
		return [];
	}
	const keyLike = input.variableNames.filter(name => SECRET_KEY_NAME_PATTERN.test(name));
	if (keyLike.length === 0) {
		return [];
	}
	const names = keyLike.join(', ');
	return [input.gitIgnored
		? {
			ruleId: 'env-file-plaintext-key', severity: 'medium', subject: input.path,
			message: `${input.path}: ключи (${names}) лежат на диске открытым текстом. Файл не уедет в git, но его читает любая программа от вашего имени — введите ключ в настройках, и он попадёт в хранилище ОС.`,
		}
		: {
			ruleId: 'env-file-tracked-key', severity: 'critical', subject: input.path,
			message: `${input.path}: ключи (${names}) лежат открытым текстом и файл НЕ исключён из git — при следующем коммите секрет уедет в историю репозитория.`,
		}];
}

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

// --- .vibe/skills/**/SKILL.md ------------------------------------------------------------------

/**
 * Instructions that try to talk the agent out of the user's own rules.
 *
 * A skill is untrusted prose that goes into the system context verbatim, so the classic
 * prompt-injection openers matter here in a way they do not in ordinary project files. Matching is
 * deliberately narrow — imperative phrases aimed at the agent — because a skill ABOUT prompt
 * injection is a legitimate thing to write, and a guard that cries at the word «ignore» would be
 * turned off within a day.
 */
const SKILL_OVERRIDE_PHRASES: readonly RegExp[] = [
	/\bignore (?:all |any )?(?:previous|prior|above|preceding) (?:instructions|rules|prompts)\b/i,
	/\bdisregard (?:all |any )?(?:previous|prior|the) (?:instructions|rules|system prompt)\b/i,
	// NOTE: no `\b` around the Russian alternatives. In JavaScript `\w` and `\b` are ASCII-only
	// without the `u` flag, so a boundary before «без» never matches — a space and a Cyrillic letter
	// are both non-word characters to the engine. The rule silently never fired until a test caught
	// it; the phrases below are anchored by their own words instead.
	/(?:игнорируй|забудь|отмени)\s+(?:все\s+)?(?:предыдущие|прежние|данные ранее)\s+(?:инструкции|правила|указания)/i,
	/(?:не\s+спрашивай|без)\s+подтвержден[а-яё]*/i,
	/\bwithout asking (?:the user |for )?(?:permission|confirmation)\b/i,
	/\bdo not (?:tell|inform|mention to) the user\b/i,
	/не\s+сообщай\s+пользователю/i,
];

/** What a skill declares about itself, as the library parsed it. */
export interface SkillGuardInput {
	readonly skillId: string;
	/** Path inside the skill directory to a validation script, exactly as written. */
	readonly precheck?: string;
	/** Frontmatter fields as strings, for the secret check. */
	readonly frontmatter?: Readonly<Record<string, string>>;
	/** The prose handed to the model. */
	readonly body: string;
}

/**
 * Scan skills before their text reaches the model.
 *
 * WHY skills need this at all: everything else the guard covers is configuration the user wrote,
 * while a skill is routinely someone else's — the format is a shared standard, and «скилл,
 * написанный для другого агента, работает и здесь» is a feature we advertise. That makes a skill
 * the one artefact in `.vibe/` that arrives from outside and is fed to the model verbatim.
 *
 * The checks stay narrow on purpose. This is not a content filter and cannot be one: it reports the
 * three shapes that are hard to explain away — a precheck escaping its own directory, a literal
 * secret, and instructions aimed at overriding the user — and leaves judgement to the person.
 */
export function scanSkills(skills: readonly SkillGuardInput[]): ConfigGuardFinding[] {
	const findings: ConfigGuardFinding[] = [];
	for (const skill of skills) {
		const id = skill.skillId;

		const precheck = skill.precheck?.trim();
		if (precheck && (precheck.startsWith('/') || precheck.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(precheck) || precheck.split(/[\\/]/).includes('..'))) {
			findings.push({
				ruleId: 'skill-precheck-escapes', severity: 'critical', subject: id,
				message: `Скилл «${id}»: precheck указывает за пределы своей папки («${precheck}») — путь к чужому скрипту, а не к проверке скилла.`,
			});
		}

		for (const [name, value] of stringEntries(skill.frontmatter)) {
			if (isEmbeddedSecret(name, value)) {
				findings.push({
					ruleId: 'skill-embedded-secret', severity: 'critical', subject: id,
					message: `Скилл «${id}»: поле «${name}» содержит секрет в открытом виде.`,
				});
			}
		}
		if (SECRET_VALUE_PATTERNS.some(re => re.test(skill.body))) {
			findings.push({
				ruleId: 'skill-embedded-secret', severity: 'critical', subject: id,
				message: `Скилл «${id}»: в тексте скилла лежит ключ вендора в открытом виде — он уедет в модель вместе со скиллом.`,
			});
		}

		if (REMOTE_PIPE.test(skill.body)) {
			findings.push({
				ruleId: 'skill-remote-execution', severity: 'high', subject: id,
				message: `Скилл «${id}»: предлагает агенту скачать и выполнить удалённый скрипт (curl … | sh).`,
			});
		}

		const override = SKILL_OVERRIDE_PHRASES.find(re => re.test(skill.body));
		if (override) {
			findings.push({
				ruleId: 'skill-override-instructions', severity: 'medium', subject: id,
				message: `Скилл «${id}»: содержит указание обойти ваши правила или скрыть действие от вас — прочитайте текст скилла перед использованием.`,
			});
		}
	}
	return findings;
}
