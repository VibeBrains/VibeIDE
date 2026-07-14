# `IEditorService.openEditor` — единственный путь

← [Knowledge Index](../README.md)

---

## [правило] `IEditorService.openEditor` — единственный способ открывать редакторы

**Контекст:** правило уже зафиксировано в `CLAUDE.md`, но конкретный симптом стоил отладки. Toggle настроек VibeIDE использовал `editorGroupService.activeGroup.openEditor(input)` — при заблокированной активной группе (например, чат-группа в editor-area) `EditorPane.createEditor` частично рендерил DOM в чужой группе **до** перенаправления, оставляя «прилипший» лайаут поверх соседнего таба до клика по нему.

**Суть:** `activeGroup.openEditor(...)` — прямой вызов, игнорирует lock и стандартную маршрутизацию. `IEditorService.openEditor(...)` сам выбирает целевую группу с учётом блокировки и не создаёт pane в чужом DOM.

**Применение:** в любом Action `run(accessor)`, открывающем VibeIDE-input, использовать только `editorService.openEditor(input)`. Если видишь `accessor.get(IEditorGroupsService)` рядом с `.openEditor(` — почти всегда это баг.
