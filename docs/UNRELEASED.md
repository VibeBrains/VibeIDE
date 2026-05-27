# UNRELEASED — накопитель к следующему релизу

> Рабочий файл: что уже в `main` и пойдёт в ближайшие GitHub Release notes, плюс
> накопленные баги (режим «копим за день» — найдено, но НЕ чиним). Очищать при выпуске.
> Старт накопителя: **2026-05-27**.

---

## ✅ Готово к релизу (в `main`)

_Пусто — всё накопленное выпущено в **v0.13.27** (2026-05-27): `initializeModel` dir-guard,
datetime в трейсах, self-host QR. Дальше копим сюда по мере новых коммитов._

---

## 🐞 Каталог багов — найдено, НЕ чиним (копим)

Всё grounded по коду. Предложенный порядок починки: **D → C → B → A → 2 → 5**.

| # | Симптом | Где (grounded) | Класс |
|---|---|---|---|
| **C** | `grep '.*'` шёл 234 846 мс (~4 мин), подвесил extension host | `toolsService.ts:876` — у grep-поиска нет таймаута (ср. `run_command` clamp `:551`); допускает match-all паттерны | наш, высокий |
| **A** | smart-truncation петля: режет tool-результаты → модель циклит чтения, контекст растёт (`41k→…→86k`, `msgs:6` каждый ход) | `convertToLLMMessageService.ts:1916` | наш, высокий |
| **B** | `systemLen → 156`: обрезка выкидывает folded-system (тело скилла) у моделей без system-role (deepseek) | `convertToLLMMessageService.ts` (fold+truncate); guidelines пиннятся `:893`, folded-system — нет | наш, высокий |
| **D** | Промпт не говорит, что хост — VibeIDE, и не учит писать правила в `.vibe/rules.md` (только пассивный `source=` в `<workspace_guidelines>`) → модель создаёт `AI_RULES.md` / спрашивает про Cursor | `prompts.ts:273`, `convertToLLMMessageService.ts:877`; источник правил: `vibeProjectRulesService.ts:71` = `.vibe/rules.md` + `AGENTS.md` | наш, промпт |
| **2** | diff-превью `edit_file` гаснет по клику | `editCodeService.ts` / core `diffEditorWidget.ts:406` — `TextModel disposed before DiffEditorWidget reset` при mouse-down | наш |
| **5** | Ложный `(truncated after 500k)` на line-range чтении 50 строк | `SidebarChat.tsx:2585` — `hasNextPage` считается по размеру всего файла | наш, косметика |
| **6** | search-паттерн (`\.select\(`) рендерится как имя файла | UI search-слот | минор |
| **rc** | run_command: нативные exe (robocopy) / PS досиживают timeout (~18–40с), `ok:true` маскирует таймаут | `terminalToolService.ts:331` — нет `onCommandFinished` для native exe | наш |

### Не наши (провайдер / модель) — фиксировать не нужно
- minimax-m2.7 через openCode: stream stall 120с (`chatThreadService.ts:4947`) и `520` от `api.minimax.io` (origin лёг) — watchdog + ретраи отработали штатно.
- Деградация модели на 24–59 итерациях без сходимости — качество модели; по плейбуку `model-stalls.md:39` новые предохранители не плодим.

---

## ⚠️ Процессная заметка — релиз (важно)

`scripts\release-windows.ps1` **сам делает `patch += 1`** при сборке. НЕ бампить `product.json`
вручную перед запуском — иначе **двойной бамп**.
2026-05-27: ручной бамп `0.13.25 → 0.13.26` + авто-бамп скрипта → версия **0.13.26 пропущена**,
выпущена **v0.13.27**. На будущее: при `делай релиз` НЕ трогать `product.json` руками — только
обновить бейдж README после сборки под фактическую версию. Стоит поправить процедуру в `CLAUDE.md`
(шаги 1–5 «бампнуть вручную» конфликтуют с авто-бампом скрипта).

---

## 📌 В docs/knowledge при закрытии
- **Ночной renderer-OOM 2026-05-27** (машина 059-1-WS-346): heap renderer ровный ~320 МБ 4+ ч → внезапный спайк <2 мин на фоне ночного autopilot; **не** медленная idle-утечка (в отличие от инцидента 22–23 мая). Дополнить `docs/knowledge/runtime-quirks/idle-memory.md`.
- **#D / правила**: способная модель извлекает `.vibe/rules.md` из `source=`-атрибута (подтверждено транскриптом), слабая (minimax) — нет. Лечится явной инструкцией в промпте.
- **Двойной бамп релиза** (см. процессную заметку выше) — кандидат в `docs/knowledge` + правка `CLAUDE.md`.
