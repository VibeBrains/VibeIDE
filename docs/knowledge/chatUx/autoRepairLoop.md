# Auto-repair loop и Dead Man's Switch

← [Knowledge Index](../README.md)

---

## [архитектура] Auto-repair loop шаги исключены из loop detector

**Контекст:** риск #80 из idea.md.

**Суть:** `run tests → fix → run tests` внутри repair loop — легитимный паттерн, не цикл. Loop detector не должен паузировать repair loop. В Auto режиме repair-итерации для 🔴-confidence файлов записываются как `agent:repair-override` в аудит-лог, но НЕ блокируют выполнение.

**Применение:** при реализации loop detector и auto-repair loop в Фазе 2.

---

## [архитектура] Dead man's switch — три явных исключения из таймера

**Контекст:** риски #52, #60 из idea.md.

**Суть:** DMS таймер НЕ сбрасывается при: (1) движении мыши, (2) rate limit 429 + retry backoff, (3) режиме ожидания pre-flight plan approval. Сбрасывается только явным Approve action.

**Применение:** при реализации DMS в Фазе 1.
