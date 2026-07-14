# IUpdateService и GitHub releases

← [Knowledge Index](../README.md)

---

## [архитектура] Обновления VibeIDE (GitHub + IUpdateService)

**Контекст:** запрос на Cursor-like UX установки (2026-05-04).

**Суть:** проверка и уведомления живут в `vibeideUpdateMainService.ts` (main) + `vibeideUpdateActions.ts` (workbench, авто через 5 с и каждые 3 ч). При активном `IUpdateService` отдаются состояния MS Code (`download`/`apply`/`restart`); при `StateType.Disabled` — сравнение GitHub `tag_name` с `product.version` / `package.json` без полноценной установки (подталкивание к reinstall/сайту).

Сравнение версий: **`semver.coerce` + `semver.gte`** после снятия префикса **`v`** с тега (тег `v1.0.0` vs продукт `1.0.0` больше не ломает проверку); неразборчивый remote-тег трактуется как up-to-date (без ложных «есть обновление»).

Полный сценарий «скачать → quit → updater ждёт PID → silent install → restart» в `.vibe/plans/vibeide-cursor-like-updates.plan.md`.

**Применение:** не дублировать логику проверки на renderer; расширять main и IPC; релизные артефакты именовать предсказуемо + checksums.
