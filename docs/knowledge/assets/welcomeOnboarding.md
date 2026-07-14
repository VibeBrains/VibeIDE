# Welcome онбординг

← [Knowledge Index](../README.md)

---

## [ux] Лого и копирайт welcome-онбординга (React)

**Контекст:** экран первого запуска грузится из `VoidOnboarding.tsx` (bundled `buildreact`), не из VS Code NLS.

**Суть:** герой-картинка — `FileAccess.asBrowserUri('vs/workbench/browser/media/vibeide-main.png')`; этот файл нужно синхронизировать с эталоном **`references/logo-final.png`** при смене брендинга (`cp` или замена ресурса). Тексты на экране — литералы в TSX до появления полноценного nls в этом дереве React.

**Применение:** после смены лого или перевода — **`npm run buildreact`**.
