# OpenAPI / GraphQL / AsyncAPI context (MVP)

Normative stub for roadmap § **D** — прикрепление машиночитаемой спеки к чату без ручного `@file` на каждый фрагмент.

## Продукт (текущее состояние)

- **Команда палитры:** `VibeIDE: Attach OpenAPI / GraphQL spec to chat` (`vibeide.context.attachApiSpec`).
- Диалог выбора файла с фильтрами: `.yaml`, `.yml`, `.json`, `.graphql`, `.gql`.
- Выбранный файл добавляется в **staging selections** текущего треда (тот же контур, что и `@file`), боковая панель открывается автоматически.
- Файл должен лежать **внутри workspace** (политика как у остальных вложений).

## Backlog (не MVP)

- Явный mention-токен `@spec` в строке ввода и автодополнение путей.
- Diff на изменение закреплённой спеки между ходами агента.
- Версионирование и breaking-change подсказка (см. roadmap § G / spec-driven контекст).
