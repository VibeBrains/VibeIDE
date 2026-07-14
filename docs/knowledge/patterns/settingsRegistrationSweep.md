# Settings registration sweep — pattern + footguns

> Контекст: roadmap-max runs Apr-May 2026 завернули ~20 vibeide-сервисов в
> Settings UI через `IConfigurationRegistry.registerConfiguration`. До этого
> ключи существовали только через `?? default` fallback в коде —
> «фантомные» настройки, недоступные пользователю.

## Контекст / Суть / Применение

### 1. Phantom config keys

**Контекст.** Сервис читает `this._config.getValue<T>('vibeide.foo')` через
`IConfigurationService`. Если ключ нигде не зарегистрирован — `getValue`
возвращает `undefined`, код падает на `?? default`. Всё работает «как ожидается»,
но ключ не виден ни в Settings UI, ни в `settings.json` autocomplete, ни в
`Configure Display Language`.

**Суть.** Конфигурацию надо **регистрировать**, даже если у тебя уже есть
дефолт в коде. Регистрация — это не «дополнительный шаг», это сам факт
существования настройки для пользователя.

**Применение.** Каждый раз когда читаешь `_config.getValue('vibeide.X')` в
новом сервисе — сразу добавь `Registry.as<IConfigurationRegistry>(...)`
блок где-то в этом же файле (`// ── Configuration ──`). Дефолт в `??`
fallback'е → это **миграционный артефакт**, не паттерн.

### 2. Где регистрировать — рядом или в `vibeideGlobalSettingsConfiguration`?

**Контекст.** Два паттерна сосуществуют:
- **In-service registration** — Registry-блок в самом сервисе (`auditLogService.ts`,
  `gitAutoStashService.ts`, ...). Регистрация выполняется при первом импорте
  модуля.
- **Centralised** — `vibeideGlobalSettingsConfiguration.ts`
  (`WorkbenchPhase.BlockRestore` contribution) собирает группы `vibeide.skills.*`,
  `vibeide.global.*`, `vibeide.commands.*`.

**Суть.** Правило отбора: **если сервис уже импортируется через
`vibeide.contribution.ts` независимо** — регистрируй в нём же (избегаешь
двойной точки изменения). **Если ключи — application-scope user prefs без
очевидного «хозяина-сервиса»** — централизованный файл.

**Применение.** `vibeide.skills.*`, `vibeide.commands.*` идут в
`vibeideGlobalSettingsConfiguration.ts`. `vibeide.audit.*`, `vibeide.safety.*`,
`vibeide.context.*` — в сервис, который их потребляет.

### 3. Standalone config files как mini-registries

**Контекст.** Иногда настройка нужна, а сервиса-потребителя ещё нет
(пуре-helper landed, runtime hookup отложен). Примеры:
`vibeAgentBehaviorConfiguration.ts`, `commandsAuditPrivacyConfiguration.ts`,
`vibeAgentResponseLanguageConfiguration.ts`.

**Суть.** Standalone-файл с одним `registerConfiguration({...})` блоком + import
в `vibeide.contribution.ts` — корректный паттерн «зарегистрировать ключи
заранее, пока сервис ещё не написан». Когда landed runtime — он просто
читает уже-существующие ключи, без миграции пользовательских settings.

**Применение.** Если из roadmap-skeleton надо «зарегистрировать настройку
до runtime» — заводи отдельный `xxxConfiguration.ts` файл, не пихай Registry-блок
в pure helper (helper останется vscode-free для unit-тестов).

### 4. `localize()` для description / enumDescriptions

**Контекст.** Если `description` или `enumDescriptions` пишутся как литералы —
они попадают в i18nUnwrappedScanner findings и блокируют закрытие L520 baseline.

**Суть.** Всегда оборачивай в `localize('vibeide.foo', 'описание')`. Ключ
конвенция: `<settingFullPath>` или `<settingPath>.<sub>` (для enumDescriptions
именно подкарта, не одна общая строка).

**Применение.** При написании Registry-блока — `import { localize } from
'../../../../nls.js'` сразу. Brand-allowlist в scanner отсекает только провайдер
brand-names; «русские описания настроек» — нет.

### 5. ConfigurationScope choice

**Контекст.** `ConfigurationScope.APPLICATION` (user-wide) vs `RESOURCE`
(per-workspace) vs `WINDOW` (per-window) — выбор влияет на то где появится
ключ в settings.json и как профили его шарят.

**Суть.** Правило большого пальца:
- **APPLICATION** — секреты, API-ключи, user-wide preferences (`vibeide.global.*`,
  `vibeide.skills.globalPaths`, `vibeide.commands.globalPaths`).
- **RESOURCE** — проектные пороги, per-workspace overrides (`vibeide.context.warningThresholdPercent`,
  `vibeide.skills.sessionActiveIds`).
- **Не указывать (default)** — наследовать workspace scope, подходит для большинства флагов.

**Применение.** «По умолчанию опускай scope» — VS Code сам выберет workspace.
Указывай явно только когда нужен APPLICATION (нельзя пере-override'ить
из workspace) или явно WINDOW.

### 6. `minimum` / `maximum` clamp для number полей

**Контекст.** Без `minimum` / `maximum` пользователь может вписать любое
значение, и runtime'у придётся его клампить руками. Без явного объявления
типа — Settings UI рендерит plain text input.

**Суть.** Все number-настройки — с `minimum`, `maximum`, и в коде runtime
ещё раз клампь (defense in depth — пользователь может править через
`settings.json` напрямую с любым числом).

**Применение.** Пример:
```ts
'vibeide.safety.deadMansSwitchMinutes': {
    type: 'number',
    default: 5,
    minimum: 0,
    maximum: 60,
    description: localize('vibeide.safety.deadMansSwitchMinutes', '...'),
},
```

### 7. Запах: «настройка есть, но её нигде не видно»

**Контекст.** Симптом фантомной настройки: `grep -r "vibeide.foo"` находит
только consumer site, нигде нет `registerConfiguration`.

**Суть.** Это roadmap-debt — добавляй регистрацию **в том же коммите**, что
вводишь чтение. Не «потом раз отдельно зарегистрируем».

**Применение.** При code-review — если PR добавляет
`_config.getValue('vibeide.X')` и не регистрирует ключ → request changes.

## Связанные документы

- [architecture/settingsNamespaces.md](../architecture/settingsNamespaces.md) — общая инфра namespacing'а ключей
- [orphanServices.md](../architecture/orphanServices.md) — список «сирот» с
  pending registration работой
- `docs/roadmap.md` §K.4 L520 (i18n baseline) + §K.4 L1056 (perf guardrails dashboard)

## Sweep history (для траекторий — что попало в эту волну)

Single-commit мульти-сервис sweep `3f906683 feat(settings): surface internal service config keys`:
audit / autostash / contextGuard / deadMansSwitch / loopDetector / rollback / vectorStore /
ambientAgent / autocompleteExplain / planEventJournal / runTestsAfterApply /
stealthMode / structuredOutput / tokenBudget / voiceInput + 2 standalone-файла
(`vibeAgentBehaviorConfiguration`, `commandsAuditPrivacyConfiguration`).

Следующая волна `7fb3e875 feat(settings): register vibeide.commands.{globalPaths,toolbar.position}`
зарегистрировала project-commands ключи централизованно в
`vibeideGlobalSettingsConfiguration` (паттерн 2 выше).
