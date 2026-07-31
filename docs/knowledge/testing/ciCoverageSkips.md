# Реестр пропусков покрытия в CI (скипы и отключения) — технический долг

> Домен: testing · создано 2026-07-21 (ветка `next`, PR #2)

## Принцип

**Скип теста в CI — это заплатка, а не решение.** Смысл CI (GitHub Actions) — гонять тесты на
каждом PR/пуше и ловить регрессии **до** мержа. Скип означает «этот тест в CI не проверяется» →
регрессия по нему пройдёт незамеченной до продакшена или до того, как кто-то вспомнит прогнать
локально. Скип оправдан **только** когда тест физически невозможен в headless-CI (нужен
GPU/дисплей/интерактив/внешний сервис), и даже тогда правильнее адаптировать тест под окружение,
чем прятать. Каждый скип ниже — **долг на возврат покрытия**, а не «done».

## Реестр (введено/расширено в кампании PR #2)

| # | Где | Что | Причина | Потеря покрытия | Правильный фикс |
|---|---|---|---|---|---|
| 1 | `policyExport.integrationTest.ts` | `if (TF_BUILD \|\| GITHUB_ACTIONS) this.skip()` | Тест запускает **вложенный полный Electron** (`code.sh --export-policy-data`); в headless CI виснет 60с (наследует user-data-dir родительского тест-VS-Code → lock). | Дрейф `build/lib/policies/policyData.jsonc` **не ловится в CI** — только на dev-машине, если кто-то вспомнит `npm run export-policy-data`. | Отдельный `--user-data-dir` (temp) для вложенного Electron в `exec` (строка ~56) + разобрать, почему автономный экспорт не пишет файл (contribution в renderer, `WorkbenchPhase.Eventually`/`withProgress(Notification)`). Диагностика — fs-маркеры (renderer `console.*` не в stdout даже с `ELECTRON_ENABLE_LOGGING=1`). |
| 2 | `screenshot-test.yml` | `on: workflow_dispatch` (снят auto-run на push/PR) | Диффит скриншоты против внешнего baseline-сервиса upstream vscode (`hediet-screenshots.azurewebsites.net`); форк не авторизован → 403. | Скриншот-регрессии компонентов **не ловятся в CI**. | Свой baseline-сервис/хранилище артефактов ИЛИ локальный компонент-рендер-чек без внешней зависимости (`component-explorer render` уже есть — сравнивать с checked-in эталонами в репо). |
| 3 | `disposable-audit.yml` | `continue-on-error: true` (soft gate) | leak-audit таймеров/disposables показывает findings в PR-чеках, но **не блокирует мерж**. Заведено как «promote to hard gate once existing findings are triaged». | Регрессия по утечкам таймеров/disposables **не блокирует** — можно замержить новую утечку. | Разгрести существующие findings → снять `continue-on-error` (сделать hard gate), как обещано в комментарии workflow. |
| 4 | `test/componentFixtures/playwright/tests/*.spec.ts` | `if (!available) test.skip()` — `localeI18n.spec` ×4, `privacyNetworkSniffer.spec` ×1 | Тест грациозно скипается, если компонент-фикстура не отрендерилась (`tryOpenFixture` вернул false / `page.goto` бросил). | **Риск тихого пропуска:** если фикстура НИКОГДА не рендерится в CI (сборка фикстур сломана), тест всегда скипается и «зелёный» — покрытия ноль, но никто не видит. | Проверить, что фикстуры реально рендерятся в CI (счётчик прогнанных vs скипнутых); заменить тихий `test.skip()` на **явный фейл**, если фикстура ожидаемо должна быть, но недоступна (тихий скип ≠ отсутствие фикстуры «по плану»). |

## НЕ долг (корректный роутинг/исключения, не потеря покрытия)

- **`vibeDocsGraphParity.test.ts`** — `this.skip()` по `process.type === 'renderer'`: тест node-only
  (динамический `import(file://scripts/…mjs)` вне бандла невозможен в Electron-рендерере). **Покрытие
  не теряется** — тест бежит в node-раннере (`npm run test-node`). Это правильный роутинг «тест туда,
  где он валиден», а не скип-долг.
- **cyclic-dependency чек** — исключены `react/out` (генерённые tsup-бандлы): исключение
  генерированных файлов из статического чека, а не пропуск теста.
- **transpile/compile** — исключены `react/src` (отдельный build-юнит): легитимное разделение сборки.
- **`continue-on-error` на diagnostics/publish** (`pr-darwin-test.yml`, `pr-win32-test.yml`: «Diagnostics
  before/after smoke», «Publish Crash Reports / Node Modules / Log Files») — upstream best-effort:
  вспомогательные шаги диагностики/публикации артефактов не должны ронять прогон. Покрытия не касаются.

## Как гасить долг

Перед снятием скипа: воспроизвести фейл локально → починить причину (не тест) → снять скип-условие
→ прогнать в CI. Для policyExport — начать с отдельного `--user-data-dir`, это наиболее вероятная
причина зависания. Связано: [[electronTestPollution]] (тот же мотив «долг вскрывается слоями»,
«чинить причину, а не прятать симптом»).
