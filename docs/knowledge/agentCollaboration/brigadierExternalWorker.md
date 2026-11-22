# Внешний исполнитель бригадира (DeepSeek)

## Контекст

Навык `brigadier` (экономия токенов главной сессии) умеет отдавать работу отдельному неинтерактивному `claude -p`, у которого подменён сервер на Anthropic-совместимый API провайдера. Источник истины — набор `.vibe-defaults` (репозиторий VibeBrains, ветка `main`), живые копии навыка лежат в `~/.claude/skills/brigadier` и `~/.vibe/skills/brigadier`. Подключение, ключ, цены и узкие места описаны в `.vibe-defaults/skills/brigadier/worker/README.md`.

## Суть

- Профиль провайдера — `worker/providers/<имя>.json` рядом со скриптом (перекрывается `~/.config/brigadier-worker/providers/`). Ключ хранится в связке ключей macOS под сервисом `brigadier-worker-deepseek`, аккаунт = `$USER`; запасной путь — env `BRIGADIER_WORKER_DEEPSEEK_KEY`. Ключ НИКОГДА не коммитится, при засеве используются `set-key` / `import-key` (значение через stdin, не argv).
- Проверка: `bash ~/.claude/skills/brigadier/worker/worker.sh check deepseek` (curl-короткий запрос, claude CLI не нужен). Пробный запуск `run` требует наличия команды `claude` на PATH.
- 22.11.2026 зафиксировано: ключ DeepSeek уже засеян в связку, `check` зелёный (модель deepseek-flash), во всех трёх копиях (набор, ~/.claude, ~/.vibe).
- Фикс `6e6f61f` в VibeBrains: `worker.sh` падал с `USER: unbound variable` (set -u) в обрезанных окружениях без `$USER` и молча не находил ключ. Добавлен fallback `USER="${USER:-$(id -un ...)}"` сразу после `set -u`. Проверять regressions: `env -u USER bash …/worker.sh check deepseek`.
- Расхождение копий (22.11.2026): `~/.claude` содержит фичу `gates`/`merge` (отпечаток дерева при гейтах), которой НЕТ в `.vibe-defaults` — обратный перенос не делался. Синхронизация копий из набора эту фичу затрёт; перед следующим синком решить судьбу гейтов.

## Применение

- «Подключи DeepSeek / засей ключ» → триггеры навыка; сначала живой `check`, потом `import-key` (берёт из env/`~/.vibe/.env`/связки) или `set-key`.
- Ключ есть, но `check` говорит «не найден» → смотреть `$USER` в окружении и аккаунт записи (`security find-generic-password -s brigadier-worker-deepseek`, без `-w` пароль не печатается).
- После правки файлов набора: коммит в VibeBrains `main` → `node scripts/gen-vibe-defaults.mjs` → коммит указателя сабмодуля + манифеста в основном репо (precommit-хук требует парой). Обновить живые копии `~/.claude/skills` и `~/.vibe/skills` (`findings.jsonl` в ~/.vibe — живые данные, не затирать).
