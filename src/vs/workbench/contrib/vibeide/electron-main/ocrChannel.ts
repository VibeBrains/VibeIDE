/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { OcrRecognizeRequest, OcrRecognizeResponse, OcrWord } from '../common/imageQA/ocrTransport.js';
import { bundledTrainedDataPath, ocrLanguagesOf } from '../common/imageQA/ocrBundledLanguages.js';

/** Минимальная часть API tesseract.js, которой мы пользуемся. */
interface TesseractWorkerLike {
	recognize(image: Uint8Array): Promise<{ data: { text?: string; words?: OcrWord[] } }>;
	terminate(): Promise<unknown>;
}
interface TesseractModuleLike {
	createWorker(langs: string, oem?: number, options?: { langPath?: string; cachePath?: string; gzip?: boolean }): Promise<TesseractWorkerLike>;
}

/**
 * Распознавание текста в главном процессе.
 *
 * Здесь оно живёт не по вкусу, а по необходимости: в окне `new Worker(<строка>)` запрещён
 * Trusted Types (см. `common/imageQA/ocrTransport.ts`). В главном процессе Node берёт
 * `worker_threads`, и тот же самый распознаватель работает.
 */
export class VibeOcrChannel implements IServerChannel {

	private _worker: TesseractWorkerLike | undefined;
	private _languages: string | undefined;
	/** Одна очередь: распознаватель однопоточный, параллельные вызовы его роняют. */
	private _queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly _langDataDir: string,
		private readonly _logService: ILogService,
	) { }

	listen<T>(): Event<T> {
		throw new Error('VibeOcrChannel: событий нет');
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		if (command === 'recognize') {
			return await this._enqueue(() => this._recognize(arg as OcrRecognizeRequest)) as T;
		}
		if (command === 'dispose') {
			await this._disposeWorker();
			return undefined as T;
		}
		throw new Error(`VibeOcrChannel: неизвестная команда ${command}`);
	}

	/** Вызовы выстраиваются в цепочку: распознаватель один, и второй одновременный вызов его роняет. */
	private _enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = this._queue.then(work, work);
		// Очередь не должна вставать колом из-за неудачи предыдущего вызова.
		this._queue = next.then(() => undefined, () => undefined);
		return next;
	}

	private async _recognize(request: OcrRecognizeRequest): Promise<OcrRecognizeResponse> {
		try {
			const worker = await this._ensureWorker(request.languages);
			const image = Buffer.from(request.imageBase64, 'base64');
			this._logService.trace(`[VibeOcr] картинка ${image.byteLength} байт`);
			const result = await worker.recognize(image);
			return {
				ok: true,
				text: result.data.text ?? '',
				words: result.data.words ?? [],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._logService.warn(`[VibeOcr] распознать не удалось: ${message}`);
			// Языковые данные качаются один раз и лежат рядом с настройками. Пока их нет и сети нет,
			// сказать об этом надо словами: молчаливый пустой результат читается как «на странице
			// ничего нет», а это другое утверждение.
			return { ok: false, error: message };
		}
	}

	private async _ensureWorker(languages: string): Promise<TesseractWorkerLike> {
		if (this._worker && this._languages === languages) {
			return this._worker;
		}
		await this._disposeWorker();

		await this._seedBundledLanguages(languages);
		const { createWorker } = await import('tesseract.js') as unknown as TesseractModuleLike;
		this._logService.info(`[VibeOcr] поднимаю распознаватель (${languages}), данные в ${this._langDataDir}`);
		// `cachePath` — куда лечь скачанным языковым данным, чтобы второй раз не качать; `langPath`
		// не задаём, иначе tesseract перестанет докачивать отсутствующий язык вовсе.
		this._worker = await createWorker(languages, undefined, { cachePath: this._langDataDir });
		this._languages = languages;
		return this._worker;
	}

	/**
	 * Copy the languages the app ships into the recognizer's cache, so a scan is read without a network.
	 * A language already in the cache is left alone; one the app does not ship still downloads as before.
	 */
	private async _seedBundledLanguages(languages: string): Promise<void> {
		for (const language of ocrLanguagesOf(languages)) {
			const bundled = bundledTrainedDataPath(language);
			const cached = join(this._langDataDir, `${language}.traineddata`);
			if (!bundled || await exists(cached)) {
				continue;
			}
			const source = FileAccess.asFileUri(bundled).fsPath;
			if (!await exists(source)) {
				this._logService.warn(`[VibeOcr] данные языка ${language} не найдены в приложении (${source}) — будут скачаны`);
				continue;
			}
			await fs.mkdir(this._langDataDir, { recursive: true });
			// tesseract.js checks the gzip signature of what it reads from the cache, so the file is copied as is.
			await fs.copyFile(source, cached);
			this._logService.info(`[VibeOcr] данные языка ${language} взяты из приложения, без сети`);
		}
	}

	private async _disposeWorker(): Promise<void> {
		const worker = this._worker;
		this._worker = undefined;
		this._languages = undefined;
		if (worker) {
			try { await worker.terminate(); } catch { /* уже мёртв — нечего закрывать */ }
		}
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}
