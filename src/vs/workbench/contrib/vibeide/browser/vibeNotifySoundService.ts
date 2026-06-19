/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { vibeLog } from '../common/vibeLog.js';

// Events that move the IDE into a "waiting for the user / work not proceeding" state.
export type NotifySoundEvent = 'complete' | 'stalled' | 'awaiting_user';

// Bundled default sounds reuse short MP3 cues already shipped (and copied to out-build)
// under the accessibility-signal media folder — zero new assets, zero packaging changes.
const DEFAULT_SOUND_DIR = 'vs/platform/accessibilitySignal/browser/media';
export const NOTIFY_DEFAULT_SOUND_IDS = ['taskCompleted', 'success', 'chatUserActionRequired', 'terminalBell', 'break'] as const;
export type NotifyDefaultSoundId = typeof NOTIFY_DEFAULT_SOUND_IDS[number];
const NOTIFY_DEFAULT_SOUND_ID: NotifyDefaultSoundId = 'taskCompleted';

// Custom-file acceptance rules (product rules, intentionally not user-configurable).
export const NOTIFY_CUSTOM_MAX_BYTES = 1024 * 1024; // 1 MB
export const NOTIFY_CUSTOM_MAX_DURATION_SEC = 5;
export const NOTIFY_CUSTOM_ALLOWED_EXTS = ['.mp3', '.ogg', '.wav'] as const;

// Anti-spam: never play more than one sound within this window (local, self-evident).
const MIN_PLAY_INTERVAL_MS = 1500;

export interface IVibeNotifySoundService {
	readonly _serviceBrand: undefined;
	/** Play the configured sound for a state-transition event, honoring all gates (enabled, per-event, focus, debounce). */
	playForEvent(event: NotifySoundEvent): void;
	/** Play the currently-selected sound ignoring gates — used by the settings preview. */
	preview(soundId?: string): void;
}

export const IVibeNotifySoundService = createDecorator<IVibeNotifySoundService>('vibeNotifySoundService');

class VibeNotifySoundService extends Disposable implements IVibeNotifySoundService {
	declare readonly _serviceBrand: undefined;

	private _lastPlayedAt = 0;
	// Cache custom-file blob URLs keyed by "path|mtime|size" so we read the file once.
	private _customBlobCache: { key: string; url: string } | undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IHostService private readonly _hostService: IHostService,
	) {
		super();
		this._register({ dispose: () => this._revokeCustomBlob() });
	}

	playForEvent(event: NotifySoundEvent): void {
		if (this._configurationService.getValue<boolean>('vibeide.notify.sound.enabled') === false) { return; }

		const eventKey = event === 'complete' ? 'vibeide.notify.sound.onComplete'
			: event === 'stalled' ? 'vibeide.notify.sound.onStalled'
				: 'vibeide.notify.sound.onAwaitingUser';
		if (this._configurationService.getValue<boolean>(eventKey) === false) { return; }

		// Phone-like behavior: alert only when the user is away (IDE not focused).
		if (this._configurationService.getValue<boolean>('vibeide.notify.sound.muteWhenFocused') !== false
			&& this._hostService.hasFocus) {
			return;
		}

		const now = Date.now();
		if (now - this._lastPlayedAt < MIN_PLAY_INTERVAL_MS) { return; }
		this._lastPlayedAt = now;

		void this._resolveAndPlay();
	}

	preview(soundId?: string): void {
		this._lastPlayedAt = Date.now();
		void this._resolveAndPlay(soundId);
	}

	private _readVolume(): number {
		const raw = this._configurationService.getValue<unknown>('vibeide.notify.sound.volume');
		const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0.6;
		return Math.min(1, Math.max(0, v));
	}

	private async _resolveAndPlay(soundIdOverride?: string): Promise<void> {
		try {
			const url = await this._resolveSoundUrl(soundIdOverride);
			if (!url) { return; }
			const audio = new Audio(url);
			audio.volume = this._readVolume();
			await audio.play();
		} catch (err) {
			// Autoplay restrictions, decode errors, or a removed custom file land here — never throw to the caller.
			vibeLog.warn('notifySound', `failed to play notification sound: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _resolveSoundUrl(soundIdOverride?: string): Promise<string | undefined> {
		const selected = soundIdOverride ?? this._configurationService.getValue<string>('vibeide.notify.sound.sound') ?? NOTIFY_DEFAULT_SOUND_ID;

		if (selected === 'custom') {
			const custom = await this._resolveCustomUrl();
			if (custom) { return custom; }
			// Misconfigured custom file: fall back to a default so the user still gets a notification.
			vibeLog.warn('notifySound', 'custom sound unavailable — falling back to the default sound');
			return this._defaultUrl(NOTIFY_DEFAULT_SOUND_ID);
		}

		const id = (NOTIFY_DEFAULT_SOUND_IDS as readonly string[]).includes(selected) ? selected as NotifyDefaultSoundId : NOTIFY_DEFAULT_SOUND_ID;
		return this._defaultUrl(id);
	}

	private _defaultUrl(id: NotifyDefaultSoundId): string {
		return FileAccess.asBrowserUri(`${DEFAULT_SOUND_DIR}/${id}.mp3`).toString(true);
	}

	private async _resolveCustomUrl(): Promise<string | undefined> {
		const path = this._configurationService.getValue<string>('vibeide.notify.sound.customPath');
		if (!path || typeof path !== 'string' || path.trim().length === 0) { return undefined; }

		const ext = this._extOf(path);
		if (!(NOTIFY_CUSTOM_ALLOWED_EXTS as readonly string[]).includes(ext)) {
			vibeLog.warn('notifySound', `custom sound rejected: unsupported format "${ext}" (allowed: ${NOTIFY_CUSTOM_ALLOWED_EXTS.join(', ')})`);
			return undefined;
		}

		try {
			const uri = URI.file(path);
			const stat = await this._fileService.stat(uri);
			if (typeof stat.size === 'number' && stat.size > NOTIFY_CUSTOM_MAX_BYTES) {
				vibeLog.warn('notifySound', `custom sound rejected: ${stat.size} bytes exceeds limit ${NOTIFY_CUSTOM_MAX_BYTES}`);
				return undefined;
			}

			const cacheKey = `${uri.toString()}|${stat.mtime ?? 0}|${stat.size ?? 0}`;
			if (this._customBlobCache?.key === cacheKey) { return this._customBlobCache.url; }

			const content = await this._fileService.readFile(uri);
			// Copy into a fresh ArrayBuffer so the Blob part is unambiguously ArrayBuffer-backed.
			const bytes = content.value.buffer;
			const arrayBuffer = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(arrayBuffer).set(bytes);
			const blob = new Blob([arrayBuffer], { type: this._mimeForExt(ext) });
			const url = URL.createObjectURL(blob);
			this._revokeCustomBlob();
			this._customBlobCache = { key: cacheKey, url };
			return url;
		} catch (err) {
			vibeLog.warn('notifySound', `custom sound unreadable: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private _revokeCustomBlob(): void {
		if (this._customBlobCache) {
			try { URL.revokeObjectURL(this._customBlobCache.url); } catch { /* ignore */ }
			this._customBlobCache = undefined;
		}
	}

	private _extOf(path: string): string {
		const dot = path.lastIndexOf('.');
		return dot < 0 ? '' : path.slice(dot).toLowerCase();
	}

	private _mimeForExt(ext: string): string {
		return ext === '.ogg' ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
	}
}

registerSingleton(IVibeNotifySoundService, VibeNotifySoundService, InstantiationType.Delayed);
