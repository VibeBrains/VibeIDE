# Git flow и AI co-author

← [Knowledge Index](../README.md)

Стандартный flow коммитов, глобальный hook против AI co-author trailers, push из Cursor shell, lockfile в `extensions/*`.

---

## [договорённость] Git флоу коммитов

**Контекст:** зафиксировано из прошлого проекта.

**Суть:** стандартный флоу без хитростей — `git add .` → `git commit -m "feat: описание (vX.Y.Z)"` → `git push`. Релизы через `gh release create`.

**Применение:** при каждом коммите в VibeIDE.

---

## [договорённость] Убрать AI co-author из коммитов — глобальный hook

**Контекст:** Cursor и Claude Code могут автоматически добавлять co-author trailers в коммиты.

**Суть:** глобальный hook `%USERPROFILE%\.git-hooks\prepare-commit-msg` (путь прописан в глобальном git config: `core.hookspath`). Зачищает:
```bash
#!/bin/sh
COMMIT_MSG_FILE="$1"
sed -i '/^Co-authored-by: Cursor <cursoragent@cursor\.com>$/d' "$COMMIT_MSG_FILE"
sed -i '/^Made-with: Cursor$/d' "$COMMIT_MSG_FILE"
sed -i '/^Co-authored-by: Claude/Id' "$COMMIT_MSG_FILE"
```
Дополнительно в Claude Code settings: `"includeCoAuthoredBy": false`.

**Применение:** при добавлении нового AI-инструмента — дописать sed-строку в hook.

---

## [инструмент] Убрать Co-authored-by (Claude и Cursor) из коммитов

**Контекст:** пользователь не хочет, чтобы AI инструменты фигурировали как контрибьюторы в истории коммитов.

**Суть:**
- Глобальный git hook: `%USERPROFILE%\.git-hooks\prepare-commit-msg`
- Зачищает: `Co-authored-by: Cursor <cursoragent@cursor.com>`, `Made-with: Cursor`, `Co-authored-by: Claude*` (регистронезависимо)
- Подключён через `git config --global core.hooksPath %USERPROFILE%\.git-hooks`
- В Claude Code settings: `"includeCoAuthoredBy": false` — Claude не добавляет co-author trailer автоматически

**Применение:** при добавлении нового AI-инструмента — добавить строку в `prepare-commit-msg`; при коммитах не добавлять co-author вручную.

---

## [баг] git push из Cursor shell — GitHub недоступен по HTTPS

**Контекст:** попытки пушить в GitHub из терминала Cursor.

**Суть:** Cursor's shell изолирует сетевые соединения — `git push` по HTTPS таймаутит. `gh auth status` работает (другой HTTP-клиент). Решение: выполнять `git push` из своего терминала (PowerShell/Git Bash), не из Cursor shell. `gh auth setup-git` не помогает.

**Применение:** при всех git push операциях — использовать внешний терминал.
