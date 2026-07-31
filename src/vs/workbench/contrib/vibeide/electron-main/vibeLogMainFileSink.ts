/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// `vibeLog` is a per-process module singleton: the renderer instance and the main-process
// instance are DIFFERENT objects with separate ring buffers and sinks. The renderer wires a
// file sink in `vibeLogOutputChannel.ts`, but that only captures renderer-side lines — every
// `vibeLog.*` call made in electron-main (modelsDevCatalog, update service, voice/video, …)
// goes to console.* only, which Electron routes to stdout and is lost once the app exits.
// This installs a persistent file sink on the MAIN instance so those diagnostics survive to
// `<logsHome>/vibeide-main.log`. Kept in a separate file from the renderer's `vibeide.log`:
// two processes appending to one file concurrently would interleave into garbage.

import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { vibeLog, formatVibeLogEntry } from '../common/vibeLog.js';

const MAIN_LOG_FILENAME = 'vibeide-main.log';

/**
 * Mirror the main-process `vibeLog` singleton into `<logsDir>/vibeide-main.log`.
 * Best-effort: any failure to open the stream is swallowed (logging must never break the
 * app), and callers get an `IDisposable` that detaches the sink and closes the stream.
 *
 * @param logsDir Absolute path to the session logs directory (`environmentMainService.logsHome.fsPath`).
 */
export function installVibeLogMainFileSink(logsDir: string): IDisposable {
	let stream: fs.WriteStream;
	try {
		fs.mkdirSync(logsDir, { recursive: true });
		// `flags: 'a'` — append; the logs dir is per-session so the file starts empty anyway,
		// but appending is the correct, restart-safe default.
		stream = fs.createWriteStream(path.join(logsDir, MAIN_LOG_FILENAME), { flags: 'a' });
	} catch {
		// Could not open the log file (no logs dir, EPERM, ENOSPC). Diagnostics are an
		// optimisation, not a correctness requirement — degrade to console-only.
		return toDisposable(() => { /* nothing to clean up */ });
	}
	// A stream error after open (disk full mid-run, etc.) must not crash the process; swallow.
	stream.on('error', () => { /* best-effort file logging */ });

	const write = (entry: Parameters<typeof formatVibeLogEntry>[0]): void => {
		stream.write(formatVibeLogEntry(entry) + '\n');
	};

	// Flush the ring buffer first: lines logged before this sink was installed (early main
	// startup) are already in the buffer and would otherwise never reach the file.
	for (const entry of vibeLog.getRecentEntries()) { write(entry); }

	const detach = vibeLog.addSink(write);
	return toDisposable(() => {
		detach();
		stream.end();
	});
}
