<p align="center">
  <img src="references/logo-final.png" alt="VibeIDE" width="180" />
</p>

<h1 align="center">VibeIDE</h1>

<p align="center">
  <strong>Открытый AI-редактор кода. Без подписки. Без телеметрии. Ваши ключи, ваши модели.</strong>
</p>

<p align="center">
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/VibeIDETeam/VibeIDE/releases"><img src="https://img.shields.io/badge/версия-0.1.0-green.svg" alt="Версия" /></a>
  <a href="https://github.com/VibeIDETeam/VibeIDE/issues"><img src="https://img.shields.io/github/issues/VibeIDETeam/VibeIDE.svg" alt="Issues" /></a>
  <a href="https://open-vsx.org"><img src="https://img.shields.io/badge/extensions-Open%20VSX-purple.svg" alt="Open VSX" /></a>
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
| **Локальные модели (Ollama)** | ✅ Встроено | ⚠️ Через расширение | ❌ | ❌ |
| **Телеметрия вендору** | ❌ Нет | ✅ Есть | ✅ Есть | ✅ Есть |
| **Ключи в системном хранилище** | ✅ safeStorage | ✅ | ❓ | ✅ |
| **Маркетплейс расширений** | Open VSX (бесплатно) | VS Marketplace | VS Marketplace | VS Marketplace |
| **Мультиагентность** | ✅ Встроена | ⚠️ Базовая | ❌ | ❌ |
| **Правила AI на уровне проекта** | ✅ Skills system | ✅ .cursorrules | ❌ | ❌ |
| **Поддержка MCP** | ✅ Официальный SDK | ✅ | ❌ | ⚠️ Preview |

---

## Возможности

**AI-ядро**
- Роутер LLM-провайдеров — OpenAI, Anthropic, Gemini, Mistral, Ollama и другие. Разные модели для разных задач.
- Встроенный автокомплит FIM (Fill-in-the-Middle) — без дополнительных расширений.
- Инлайн-редактирование кода, детекция ошибок и код-ревью силами выбранной модели.
- Индексация кодовой базы и семантический поиск (RAG) по всему репозиторию.
- Image QA — анализ скриншотов и диаграмм как часть контекста.

**Агенты**
- Мультиагентная оркестрация с территориальными блокировками — агенты не мешают друг другу.
- Персистентные планы — планы агента переживают перезапуск IDE и продолжаются с места остановки.
- Skills system — переиспользуемые AI-поведения на уровне проекта.
- Детектор петель — автоматически останавливает зациклившегося агента.
- Dead man's switch — защитный механизм для долгих автономных задач.

**Приватность**
- Нет телеметрии Microsoft — поле `enableTelemetry` убрано из `product.json`.
- Локальное хранение телеметрии с явным opt-in для облака.
- API-ключи через Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux libsecret).
- Офлайн-гейт приватности — embedding и контекстный пайплайн уважают офлайн-режим.
- Детекция секретов перед отправкой контекста в любой LLM.

**Редактор**
- Полная совместимость с VS Code — настройки, кейбиндинги и рабочие процессы переносятся без изменений.
- Реестр расширений Open VSX — без аккаунта Microsoft.
- Встроенная тема Vibe Neon.
- Git-интеграция с автоматическим stash при агентных правках.
- Статусбар контекстного окна — видно сколько контекста используется.

---

## Быстрый старт

### Требования

- Node.js 20+ (файл `.nvmrc` — используйте `nvm use`)
- Python 3.x
- Git

### Сборка из исходников

```bash
git clone https://github.com/VibeIDETeam/VibeIDE.git
cd VibeIDE
npm install
npm run compile
./scripts/code.sh        # Linux / macOS
.\scripts\code.bat       # Windows
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

### Папка `.vibeide/` — служебные данные IDE в воркспейсе

Создаётся автоматически (не трогать руками, добавьте в `.gitignore`):

- `.vibeide/audit.jsonl` — аудит-лог всех действий агента: промпты, диффы, применения, откаты, stash-операции. Включается через `vibeide.audit` в настройках. Поддерживает ротацию по размеру (по умолчанию 10 МБ) и удаление (GDPR erasure).

RAG-индекс кодовой базы хранится **не** в `.vibeide/`, а в системном `workspaceStorage` IDE. Если в проекте есть старый `.vibeide/index.json` — он будет мигрирован автоматически.

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

## Участие в разработке

Pull request'ы приветствуются. Перед началом значимой работы — откройте issue для обсуждения подхода.

Инструкции по сборке, гайдлайны и процесс PR: [CONTRIBUTING.md](CONTRIBUTING.md) и [HOW_TO_CONTRIBUTE.md](HOW_TO_CONTRIBUTE.md).

Что изменено относительно upstream VS Code: [FORK_CHANGES.md](FORK_CHANGES.md).

---

## Связь, сообщество и поддержка

**Discord** — самый быстрый способ задать вопрос по установке и использованию, обсудить идеи и поймать «плавающие» баги вместе с другими пользователями, пока вы ещё не уверены, что это стоит оформлять в тикет.

<p>
  <a href="https://discord.gg/NFc3EKPany" title="Приглашение в Discord VibeIDE">
    <img src="https://img.shields.io/badge/Discord-войти_на_сервер-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord — приглашение на сервер" />
  </a>
</p>

**GitHub Issues** — для **воспроизводимых** сбоев, регрессий и предложений по продукту лучше завести [issue в репозитории](https://github.com/VibeIDETeam/VibeIDE/issues/new): так задача не потеряется, к ней можно приложить логи и версию сборки, а исправление будет привязано к релизам.

**Почта** — [mail@vibeide.ru](mailto:mail@vibeide.ru): деловые вопросы, партнёрство, обратная связь вне публичных площадок.

### Поддержать проект

Если VibeIDE оказался полезным — буду рад благодарности 🙏

<a href="https://raw.githubusercontent.com/borodatych/VSCodeSyncFiles/main/media/QR-Code.jpg" target="_blank" rel="noopener noreferrer">
  <img src="https://raw.githubusercontent.com/borodatych/VSCodeSyncFiles/main/media/QR-Code.jpg" width="120" alt="QR-код для поддержки проекта" />
</a>

---

## Лицензия

MIT — см. [LICENSE.txt](LICENSE.txt).

VibeIDE построен на базе [VS Code open source (Code-OSS)](https://github.com/microsoft/vscode), который также распространяется под лицензией MIT. Сторонние компоненты: [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
