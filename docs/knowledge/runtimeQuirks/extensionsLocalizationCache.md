# Локализация builtin extension cache

← [Knowledge Index](../README.md)

## [баг] Два сканирования получали разные языки и инвалидировали кэш при каждом запуске

**Контекст:** VibeIDE 1.28.1 при русском UI каждый запуск писал `Invalidating Cache` и предлагал перезагрузить окно. В кэше были английские манифесты, при проверке — русские; расходились только расширения с локальным `package.nls.ru.json`.

**Суть:** `AbstractExtensionsScannerService.createExtensionScannerInput()` загружал language pack для `language ?? platform.language`, но сохранял исходный `language` в `ExtensionScannerInput`. Сканирование без аргумента читало английские манифесты, сканирование с `platform.language` — локализованные. Теперь один `resolvedLanguage` используется и для translations, и для `package.nls.<language>.json`.

**Применение:** скан с явным языком и без него должен давать одинаковые манифесты. Регрессия — `extensionsScannerService.test.ts`. Дубли настроек `vibeide.trustScore.level` и `vibeide.skills.workspaceDiscoveryHint` удалены из `extensions/vibeide-neon/package.json`: единственные объявления остаются в `vibeideGlobalSettingsConfiguration.ts`, осиротевшие NLS-ключи удалены.
