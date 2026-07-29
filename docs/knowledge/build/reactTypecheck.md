# Тайпчек React-части: гейт `npm run react-typecheck`

← [Knowledge Index](../README.md)

## Что было

`src/tsconfig.json` **исключает** `vs/workbench/contrib/vibeide/browser/react/**`, а `@types/react`
не был установлен вовсе. Значит 56 TSX-файлов чата, настроек и онбординга не проверял **никто**:
`npm run buildreact` их только бандлит (esbuild/tsup не тайпчекают), а корневой `compile-check-ts-native`
до них не доходит. Единственной реальной проверкой был живой смоук в собранной IDE.

Цена этого видна по улову первого же прогона — 53 ошибки, среди них не стилистика, а поведение:

- **14 инструментов агента без заголовков в чате** (`glob`, `grep`, `code_graph`, `find_references`,
  `search_symbols`, `automated_code_review`, `generate_tests`, `rename_symbol`, `extract_function`,
  `run_nl_command`, `kill_background_command`, `read_background_output`, `open_file`,
  `go_to_definition`): каталог `titleOfBuiltinToolName` отставал от `BuiltinToolName`, и вместо
  названия рисовался сырой id тула. Рядом стоял фолбэк `if (!titles) return t.name` — заплатка,
  которая гасила симптом и прятала причину.
- **Результат тех же инструментов не рендерился вообще:** `builtinToolNameToComponent` был объявлен
  тотальным (`{ [T in BuiltinToolName]: … }`), фактически неполон, а потребитель делал
  `?.resultWrapper` → `undefined` → `return null`.
- **`@recent` в чате не работал:** `accessor.get('IHistoryService')` возвращал `undefined`
  (сервиса не было в React-аксессоре), падение глушил внешний `catch`.
- **`@selection` и `@sym:` теряли диапазон строк:** клали `range` в вариант `File`, у которого поля
  `range` нет; правильный вариант — `CodeSelection`.
- **QuickEdit не сохранял файл перед правкой:** `callBeforeApplyOrEdit` принимал `URI | 'current'`,
  а React-вызов передавал объект опций; резолв молча возвращал `undefined`. Тип
  `CallBeforeStartApplyingOpts` и приватный `_getURIBeforeStartApplying` для этого уже существовали —
  контракт метода просто отстал от собственного замысла.
- **Тултипы, которых нет:** `title` на Lucide-иконке (`<Pin>`) и на `VibeButtonBgDarken` не
  поддерживается — три подсказки не показывались.
- **Кнопка с пустой надписью:** `workspaceS.refreshFileList` не существовал → `undefined`.
- **`hover: { enabled: false }`** — апстрим сменил тип на `'on' | 'off' | 'onKeyboardModifier'`,
  булев `false` тихо не отключал hover в превью-редакторе.
- **Три мёртвых сломанных компонента:** `VibeInputBox`, `VibeCheckBox`, `_VibeSelectBox` ссылались на
  `WidgetComponent`, удалённый ещё `670eb700` (18.05) — любой их рендер дал бы `ReferenceError`.
  Живые аналоги (`VibeInputBox2`, `VibeCustomDropdownBox`) на месте, замысел не потерян → удалены.

## Как устроен гейт

`npm run react-typecheck` → [scripts/vibe-react-typecheck.mjs](../../../scripts/vibe-react-typecheck.mjs)
запускает `tsgo --project react/tsconfig.json` и **падает только на ошибках под `react/src/`**.
Ошибки в импортированных workbench-модулях печатаются справочным хвостом: они принадлежат
`compile-check-ts-native` и `valid-layers-check`, а не этому гейту.

Конфиг `react/tsconfig.json` наследует `src/tsconfig.base.json`. Это ключевое: без него
`experimentalDecorators`, `lib: DOM` и `target` отсутствуют, и один только импортированный граф
даёт **4057** ошибок вместо 53 — из них ~3200 `TS1206` «Decorators are not valid here». Порядок
сокращения шума при настройке был: базовый конфиг (4057 → 532) → явные ambient-пути
`typings/`, `monaco.d.ts`, `debugProtocol.d.ts`, `@webgpu/types`, `trusted-types` (532 → 56) →
итоговые 53 в нашем коде.

## Грабли

- **`types` не задавать «по интуиции».** С явным списком без `node` всплывают три `TS2591` на
  `process` в `browser/vibeCustomCommandsService.ts`; с `node` — ломается весь browser-слой
  (`@types/node` переопределяет `setTimeout` → `TS2741 Timeout vs TimeoutHandle`). Апстримный
  `build/checker/tsconfig.browser.json` решает это тем, что `node` не подключает, а нужные ambient
  пакеты перечисляет **путями в `include`**. Здесь сделано так же.
- **`noUnusedLocals` выключен намеренно:** это лint-забота, и при включённом флаге гейт начинает
  ругаться на импортированный код, который мы не правим.
- **Проверка идёт по `react/src`, а `react/src2` регенерируется** из него при `compile` — править
  `src2` руками бессмысленно, гейт его и не смотрит.
- **`@types/react` + `@types/react-dom` + `@types/diff`** добавлены в `devDependencies`; без первых
  двух каждый TSX-файл тонет в `TS7016`/`TS7026`, без третьего `diff/index.tsx` даёт `TS7016`
  (пакет `diff@5` своих типов не поставляет).

## Применение

- Гонять `npm run react-typecheck` после любой правки в `react/src/**` — `compile-check-ts-native`
  эту область **не** покрывает и зелёный прогон там ничего о TSX не доказывает.
- Новый инструмент агента в `BuiltinToolResultType` → сразу заголовок в `titleOfBuiltinToolName`
  (гейт заставит: карта объявлена `satisfies Record<BuiltinToolName, …>`). Обёртка результата и
  описание параметров опциональны по дизайну — их карты частичные, есть generic-фолбэк.

Связано: [[reactBundleDeclarations]] (почему у бандлов свои `.d.ts`), [[compileAndSync]].
