/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
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
// Decoders round duration slightly (a nominal 5.0s file may decode to ~5.02s); a small tolerance
// keeps the UI validator and the runtime gate from disagreeing on borderline files.
const NOTIFY_CUSTOM_DURATION_TOLERANCE_SEC = 0.5;
export const NOTIFY_CUSTOM_ALLOWED_EXTS = ['.mp3', '.ogg', '.wav'] as const;

// Upper bound on a file the user loads INTO the sound editor (before trimming). The editor decodes
// the whole file into memory to draw the waveform, so this caps memory and rejects hour-long tracks;
// the SAVED clip is still bound by the ≤5s / ≤1MB acceptance rules above.
export const NOTIFY_EDITOR_MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20 MB

// Folder (next to the user-data dir) where user-saved custom sounds live.
const NOTIFY_SOUNDS_DIR_NAME = 'sounds';

// Result of validating a user-picked custom sound file against the acceptance rules.
export interface NotifyCustomValidation {
	readonly ok: boolean;
	/** Russian, user-facing reason when `ok` is false. */
	readonly reason?: string;
	/** Decoded duration in seconds when it could be measured. */
	readonly durationSec?: number;
}

/** A user-saved custom sound found in the sounds folder. */
export interface NotifyCustomSound {
	readonly name: string;
	readonly uri: URI;
}

// Anti-spam: never play more than one sound within this window (local, self-evident).
const MIN_PLAY_INTERVAL_MS = 1500;

export interface IVibeNotifySoundService {
	readonly _serviceBrand: undefined;
	/** Play the configured sound for a state-transition event, honoring all gates (enabled, per-event, focus, debounce). */
	playForEvent(event: NotifySoundEvent): void;
	/**
	 * Play a sound ignoring gates — used by the settings preview. With no args, plays the configured
	 * selection. `soundId` previews a specific default; `customPathOverride` previews an as-yet-unsaved
	 * custom file (settings "Browse" flow), bypassing the stored `customPath`.
	 */
	preview(soundId?: string, customPathOverride?: string): void;
	/** Validate a user-picked custom sound file against the acceptance rules (format + size + duration). */
	validateCustomFile(path: string): Promise<NotifyCustomValidation>;
	/** Absolute folder where user-saved custom sounds live (created on first use). */
	ensureSoundsDir(): Promise<URI>;
	/** List user-saved custom sounds (allowed audio files in the sounds folder). Never throws. */
	listCustomSounds(): Promise<NotifyCustomSound[]>;
	/** Save bytes as a custom sound in the sounds folder; returns the written file URI. */
	saveCustomSound(fileName: string, bytes: Uint8Array): Promise<URI>;
	/** Delete a user-saved custom sound by URI. Never throws. */
	deleteCustomSound(uri: URI): Promise<void>;
}

export const IVibeNotifySoundService = createDecorator<IVibeNotifySoundService>('vibeNotifySoundService');

class VibeNotifySoundService extends Disposable implements IVibeNotifySoundService {
	declare readonly _serviceBrand: undefined;

	private _lastPlayedAt = 0;
	private _audioCtx: AudioContext | undefined;
	// Decoded PCM keyed by source identity ("default|<id>" or "custom|<uri>|<mtime>|<size>").
	private readonly _bufferCache = new Map<string, AudioBuffer>();
	// Resolved + created sounds folder, cached after the first successful ensureSoundsDir().
	private _soundsDir: URI | undefined;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
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

	preview(soundId?: string, customPathOverride?: string): void {
		this._lastPlayedAt = Date.now();
		void this._resolveAndPlay(soundId, customPathOverride);
	}

	async validateCustomFile(path: string): Promise<NotifyCustomValidation> {
		if (!path || typeof path !== 'string' || path.trim().length === 0) {
			return { ok: false, reason: 'Путь к файлу не указан.' };
		}

		const ext = this._extOf(path);
		if (!(NOTIFY_CUSTOM_ALLOWED_EXTS as readonly string[]).includes(ext)) {
			return { ok: false, reason: `Формат «${ext || '—'}» не поддерживается. Допустимы: ${NOTIFY_CUSTOM_ALLOWED_EXTS.join(', ')}.` };
		}

		let uri: URI;
		try {
			uri = URI.file(path);
			const stat = await this._fileService.stat(uri);
			if (typeof stat.size === 'number' && stat.size > NOTIFY_CUSTOM_MAX_BYTES) {
				const mb = (stat.size / (1024 * 1024)).toFixed(1);
				return { ok: false, reason: `Размер ${mb} МБ превышает лимит 1 МБ.` };
			}
		} catch (err) {
			return { ok: false, reason: `Файл недоступен: ${err instanceof Error ? err.message : String(err)}` };
		}

		// Duration is the rule that can only be checked by decoding. Without an AudioContext (rare) we
		// accept on format + size — best effort, the runtime gate re-checks before playback.
		const ctx = this._ensureCtx();
		if (!ctx) { return { ok: true }; }
		try {
			const buffer = await this._decodeFile(ctx, uri);
			if (buffer.duration > NOTIFY_CUSTOM_MAX_DURATION_SEC + NOTIFY_CUSTOM_DURATION_TOLERANCE_SEC) {
				return { ok: false, reason: `Длительность ${buffer.duration.toFixed(1)} с превышает лимит ${NOTIFY_CUSTOM_MAX_DURATION_SEC} с.`, durationSec: buffer.duration };
			}
			return { ok: true, durationSec: buffer.duration };
		} catch (err) {
			return { ok: false, reason: `Не удалось декодировать аудио: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	private _readVolume(): number {
		const raw = this._configurationService.getValue<unknown>('vibeide.notify.sound.volume');
		const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0.6;
		return Math.min(1, Math.max(0, v));
	}

	private _ensureCtx(): AudioContext | undefined {
		if (!this._audioCtx) {
			try {
				const audioGlobal = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
				const Ctor: typeof AudioContext | undefined = audioGlobal.AudioContext ?? audioGlobal.webkitAudioContext;
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

	private async _resolveAndPlay(soundIdOverride?: string, customPathOverride?: string): Promise<void> {
		try {
			const ctx = this._ensureCtx();
			if (!ctx) { return; }
			await this._ensureUnlocked();
			const buffer = await this._resolveBuffer(ctx, soundIdOverride, customPathOverride);
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

	/** Resolve the selection to a decoded AudioBuffer (cached). Custom files validated (format/size/duration) + fall back to default. */
	private async _resolveBuffer(ctx: AudioContext, soundIdOverride?: string, customPathOverride?: string): Promise<AudioBuffer | undefined> {
		// An explicit custom-path override (settings "Browse" preview) always takes the custom branch.
		const selected = customPathOverride ? 'custom' : (soundIdOverride ?? this._configurationService.getValue<string>('vibeide.notify.sound.sound') ?? NOTIFY_DEFAULT_SOUND_ID);

		if (selected === 'custom') {
			const resolved = await this._resolveCustomFile(customPathOverride);
			if (resolved) {
				const buffer = await this._getDecoded(ctx, resolved.key, resolved.uri);
				// Runtime duration gate: enforce the same limit the settings validator applies, so a
				// too-long file that slipped into settings.json by hand never plays full-length.
				if (buffer.duration <= NOTIFY_CUSTOM_MAX_DURATION_SEC + NOTIFY_CUSTOM_DURATION_TOLERANCE_SEC) {
					return buffer;
				}
				vibeLog.warn('notifySound', `custom sound rejected: duration ${buffer.duration.toFixed(1)}s exceeds limit ${NOTIFY_CUSTOM_MAX_DURATION_SEC}s — falling back to the default sound`);
			} else {
				vibeLog.warn('notifySound', 'custom sound unavailable — falling back to the default sound');
			}
			return this._getDecoded(ctx, `default|${NOTIFY_DEFAULT_SOUND_ID}`, FileAccess.asFileUri(`${DEFAULT_SOUND_DIR}/${NOTIFY_DEFAULT_SOUND_ID}.mp3`));
		}

		const id = (NOTIFY_DEFAULT_SOUND_IDS as readonly string[]).includes(selected) ? selected as NotifyDefaultSoundId : NOTIFY_DEFAULT_SOUND_ID;
		return this._getDecoded(ctx, `default|${id}`, FileAccess.asFileUri(`${DEFAULT_SOUND_DIR}/${id}.mp3`));
	}

	/** Read + decode a file into a cached AudioBuffer keyed by source identity. */
	private async _getDecoded(ctx: AudioContext, key: string, fileUri: URI): Promise<AudioBuffer> {
		const cached = this._bufferCache.get(key);
		if (cached) { return cached; }
		const buffer = await this._decodeFile(ctx, fileUri);
		this._bufferCache.set(key, buffer);
		return buffer;
	}

	/** Read a file via IFileService and decode it to PCM (no caching — caller decides). */
	private async _decodeFile(ctx: AudioContext, fileUri: URI): Promise<AudioBuffer> {
		const content = await this._fileService.readFile(fileUri);
		const bytes = content.value.buffer;
		// decodeAudioData needs an ArrayBuffer (not a possibly-shared Uint8Array view) — copy.
		const arrayBuffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(arrayBuffer).set(bytes);
		return ctx.decodeAudioData(arrayBuffer);
	}

	/** Validate the custom file (format + size) and return its URI + cache key, or undefined. Path = override or configured. */
	private async _resolveCustomFile(pathOverride?: string): Promise<{ uri: URI; key: string } | undefined> {
		const path = pathOverride ?? this._configurationService.getValue<string>('vibeide.notify.sound.customPath');
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

	// ── User-saved custom sounds (sounds folder, sibling of the user-data dir) ──────────────

	async ensureSoundsDir(): Promise<URI> {
		if (this._soundsDir) { return this._soundsDir; }

		// logsHome = <userData>/logs/<session>; two dirnames up = <userData>. The user asked for the
		// sounds folder "next to data", i.e. a sibling of the user-data dir.
		const userData = dirname(dirname(this._environmentService.logsHome));
		const sibling = joinPath(dirname(userData), NOTIFY_SOUNDS_DIR_NAME);
		const inside = joinPath(userData, NOTIFY_SOUNDS_DIR_NAME);

		// Prefer the sibling location; fall back to inside the user-data dir if the parent is not
		// writable (e.g. an installed build under Program Files) — never let folder setup crash.
		for (const candidate of [sibling, inside]) {
			try {
				await this._fileService.createFolder(candidate);
				this._soundsDir = candidate;
				return candidate;
			} catch (err) {
				vibeLog.warn('notifySound', `sounds dir not usable at ${candidate.toString()}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		// Both failed — return the sibling URI anyway so callers have a path; writes will surface errors.
		this._soundsDir = sibling;
		return sibling;
	}

	async listCustomSounds(): Promise<NotifyCustomSound[]> {
		try {
			const dir = await this.ensureSoundsDir();
			const stat = await this._fileService.resolve(dir);
			const out: NotifyCustomSound[] = [];
			for (const child of stat.children ?? []) {
				if (child.isDirectory) { continue; }
				if (!(NOTIFY_CUSTOM_ALLOWED_EXTS as readonly string[]).includes(this._extOf(child.name))) { continue; }
				out.push({ name: child.name, uri: child.resource });
			}
			return out.sort((a, b) => a.name.localeCompare(b.name));
		} catch (err) {
			vibeLog.warn('notifySound', `failed to list custom sounds: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	async saveCustomSound(fileName: string, bytes: Uint8Array): Promise<URI> {
		const dir = await this.ensureSoundsDir();
		const safe = this._sanitizeFileName(fileName);
		const target = joinPath(dir, safe);
		await this._fileService.writeFile(target, VSBuffer.wrap(bytes));
		// A re-saved file under the same name keeps the old key in the decode cache — drop stale entries.
		for (const key of [...this._bufferCache.keys()]) {
			if (key.startsWith(`custom|${target.toString()}|`)) { this._bufferCache.delete(key); }
		}
		return target;
	}

	async deleteCustomSound(uri: URI): Promise<void> {
		try {
			await this._fileService.del(uri);
		} catch (err) {
			vibeLog.warn('notifySound', `failed to delete custom sound ${uri.toString()}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Keep only a safe basename with an allowed audio extension (defaults to .wav). */
	private _sanitizeFileName(name: string): string {
		const base = (name.split(/[\\/]/).pop() ?? 'sound').replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^_+/, '').slice(0, 80);
		const stem = base.length > 0 ? base : 'sound';
		const ext = this._extOf(stem);
		return (NOTIFY_CUSTOM_ALLOWED_EXTS as readonly string[]).includes(ext) ? stem : `${stem}.wav`;
	}
}

registerSingleton(IVibeNotifySoundService, VibeNotifySoundService, InstantiationType.Delayed);
