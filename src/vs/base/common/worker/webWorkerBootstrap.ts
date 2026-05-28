/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWebWorkerServerRequestHandler, IWebWorkerServerRequestHandlerFactory, WebWorkerServer } from './webWorker.js';
import { vibeTimestamp } from '../vibeTimestamp.js';

type MessageEvent = {
	data: unknown;
};

declare const globalThis: {
	postMessage: (message: any) => void;
	onmessage: (event: MessageEvent) => void;
};

// VibeIDE: web workers run in a separate realm, so the renderer's console
// timestamp/redaction wrappers never reach them -- worker console output was the
// one place without a date-time. This is the single entry point for every worker
// (language detection, textmate, editor, search, ...), so stamp the worker console
// here once. Prefix only: no new lines are emitted, so existing noise is unchanged.
let consoleStamped = false;
function stampWorkerConsole(): void {
	if (consoleStamped) { return; }
	consoleStamped = true;
	const c = (typeof console !== 'undefined' ? console : undefined) as Record<string, ((...args: any[]) => void) | undefined> | undefined;
	if (!c) { return; }
	for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
		const original = c[method];
		if (typeof original !== 'function') { continue; }
		c[method] = (...args: any[]) => original.apply(c, [`[${vibeTimestamp()}] [worker]`, ...args]);
	}
}
stampWorkerConsole();

let initialized = false;

export function initialize<T extends IWebWorkerServerRequestHandler>(factory: IWebWorkerServerRequestHandlerFactory<T>) {
	if (initialized) {
		throw new Error('WebWorker already initialized!');
	}
	initialized = true;

	const webWorkerServer = new WebWorkerServer<T>(
		msg => globalThis.postMessage(msg),
		(workerServer) => factory(workerServer)
	);

	globalThis.onmessage = (e: MessageEvent) => {
		webWorkerServer.onmessage(e.data);
	};

	return webWorkerServer;
}

export function bootstrapWebWorker(factory: IWebWorkerServerRequestHandlerFactory<any>) {
	globalThis.onmessage = (_e: MessageEvent) => {
		// Ignore first message in this case and initialize if not yet initialized
		if (!initialized) {
			initialize(factory);
		}
	};
}
