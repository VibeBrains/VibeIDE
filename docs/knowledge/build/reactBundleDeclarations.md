# React-бандлы: `.d.ts`-шимы против OOM tsgo в CI

## Симптом

`core-ci` (job «Compile & Hygiene») в CI падает на `tsgo-typecheck`:

```
error TS2305: Module './react/out/sidebar-tsx/index.js' has no exported member 'mountSidebar'.
```

— и так для всех ~10 `mount*`-функций (`mountSidebar`, `mountCtrlK`, `mountVibeSettings`, …).
Изначально считалось, что локально не воспроизводится, — это было следствием того, что рядом с
бандлами лежали `.d.ts` (сгенерированные или рукописные) конкретной машины, см. «Корень».

## Корень

- Воркбенч-исходники импортируют собранные React-бандлы напрямую:
  `import { mountSidebar } from './react/out/sidebar-tsx/index.js'`.
- `react/**` **исключён** из `src/tsconfig.json` (`exclude`), готовых `.d.ts` рядом с бандлами нет.
- При `allowJs: true` type-checker (tsgo) вынужден выводить экспорты **из самого бандла**.
- Бандлы — корректный ESM с именованными экспортами, но внутри лежат esbuild-обёртки `__commonJS`
  для React-зависимостей с присваиваниями `module.exports = …` во вложенных функциях (в
  `out/sidebar-tsx/index.js` — 11 вхождений `__commonJS`). **tsgo (в отличие от `tsc`) принимает
  такой файл за CommonJS** и теряет верхнеуровневые `export { … }`: модуль типизируется
  содержимым `module.exports` → `TS2305`.

**Проверено фактом (2026-07-29, macOS, памяти вдоволь, один tsgo):** убрать
`out/sidebar-tsx/index.d.ts` (экспорт в самом бандле остаётся) → `npx tsgo --project
./src/tsconfig.json --noEmit --skipLibCheck` даёт ровно тот же
`sidebarPane.ts(36,10): error TS2305 … has no exported member 'mountSidebar'`. То есть отказ
детерминированный, а не деградация под нехватку памяти.

**Ранее корень был записан неверно** — как память-ёмкий разбор 1.5–2.5 МБ бандла, деградирующий на
стеснённых раннерах (ubuntu-22.04, 2 vCPU / 7 ГБ, два параллельных `tsgo`). Признак различения:
при памятной гипотезе отказ был бы плавающим и только в CI; воспроизведение на свободной машине её
опровергает. OOM в этой области существует, но относится к другому: `tsup` с `dts: true` на тех же
входах роняет rollup-dts воркер с `ERR_WORKER_OUT_OF_MEMORY` — это причина не включать `dts`, а не
причина `TS2305`.

## Решение (правильное, не заплатка)

`build.js` после `tsup` генерирует лёгкие `.d.ts` рядом с каждым `out/<entry>/index.js`
(`generateDeclarations()`). Декларации **выводятся из исходников** `src/<entry>/index.tsx`, поэтому
не расходятся с реальными экспортами:

- каждый `export const mountX = mountFnGenerator(...)` → `export declare const mountX: VibeReactMountFn;`
  (общий тип, зеркалит возврат `util/mountFnGenerator`: `{ rerender, dispose } | undefined`);
- любой плоский `export { … };` (напр. `diff/index.tsx` → `diffLines`, `Change`) форвардится в
  исходный модуль (`export { diffLines } from 'diff';`), у которого свои типы.

TS предпочитает `.d.ts` над `.js` для одного модуля → импорт резолвится в крошечный шим, тяжёлый
разбор бандла **исчезает из графа**. `out/` в `.gitignore`, шимы регенерятся при каждой сборке;
в `core-ci` `build-vibeide-browser-react` идёт **первым** в series, до `tsgo-typecheck`, так что в
CI они есть к моменту проверки.

## Как это проверять фактом

- `.d.ts` реально используется, а не `.js`: удалить одну строку `export declare const mountSidebar`
  из сгенерированного `out/sidebar-tsx/index.d.ts` (в бандле экспорт остаётся) → `tsgo` даёт
  **тот же** `TS2305 has no exported member 'mountSidebar'`. Значит резолв идёт по шиму.
- Полный прогон: `npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck` → exit 0.

## Грабли, если трогать это снова

- Не включать `tsup dts: true` — rollup-dts тянет типы всего React-дерева и внешних
  vscode-импортов → OOM воркера. Кодоген из `export`-строк дёшев и детерминирован.
- Путь `ServicesAccessor` в шиме — 7 уровней вверх (`../../../../../../../editor/browser/editorExtensions.js`),
  т.к. `out/<entry>/` и `src/util/` на одинаковой глубине внутри `react/`.
- Watch-режим: шимы обновляются на каждый `Build success` от `tsup --watch` (экспорты меняются
  редко, но dev-`tsgo` должен совпадать с CI).

Связано: [[compileAndSync]] (`tsgo` exit 2), [[verifyGate]].
