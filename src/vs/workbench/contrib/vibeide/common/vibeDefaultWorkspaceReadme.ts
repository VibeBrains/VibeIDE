/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Workspace `.vibe/` JSON and template version (keep in sync with constraints.json and related files). */
export const VIBE_WORKSPACE_FORMAT_VERSION = '1.0.0';

/**
 * Default markdown for `.vibe/README.md` (human-oriented map of the workspace agent folder).
 */
export function getDefaultVibeReadmeMarkdown(): string {
	const v = VIBE_WORKSPACE_FORMAT_VERSION;
	return `# Папка .vibe — конфигурация VibeIDE для этого воркспейса

Версия формата: **${v}** (поле \`vibeVersion\` в JSON-файлах). При рассинхроне см. \`vibe doctor --repair\`.

## С чего начать

1. **Правила для ИИ** — **.vibe/rules.md** и корневой **AGENTS.md**. Они подмешиваются в блок GUIDELINES после глобальных «AI Instructions» из настроек. Удобно править через **VibeIDE Settings → Workspace**. Не дублируйте одно и то же в двух файлах без нужды.
2. **Запретить агенту трогать важные файлы** — используйте **constraints.json** (жёсткая блокировка на уровне IDE).
3. **Повторяющиеся запросы в чате** — заведите шаблон в **prompts/** и вызывайте **/my:имя** или опишите многошаговый сценарий в **workflows/** и вызывайте **/workflow:имя**. **Agent Skills** (как в Cursor): каталог **.vibe/skills/** с файлами **SKILL.md** — вызывайте **/skill:имя**; список навыков также попадает в блок **GUIDELINES** для модели.

Если **rules.md** только что создали, а чат уже был открыт, при пустых GUIDELINES сделайте **Reload Window** один раз.

---

## Если вы хотите…

| Задача | Куда смотреть |
|--------|----------------|
| Задать стиль кода, язык ответов, обязательные тесты | **.vibe/rules.md**, корневой **AGENTS.md** |
| Запретить **запись** в пути (secrets, лицензии, generated) | **constraints.json** (\`deny_write\`) |
| Запретить **чтение** части дерева агентом | **constraints.json** (\`deny_read\`) + **ignore** |
| Уменьшить шум в контексте (node_modules, огромные логи) | **ignore** |
| Разрешить только определённые модели | **allowed-models.json** |
| Один и тот же текст запроса с параметрами | **prompts/*.md** → в чате **/my:шаблон** (плейсхолдеры вида **$VAR_NAME** латиницей) |
| Чеклист из нескольких шагов с описанием и порядком | **workflows/*.json** → **/workflow:имя** (в сообщение подставляется план шагов; выполнение делает агент по вашему запросу) |
| Зафиксировать цели недели/спринта | **goals.md** (агент может обновлять по просьбе; контент в чат не подставляется автоматически — процитируйте или попросите прочитать файл; запрет записи — \`deny_write\` на \`.vibe/goals.md\` в **constraints.json**) |
| Версионируемые планы задач для команды | **plans/** (*.md) |
| Откат изменений | **snapshots/** (сервис снапшотов IDE) |
| Узкий «рецепт» с чеклистом для ИИ (Cursor-style skills) | **skills/** (**SKILL.md** в подпапках) → **/skill:имя** |

---

## Сценарии по ролям

**Разработчик:** правила в **rules.md**, секреты и билд в **ignore**, опасные пути в **constraints.json**, частый код-ревью → **prompts/code-review.md** + **/my:code-review**.

**Тимлид / безопасность:** минимальный whitelist моделей в **allowed-models.json**, **constraints.json** на прод-конфиги и ключи, аудит через снапшоты.

**Новый участник:** прочитать этот README, **rules.md**, при наличии — **AGENTS.md** в корне репозитория; заглянуть в **plans/** на актуальные задачи.

---

## Файлы в корне

**В корне репозитория (не внутри каталога .vibe):** может лежать **AGENTS.md** — инструкции для агентов; текст попадает в тот же блок GUIDELINES после **.vibe/rules.md**. В чате можно набрать **@agent**, чтобы прикрепить **AGENTS.md** и **.vibe/rules.md** (если есть).

| Файл | Назначение |
|------|------------|
| **README.md** | Эта карта (для людей). |
| **constraints.json** | Жёсткие ограничения IDE до вызова инструментов агента. |
| **allowed-models.json** | Whitelist моделей; пустой **models** — разрешены все. |
| **pinned.json** | Закреплённые файлы/символы (задел под контекст; дублируйте важное через @ в чате). |
| **rules.md** | Проектные правила для ИИ в **.vibe/** → блок GUIDELINES. |
| **ignore** | Исключения из контекста/индексации для агента. |
| **goals.md** | Цели периода; по умолчанию агент может править по запросу; можно запретить через **constraints.json**. |

## Подпапки

| Папка | Назначение |
|-------|------------|
| **prompts/** | Шаблоны текста: **/my:имя_файла**; переменные **$UPPER_SNAKE**. |
| **workflows/** | JSON/YAML сценарии: **/workflow:имя**. |
| **snapshots/** | Снимки для отката. |
| **plans/** | Планы в markdown для команды. |
| **skills/** | **Agent Skills**: **SKILL.md** (YAML frontmatter: name, description) → **/skill:name**; discovery в **GUIDELINES**. |
| **profiles/** | Профили VibeIDE (если включены). |

## Другие файлы (появляются при использовании фич)

- **permissions.json** — точечные allow/deny записи.
- **context.md** — Project Brain (автообновление памяти между сессиями).
- **persona.json** — стиль ответа агента.

## Полезно помнить

- Изменения в **.vibe/** подхватываются при следующих вызовах инструментов (hot-reload), но **модель правил** для GUIDELINES берётся из открытого документа — после создания файлов при необходимости **Reload Window**.
- **constraints** и **permissions** — про безопасность; **.vibe/rules.md** / **AGENTS.md** — про стиль и договорённости.

`;
}
