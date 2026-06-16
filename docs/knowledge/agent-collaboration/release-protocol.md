# Release Protocol

Правила релизного pipeline VibeIDE: запуск скрипта, маршрутизация gh-аккаунтов, выбор фразы поддержки, post-release sync. Дополняет формальные требования `CLAUDE.md → «Версионирование»` и `CLAUDE.md → «Формат GitHub Releases»`.

---

## [pending] 1.2.1 собрана, но НЕ опубликована → её ченжлог влить в релиз 1.2.2 (2026-06-16)

**Контекст.** Двухфазный поток: **1.2.1** прошла только Фазу 1 (собрана с `-SkipPublish`, пользователь тестировал), но до Фазы 2 не дошло — нашлись правки, забампили сразу в **1.2.2**. Тега `v1.2.1` и GitHub Release **нет** (последний опубликованный — `v1.2.0`).

**Суть.** При публикации **1.2.2** релиз-ноты должны покрывать изменения **ОБЕИХ** версий:
- **1.2.1:** Config Guard (скан `.vibe/providers.json`+`mcp.json`), fix edit_file destructive-block, `.vibe/ignore` enforcement, browse_url alias-fix, audit-лог → `.vibe/`.
- **1.2.2:** flat `old_string`/`new_string` + терпимый матчер, gather-mode guidance, approvalType рефактор-тулам, подсветка `/skill:`.

`gh release create v1.2.2 --generate-notes` авто-нотки возьмёт от последнего тега `v1.2.0` → коммиты 1.2.1 попадут сами. Но **курируемый русский ченжлог** (секции 🐛/✨/🚀 + блок поддержки) надо писать руками за обе версии. Нюанс in-app «Что нового» (`vibeWhatsNew.ts`): модалка показывает запись ТОЛЬКО текущей версии — апдейт `1.2.0 → 1.2.2` запись `'1.2.1'` не покажет, поэтому в `'1.2.2'`-запись стоит свести и хайлайты 1.2.1.

**Применение.** На «публикуй»/«релиз» 1.2.2 — собрать changelog за `v1.2.0..HEAD` (обе версии) + слить хайлайты 1.2.1 в What's New `'1.2.2'`. **Снять эту заметку после публикации 1.2.2.**

---

## `release-windows.ps1` — `-Version` для минор/мажор бампов [release] [foot-gun]

**Контекст.** Скрипт `.\scripts\release-windows.ps1` без флага `-Version` безусловно делает `patch += 1` поверх текущей версии в `product.json`, делает свой коммит `chore: bump version to X.Y.Z` и пушит. На минор/мажор-бампе это даёт версию на патч выше задуманной. На v0.4.0 после ручного бампа `0.3.2 → 0.4.0` запуск скрипта без `-Version` дал тег `v0.4.1` вместо ожидаемого `v0.4.0`.

**Суть.** При минор/мажор-бампе **обязательно** вызывать с явным `-Version vX.Y.Z`, соответствующим только что забампленной версии. Для патч-бампа можно без `-Version` — авто-инкремент совпадает с намерением.

**Применение.**
- Запросы пользователя «повысь минор», «повысь мажор», «minor», «major» → перед скриптом вычислить целевую версию (`X.Y.0` / `X.0.0`), записать в `product.json` и `README.md`, закоммитить, и **обязательно** `release-windows.ps1 -Version vX.Y.Z`.
- Для патч-бампа (по умолчанию или «повысь патч») — звать без `-Version`, авто-инкремент норма.
- Признак промаха: после запуска скрипт пишет `chore: bump version to X.Y.Z+1` вместо ожидаемой версии. Либо принять смещённый тег, либо до `git push` тэга остановить и перезапустить с `-Version`.

---

## Post-release sync README + pre-clean archive [release]

**Контекст.** Скрипт обновляет только `product.json`, бейдж в `README.md` (`https://img.shields.io/badge/версия-X.Y.Z-green.svg`) — нет. После релизов v0.3.2 и v0.4.1 бейдж разъезжался с фактической версией.

**Суть.** После завершения скрипта (или после ручного bump-коммита) **сразу** проверить, что бейдж в `README.md` совпадает с `product.json → vibeVersion`. Не совпадает — править, коммитить (`chore: sync README badge to X.Y.Z`), пушить **без отдельного запроса подтверждения** — это рутинный follow-up уже одобренного релиза. Превентивно чистить `.build\win32-x64\archive\VibeIDE-*.zip` перед запуском скрипта (избегаем stale-asset как в v0.4.1) — тоже на автомате.

**Применение.**
- Триггеры авто-синка: завершение `release-windows.ps1`, любой commit `chore: bump version to …`, `gh release view` показывает версию выше чем строка `badge/версия-…` в `README.md`.
- Не спрашивать «синкнуть бейдж?» каждый раз — это часть релизного workflow.

---

## VibeIDE-версия в About-диалоге [release] [vscode]

**Контекст.** До v0.4.2 диалог Help → About показывал только `Version: 1.118.x` (базовый VS Code), пользователю было неясно какая у него версия VibeIDE.

**Суть.** Первая строка About теперь `VibeIDE: <vibeVersion>`, вторая `VS Code: <version>` (базовая версия форка). Источник правды — `productService.vibeVersion` из `product.json → vibeVersion`. Поле в `IProductConfiguration` ([base/common/product.ts](../../../src/vs/base/common/product.ts)).

**Применение.**
- Три точки сборки строки `aboutDetail` должны держать формат «VibeIDE первой, VS Code второй»:
  - [`src/vs/platform/dialogs/electron-browser/dialog.ts`](../../../src/vs/platform/dialogs/electron-browser/dialog.ts)
  - [`src/vs/platform/dialogs/browser/dialog.ts`](../../../src/vs/platform/dialogs/browser/dialog.ts)
  - [`src/vs/workbench/browser/parts/dialogs/dialog.ts`](../../../src/vs/workbench/browser/parts/dialogs/dialog.ts)
- При апстрим-merge'ах VS Code эти места могут регрессировать к «Version: …» — проверять и восстанавливать формат.
- Отдельных действий «обновить версию в About при бампе» **не нужно**: бамп `vibeVersion` автоматически отражается через `IProductService`.
- Новые поля (например `Build: <commit-short>`) — сохранять порядок: VibeIDE → VS Code → Commit → Date → ….

---

## gh account routing [reference]

**Контекст.** `gh auth` keyring хранит два аккаунта: `VibeBrains` и `borodatych`. Под `VibeBrains` push в `borodatych/VSCodeSyncFiles` падает с `403 Permission denied`.

**Суть.** Маршрутизация по проектам:

| Репозиторий | Активный аккаунт |
|---|---|
| `VibeIDE` | `VibeBrains` (default) |
| `borodatych/VSCodeSyncFiles` | `borodatych` (требует `gh auth switch -u borodatych`) |

**Применение.** Workflow для VSCodeSync релиза:
```
gh auth switch -u borodatych
git push origin main && git push origin vX.Y.Z
gh release create vX.Y.Z builds/vscodesyncfiles-X.Y.Z.vsix --title "…" --notes "…"
gh auth switch -u VibeBrains   # вернуть active по умолчанию
```

Возврат на `VibeBrains` после VSCodeSync-релиза **обязателен** — иначе следующая VibeIDE-операция полезет под чужим аккаунтом.

---

## Donation phrase choice — спросить пользователя [release] [voice]

**Контекст.** Блок «Поддержать проект» в release notes использует одну фразу из активного пула в [`docs/release-donation-phrases.md`](../../release-donation-phrases.md). Это голос проекта/автора, не технический параметр. На v0.8.0 фраза была выбрана агентом самостоятельно — пользователь отметил это как недосмотр.

**Суть.** Перед публикацией или edit-ом release notes **всегда** предлагать 2–3 кандидата из активного пула, релевантных тематике релиза, и спрашивать выбор у автора. Никогда не решать самостоятельно.

**Применение.**
- Триггеры: формирование release notes для нового релиза, edit существующего релиза, draft, любая ручная правка фразы.
- Шаги:
  1. Прочитать активный пул в [`docs/release-donation-phrases.md`](../../release-donation-phrases.md) (секция «Активные»).
  2. Отфильтровать 2–3 кандидата, тематически совпадающих с фиксами/фичами текущего релиза.
  3. Спросить через `AskUserQuestion` или прямым вопросом — какую брать.
  4. Только после ответа — вставлять в release notes блок и помечать в истории использования (внутри того же файла).
- История использования (таблица в нижней части файла) обновляется агентом сразу после релиза без отдельного спроса — это техническая фиксация факта.

---

## Пер-файловый diff working tree от прошлой сессии [release] [memory-loss]

**Контекст.** На v0.12.0 (2026-05-19) сессия началась с uncommitted working tree ~513 строк, оставшимся от прошлой сессии после OOM-краша + hardreset. Пользователь сказал «в прошлый раз мы упали» — ассистент воспринял как диагностический вопрос про OOM, а не как «вся uncommitted работа — твоя из прошлой сессии». Ассистент не помнил контекст и оформил release notes по беглому осмотру (`git diff --stat` + новые файлы). Пропустил подсветку `/skill:` через двухслойный overlay (inputs.tsx +125 / SidebarChat.tsx +36 / vibeide.css +53) и orphan-tool guard в aiSdkAdapter.ts (+90). Пользователь заметил, пришлось переписывать notes.

**Суть.** Перед оформлением release notes по uncommitted working tree от прошлой сессии — обязательно пройтись `git diff HEAD -- <file>` (или `git show <commit> -- <file>` после коммита) по **каждому** изменённому/новому файлу, не ограничиваться `--stat`. Размер в строках не показывает семантику: 36 строк могут быть UX-фичей, 90 — защитой от инфинит-лупа. В notes должна попасть **эффект-для-пользователя**, не «scope из коммит-сообщения».

**Применение.**
- Триггер: working tree содержит uncommitted M/?? от предыдущей сессии **И** пользователь просит релиз/коммит/changelog/CHANGELOG.
- Шаги: пройти diff каждого файла → описать каждую значимую правку одной фразой через **эффект**, не «изменён X».
- Антипаттерн: оформление notes по `git log --oneline` или `git diff --stat` без захода внутрь diff'а. Даёт ложное чувство покрытия.
