/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incoming HTTP API — shared contracts and the whole admission decision.
 *
 * What this opens: a way to start an agent run from CI, a bot, or cron, and to continue the same
 * session later. What it also opens, if done carelessly: arbitrary code execution on the owner's
 * machine, from anything that can reach a port. Every rule below exists because of the second
 * sentence, and the decision is kept here — pure, without a socket in sight — because that is the
 * only way to test the cases that matter (wrong token, right token from the wrong host, a browser
 * on some website that resolved a domain to 127.0.0.1).
 *
 * Deliberate positions:
 *
 * - **Off by default, and refuses to start without a token.** A feature that boots into "anyone
 *   local can run commands" would be a backdoor with a settings page.
 * - **Loopback only.** The listener never binds a routable address, so "I only meant it for my
 *   laptop" cannot become a machine on the office network.
 * - **The `Host` header is checked too.** Loopback binding alone does not stop DNS rebinding: a
 *   web page the owner visits can resolve its own domain to 127.0.0.1 and have the browser talk to
 *   this port with the site's own credentials. Only requests addressed to a loopback name pass.
 * - **Constant-time token comparison.** An early-exit compare leaks the token a byte at a time to
 *   anything that can measure, and this token is worth a shell.
 */

import { Event } from '../../../../../base/common/event.js';
// One implementation of "is this request local", shared with the MCP gateway: two copies drift, and
// the copy that drifts is the one nobody tested.
import { isLoopbackHost, isRemoteLoopback, secretEquals } from '../../../../../base/common/loopbackAdmission.js';

export { isLoopbackHost, isRemoteLoopback, secretEquals };

export const VIBE_HTTP_API_CHANNEL = 'vibeide-channel-httpApi';

export const VibeHttpApiConfigKeys = {
	section: 'vibeide.httpApi',
	enabled: 'vibeide.httpApi.enabled',
	port: 'vibeide.httpApi.port',
} as const;

/** Wire version. Bumped only on breaking changes to the request/response shapes. */
export const VIBE_HTTP_API_VERSION = 1;

/** Largest request body accepted, in bytes. A prompt is text; a megabyte is already generous. */
export const MAX_REQUEST_BODY_BYTES = 1_000_000;

/** Start a run, optionally continuing an existing session. */
export interface VibeHttpRunRequest {
	/** What the agent should do. Required and non-empty — an empty task is a client bug, not a run. */
	readonly task: string;
	/**
	 * Continue this session instead of starting a new one. Absent = new session.
	 * This is what makes the API usable from CI: step two talks to the same agent as step one.
	 */
	readonly sessionId?: string;
	/** Wait for the run to finish before answering. Default false — CI usually polls. */
	readonly wait?: boolean;
}

/**
 * Where a run started over HTTP stands
 *
 * `started` exists only as the answer to `POST /run` without `wait`; the rest is what `GET /run/<sessionId>` shows
 * `awaiting_approval` is not an end:
 * The agent waits for a person to allow an action, and the approval starts the next leg of the same run
 */
export type VibeHttpRunStatus = 'started' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'aborted';

/** Statuses after which the run changes no more */
export function isTerminalHttpRunStatus(status: VibeHttpRunStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'aborted';
}

/** Longest answer returned over HTTP, in characters; a longer one is cut and flagged `answerTruncated` */
export const MAX_ANSWER_CHARS = 100_000;

export interface VibeHttpRunResponse {
	readonly sessionId: string;
	readonly status: VibeHttpRunStatus;
	/** The agent's final answer, once the run has ended */
	readonly answer?: string;
	/** The answer was longer than {@link MAX_ANSWER_CHARS} and was cut */
	readonly answerTruncated?: boolean;
	readonly error?: string;
}

/** What `GET /run/<sessionId>` returns: the latest run of the session */
export interface VibeHttpRunSnapshot extends VibeHttpRunResponse {
	/** ISO 8601 */
	readonly startedAt: string;
	/** ISO 8601 */
	readonly updatedAt: string;
	/** ISO 8601, set once the status is terminal */
	readonly finishedAt?: string;
}

/** A window telling the main process where a run stands */
export interface VibeHttpRunReport extends VibeHttpRunResponse {
	/** The `POST /run` the run came from: tells the next run of the same session from a late word about this one */
	readonly requestId: string;
	/** The window instance executing it: when that window reloads or closes, its runs are dead */
	readonly instanceId: string;
}

/** HTTP code for a run answer: an unfinished run is accepted, not done */
export function httpStatusOfRun(status: VibeHttpRunStatus): number {
	switch (status) {
		case 'failed': return 500;
		case 'running':
		case 'awaiting_approval': return 202;
		default: return 200;
	}
}

export interface VibeHttpApiStatus {
	readonly running: boolean;
	readonly port?: number;
	readonly error?: string;
}

/**
 * A window offering to serve the API
 *
 * `instanceId` is new on every load of the window:
 * A reload keeps `windowId`, and the main process must still tell the dead instance from the one that replaced it
 */
export interface VibeHttpApiRegistration {
	readonly windowId: number;
	readonly instanceId: string;
	readonly port: number;
	readonly token: string;
}

export interface VibeHttpApiRegistrationResult extends VibeHttpApiStatus {
	/** This instance serves the requests; the others stand by until it goes away */
	readonly owner: boolean;
}

/** A request handed to the owner window to run */
export interface VibeHttpApiPendingRun {
	readonly requestId: string;
	/** The instance that must execute it; every other window ignores the event */
	readonly instanceId: string;
	readonly request: VibeHttpRunRequest;
}

/**
 * Channel contract between the main process (owns the socket) and a window (owns the agent).
 *
 * Declared here rather than next to the implementation so neither side imports the other's layer:
 * the window would otherwise reach into `electron-main` for a type and the dependency direction
 * would exist on paper even if the compiler tolerated it.
 *
 * One window serves the API at a time — the one registered longest
 * Every window with the API enabled registers, the rest stand by:
 * They take over when the owner reloads, closes or turns the API off, so a task never runs in two windows at once
 */
export interface IVibeHttpApiMain {
	readonly onRun: Event<VibeHttpApiPendingRun>;
	/** Offer this window instance to serve the API; the listener follows whoever owns it */
	register(registration: VibeHttpApiRegistration): Promise<VibeHttpApiRegistrationResult>;
	/** Withdraw the instance (API turned off, window going away); the next one takes over, or the listener stops */
	unregister(instanceId: string): Promise<void>;
	getStatus(): Promise<VibeHttpApiStatus>;
	/** A window answers a request it was handed. */
	completeRun(requestId: string, response: VibeHttpRunResponse): Promise<void>;
	/** A window records where a run stands, for `GET /run/<sessionId>` */
	reportRun(report: VibeHttpRunReport): Promise<void>;
	/** Generate a token; the caller stores it in SecretStorage and shows it to the user once. */
	generateToken(): Promise<string>;
}

export type AdmissionVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: number; readonly reason: string };


/**
 * Everything that must be true before a request is allowed to reach the agent.
 *
 * Order matters for what an attacker learns: the host check runs BEFORE the token check, so a
 * rebinding page is refused without ever being told whether its guessed token was right.
 */
export function admitRequest(params: {
	readonly hostHeader: string | undefined;
	readonly authorization: string | undefined;
	readonly remoteAddress: string | undefined;
	readonly expectedToken: string | undefined;
}): AdmissionVerdict {
	if (!params.expectedToken) {
		// No token configured means the server should not have started at all; refusing here as
		// well keeps the invariant true even if some future caller forgets to check.
		return { ok: false, status: 503, reason: 'HTTP API не настроен: нет токена' };
	}
	if (!isRemoteLoopback(params.remoteAddress)) {
		return { ok: false, status: 403, reason: 'Запросы принимаются только с этого компьютера' };
	}
	if (!isLoopbackHost(params.hostHeader)) {
		return { ok: false, status: 403, reason: 'Недопустимый заголовок Host' };
	}
	const prefix = 'bearer ';
	const header = params.authorization ?? '';
	if (header.slice(0, prefix.length).toLowerCase() !== prefix) {
		return { ok: false, status: 401, reason: 'Требуется заголовок Authorization: Bearer <токен>' };
	}
	if (!secretEquals(header.slice(prefix.length).trim(), params.expectedToken)) {
		return { ok: false, status: 401, reason: 'Неверный токен' };
	}
	return { ok: true };
}


/** Parse and validate a run request body. Returns a reason instead of throwing — the caller answers 400. */
export function parseRunRequest(body: string): { readonly ok: true; readonly value: VibeHttpRunRequest } | { readonly ok: false; readonly reason: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return { ok: false, reason: 'Тело запроса — не JSON' };
	}
	// `typeof [] === 'object'`, so an array would sail past a bare type check and be refused later
	// for a missing `task` — a misleading message for a body that was the wrong shape entirely.
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { ok: false, reason: 'Тело запроса — не объект' }; }
	const obj = raw as Record<string, unknown>;
	const task = obj['task'];
	if (typeof task !== 'string' || task.trim().length === 0) {
		return { ok: false, reason: 'Поле task обязательно и не может быть пустым' };
	}
	const sessionId = obj['sessionId'];
	if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0)) {
		return { ok: false, reason: 'Поле sessionId, если указано, — непустая строка' };
	}
	const wait = obj['wait'];
	if (wait !== undefined && typeof wait !== 'boolean') {
		return { ok: false, reason: 'Поле wait, если указано, — булево' };
	}
	return {
		ok: true,
		value: {
			task: task.trim(),
			...(typeof sessionId === 'string' ? { sessionId } : {}),
			...(typeof wait === 'boolean' ? { wait } : {}),
		},
	};
}

const RUN_PATH_PREFIX = '/run/';

/**
 * A session id as it may appear in `GET /run/<sessionId>`
 * Session ids are UUIDs; the pattern leaves room for other id shapes and nothing for paths, dots or escapes
 */
const SESSION_ID_IN_PATH = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Read `GET /run/<sessionId>` out of a request URL (the query part is ignored)
 *
 * `undefined` — not this route at all; `{ ok: false }` — the route with an id that is not a session id
 * The id is checked, not merely looked up: it goes into responses, and nothing a caller sends gets there unvetted
 */
export function parseRunPath(url: string): { readonly ok: true; readonly sessionId: string } | { readonly ok: false } | undefined {
	const path = url.split('?')[0];
	if (!path.startsWith(RUN_PATH_PREFIX)) {
		return undefined;
	}
	const sessionId = path.slice(RUN_PATH_PREFIX.length);
	return SESSION_ID_IN_PATH.test(sessionId) ? { ok: true, sessionId } : { ok: false };
}
