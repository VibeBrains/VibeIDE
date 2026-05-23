# Pre-merge audit checklist — XML tool-normalize changes

← [Knowledge Index](../README.md)

Living document. Каждый раз когда добавляешь / меняешь regex / transform в `xmlToolNormalize.ts` (или `extractGrammar.ts` partial detection), пройти по этому списку **до commit'а**. Через 6+ rounds audit-passes выявили recurring patterns — checklist mitigate'ит их before code review.

---

## [правило] Pre-merge gate

### 1. Regex literals — escape applied?

Если строишь regex из переменных tool names / params:

```ts
// ❌ Плохо — `name` может содержать `.`, `+`, `*`
new RegExp(`<${name}>...</${name}>`, 'g')

// ✅ Хорошо
new RegExp(`<${escapeRegexLiteral(name)}>...</${escapeRegexLiteral(name)}>`, 'g')
```

`escapeRegexLiteral` уже есть в `xmlToolNormalize.ts`. Применять always при building regex из data, не literal'а.

### 2. Idempotency test

`normalize(normalize(x)) === normalize(x)` для каждого нового format'а:

```ts
test('normalize(normalize(x)) === normalize(x) — <new format>', () => {
    const input = '<новый формат>';
    const once = normalizeAlternativeToolSyntax(input);
    const twice = normalizeAlternativeToolSyntax(once);
    assert.strictEqual(once, twice);
});
```

Критичная correctness property — streaming tick может вызвать normalize multiple раз в одну сессию.

### 3. Null / empty input guard

Публичный entry point должен defendiveно handle nullish:

```ts
export const normalizeFoo = (text: string): string => {
    if (!text) return text  // ← required
    // ...
}
```

TypeScript types `string` могут на runtime'е получить `undefined` из optional-chained source. Без guard'а — TypeError на `text.includes(...)`.

### 4. Test assertion — структурный, не verbatim локализуемый текст

```ts
// ❌ Плохо — breaks при локализации
assert.match(out, /tool call — formatted incorrectly/);

// ✅ Хорошо — structural shape
assert.match(out, /\*\[.+\]\*/);  // italic-markdown brackets
```

User-visible strings проходят через `localize()` и могут быть RU/EN/etc. в зависимости от UI locale. Test asserting verbatim text ломается при переводе.

### 5. Fast-path sniff включает новый wrapper marker?

Если добавил новый wrapper в `VENDOR_WRAPPER_NAMES` / `VENDOR_NAMESPACED_SUFFIXES` — `FAST_PATH_SNIFFS` derives автоматически (verified — derivation в `xmlToolNormalize.ts` через map calls).

Если же добавил **новый класс** marker'а (например, новый equivalent to `/>` или `｜`) — добавить его literal в `FAST_PATH_SNIFFS` array вручную.

### 6. Symmetric defense — где ещё применима та же transform?

Recurring класс bug'а из audit passes:

- Tolerant close на invoke → НЕ забыть на parameter
- Escape regex literal на one regex → НЕ забыть на остальные с тем же data source
- Aliases в normalize matcher → решить ОСОЗНАННО, нужны ли в safety net (asymmetry допустима, документировать)
- Self-closing handling в normalize → safety net тоже должен покрывать self-closing

Mental checklist при коде нового pattern: "Если форма X — есть ли parallel форма Y где то же transform осмыслено?"

### 7. Streaming partial behavior

Если transform применим mid-stream:

- `ALT_PARTIAL_REGEXES` покрывает partial prefix этого pattern'а?
- `findPartiallyWrittenToolTagAtEnd` срабатывает на partial → buffer'ит до full match?
- Если partial detection невозможна (например, marker arrives только в конце) — задокументировать flicker как known limitation.

### 8. Verbatim fixture от real model output

Когда incident triggers fix:

- Скопировать **дословно** model output из screenshot/log → unit-test fixture
- Привязать к дате (`test('user 2026-MM-DD screenshot — ...', ...)`)
- Этот test = regression guard на конкретный observed pattern. Future refactors не должны его сломать.

---

## [инструмент] Применение

После завершения нового fix'а перед commit:

```bash
# 1. Compile clean
npm run compile-check-ts-native

# 2. Pass через checklist выше — 8 пунктов

# 3. Идемпотентность — add тест если ещё нет

# 4. Add catalog запись в docs/knowledge/runtime-quirks/xml-tool-format-incidents.md
#    если новый observed format

# 5. Commit с conventional message
git commit -m "fix(llm): <pattern> <one-line root cause>"
```

---

## Связано

- [xml-tool-normalization.md](../architecture/xml-tool-normalization.md) — architecture overview
- [xml-tool-format-incidents.md](../runtime-quirks/xml-tool-format-incidents.md) — catalog of observed formats
- [`docs/roadmap.md`](../../roadmap.md) секция X.17 — recurring patterns meta-observation (источник этого checklist)
- [`docs/roadmap.md`](../../roadmap.md) секция X.20 — audit-pass terminal condition (когда запускать новый pass)
