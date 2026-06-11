# `ServicesAccessor` и async handlers

← [Knowledge Index](../README.md)

---

## [vscode] `ServicesAccessor` и async handlers команд

**Контекст:** в DevTools / логе — **`Illegal state: service accessor is only valid during the invocation of its target method`** при выполнении команд VibeIDE (2026-05).

**Суть:** `CommandService` вызывает `instantiationService.invokeFunction(handler, …)`. У async-функции после **первого `await`** синхронная часть уже завершилась → `invokeFunction` в `finally` помечает accessor как недействительный; любой последующий **`accessor.get()`** бросает эту ошибку.

**Применение:** во всех **`async`** `CommandsRegistry.registerCommand` / `Action2.run` снимать нужные сервисы **`accessor.get` в начале**, до первого `await`; либо передавать в хелперы уже разрешённые сервисы, а не `ServicesAccessor`.

См. также конкретный кейс с multi-chat tabs: [architecture/chat-pane.md](../architecture/chat-pane.md) → трап #1.

**Рецидив (2026-06-11): найдено и исправлено ещё 4 команды** — `vibeide.projectRules.showSources`, `vibeide.showAlternativesComparison`, `vibeide.backgroundJob.createCheckpoint`, `vibeide.backgroundJob.scheduleHint`. Правило задокументировано с мая, но новый код его повторяет → нужен grep при ревью.

**Энейблер — `await import(...)` в начале `run()`.** Все 4 кейса начинались с динамических `const { IFoo } = await import('…')`, и `accessor.get(IFoo)` шёл уже ПОСЛЕ этого await → accessor мёртв. **Превентивно: статические импорты** (нет `await import` — нет соблазна ставить `accessor.get` после await). Скан кандидатов:

```
grep -rln "await import" src/vs/workbench/contrib/vibeide --include=*.ts
# затем в каждом run(accessor): есть ли accessor.get ПОСЛЕ await import?
```
