# UNRELEASED — накопитель к следующему релизу

> Рабочий файл: что уже в `main` и пойдёт в ближайшие GitHub Release notes, плюс
> накопленные баги. Очищать при выпуске. Полный grounded-каталог дня — `docs/roadmap.md` → **O.25**.

---

## ✅ Готово к релизу (в `main`) — войдёт в v0.13.28

| Commit | Изменение | Секция release-notes |
|---|---|---|
| `09259827` | **#D** — промпт: идентичность VibeIDE + инструкция писать правила в `.vibe/rules.md` (не `AI_RULES.md`/`.cursorrules`) | 🐛 Исправления |
| `1607e31f` | **#C** — `grep`: отбой match-all паттернов + жёсткий cancel поиска на 15с (был фриз EH ~234с) | 🐛 Исправления |
| `01624d33` | **#5/#6** — ложный `(truncated 500k)` на line-range убран; `search_in_file` показывает файл, а не паттерн | 🐛 Исправления |

_Релиз 0.13.27 (initializeModel dir-guard, datetime-трейс, self-host QR) уже выпущен._

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
- Ночной renderer-OOM 2026-05-27 (059-1-WS-346): heap renderer ровный ~320 МБ 4+ ч → спайк <2 мин при autopilot; **не** idle-leak. → `docs/knowledge/runtime-quirks/idle-memory.md`.
- #D / правила: способная модель извлекает `.vibe/rules.md` из `source=`-атрибута, слабая — нет; вылечено явной инструкцией (`09259827`).
