# Vibe Agents — vision-маршрутизация ролей (картинка → роль на vision-модели)

**Задача.** «Скинул субагенту картинку + разбери ошибку» → система сама отдаёт изображение роли на vision-модели (дизайнер), та разбирает и передаёт текстовый вывод кодерам (которые могут быть на сильной, но слепой модели).

**Ветка/коммиты:** `next`, `27ebd40f` (звено 2) → `663c2f86` (1) → `1790d6fd` (3) → `ec30e3a2` (4) → `825c16b9` (5).

## Что было сломано (до фичи)

1. **Маршрутизация чисто текстовая** (`vibeAgentRoutes.ts` — regex по промпту). Картинка на входе не детектилась.
2. **Картинка не долетала до субагента вообще** — вход раннера был `goal: string` (см. `SubagentHandoff`/`SubagentRunRequest`). Даже если дизайнер в маршруте — изображения он не получал.
3. **Модель на роль — вручную**, без проверки vision. На роль с картинкой могла встать слепая модель → тихая потеря / галлюцинации.

Фундамент vision в проекте БЫЛ, но не подключён к роутеру: `supportsVision` на моделях, `modelVisionHeuristics.ts`, `vibeProviderCapabilityService.vision`, `getModelCapabilities`.

## Решение — 5 звеньев (снизу вверх)

- **Звено 2 (фундамент):** `SubagentHandoff.images?`/`SubagentRunRequest.images?` (переиспользуют `ChatImageAttachment` из чата). Раннер кладёт их в `images` первого user-сообщения → `prepareLLMChatMessages` base64-кодирует в image-парты **как для основного треда** — новой логики нет. Без этого звена остальные бесполезны.
- **Звено 1 (маршрут):** `buildRoute(text, {hasImages})` при картинке продвигает `designer` в ведущий solo-этап (дедуп) и отдаёт `route.imageSink`. Оркестратор `executeRoute({images})` доставляет картинку ТОЛЬКО роли-`imageSink` (первичный спавн; durable-resume не хранит блобы).
- **Звено 3 (гарантия):** раннер — если роль получила картинку, а её модель не `supportsVision`, подмена на vision-совместимую из включённых (+info-нотис); нет vision-модели → warn.
- **Звено 4 (дефолт):** флаг `receivesImages` на пресете (дизайнер) — роль-vision-сток при незаданной пользователем модели и не-vision модели чата по умолчанию берёт vision-модель (vision-ready ещё до картинки; явный выбор уважается). Бейдж «🖼 картинки» в модалке «Роли».
- **Звено 5 (вход):** `VibeModalOptions.imageInput` → `VibeModalSimple` рендерит скрепку + drag-drop + paste + чипы (переиспользует `useImageAttachments`); `showModal` возвращает `images`. Route-модалка прокидывает их в `executeRoute`.

## Грабли / решения

- **DRY решения о vision:** логика «видит ли модель картинки» жила приватно в `chatThreadService._isModelVisionCapable` И частично в `visionModelHelper`. Вынесена в общий `isModelVisionCapable(modelSelection, capabilities?)` в `common/modelVisionHeuristics.ts` (catalog `supportsVision` → провайдерное знание → name-эвристика). `chatThreadService` теперь делегирует — image-attach-гейт чата и фолбэк раннера не разъезжаются.
- **`getModelCapabilities().supportsVision` часто `undefined`** — он не полное решение; провайдерные эвристики (Gemini all, Anthropic 3.5/4, GPT-4o, MiniMax-M3 vs M2) обязательны как фолбэк.
- **Бандл модалки:** Tailwind в бандле `VibeModalSimple` генерит только text-size/color-утилиты; layout/border/`grid-cols-[...]`/`w-full` НЕ собираются → разметку контента модалок (напр. `AgentRoleModels`) делать инлайн-стилями по `--vscode-*` токенам, не Tailwind-классами.
- **`<select>` в модалке:** `@@vibe-themed-select` полагается на `appearance: base-select` (Chromium 132+), не поддерживаемый рантаймом → нативный белый select на macOS. Лечится `appearance: none` + инлайн фон/бордер/радиус из input-токенов + свой data-URI шеврон.
- **Ограничение звена 5:** вложения не переживают round-trip под-модалки «Роли» (каждый `showModal` = новый `VibeModalSimple`). Промпт/лимиты переживают (их SidebarChat передаёт обратно), картинки — нет. Основной поток attach→Запустить не затронут. Для персистентности нужен `initialImages` в опциях + сидинг хука.
