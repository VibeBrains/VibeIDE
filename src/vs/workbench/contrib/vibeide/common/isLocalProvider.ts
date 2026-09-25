/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ProviderId, SettingsOfProvider } from './vibeideSettingsTypes.js';

/** Hosts that name this machine; the shared set lists the same four (`testVectors/providerAuth.json`) */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * The address points at this machine
 * An IPv6 host comes back from `URL` in brackets (`[::1]`), so a bare `::1` never matched it
 * `0.0.0.0` counts: servers print it as their listen address, and a request to it reaches this machine
 */
export function isLocalAddress(address: string | undefined): boolean {
	if (!address) { return false; }
	try {
		const hostname = new URL(address).hostname.replace(/^\[(.*)\]$/, '$1');
		return LOCAL_HOSTS.has(hostname);
	} catch {
		return false;
	}
}

/** A provider file entry's models run on this machine: its `runsLocally`, or by the address when it says nothing */
export function runsLocallyOf(entry: { readonly runsLocally?: boolean; readonly baseURL?: string }): boolean {
	return typeof entry.runsLocally === 'boolean' ? entry.runsLocally : isLocalAddress(entry.baseURL);
}

/** What `isLocalProvider` reads from a provider's settings: the declaration first, then the address */
interface LocalitySettings {
	/** The provider file's `runsLocally`, or its default by address — see `runsLocallyOf` */
	readonly runsLocally?: boolean;
	/** A built-in's endpoint, or a file provider's base URL on its settings seed */
	readonly endpoint?: string;
	/** A file provider's base URL on its send-time transport, which replaces the seed in electron-main */
	readonly baseURL?: string;
}

/**
 * The provider's models run on this machine — what local-model optimizations, timeouts and privacy hints decide on
 * Not the same question as «the server is on this machine» (`isLocalAddress`): a localhost proxy to a cloud model is
 * local by address and remote by model, so the provider file's `runsLocally` has the last word
 * Pure predicate with no browser dependencies — lives in common/ so pure-helper tests can import it
 */
export function isLocalProvider(providerName: ProviderId, settingsOfProvider: SettingsOfProvider): boolean {
	const settings = (settingsOfProvider as Readonly<Record<string, LocalitySettings | undefined>>)[providerName];
	if (typeof settings?.runsLocally === 'boolean') { return settings.runsLocally; }
	if (providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio') { return true; }
	return isLocalAddress(settings?.endpoint || settings?.baseURL);
}
