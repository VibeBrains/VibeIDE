# Unit-test runner (scripts\test.bat) — footguns

← [Knowledge Index](../README.md)

Извлечено 2026-06-05 при реанимации прогона тестов (sentinel/run_command сессия).

---

## [Footgun] `import { suite, test } from 'mocha'` убивает ВЕСЬ тестовый прогон

**Контекст:** electron-renderer-раннер (`test/unit/electron/renderer.js`) загружает каждый `*.test.js` из `out/` нативным ESM `import()`. Bare specifier `'mocha'` в нём не резолвится → `TypeError: Failed to resolve module specifier "mocha"` → загрузка модулей абортится **целиком**, ни один тест не выполняется (exit 1 без единого passing). `suite`/`test`/`setup`/`teardown` раннер предоставляет как глобалы через `EVENT_FILE_PRE_REQUIRE`; типы — глобальные из `@types/mocha`.

**Суть:** 7 vibeide-тестфайлов с момента Initial import содержали `import { suite, test } from 'mocha';` — из-за этого `scripts\test.bat` был сломан полностью, а сами файлы никогда не запускались (latent-падения копились незамеченными). Починено 2026-06-05 удалением импорта во всех 7.

**Применение:** в новых тестах НИКОГДА не импортировать из `'mocha'` — использовать глобальные `suite`/`test` (см. любой upstream-тест, напр. `tokenCalibration.test.ts`). Один такой импорт = красный прогон для всех.

## [Workflow] test.bat гоняет `out/`, не `src/` — перед прогоном транспилировать

**Контекст:** `scripts\test.bat` не компилирует; он запускает electron против `out/**/*.test.js`. Правки в `src/` не видны тестам, пока не выполнен `npm run transpile-client` (~5–6 сек, без typecheck) или не работает watch.

**Применение:** цикл — `npm run compile-check-ts-native` (типы) → `npm run transpile-client` (out/) → `scripts\test.bat --grep <Suite>`. Если падение выглядит «невозможным» — первым делом проверить timestamp соответствующего файла в `out/`.

## [Footgun] Псевдотесты: файл «тестирует» собственную инлайн-копию логики

**Контекст:** обнаружены два никогда не запускавшихся AI-генерированных файла, которые не импортируют тестируемый продуктовый код вовсе:
- `test/browser/toolsService.test.ts` («New Cursor Tools») — каждый тест определяет toy-логику инлайн и ассертит её же; плюс платформо-наивные ассерты путей (`/src/...` против Windows `\src\...`).
- `test/common/applyEngineV2.test.ts` — содержит 160-строчную РЕИМПЛЕМЕНТАЦИЮ `applyTransaction` внутри `setup()` («Since the class is not exported, we create a test implementation») и тестирует её, а не реальный движок. Ожидание «snapshot discarded после rollback» противоречит реальному дизайну (снапшот намеренно сохраняется для crash-recovery, чистится через `vibe:checkpoint:prune`).

**Применение:** тест без импорта продуктового модуля = красный флаг на ревью. Если класс не экспортирован — экспортировать для тестов или тестировать через публичный сервис-интерфейс, но не копировать логику в тест: копия дрейфует и даёт ложную уверенность.
