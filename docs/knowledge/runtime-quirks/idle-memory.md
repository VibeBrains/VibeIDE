# Idle memory pressure / overnight OOM / blocking other Electron apps

← [Knowledge Index](../README.md)

Симптомы вокруг долго работающего экземпляра VibeIDE — утечки в idle, OOM после ночи без активности, временная блокировка запуска соседних Electron-приложений (VS Code, Cursor) пока VibeIDE открыт.

---

## [инцидент] 2026-05-30 02:28 MSK — renderer-OOM по **commit charge** (НЕ V8 heap)

**Состояние:** механизм root cause установлен. Это тот же класс, что инцидент 2026-05-22/23 ниже, но прежняя атрибуция «V8 heap exhaustion» **опровергнута** — V8-куча была на 8% лимита в момент смерти.

### Подтверждённое (логи + минидамп)

| Факт | Источник |
|---|---|
| Renderer крашнулся `2026-05-30 02:28:56 MSK` (`23:28:56Z`), reason `oom`, code `-536870904` (`0xE0000008`) | `main.log` session `20260529T202223`; watchdog `{type:'crash',proc:'renderer',exitCode:-536870904}` |
| Окно idle ~6 ч (старт 20:22, краш 02:28) | `renderer.log` тих после старта |
| **V8 heap рендерера был ЗДОРОВ**: за 89 с до смерти `heapUsed≈336 MB` при `heapLimit=4.29 GB` (ratio **0.08**), `rss≈397 MB` — плоско весь вечер | watchdog renderer-сэмплы |
| **Crash — это commit charge, не куча.** Exception-params минидампа `[0x200000, 0xe73d9f000, 0x356964000]` = `[2 MB запрос, ~57.8 GB commit-лимит, ~13.35 GB закоммичено]` | `Crashpad/reports/*.dmp`, распарсен вручную (cdb/символов нет — парсер `MemoryInfoList` дал мусор, но Exception-стрим читается чисто) |
| `0xE0000008` = Chromium `kOomExceptionCode`; `0x200000`=2 MB = гранулярность super-page PartitionAlloc | декод params |
| Системного OOM НЕ было | 48 GB RAM, 30 GB свободно; `Resource-Exhaustion-Detector` в окне краша пуст |

### Почему watchdog не предупредил — слепое пятно по `privateBytes`

Renderer само-сэмплится через `performance.memory` → только V8 heap, **без off-heap/commit**, ещё и с `pid:-1`. Рост шёл в **private commit** (ArrayBuffers / нативные буферы / PartitionAlloc-резервации), невидимый ни в `heapUsed`, ни в `rss` (working set остался 400 MB — страницы нерезидентны/вытеснены в pagefile). Все три существовавших сигнала молчали: pre-OOM смотрел `heapUsed/heapLimit` (0.08), RSS-slope — плоский RSS, абсолютного commit-порога не было.

### Исправление — commit-видимость watchdog (2026-05-30)

- **`privateBytes`** (private commit, байты) добавлен в `WatchdogSampleBase`; пишется в `_sampleElectronChildProcesses` из `app.getAppMetrics().memory.privateBytes` для **всех** дочерних процессов.
- Рендереры больше **не** пропускаются в main-сэмплере (бывшая строка `if (m.type==='Tab') continue`): эмитится main-side commit-probe (`note:'commit-probe'`, реальный OS-pid). Это единственный способ прочитать commit рендерера — сам он не может.
- Pre-OOM: ветка `commitAlertMB` (абсолютный private commit, default 4000 MB) → `onPreOomAlert`.
- Commit-slope: параллельный `SlopeWatcher` на `privateBytes` → `onSlopeAlert` с `metric:'commit'` (rss-алерт стал `metric:'rss'`). Renderer-нотификация различает текст: «commit-память … растёт, в working set/диспетчере задач не видно».

**Зачем абсолют И наклон вместе:** абсолют (`commitAlertMB`) = «уже у обрыва»; slope = «идёшь к обрыву» (ловит раньше, не зависит от машины, различает рост vs плато). RSS-slope этот инцидент пропустил именно потому, что рост был в commit, а не в working set.

### Открытый хвост — пост-крашевый leak в main

После смерти рендерера main (с висящим диалогом «Открыть повторно?») **сам** начинает течь `external` ~6 MB/ч; маркер зомби-состояния — `handles` падает 16→12. В здоровой сессии (`handles:16`, без crash-событий) main `external` плоский ~5 MB 4.5 ч подряд — **устойчивой idle-утечки main НЕТ** (прежнее предположение об этом снято: измерялось только пост-крашевое окно). Вторичный leak заведён отдельной задачей — см. `docs/roadmap.md` секция W. Источник не локализован (кандидаты: retry/буферизация IPC к мёртвому MessagePort, crash-recovery state).

---

## [инцидент] 2026-05-22/23 — ночной renderer-OOM (cross-machine reproduction)

**Состояние:** ⚠️ гипотеза «V8 heap exhaustion» **опровергнута** инцидентом 2026-05-30 выше — тот же код `0xE0000008` оказался **commit-charge OOM** (PartitionAlloc/Chromium), а не исчерпанием V8-кучи. Виновник роста — off-heap/private commit, невидимый старому watchdog'у. Записи ниже верны как факты по логам, но вывод о «heap exhaustion» читать с поправкой.

### Подтверждённое (по логам, не гипотезы)

| Факт | Источник |
|---|---|
| Renderer крашнулся **`2026-05-22 23:56:06`** | `main.log:10` в session `20260522T184505`: `CodeWindow: renderer process gone (reason: oom, code: -536870904)` |
| Reason: `oom`, code: `-536870904` (`0xE0000008`) | Chromium `kOomExceptionCode` (НЕ V8 `FatalProcessOutOfMemory`, как считалось ранее — см. инцидент 2026-05-30: это commit charge) |
| Окно было **idle 5h 10min** до смерти | `renderer.log` молчит с 18:45:14 до 23:56:06 (14 строк за 8 секунд на старте, потом тишина) |
| **Main-процесс стабилен на обеих машинах** | Watchdog `vibe-idle-watchdog/2026-05-22.jsonl` + `2026-05-23.jsonl`: rss ~208 MB ± noise всю ночь, handles=9, requests=0 |
| **Воспроизводится на двух машинах** | Дом (0.13.8) — ночью идл; Работа (0.13.5) — оставлен на ночь с 18:45, упал в 23:56 |
| Extension host закрылся **после** renderer'а штатно | `exthost.log:20-21`: `Extension host terminating: renderer closed the MessagePort` + `exiting with code 0` |

### Исключённое

- **Системный OOM.** `Resource-Exhaustion-Detector` события за ночь 22→23 — ноль. Последнее событие 21.05 19:54 (некритичное `1014`).
- **`models.dev` fetch storm.** `renderer.log:4-5` ночной сессии: `[VibeIDE ModelsRegistry] Refreshed: 49 models (v1.1.0)` — fetch успешен, никаких ETIMEDOUT/retry.
- **PlanResume автозапуск.** `vibePersistedPlanResumeContribution.ts` показывает `INotificationService.notify` тост и **всё** — никаких setInterval/retry-петель. Тост `Found 1 interrupted plan(s)` на :115 — это просто детектор, не executor.
- **Single-instance lock конфликт.** `nameShort=VibeIDE / applicationName=vibeide / dataFolderName=.vibeide / win32MutexName=vibeide / darwinBundleIdentifier=io.vibeide.app / urlProtocol=vibeide` — уникальны, не пересекаются с VS Code.

### Под подозрением (требуется расширенный watchdog)

Renderer.log тих 5 часов до OOM — значит виновник **не логирует**, накапливает heap молча. Кандидаты (по грепу `setInterval(`, прямой связь с OOM не установлена):

- **`vibeideStatusBar.ts:72`** — `setInterval(..., 500)` дважды в секунду пожизненно обновляет 3 status-bar entries (`latencyEntry?.update`, `modelEntry?.update`, `privacyEntry?.update`) даже когда **нет активных запросов**. Каждый `update()` аллоцирует новый props-объект. За 5h idle = 36 000 аллокаций. Disposal корректный, но интервал не паузится в idle. Topик: добавить early-return когда `vibeideSettingsService.state.activeRequests === 0`.
- **`chatLatencyAudit.ts:387`** — 16ms (60 FPS) render-frame interval **только при активных contexts** (старт на 137, стоп на 375-377 при `contexts.size === 0`). По коду корректно — но если `context.streamCompleteTime` не устанавливается из-за бага в LLM error path, контекст остаётся, interval не останавливается. Низкая вероятность, проверить через расширенный watchdog.
- **`vibeMCPTokenRotationContribution.ts:53`** — `setInterval(_scanTimer, ROTATION_SCAN_INTERVAL_MS)`; dispose корректный. Низкая вероятность.
- `AccountPolicyGate.apply` — в renderer.log дважды за 5 секунд: возможный интервал-тик. Найти регистрацию контрибуции не удалось грепом — возможно lazy-load.
- `VibeMultiWindowCoordinator` heartbeat — `setInterval(_heartbeatTimer, 20_000ms)` на :144; lifecycle через `this._register({dispose})` есть. Низкая вероятность.
- MCP gateway client connection / stdio buffers — не аудитировано.
- FileWatcher / ripgrep watch buildup — не аудитировано.

**Аудит выполнен:** 2026-05-23, grep `setInterval(` по `src/vs/workbench/contrib/vibeide` — 21 файл. Все ревизированные имеют корректный disposal. **Smoking gun не найден** — для дальнейшей локализации нужен расширенный watchdog с `proc:'renderer'` тиками и slope-detection (см. W.5 в roadmap).

### Параллельный симптом (связь не доказана)

VS Code «белое окно» при попытке открыть его параллельно живому VibeIDE. Закрытие VibeIDE → VS Code мгновенно дочитывается. Гипотезы:
1. **Working-set pressure без формального OOM.** VibeIDE удерживает 3-6 GB → Windows page swap при запуске нового Electron-процесса.
2. **CPU-pin** одним из background-сервисов (Node.js single-threaded).
3. **Disk I/O ping-pong** между FileWatcher / ripgrep / plan journal / MCP pipes.

Не зафиксировано в логах — сохраняется как открытый вопрос для следующего инцидента.

---

## [инцидент] 2026-05-18 16:33–16:51 — настоящий системный OOM (3× node.exe)

**Контекст:** реальный системный OOM, отдельный от renderer-OOM выше. Не VibeIDE main-процесс.

**Источник:** Resource-Exhaustion-Detector, 7 подряд событий `2004 Предупреждение` за ~18 минут.

**Виновники (по pid):**

| Процесс | PID | Виртуальная память |
|---|---|---|
| `node.exe` | 53464 | до **24.7 GB** |
| `node.exe` | 14620 | до **25.0 GB** |
| `node.exe` | 24616 | до **20.7 GB** |
| `tsgo.exe` | разные | 3.9–4.5 GB |

**~70 GB virtual в трёх node-процессах одновременно.** Скорее всего параллельно открытые extension host'ы / TypeScript language servers (`tsgo.exe` рядом — нативный TS compiler) у VibeIDE + VS Code + Cursor.

**Профилактика:** не держать несколько IDE одновременно на больших TS-monorepo; ограничить `typescript.tsserver.maxTsServerMemory`.

---

## [инструмент] Idle Watchdog — диагностический сервис VibeIDE (W.0 → W.14)

**Контекст:** ловить медленные утечки памяти / дескрипторов в любом из VibeIDE-процессов, которые проявляются за часы idle. DevTools не помогает (никто не смотрит console.warn в 4 утра).

### Покрытие (post-W.0/W.1/W.2)

| Процесс | Тики собираются | Доставка на диск |
|---|---|---|
| `main` | `process.memoryUsage()` + `_getActiveHandles/Requests` + GC observer + optional `process.report` subset | Прямой `appendFile` через `WriteQueue` |
| `renderer` | `process.memoryUsage()` (через privileged renderer) + `performance.memory` fallback + idle-time tracking | IPC канал `vibeide-channel-idleWatchdog` → main `WriteQueue` |
| `exthost` / `gpu` / `utility` | `app.getAppMetrics()` — main опрашивает Electron API на каждом тике, получает RSS+CPU всех дочерних процессов | Прямо в main `WriteQueue`, без IPC roundtrip |

### Slope-detector (W.5)

Main отслеживает rolling-window slope `(rss_last - rss_first) / dt_min` MB/min на последних 12 тиках для каждого `(proc, windowId, pid)` triple. При `slope > growthAlertMBPerMin` (default 5) — событие `onSlopeAlert` через ProxyChannel Event surface уходит в renderer, который **только на focused window** показывает `INotificationService.warn` с действиями `[Собрать crash report / Пропустить]`. One-shot на triple — повторных нотификаций нет.

### Где смотреть и как читать

- **Файл:** `${userDataPath}/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl` (один файл на день, **UTC**).
  - Windows: `%APPDATA%\Roaming\VibeIDE\logs\vibe-idle-watchdog\YYYY-MM-DD.jsonl`
  - macOS: `~/Library/Application Support/VibeIDE/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl`
  - Linux: `~/.config/VibeIDE/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl`
- **Формат строки** (см. `common/vibeIdleWatchdogTypes.ts`):
  ```jsonc
  {
    "v": 1,                      // schema version
    "type": "sample" | "crash" | "exit" | "snapshot",
    "ts": "2026-05-23T12:00:00.000Z",
    "proc": "main" | "renderer" | "exthost" | "gpu" | "utility",
    "pid": 12345,
    "uptimeSec": 3600,
    "rss": 230_000_000,          // байты (working set)
    "heapUsed": 85_000_000,
    "heapTotal": 130_000_000,
    "privateBytes": 240_000_000, // private commit charge, байты — main-sampled children + renderer commit-probe. Ловит commit-OOM, невидимый в rss
    "handles": 11,
    "activeRequests": 0,
    "windowId": 12345678,        // только renderer
    "idleSec": 1800,             // только renderer (когда окно в фокусе)
    "gcCount": 4,                // delta с прошлого тика
    "gcMajorCount": 0,
    "report": { ... }            // только каждый 10-й тик при `includeProcessReport=true`
  }
  ```
- **Backward-compat:** старые строки без `v`/`proc` читаются как `v:1, proc:'main'`. Не править вручную.
- **Crash correlation** (W.3): когда renderer/utility/gpu умирает, main записывает `{type:'crash', proc, reason, exitCode, lastTickRef: <ts последнего тика того процесса>}` в тот же файл. **Один файл = вся картина инцидента.**

### Конфигурация (`vibeide.diagnostics.idleWatchdog.*`)

| Ключ | Default | Назначение |
|---|---|---|
| `enabled` | `true` | Включить watchdog. **Hot-reload** через `fs.watch` settings.json |
| `intervalMinutes` | `5` (1..60) | Интервал тиков main+renderer. Hot-reload |
| `retentionDays` | `3` (1..90) | Сколько дней хранить .jsonl. Cleanup при старте + при пересечении UTC-полуночи (W.0) |
| `includeProcessReport` | `false` | Каждый 10-й тик дописывать `process.report.getReport()` subset (W.13) |
| `heapSnapshotOnHighRss` | `false` | Auto-snapshot при rss > threshold (W.4) |
| `heapSnapshotThresholdMB` | `2000` | Порог rss для auto-snapshot |
| `snapshotCooldownMinutes` | `30` | Минимальный интервал между snapshot'ами |
| `growthAlertMBPerMin` | `5` | Slope-порог МБ/мин для proactive notification (W.5). Применяется и к RSS-slope, и к commit-slope |
| `commitAlertMB` | `4000` (0..64000, 0=off) | Абсолютный private-commit (МБ) → `onPreOomAlert`. Ловит commit-балон при здоровой V8-куче (инцидент 2026-05-30) |

Все настройки — APPLICATION scope. Settings UI секция «VibeIDE — Idle Watchdog (diagnostics)».

### Команды (Command Palette)

- **`VibeIDE: Собрать crash report (Idle Watchdog)`** — пакует в ZIP: последние 3 дня `.jsonl` + 3 heap snapshots + 5 session log folder'ов + `system-info.json`. Сохраняется в выбранную пользователем папку. (W.11)

### Pre-flight (W.14)

При старте IDE (через 5s после workbench-ready) — читает tail 200 строк последнего `.jsonl`. Если есть `type:'crash'` за последние 24h без последующего `first-tick` того же `proc` — показывает info-нотификацию: «предыдущая сессия завершилась аварией {proc} (reason: {reason}, last tick: {ts}). Собрать crash report?» с действиями `[Собрать crash report / Пропустить]`.

### Применение для расследования утечки

1. Подозрение на утечку → подождать несколько часов / оставить на ночь.
2. Открыть `${userDataPath}/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl`.
3. Отфильтровать по `proc`: `jq 'select(.proc=="renderer")' YYYY-MM-DD.jsonl`.
4. Построить график `rss` по `ts`. Линейный рост = leak; полка с дрейфом = нормально (GC компенсирует).
5. Скоррелировать с `crash` entries и `lastTickRef` — даёт точный момент и причину смерти.
6. Если leak подтвердился — `VibeIDE: Собрать crash report` для шаринга, плюс DevTools heap snapshot (`Ctrl+Shift+I` → Memory → Take heap snapshot) для retain-анализа.

### Анти-паттерны (исторические уроки)

- **Не делать heap snapshot автоматически на каждом тике** — файл 50-200 MB на тик заполнит диск за день. Auto-snapshot работает **только** при превышении порога с cooldown (W.4).
- **Не писать в workspace `.vibe/`** — utility глобальный, не привязанный к проекту (leak в idle = пользователь не помнит, какой workspace был открыт).
- **Не использовать module-level singleton state** (pre-W.0 ошибка — поправлена) — теперь `VibeIdleWatchdogService` класс с явным lifecycle.
- **Не использовать `as any` для unref** (pre-W.0) — теперь `unrefTimer(handle)` helper с feature-detection.
- **Апостроф в single-quoted JS-строках с локализацией** — `'leak'и file descriptor'ов'` ломает TS parser. Использовать без апострофа («утечки file-descriptor»).

### Расширение покрытия — roadmap

Полный план в `docs/roadmap.md` секция **W. Idle Watchdog evolution**. Что осталось:

- **W.6** — status bar widget с rss/heap всех процессов.
- **W.7** — Timeline viewer webview (recharts линейный график .jsonl).
- **W.9** — GC pressure metric в renderer (для main работает).
- **W.12** — CI nightly memory-regression test.
- **W.15** — секция «Диагностика» в Vibe Settings React app.
- **W.16-W.19** — disposable audit lint, DevTools auto-open, OTLP export, SIGUSR2 trigger.
- **W.4 renderer-side** heap snapshot (CDP attach подход) — основное реализовано для main, renderer/exthost — backlog.
