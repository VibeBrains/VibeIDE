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

## [долг] Что ещё работает на Node 20

`actions/upload-artifact@v4`, `actions/github-script@v7`, `peter-evans/create-or-update-comment@v4`,
`actions/deploy-pages@v4` — `runs.using: node20` в их `action.yml`. Составной
`actions/upload-pages-artifact@v3` — что у него внутри, не проверялось. Это следующая волна.
`softprops/action-gh-release@v3`, `actions/upload-artifact@v7` и `actions/download-artifact@v8` уже на
Node 24, но закреплены тегом, а не SHA.

**Связано:** [portableAndElectron.md](portableAndElectron.md) — сборка в CI; запись в `docs/roadmap.md`,
секция DIGEST-0911.
