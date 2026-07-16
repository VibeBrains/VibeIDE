# Голосовой ввод: локальный STT на sherpa-onnx

← [Knowledge Index](../README.md)

---

## [архитектура] Пайплайн диктовки и раскладка по слоям

**Контекст:** 2026-07-15, ветка `next`. Задача «голосовой ввод» — офлайн, русский основной, mac arm64 + win x64. В ядре VS Code давно живёт полный каркас речи без провайдера (у Microsoft он в проприетарном `ms-vscode.vscode-speech`, форкам недоступен юридически: Marketplace запрещён, в Open VSX расширения нет).

**Суть:**

- **Провайдер регистрируется из ядра**, extension host не нужен: [vibeVoiceInputService.ts](../../../src/vs/workbench/contrib/vibeide/electron-browser/voice/vibeVoiceInputService.ts) → `ISpeechService.registerSpeechProvider('vibeide.voice', …)`. Одна регистрация бесплатно оживляет: диктовку в редакторе (`Ctrl/Cmd+Alt+V`, ghost-превью interim, hold-режим), диктовку в терминале, динамические настройки `accessibility.voice.*` (появляются в Settings UI только при живом провайдере) и звуки старта/стопа записи.
- **Раскладка:** контракты/каталог — `common/voice/*` (pure, юнит-тесты); скачивание моделей + lifecycle воркера — `electron-main/voice/*` (канал `vibeide-channel-voice`, стиль ollamaInstaller: `listen` для пуш-событий); микрофон + провайдер + фасад для React — `electron-browser/voice/` (перевязка в `workbench.desktop.main.ts` по рецепту [[layerSplitElectronBrowser]]); инференс — **utility-процесс** `node/voice/vibeVoiceWorkerMain.ts` (entry в `build/buildfile.ts`, спавн через `UtilityProcess` как ptyHost). Краш нативного декодера не роняет IDE; `keepAliveSec` выгружает ~0.5 ГБ моделей после простоя.
- **Аудио:** renderer `getUserMedia` → `AudioContext({sampleRate: 16000})` (Chromium сам ресемплирует — свой ресемплер не нужен) → `ScriptProcessorNode` (2048 сэмплов ≈ 128 мс; AudioWorklet требовал бы blob-URL под CSP воркбенча) → PCM16 → VSBuffer по каналу → main → structured clone в воркер. `'media'`-permission окнам ядра уже разрешён в `app.ts#configureSession` — диалогов Electron нет (системный TCC-промпт macOS остаётся).
- **Гибрид для русского:** стриминговый **T-one** (Т-Банк, 144 МБ) даёт interim каждые ~300 мс; его **встроенный endpointing** (rule2 = `vibeide.voice.endpointSilenceMs`) закрывает фразу; аудио фразы копится в кольцевом буфере и передекодируется **GigaAM v3 CTC int8** (Сбер, 225 МБ, WER ~8.4 против 12.8 у T-one) → событие `final` заменяет interim. Отдельный Silero-VAD оказался не нужен — endpointing уже сегментирует. Английский — NeMo fast-conformer transducer 480ms int8, стриминг без второго прохода.

**Применение:** новый язык = профиль в `common/voice/vibeVoiceModels.ts` (архив на зеркале + SHA256 + маппинг в `voiceProfileForSpeechLanguage`) — рантайм один на все модели sherpa (transducer/CTC/nemo/whisper/…).

**Связано:** [[layerSplitElectronBrowser]], [[inheritedPrototypes]] (заглушка `vibeVoiceInputService` из Initial import — замысел whisper-local/web-speech поглощён этой реализацией; web-speech в Electron мёртв: Google закрыл Chrome Speech API для shell-окружений).

---

## [квирк] Контракт ISpeechProvider: три инварианта, без которых виснет UI

**Контекст:** `speechService.ts` (browser) оборачивает сессию провайдера своей бухгалтерией контекст-ключей; `editorDictation.ts` игнорирует события после отмены токена (`if (cts.token.isCancellationRequested) return;` — проверено по коду, строка ~266).

**Суть:**

1. `createSpeechToTextSession` **синхронный** — сессию вернуть сразу, `Started` эмитить только когда микрофон И движок реально готовы (на `Started` завязан UI «recording» и счётчики).
2. **После `Error` обязан прийти `Stopped`** — сервис на `Error` только логирует; без `Stopped` контекст-ключ `speechToTextInProgress` виснет навсегда (виджет диктовки, Escape-кейбинды).
3. **Отмена токена = жёсткая отмена.** Апстримные потребители после cancel глухи — «мягкий стоп» с дожимом последней фразы туда доставить нельзя. Поэтому graceful stop (flush хвоста → последний `final` → `Stopped`) живёт только в фасаде чата (`stop()`), который сам владеет сессией; `cancel()`/токен — мгновенное закрытие без вставки.

Бонус-квирки: TTS/keyword-сессии в контракте обязательны — заглушки должны эмитить `Stopped` сразу (`Event.None` подвесит `recognizeKeyword`); наш провайдер регистрируется на `WorkbenchPhase.AfterRestored` и потому первый в Map — `getProvider()` берёт первого, даже если пользователь потом поставит расширение.

**Применение:** любой новый потребитель голосового ввода — либо через `IVibeVoiceInputService` (interim/final/level/state), либо через `ISpeechService` с учётом трёх инвариантов выше.

---

## [грабли] Что стрельнуло по дороге

**Суть:**

- **`sherpa-onnx-node`: `LC_RPATH=@loader_path`** у `sherpa-onnx.node` (проверено `otool -l`) — dylib-и грузятся из каталога пакета, `DYLD_LIBRARY_PATH` из README **не нужен**, пока `.node` и dylib-и лежат в одном реальном каталоге. Отсюда правило упаковки: глобы `**/sherpa-onnx-*/**` в unpack-список `createAsar` (`gulpfile.vscode.ts`) — пакет уезжает в `node_modules.asar.unpacked` целиком. Windows аналогично: `LoadLibraryExW` с altered search path ищет DLL рядом с `.node`.
- **`sherpa-onnx-streaming-zipformer-en-2023-06-26` в рантайме 1.13.4 выдаёт мусор** («YOU» на собственном тестовом wav, int8 и fp32 одинаково) — старые экспорты несовместимы. Смоук на **их же** `test_wavs` перед выбором модели обязателен; свежий NeMo-экспорт (2024) работает.
- **GigaAM v3 «с пунктуацией» — только в апстриме GigaAM**: sherpa-экспорт `2025-12-16` имеет посимвольный словарь (`tokens.txt`: 33 буквы + blank) — ни пунктуации, ни капитализации. Русской пунктуационной модели в sherpa нет (только en/zh-en) → диктовка строчными; доводка LLM — отдельная задача.
- **`npm install` под системной Node 24 упал на preinstall, но exit-код съел пайп в `tail`** (`npm install | tail` → код tail'а), а node_modules остался полусобранным. Повтор известного урока: активировать fnm (`.nvmrc` → 22.22.1) и читать код выхода команды, не пайпа.
- **Upstream-архивы моделей — tar.bz2**: в node нет bz2 — на зеркале перепакованы в zip под `vs/base/node/zip.ts#extract`. Зеркало: релиз `stt-models-v1` в нашем репо (HF из РФ нестабилен; создать репо в организации токен gh не смог — 404 на `POST /orgs`).
- **Тест wav для смоука без микрофона**: `say -v Milena "…" -o x.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav` — весь пайплайн (T-one partials → endpoint → GigaAM final) проверяется на синтетической русской речи; скормить IDE: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --no-sandbox --use-file-for-fake-audio-capture=x.wav` (без `--no-sandbox` аудио-сервис не может читать файл).
- **Вставка interim в textarea — только с самопроверкой якоря.** Textarea чата — общий неконтролируемый ресурс: пользователь может кликнуть/напечатать в середине диктовки, а ремоунт композера теряет `useRef`-состояние кнопки. Слепые оффсеты вырождают замену interim в накопительное дублирование («составь авсавсе нужно…»). Правило: слот вставки — в module-scope `WeakMap<HTMLTextAreaElement, …>`, перед заменой — сверка «по оффсету стоит наш interim», иначе перебазирование `lastIndexOf`/рестарт от курсора.
- **Отладка React-слоя через CDP — три капкана разом:** (1) `agent-browser eval` исполняется в **изолированном мире** — DOM общий, но `window`/`console` свои: хуки на `console.warn` из eval никогда не увидят вызовы страницы; диагностику писать в **DOM-узел** (`<div style=display:none>`), он виден из обоих миров. (2) `document.createElement('script')` в воркбенче бьётся о Trusted Types — обработчик молча умирает на первом событии. (3) `npm run buildreact` кладёт бандл в `src/**/react/out/`, а рантайм грузит **копию** из `out/vs/**/react/out/` — её обновляет только полный `npm run compile` (или ручной `cp -R`); `location.reload` из eval может не перезагрузить окно (dirty-редактор держит) — надёжен только рестарт процесса.
- **Согласие на скачивание — через `IVibeModalService`, не `IDialogService`.** `IDialogService.confirm` на десктопе резолвится в нативный Electron message box: он **вне DOM** (CDP/agent-browser его не видит и не кликает → смоук зависает на нерезолвящемся await) и стилистически чужероден остальным подтверждениям VibeIDE (все они — vibe-modal). Симптом при отладке: лог «opening confirm» есть, «resolved» нет, в DOM ноль `.monaco-dialog-box`. Для любых наших подтверждений брать `IVibeModalService.confirmModal` (возвращает `Promise<boolean>`, in-DOM, темизирован). Он в browser-слое — electron-browser его импортирует легально.
- **`channel.listen` нельзя переподписывать** (ловушка апстримного `ChannelClient#requestEvent`, `ipc.ts:654`): обработчик ответа кладётся в `handlers` один раз при создании события, а `onDidRemoveLastListener` удаляет его **навсегда**; повторная подписка шлёт `EventListen` заново, но события уже некому принять — дропаются молча. Симптом у нас: **вторая диктовка не стартовала** — сессия #1 отписалась, сессия #2 не получила `ready` (main-лог при этом показывал `ready` через 1 мс — терялось на пути main→renderer). Правило: на канальные события подписываться **один раз навсегда** в клиенте-обёртке и ре-эмитить в локальный Emitter (паттерн `ollamaInstallerService`); short-lived подписчики слушают локальный эмиттер. Апстрим не чинить — там никто не переподписывается, а правка ipc.ts = конфликт на каждом мерже.

**Антипаттерны:** не заводить отдельную настройку языка диктовки (есть апстримная `accessibility.voice.speechLanguage`, `auto` → язык интерфейса); не таскать whisper.cpp ради русского (large-v3 WER 16.2 против 8.4 у GigaAM при 3 ГБ против 225 МБ; npm-биндинги мертвы или собираются на машине пользователя).
