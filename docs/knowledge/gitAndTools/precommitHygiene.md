# Pre-commit hygiene: tsx-раннер, фильтры vibeide, lint-staged

← [Knowledge Index](../README.md)

---

## [инструмент] Как устроен и чинится pre-commit hygiene

**Контекст:** husky pre-commit → `npm run -s precommit` → `node scripts/vibe-seeds-pointer.ts && tsx build/hygiene.ts && npx lint-staged && node scripts/i18n-sync.js --apply` (гейт указателя набора — первым, см. последний раздел). `build/hygiene.ts` гоняет copyright/unicode/indentation/formatting/ESLint/stylelint на staged-файлах. Долго хук был фактически сломан и накопленный код коммитился через `--no-verify`; починен 2026-06-30 (merge `2a854384`).

**Суть — почему `tsx`, а не `node`:**
- `eslint.config.js` импортирует `./.eslint-plugin-local/index.ts`, который через `require()` грузит правила (`.eslint-plugin-local/*.ts`), написанные в CJS-стиле `export = new class …`.
- Под `node --experimental-strip-types` это падает: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: export assignment`. Под `--experimental-transform-types` — `module is not defined in ES module scope` (в `package.json` `"type":"module"`).
- Рабочий путь — **`tsx`** (esbuild корректно трансформирует `export =`/CJS). Скрипты `precommit` и `eslint` в `package.json` запускаются через `tsx`. Зависимость: `devDependencies.tsx`.
- **Пин версии важен:** `tsx@4.19.2` имеет баг — `import.meta.dirname === undefined` в require-пути, из-за чего падает `code-import-patterns.ts`. Брать `^4.22.4`+.

**Суть — фильтры для vibeide (`build/filters.ts`):**
- `vibeide` исключён из `unicodeFilter` и `indentationFilter`. Причина: Russian-first форк намеренно несёт богатый Unicode (математика `≤≥≈∞∩`, box-drawing, emoji, греческий, кириллица) в UI-строках/логах, а большие template-литералы (системные промпты, тест-фикстуры) — пробельные данные внутри строк. Upstream homoglyph/таб-проверки к авторскому коду форка неприменимы.
- Кириллица + русская пунктуация (`«» „" § №`) дополнительно разрешены в общем allowlist-regex `build/hygiene.ts` (для не-vibeide файлов).
- **Наши build/release-скрипты исключены из `unicodeFilter`** (2026-07-14): `release-{windows,macos,linux}`, `home-build-windows.ps1`, `lib/home-build-common.sh` — рамки box-drawing и глифы статуса там форматирование консольного вывода, а не код; обоснование то же, что у `vibeide/**`. До этого правка **одной строки** в любом из них поднимала 70+ пред-существующих находок → коммит только через `--no-verify`, то есть хук снова превращался в декорацию. Исключения **пять явных путей**, не `scripts/**`: остальные скрипты (в т.ч. апстримные) проверяются как раньше.
- **Грабля при правке `build/filters.ts`:** `unicodeFilter` (стр. ~33–76) и `indentationFilter` (стр. ~78–166) **оба** заканчиваются строкой `'!src/vs/workbench/contrib/vibeide/**'` — якориться на неё при вставке нельзя, легко попасть не в тот фильтр (проверено на себе). Ориентир — комментарий над строкой: у unicode он про «Russian-first … rich Unicode», у indentation — про «large template literals … tab indentation». И не тащите юникод в сам комментарий `filters.ts` — файл проверяется тем же фильтром и упадёт.
- В `eslint.config.js`: `local/code-no-unexternalized-strings` = off для `browser/react/**` и тестов — raw Russian-first строки React и CSS-классы не являются локализуемым контентом.

**Суть — `lint-staged` НЕ должен гонять ESLint:**
- ESLint staged-файлов уже делает `hygiene`. Дублирующий `npm run eslint -- --fix` в `lint-staged` (1) запускал по отдельному `tsx`-процессу на каждый чанк — на больших коммитах десятки node-процессов → зависание/OOM; (2) флаг `--fix` фактически игнорировался (`build/eslint.ts` не передаёт `fix` в ESLint). Удалён 2026-06-30; в `lint-staged` остались только markdown- и `SKILL.md`-хуки (с 2026-09-11 к ним добавлен гейт покрытия `deprecated.json` на сгенерированном манифесте).

**Применение:**
- Проверить hygiene вручную на staged: `tsx build/hygiene.ts` (без аргументов читает `git diff --cached`). На конкретных файлах: `tsx build/hygiene.ts <path...>`.
- Прогнать ESLint по vibeide целиком: через `ESLint` API под `tsx` (не `node` напрямую). `npm run eslint` уже на `tsx`.
- Запускать под нодой из **`.nvmrc`** (с 1.15.1 — Node 24.18.0, до неё была 22.22.1), активировать через fnm: чужой мажор ломает сборку.
- **Большой коммит (сотни файлов):** хук тяжёлый (ESLint дважды + i18n-sync). После ручной валидации (`hygiene` exit 0, ESLint 0, tsgo 0) допустимо `git commit --no-verify` именно из-за объёма — на обычных коммитах (единицы файлов) хук быстрый и `--no-verify` не нужен.

**Антипаттерны:**
- Не возвращать `node --experimental-strip-types build/hygiene.ts` — снова сломает загрузку CJS-правил.
- Не «чинить» массовый `code-no-unexternalized-strings` в React оборачиванием в `localize()` — это архитектурно неверно (React-слой не использует nls).
- Не глушить type-правила (`no-explicit-any`, casts) через `// eslint-disable` — заводить реальные типы/guard'ы.

**Связано:** [russianFirst.md](../i18n/russianFirst.md), [gitFlow.md](gitFlow.md), [compileAndSync.md](../build/compileAndSync.md).

---

## [foot-gun] Фильтры hygiene каскадные: исключение шире своего имени

**Контекст:** 2026-07-15. Чтобы протолкнуть коммит, добавил `'!scripts/vibe-doctor.js'` в **`copyrightFilter`** — казалось, «этот файл не проверяем на копирайт». Через час выяснилось, что заодно отключился **ESLint** по обоим исключённым файлам: возврат в проверку вскрыл 61 накопленный `curly`.

**Суть:** подмножества в `build/filters.ts` **вложены**, о чём написано в шапке самого файла:

```
all ⊃ eol ⊇ indentation ⊃ copyright ⊃ typescript
```

`build/hygiene.ts` строит конвейер, где каждый следующий `filter()` сужает уже отфильтрованный поток. Поэтому `!path` в **раннем** фильтре выкидывает файл из **всех последующих** проверок, а не из одной одноимённой. Цена растёт слева направо: исключение в `copyrightFilter` дороже, чем в `typescript`.

Смежное: **shebang и copyright-чек взаимоисключающи** — `copyrights` сравнивает строки 0–3 с эталоном вербатим, а `#!/usr/bin/env node` обязан быть строкой 1. Но это почти всегда ложная дилемма: у наших CLI-скриптов shebang **рудимент** (зовутся `node scripts/…` из npm/CI/`bin/vibe.mjs`; воркер вообще отказывает при прямом запуске). Снять shebang → заголовок встаёт на строку 0 → исключение не нужно.

Ещё: файл линтуется, **только когда попадает в staged** (`hygiene` читает `git diff --cached`). Отсюда иллюзия «всё чисто»: неконформные скрипты годами лежат зелёными, а первый же, кто тронет строку, получает всю накопленную пачку (у `vibe-doctor.js` — 96 юникод-находок на **чистом удалении** блока).

**Применение:**
- Прежде чем исключать путь — спросить: «из скольких проверок это его выкинет?» Ответ читать по цепочке `all ⊃ eol ⊇ indentation ⊃ copyright ⊃ typescript`, а не по имени фильтра.
- Исключать в **самом позднем** фильтре, который закрывает проблему. `unicodeFilter` для console-скриптов с box-drawing — законно (рамки вывода = данные). `copyrightFilter` — почти никогда: сперва убрать рудиментарный shebang.
- Автофикс ESLint запускать **под `tsx`**: `npx tsx ./node_modules/eslint/bin/eslint.js --fix <path>`. Standalone `npx eslint` падает на загрузке локального TS-плагина (`export = new class …`), а `npm run eslint` игнорирует `--fix` (`build/eslint.ts` не передаёт `fix`).
- После автофикса control-flow (`curly`) — **прогнать скрипт**, а не только линтер.

**Антипаттерны:**
- Исключение как способ «протолкнуть коммит»: тихо снимает и соседние проверки.
- Юникод в комментарии к самому исключению в `filters.ts` — сам себя завалит (наступал: `≤/≥/✗` в пояснении).
- Заголовок, вписанный **над** shebang: файл перестаёт парситься (`'#!' can only be used at the start of a file`) — наступал.

**Связано:** [[verifyBeforeHypothesizing]] («зелёный чек ≠ работающий чек» — тот же корень: граница гарантии не там, где кажется), [[agenticRewriteNeedsOracle]].

## [правило] Карта фильтров + расширение вырезок на VibeIDE-зоны вне `src/vibeide/**` (2026-07-19)

**Контекст:** миграция doc-путей тронула комментарии в 62 файлах → pre-commit выдал 170 ошибок на **пред-существующем** долге (доказано: заголовок `golden-eval.js` = HEAD). Разбор вскрыл устройство и дыру в вырезках.

**Устройство (`build/hygiene.ts` + `build/filters.ts`):** pre-commit `tsx build/hygiene.ts` без аргументов берёт **`git diff --cached`** (только staged), фильтрует через набор **`all`** (`* build/** extensions/** scripts/** src/** test/**` — **`docs/` НЕ входит**, доки не проверяются вовсе) и гоняет каскад `all ⊃ eol ⊇ indentation ⊃ copyright ⊃ typescript`:
- **unicode** — гомоглифы; кириллица и `«» „" § №` разрешены (`hygiene.ts:72`), но box-drawing `──`, стрелки, emoji, `⊘/✅/✗` — нет. Исключён `.md`.
- **indentation** — «хорошо» = `^[\t]*` (табы); ведущие **пробелы** = «Bad whitespace indentation». Исключён `.md`, `build/**/*.sh`.
- **copyright** — точный 4-строчный MS-заголовок; сравнение с `lines[0]`. Исключены `.md/.json/.sh/.bat/…`, но **не `.js/.mjs/.ts`**.

**Дыра:** вырезки покрывали только `src/vs/**/vibeide/**`, а форк-авторские зоны **вне** него — нет. Мимо проходило: release/build shell-скрипты (`build-macos-universal.sh`, `notarize-macos.sh`, `sign-windows.ps1` — box-drawing + пробельные heredoc-usage), `extensions/vibeide-*/**` (глиф `⊘`), `scripts/vibe-golden-eval.js` (box-drawing). Тронешь по другому поводу → лавина, тренаж на `--no-verify`.

**Фиксы (сделаны):**
- `unicodeFilter` += `!scripts/{build-macos-universal,notarize-macos}.sh`, `!scripts/sign-windows.ps1`, `!scripts/vibe-golden-eval.js`, `!extensions/vibeide-*/**` (тот же «rich Unicode by design», что у `src/**/vibeide/**`).
- `indentationFilter` += `!scripts/{build-macos-universal,notarize-macos}.sh` — **пробелы там легитимны**: строки 53-62 это тело `cat <<'EOF'` (usage-текст), их отступ — печатаемый вывод; табы сломали бы вывод. Тот же shell-carve-out, что `build/**/*.sh`.
- **`hygiene.ts` copyright-чек научен пропускать shebang** (`const offset = lines[0]?.startsWith('#!') ? 1 : 0`) — общий баг: исполняемый скрипт обязан держать shebang на строке 0, MS-заголовок легитимно идёт следом. Раньше **любой** shebang-скрипт (`vibe-plan-merge-driver.js` и т.п.) валил copyright. Теперь MS-заголовок после shebang проходит — добавлен в `vibe-golden-eval.js`, `vibe-docs-dedup.js`.

**Применение:** новый форк-авторский файл вне `src/**/vibeide/**` с богатым Unicode/пробельным console-выводом — сразу в соответствующую вырезку `filters.ts` **с комментарием-обоснованием**, не жди лавины. `.md` под hygiene не попадают вообще (в `all` нет `docs/`) — «исключить docs/**» бессмысленно. Проверка вырезки — `npx tsx build/hygiene.ts <файлы>` до 0, затем staged-прогон `npx tsx build/hygiene.ts` (читает `git diff --cached`).

## [правило] hygiene на PR-гейте: 771→0, вырезки по директориям + ретаргет product.json-чека (2026-07-20)

**Контекст:** PR #2 (`next→main`) впервые прогнал `hygiene` как gulp-таск (`npm run gulp hygiene`, читает **диск через `vfs.src`**, не git-index) на всём `all` → **771 ошибка**, все пред-существующие (пуши без PR их скрывали). Каскад: 571 indentation + 193 unicode + 5→39 copyright + 1 format + 1 product.json. Урок [[precommitHygiene]] «не whack-a-mole, а вырезки по директориям» применён:

- **unicode:** энумерация `!scripts/<файл>` (10+ строк) свёрнута в **`!scripts/**`** — весь `scripts/**` это форк-тулинг с box-drawing console-выводом; не шипается, `.js` всё равно линтится eslint'ом (падает только гомоглиф-чек). Три легитимных символа в комментариях **upstream/форк-исходников** (`∈` U+2208, `≥` U+2265, `“”` U+201C/D) добавлены в allowlist-регекс `hygiene.ts` (исходники не трогаем ради гомоглиф-чека; использованы явные глифы, проверено codepoint'ами).
- **indentation:** `!scripts/**` (heredoc-usage + свои конвенции), `!extensions/vibeide-neon/**` (форк-CSS `media/` 2 пробела + вендор-снапшоты `upstream/vendor-neon-theme/**` — upstream не трогаем ради стиля), `!test/componentFixtures/**` (Playwright/Prettier 2 пробела). Один форк-добавленный битый блок-коммент в upstream-CSS (`chatInlineAnchorWidget.css:34` — континуация с 3 пробелами) схлопнут в одну строку (чиним свою правку, не upstream-стиль).
- **copyright:** `!extensions/vibeide-neon/**/*.css` (тема — данные токенов, не исходник). **`!**/*.tsbuildinfo`** добавлен в `all` — это gitignored TS-инкремент-кэш; на диске появляется после компиляции, gulp-hygiene его подхватывал (39 ложных срабатываний), pre-commit — нет (читает git-index).
- **product.json extensionsGallery (D8):** upstream-гард `if (product.extensionsGallery) error` **ретаргетнут** на реальную цель — блокировать проприетарный MS-маркетплейс. VibeIDE намеренно шипает Open VSX (`open-vsx.org`); чек теперь падает только если URL галереи ведёт на `visualstudio.com`/`marketplace.visualstudio`/`*.microsoft.com`. Гард `BUILD_SOURCEVERSION` в CI **не** установлен → чек в CI работает, поэтому это был реальный красный, не локальный артефакт.

**Проверено:** `npm run gulp hygiene` → exit 0, 0 ошибок; `build/` typecheck → exit 0. Расхождение счётчиков CI-лога (5 copyright) и локали (39) — из-за неполного лог-фетча + тайминга генерации `.tsbuildinfo`; авторитетен полный локальный прогон.

## [foot-gun] Хук и подмодули: гейт трижды числился подключённым и не работал (2026-09-11)

**Контекст:** гейт `scripts/vibe-seeds-pointer.ts` — указатель подмодуля `.vibe-defaults` обязан быть достижим из `origin/main` VibeBrains. Каждый раз «подключено» оказывалось неправдой, и каждый раз это показал живой прогон, а не чтение конфига.

**1. lint-staged 16 не видит подмодули — по устройству.** `node_modules/lint-staged/lib/getStagedFiles.js` отсеивает режим `160000` («Filter out submodules and symlinks»). Задача с ключом `.vibe-defaults` стоит в списке lint-staged и не может сработать никогда: в `--debug` git показывает указатель в индексе, а список проиндексированных файлов у lint-staged пуст. Проверка подмодуля — только прямо из цепочки `precommit`.

**2. `build/hygiene.ts` падает на коммите «только указатель».** Он тоже не видит подмодуль, получает пустой список и выходит с кодом 1: «No staged files found. Pass file paths to check unstaged files.» Стоя в цепочке раньше гейта, он подменял причину: при плохом указателе человек видел «нет файлов», а гейт не успевал сказать ни слова. Поэтому гейт — первым. А с 2026-09-11 такой коммит до hygiene вообще не доходит: гейт отклоняет сдвиг указателя без изменения сгенерированного манифеста (решение владельца) — с верной причиной и до обращения к сети. Сам сбой hygiene остаётся поведением апстрима, но попасть в него теперь нечем.

**3. Git протекает окружением хука в дочерние процессы.** Внутри pre-commit хука git экспортирует (проверено временным хуком, сохраняющим `GIT_*`): `GIT_INDEX_FILE=.git/index` — **относительный** путь, `GIT_PREFIX`, `GIT_EDITOR=:`, `GIT_AUTHOR_*`, `GIT_EXEC_PATH`, а при `-c` — ещё `GIT_CONFIG_PARAMETERS`. Дочерний `git`, запущенный с рабочим каталогом в подмодуле, наследует `GIT_INDEX_FILE` и работает не с тем репозиторием. Итог: все прямые запуски гейта верны, а настоящий `git commit` пропускает указатель на незапушенный коммит.

**Применение:**
- Для git-команд в ДРУГОМ репозитории (подмодуль, соседний клон), запускаемых из хука, — очищать переменные из `git rev-parse --local-env-vars` (собственный список git, 15 имён). Команды основного репозитория окружение сохраняют: `GIT_INDEX_FILE` — то, как хук видит индекс, который коммитится на самом деле, а при `git commit <пути>` он временный.
- **Хук доказывается только настоящим `git commit`**, в обе стороны и со страховкой: запомнить `HEAD`, после попытки сравнить и при сдвиге сделать `git reset --soft`. Прямой запуск скрипта доказывает скрипт, но не хук.
- Фильтр вывода при такой проверке — по **всем** маркерам скрипта, включая «пропускающие» (`⚠️ НЕ ПРОВЕРЕНО`): однажды провал спрятался ровно в строку, которую фильтр не ловил, а код выхода `tail` в конце конвейера был прочитан как код гейта.
- Чтобы hygiene не валил тестовый коммит «только указатель», проиндексировать рядом безвредную правку `.md`: `docs/` в набор `all` не входит, hygiene её не проверяет.

**Антипаттерны:**
- Ключ lint-staged на путь подмодуля — мёртвый конфиг, выглядящий подключённой проверкой.
- Относительные `GIT_*` плюс рабочий каталог в другом репозитории — тихая работа не с тем репозиторием.
- «Проверил прямым запуском» как доказательство для хука.

**Связано:** [../vibeDotfolder/sharedSeedContract.md](../vibeDotfolder/sharedSeedContract.md), [gitFlow.md](gitFlow.md).
