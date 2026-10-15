# Точка входа сборки без исходника: agentHostMain в 1.25.0 и 1.26.0

**Дата:** 2026-10-15 · **Ветка:** `next` · **Код:** `build/buildfile.ts`, `build/next/index.ts`, `scripts/vibe-entrypoints-check.ts`, `src/vs/code/electron-main/app.ts`

← [Knowledge Index](../README.md)

---

## [грабли] Главный процесс запускал агент-хост, которого в сборке нет

**Симптом:** в `main.log` собранных 1.25.0 и 1.26.0 на каждом старте две строки подряд:
`AgentHostProcessManager: agent host started` и `ERR_MODULE_NOT_FOUND` для
`out/vs/platform/agentHost/node/agentHostMain.js`. Окно при этом открывалось.

**Что такое agentHost.** Апстримный (VS Code 1.133) отдельный процесс для агентских сессий чата: внутри харнессы Copilot CLI, Claude и Codex.
Главный процесс поднимает его лениво, когда окно просит соединение; окно общается с ним напрямую по MessagePort.
В VibeIDE свой агентский стек, и этот процесс не нужен: чат апстрима на нём отключён
(`agentHost.contribution.js` закомментирован в `workbench.common.main.ts`).

**Откуда взялось.** Коммит `e0f422096` (15.08.2026) удалил точку входа `agentHostMain.ts` вместе с харнессами,
потому что SDK вендорных агентов вырезаны из зависимостей. Обвязку запуска он не тронул:

- `app.ts` создавал `ElectronAgentHostStarter` и `AgentHostProcessManager`;
- окно, считая рантайм доступным (`!isWeb`), на старте само просило соединение;
- `build/buildfile.ts` держал строки `agentHostMain`, `diffWorkerMain` и `localTranscriptionMain` (все три без исходника).

`build/next/index.ts` (он и упаковывает приложение) уже не перечислял их, так что в пакет модуль не попадал.
Утилитарный процесс форкался и падал в загрузчике ESM; события выхода в логах нет (сообщение «terminated unexpectedly» не появляется),
так что счётчик перезапусков не срабатывал, а соединение окна оставалось без ответа.

**Что теряется.** Ничего живого: ни одна функция VibeIDE на агент-хосте не стоит.
Файл `agentHostServerMain.ts` (серверный запуск) убран раньше, `src/vs/sessions` в форке запрещён гейтом вендорных поверхностей.

**Лечение (три слоя, сверху вниз):**

- окно: `BrowserAgentHostEnablementService` объявляет рантайм недоступным, поэтому соединение не запрашивается,
  а UI, зависящий от `chat.agentHost.enabled`, остаётся выключенным;
- главный процесс: запуск вынут из `app.ts`, файлы `electronAgentHostStarter.ts` и `node/agentHostService.ts` удалены (в git остаются);
- сборка: из `build/buildfile.ts` убраны три мёртвые строки.

**Защита.** `npm run entrypoints-check` (`scripts/vibe-entrypoints-check.ts`, стоит в lint-staged на `build/buildfile.ts` и `build/next/index.ts`)
сверяет каждую точку входа обоих списков с файлом в `src/`. Тот же класс дефекта уже был: голосовой воркер в 1.9.0
(см. [macosToolchain.md](macosToolchain.md)) ушёл из пакета из-за двух несинхронизированных списков.

**Не закрыто.** Остальное дерево `src/vs/platform/agentHost/` (около 140 файлов в `node/`, общие типы в `common/`) не удалено:
на него завязаны типы чата апстрима, и его выпил — отдельная большая работа.
