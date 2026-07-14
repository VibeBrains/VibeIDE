# HTML/CSS language server — ESM-клиент и CJS

← [Knowledge Index](../README.md)

---

## [vscode] HTML language server — ESM-клиент и CJS `vscode-html-languageservice`

**Контекст:** `extensions/html-language-features/server` с **`"type": "module"`**; в Output — `Named export 'TokenType' not found`, цикл рестартов HTML LS.

**Суть:** для таких пакетов Node 22 резолвит CJS-бандл; **именованный** `import { TokenType } …` может не находить экспорт. **`import * as pkg`** отдаёт урезанный namespace.** Рабоче: `import pkg from '…'` при **`esModuleInterop`** и свойства **`pkg.TokenType`** / **`pkg.getLanguageService`**. Чистые типы — **`import type`**. То же для **`vscode-css-languageservice`** там, где нужны **`FileType`** и сервисы.

**Применение:** встроенные language servers VS Code/VibeIDE под Electron + Node текущего поколения.
