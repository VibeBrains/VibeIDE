## ✨ Новое

- **`reasoning_content` round-trip для thinking-моделей через OpenAI-совместимые агрегаторы** — DeepSeek-thinking через openCode/zen, vLLM, liteLLM **требуют** прислать обратно `reasoning_content` предыдущего assistant-сообщения, иначе на втором тёрне отвечают HTTP 400 «reasoning_content must be passed back». Теперь это происходит в двух точках: `prepareMessages_openai_tools` пришивает `reasoning_content` к assistant-сообщению (custom-поле, plain OpenAI/GPT его игнорируют — безопасно слать всегда), а `aiSdkAdapter.convertMessagesToModelMessages` эмитит `{ type: 'reasoning', text }` part первым в списке для AI SDK 4.x+. Multi-turn с reasoning-моделями через агрегаторы заработал.
- **Реальные токены провайдера — end-to-end** — AI SDK v5+ присылает `usage`/`totalUsage` в `finish-step`/`finish`-парт (поля `inputTokens`/`outputTokens` + fallback на v4 `promptTokens`/`completionTokens`). Новый тип `LLMTokenUsage` пробрасывается: `aiSdkAdapter` ловит и аккумулирует → `OnFinalMessage` → `sendLLMMessageService.tokenBudgetService.recordUsage` пишет **настоящие** числа в бюджет (вместо `length/4`-эвристики на ответе) → `chatThreadService` персистит `thread.state.lastUsage` → метрики и UI получают авторитет.
- **Контекст-индикатор в чат-пане больше не врёт в 50×** — раньше левый бейдж считал `previousMessages.reduce(length/4)` только по тексту сообщений, игнорируя system prompt + skill expansion + tools schema + history; занижение в десятки раз. Теперь приоритет источников: (1) реальный `lastUsage.promptTokens + completionTokens` после первого тёрна → (2) `IVibeContextGuardService.onUsageUpdated` (та же эвристика, что и в правом «Контекст: X / Y» панель и нижний status bar — по **полному** prompt'у) → (3) `messagesTokens` как degenerate fallback. Draft-токены живо досчитываются эвристикой поверх.
- **Сжатие старых tool-results** — настройка `vibeide.chat.compactToolResultsAfterTurns` (default `3`, 0 — выключено). Tool-outputs старше N user-turns заменяются на summary с пометкой `[summarized: N tokens]`. Лечит линейный рост input prompt'а в долгих агентских циклах — главная причина `AI_RetryError` у openCode/minimax-m2.7 на больших проектах.
- **Truncation тяжёлых поисковых тулзов** — `vibeide.tools.searchMaxChars` (default `8000`, ≈2K токенов). Head+tail truncation с маркером `[truncated]` для `grep`, `glob`, `search_for_files`, `search_pathnames_only`, `ls_dir`, `get_dir_tree`. Один greedy `grep "**/*"` на большом репо больше не забивает весь context window. Cap читается per-call — изменение настройки применяется сразу.
- **Опциональное отключение тяжёлых поисковых тулзов в `gather`/`plan`** — `vibeide.tools.disableExpensiveSearchInNonAgentModes` (off by default). Read/navigation-тулзы (`read_file`, `ls_dir`, `go_to_definition`, `find_references`) остаются, тяжёлые поисковые — выключаются. Опция для жёстко лимитированных по токенам провайдеров.
- **Pin-protect для `/skill:` и workspace-guidelines от трим-логики** — `_findLargestByWeight` мог тихо вырезать тело SKILL.md из системного сообщения, когда контекст переполнен; модель видела `/skill:NAME` в истории, но не сами инструкции, и галлюцинировала процедуру. Теперь у такого system-сообщения weight=0 — тример выберет вместо него старые user/tool сообщения.
- **Catalog-aware model capabilities** — новый sync-метод `IRemoteCatalogService.getCachedModelInfo()` (case-insensitive по `id`, затем `name`, без сети). `getModelCapabilities` в чат-индикаторе теперь принимает `catalogInfo` и использует реальный `contextWindow` провайдера, а не общий пресет — те же числа, что pipeline шлёт в SDK.
- **AI SDK `maxRetries: 5`** (вместо default 2) — aggregator-proxied модели (openCode/zen → DeepSeek-thinking, BigPickle, minimax-m2.7) троттлят на бёрстах агентских шагов, и 3 попытки попадают в одно rate-limit окно. 6 попыток с exp-backoff `2^n` дают ~60s разброса — окно сбрасывается. Успешный первый запрос — без задержки.
- **Sweep context windows у open-source моделей** к актуальным спекам: DeepSeek (V1/V2/V3) 32K → 64K/128K, Gemma 32K → 128K, Llama 32K → 128K, добавлен **`deepseekV4`** (128K, fallback для self-hosted; для известных агрегаторов выигрывает каталог).
- **`/skill:` dropdown — UX-полировка** — авто-скролл подсвеченного элемента в зону видимости при `↑/↓` (раньше уезжал за viewport), и сам дропдаун теперь выбирает сторону (выше/ниже textarea) исходя из свободного места.

## 🐛 Исправления

- **Зелёный цвет у spinner-эмодзи в чате** — `⏳` / `🔄` рендерились в тёмно-сером (от родительского `text-vibe-fg-2`), несмотря на то что Segoe UI Emoji их рисует зелёным. Каскад `var(--vscode-charts-green, --vscode-gitDecoration-addedResourceForeground, --vscode-terminal-ansiBrightGreen, --vscode-terminal-ansiGreen, #89D185) !important` — теперь зелёный во всех VS Code темах, в которых хоть один из токенов определён.
- **Диагностика invalid tool-params** — на validation failure теперь в консоль уходит подробный дамп: имя тулзы, исходное сообщение валидатора, raw-параметры, JSON, и ключи объекта. Без этого виден был только бейдж «Invalid parameters» и приходилось угадывать, что именно модель напутала (галлюцинированный путь, пропущенное поле, неправильный envelope).
- **`reasoning` корректно сохраняется в `SimpleLLMMessage`** — поле появилось в типе `SimpleLLMMessage` и заполняется в `_chatMessagesToSimpleMessages`, иначе `prepareMessages_openai_tools` нечего было бы пристёгивать (фикс самой цепочки, без которого фича `reasoning_content` round-trip не работала бы).

## 📦 Сборка

- **Никаких новых runtime-зависимостей** — вся работа уложилась в существующие пакеты (`ai`, AI SDK уже на `^6.0.182`).

---

### Поддержать проект

Если VibeIDE оказалось полезным — буду рад благодарности.
Контекст-индикатор больше не врёт в 50×. Реальные токены провайдера → реальные числа. Счётчик кофе у автора тоже честный — кнопка ниже его обновляет.

<a href="https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/media/QR-Code.jpg" target="_blank">
  <img src="https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/media/QR-Code.jpg" width="120" alt="QR-код для поддержки проекта">
</a>
