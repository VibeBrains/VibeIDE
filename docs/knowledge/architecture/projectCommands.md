# Project Commands (`.vibe/commands.json`) — runtime + UX

> Контекст: Roadmap §K.4 «Project Commands» — workspace-first shell shortcuts
> с trust/audit/keybinding инфраструктурой. Прошёл май 2026 sweep: 14 pure
> helpers → 7 runtime контрибуций.

## Контекст / Суть / Применение

### 1. Service-as-singleton + contribution-as-orchestrator

**Контекст.** `IVibeCustomCommandsService` (singleton, browser/) делает FS-watch +
`run()`. `VibeCustomCommandsContribution` — workbench contribution — стартует
сервис в `WorkbenchPhase.AfterRestored` и держит **динамические
CommandsRegistry registrations**. Status-bar, onboarding hint, janitor — каждый
отдельный contribution.

**Суть.** Когда сервис содержит data-cache и event-emitter, контрибуция держит
disposable-ы. Не пихать registerCommand/registerKeybindingRule в конструктор
сервиса — Delayed singleton instantiates lazy, регистрации потеряются.

**Применение.** Любой dynamic `vibeide.commands.run.<id>` = `Map<registryId,
IDisposable>` в contribution. `onDidChangeCommands` → dispose all → re-register.

### 2. FNV-1a stable hash для trust file

**Контекст.** `decideRunConfirm` нужен `commandShapeHash` для определения
«изменилась ли команда с последнего approve». Crypto не нужно — trust file
local-only, threat model ≠ adversary-controlled collisions.

**Суть.** FNV-1a 32-bit над `[command, args.join(\x1f), cwd, sorted-env-entries,
shell?].join(\x1e)`. Math.imul для безопасного 32-bit multiply.

**Применение.** Для любого «did this change since last approval» — FNV-1a + 8-char
hex prefix. Если нужно cross-machine — SHA-256, но это уже crypto.

### 3. Resolver результат имеет **two shapes**: `resolved` и `redactedForAudit`

**Контекст.** `resolveProjectCommandSecrets(input, lookups)` → `{ resolved,
redactedForAudit, unresolved }`. **resolved** — для spawn (env values inline).
**redactedForAudit** — для audit log (env values → `[REDACTED]`).

**Суть.** **Никогда не передавай `resolved` в audit channel.** Используй
`redactedForAudit`. Это инвариант — pure-helper тесты ловят leak'и через
`SECRET_CANARIES` fixtures.

**Применение.** `_audit.append({meta: redactCommandForAudit(record_from_redacted)})`.

### 4. Trust confirm + workflow gate **до** terminal spawn

**Контекст.** `run()` flow: resolve secrets → workflow gate (если workflowId set) →
trust confirm → terminal spawn. Порядок намеренный:

1. **Secrets первые**: если placeholder unresolved — отказ до показа dialog
   («не показывай пользователю команду, которую не сможем запустить»).
2. **Workflow gate второй**: если `workflowId` malformed/not-found — отказ; нет
   смысла спрашивать confirm на команду, которую запускать всё равно нельзя.
3. **Trust confirm третий**: финальный user gate перед spawn.

**Суть.** Кратчайший fail-fast путь = меньше user-facing surface, меньше
attack surface (нет state'а после которого мы partial-rolled-back).

**Применение.** Любой security gate с side-effect — order: validation →
external-dep-check → user-confirm → side-effect. Не реверсировать.

### 5. `KeybindingsRegistry.registerKeybindingRule` returns disposable

**Контекст.** Динамические шорткаты `ctrl+shift+alt+1..9` для top-9 pinned.
Когда pinned set меняется (FS-watcher trigger), все 9 regбиндов dispose'ятся и
ре-регистрируются.

**Суть.** В отличие от Action2 (immutable registration), `registerKeybindingRule`
**возвращает IDisposable**. Это позволяет re-bind dynamic chord allocation. До
сих пор у multiple roadmap items была пометка «KeybindingRegistry adoption
остаётся» — потому что мало кто знает, что adoption-pattern это
«registerKeybindingRule + сохранить disposable».

**Применение.** Любой dynamic chord set: `Map<chordId, IDisposable>` + dispose-all
+ re-register на каждом change-event. Не пытаться «unregister by id» — нет API,
только через disposable который вернул rule register call.

### 6. `MutableDisposable` для status-bar entries

**Контекст.** Status-bar indicator `▶ N` показывается только когда есть running
commands. `MutableDisposable<IStatusbarEntryAccessor>` — `.clear()` убирает entry
полностью, `.value = ...` пересоздаёт.

**Суть.** Не делать `entry.update({text: ''})` для скрытия — entry останется в
DOM. `MutableDisposable.clear()` — единственный способ корректного hide.

**Применение.** Любой transient status-bar widget = `MutableDisposable`. Update
через `entry.value.update(...)` когда уже есть, иначе `entry.value =
statusbar.addEntry(...)`.

### 7. `WorkspaceScope.WORKSPACE` для one-shot onboarding

**Контекст.** `vibeide.commands.onboardingHint.v1` хранится в
`IStorageService` `WORKSPACE` scope, не `APPLICATION` / `USER`. Это значит каждый
новый workspace получает свежий onboarding.

**Суть.** Опытному пользователю в его monorepo «закрепить?» уже не показываем,
но новичок в свежем checkout снова увидит. Точно тот UX, который roadmap L356
предписал.

**Применение.** Onboarding-style toasts → `StorageScope.WORKSPACE` + `markShown`
persisted **до** `notify()` (иначе rapid sequential success даст double-fire).

### 8. Periodic janitor через `setInterval` + `IFileService.resolve` dir-walk

**Контекст.** `vibePlanLeaseJanitorContribution` сканит `.vibe/plans/.leases`
каждые 30 секунд. Не FS-watcher — нужен `now` для TTL-вычисления, watcher
триггерится только на change.

**Суть.** Когда нужен periodic TTL-cleanup (lease-style), `setInterval` поверх
`IFileService.resolve(dir)` + `readFile(child)` + pure decide. Cleanup сам по
себе **не** должен thread-блокировать; всё async, sequential per-folder.

**Применение.** Любой TTL-cleanup для local file → этот pattern. interval 30s
для leases (TTL 120s, рекавери ≤150s). Other surfaces могут хотеть другой
cadence — но логика та же.

## Связанные документы

- [orphanServices.md](orphanServices.md) — список «сирот» сервисов без
  roadmap entry (часть теперь имеют homes — projectCommands из them).
- [patterns/settingsRegistrationSweep.md](../patterns/settingsRegistrationSweep.md)
  — phantom config keys паттерн (vibeide.commands.audit, .auditStdout,
  .toolbar.position, .globalPaths).
- `docs/roadmap.md` §K.4 «Project Commands» — current item-by-item status.

## Sweep history

- `c1b0faa6` — runtime service (FS-watch + run + secrets + terminal spawn)
- `cf02aeae` — trust confirm + audit log
- `54040950` — status-bar + dynamic CommandsRegistry registration
- `9ac660c3` — first-success onboarding hint
- `0ba0a6e5` — tasks.json import palette + workflow trigger gate
- `583dcb07` — default chord keybindings + KB-shortcuts metadata
- `f0f47bbd` — sanitizer gate + pin/unpin palettes
- `07a88a1e` — plan-lease periodic janitor (sibling, K.1 L903)

Сейчас Project Commands закрывает 14 → 7 skeleton items, остаются: form-based
React editor, top-bar pinned widget, community import URL flow, JSON Schema
GitHub Pages mirror.
