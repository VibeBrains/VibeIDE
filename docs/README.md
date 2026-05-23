# VibeIDE — Documentation

Все долгоживущие знания, планы и решения проекта. Источник правды для команды и AI-агентов работающих с репозиторием.

> Тон: рабочие записи, не маркетинг. Цель — чтобы через месяц можно было найти причину решения и не повторить ошибку.

---

## Структура

```
docs/
├── roadmap.md                     # Главный roadmap (фазы, секции W/X/...)
├── knowledge.md                   # Точка входа в knowledge base (короткий индекс)
├── knowledge/                     # База знаний по темам — single source of truth
│   ├── README.md                  # Полный индекс всех топиков
│   ├── architecture/              # LLM pipeline, tool calls, model quirks
│   ├── agent-collaboration/       # Workflow с AI-агентами, permissions, hooks
│   ├── build/                     # Windows toolchain, портабл, update service
│   ├── chat-ux/                   # Поведение чата, circuit breakers, stall recovery
│   ├── git-and-tools/             # Git flow, vibe-doctor, bin scripts
│   ├── i18n/                      # Language pack, NLS, React i18n
│   ├── patterns/                  # Recurring patterns + lessons learned
│   ├── runtime-quirks/            # Path/URI, services accessor, idle memory, watchdog
│   ├── tool-system/               # Built-in tools contract, read/edit safety
│   ├── ui/                        # CSS pipeline, scope-tailwind, themes
│   ├── vibe-dotfolder/            # .vibe/ workspace config
│   ├── assets/                    # Логотипы, onboarding
│   └── roadmap/                   # Run logs (roadmap-max sessions etc.)
├── v1/                            # Подробное планирование Phase 1
│   ├── README.md                  # Индекс всех V1 документов
│   ├── phases/                    # phase-0..phase-3b — детальные чеклисты
│   ├── agent/                     # Auto-repair, skills, trust-score
│   ├── config/                    # rules/constraints/profiles/.vibe
│   ├── integrations/              # Project Manager, Synthwave84, VSCodeSync
│   ├── risks/                     # Architecture/product/security risks
│   ├── transparency/              # Control & visibility design
│   ├── vision/                    # North star, market, narrative
│   ├── gateway-threat-model.md    # Security model для будущего gateway
│   ├── monetization.md            # Business model
│   ├── open-vsx-gap-list.md       # Чего не хватает vs marketplace
│   ├── performance-sla.md         # Cold start / memory targets
│   └── ...
├── CI_CD_GUIDE.md                 # CI/CD pipeline overview
├── SECURITY_FAQ.md                # Security responses
├── release-donation-phrases.md    # Фразы блока «Поддержать проект»
└── release-notes-v0.3.0.md        # Архивные release notes (historical)
```

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
- Stall/timeout/recovery — `knowledge/chat-ux/`
- File ops/services API — `knowledge/runtime-quirks/`
- Tool definitions/aliases — `knowledge/tool-system/` или `knowledge/architecture/tool-calling.md`
- Agent workflow rules (тон, протокол, реакция на корнеры) — `knowledge/agent-collaboration/`

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
