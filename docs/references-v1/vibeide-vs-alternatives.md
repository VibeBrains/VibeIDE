# VibeIDE vs Alternatives — Honest Comparison

> Used in onboarding to position VibeIDE relative to Continue.dev, Cursor, Windsurf, and Aider.  
> Philosophy: short, honest, no marketing fluff.

---

## vs Continue.dev

| Feature | Continue.dev | VibeIDE |
|---|---|---|
| **Standalone app** | VS Code extension | Standalone IDE (fork of VS Code) — no extension tax |
| **Transparency Suite** | Not built-in | Built-in: context window visualizer, prompt versioning, debug prompt, audit log |
| **Audit log** | None | GDPR-exportable, encrypted opt-in, queryable |
| **Privacy mode** | Partial | First-class: stealth mode, fingerprint stripping, local embeddings only |
| **Agent Plans** | None | Persisted `.vibe/plans/*.plan.md` with resume after crash |
| **Constraints** | No | `.vibe/constraints.json` — hard deny_write rules before agent executes |
| **Dead Man's Switch** | No | Built-in: auto-pause agent after N minutes of inactivity |
| **MCP support** | Yes | Yes + marketplace + port conflict check |
| **Local models** | Yes (Ollama etc.) | Yes + auto-detect onboarding |
| **Price** | Free / open-source | Free / open-source |

**TL;DR:** Continue.dev is a great VS Code extension. VibeIDE is a standalone IDE with a full Transparency & Control suite built in.

---

## vs Cursor

| Feature | Cursor | VibeIDE |
|---|---|---|
| **Open source** | No (proprietary fork) | Yes (MIT, fork of VS Code) |
| **Audit log** | No | Yes |
| **Privacy mode** | Paid feature | Free, first-class |
| **Agent constraints** | No | `.vibe/constraints.json` hard rules |
| **Subscription required** | Yes (for AI features) | No — BYOK (bring your own key) |
| **Background agent** | Yes (cloud-based) | Planned (Phase J, local-first) |

---

## vs Windsurf

| Feature | Windsurf | VibeIDE |
|---|---|---|
| **Open source** | No | Yes |
| **Agent audit trail** | No | Yes |
| **Constraint enforcement** | No | Yes |
| **Price** | Subscription | Free + BYOK |

---

## vs Aider

| Feature | Aider | VibeIDE |
|---|---|---|
| **UI** | CLI only | Full IDE UI |
| **Transparency** | Git diffs | Transparency Suite + audit |
| **Context control** | Manual file selection | Smart context picker + constraints |
| **MCP** | No | Yes |

---

## vs Managed-Agent Platforms (Multica, Paperclip)

> Знакомы с платформами оркестрации агентов «как командой/компанией» (Multica, Paperclip)? Почти всё это в VibeIDE **уже встроено** — просто под своими названиями.

| Что вы знаете там | Как это называется в VibeIDE |
|---|---|
| **Squads** / оргчарт-роли (лидер раздаёт работу) | Vibe Agents: субагенты + оркестратор + роли-персоны + vision-роутинг |
| **Reusable Skills** в реестре + семантический поиск | Agent Skills (`.vibe/skills/`) + Community Skills marketplace + локальные эмбеддинги |
| **Autopilots** (расписание → авто-задачи: стендапы, аудиты) | Background agent + nightly-roadmap skill |
| **Тикеты** + журнал всех действий агента | Persisted Plans (`.vibe/plans/`) + JSONL-журнал + audit log |
| **Бюджеты** + авто-пауза агента | Token budget (лимит на сессию) + Dead Man's Switch + статус-бар стоимости |
| **Governance** (пауза/стоп/override, одобрение) | Кнопки в плане + `.vibe/constraints.json` (hard-правила до выполнения) |
| **Agent-agnostic** (Claude/OpenAI/Gemini) | Мульти-провайдер BYOK через AI SDK |

**Ключевое отличие:** Multica/Paperclip — отдельные пульты, дирижирующие внешними agent-CLI. В VibeIDE агент **встроен в саму IDE** — оркестрация и редактор в одном месте, без второго сервиса.

---

## When to use Continue.dev instead

- You want a lightweight extension without switching IDEs
- Your team already standardized on VS Code with specific extensions
- You need Continue's deep VS Code integration (custom context providers, etc.)

VibeIDE imports Continue.dev config via `vibe init --from continue`.
