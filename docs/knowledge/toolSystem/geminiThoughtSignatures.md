# Подписи мыслей Gemini 3

**Домен:** toolSystem · **Дата:** 2026-09-15

---

## 1. Требование

Gemini 3 подписывает рассуждение, стоящее за вызовом функции, и ждёт подпись на этом вызове в следующем ходу.
Документация: «MUST always resend all thought blocks» (ai.google.dev/gemini-api/docs/thinking).
Без подписи:
- OpenAI-совместимый слой Google отвечает 400 `Missing required field 'thought_signature'` (по отчётам пользователей)
- `@ai-sdk/google` сам подставляет заглушку и пишет предупреждение — запрос проходит, но деградированно

---

## 2. Как у нас

История собирается из нашего треда, а не из ответа вендора, поэтому подпись теряется, если её не сохранить.
Путь подписи:
- родной `sendGeminiChat`: из части ответа с `functionCall` (`signatureOfFunctionCallParts`)
- `@ai-sdk/google`: из `providerMetadata.google.thoughtSignature` части `tool-call`
- ход ассистента в треде хранит `thoughtSignature: { toolCallId, signature }`
- сборка истории кладёт её на `tool_use` этого вызова, дальше на `functionCall` или в `providerOptions.google`

**Грабля:** `prepareMessages_anthropic_tools` переписывает массив на месте — подпись ассистента нужно отложить до замены его сообщения.

**Грабля:** поле в блоке `tool_use` у Anthropic может дать 400 после смены модели в треде.
Поэтому подпись снимается в главном процессе (`withoutThoughtSignatures`) для всех моделей без квирка `roundtripThoughtSignature`.

---

## 3. Не покрыто

OpenAI-совместимые маршруты Gemini (через OpenRouter или совместимый слой Google) несут подпись другим форматом
(`extra_content.google.thought_signature`, у OpenRouter — `reasoning_details`) и здесь не проводятся.
Живой смоук не прогнан: нет ключа Gemini.
