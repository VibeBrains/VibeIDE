<p align="center">
  <img src="cortexide-main.png" alt="VibeIDE" width="180" />
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

## Участие в разработке

Pull request'ы приветствуются. Перед началом значимой работы — откройте issue для обсуждения подхода.

Инструкции по сборке, гайдлайны и процесс PR: [CONTRIBUTING.md](CONTRIBUTING.md) и [HOW_TO_CONTRIBUTE.md](HOW_TO_CONTRIBUTE.md).

Что изменено относительно upstream VS Code: [FORK_CHANGES.md](FORK_CHANGES.md).

---

## Лицензия

MIT — см. [LICENSE.txt](LICENSE.txt).

VibeIDE построен на базе [VS Code open source (Code-OSS)](https://github.com/microsoft/vscode), который также распространяется под лицензией MIT. Сторонние компоненты: [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
