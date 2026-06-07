# Авто-даунгрейд в XML: три замка, без любого из которых он не живёт

← [Knowledge Index](../README.md)

---

## [инцидент] 2026-06-08 — даунгрейд «no-tools endpoint» трижды не доживал до повтора хода

**Контекст:** free-эндпоинты OpenRouter без поддержки tools (404 «No endpoints found that
support the provided 'tool_choice'») должны автоматически переключать модель на XML-формат
тулов и повторять ход. Фича падала тремя независимыми способами, каждый маскировал следующий
(карусель тостов → испарившийся override → откат recovery). Диагностика заняла три прогона.

**Суть — три слоя:**

1. **Run-local guard.** `downgradedModelsThisSession` объявлен ВНУТРИ `_runChatAgent` —
   живёт один прогон. Повтор хода = новый прогон = свежий Set → даунгрейд «впервые»
   бесконечно (мигающий тост). Замок: session-wide поле класса `_noToolsDowngradedModels`.

2. **`undefined` умирает на IPC и на диске.** Override `{ specialToolFormat: undefined }`
   теряет ключ при JSON-сериализации (renderer→main IPC и storage) → main-процесс
   продолжает слать native tools. Замок: persistable-sentinel **`null`** в `ModelOverrides`
   (только там), `getModelCapabilities` нормализует `null → undefined` на чтении.
   ⚠️ Этим страдал и numeric-tool-name даунгрейд с момента написания.

3. **Cross-session recovery стирает свежие override'ы.** O.11 при старте нового прогона
   очищает `_autoDetected`-override'ы («свежий шанс native»), сверяясь с run-local сетами —
   повтор хода = новый прогон → recovery стёр override через секунду после записи. Замки:
   проверка session-wide сета + **age-guard** (не трогать override'ы моложе 10 минут —
   «cross-session» лечит вчерашнюю залежалость, а не запись секундной давности).

**Применение:**
- Любой «запиши override → перезапусти прогон» паттерн обязан проверять ВСЕ места, где
  override может быть стёрт/потерян между записью и повторным чтением (IPC, storage,
  recovery/janitor-механизмы, run-local guard'ы).
- **Сериализуемость значений — часть контракта настроек:** `undefined` в персистируемых /
  IPC-передаваемых объектах = молчаливая потеря. Для «принудительно выключено» — `null`.
- Диагностика таких цепочек: warn-лог на КАЖДОМ участнике (downgrade пишет, recovery пишет,
  guard пишет) — именно по этим строкам цепочка читалась из лога дословно.

**Связано:** [anthropic-shape-tool-history.md](anthropic-shape-tool-history.md),
[provider-quota-429.md](provider-quota-429.md), roadmap O.7/O.11 (tool-call resilience).
