# [инцидент] YYYY-MM-DD — [одна строка симптома] (template)

← [Knowledge Index](README.md)

> **Удалить этот шаблонный блок.** Копировать в `docs/knowledge/<подходящий-topic>/<short-slug>.md`. Подходящие topic'и для инцидентов: `runtime-quirks/`, `chat-ux/`, `architecture/`, `build/`.

---

## Подтверждённое

| Факт | Источник |
|---|---|
| Когда (UTC + локально) | log timestamp / Git Discussions / chat screenshot |
| Модель / провайдер / версия VibeIDE | `product.json` + provider config |
| Точный error / stack / behaviour | log line / DevTools console / video |
| Воспроизводится? | reproducibility scope (single-machine / cross-machine / specific-input) |

## Исключённое

- Что **не** причина — для каждого исключённого варианта одно предложение почему. Цель: не возвращаться к этим гипотезам в следующий раз.

## Под подозрением

- Кандидаты с обоснованием. Прioritise по наибольшему ROI диагностики (быстрее проверить = выше в списке).

## Root cause

- Когда найден — одно предложение.
- Если ещё нет — `<UNRESOLVED>` явно, не симулировать ответ.

## Fix

- Commit hash + одна строка описания фикса.
- Регрессионный тест: `path/to/test.ts#L42` или «не написан, backlog».

## Lessons

- Что было удивительно / неочевидно.
- Класс баг'а — recurring или one-off?
- Что добавить в checklist / lint / CI / safety net чтобы не повторилось.

## Связано

- Если incident — продолжение другого: `[[other-incident]]` или ссылка.
- Если открыта roadmap-задача для follow-up — указать ID.
