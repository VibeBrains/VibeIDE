# Pre-commit hygiene: tsx-раннер, фильтры vibeide, lint-staged

← [Knowledge Index](../README.md)

---

## [инструмент] Как устроен и чинится pre-commit hygiene

**Контекст:** husky pre-commit → `npm run -s precommit` → `tsx build/hygiene.ts && npx lint-staged && node scripts/i18n-sync.js --apply`. `build/hygiene.ts` гоняет copyright/unicode/indentation/formatting/ESLint/stylelint на staged-файлах. Долго хук был фактически сломан и накопленный код коммитился через `--no-verify`; починен 2026-06-30 (merge `2a854384`).

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
- ESLint staged-файлов уже делает `hygiene`. Дублирующий `npm run eslint -- --fix` в `lint-staged` (1) запускал по отдельному `tsx`-процессу на каждый чанк — на больших коммитах десятки node-процессов → зависание/OOM; (2) флаг `--fix` фактически игнорировался (`build/eslint.ts` не передаёт `fix` в ESLint). Удалён 2026-06-30; в `lint-staged` остались только markdown- и `SKILL.md`-хуки.

**Применение:**
- Проверить hygiene вручную на staged: `tsx build/hygiene.ts` (без аргументов читает `git diff --cached`). На конкретных файлах: `tsx build/hygiene.ts <path...>`.
- Прогнать ESLint по vibeide целиком: через `ESLint` API под `tsx` (не `node` напрямую). `npm run eslint` уже на `tsx`.
- Запускать под **Node 22** (пин в `.nvmrc`, активировать через fnm; system Node 24 ломает сборку).
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
