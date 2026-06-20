/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
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
	private _audioCtx: AudioContext | undefined;
	// Decoded PCM keyed by source identity ("default|<id>" or "custom|<uri>|<mtime>|<size>").
	private readonly _bufferCache = new Map<string, AudioBuffer>();

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IHostService private readonly _hostService: IHostService,
	) {
		super();
		// The workbench window sets `autoplayPolicy: 'user-gesture-required'` (windows.ts), so a bare
		// HTMLAudioElement.play() on an ASYNC event (turn end) is blocked ("play() can only be initiated
		// by a user gesture"). Web Audio sidesteps this if the AudioContext is resumed inside a real user
		// gesture; once running it plays async sounds freely. Resume it on the first interaction.
		const unlock = () => { void this._ensureUnlocked(); };
		this._register(addDisposableListener(mainWindow, 'pointerdown', unlock, true));
		this._register(addDisposableListener(mainWindow, 'keydown', unlock, true));
		this._register(toDisposable(() => { try { void this._audioCtx?.close(); } catch { /* ignore */ } }));
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

	private _ensureCtx(): AudioContext | undefined {
		if (!this._audioCtx) {
			try {
				const Ctor: typeof AudioContext | undefined = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
				if (!Ctor) { return undefined; }
				this._audioCtx = new Ctor();
			} catch (err) {
				vibeLog.warn('notifySound', `AudioContext unavailable: ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			}
		}
		return this._audioCtx;
	}

	private async _ensureUnlocked(): Promise<void> {
		const ctx = this._ensureCtx();
		if (ctx && ctx.state === 'suspended') {
			try { await ctx.resume(); } catch { /* still locked until a real gesture */ }
		}
	}

	private async _resolveAndPlay(soundIdOverride?: string): Promise<void> {
		try {
			const ctx = this._ensureCtx();
			if (!ctx) { return; }
			await this._ensureUnlocked();
			const buffer = await this._resolveBuffer(ctx, soundIdOverride);
			if (!buffer) { return; }
			const source = ctx.createBufferSource();
			source.buffer = buffer;
			const gain = ctx.createGain();
			gain.gain.value = this._readVolume();
			source.connect(gain);
			gain.connect(ctx.destination);
			source.start();
		} catch (err) {
			// Decode errors, a removed custom file, or a still-locked context land here — never throw.
			vibeLog.warn('notifySound', `failed to play notification sound: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Resolve the configured sound to a decoded AudioBuffer (cached). Custom files validated + fall back to default. */
	private async _resolveBuffer(ctx: AudioContext, soundIdOverride?: string): Promise<AudioBuffer | undefined> {
		const selected = soundIdOverride ?? this._configurationService.getValue<string>('vibeide.notify.sound.sound') ?? NOTIFY_DEFAULT_SOUND_ID;

		let key: string;
		let fileUri: URI;
		if (selected === 'custom') {
			const resolved = await this._resolveCustomFile();
			if (!resolved) {
				vibeLog.warn('notifySound', 'custom sound unavailable — falling back to the default sound');
				key = `default|${NOTIFY_DEFAULT_SOUND_ID}`;
				fileUri = FileAccess.asFileUri(`${DEFAULT_SOUND_DIR}/${NOTIFY_DEFAULT_SOUND_ID}.mp3`);
			} else {
				key = resolved.key;
				fileUri = resolved.uri;
			}
		} else {
			const id = (NOTIFY_DEFAULT_SOUND_IDS as readonly string[]).includes(selected) ? selected as NotifyDefaultSoundId : NOTIFY_DEFAULT_SOUND_ID;
			key = `default|${id}`;
			fileUri = FileAccess.asFileUri(`${DEFAULT_SOUND_DIR}/${id}.mp3`);
		}

		const cached = this._bufferCache.get(key);
		if (cached) { return cached; }

		const content = await this._fileService.readFile(fileUri);
		const bytes = content.value.buffer;
		// decodeAudioData needs an ArrayBuffer (not a possibly-shared Uint8Array view) — copy.
		const arrayBuffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(arrayBuffer).set(bytes);
		const buffer = await ctx.decodeAudioData(arrayBuffer);
		this._bufferCache.set(key, buffer);
		return buffer;
	}

	/** Validate the configured custom file (format + size) and return its URI + cache key, or undefined. */
	private async _resolveCustomFile(): Promise<{ uri: URI; key: string } | undefined> {
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
			return { uri, key: `custom|${uri.toString()}|${stat.mtime ?? 0}|${stat.size ?? 0}` };
		} catch (err) {
			vibeLog.warn('notifySound', `custom sound unreadable: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private _extOf(path: string): string {
		const dot = path.lastIndexOf('.');
		return dot < 0 ? '' : path.slice(dot).toLowerCase();
	}
}

registerSingleton(IVibeNotifySoundService, VibeNotifySoundService, InstantiationType.Delayed);
