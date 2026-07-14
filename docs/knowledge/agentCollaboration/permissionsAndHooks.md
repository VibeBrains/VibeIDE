# Permissions and Hooks

Правила выдачи разрешений Claude Code в этом проекте. Покрывает write-capable инструменты (Edit/Write/MultiEdit/NotebookEdit) и destructive Bash.

---

## Marker-gated permissions, не flat global allow [security] [workflow]

**Контекст.** При выдаче write-разрешений долгоиграющему скиллу (`roadmap-max`) предложен был выбор между «add Edit, Write, MultiEdit to permissions.allow глобально» и «PreToolUse hook + marker file». Пользователь выбрал marker-gate.

**Суть.** Не давать unrelated сессиям наследовать broad write access только потому, что одному скиллу это понадобилось. Разрешения активны **только пока работает соответствующий скилл**. Marker создаётся при старте, удаляется при завершении, имеет 6-часовой TTL fail-safe.

**Применение.**
- Любой новый запрос на write-tool / destructive Bash → дефолт marker-gate, **не** flat global `allow`.
- Reference implementation:
  - `~/.claude/hooks/roadmap-max-gate.ps1` — PreToolUse hook
  - `~/.claude/skills/roadmap-max/SKILL.md` — Step −1 / Step 6 marker create/cleanup
  - `~/.claude/skills/roadmap-max-clear/SKILL.md` — manual dangling-marker cleanup
- Read-only tools (Read, Grep, Glob, WebFetch, WebSearch) → flat global allow OK, пользователь явно принял это без скоупинга.
- TTL на маркере **non-negotiable**: никогда не проектировать marker-gate без self-clean fail-safe.
