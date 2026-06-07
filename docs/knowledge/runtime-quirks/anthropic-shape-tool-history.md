# Anthropic-форма истории терялась в AI SDK адаптере

← [Knowledge Index](../README.md)

---

## [инцидент] 2026-06-07 — sonnet через Zen бесконечно повторял get_dir_tree: tool-история не доезжала до провайдера

**Контекст:** claude-sonnet-4-6 через openCode Zen (`/zen/v1/messages`, anthropic-протокол)
зацикливался на дословном повторе `get_dir_tree` с пустыми текстовыми ходами (`out:7`).
Похожий цикл наблюдался утром того же дня (тогда списали на компакцию окна подпинами —
тот фикс тоже валиден, но корень был глубже).

**Суть:** рассинхрон форм сообщений между слоями. Renderer для anthropic-протокольных
маршрутов собирает историю в **Anthropic-форме**: assistant с `content[].tool_use`-блоками,
user с `content[].tool_result`-блоками, без `role:'tool'`. А `convertMessagesToModelMessages`
в `aiSdkAdapter.ts` понимал только **OpenAI-форму** (`assistant.tool_calls[]`,
`role:'tool'` + `tool_call_id`) и из массивов контента брал только `type==='text'` —
tool_use и tool_result **молча выбрасывались**. Провайдер получал историю, где вызовов
инструментов и их результатов не существует → модель легитимно повторяла вызов вечно.

**Диагностика, которая вскрыла:** в `promptDump.messagesLens` tool-результаты шли как
`{role:'user', len:0}` (len меряет только text-блоки — сам по себе не доказательство), но
`TokenBudget in:` вырос всего на +32 токена за ход, в котором в payload добавился результат
дерева на ~800 токенов — контент физически отсутствовал в запросе.

**Фикс:** конвертер стал толерантным к обеим формам (`aiSdkAdapter.ts`):
- `buildToolNameLookup` дополнительно сканирует `content[].tool_use`;
- assistant-ветка маппит `tool_use` → AI SDK `tool-call` part;
- user-ветка маппит `tool_result` → отдельное `role:'tool'` сообщение (orphan без
  известного tool_use_id деградирует в инлайн-текст `[tool result]…`, чтобы строгие
  провайдеры не отдавали 400 на «tool без tool_calls»); user, состоявший только из
  tool_result-блоков, не порождает пустого user-хода;
- заодно поддержана Anthropic-форма картинок (`source.base64`).

**Применение:** при любом «модель повторяет один и тот же вызов, не видя результат» —
ПЕРВЫМ делом сверить `TokenBudget in:`-прирост с ожидаемым размером tool-результата;
`messagesLens len:0` у user-сообщений после assistant-хода — маркер именно этой формы.
При добавлении нового протокольного маршрута проверять оба конца: какую форму собирает
renderer и какую парсит адаптер.

**Связано:** [../architecture/ai-sdk-migration-wip.md](../architecture/ai-sdk-migration-wip.md),
[../architecture/api-protocol-routing.md](../architecture/api-protocol-routing.md),
isSyntheticNudge-фикс (Step A.5) — смежный, лечил усиление этого же симптома компакцией.
