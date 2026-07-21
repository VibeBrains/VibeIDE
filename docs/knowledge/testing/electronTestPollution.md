# Electron unit-тесты: каскадный test-pollution от зависшего fake-timer теста

> Домен: testing · создано 2026-07-21 (ветка `next`, PR #2)

## Симптом

Electron-джоба юнит-тестов падала с **34 failing** на всех платформах (Linux/macOS/Windows) —
**детерминированно, одни и те же тесты**, номера совпадают: `ExtensionRecommendationsService`,
`EditorAutoSave`, `Files - FileEditorInput`, `textFileEditorTracker`, весь `mcp/` (ServerConnection,
ResourceFilesystem, Gateway, Registry), `stat/readdir/watch`. Плюс `8 undisposed disposables` и
`Unexpected console output`. 32 из 34 — `Timeout of 30000ms exceeded`.

**Ловушка диагностики:** долго не всплывало, потому что джоба рубилась по `timeout-minutes: 15`
раньше, чем тесты досчитывались. Подняли лимит до 30 мин → тесты добежали до конца → 34 фейла
стали видны. То есть «увеличили таймаут → появились фейлы» — не регресс, а **разоблачение**
пред-существующего долга.

## Корень (один тест роняет 34)

Все 34 теста **проходят изолированно** за <300мс (`test.sh --grep`/`--runGlob` по одному файлу) —
значит это **test-pollution**, а не 34 бага. Бинарный поиск через `--runGlob` по группам
(`mcp/` зелёный сам, `files/` зелёный сам, `extensions/` падает сам на 2) свёл к одному файлу:
**`extensionRecommendationsService.test.ts` → тест «Prompt for valid workspace recommendations»**.

Механика каскада:
1. Форк намеренно убрал навязчивый workspace-recommendations toast
   (`extensionRecommendationsService.ts` → `VIBEIDE_SHOW_WORKSPACE_RECOMMENDATIONS_TOAST = false`,
   есть патч-файл). Промпт больше **не файрится** — рекомендации только вычисляются.
2. Upstream-тест ждал этот промпт: `await Event.toPromise(promptedEmitter.event)` → **виснет вечно**.
3. Тест обёрнут в `runWithFakedTimers({ useFakeTimers: true })`. Зависнув до таймаута, он
   **оставляет fake timers активными** (хелпер не восстановил clock из-за зависания).
4. → Все последующие async-тесты, ждущие **реального** времени (autosave-delay, watch,
   `timeout()`, mcp), не получают тик → таймаут 30с каждый → каскад из 34.

`8 undisposed disposables` и `Unexpected console output` — **следствия** (зависшие тесты не доходят
до teardown), а не отдельные баги.

## Фикс

- **Нарушитель:** ждать `testObject.activationPromise` (как соседние «No Prompt» тесты) вместо
  несуществующего промпта + `assert.ok(!prompted)`. Тест перестаёт виснуть → fake timers
  восстанавливаются штатно → каскад разорван. Локально: 35 failing → 1.
- **Остаток (console output):** `vibeModalService.test.ts` — несколько defensive-тестов намеренно
  гоняют error/timeout-пути, логирующие `vibeLog.warn` (→ глобальный `console.*`), что валит
  раннерскую проверку «no console output in tests». Подавлено на уровне сюиты:
  `setup(() => vibeLog.configure({ enabled: false }))` / `teardown(() => …{ enabled: true })`.

Локально после обоих фиксов: **24114 passing, 0 из исходных 34**. Оставшиеся локальные фейлы
(`detectBOM UTF-8`, `vibeDocsGraph parity`) — артефакты окружения (фикстуры/пути), в CI не
воспроизводятся (0 совпадений в CI-логе), падают и изолированно — не pollution.

## Метод (переиспользуемый)

1. **Изолированный прогон** упавшего теста (`test.sh --runGlob "**/<file>.test.js"`): зелёный
   изолированно + красный в полном = **pollution**, ищи нарушителя, а не баг в жертве.
2. **Бинарный поиск** нарушителя через `--runGlob` по директориям-группам: запускай подмножества,
   сужай до группы/файла, что падает **сам**.
3. **Fake-timers как первый подозреваемый**, когда жертвы — `Timeout of 30000ms` из разных областей:
   ищи тест, который виснет под `runWithFakedTimers`/`useFakeTimers` и не восстанавливает clock.
4. **«Появились фейлы после ↑таймаута» ≠ регресс** — часто разоблачение долга, скрытого ранним
   обрывом джобы.
5. Полный локальный Electron-прогон (`./scripts/test.sh`, ~3 мин) воспроизводит CI-порядок —
   быстрее, чем 17-мин CI-итерация.

## Вторая волна: 2 фейла, вскрытые после разрыва каскада

Разорвав каскад (34→2), досчитали до двух **реальных** пред-существующих фейлов, которые раньше
были за зависанием (CI до них не доходил — легко ошибиться и списать на «локальное»):

- **`detectBOM UTF-8` (`null !== 'utf8bom'`)** — фикстура `encoding/fixtures/some_utf8.css` **потеряла
  UTF-8 BOM (`EF BB BF`)**: `.gitattributes` строка 1 `* text=auto` без исключения для этих фикстур
  ренормализовал текст и срезал BOM **в самом git-blob** (не только чекаут; utf16-фикстуры уцелели —
  git счёл их binary). Фикс: восстановить BOM + `encoding/fixtures/** -text` в `.gitattributes`.
- **`vibeDocsGraph parity` (`Failed to fetch dynamically imported module`)** — node-only тест
  динамически `import(file://…/scripts/vibe-docs-graph.mjs)` (вне `out/`); Electron-**рендерер** не
  может фетчить file:// за пределами app-бандла. Тест валиден в `npm run test-node`; в рендерере
  пропущен через `this.skip()` по `process.type === 'renderer'`.

**Урок:** долг вскрывается **слоями** — за таймаутом джобы прятался каскад, за каскадом ещё 2 фейла.
«Нет в CI-логе» проверяй на СВЕЖЕМ прогоне (где предыдущий слой уже починен), а не на старом, где
прогон падал раньше.

**Связано:** [[precommitHygiene]] (тот же мотив «ранний барьер маскирует хвост»).
