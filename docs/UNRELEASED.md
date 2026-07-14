# UNRELEASED — накопитель к следующему релизу

> Рабочий файл: что уже в `main` и пойдёт в ближайшие GitHub Release notes, плюс
> накопленные баги. Очищать при выпуске. Полный grounded-каталог дня — `docs/roadmap.md` → **O.25**.

---

## ✅ Готово к релизу

_Пусто — всё накопленное выпущено. Дальше копим сюда по мере новых коммитов._

- **v0.13.28** (2026-05-27): #C (grep guard + 15s cancel), #5/#6 (read-label / search-header), #D (агент знает VibeIDE) + команды `/rule` и «Открыть правила», **Chat Run Timeline** + индикатор сжатия контекста, фикс рендера таймлайна (`fa40c8a3`).
- **v0.13.27**: initializeModel dir-guard, datetime-трейс, self-host QR.

---

## 🐞 Осталось — дефер (core-fragile), полный спек в roadmap **O.25**

| # | Симптом | Где |
|---|---|---|
| **A** | smart-truncation петля: режет tool-результаты → модель циклит чтения | `convertToLLMMessageService.ts:1916` |
| **B** | `systemLen → 156`: обрезка выкидывает folded-system у моделей без system-role | `convertToLLMMessageService.ts:877/:1916` |
| **#2** | diff-превью `edit_file` гаснет по клику (`TextModel disposed before DiffEditorWidget reset`) | `editCodeService.ts` / `diffEditorWidget.ts:406` |
| **rc** | run_command native-exe досиживает timeout, `ok:true` маскирует | `terminalToolService.ts:331` |

Не наши (провайдер/модель): minimax stall 120с + `520` от openCode; деградация модели на длинных прогонах. Не чиним.

---

## ⚠️ Процессная заметка — релиз

`scripts\release-windows.ps1` **сам делает `patch += 1`** при сборке. НЕ бампить `product.json`
вручную перед запуском — будет двойной бамп (2026-05-27: ручной `0.13.25→0.13.26` + авто → `0.13.26`
пропущена, вышла `0.13.27`). При «делай релиз» `product.json` руками не трогать; бейдж README
синхронизировать после сборки под фактическую версию. Кандидат на правку процедуры в `CLAUDE.md`.

---

## 📌 В docs/knowledge при закрытии
- Ночной renderer-OOM 2026-05-27 (059-1-WS-346): heap renderer ровный ~320 МБ 4+ ч → спайк <2 мин при autopilot; **не** idle-leak. → `docs/knowledge/runtimeQuirks/idleMemory.md`.
- #D / правила: способная модель извлекает `.vibe/rules.md` из `source=`-атрибута, слабая — нет; вылечено явной инструкцией (`09259827`).
