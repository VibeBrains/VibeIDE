# Спецификация формата `.vibe/providers.json` (VibeIDE)

> **Как этим пользоваться.** Скопируйте весь этот файл целиком своей LLM и попросите:
> *«По этой спецификации собери мне `.vibe/providers.json` для провайдера <НАЗВАНИЕ>: base URL — <…>, ключ в переменной окружения <ИМЯ>, модели — <…>».*
> Модель вернёт готовый JSONC, который кладётся в `.vibe/providers.json` в корне рабочей папки.
> Это самодостаточный документ: всё, что нужно для генерации валидного конфига, — ниже.

Канонический источник схемы — TypeScript-типы в
`src/vs/workbench/contrib/vibeide/common/vibeProvidersFile.ts`. Этот файл описывает тот же формат человеческим языком.

---

## 1. Что это и зачем

`.vibe/providers.json` — пользовательский файл, которым можно **добавить**, **переопределить** или **выключить** LLM-провайдеров и модели **без пересборки IDE**. Объявленный провайдер ведёт себя как встроенный: карточка в «Облачных провайдерах», ввод/проверка ключа, живой каталог моделей, тумблеры моделей.

- Формат — **JSONC**: допускаются `//`-комментарии и висячие запятые.
- Файл располагается по пути `.vibe/providers.json` в корне рабочей папки.
- В редакторе работают автодополнение и диагностика (подключена JSON Schema).

**Перезапуск:** после изменения *структуры* (id, baseURL, список моделей, protocol) — перезапустить VibeIDE. Значение ключа в `.vibe/.env` подхватывается на лету, без рестарта.

---

## 2. Главные принципы

- **Ключи API в файле не хранятся.** Источник ключа задаётся ссылкой:
  - `apiKeyEnv` — имя переменной окружения. Значение берётся из `.vibe/.env` (строка `ИМЯ=значение`, gitignored, в контекст агента не попадает) **или** из переменной окружения ОС.
  - `apiKeyRef` — ключ из защищённого хранилища VibeIDE (вводится в Настройках по id провайдера).
  - Сам `providers.json` можно коммитить в репозиторий.
- **`active: true|false`** — тумблер. Есть на провайдере и на каждой модели. По умолчанию `true`.
- **Совпадение `id` со встроенным провайдером → патч.** Ваши поля накладываются поверх встроенного.
- **`extends: "<id>"` → новый провайдер** на базе существующего (оригинал остаётся).
- **Пишите только отличия** — остальное наследуется. Список моделей мёржится по `id` модели.

---

## 3. Структура файла

```jsonc
{
  "version": 1,
  "providers": [ /* массив провайдеров */ ]
}
```

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `version` | `number` | нет | Версия формата. Сейчас `1`. |
| `providers` | `ProviderEntry[]` | **да** | Массив определений провайдеров. |

Если запись в `providers[]` невалидна (нет `id` и т.п.) — она пропускается с предупреждением, остальные продолжают работать; весь файл из-за одной опечатки не отключается.

---

## 4. Провайдер — `ProviderEntry`

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | `string` | — (**обяз.**) | Уникальный ключ. Совпал со встроенным → **патч** его; новый → **новый** провайдер. |
| `extends` | `string` | — | Наследовать все поля другого провайдера (встроенного или из файла), затем переопределить ниже. Директива резолвинга, в результат не попадает. |
| `name` | `string` | = `id` | Отображаемое имя. |
| `active` | `boolean` | `true` | `false` выключает провайдера и все его модели. |
| `order` | `number` | — | Порядок среди ВАШИХ провайдеров (меньше = выше). Без него — в конец по имени. |
| `tags` | `string[]` | — | Произвольные метки. |
| `note` | `string` | — | Заметка для себя (в UI не показывается как функционал). |
| `protocol` | `"openai" \| "anthropic" \| "gemini"` | — | Протокол API. Для нового провайдера обычно `"openai"`. |
| `baseURL` | `string` | — | Базовый URL API. **Обязателен** для нового провайдера (без него запросы не уходят). |
| `auth` | `"bearer"` \| объект (см. ниже) | `"bearer"` | Способ передачи ключа. |
| `apiKeyEnv` | `string` | — | Имя переменной окружения с ключом. |
| `apiKeyRef` | `string` | — | Взять ключ из защищённых настроек VibeIDE по этому id. |
| `headers` | `Record<string,string>` | — | Статические заголовки запроса. |
| `query` | `Record<string,string>` | — | Статические query-параметры. |
| `timeoutMs` | `number` | — | Таймаут запроса, мс. |
| `docsUrl` | `string` | — | Ссылка на документацию (кнопка в карточке). |
| `apiKeyUrl` | `string` | — | Ссылка на страницу получения ключа (кнопка в карточке). |
| `models` | `ModelsSpec` | — | Список/каталог моделей (см. §6). Необязателен — по умолчанию модели тянутся из каталога. |

### 4.1. Формат `auth`

```jsonc
"auth": "bearer"                              // Authorization: Bearer <key>  (по умолчанию)
"auth": { "type": "bearer" }                  // то же в явной форме
"auth": { "type": "header", "name": "x-api-key" }  // ключ в заголовке x-api-key
"auth": { "type": "query",  "name": "key" }        // ключ в query-параметре ?key=<key>
```

---

## 5. Каталог моделей — `ModelsSpec`

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `fetch` | `boolean \| string` | `true` | `true` — авто-список из `<baseURL>/v1/models`; строка — фетчить этот URL; `false` — только `static`. |
| `static` | `ModelEntry[]` | — | Статически заданные модели. Мёржатся с авто-списком по `id` (static перекрывает возможности). |

> **Важно про URL каталога.** При `fetch: true` дёргается `<baseURL>/v1/models`. Если у провайдера список моделей лежит по другому пути (например `<baseURL>/models` без `/v1`), укажите полный URL строкой: `"fetch": "https://.../models"`.

---

## 6. Модель — `ModelEntry`

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | `string` | — (**обяз.**) | Id модели, как её принимает API. |
| `name` | `string` | = `id` | Отображаемое имя. |
| `active` | `boolean` | `true` | `false` прячет модель из выбора. |
| `default` | `boolean` | `false` | Модель по умолчанию (авто-выбор) у провайдера. |
| `pinned` | `boolean` | `false` | Показывать вверху списка. |
| `contextWindow` | `number` | — | Размер окна контекста (токены). |
| `maxOutputTokens` | `number` | — | Максимум выходных токенов. |
| `toolFormat` | `"openai" \| "anthropic" \| "gemini" \| "none"` | — | Формат вызова инструментов. Для OpenAI-совместимых — `"openai"`. |
| `vision` | `boolean` | — | Поддержка изображений. |
| `systemMessage` | `"system" \| "developer" \| "separated" \| false` | — | Как передавать системное сообщение. Обычно `"system"`. |
| `fim` | `boolean` | — | Поддержка fill-in-the-middle (автокомплит). |
| `reasoning` | `false \| ReasoningSpec` | — | Настройки «размышления» (см. §6.1). |
| `cost` | объект | — | Цена: `{ input, output, cacheRead, cacheWrite }` — за 1M токенов. |
| `temperature` | `number` | — | Дефолтная температура. |
| `topP` / `topK` | `number` | — | Сэмплинг. |
| `extraBody` | `Record<string,unknown>` | — | Доп. поля, доливаемые в тело запроса как есть (квирки провайдера/модели). |
| `note` | `string` | — | Заметка. |

### 6.1. `reasoning` — «думающие» модели

```jsonc
"reasoning": {
  "canTurnOff": true,               // размышление можно выключить
  "field": "reasoning_effort",      // поле в теле запроса, несущее тумблер/усилие
  "effort": ["low", "medium", "high"], // допустимые значения усилия → слайдер в UI
  "thinkTags": ["<think>", "</think>"] // если модель отдаёт мысли инлайном — вырезать эту пару
}
```

- `effort` включает слайдер усилия; VibeIDE шлёт `reasoning_effort` и парсит `reasoning_content`.
- **Провайдеро-специфичный** тумблер размышления (например Moonshot/Kimi `thinking`) кладётся не сюда, а в `extraBody` модели — он уходит в тело запроса без изменений.
- `"reasoning": false` — модель без размышления.

---

## 7. Рецепты (совпадение по `id` со встроенным)

Встроенные id — для патча по `id`, для `extends` и для `apiKeyRef`:

```
openCodeZen  openCodeGo  minimax  openRouter  lmRoute  liteLLM  gemini  groq
pollinations anthropic   openAI   deepseek    mistral  xAI      googleVertex
microsoftAzure awsBedrock ollama  vLLM  lmStudio  openAICompatible
```

(Тот же список с описаниями — команда «VibeIDE: Показать распознанные провайдеры».)

| Задача | Как |
|---|---|
| свой провайдер с нуля | новый `id` + `baseURL` + `auth` + `apiKeyEnv`/`apiKeyRef` |
| выключить встроенного | `{ "id": "<builtin>", "active": false }` |
| оставить у встроенного N моделей | тот же `id` + `models.fetch: false` + нужный `static` |
| выключить одну модель | тот же `id` + `models.static: [{ "id": "…", "active": false }]` |
| клон встроенного как отдельный вариант | новый `id` + `extends: "<builtin>"` |

---

## 8. Примеры

### 8.1. OpenAI-совместимый провайдер «с нуля»

```jsonc
{
  "version": 1,
  "providers": [
    {
      "id": "my-proxy",
      "name": "Мой прокси",
      "protocol": "openai",
      "baseURL": "https://llm.mycorp.local/v1",
      "auth": { "type": "header", "name": "x-api-key" },
      "apiKeyEnv": "MYCORP_LLM_KEY",
      "order": 10,
      "models": { "fetch": true }   // авто-список из <baseURL>/v1/models
    }
  ]
}
```

### 8.2. Z.AI (GLM) — OpenAI-совместимый, каталог по нестандартному пути

```jsonc
{
  "version": 1,
  "providers": [
    {
      "id": "zai",
      "name": "Z.AI (GLM)",
      "protocol": "openai",
      "baseURL": "https://api.z.ai/api/paas/v4",
      "auth": "bearer",
      "apiKeyEnv": "ZAI_API_KEY",
      "docsUrl": "https://docs.z.ai/",
      "apiKeyUrl": "https://z.ai/manage-apikey/apikey-list",
      "order": 50,
      "models": {
        // Каталог z.ai — на <baseURL>/models, не /v1/models → указываем полный URL.
        "fetch": "https://api.z.ai/api/paas/v4/models",
        "static": [
          {
            "id": "glm-4.6",
            "name": "GLM-4.6",
            "default": true,
            "pinned": true,
            "contextWindow": 200000,
            "maxOutputTokens": 131072,
            "toolFormat": "openai",
            "systemMessage": "system",
            "reasoning": { "canTurnOff": true, "field": "thinking" }
          },
          {
            "id": "glm-4.5v",
            "name": "GLM-4.5V (vision)",
            "contextWindow": 65536,
            "toolFormat": "openai",
            "vision": true,
            "systemMessage": "system"
          }
        ]
      }
    }
  ]
}
```

### 8.3. «Думающая» модель: `reasoning` + `extraBody` (Kimi/Moonshot)

```jsonc
{
  "id": "kimi",
  "name": "Kimi (Moonshot)",
  "baseURL": "https://api.moonshot.ai/v1",
  "apiKeyEnv": "MOONSHOT_API_KEY",
  "models": {
    "fetch": false,
    "static": [
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "contextWindow": 262144,
        "maxOutputTokens": 32768,
        "toolFormat": "openai",
        "reasoning": { "canTurnOff": true, "effort": ["low", "medium", "high"] },
        "extraBody": { "thinking": { "type": "enabled" } }
      }
    ]
  }
}
```

---

## 9. Чек-лист валидного конфига

- [ ] Корень — объект с массивом `providers`.
- [ ] У каждого провайдера есть уникальный `id`.
- [ ] У нового провайдера задан `baseURL`.
- [ ] Ключ задан ссылкой (`apiKeyEnv` или `apiKeyRef`), а не значением в файле.
- [ ] Если каталог моделей не на `<baseURL>/v1/models` — `fetch` указан полным URL строкой.
- [ ] У каждой модели в `static` есть `id`.
- [ ] Для OpenAI-совместимого API у моделей `toolFormat: "openai"`.
- [ ] Провайдеро-специфичные тумблеры — в `extraBody`, а не в стандартных полях.

См. также готовый пример: `.vibe-defaults/providers.example.jsonc` (засевается в `.vibe/`).
