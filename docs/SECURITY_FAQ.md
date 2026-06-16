# VibeIDE Security FAQ

> Для privacy-аудитории: что уходит наружу, что остаётся локально, в каких режимах.

---

## Что VibeIDE отправляет наружу?

### По умолчанию (BYOK режим)

| Данные | Куда | Когда |
|--------|------|-------|
| Ваш код (контекст) | LLM провайдер (Anthropic, OpenAI, etc.) | При каждом запросе к агенту |
| Промпты | LLM провайдер | При каждом запросе |
| Версия IDE | registry.vibeide.io/models.json | При старте (только GET, без кода) |
| Агрегированная статистика | Не отправляется (Phase 1) | — |

### В Offline/Privacy режиме

| Данные | Статус |
|--------|--------|
| Код и промпты | ✅ Остаётся локально |
| Embedding (RAG) | ✅ Только локальная модель (Ollama) |
| Автообновление | ✅ Отключено |
| Телеметрия | ✅ Отключена |

---

## Провайдеры и дообучение на ваших данных

| Провайдер | Обучение на API-запросах | Как отключить |
|-----------|--------------------------|----------------|
| Anthropic | Нет по умолчанию | — |
| OpenAI | Нет для платных планов | [Privacy settings](https://platform.openai.com/account/privacy) |
| Google Gemini | Нет по умолчанию | — |
| Ollama | ✅ Никогда (локально) | — |

---

## API-ключи — как хранятся?

Через **Electron `safeStorage`**:
- macOS: Keychain
- Windows: DPAPI (Data Protection API)
- Linux: libsecret

Никогда: localStorage, plaintext файлы.

---

## Аудит-логи — где хранятся?

В `.vibe/snapshots/` и `.vibe/audit.jsonl` **в вашей рабочей директории**.  
Никогда не отправляются на серверы VibeIDE.

Управление логами:
- Экспорт: `Settings → VibeIDE → Audit → Export` (GDPR portability)
- Удаление: `Settings → VibeIDE → Audit → Delete All` (GDPR erasure)

---

## Workspace isolation — агент может читать `/etc/passwd`?

Нет. Агент работает только внутри рабочей директории проекта.  
Любой выход за её пределы — явный prompt с указанием пути.

Дополнительно защищают:
- `.vibe/ignore` — явный blacklist файлов
- `.vibe/constraints.json` — запреты на чтение/запись паттернов
- `secretDetectionService` — блокирует передачу секретов в LLM

---

## Расширения — имеют ли доступ к коду?

Расширения из Open VSX имеют доступ через стандартный VS Code Extension API.  
VibeIDE добавляет:
- Extension Permissions UI (Phase 1): декларации capability при установке
- Extension Security Scanner (Phase 1): проверка через socket.dev при установке

---

## MCP серверы — безопасны?

VibeIDE блокирует:
- HTTP (незашифрованные) remote URLs
- Предупреждает о потенциально опасных stdio командах (curl, wget, bash)

MCP серверы работают в отдельном процессе (stdio transport) или подключаются к сети через HTTPS.

---

## Incident Response

Агент случайно удалил важный файл? Неверно изменил код?

1. **Откат**: `Agent Action History sidebar → выбери шаг → Rollback`
2. **Снапшоты**: `.vibe/snapshots/` — JSON файлы с содержимым файлов до изменений
3. **CLI**: `node scripts/vibe-session-replay.js --list` — посмотреть что делал агент
4. **Репорт**: [github.com/VibeBrains/VibeIDE/issues](https://github.com/VibeBrains/VibeIDE/issues)

---

## Открытый исходный код

Весь код VibeIDE открыт:  
**[github.com/VibeBrains/VibeIDE](https://github.com/VibeBrains/VibeIDE)**

Любой может проверить что именно отправляется наружу.
