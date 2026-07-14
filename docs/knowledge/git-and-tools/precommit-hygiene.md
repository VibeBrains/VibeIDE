# Pre-commit hygiene: tsx-раннер, фильтры vibeide, lint-staged

← [Knowledge Index](../README.md)

---

## [инструмент] Как устроен и чинится pre-commit hygiene

**Контекст:** husky pre-commit → `npm run -s precommit` → `tsx build/hygiene.ts && npx lint-staged && node scripts/i18n-sync.js --apply`. `build/hygiene.ts` гоняет copyright/unicode/indentation/formatting/ESLint/stylelint на staged-файлах. Долго хук был фактически сломан и накопленный код коммитился через `--no-verify` (см. [[next-sound-phase-2]]); починен 2026-06-30 (merge `2a854384`).

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
- Запускать под **Node 22** (fnm; system Node 24 ломает сборку — см. [[this-machine-build-release-setup]]).
- **Большой коммит (сотни файлов):** хук тяжёлый (ESLint дважды + i18n-sync). После ручной валидации (`hygiene` exit 0, ESLint 0, tsgo 0) допустимо `git commit --no-verify` именно из-за объёма — на обычных коммитах (единицы файлов) хук быстрый и `--no-verify` не нужен.

**Антипаттерны:**
- Не возвращать `node --experimental-strip-types build/hygiene.ts` — снова сломает загрузку CJS-правил.
- Не «чинить» массовый `code-no-unexternalized-strings` в React оборачиванием в `localize()` — это архитектурно неверно (React-слой не использует nls).
- Не глушить type-правила (`no-explicit-any`, casts) через `// eslint-disable` — заводить реальные типы/guard'ы.

**Связано:** [[next-sound-phase-2]], [[this-machine-build-release-setup]], [russian-first.md](../i18n/russian-first.md), [git-flow.md](git-flow.md).
