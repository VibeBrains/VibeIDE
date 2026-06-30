<p align="center">
  <img src="references/logo-final.png" alt="VibeIDE" width="180" />
</p>

<h1 align="center">VibeIDE</h1>

<p align="center">
  <strong>Открытый AI-редактор кода. Без подписки. Без телеметрии. Ваши ключи, ваши модели.</strong>
</p>

<p align="center">
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/VibeBrains/VibeIDE/releases"><img src="https://img.shields.io/badge/версия-1.5.0-green.svg" alt="Версия" /></a>
  <a href="https://github.com/VibeBrains/VibeIDE/issues"><img src="https://img.shields.io/github/issues/VibeBrains/VibeIDE.svg" alt="Issues" /></a>
  <a href="https://open-vsx.org"><img src="https://img.shields.io/badge/extensions-Open%20VSX-purple.svg" alt="Open VSX" /></a>
</p>

<p align="center">
  <a href="https://github.com/VibeBrains/VibeIDE/releases/latest/download/VibeIDESetup.exe"><img src="https://img.shields.io/badge/Скачать%20для%20Windows-VibeIDESetup.exe-2ea44f?style=for-the-badge&logo=windows" alt="Скачать VibeIDE для Windows" /></a>
</p>

---

## Что такое VibeIDE?

VibeIDE — форк [VS Code open source (Code-OSS)](https://github.com/microsoft/vscode) с глубоко встроенным AI: не как расширение поверх редактора, а как часть самого редактора. Полностью открытый исходный код (MIT), работает с любым LLM-провайдером, не отправляет никакой телеметрии.

> **«Ты видишь всё — и управляешь всем»**

---

## Почему VibeIDE, а не Cursor, Windsurf или Copilot?

| | VibeIDE | Cursor | Windsurf | GitHub Copilot |
|---|---|---|---|---|
| **Открытый исходный код** | ✅ MIT | ❌ Закрытый | ❌ Закрытый | ❌ Закрытый |
| **Подписка** | ❌ Не нужна | 💸 $20/мес | 💸 $15/мес | 💸 $10/мес |
| **Свой API-ключ** | ✅ Любой провайдер | ⚠️ Ограничено | ⚠️ Ограничено | ❌ |
| **Свои провайдеры без пересборки** | ✅ `.vibe/providers.json` | ⚠️ Только base URL | ❌ | ❌ |
| **Локальные модели (Ollama)** | ✅ Встроено | ⚠️ Через расширение | ❌ | ❌ |
| **Телеметрия вендору** | ❌ Нет | ✅ Есть | ✅ Есть | ✅ Есть |
| **Ключи в системном хранилище** | ✅ safeStorage | ✅ | ❓ | ✅ |
| **Маркетплейс расширений** | Open VSX (бесплатно) | VS Marketplace | VS Marketplace | VS Marketplace |
| **Мультиагентность** | ✅ Встроена | ⚠️ Базовая | ❌ | ❌ |
| **Правила AI на уровне проекта** | ✅ Skills system | ✅ .cursorrules | ❌ | ❌ |
| **Поддержка MCP** | ✅ Официальный SDK | ✅ | ❌ | ⚠️ Preview |

---

## Возможности

Здесь — только ключевое. Полный каталог по темам — в **[docs/functional.md](docs/functional.md)**.

- **Свои LLM-провайдеры без пересборки** — `.vibe/providers.json`: добавить, переопределить или выключить провайдера и модели, живой каталог моделей из API; работают как встроенные.
- **Любой провайдер на свой ключ** + локальные модели (Ollama, LM Studio) встроены.
- **Агент с автопилотом** — доводит задачу до конца сам; мультиагентная оркестрация с блокировками; персистентные планы переживают перезапуск IDE.
- **Vibe Server — превью без деплоя** — локальный предпросмотр прямо в IDE: статика, dev-сервер фреймворка (Vite/Next/…) или Docker-окружение, живая перезагрузка, QR для телефона, ошибки превью одной кнопкой в чат агенту.
- **Vibe Deploy — выкат в облако через агента** (Timeweb Cloud первым, провайдеро-агностично) с подтверждением перед каждым внешним действием.
- **Skills system** — переиспользуемые AI-правила на уровне проекта.
- **Контекст на ходу** — добавляете сообщение, пока агент работает: видно очередью над вводом, подхватывается на следующем шаге без остановки.
- **Guard'ы от галлюцинаций и счёта** — лимит токенов сессии + индикатор заполнения контекста с предупреждениями до того, как модель начнёт деградировать.
- **Надёжные правки файлов** даже на слабых моделях — простой формат `old/new` + терпимый поиск заменяемого текста.
- **Уведомления, когда отошёл** — звук, мигание иконки в панели задач и системный тоаст, когда агент закончил или ждёт ответа; клик возвращает к IDE.
- **Диагностика провайдеров + «починить связь»** — послойная проверка (конфиг → сеть → авторизация → модели) и сброс клиентов без перезапуска.
- **MCP** — официальный SDK + менеджер OAuth-токенов.
- **Команды проекта** — `.vibe/commands.json` с авто-хоткеями, едут в репозитории вместе с проектом.
- **Приватность по умолчанию** — нет телеметрии Microsoft, ключи в системном хранилище (`safeStorage`), детекция секретов перед отправкой в LLM.
- **Полная совместимость с VS Code** + Open VSX без аккаунта Microsoft.

---

## Быстрый старт

### Требования

- **Node.js 22.22.1** (версия зафиксирована в `.nvmrc`) — именно этот мажор; на другом (24/20) сборка падает, часто **молча**.
- Python 3.x (нужен node-gyp)
- Git
- **Windows:** Visual Studio Build Tools 2022 — компонент **«Desktop development with C++»** **И** **Spectre-mitigated библиотеки**. Подробности и команды — в [«C/C++ тулчейн для Windows»](#cc-тулчейн-для-windows-нативные-модули--обязательно) ниже.

#### Node через fnm (рекомендуется)

[**fnm**](https://github.com/Schniz/fnm) (Fast Node Manager) — это **альтернатива классической установке Node.js с сайта**. Это лёгкий **менеджер версий Node**: вместо одного глобального Node в системе он хранит несколько версий рядом и **переключает активную версию под конкретный проект** автоматически по файлу `.nvmrc` (в VibeIDE там зафиксирована `22.22.1`). Удобно, когда разные проекты требуют разных версий Node.

Установка и активация нужной версии под проект (один раз):

```powershell
fnm install 22.22.1
fnm default 22.22.1
node -v        # должно показать v22.22.1
npm -v         # должно показать версию npm
```

> **Если в новом терминале `node`/`npm` «не является командой»** — у тебя не подключена интеграция fnm с шеллом (fnm хранит версии отдельно и подставляет их через shell-хук). Активируй её в профиле:
> - **PowerShell:** `fnm env --use-on-cd | Out-String | Invoke-Expression` (добавь в `$PROFILE`)
> - **bash/zsh:** `eval "$(fnm env --use-on-cd)"` (добавь в `~/.bashrc` / `~/.zshrc`)
>
> На Windows запуск dev-IDE через `.\run-dev.bat --compile` также сам резолвит Node из fnm, если он установлен.

#### C/C++ тулчейн для Windows (нативные модули) — обязательно

`npm install` компилирует нативные модули (`@vscode/windows-registry`, `@vscode/spdlog`, `native-keymap`, `node-pty` и др.) через **node-gyp**, поэтому нужен компилятор MSVC. Без него `preinstall` падает с `*** Invalid C/C++ Compiler Toolchain`.

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-package-agreements --accept-source-agreements `
  --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

> ⚠️ **Spectre-mitigated библиотеки — отдельный компонент, и без него сборка падает.** На `@vscode/windows-registry` будет `MSB8040: для этого проекта требуются библиотеки с устранением рисков Spectre`. `--includeRecommended` их **не** ставит — добавь явно через `setup.exe modify` (winget доустановить компонент в существующий VS **не умеет** — считает это «нет обновлений»):
>
> ```powershell
> & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\setup.exe" modify `
>   --installPath "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools" `
>   --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --quiet --norestart
> ```
>
> **Не передавай `--wait` напрямую в `setup.exe`** — он его не понимает и сразу выходит с `exit 87`. Ожидание делает `Start-Process … -Wait`.

После установки тулчейна **открой новый терминал** (PATH обновится) и убедись, что Node = 22.22.1, прежде чем `npm install`.

### Сборка из исходников

```bash
git clone https://github.com/VibeBrains/VibeIDE.git
cd VibeIDE
npm install
npm run compile
./scripts/code.sh        # Linux / macOS
.\run-dev.bat            # Windows (верный запуск dev-IDE; --compile пересоберёт перед стартом)
```

Для быстрой разработки:

```bash
./scripts/code.sh --inspect  # с отладчиком
```

Одно нажатие через Docker или GitHub Codespaces — см. [Dev Container](.devcontainer/README.md).

### Настройка провайдера

При первом запуске VibeIDE проведёт вас через подключение модели. Можно использовать облачный API-ключ (OpenAI, Anthropic и др.) или подключить локальный [Ollama](https://ollama.ai) — аккаунт не нужен.

---

## Структура проекта

```
src/vs/workbench/contrib/vibeide/   ← весь AI-функционал
  browser/                          ← UI: сайдбар, панель настроек, статусбары
  common/                           ← сервисы: роутер моделей, MCP, память, RAG
extensions/                         ← встроенные расширения VS Code
resources/                          ← платформенные ресурсы (иконки, desktop-файлы)
product.json                        ← брендинг и настройки маркетплейса
```

---

## Неочевидные поведения

Вещи, которые работают «из коробки», но нигде явно не описаны.

### Папка `data/` — портативный режим

Создайте папку `data/` рядом с бинарником VibeIDE — IDE автоматически перейдёт в **portable mode**: все данные будут храниться внутри неё, а не в системных директориях (`%APPDATA%`, `~/.config` и т.п.). Это подтверждено кодом в `src/bootstrap-node.ts`.

```
VibeIDE/
  data/
    user-data/       ← настройки, профили, history
    extensions/      ← установленные расширения
    shared-data/     ← shared state между воркспейсами
    agent-plugins/   ← MCP/agent плагины
    argv.json        ← аргументы запуска
    policy.json      ← политики (если применяются)
    tmp/             ← если создать эту подпапку, она становится системной TMP/TMPDIR
```

Перенести IDE на другой компьютер = скопировать один каталог. Путь к `data/` можно переопределить переменной окружения `VSCODE_PORTABLE`.

### Папка `.vibe/` — конфигурация воркспейса для AI

При первом открытии любого воркспейса VibeIDE **автоматически создаёт** папку `.vibe/` с шаблонами конфигурации. Файлы внутри читаются IDE на лету (hot-reload) — изменения подхватываются без перезапуска.

| Файл / Папка | Что делает |
|---|---|
| `rules.md` | Правила для агента, подмешиваются в системный контекст перед каждым запросом |
| `constraints.json` | **Жёсткие** блокировки записи/чтения файлов на уровне IDE — агент не может их обойти |
| `permissions.json` | Точечные allow/deny на конкретные пути (тоньше, чем `constraints.json`) |
| `allowed-models.json` | Whitelist моделей; пустой массив = разрешены все |
| `ignore` | Файлы/папки, которые агент не читает и не индексирует (аналог `.gitignore`) |
| `context.md` | **Project Brain** — IDE автоматически записывает сюда накопленный контекст после каждой сессии |
| `pinned.json` | Файлы и символы, которые всегда включаются в контекст агента |
| `goals.md` | Цели периода; агент может обновлять по запросу |
| `agent-locks.json` | Территориальные блокировки агентов (кто какой файл сейчас редактирует) |
| `plans/` | Персистентные планы задач — переживают перезапуск IDE |
| `prompts/` | Шаблоны запросов, вызываются в чате командой `/my:имя` |
| `workflows/` | JSON-сценарии из нескольких шагов, вызываются `/workflow:имя` |
| `skills/` | Agent Skills: `SKILL.md` в подпапках → вызов `/skill:имя`; список попадает в GUIDELINES автоматически |
| `snapshots/` | Снимки файлов для отката после агентных правок |
| `commands.json` | **Команды проекта** — shell-шорткаты для меню «Команды» в шапке IDE; первый запуск требует approve и фиксируется в `commands.trust.json` |
| `commands.trust.json` | Approved-hash'и команд (auto-managed, обычно в `.gitignore`) |
| `providers.json` | **Свои LLM-провайдеры и модели** — добавить/переопределить/выключить без пересборки (см. ниже) |

#### Свои провайдеры — `.vibe/providers.json`

Формат **JSONC** (можно `//`-комментарии), с подсветкой и автодополнением полей прямо в редакторе. Готовый пример — `.vibe/providers.example.jsonc` (создаётся автоматически). Ключи API **в файле не хранятся** — указывайте `apiKeyEnv` (переменная окружения) или `apiKeyRef` (защищённые настройки), файл можно коммитить.

Главное: `active: true|false` — тумблер (на провайдере и на каждой модели). Совпадение `id` со встроенным провайдером **накладывает** ваши поля поверх него; новый `id` создаёт нового; `extends: "<id>"` — клон существующего как отдельный вариант. Пишите только отличия — остальное наследуется.

```jsonc
{
  "version": 1,
  "providers": [
    // свой OpenAI-совместимый провайдер с нуля
    { "id": "my-proxy", "name": "Мой прокси", "baseURL": "https://llm.local/v1",
      "auth": { "type": "header", "name": "x-api-key" }, "apiKeyEnv": "MY_KEY",
      "models": { "fetch": true } },

    // выключить встроенный (убрать из списка)
    { "id": "googleVertex", "active": false },

    // прорядить модели встроенного OpenRouter
    { "id": "openRouter", "models": { "fetch": false, "static": [
      { "id": "anthropic/claude-sonnet-4.5", "default": true },
      { "id": "deepseek/deepseek-v3.2" }
    ] } },

    // клон встроенного как отдельный вариант (оригинал остаётся)
    { "id": "openRouter-fav", "extends": "openRouter", "name": "OpenRouter — избранное",
      "apiKeyRef": "openRouter",
      "models": { "fetch": false, "static": [ { "id": "x-ai/grok-4", "default": true } ] } }
  ]
}
```

| Хочу | Как |
|---|---|
| свой провайдер с нуля | новый `id` + `baseURL` + `auth` + `apiKeyEnv`/`apiKeyRef` |
| выключить/подправить встроенный | совпасть по `id`, написать только изменения |
| второй вариант на базе существующего | `extends: "<id>"` + новый `id` |
| выключить модель | в `models.static` — `{ "id": "...", "active": false }` |

### Папка `.vibe/` — служебные данные IDE в воркспейсе

Создаётся автоматически (не трогать руками, добавьте в `.gitignore`):

- `.vibe/audit.jsonl` — аудит-лог всех действий агента: промпты, диффы, применения, откаты, stash-операции. Включается через `vibeide.audit` в настройках. Поддерживает ротацию по размеру (по умолчанию 10 МБ) и удаление (GDPR erasure).

RAG-индекс кодовой базы хранится **не** в `.vibe/`, а в системном `workspaceStorage` IDE. Если в проекте есть старый `.vibeide/index.json` — он будет мигрирован автоматически.

### Детектор петель

Агент автоматически паузится, если совершает **3 и более одинаковых действия подряд** (одинаковые = совпадают `type` + `target` операции). Также ловит паттерн A→B→A. Шаги auto-repair и task decomposition из детекции исключены.

### Dead man's switch

При долгой агентной задаче таймер отсчитывает **5 минут** с момента последнего явного Approve. Если пользователь не подтвердил прогресс — агент автоматически паузится. Настраивается через `vibeide.deadMansSwitchMinutes`; значение `0` отключает механизм. Минимум — 1 минута. Движение мыши и 429-ретраи таймер **не** сбрасывают.

### Git auto-stash

Перед каждой агентной правкой VibeIDE автоматически стешит незакоммиченные изменения (`git.stashIncludeUntracked`) и восстанавливает их после применения. Если apply упал — stash также автоматически восстанавливается, изменения не теряются.

### Переменные окружения

| Переменная | Эффект |
|---|---|
| `VSCODE_PORTABLE=/path/to/dir` | Задаёт кастомный путь к данным вместо `data/` рядом с бинарником |
| `VSCODE_APPDATA=/path` | Базовая директория для данных (вместо `%APPDATA%` / `~/.config`) |
| `VSCODE_DEV=1` | Изолирует данные разработчика в отдельную директорию (`vibeide-dev`) — не смешивает со стабильной сборкой |

### Системные пути по умолчанию (не portable)

Если `data/` не создана и переменные не заданы, данные лежат здесь:

| ОС | Путь |
|---|---|
| Windows | `%APPDATA%\VibeIDE\` |
| macOS | `~/Library/Application Support/VibeIDE/` |
| Linux | `~/.config/vibeide/` (или `$XDG_CONFIG_HOME/vibeide/`) |

Расширения, перенесённые из VS Code при первом запуске, копируются в `~/.vibeide-editor/extensions/`.

---

## Поведенческие квирки моделей

Некоторые LLM-модели (особенно через aggregator'ы вроде opencode.ai/zen) требуют специфической настройки, чтобы стримить стабильно: одни шлют пустой ответ при стандартной `temperature`, другие падают без `reasoning_content` обратно, третьи галлюцинируют имена параметров в native function-calling и работают только через XML-формат. Все aggregator-проксированные клиенты (cursor, continue, opencode CLI) поддерживают похожие таблицы — у нас это **внешний каталог**.

**Где живут квирки:** [`resources/model-quirks.json`](resources/model-quirks.json) — JSON-каталог в этом репо.

**Источники и приоритет (по образцу `models.dev.json`):**
1. **exe-adjacent** — файл `model-quirks.json`, положенный **рядом с исполняемым файлом VibeIDE**. **Максимальный приоритет** (явный override, действует всегда — даже офлайн). Если он **старее** bundled/CDN (по полю `date`) — **один раз при старте VibeIDE** показывается тост: файл всё ещё действует, но может не содержать свежих фиксов; предлагается обновить/удалить или обновить с CDN.
2. **CDN** — фоновый fetch с `main`-ветки `https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/resources/model-quirks.json`, ETag-кэш в `${userData}/model-quirks-cache.json`. Refresh каждые 24ч (`vibeide.modelQuirks.refreshIntervalHours`, 0 — выкл).
3. **bundled** — копия, вшитая в сборку (TS-константа, всегда доступна).

- При отсутствии exe-adjacent активным становится **более свежий по `date`** из {CDN-кэш, bundled}.
- CDN недоступен → работаем на кэше/bundled/exe — **работа не встаёт**.
- Merge в `main` → квирк у всех пользователей **без релиза VibeIDE** на следующем refresh-цикле.
- Top-level поле **`date`** (ISO `YYYY-MM-DD`) определяет «свежесть» при сравнении источников.

**Как добавить квирк для новой модели:** PR в этот репо, правка одного файла `resources/model-quirks.json`. Поля правила:

| Поле | Тип | Что делает |
|---|---|---|
| `match` | string | Substring модели (case-insensitive). Правила **сливаются по полям** с приоритетом most-specific (`provider`-scoped > длиннее `match`); каждое поле берётся из самого специфичного правила, которое его задаёт — затенения нет. |
| `temperature` | 0..2 | Override default temperature провайдера. |
| `topP` | 0..1 | Nucleus sampling. |
| `topK` | int ≥1 | Только для провайдеров, которые его уважают. |
| `forceEmptyReasoning` | boolean | Для DeepSeek-семейства: вшивать пустой reasoning placeholder на каждый assistant message (иначе HTTP 400). |
| `mirrorReasoningContent` | boolean | Дублировать reasoning в `providerOptions.openaiCompatible.reasoning_content` (interleaved-семейства). |
| `forceToolCallFormat` | `"native"` / `"xml"` / `"auto"` | Override формата tool-call'ов. `"xml"` для моделей с broken native FC (qwen, например). |
| `note` | string | Свободный комментарий для контрибьюторов, не консумируется рантаймом. |

**User-уровневый override:** настройка `vibeide.modelQuirks` (JSON-объект `{ <modelId>: { …поля… } }`). Перекрывает каталог per-field. Полезно для приватных моделей или быстрого тюнинга без PR.

**Принудительный refresh:** команда **«VibeIDE: Обновить каталог квирков моделей (model-quirks) с CDN»** через палитру — резерв, если фоновый refresh не сработал или нужен свежий каталог сейчас.

Подробнее: [`docs/knowledge/architecture/model-quirks.md`](docs/knowledge/architecture/model-quirks.md).

---

## Участие в разработке

Pull request'ы приветствуются. Перед началом значимой работы — откройте issue для обсуждения подхода.

Инструкции по сборке, гайдлайны и процесс PR: [CONTRIBUTING.md](CONTRIBUTING.md) и [HOW_TO_CONTRIBUTE.md](HOW_TO_CONTRIBUTE.md).

Что изменено относительно upstream VS Code: [FORK_CHANGES.md](FORK_CHANGES.md).

---

## Связь, сообщество и поддержка

**Discord** — самый быстрый способ задать вопрос по установке и использованию, обсудить идеи и поймать «плавающие» баги вместе с другими пользователями, пока вы ещё не уверены, что это стоит оформлять в тикет.

<p>
  <a href="https://discord.gg/kB8Gx56S" title="Приглашение в Discord VibeIDE">
    <img src="https://img.shields.io/badge/Discord-войти_на_сервер-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord — приглашение на сервер" />
  </a>
</p>

**GitHub Issues** — для **воспроизводимых** сбоев, регрессий и предложений по продукту лучше завести [issue в репозитории](https://github.com/VibeBrains/VibeIDE/issues/new): так задача не потеряется, к ней можно приложить логи и версию сборки, а исправление будет привязано к релизам.

**Почта** — [mail@vibeide.ru](mailto:mail@vibeide.ru): деловые вопросы, партнёрство, обратная связь вне публичных площадок.

### Поддержать проект

Если VibeIDE оказался полезным — буду рад благодарности 🙏

<a href="https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/media/QR-Code.jpg" target="_blank" rel="noopener noreferrer">
  <img src="https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/media/QR-Code.jpg" width="120" alt="QR-код для поддержки проекта" />
</a>

---

## Лицензия

MIT — см. [LICENSE.txt](LICENSE.txt).

VibeIDE построен на базе [VS Code open source (Code-OSS)](https://github.com/microsoft/vscode), который также распространяется под лицензией MIT. Сторонние компоненты: [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
