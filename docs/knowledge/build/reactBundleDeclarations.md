# React-бандлы: `.d.ts`-шимы против OOM tsgo в CI

## Симптом

`core-ci` (job «Compile & Hygiene») в CI падает на `tsgo-typecheck`:

```
error TS2305: Module './react/out/sidebar-tsx/index.js' has no exported member 'mountSidebar'.
```

— и так для всех ~10 `mount*`-функций (`mountSidebar`, `mountCtrlK`, `mountVibeSettings`, …).
**Локально не воспроизводится** ни на node 24, ни на node 22.22.1 (версия CI): свежий
`node build.js` даёт корректные бандлы с экспортами, `tsgo` проходит.

## Корень

- Воркбенч-исходники импортируют собранные React-бандлы напрямую:
  `import { mountSidebar } from './react/out/sidebar-tsx/index.js'`.
- `react/**` **исключён** из `src/tsconfig.json` (`exclude`), готовых `.d.ts` рядом с бандлами нет.
- При `allowJs: true` type-checker (tsgo) вынужден **парсить сам бандл** — минифицированный ESM
  на 1.5–2.5 МБ каждый — чтобы восстановить список экспортов.
- Этот разбор **память-ёмкий**. На стеснённых по памяти раннерах (ubuntu-22.04, 2 vCPU / 7 ГБ,
  плюс `npm-run-all2 --max-parallel 2` = два тяжёлых `tsgo` одновременно) он деградирует и
  «теряет» экспорты → `TS2305`. Прямое подтверждение природы: `tsup` с `dts: true` на этих же
  входах роняет rollup-dts воркер с `ERR_WORKER_OUT_OF_MEMORY` — та же память, тот же класс.

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
