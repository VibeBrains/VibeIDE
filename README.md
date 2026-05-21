<p align="center">
  <img src="references/logo-final.png" alt="VibeIDE" width="180" />
</p>

<h1 align="center">VibeIDE</h1>

<p align="center">
  <strong>Открытый AI-редактор кода. Без подписки. Без телеметрии. Ваши ключи, ваши модели.</strong>
</p>

<p align="center">
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/VibeIDETeam/VibeIDE/releases"><img src="https://img.shields.io/badge/версия-0.13.0-green.svg" alt="Версия" /></a>
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

**Лимиты сессии и контекстного окна**

Идея: чем дольше тянется один чат и чем плотнее набито контекстное окно, тем выше шанс, что модель начнёт **галлюцинировать** — забывать ранние инструкции, путать файлы, выдумывать API, повторять уже сделанные правки. Параллельно растёт счёт за токены. Два независимых guard'а защищают от обоих сценариев — стоимости и качества.

- **Session token limit** — потолок суммы input+output токенов на одну chat-сессию. По умолчанию **2 000 000** — рассчитан на длинные autopilot-сессии без постоянных сбросов. При 80% использования — warning, при 100% агентские запросы блокируются до явного reset. **Если включён `chatAgentAutopilot`** — превышение не блокирует запрос: счётчик автоматически сбрасывается с записью в лог (с rate-limit 1 сек, чтобы зацикленный run не сбрасывал лимит сотни раз в секунду). Настройка: `vibeide.safety.sessionTokenLimit`, `…sessionTokenLimitEnabled` (Settings → VibeIDE → Safety).
- **Context window guard** — следит за заполнением контекстного окна модели в реальном времени и предупреждает **до** того, как модель начнёт деградировать. На **75%** — non-blocking warning, на **90%** — blocking-диалог *compact / continue / cancel* со снапшотом состояния. Пороги: `vibeide.context.warningThresholdPercent`, `vibeide.context.criticalThresholdPercent`.
- **Сброс счётчика** — кнопка «Сбросить сессию» в футере панели истории чата, либо команда `vibeide.tokenBudget.reset` через `executeCommand`. Сбрасывает только session-токены; контекст чата сбрасывается отдельно — кнопкой «New Chat» или командой `/clear`.
- **Per-task split (опционально)** — `vibeide.safety.taskQueueTokenSplitEnabled` делит session-budget между активными задачами очереди агентов пропорционально, чтобы одна жадная задача не съела весь лимит.
- **Индикатор в статус-баре** — показывает текущее заполнение контекста; цвет меняется зелёный → жёлтый → красный по мере приближения к лимиту, по клику открывается status-pane.

**Команды проекта**

Идея: не вспоминать и не набирать в терминале одни и те же длинные команды (`npm run compile-check-ts-native`, `scripts/test.bat --grep ...`, `docker compose up -d`, etc.) — один раз описать их для проекта и дальше запускать по нажатию.

- Описываешь команды один раз в `.vibe/commands.json` — они едут в репозитории вместе с проектом, у коллег появляются автоматически.
- Закреплённые (`pinned: true`) выводятся отдельным меню **Команды** в шапке IDE: inline pin / edit / delete, без перехода в настройки.
- Топ-9 закреплённых получают горячие клавиши `Ctrl+Shift+Alt+1..9` без ручной настройки; при изменении набора клавиши автоматически пере-биндятся.
- Импорт из `.vscode/tasks.json` через палитру — существующие таски переносятся одним кликом.
- Sanitizer режет shell-метасимволы и zero-width injection; первый запуск каждой команды и любая её последующая правка требуют явного approve (hash фиксируется в `.vibe/commands.trust.json`).
- Секреты подставляются через `${secret:KEY}` — реальные значения никогда не попадают в audit-лог и не уходят в облачные индексаторы.
- Редактор настройки: форма с валидацией полей или прямой JSON-режим — в панели настроек VibeIDE.

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

### Документация — local-only

Папки `docs/` и `references/v1/` **не коммитятся** — они в `.gitignore`. `docs/` — будущая публичная документация (на отдельный сайт), `references/v1/` — внутренние contracts и нормативки мейнтейнеров. На диске у разработчика они есть, в репозитории — нет. Подробности — `references/v1/docs-policy.md`. Если нужен периодический прод про устаревший `docs/knowledge.md` — запустить `node scripts/vibe-doctor.js --knowledge`.

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

## Сборка релиза

### Windows (локальная сборка)

Скрипт `scripts/release-windows.ps1` компилирует исходники, собирает `.exe`-установщик и `.zip`-архив, создаёт git-тег и публикует GitHub Release.

**Требования:** Node.js 20+, [gh CLI](https://cli.github.com/) (`winget install GitHub.cli`), [InnoSetup](https://jrsoftware.org/isinfo.php) (`choco install innosetup`).

```powershell
# Авто-бамп патча (0.1.2 → 0.1.3) + полная сборка + релиз
.\scripts\release-windows.ps1

# Пропустить компиляцию (исходники уже собраны)
.\scripts\release-windows.ps1 -SkipCompile

# Задать версию явно + создать как черновик
.\scripts\release-windows.ps1 -Version v0.2.0 -Draft
```

Скрипт автоматически инкрементирует `vibeVersion` в `product.json`, коммитит изменение и пушит тег перед созданием релиза.

### CI (все платформы)

Релиз для Windows, macOS и Linux через GitHub Actions запускается при пуше тега `vX.Y.Z` или вручную через `workflow_dispatch` в `.github/workflows/release.yml`.

Компиляция TypeScript по умолчанию выполняется на **self-hosted runner** (Windows-машина разработчика) — это обходит ограничения бесплатных GitHub-раннеров по памяти. Установка раннера:

```cmd
mkdir D:\github-runner && cd D:\github-runner
# Токен и команду взять из: github.com/VibeIDETeam/VibeIDE → Settings → Actions → Runners → New runner
.\config.cmd --url https://github.com/VibeIDETeam/VibeIDE --token <TOKEN>
.\svc.ps1 install && .\svc.ps1 start
```

Чтобы принудительно использовать GitHub-раннер вместо self-hosted — добавьте переменную репозитория `USE_GITHUB_RUNNER=true` в Settings → Variables.

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
