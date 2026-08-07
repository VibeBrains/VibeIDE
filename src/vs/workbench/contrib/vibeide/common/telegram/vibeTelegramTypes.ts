/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Telegram bridge — shared contracts.
 *
 * Pure data shapes and the channel protocol. No node/browser/electron imports: the renderer
 * (window side) and the main process (the poller) both speak these types over IPC.
 *
 * Architecture, and why it looks like this (see docs/manuals/telegramBridge.md):
 *
 * - **Every user runs their own bot.** The IDE sits on a personal machine with no public
 *   address, so Telegram webhooks are impossible and long polling is used instead. Long
 *   polling needs no server of ours at all — a shared bot would only save the user one trip
 *   to @BotFather while routing their code and tasks through our infrastructure.
 * - **The poller lives in the main process**, not in a window. There is exactly one main
 *   process per application, so two open windows cannot both call `getUpdates` — Telegram
 *   answers the second caller with 409 Conflict and the bridge goes silent. Windows register
 *   themselves with the main process and receive the commands addressed to them.
 * - **A chat must be bound before it can do anything.** Anyone who learns the bot's name can
 *   message it; without binding, that would be tool execution on the owner's machine.
 */

import { Event } from '../../../../../base/common/event.js';

export const VIBE_TELEGRAM_CHANNEL = 'vibeide-channel-telegram';

/** Configuration keys of the bridge. The bot token is NOT here — it lives in SecretStorage. */
export const VibeTelegramConfigKeys = {
	section: 'vibeide.telegram',
	enabled: 'vibeide.telegram.enabled',
	allowedChatIds: 'vibeide.telegram.allowedChatIds',
	pairingCode: 'vibeide.telegram.pairingCode',
	proxyUrl: 'vibeide.telegram.proxy.url',
	progressIntervalMs: 'vibeide.telegram.progressIntervalMs',
} as const;

/** SecretStorage key holding the bot token issued by @BotFather. */
export const VIBE_TELEGRAM_TOKEN_SECRET_KEY = 'vibeide.telegram.botToken';

/** Default gap between progress updates of a long run, in milliseconds. */
export const VIBE_TELEGRAM_PROGRESS_INTERVAL_MS = 20000;

/**
 * How long an approval request waits for an answer before it is treated as a refusal.
 * Silence must never mean "yes": the phone may be in a pocket, or the chat muted.
 */
export const VIBE_TELEGRAM_APPROVAL_TIMEOUT_MS = 300000;

/** A window that registered itself as able to serve Telegram commands. */
export interface VibeTelegramWindow {
	/** Electron window id — the address the main process routes commands to. */
	readonly windowId: number;
	/** Human name of the open project (folder name), or undefined for an empty window. */
	readonly projectName: string | undefined;
	/** Absolute path of the open workspace folder, or undefined for an empty window. */
	readonly projectPath: string | undefined;
}

/** One inbound message, already reduced to what the bridge needs. */
export interface VibeTelegramInbound {
	readonly chatId: number;
	/** Telegram's own message id — needed to edit a message in place instead of spamming new ones. */
	readonly messageId: number;
	/** Text of the message, or the transcript of a voice message. */
	readonly text: string;
	/** Set when the message arrived as voice and still has to be transcribed locally. */
	readonly voiceFileId?: string;
	/** Display name of the sender, for the binding prompt shown in the IDE. */
	readonly from?: string;
}

/** A command the main process routed to a window for execution. */
export interface VibeTelegramCommandForWindow {
	readonly chatId: number;
	readonly text: string;
	/**
	 * Set when the message arrived as voice: the window downloads it through the bridge and
	 * transcribes it locally, then treats the transcript as the command text.
	 */
	readonly voiceFileId?: string;
}

/** Outbound message the window asks the main process to deliver. */
export interface VibeTelegramOutbound {
	readonly chatId: number;
	readonly text: string;
	/**
	 * When set, the existing message is edited instead of a new one being sent — this is what
	 * keeps a long run from producing a wall of progress messages.
	 */
	readonly editMessageId?: number;
	/** Renders "allow / deny" buttons; the answer arrives as an approval reply. */
	readonly approval?: { readonly token: string };
}

/** Result of delivering an outbound message. */
export interface VibeTelegramDelivery {
	readonly ok: boolean;
	/** Telegram message id of the sent message — pass it back as `editMessageId` to update it. */
	readonly messageId?: number;
	/** Human-readable reason, in Russian, when `ok` is false. */
	readonly error?: string;
}

/** Outcome of transcribing one voice message. */
export type VibeTelegramTranscription =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly reason: string };

/**
 * What voice input still needs. Both parts are downloaded on demand and shared with other
 * features: `ffmpeg` comes with the video tools (`/watch`), the model with offline speech.
 */
export interface VibeTelegramVoiceReadiness {
	readonly state: 'ready' | 'needsDownload' | 'downloading' | 'unsupported';
	/** Total megabytes still to download, for an honest prompt before it starts. */
	readonly downloadMb: number;
	/** Human-readable detail in Russian for the settings panel. */
	readonly detail: string;
}

/** State of the bridge, mirrored into the IDE UI. */
export interface VibeTelegramStatus {
	readonly state: 'off' | 'connecting' | 'listening' | 'error';
	/** Bot username (`@my_bot`) once known — proof that the token works. */
	readonly botUsername?: string;
	/** Human-readable reason, in Russian, when `state` is 'error'. */
	readonly error?: string;
}

/** Main-process side of the bridge, called from windows. */
export interface IVibeTelegramMain {
	readonly onDidChangeStatus: Event<VibeTelegramStatus>;
	/** Fires when a bound chat sent a command that this window should execute. */
	readonly onDidReceiveCommand: Event<VibeTelegramCommandForWindow & { readonly windowId: number }>;
	/** Fires when an unknown chat wrote to the bot and the owner has to allow or refuse it. */
	readonly onDidRequestBinding: Event<{ readonly chatId: number; readonly from: string | undefined }>;
	/** Fires when a bound chat answered an approval request. */
	readonly onDidAnswerApproval: Event<{ readonly token: string; readonly approved: boolean }>;

	/**
	 * Pushes token, proxy and the allow-list into the poller. Configuration and SecretStorage
	 * live on the window side, so the main process is told rather than reading them itself.
	 */
	setConfig(config: { readonly token: string | undefined; readonly proxyUrl: string | undefined; readonly allowedChatIds: readonly number[]; readonly pairingCode: string; readonly voiceProfile: 'ru' | 'en' }): Promise<void>;
	/** Windows currently able to serve commands — the answer to `/projects`. */
	listWindows(): Promise<readonly VibeTelegramWindow[]>;
	/** Points a chat at a window; subsequent commands from that chat go there. */
	bindChatToWindow(chatId: number, windowId: number): Promise<void>;
	/** (Re)starts polling with the current token and settings; no-op when disabled. */
	start(): Promise<VibeTelegramStatus>;
	/** Stops polling and forgets the in-flight state. */
	stop(): Promise<void>;
	getStatus(): Promise<VibeTelegramStatus>;
	/** A window announces itself (and its project) as a command target. */
	registerWindow(window: VibeTelegramWindow): Promise<void>;
	unregisterWindow(windowId: number): Promise<void>;
	/** Delivers a message to a chat. */
	send(message: VibeTelegramOutbound): Promise<VibeTelegramDelivery>;
	/** Downloads a voice message and returns its bytes for local transcription. */
	downloadVoice(fileId: string): Promise<VSBufferLike | undefined>;
	/**
	 * Downloads a voice message and transcribes it locally (ffmpeg decode + offline STT).
	 * Never throws: an unusable result comes back as a reason in Russian, because the only
	 * place it can be shown is the chat the voice came from.
	 */
	transcribeVoice(fileId: string): Promise<VibeTelegramTranscription>;
	/** Whether voice input is usable right now, and what is missing if not. */
	getVoiceReadiness(): Promise<VibeTelegramVoiceReadiness>;
	/** Downloads the voice components up front, so the first voice message is not a wait. */
	prepareVoice(): Promise<void>;
}

/**
 * Voice payload crossing IPC. Typed structurally to keep this file free of `VSBuffer`'s
 * module, which would pull a concrete implementation into a pure contract.
 */
export interface VSBufferLike {
	readonly buffer: Uint8Array;
}
