/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/** Отметка о запуске окна: когда началось окно и сколько падений подряд мы помним. */
export interface ChatRestoreGuardState {
	/** Время старта прошлого окна, если оно не прожило 60 секунд. */
	readonly pendingSince?: number;
	/** Сколько окон подряд умерло, не дожив до отметки стабильности. */
	readonly crashes: number;
}

/** Сколько живёт отметка, после которой прошлое падение уже не считаем свежим. */
export const RESTORE_CRASH_WINDOW_MS = 10 * 60 * 1000;

/** После этого времени окно считается стабильным, и счётчик падений сбрасывается. */
export const RESTORE_STABLE_WINDOW_MS = 60 * 1000;

/**
 * Решение о восстановлении вкладок на старте.
 *
 * Отметку `pendingSince` пишет каждое окно при запуске и снимает, прожив минуту.
 * Значит, отметка на старте означает: прошлое окно умерло, не дожив до минуты.
 * Две такие смерти подряд — и вкладки не восстанавливаем: открытие чата само
 * могло быть причиной падения (огромная история в памяти), и повторять его в
 * третий раз бессмысленно. Сами треды при этом не трогаем.
 */
export function decideRestore(prev: ChatRestoreGuardState | undefined, now: number): { restoreTabs: boolean; next: ChatRestoreGuardState } {
	const fresh = typeof prev?.pendingSince === 'number' && now - prev.pendingSince < RESTORE_CRASH_WINDOW_MS;
	const crashes = fresh ? Math.max(0, prev?.crashes ?? 0) + 1 : 0;
	return {
		restoreTabs: crashes < 2,
		next: { pendingSince: now, crashes },
	};
}
