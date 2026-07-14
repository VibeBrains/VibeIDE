# Configuration namespaces — что наше, что бандла

## Контекст

При открытии **File → Preferences → Settings** в консоль раньше прилетал warning от `SettingsEditor2:1389` —
`Settings not included in settingsLayout.ts: …` со списком ~120 ключей. Источник — `_resolveSettingsTree`
в `settingsTree.ts`: всё, что не подпадает ни под один pattern в `tocData` ([settingsLayout.ts](../../../src/vs/workbench/contrib/preferences/browser/settingsLayout.ts)),
сваливается в `leftoverSettings`. Дерево навигации в UI этих ключей не показывает —
найти их можно только поиском.

В VibeIDE до правок 2026-05-12 **ни одного** упоминания `vibeide.*` в `settingsLayout.ts` не было —
все наши ключи регистрировались программно через `IConfigurationRegistry`, но в TOC не попадали.

## Суть

### `vibeide.*` — наш namespace

Зарегистрировано на 2026-05-12 — **97 ключей** (счётчик `vibe-settings-toc-coverage.mjs`), сгруппированы под одной top-level
секцией `vibeide` в `settingsLayout.ts` с подразделами:

| Подраздел | Glob-патёрны |
|---|---|
| `vibeide/agent` | `vibeide.agent.*`, `agentUI.*`, `ambientAgent.*`, `backgroundAgent.*`, `chat.*`, `roadmapAgent.*`, `subagent.*`, `aiProvenance.*` |
| `vibeide/safety` | `vibeide.safety.*`, `audit.*`, `secretDetection.*`, `stealthMode.*` |
| `vibeide/context` | `vibeide.context.*`, `rag.*`, `specContext.*`, `projectRules.*`, `autocomplete.*` |
| `vibeide/providers` | `vibeide.mcp.*`, `mcpOAuth.*`, `providers.*`, `cost.*` |
| `vibeide/observability` | `vibeide.otel.*`, `planEventsJournal.*`, `debug.*`, `output.*` |
| `vibeide/tools` | `vibeide.commands.*`, `browserAutomation.*`, `backgroundJob.*`, `diffPreview.*`, `notifications.*`, `statusBar.*`, `voice.*` |
| `vibeide/appearance` | `vibeide.theme.*`, `locale`, `cloud.*` |
| `vibeide/other` | `vibeide.*` (catch-all для новых ключей до классификации) |

Catch-all `vibeide.*` в `vibeide/other` важен: новые ключи **не вызывают warning** до того, как их
переложат в правильную категорию. Coverage CI ([`vibe-settings-toc-coverage.mjs`](../../../scripts/vibe-settings-toc-coverage.mjs))
проверяет, что каждый зарегистрированный ключ покрыт хотя бы одним pattern из layout — это страховка
от ошибочного удаления catch-all'а.

### `chat.*` — бандлованные расширения, **не наш контракт**

Сразу под `vibeide` лежит top-level `chat-extensions` (label «Chat (Extensions)»). Покрывает:

- `chat.*` (~25 ключей) — Copilot Chat / Anthropic chat fork: `chat.agentHost.*`, `chat.artifacts.*`, `chat.autopilot.enabled`, `chat.editing.*`, `chat.experimental.*`, `chat.permissions.default`, `chat.plugins.*`, `chat.subagents.*`, …
- `github.copilot.chat.*` — `github.copilot.chat.agent.terminal.allowList` / `denyList`.
- `imageCarousel.*` — отдельное расширение image carousel.
- `accessibility.signals.chat*` — accessibility signals от чат-расширений.

**Решение:** не переупаковывать в `vibeide.*` пространство, оставить как есть. Эти ключи приходят от чужих
расширений, и переименование сломает совместимость с их UI/командами. Достаточно, что они видны в TOC
под честным лейблом «Chat (Extensions)».

## Применение

### Когда добавляешь новую `vibeide.*` настройку

1. Зарегистрируй ключ в подходящем `*Configuration.ts` или Service-файле — coverage CI сразу подскажет,
   если пропустил.
2. Если ключ ложится в существующий glob (`vibeide.agent.responseLanguage` → `vibeide/agent`) — ничего
   менять в `settingsLayout.ts` не нужно.
3. Если новый под-namespace (`vibeide.newgroup.*`) — добавь pattern в нужную категорию **или** новую
   подсекцию `vibeide/newgroup`. Catch-all `vibeide/other` тебя прикроет до этого момента, но коммитить
   в `main` без явной категории — не норма.

### Когда расширение добавляет `chat.*`-подобный ключ

- Если расширение приходит **с VibeIDE из коробки** (бандл) — добавь его top-level namespace в
  `chat-extensions` или (если он крупный) в отдельный top-level рядом с `vibeide` / `chat-extensions`.
- Если расширение — **сторонний marketplace plugin** — оно регистрирует свои ключи само, и VS Code
  показывает их под «Extensions» автоматически.

### Диагностика «нет настройки в дереве»

- Перепроверь, что в [settingsLayout.ts](../../../src/vs/workbench/contrib/preferences/browser/settingsLayout.ts) есть pattern, под который ключ матчится по правилам `createSettingMatchRegExp`
  (`*` → `.*` — матчит включая точки).
- Если catch-all `vibeide/other` поймал ключ, но в дереве он лежит в «Other» — это сигнал, что в
  основной категоризации потеряли pattern. Подними его в правильную секцию.
- Если ключ вообще не виден поиском — проверь, что `registerConfiguration` действительно вызвался
  (контрибуция активирована, scope правильный).

### Не запускать `release-windows.ps1` без явной команды

Этот раздел документирован отдельно в AGENTS.md / CLAUDE.md, но повторяю — изменения в TOC относятся
к workbench/preferences, а не к `product.json`, и не требуют bump версии или релиз-цикла.

## Ссылки

- [settingsLayout.ts](../../../src/vs/workbench/contrib/preferences/browser/settingsLayout.ts) — TOC.
- [settingsTree.ts:684 `createSettingMatchRegExp`](../../../src/vs/workbench/contrib/preferences/browser/settingsTree.ts) — правила матчинга patterns.
- [settingsEditor2.ts:1383 leftoverSettings warning](../../../src/vs/workbench/contrib/preferences/browser/settingsEditor2.ts) — источник предыдущей жалобы.
- [scripts/vibe-settings-toc-coverage.mjs](../../../scripts/vibe-settings-toc-coverage.mjs) — coverage CI.
- [.github/workflows/settings-toc-coverage.yml](../../../.github/workflows/settings-toc-coverage.yml) — CI workflow.
