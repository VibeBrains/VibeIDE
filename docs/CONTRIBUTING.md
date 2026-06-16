# Contributing to VibeIDE

VibeIDE — open-source IDE на базе VS Code. Любые правки в код, документацию, knowledge base, конфиги — через GitHub PR.

## TL;DR

- **Код** — `src/` основной, `extensions/` встроенные расширения. `npm run compile-check-ts-native` перед PR (mandatory).
- **Документация и knowledge** — `docs/`. Docs-only PR проходит легковесный CI (~30s).
- **Issues** — баг? Прикрепи: версию (`Help → About`), модель + провайдер если LLM-related, минимальный repro.

## Структура repo

| Путь | Что |
|---|---|
| `src/vs/workbench/contrib/vibeide/` | Основной код VibeIDE (chat, tools, settings, integrations) |
| `src/vs/workbench/contrib/vibeide/electron-main/` | Main-process — IPC channels, services, watchdog |
| `src/vs/workbench/contrib/vibeide/browser/` | Renderer-side contributions |
| `src/vs/workbench/contrib/vibeide/common/` | Pure helpers, types, layer-independent code |
| `src/vs/workbench/contrib/vibeide/test/common/` | Unit-тесты (Mocha) для common-helpers |
| `extensions/vibeide-*/` | Встроенные расширения (theme, neon glow) |
| `resources/` | JSON каталоги (model-quirks, providers) |
| `docs/` | Project knowledge base — see [docs/README.md](README.md) |
| `.github/workflows/` | CI pipelines |
| `scripts/` | Build / release / dev-time scripts |

## Workflow

### 1. Перед началом

- **Fork** репо в свой GitHub аккаунт.
- **Clone** локально + checkout новой ветки от `main`:
  ```bash
  git checkout -b fix/short-description
  ```
- **Issue-first для крупных изменений** — открой issue с описанием прежде чем тратить часы на PR. Малые исправления (typo, single-line bug) можно сразу PR'ом.

### 2. Виды PR

**Code-change PR:**
- Запустить `npm run compile-check-ts-native` перед коммитом — **обязательно для code-изменений**. Без этого full CI упадёт.
- Если добавляешь новую функциональность — unit test в `test/common/` (если функция pure) или интеграционный (если требует workbench).
- Conventional Commit message: `feat(area):`, `fix(area):`, `refactor(area):`, `docs(area):` (см. `git log` для примеров).

**Doc-only PR:**
- Изменения только в `docs/` или `*.md` → CI skip heavy jobs, runs только `docs-only.yml` + `docs-links.yml` (~30s).
- `compile-check-ts-native` **не нужен** — нет TypeScript изменений.
- Markdownlint lenient — fail только на structural errors.
- Roadmap section integrity — auto-check.
- Link integrity — `docs-links.yml` проверяет relative + external links (templates `_template-*.md` excluded — содержат placeholder paths).

**Knowledge entry PR:**
- Шаблон — `docs/knowledge/_template-knowledge-entry.md`. Скопировать в подходящий topic, заполнить.
- Incident retrospective — `docs/knowledge/_template-incident.md`.
- Один PR — одна запись (не bundle'ить разные знания). Reviewer проверит формат + дубликаты.

**Roadmap update:**
- Если закрываешь существующий пункт — `[ ]` → `[x] ✅ commit-hash`. Маркер `[~]` если partial.
- Новые пункты — в подходящую секцию (W/X/Y/...). См. `docs/roadmap.md` начало для convention.
- Если меняешь `docs/roadmap.md` без сопутствующего code change — docs-only PR.

### 3. Перед открытием PR

- `git fetch upstream && git rebase upstream/main` — синхронизироваться с main.
- `npm run compile-check-ts-native` — TypeScript clean.
- Если есть relevant tests — `scripts/test.bat --grep <pattern>`.
- Локально проверить что `npm run compile-build` проходит (это full build с mangling — выявляет issues которые `tsgo` пропускает, см. v0.13.10 incident).

### 4. PR review

- **Maintainer review** — обычно ответ в течение 1-3 дней.
- **CI must pass** — все required workflows green. Docs-only PRs — только docs-only + links workflows.
- **Squash merge default** — commits сжимаются в один при merge'е. Если важна история коммитов внутри PR — request "Rebase merge" в PR description.

## Knowledge entry quality bar

Перед commit'ом записи в `docs/knowledge/`:

- [ ] Использовал template (`_template-knowledge-entry.md` или `_template-incident.md`).
- [ ] Формат «Контекст / Суть / Применение» (или incident: «Подтверждённое / Исключённое / Под подозрением / Root cause / Fix / Lessons»).
- [ ] Не дублирует существующую запись — grep по ключевому термину в `docs/knowledge/`.
- [ ] Не leak'ает personal info (`%USERPROFILE%` вместо `C:\Users\<name>`, etc.).
- [ ] Не leak'ает live credentials (API keys, tokens, passwords).
- [ ] Внутренние ссылки relative path, не absolute.
- [ ] Если incident — есть commit hash фикса (или явное `<UNRESOLVED>`).

## Tone и формат

VibeIDE документация:

- **Lang:** primary RU для user-facing knowledge; EN для inline code comments.
- **Tone:** рабочие записи, не маркетинг. Цель — через 6 месяцев восстановить причину решения. Не «впечатлять», а «записать».
- **Сжатость:** один абзац ≤ 5 предложений. Списки лучше чем prose.
- **Конкретика:** `chatThreadService.ts:3520` > «где-то в чат-сервисе». `commit 2400d897` > «недавний коммит».
- **Без emoji** в knowledge / code (исключение: release notes, где emoji-маркеры секций — `## ✨ Новое`).

## Locale

VibeIDE — RU-first IDE. Локализация через `nls.localize(key, defaultValue)`:

- **`defaultValue`** — RU текст. EN-locale пользователь увидит русский — это by-design, не bug.
- **Ключи** — `vibeide.<domain>.<action>` или `vibeide.<feature>.<element>` snake-or-camelCase consistent с domain.

## Лицензия

Code: MIT (см. `LICENSE.txt`).  
Docs: MIT (то же — knowledge base — часть продукта).

Контрибутишь = соглашаешься с MIT.

## Контакты

- Issues: <https://github.com/VibeBrains/VibeIDE/issues>
- Discussions / support — Discord (ссылка в README).
- Security — [SECURITY.md](../SECURITY.md) для disclosure procedure.
