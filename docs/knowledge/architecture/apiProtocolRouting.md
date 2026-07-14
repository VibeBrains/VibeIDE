# AI SDK adapter routing (v0.12.4)

Контекст: VibeIDE использует Vercel AI SDK для общения с LLM. У каждой модели может быть **разный wire-protocol** (Anthropic Messages, OpenAI chat-completions, Google Gemini, openai-compatible как универсальный fallback). Выбор SDK адаптера — НЕ hardcoded; data-driven.

## Источники данных для routing-решения

В порядке убывающего приоритета (первый matched wins):

1. **User override:** `ModelOverrides.apiProtocol` (per-model в settings)
2. **models.dev catalog:** lookup по `(baseURL, modelName)` через `getModelSdkNpm()`
3. **Fallback:** `@ai-sdk/openai-compatible` (works for ~80% of providers)

`aiSdkAdapter.ts:605-624`:

```typescript
const apiProtocolOverride = overridesOfModel?.[providerName]?.[modelName_]?.apiProtocol;
const sdkNpmFromOverride = apiProtocolOverride 
    ? API_PROTOCOL_TO_SDK_NPM[apiProtocolOverride] 
    : undefined;
const sdkNpm = sdkNpmFromOverride ?? await getModelSdkNpm(baseURL, modelName);
```

## Single source of truth — `API_PROTOCOL_VALUES`

`modelCapabilities.ts:240-275`. **One const, three usages**:

```typescript
export const API_PROTOCOL_VALUES = ['openai-compat', 'openai', 'anthropic', 'google'] as const;
export type ApiProtocolOverride = typeof API_PROTOCOL_VALUES[number];

export const API_PROTOCOL_TO_SDK_NPM: Record<ApiProtocolOverride, string> = {
    'openai-compat': '@ai-sdk/openai-compatible',
    'openai': '@ai-sdk/openai',
    'anthropic': '@ai-sdk/anthropic',
    'google': '@ai-sdk/google',
};
```

Все три потребителя берут из этого const'а:
- `aiSdkAdapter.ts` — routing mapping
- `Settings.tsx` — dropdown options + JSON validator
- `Settings.tsx` — UI hint text

`Record<ApiProtocolOverride, ...>` mapped type заставит TS fail-loud если новое значение добавлено в array но не в map → не дать silent breakage.

## Добавление нового SDK адаптера — checklist

1. `npm install @ai-sdk/<name>`
2. Добавить в `API_PROTOCOL_VALUES` array (+ TS-enforced mapping в `API_PROTOCOL_TO_SDK_NPM`).
3. Добавить branch в SDK selection ternary в `aiSdkAdapter.ts:619+`:
   ```typescript
   : sdkNpm === '@ai-sdk/<name>' 
       ? create<Name>SDK({ baseURL, apiKey, headers, fetch })(modelName)
       : ...
   ```
4. Compile check — TS ловит missing map entry.
5. Test через models.dev catalog OR explicit `apiProtocol` override.

## Adapter quirks

| SDK | Quirk |
|---|---|
| `@ai-sdk/anthropic` | Headers `anthropic-beta: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`. Без них tool_use stream приходит в coarse-format → minimax-style модели генерят degenerate output (numeric tool names, empty params). |
| `@ai-sdk/openai` | `.chat()` shape — chat-completions endpoint. **Не** `.responses()` (новый Responses API), мы его не wire'или вниз по pipeline. |
| `@ai-sdk/google` | Tool format — `functionDeclarations` / `functionCall`. SDK конвертит внутри, но native Gemini provider (`sendGeminiChat` в `sendLLMMessage.impl.ts:1681`) НЕ мигрирован — это отдельная задача с своим test plan. |
| `@ai-sdk/openai-compatible` | Default fallback. Strip'ит unknown fields — провайдер-специфика (logprobs, parallel_tool_calls) может теряться. |

## Когда юзер должен использовать `apiProtocol` override

- models.dev catalog mis-classifies модель (rare, но happens — aggregator added a model то которое не в community registry).
- Корпоративная сеть блокирует `models.dev/api.json` fetch → fallback на openai-compatible неверен для Anthropic-протоколизованной модели → set `apiProtocol: "anthropic"` вручную.
- A/B testing: проверить, какой adapter лучше работает с конкретной моделью.

UI: Settings → Models → конкретная модель → "Override defaults" toggle → **dropdown "apiProtocol"** (default = use models.dev catalog).

## Diagnostic

`aiSdkAdapter.ts:619`: `console.debug` once per `(providerName, modelName, sdkNpm, source)` combo. Deduped в module-level `_loggedSdkSelections: Set<string>`. Видно в DevTools при включённом debug-level.

`getCatalogStatus()` (IPC к main-process) — что catalog показывает: `loaded_from_network` / `loaded_from_local` / `failed`.

## Что НЕ делаем

- **`@ai-sdk/alibaba`** — пакет не существует на npm (verified 2026-05-20). Roadmap P.1 text был спекулятивным. Qwen-DashScope доступен через openCode-zen aggregator → openai-compatible.
- **Migrating `sendGeminiChat` to `@ai-sdk/google`** — требует переписки tool-call format, Gemini API key для интеграционного теста. Отдельная задача.
