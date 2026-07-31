# OpenRouter frontier-модели: LongCat-2.0, Inkling + мультимодельный security-скан

← [Knowledge Index](../README.md)

---

## [квирк] LongCat-2.0 (Meituan) — плавающее число активных параметров + двойная API-совместимость

**Контекст:** дайджест 21.07.2026, кандидат в BYOK-провайдеры через OpenRouter. Проверено fetch'ем страницы OpenRouter + вторичными обзорами (MarkTechPost, TestingCatalog).

**Суть:**
- Slug OpenRouter — `meituan/longcat-2.0` (на OpenRouter тестировался как «Owl Alpha»).
- Sparse MoE 1.6T total, **~48B активных с ДИНАМИЧЕСКИМ окном 33B–56B на токен** (не фиксированная стоимость) — переменная латентность/цена на длинном контексте. Механизм LongCat Sparse Attention (LSA), близкое к линейному масштабирование по длине.
- Контекст **1M** нативно. Streaming (SSE) есть.
- **Native tool-calling доступен через ДВА формата — OpenAI-совместимый И Anthropic-совместимый** эндпоинты. При настройке провайдера выбрать `protocol` осознанно.
- Цена OpenRouter на момент проверки: input **$0.30/1M**, output **$1.20/1M** (действовала скидка 60%).

**Применение:** в `.vibe/providers.json` — обычный провайдер через `baseURL` OpenRouter + auth, `contextWindow: 1000000`. При переменной латентности на 1M-контексте не считать стоимость/тайминг фиксированными. Если поведение tool-call формата отклоняется — правило в `resources/model-quirks.json` (`forceToolCallFormat`).

**Не проверено:** формат `tool_calls` в стриминге; max-output через OpenRouter (128K заявлен только для родного API longcat.chat/platform/docs).

**Связано:** [[llmProxyDispatcher]], `common/vibeProvidersFile.ts`, `common/modelQuirks/modelQuirksTypes.ts`.

---

## [квирк] Thinking Machines Inkling — reasoning-effort как драйвер стоимости

**Контекст:** тот же дайджест, кандидат в провайдеры. Проверено fetch'ем OpenRouter + вторичными источниками (Raschka, Artificial Analysis).

**Суть:**
- Slug — `thinkingmachines/inkling`. Open-weight мультимодальная MoE, 41B активных из 975B, контекст **1M (1 048 576)**.
- Цена OpenRouter: input **$1.00/1M**, output **$4.05/1M** (≈3× дороже LongCat).
- **Квирк, критичный для конфига:** параметр **reasoning effort 0.2–0.99** управляет числом reasoning-токенов до ответа. Все офиц. эвалы прогнаны на effort 0.99 / temp 1.0. Высокий дефолтный effort раздувает output-стоимость (и так вчетверо дороже input). Дефолт задавать осознанно.
- Native tool-use с заявленным tool-call recovery.

**Применение:** провайдер через OpenRouter `baseURL`. Зафиксировать дефолтный reasoning-effort в конфиге/quirks под целевой бюджет, а не оставлять 0.99.

**Не проверено первоисточником:** SWE-bench Verified 77.6% (вторичные обзоры, не страница TM); точный формат tool-calling и факт стриминга на OpenRouter.

---

## [правило] Один LLM ненадёжен для security-скана диффа → ансамбль провайдеров

**Контекст:** статья techxplore (07.2026) реферирует рецензируемое исследование в *International Journal of Applied Cryptography* (Kouliaridis et al., 2026) — 11 LLM на Android/IoT/смарт-контрактах.

**Суть:**
- Подтверждено цитатами: «no single system consistently outperforms its rivals», «current LLMs remain unsuitable as universal vulnerability detectors». Причины — устаревшие данные обучения + галлюцинации. Статья доказывает **проблему**, ансамбль сама не тестировала.
- Ансамбль помогает (рецензируемо, arXiv 2509.12629 «Ensembling LLMs for Code Vulnerability Detection»): «ensemble approaches can significantly improve detection» за счёт комплементарности архитектур (разные модели ошибаются по-разному).
- Практические паттерны мержа находок: majority voting + порог согласия (k-review: дифф → 6 параллельных проходов Claude/GPT/Gemini → голосование → пост-валидация трассировкой); confidence-weighting по числу согласных (calimero); LLM-агрегатор-арбитр вместо механического голосования (Multi-Review / mozilla.ai Star Chamber); дедуп по строке («comment blending»).

**Применение:** `codeReviewService.ts` сейчас single-model. Для security-категории — прогонять 2–3 провайдера параллельно и мержить (majority vote/порог + дедуп по строке); фундамент (line-anchored аннотации, множество провайдеров, оркестрация) уже есть. Оформить как отдельный security-skill.

**Связано:** `common/codeReviewService.ts`, `common/vibeSkillsLibraryService.ts`.
