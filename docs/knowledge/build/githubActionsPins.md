# GitHub Actions: версии действий закреплены по SHA

← [Knowledge Index](../README.md)

---

## [правило] `checkout` и `setup-node` — v6, закреплённые по SHA

**Контекст:** 2026-09-11. Первый прогон `raw-nul.yml` выдал предупреждение: `actions/checkout@v4` и
`actions/setup-node@v4` написаны под Node 20, и GitHub принудительно запускает их на Node 24. Так же
были устроены почти все наши workflow: 82 ссылки в 33 файлах — 47 на `@v4`, 35 на незакреплённом теге
`@v6`. Пришедший из апстрима `pr.yml` уже закреплял обе по SHA.

**Суть:**
- Все ссылки переведены на SHA из `pr.yml`: `actions/checkout@d23441a4… # v6.1.0` и
  `actions/setup-node@24997072… # v6.5.0` — это текущие теги `v6`. Одна версия на весь репозиторий:
  тег в комментарии нужен человеку, SHA — гарантия, что под тегом не подменят код.
- Что сверено перед сменой мажора (release notes v5 и v6):
  - оба v5+ требуют раннер не старше v2.327.1 (Node 24). Self-hosted джобы (`release.yml`,
    `pr-node-modules.yml`) уже стояли на v6 — нового требования к раннеру не появилось;
  - checkout v6 хранит учётные данные в `$RUNNER_TEMP`, а не в `.git/config`. `git push` в шагах
    `run:` работает как раньше (`fork-changes-sync.yml`, `i18n-readme-badge.yml`); раннер v2.329.0
    нужен только Docker-actions, их у нас нет;
  - setup-node v5+ сам включает кэш, только если в `package.json` есть `packageManager` — у нас этого
    поля нет, поведение не меняется;
  - входы `with:` всех 105 шагов (`fetch-depth`, `lfs`, `persist-credentials`, `ref`, `cache`,
    `node-version`, `node-version-file`) в v6 те же.

**Применение:** новый workflow — сразу с этими SHA, копировать их из `pr.yml`. Обновлять — все ссылки
разом одним коммитом, сверив release notes нового мажора. Проверка — `actionlint` по всем workflow до
и после: вывод обязан совпасть.

**Антипаттерны:** закреплять ссылку в кавычках дописыванием комментария. В
`uses: 'actions/checkout@<sha> # v6.1.0'` комментарий становится частью строки — кавычки сначала
снять (так было в `telemetry-audit.yml`).

## [решение] Вторая волна: остальные actions тоже по SHA, с Node 20 — на свежий мажор

**Контекст:** после первой волны на тегах оставались 18 ссылок на 8 actions. Пять из них работали на
Node 20: четыре с `runs.using: node20`, а `upload-pages-artifact@v3` — composite, внутри которого
`upload-artifact@v4`. Закрепить их по SHA как есть значило бы зацементировать устаревший рантайм.

**Суть:**

| Action | Было | Стало |
|---|---|---|
| `actions/upload-artifact` | `@v4` ×3, `@v7` ×5 | v7.0.1 (`043fb46d`) — тот же SHA, что уже в `pr-*.yml` |
| `actions/download-artifact` | `@v8` ×4 | v8.0.1 (`3e5f45b2`) |
| `actions/github-script` | `@v7` | v9.0.0 (`3a2844b7`) |
| `actions/deploy-pages` | `@v4` | v5.0.1 (`368f8252`) |
| `actions/upload-pages-artifact` | `@v3` | v5.0.0 (`fc324d35`) |
| `peter-evans/create-or-update-comment` | `@v4` | v5.0.0 (`e8674b07`) |
| `softprops/action-gh-release` | `@v3` ×2 | v3.0.3 (`efb35369`) |

Каждый SHA сверен через API с коммитом своего тега, `runs.using` прочитан из `action.yml` на
закреплённом коммите: везде `node24`, у `upload-pages-artifact` — composite с `upload-artifact` v7.0.0
внутри. На 2026-09-11 все восемь версий — последние релизы.

Что сверено по release notes и по нашему использованию:
- `upload-artifact`: v5 — предварительная поддержка Node 24, v6 — Node 24 по умолчанию, v7 — ESM и
  загрузка одного файла без архива (вход `archive`, по умолчанию `true` — архив, как раньше). Наши входы
  `name`, `path`, `retention-days` в v7.0.1 есть.
- `github-script`: v8 — только Node 24. v9 ломает `require('@actions/github')` и собственное объявление
  `getOctokit`; наш скрипт в `test-coverage.yml` зовёт только `github.rest.issues.*` и `context.*`.
- `upload-pages-artifact`: с v4 dotfiles в артефакт не попадают (v5 возвращает их входом
  `include-hidden-files`). `publish-schemas` кладёт в `_site` только `schemas/*.json` и `index.html`.
- `deploy-pages`: v5 — Node 24, v5.0.1 — backoff и jitter в опросе статуса деплоя. Входов мы не передаём.
- `create-or-update-comment`: v5 — Node 24. Наши входы `issue-number` и `body-path` на месте.
- Node 24 требует раннер не старше v2.327.1, но шаги со сменой мажора стоят только в джобах на
  `ubuntu-latest`. На self-hosted из 18 ссылок может попасть одна — `upload-artifact@v7` в джобе
  `compile` из `release.yml` (раннер выбирает переменная `USE_GITHUB_RUNNER`), и она была на Node 24 и
  до этого.
- `download-artifact`, `action-gh-release` и `upload-artifact@v7` закреплены на тех же коммитах, куда
  указывали их теги: поведение не изменилось.

**Применение:** новая ссылка — сразу по SHA с тегом в комментарии. Незакреплённых внешних ссылок нет,
если проверка ниже ничего не печатает. На 2026-09-11 в `.github` 176 строк `uses:`: 147 по SHA и
29 локальных `./`.

```bash
grep -a -rnE --include='*.yml' --include='*.yaml' "^[[:space:]]*(-[[:space:]]+)?uses:" .github \
  | grep -avE "uses:[[:space:]]*['\"]?\./|@[0-9a-f]{40}"
```

**Антипаттерны:** искать `uses:` подстрокой без якоря в начале строки — она находится внутри
`statuses:` (права workflow) и `causes:` (текст скилла). Искать только `@v<цифра>` — пропустит ссылку на
ветку вроде `@main`.

**Не проверено живьём:** пуш в `next` эти шаги не запускает, открытых PR нет.
- `github-script` в `test-coverage` и `create-or-update-comment` в `i18n-coverage` — только на PR.
- `upload-artifact` в `test-coverage`, `privacy-verify` и `idle-memory-regression` — только при падении
  джоба (`if: failure()`). У последнего есть ручной запуск, но на успешном прогоне шаг пропустится.
- `publish-schemas`, `release` и `sbom` при ручном запуске публикуют.

Первый прогон — на ближайшем PR, пуше в `main` или теге.

**Связано:** [portableAndElectron.md](portableAndElectron.md) — сборка в CI; запись в `docs/roadmap.md`,
секция DIGEST-0911.
