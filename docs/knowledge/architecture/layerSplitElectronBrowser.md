# Сплит слоя: `IMainProcessService` из `common/` в `electron-browser/`

← [Knowledge Index](../README.md)

---

## [рецепт] Как разделять desktop-only сервис (проверено 9 раз)

**Контекст:** 2026-07-15, ветка `fix/vibeide-common-layer`. `IMainProcessService` — native-only тип (денай-лист `build/checker/layersChecker.ts`), а девять наших сервисов держали его в кросс-средовых слоях: `valid-layers-check` давал **36 нарушений**. Волна довела до **9** (остаток — ниже).

**Схема** (образец в репо — `electron-browser/vibeDesktopNotificationService.ts`):

1. **Контракт остаётся** в `common/xxx.ts`: типы, IPC-интерфейс, публичный интерфейс, декоратор. IPC-интерфейс **экспортировать** — реализация теперь в другом слое.
2. **Класс + `registerSingleton` + `IMainProcessService`** → `electron-browser/xxx.ts`, **имя файла то же**.
3. Снять side-effect импорт из `browser/vibeide.contribution.ts`.
4. **Добавить перевязку в `vs/workbench/workbench.desktop.main.ts`** — `browser/` не может импортировать `electron-browser/`.
5. **Потребителей не трогать** — они берут интерфейс с неизменившегося common-пути. За 9 сплитов не тронут ни один.

**Цена:** перевязка живёт в `workbench.desktop.main.ts` — **апстримный файл VS Code**, то есть поверхность конфликтов при мерже апстрима. Осознанная: другого пути нет.

**Проверка после каждого сервиса:** `compile-check-ts-native` → `npm run service-registration-check` (**обязательно ломать намеренно**: убрать перевязку, увидеть exit 1) → счётчик `valid-layers-check` обязан упасть **ровно на 3** → hygiene.

---

## [ловушка] Три ошибки, на которых строился неверный план

**`browser/` — тоже запретная зона.** У чекера отдельное правило `'**/vs/**/browser/**'`, и `IMainProcessService` под него подпадает. Изначальный план «реализация → `browser/xxxServiceImpl.ts`» **не сработал бы**: перенёс бы нарушения из одного слоя в другой, счётчик остался бы 36. Единственный рабочий адрес — `electron-browser/`.

**Список нарушителей, собранный грепом, врёт.** `vibeIdleWatchdogTypes.ts` числился нарушителем, потому что искали строку `IMainProcessService` — а она там **в JSDoc-комментарии** про имя канала. У чекера по нему 0 записей. Обратная ошибка: искали только в `common/` и пропустили `browser/vibeideSCMService.ts` и `browser/vibeServer/vibeServerService.ts`. **Спрашивать чекер, а не грепать.**

**Совпадение имён.** `contrib/mcp/browser/mcp.contribution.ts` импортирует `McpService` — это **апстримный** сервис VS Code, к нашему `vibeide/common/mcpService.ts` отношения не имеет. То же с `telemetryService.js`. Проверять полный путь, а не basename.

---

## [баг-класс] Регистрация «попутной» загрузкой — умирает молча

**Суть:** у `vibeServerService` и `mcpService` side-effect импорта **не существовало вовсе**. `registerSingleton` срабатывал только потому, что потребитель импортировал декоратор **значением** из того же файла и тем самым грузил модуль. После расщепления контракт грузится, реализация — нет: сервис исчезает из DI.

**Почему это опасно:** декоратор экспортируется, `compile-check-ts-native` доволен, `valid-layers-check` доволен. Падает только в рантайме, когда потребитель инжектит сервис. Ни один тайпчекер этого не видит.

**Ловится** гейтом `npm run service-registration-check` (`scripts/vibe-service-registration-check.mjs`): каждый модуль с `registerSingleton` обязан быть достижим по импортам от точки входа. Точки входа **множественны** — вход это любой модуль vibeide, импортируемый снаружи контриба (версия с одним корнем объявляла недостижимым корректно сшитый `vibeDesktopNotificationService`, который грузится из `workbench.desktop.main.ts`).

---

## [договорённость] Базлайн 9 — зелёным чек быть не может

- **3 — апстрим, неустранимы:** `src/vs/platform/browserElements/common/nativeBrowserElementsService.ts`. Ни одного нашего коммита, ноль упоминаний `vibe`, пришёл с `Initial import` (2026-05-05). Правка апстрима = конфликт на следующем мерже. **Не чинить, не искать здесь ошибку.**
- **6 — наш отложенный долг:** `sendLLMMessageService` (6 common-потребителей интерфейса) и `metricsService` (54 точки `capture()` в 12 файлах; `LLMMessageChannel` держит `MetricsMainService`; ждёт переименования в `routingOutcomeLog` — см. [inheritedPrototypes.md](inheritedPrototypes.md)).

**Проверять счётчиком:** `npm run valid-layers-check 2>&1 | grep -c IMainProcessService` ≤ 9. Гейт — [.claude/pipeline.md](../../../.claude/pipeline.md) Этап 2.

---

## [приём] Смоук: реестр живого рантайма через CDP

Статика доказывает достижимость модуля, но не регистрацию. Настоящий оракул — спросить работающую IDE:

```js
const ext = await import(new URL('vs/platform/instantiation/common/extensions.js', globalThis._VSCODE_FILE_ROOT).href);
ext.getSingletonServiceDescriptors().map(([id]) => String(id));  // → 530 записей
```

Выполняется через CDP (`Runtime.evaluate`, `awaitPromise: true`) по рецепту смоука. Проверено 2026-07-15: все 9 переехавших сервисов в реестре; в `common/` декоратор есть, класса нет; все impl-модули грузятся.

**Ещё сильнее — сквозь IPC:** статус-бар `vibeide.modelQuirks.source` показал «Model-quirks catalog source: CDN». Это вся цепочка разом: DI отдал сервис из `electron-browser` → канал `vibeide-channel-modelQuirksStatus` → ответ main → рендер. «Зарегистрирован» ≠ «работает»; UI, питаемый по IPC, доказывает второе.

**Грабли:** скрипт с `require('ws')` запускать **из корня репо** (в `/tmp` не резолвится); `node_modules` — там же. Пайп `| tail` буферизует вывод компиляции до конца — прогресс не видно, ждать завершения задачи.

**Связано:** [[verifyBeforeHypothesizing]] («зелёный чек ≠ работающий чек»), [[inheritedPrototypes]], [[precommitHygiene]], [orphanServices.md](orphanServices.md).
