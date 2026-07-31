# Vibe Server: стек `.vibe/servers.json` — сшивка чистого ядра с UI

← [Knowledge Index](../README.md)

---

## [архитектура] Мультисервер поверх готового чистого ядра (2026-07-24, ветка `next`)

**Контекст:** ядро формата `.vibe/servers.json` (`common/vibeServer/vibeServersFile.ts` — парсер + `planStartOrder` волнами по `dependsOn`) было написано заранее и покрыто тестами, но **не подключено ни к UI, ни к сервису запуска** — `parseServersFile`/`planStartOrder` импортировались только из собственного теста. Единственный путь запуска (`IVibeServerService.start()`) поднимал один авто-детектнутый сервер и `servers.json` не читал. Задача: сшить ядро с UI, не трогая одиночный путь (нет файла = прежнее поведение).

**Суть:**
- **Слои сервиса как у `IVibeServerService`:** контракт в `browser/vibeServer/vibeServerStackService.ts` (декоратор + типы состояния), реализация в `electron-browser/vibeServer/vibeServerStackService.ts` — потому что оркестратору нужен `IMainProcessService` (процесс-канал), запрещённый в `common/**` и `browser/**`. Регистрация singleton в `workbench.desktop.main.ts`.
- **Примитивы мультизапуска уже были** в `electron-main/vibeServer/vibeServerProcessService.ts`: `start({id,…})` спавнит **по id** (не один процесс), `stop(id)`, `onDidOutput`/`onDidExit` по id, `waitForPort`. Сшивка не потребовала нового main-спавна — только средний слой в рендерере: прочитать файл (`IFileService`) → `parseServersFile` → держать статус per-entry → гонять волны.
- **Новая чистая функция ядра** `selectWithDependencies(servers, targetId)` — цель + транзитивные `dependsOn` (BFS), в файловом порядке. `startEntry` = `planStartOrder(selectWithDependencies(all, id))`: запуск одной записи тянет ровно её зависимости, сиблинги не трогаются. Неизвестная зависимость намеренно **не** попадает в выборку → `planStartOrder` исключает цель ровно как в полном плане (гарантия «не стартовать без предусловия» одинакова на обоих путях).
- **readyCheck-раннер на все режимы** (`effectiveReadyCheck`): `port`→`waitForPort`; `http`→**новый `waitForHttp(url, timeoutMs)` в main** (см. гочу ниже); `log`→подписка `onDidOutput` по id + regex построчно (буфер обрезается по `\n`, чтобы не рос); `exit`→`onDidExit` code 0 (для `task`); `spawn`→сразу. Волны последовательны: провал предусловия останавливает запуск зависимых.
- **`task` + `skipIf`:** `skipIf` прогоняется как короткий процесс через тот же канал (`${id}::skipIf`, ждём `onDidExit`), exit 0 → «уже сделано, пропустить». `stopCommand` — так же (`${id}::stop`).

**Гочи / решения:**
- **`http`-проба — в main, а не fetch из рендерера.** HTTP GET на loopback из workbench-renderer упирается в CSP. Поэтому добавлен `waitForHttp` в `IVibeServerProcessMain` (node `http`/`https`, `rejectUnauthorized:false` — dev-серверы часто на self-signed, non-5xx = готов). Правило: **loopback-пробы готовности делаем в main, где нет CSP.**
- **`pathPrepend` применяется в main после резолва login-shell PATH.** В рендерере итоговый PATH неизвестен (собирается в main из shellEnv). Добавлено поле `pathPrepend` в `IVibeServerProcSpec`; main препендит его к уже собранному `env.PATH` — иначе пин тулчейна (напр. `node@20/bin`) не победил бы ambient-версию.
- **Самопроизвольная смерть сервиса.** Глобальная подписка `onDidExit`: `running`→`stopped` (крэш/внешний kill). `stopEntry` ставит `stopped` **до** `procMain.stop`, поэтому свой стоп не трактуется как неожиданный. `starting` не трогается — им владеет локальный readiness-waiter.
- **Reload сохраняет живые статусы** записей с тем же `id` — перечитать файл при работающем стеке не сбрасывает строки в `stopped`.

**Два UI-потребителя одного сервиса:**
- Боковая панель `VibeServerViewPane`: если `stackService.available` — список записей (статус-иконка + имя + порт + play/stop) и «Запустить всё»/«Остановить всё»; `excluded`/`failed` приглушены с hover-причиной (`setupManagedHover`, guideline — не native title). Иначе прежний одиночный UI.
- Welcome-экран встроенного браузера `browserView/electron-browser/browserEditor.ts`: список сервисов; клик = `startEntry` (с зависимостями) → `navigateToUrl(previewUrlFor(id))` — сервис сразу открывается в этом же табе.

**Применение / границы:**
- Образец UI — стартовая страница agent-browser Claude Code (список dev-серверов из `.claude/launch.json`); здесь тот же UX, но на детерминированном топосорте `dependsOn`, а не на ИИ.
- Требует live-smoke: реальный `.vibe/servers.json` со стеком `dependsOn` (напр. `app`→`api`→`task`), проверить волны, readyCheck и открытие превью.
