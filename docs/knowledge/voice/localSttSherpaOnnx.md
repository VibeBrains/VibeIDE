# Голосовой ввод: локальный STT на sherpa-onnx

← [Knowledge Index](../README.md)

---

## [архитектура] Пайплайн диктовки и раскладка по слоям

**Контекст:** 2026-07-15, ветка `next`. Задача «голосовой ввод» — офлайн, русский основной, mac arm64 + win x64. В ядре VS Code давно живёт полный каркас речи без провайдера (у Microsoft он в проприетарном `ms-vscode.vscode-speech`, форкам недоступен юридически: Marketplace запрещён, в Open VSX расширения нет).

**Суть:**

- **Провайдер регистрируется из ядра**, extension host не нужен: [vibeVoiceInputService.ts](../../../src/vs/workbench/contrib/vibeide/electron-browser/voice/vibeVoiceInputService.ts) → `ISpeechService.registerSpeechProvider('vibeide.voice', …)`. Одна регистрация бесплатно оживляет: диктовку в редакторе (`Ctrl/Cmd+Alt+V`, ghost-превью interim, hold-режим), диктовку в терминале, динамические настройки `accessibility.voice.*` (появляются в Settings UI только при живом провайдере) и звуки старта/стопа записи.
- **Раскладка:** контракты/каталог — `common/voice/*` (pure, юнит-тесты); скачивание моделей + lifecycle воркера — `electron-main/voice/*` (канал `vibeide-channel-voice`, стиль ollamaInstaller: `listen` для пуш-событий); микрофон + провайдер + фасад для React — `electron-browser/voice/` (перевязка в `workbench.desktop.main.ts` по рецепту [[layerSplitElectronBrowser]]); инференс — **utility-процесс** `node/voice/vibeVoiceWorkerMain.ts` (entry в `build/buildfile.ts`, спавн через `UtilityProcess` как ptyHost). Краш нативного декодера не роняет IDE; `keepAliveSec` выгружает ~0.5 ГБ моделей после простоя.
- **Аудио:** renderer `getUserMedia` → `AudioContext({sampleRate: 16000})` (Chromium сам ресемплирует — свой ресемплер не нужен) → `ScriptProcessorNode` (2048 сэмплов ≈ 128 мс; AudioWorklet требовал бы blob-URL под CSP воркбенча) → PCM16 → VSBuffer по каналу → main → structured clone в воркер. `'media'`-permission окнам ядра уже разрешён в `app.ts#configureSession` — диалогов Electron нет (системный TCC-промпт macOS остаётся).
- **Гибрид для русского:** стриминговый **T-one** (Т-Банк, 144 МБ) даёт interim каждые ~300 мс; **конец фразы определяет `PhraseSplitter`** (`common/voice/vibePhraseSplitter.ts`): текст стриминговой модели не менялся `vibeide.voice.endpointSilenceMs` после речи, либо модель сама сообщила конец, либо потолок 28 с. Встроенный endpointing sherpa-onnx у T-one фразу на паузе не закрывает (раздел «Грабли»); аудио фразы копится в буфере и передекодируется **GigaAM v3 CTC int8** (Сбер, 225 МБ, WER ~8.4 против 12.8 у T-one) → событие `final` заменяет interim. Отдельный Silero-VAD не нужен — паузу видно по тексту. Английский — NeMo fast-conformer transducer 480ms int8, стриминг без второго прохода.

**Применение:** новая модель или язык — архив на зеркало, строка в каталог набора `.vibe-defaults/voice/sttModels.jsonc` (правка делается в VibeBrains, а не здесь: порядок в CLAUDE.md, раздел про сиды) и `npm run gen:stt-models`; код каталога не содержит. Маппинг языка в профиль — `voiceProfileForSpeechLanguage`. Рантайм один на все модели sherpa (transducer/CTC/nemo/whisper/…).

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

## [архитектура] Обратная связь диктовки: фазы кнопки, ошибки человеку, звуки

**Контекст:** 2026-10-15, `next`. Разбор из хендоффа VibeIDEA («голос не работает: отмена вторым кликом, ошибки только в логе») сверен с кодом; по пути поправлена посылка про звуки.

**Суть:**

- **Фаза кнопки выводится, а не хранится в компоненте.** `common/voice/vibeVoiceButtonState.ts`: `resolveVoiceButtonPhase(state)` → `hidden | idle | missing | downloading | recording | transcribing`; действие клика — `voiceButtonClickAction(phase)`: `recording` → стоп, `idle`/`missing` → старт (без моделей старт отвечает диалогом согласия), остальное — игнор. Esc взведён в `recording` и `transcribing`. Сервис отдаёт флаг `transcribing`: он ставится в `stop()`, когда `gracefulStop()` вернул «дожим идёт», и сбрасывается на `Stopped`.
- **Клик во время расшифровки игнорируется, отмена только Esc.** Дожим хвоста ограничен сторожем главного процесса (`STOP_TIMEOUT_MS`, 3 с), так что ожидание короткое, а отмена случайным вторым кликом молча выбрасывает надиктованное. Сторож после остановки человеком шлёт `error` с текстом `timeout` перед `stopped` — иначе зависший движок выглядел бы как «Не расслышал».
- **Слот вставки в textarea живёт, пока идёт запись ИЛИ расшифровка.** Итоговая фраза приходит после остановки: сброс слота на `!recording` заставил бы её лечь рядом с interim, а не заменить его.
- **Гвард двойного старта — по созданию сессии, а не по `Started`.** Между кликом и `Started` проходит прогрев движка (~1,5 с на холодном воркере); клик в этом окне открывал вторую сессию.
- **Ошибки: один переводчик, одно действие.** `common/voice/vibeVoiceErrors.ts`: `describeVoiceError(failure, platform)` принимает сырой сбой (`mic` с именем `DOMException`, `engine` с сообщением воркера или главного процесса, `download`, `noSpeech`) и отдаёт русский текст, серьёзность, действие и признак «писать в журнал». Сырые сообщения движка распознаются по смыслу: «not installed» и «did not contain the expected files» — модели; `crash`/`exit` — воркер умер; `timeout` — сторож; русский текст облачного движка проходит как есть. Сессия сообщает о сбое один раз (`failureReported`), «Не расслышал» выводится из того, что после остановки человеком не пришло ни одного непустого `partial`/`final`; отмена сбрасывает ожидание дожима.
- **Показ и журнал.** `VibeVoiceInputService.presentFailure`: уведомление `prompt` с действием и строка `IChatJournalService` (категория `other`, уровень `warning`); пустой результат — ожидаемый исход, в журнал не идёт. «Повторить» предлагается только когда сессия — чат-сессия (`session === chatSession`): для диктовки в редакторе и терминале повтор запустил бы чат-диктовку.
- **Звуки начала и конца записи уже включены по умолчанию** — вопреки хендоффу. В базе 1.133 `accessibility.signals.voiceRecordingStarted` и `accessibility.signals.voiceRecordingStopped` объявлены с умолчанием `{ sound: 'on' }`; `auto` стоит только в умолчании вложенного поля `sound`, а объявленное умолчание объекта его не перекрывает. Проверка живьём без правок настроек: `HTMLMediaElement.prototype.play`, подменённый в странице, увидел `voiceRecordingStarted.mp3` при громкости 0.7 через ~1,5 с после клика (событие `Started`) и `voiceRecordingStopped.mp3` в конце сессии. Играет их `SpeechAccessibilitySignalContribution` на `onDidStartSpeechToTextSession` / `onDidEndSpeechToTextSession`, то есть звук конца слышен после дожима, а не в момент клика. Выключение — штатные настройки сигналов (`{"sound": "off"}`), громкость — `accessibility.signalOptions.volume`. Тест `voiceSignalDefaults.test.ts` стережёт умолчание от тихого переворота при обновлении базы.
- **Цвет записи — токены, а не палитра.** `vibeide.chat.voiceRecordingForeground` и `vibeide.chat.voiceRecordingBackground` (`vibeideChatMessageColors.ts`), оба производные от `errorForeground`; в React они читаются арбитражными значениями `[var(--vscode-vibeide-chat-voiceRecording…)]`, потому что у переменных на `var()` Tailwind не умеет прозрачность через `/20`.

**Как проверять без микрофона и сети (приёмы смоука):**

- Фраза с тишиной вокруг: `say -v Milena …` → `afconvert` → склеить питоном 8 с нулей + фраза + 20 с нулей. Поддельный микрофон Chromium проигрывает файл с начала на каждом новом потоке, поэтому остановка в первые секунды даёт «Не расслышал», а через ~14 с — текст.
- Зависший движок: `kill -STOP <pid воркера>` (самый «толстый» NodeService-процесс стенда, ~600 МБ) → клик по кнопке → кнопка в `transcribing` до сторожа; `kill -CONT` до 3 с возвращает нормальный дожим.
- Отказ микрофона: в странице заменить `navigator.mediaDevices.getUserMedia` на реджект с `new DOMException('…', 'NotAllowedError')`.
- Сбой скачивания: `vibeide.voice.modelsPath` на каталог, который нельзя создать (`/System/…`) → согласие → `EPERM` за доли секунды вместо 278 МБ.
- Звук: подменить `HTMLMediaElement.prototype.play` и писать `src`, время и громкость — слушать не нужно.
- Модели чистого стенда: настройка `vibeide.voice.modelsPath` на каталог моделей рабочего профиля, иначе стенд предложит скачать 278 МБ.

**Применение:** новое состояние кнопки — в `vibeVoiceButtonState.ts` и в тест; новая причина сбоя — вариант `VoiceFailure` и ветка `describeVoiceError` с тестом, а не строка в компоненте.

**Связано:** контракт провайдера — раздел выше; [[watchVideoPipeline]] (модели общие с `/watch`).

---

## [грабли] Что стрельнуло по дороге

**Суть:**

- **Встроенный endpointing sherpa-onnx 1.13.4 у T-one фразу на паузе не закрывает, а встроенное правило тишины режет слова.**
  Замер 15.10.2026 в Node на синтетической речи (`say -v Milena`, четыре фразы, паузы между ними 1,5–3 с; T-one + GigaAM, чанк 128 мс, три встроенных правила как было: 5,0 / `endpointSilenceMs` / 28 с):
  фразы 1–3 склеены в один `final` и закрыты через 1,5 с после третьей, последняя — на стопе.
  При паузах 6 с закрытие приходит через ~5,7 с после речи.
  При паузах 4,6–5,4 с слова разрезаны («запустис» / «покажи ошибки добавь тест»): правило 1 («5 с тишины без декодированного текста») отсчитывает от последнего сброса, а не от речи,
  и срабатывает через полсекунды после начала слова, пока T-one ещё не показал его (первый текст появляется через ~1 с после начала слова, последнее изменение — через ~0,7 с после конца; замер на тех же записях). Правило 3 (длина фразы) считает так же от сброса.
  Поэтому в конфиге воркера у модели оставлено только правило 2, правила 1 и 3 выключены (`BUILTIN_RULE_OFF_SECONDS`),
  а тишину без речи `PhraseSplitter` фразой не закрывает вовсе: буфер обрезается до 1,5 с перед речью (`VOICE_PREROLL_SECONDS`: больше запаздывания модели; на лидирующей тишине от 2 с GigaAM ошибался чаще — 4 правки против 1 на 130 знаках), поток не сбрасывается.
  После правки на тех же записях все четыре фразы целы и закрываются через ~1,5 с после конца речи (0,8 с паузы + запаздывание текста + передекодирование GigaAM).
  Повторить: `say -v Milena`, затем `afconvert -f WAVE -d LEI16@16000 -c 1`, склеить фразы с паузами и прогнать через `sherpa-onnx-node` и `out/vs/workbench/contrib/vibeide/common/voice/vibePhraseSplitter.js` в Node (модели в `~/Library/Application Support/VibeIDE/stt/models`).
  **У VibeIDEA тот же дефект:** `SherpaEngine.kt` выставляет rule1 = 5 с и закрывает фразой с полным сбросом потока `IDLE_SILENCE_SECONDS` тишины; хендофф им отправлен.

- **`sherpa-onnx-node`: `LC_RPATH=@loader_path`** у `sherpa-onnx.node` (проверено `otool -l`) — dylib-и грузятся из каталога пакета, `DYLD_LIBRARY_PATH` из README **не нужен**, пока `.node` и dylib-и лежат в одном реальном каталоге. Отсюда правило упаковки: глобы `**/sherpa-onnx-*/**` в unpack-список `createAsar` (`gulpfile.vscode.ts`) — пакет уезжает в `node_modules.asar.unpacked` целиком. Windows аналогично: `LoadLibraryExW` с altered search path ищет DLL рядом с `.node`.
- **`sherpa-onnx-streaming-zipformer-en-2023-06-26` в рантайме 1.13.4 выдаёт мусор** («YOU» на собственном тестовом wav, int8 и fp32 одинаково) — старые экспорты несовместимы. Смоук на **их же** `test_wavs` перед выбором модели обязателен; свежий NeMo-экспорт (2024) работает.
- **GigaAM v3 «с пунктуацией» — только в апстриме GigaAM**: sherpa-экспорт `2025-12-16` имеет посимвольный словарь (`tokens.txt`: 33 буквы + blank) — ни пунктуации, ни капитализации. Русской пунктуационной модели в sherpa нет (только en/zh-en) → диктовка строчными; доводка LLM — отдельная задача.
- **`npm install` под системной Node 24 упал на preinstall, но exit-код съел пайп в `tail`** (`npm install | tail` → код tail'а), а node_modules остался полусобранным. Повтор известного урока: активировать fnm (`.nvmrc` → 22.22.1) и читать код выхода команды, не пайпа.
- **Каталог моделей — один источник, в наборе `.vibe`.** До 15.10.2026 адреса, размеры и SHA256 были константами в `vibeVoiceModels.ts`, а VibeIDEA (`SttCatalog.kt`) уже читает тот же файл из набора: копия в коде расходится молча, а архив с чужой суммой не скачается вовсе. Теперь `voice/sttModels.jsonc` из набора вшивается генератором `scripts/gen-stt-models.ts` (`common/voice/sttModels.generated.ts`, свежесть стережёт `generated-fresh-check`), читает его `common/voice/sttModelsCatalog.ts`. Генератор и IDE судят каталог одним кодом: файл без `import`, только стираемый синтаксис, поэтому Node читает его напрямую. Сборка отказывает каталогу, у которого модель профиля указывает на архив без нужного файла; VibeIDEA в таком случае отбрасывает запись с предупреждением и работает с остальными — политики разные, файл у них один.
- **Upstream-архивы моделей — tar.bz2**: в node нет bz2 — на зеркале перепакованы в zip под `vs/base/node/zip.ts#extract`. Зеркало: релиз `stt-models-v1` в нашем репо (HF из РФ нестабилен; создать репо в организации токен gh не смог — 404 на `POST /orgs`).
- **Тест wav для смоука без микрофона**: `say -v Milena "…" -o x.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav` — весь пайплайн (T-one partials → endpoint → GigaAM final) проверяется на синтетической русской речи; скормить IDE: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --no-sandbox --use-file-for-fake-audio-capture=x.wav` (без `--no-sandbox` аудио-сервис не может читать файл).
- **Вставка interim в textarea — только с самопроверкой якоря.** Textarea чата — общий неконтролируемый ресурс: пользователь может кликнуть/напечатать в середине диктовки, а ремоунт композера теряет `useRef`-состояние кнопки. Слепые оффсеты вырождают замену interim в накопительное дублирование («составь авсавсе нужно…»). Правило: слот вставки — в module-scope `WeakMap<HTMLTextAreaElement, …>`, перед заменой — сверка «по оффсету стоит наш interim», иначе перебазирование `lastIndexOf`/рестарт от курсора.
- **Отладка React-слоя через CDP — три капкана разом:** (1) `agent-browser eval` исполняется в **изолированном мире** — DOM общий, но `window`/`console` свои: хуки на `console.warn` из eval никогда не увидят вызовы страницы; диагностику писать в **DOM-узел** (`<div style=display:none>`), он виден из обоих миров. (2) `document.createElement('script')` в воркбенче бьётся о Trusted Types — обработчик молча умирает на первом событии. (3) `npm run buildreact` кладёт бандл в `src/**/react/out/`, а рантайм грузит **копию** из `out/vs/**/react/out/` — её обновляет только полный `npm run compile` (или ручной `cp -R`); `location.reload` из eval может не перезагрузить окно (dirty-редактор держит) — надёжен только рестарт процесса.
- **Согласие на скачивание — через `IVibeModalService`, не `IDialogService`.** `IDialogService.confirm` на десктопе резолвится в нативный Electron message box: он **вне DOM** (CDP/agent-browser его не видит и не кликает → смоук зависает на нерезолвящемся await) и стилистически чужероден остальным подтверждениям VibeIDE (все они — vibe-modal). Симптом при отладке: лог «opening confirm» есть, «resolved» нет, в DOM ноль `.monaco-dialog-box`. Для любых наших подтверждений брать `IVibeModalService.confirmModal` (возвращает `Promise<boolean>`, in-DOM, темизирован). Он в browser-слое — electron-browser его импортирует легально.
- **`channel.listen` нельзя переподписывать** (ловушка апстримного `ChannelClient#requestEvent`, `ipc.ts:654`): обработчик ответа кладётся в `handlers` один раз при создании события, а `onDidRemoveLastListener` удаляет его **навсегда**; повторная подписка шлёт `EventListen` заново, но события уже некому принять — дропаются молча. Симптом у нас: **вторая диктовка не стартовала** — сессия #1 отписалась, сессия #2 не получила `ready` (main-лог при этом показывал `ready` через 1 мс — терялось на пути main→renderer). Правило: на канальные события подписываться **один раз навсегда** в клиенте-обёртке и ре-эмитить в локальный Emitter (паттерн `ollamaInstallerService`); short-lived подписчики слушают локальный эмиттер. Апстрим не чинить — там никто не переподписывается, а правка ipc.ts = конфликт на каждом мерже.

**Антипаттерны:** не заводить отдельную настройку языка диктовки (есть апстримная `accessibility.voice.speechLanguage`, `auto` → язык интерфейса); не таскать whisper.cpp ради русского (large-v3 WER 16.2 против 8.4 у GigaAM при 3 ГБ против 225 МБ; npm-биндинги мертвы или собираются на машине пользователя).
