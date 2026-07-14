# Path и URI ловушки

← [Knowledge Index](../README.md)

`validateURI` на Windows + UTF-8 BOM в settings.json.

---

## [vscode] validateURI (`toolsService`) — абсолютный путь на Windows без `:///`

**Контекст:** `get_dir_tree` и любой tool с `uri` строкой без схемы; ошибка `Unable to resolve` с `fsPath` вида `D:\...\Repo\D:\...\Repo`.

**Суть:** нельзя считать путь «относительным к workspace», если только `!uriStr.startsWith('/')`: на Windows абсолютный путь `D:\...` не начинается с `/`. Тогда ошибочно вызывается `joinPath(workspaceRoot, uriStr)` — путь склеивается дважды. Нужно `isAbsolute` из **`vs/base/common/path.js`** (как **`pathIsAbsolute`** рядом с **`joinPath`**).

**Применение:** правки **`validateURI`** в **`toolsService.ts`** и любые аналогичные резолверы путей для LLM/tool params.

---

## [vscode] MCP migration + `settings.json` с UTF-8 BOM (code-oss-dev)

**Контекст:** в DevTools консоли OSS — **`MCP migration: Failed to parse ... settings.json: Unexpected token 'я╗┐'`** (символы — это **BOM** EF BB BF в UTF-8).

**Суть:** файл **`%APPDATA%\\code-oss-dev\\User\\settings.json`** (или путь из лога `vscode-userdata:...`) сохранён как **UTF-8 with BOM**; встроенный **`JSON.parse`** падает на первом символе. Исправление: пересохранить **UTF-8 без BOM** или убрать первые три байта `EF BB BF`.

**Применение:** после любого редактирования настроек редактором, который по умолчанию пишет BOM (часть Windows-редакторов / «Save with encoding»).
