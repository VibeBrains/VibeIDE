# vibe doctor

← [Knowledge Index](../README.md)

`scripts/vibe-doctor.js` — локальные предупреждения перед работой и аудит.

---

## [инструмент] vibe doctor — устаревшие `.vibe/agent-locks.json`

**Контекст:** roadmap § B.2 TTL для advisory locks.

**Суть:** **`scripts/vibe-doctor.js`**, предупреждение **`agent-locks-stale`**: если есть **`.vibe/agent-locks.json`**, парсинг JSON и проверка полей **`until`** (ISO) на истечение; невалидный **`until`** тоже в предупреждение. Формат записей — объект, массив или массив в **`locks`**.

**Применение:** локально перед работой multi-session или после экспериментов с locks.

---

## [инструмент] vibe doctor — `.vibe/plans/` footprint (`plans-folder-footprint`)

**Контекст:** roadmap § E — квота диска и «застрявшие» статусы планов.

**Суть:** **`node scripts/vibe-doctor.js --full`**, проверка **`plans-folder-footprint`**: суммарный размер дерева **`.vibe/plans`**, предупреждение при **≥25MB**, при **`status: failed`** в YAML любого **`*.plan.md`**, при **>2** планах со **`status: running`**.

**Применение:** периодический аудит перед коммитом тяжёлых артефактов в планы.
