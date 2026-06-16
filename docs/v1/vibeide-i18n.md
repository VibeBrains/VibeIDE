# VibeIDE i18n — добавление новой локали

> Status: tutorial / contract.
> Source roadmap entry: «Документ `docs/v1/vibeide-i18n.md`: как добавить новую локаль».

VibeIDE использует стандартный VS Code NLS-механизм для VibeIDE-собственных строк
(настройки, команды, sidebar, welcome, status bar, notifications). Этот документ
описывает, как добавить новую локаль, чтобы перевод поставлялся как `vibeide-language-pack-<locale>`
и подключался через `contributes.localizations`.

## Архитектура bundle

- Каждая локаль — отдельный VSIX `vibeide-language-pack-<locale>` с
  `contributes.localizations`. Это **не** заменяет встроенный
  `MS-CEINTL.vscode-language-pack-ru` — он покрывает upstream-строки VS Code.
- Структура VSIX:

  ```
  vibeide-language-pack-<locale>/
    package.json
    translations/
      main/
        i18n/vibeide/**/*.i18n.json
      extensions/
        vibeide-neon/package.i18n.json
        vibeide-plan-dashboard/package.i18n.json
  ```

- Версия bundle = `product.json:vibeVersion`, не VS Code `version`.

## Шаги

### 1. Подготовить ключи

`localize()` / `localize2()` во всех `src/vs/workbench/contrib/vibeide/**` уже добавлены
(см. roadmap «i18n bundle для VibeIDE-специфичных строк»). Ключи извлекаются скриптом
`scripts/vibe-nls-extract.ts` в `vibeide.nls.metadata.json`.

### 2. Создать локальный JSON

```bash
node scripts/i18n-sync.js --locale de
```

Скрипт берёт `vibeide.nls.metadata.json`, дописывает `[NEEDS_TRANSLATION] <english>` для
новых ключей в `vibeide.nls.de.json`, переносит пропавшие ключи в
`_orphans.json` (не теряем переводы при рефакторинге имён).

### 3. Перевести

Ручной перевод или Crowdin (когда инфраструктура запущена). Для draft-перевода:

```bash
node scripts/vibe-i18n-draft.js --locale de --provider ollama
```

Создаёт PR с `[DRAFT_LLM]` маркерами на ревью человеком — никогда не коммитит
автоматически.

### 4. Собрать VSIX

```bash
npm run build-language-packs -- --locale de
```

Использует gulp-таски `extract-vibeide-locale-strings` и `build-vibeide-language-packs`.
Артефакт: `vibeide-language-pack-de-<vibeVersion>.vsix`.

### 5. Подключить к сборке

В `product.json`:

```jsonc
{
  "builtInExtensions": [
    {
      "name": "vibeide-language-pack-de",
      "version": "<vibeVersion>",
      "repo": "https://github.com/VibeBrains/vibeide-language-pack-de",
      "metadata": { "id": "vibeide-language-pack-de" }
    }
  ]
}
```

После релиза: bundle публикуется как GitHub Release ассет
`vibeide-language-pack-<locale>-<vibeVersion>.vsix`.

## Fallback chain

`<locale>` → `<locale-base>` (например `ru-by` → `ru`) → английский (default из второго
аргумента `localize()`) → ключ. Никаких пустых строк в UI.

## CI и качество

- `.github/workflows/i18n-coverage.yml` (план) — % покрытия переведено / total для каждой
  локали; warning, не fail (см. roadmap K.4 «Сменить policy `< 95% → fail` на `warning +
  grace period`»).
- `.github/workflows/i18n-lint.yml` (план) — ESLint правило `no-hardcoded-user-strings`
  на JSX-атрибутах `title`/`placeholder`/`aria-label` и `notify()` без `localize()`.
- Pre-commit hook через husky + lint-staged запускает `i18n-sync.js` локально и
  автоматически дописывает `[NEEDS_TRANSLATION]`.
- `i18n-roundtrip.test.ts` — проверяет (а) все ключи существуют в metadata, (б) число
  `{0}`/`{1}`-плейсхолдеров совпадает с английским источником.

## Pseudo-locale `qps-ploc` (smoke test)

`code.bat --locale qps-ploc` рендерит строки как `[!!_eXampLe_!!]`. Любая нелокализованная
строка остаётся в первоначальном виде — мгновенный визуальный QA непокрытых мест без
затрат на перевод.

## Каков «готовый» перевод

`docs/v1/vibeide-i18n.md` (этот файл) описывает workflow. Фактический Definition of Done
для **каждой** локали:

- 100% строк в `src/vs/workbench/contrib/vibeide/**` обёрнуты `localize()` / `localize2()`.
- `vibeide-language-pack-<locale>.vsix` собирается воспроизводимо.
- `code.bat --locale <locale>` показывает локализованный UI без артефактов в Settings UI
  на `vibeide.*`, в sidebar, в welcome.
- `code.bat --locale qps-ploc` подсвечивает 0 непереведённых VibeIDE-мест.
- `code.bat --locale en` (или удалённый bundle) — английский fallback работает, никаких
  ключей в UI.

## Backlog

- Внедрить gulp-таски `extract-vibeide-locale-strings` и `build-vibeide-language-packs`.
- Запустить публичный Crowdin (`vibeide.crowdin.com`) с webhook → автоматический PR.
- Опубликовать первый `vibeide-language-pack-ru.vsix`.
