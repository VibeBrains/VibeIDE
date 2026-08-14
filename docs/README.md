# VibeIDE — Documentation

Все долгоживущие знания, планы и решения проекта. Источник правды для команды и AI-агентов работающих с репозиторием.

> Тон: рабочие записи, не маркетинг. Цель — чтобы через месяц можно было найти причину решения и не повторить ошибку.

---

## Структура

> Этот файл — **корень навигации по `docs/`**. Каждый документ должен быть достижим отсюда по ссылкам
> (напрямую или через индекс своего поддерева). Проверяется `npm run docs-graph-check`: файл, до которого
> нельзя дойти, никто не найдёт. Раньше здесь было ASCII-дерево внутри код-блока — оно **не создаёт ссылок**,
> поэтому 29 документов висели сиротами, а само дерево успело соврать (числился `release-notes-v0.3.0.md`,
> которого нет). Список ниже — живые ссылки, а не картинка.

**Планирование и статус**
- [roadmap.md](roadmap.md) — главный roadmap: фазы, секции W/X/…, единственный источник правды «что уже сделано».
- [UNRELEASED.md](UNRELEASED.md) — накопленное между релизами.
- [functional.md](functional.md) — каталог возможностей: «что умеет», версионно-независимо.
- [idea.md](idea.md) — исходный концепт продукта.

**База знаний** — `knowledge/`
- [knowledge/README.md](knowledge/README.md) — **единственный индекс базы** (точка входа; 14 доменов: architecture, ui, chatUx, toolSystem, build, i18n, patterns, runtimeQuirks, gitAndTools, vibeDotfolder, agentCollaboration, security, assets, roadmap). Список записей — только там; здесь его не дублируем.

**Руководства** — `manuals/` (только здесь, имена camelCase)
- [ciCdGuide.md](manuals/ciCdGuide.md) — запуск VibeIDE в GitHub Actions / GitLab CI.
- [codebaseGuide.md](manuals/codebaseGuide.md) — ориентир по кодовой базе форка.
- [designWorkflow.md](manuals/designWorkflow.md) — дизайнер: предусловие (превью), первый запуск тремя шагами, три класса находок, вкус против дефекта, режимы авто-замера, словарь команд.
- [firstRun.md](manuals/firstRun.md) — первый запуск: SmartScreen на Windows и Gatekeeper на macOS (в Sequoia и новее — только через Системные настройки).
- [howToContribute.md](manuals/howToContribute.md) — сборка и запуск из исходников (prerequisites, dev mode).
- [providersSpec.md](manuals/providersSpec.md) — формат `.vibe/providers.json` (скормить LLM → готовый конфиг).
- [handoffSpec.md](manuals/handoffSpec.md) — формат `.vibe/handoffs/*.md`: передача работы между агентами, тредами и машинами (скормить LLM → готовый хендофф).
- [serversSpec.md](manuals/serversSpec.md) — формат `.vibe/servers.json`: дев-стек проекта, порядок запуска, проверки готовности (скормить LLM → готовый конфиг).
- [hooksSpec.md](manuals/hooksSpec.md) — формат `.vibe/hooks.json`: команды проекта вокруг работы агента (скормить LLM → готовый конфиг).
- [httpApiSpec.md](manuals/httpApiSpec.md) — входящий HTTP API: запуск агента из CI, бота или крона с продолжением сессии (скормить LLM → готовый вызов).
- [pipelinesSpec.md](manuals/pipelinesSpec.md) — формат `.vibe/pipelines.json`: последовательность шагов агентов с передачей артефактов (скормить LLM → готовый файл).
- [skillSpec.md](manuals/skillSpec.md) — формат `SKILL.md`: навыки агента, поля, ограничения, наши расширения (скормить LLM → готовый навык).
- [optimizeByMetric.md](manuals/optimizeByMetric.md) — оптимизация под метрику: команда замера, контракт вывода, порог шума, что защищает честность цикла.
- [learningWorkspaceSpec.md](manuals/learningWorkspaceSpec.md) — формат `.vibe/learning/`: миссия, источники, следы уроков, правила выбора сложности (скормить LLM → готовый `MISSION.md`).
- [teachLearning.md](manuals/teachLearning.md) — как учиться в VibeIDE: отдельная папка на тему, миссия-гейт, цикл уроков, что ломает систему.
- [outputCompression.md](manuals/outputCompression.md) — сжатие вывода команд: что сворачивается по типам команд, как вернуть подробность через `expand_output`, чем это лучше перезапуска, как отключить.
- [securityFaq.md](manuals/securityFaq.md) — что уходит наружу, что остаётся локально.
- [telegramBridge.md](manuals/telegramBridge.md) — мост в Telegram: свой бот за минуту, токен в хранилище секретов, привязка чата, работа за прокси.
- [telegramClaudeCode.md](manuals/telegramClaudeCode.md) — Claude Code с телефона: команды `/cc`, кнопки подтверждения, рабочая папка, чего мост не умеет.
- [specsWorkflow.md](manuals/specsWorkflow.md) — как работать со спеками; **источник** справки «?» в панели «Спеки» (генерируется на сборке).
- [vibeEnvironment.md](manuals/vibeEnvironment.md) — окружение `.vibe`: почему устаревает, две команды, lock-файл.

**Планирование Phase 1 и нормативные документы**
- [v1/README.md](v1/README.md) — индекс всех V1-документов (phases, agent, config, integrations, risks, transparency, vision).
- [references-v1/README.md](references-v1/README.md) — индекс нормативных справок и контрактов.
- [benchmarks/minimalism-methodology.md](benchmarks/minimalism-methodology.md) — методика замеров минимализма.

**Процесс и релизы**
- [CONTRIBUTING.md](CONTRIBUTING.md) — процесс контрибьюта и ревью PR. **Не переносить** — GitHub ищет его только в корне, `docs/` или `.github/`.
- [release-donation-phrases.md](release-donation-phrases.md) — фразы блока «Поддержать проект».
- Release notes **не хранятся в репо** — источник правды это GitHub Releases (`gh release view vX.Y.Z`). Формат — в [CLAUDE.md](../CLAUDE.md).

**Сравнения** (маркетинговые материалы)
- [VibeIDE-vs-Other-AI-Editors.md](VibeIDE-vs-Other-AI-Editors.md) — сравнение с другими AI-редакторами.
- [VibeIDE-Model-Support-Comparison.md](VibeIDE-Model-Support-Comparison.md) — поддержка моделей.

`docs/specs/` — рабочие спеки воркспейса (создаются панелью «Спеки»), в навигацию не входят.
`docs/.obsidian/` — конфиг Obsidian, в `.gitignore`.

**Правило: мануалы — только в `docs/manuals/`, имена в camelCase** (`specsWorkflow.md`, `ciCdGuide.md`).
Мануал — руководство «как сделать» по шагам. Каталог возможностей (`functional.md`), план (`roadmap.md`),
индекс базы знаний (`knowledge/README.md`), концепт (`idea.md`), FAQ и регламенты — не мануалы, живут вне `manuals/`.
Исключение: `docs/CONTRIBUTING.md` остаётся на месте — GitHub ищет его в корне, `docs/` или `.github/`
и по нему показывает плашку с гайдлайнами при создании issue/PR; из `manuals/` он его не найдёт.

`docs/.obsidian/` — Obsidian editor конфиг, в `.gitignore`.

## Конвенции записи

**Формат записи в knowledge:** `Контекст / Суть / Применение` (опционально: `Antipatterns`, `Доп.`, `Устарело`). Примеры — любой существующий файл.

**Когда писать в knowledge:**
- Открыл что-то нетривиальное в коде (не должно повторно становится сюрпризом).
- Нашли причину incident'а и решение (post-mortem без формальностей).
- Vendor quirk / blacklist / known-broken combination.
- Architectural decision (ADR-style без хедера).

**Когда НЕ писать:**
- Ephemeral state (in-progress refactor) — для этого `.vibe/plans/`.
- Личные заметки — auto-memory (`~/.claude/.../memory/`).
- Code comments — рядом с кодом, не дублировать.

**Куда что:**
- LLM/Anthropic SDK/quirks — `knowledge/architecture/`
- Build/installer/Windows — `knowledge/build/`
- Stall/timeout/recovery — `knowledge/chatUx/`
- File ops/services API — `knowledge/runtimeQuirks/`
- Tool definitions/aliases — `knowledge/toolSystem/` или `knowledge/architecture/toolCalling.md`
- Agent workflow rules (тон, протокол, реакция на корнеры) — `knowledge/agentCollaboration/`

## Roadmap

`docs/roadmap.md` — главный план. Phases 0-3, фактическое состояние реализации (`[x]`/`[~]`/`[ ]` markers), audit-pass логи (секции W/X с findings).

**Где найти что:**
- Что осталось сделать в текущей фазе — search `[ ]` в `roadmap.md` (или `[/]` для in-progress).
- Что закрыто и где артефакт — search `[x]` + ссылка на коммит/файл.
- Skeleton (нужна follow-up) — search `[~]` + рядом одна строка «что осталось».

## История policy

- 2026-05-14: knowledge консолидирована в `docs/knowledge/`, auto-memory становится тонкой routing layer.
- 2026-05-23: **`docs/` перешёл в git tracking** (commit `4fa021cc`). До этого — gitignored, локально-только. Изменение: knowledge стал shared между автор/команда/AI-агенты на разных машинах, локально-only стало неточным.

## См. также

- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow contribution'а в docs/, code, knowledge entries.
- `CLAUDE.md` — тон, протокол, версионирование (root репо, не в docs/).
- `AGENTS.md` — поведение Codex/других CLI агентов в проекте.
- `.vibe/rules/` — workflow rules для агентов VibeIDE.
