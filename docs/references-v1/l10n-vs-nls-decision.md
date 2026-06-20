# `nls.localize()` vs `vscode.l10n.t()` — chosen path

> Status: normative.
> Source: roadmap §515 (`@vscode/l10n` modern API research).
> Decision: stay on **`nls.localize()`** for in-tree workbench code; use
> **`vscode.l10n.t()`** only inside extensions under `extensions/`.

## Background

VS Code 1.73+ introduced `vscode.l10n.t()` as a more ergonomic API for
extension localization. It loads bundles from a `package.json:l10n` directory
and is the documented choice for marketplace extensions.

`nls.localize()` (and `localize2()`) is the workbench-internal API that
relies on the gulp `nls` task at build time and is what the
`workbench.desktop.main.js` bundle understands.

## Decision: split by code location

| Location                                        | API to use            | Why                                              |
|-------------------------------------------------|-----------------------|--------------------------------------------------|
| `src/vs/workbench/contrib/vibeide/**`           | `nls.localize`/`2`.   | Lives inside the bundled workbench; the build's gulp `nls` task is the source of truth. Migration to `l10n.t` would require a second build path and confuse the workbench bundle. |
| `extensions/vibeide-*/**`                       | `vscode.l10n.t`.      | Extensions are independent VSIX packages with their own `package.json:l10n`. Marketplace tooling expects this API. |
| `src/vs/workbench/contrib/vibeide/browser/react/**` | Prop-injected bundle. | React tree is bundled by `tsup`; neither `nls` nor `l10n.t` is available at runtime. Use the existing `vibeSettingsRu` style prop pattern. |

## Rationale for not migrating workbench code

1. The gulp `nls` task is wired into `npm run compile-build` and the language
   pack VSIX builder (`bin/vibe-language-pack-build.mjs`); migration would
   require reworking both.
2. `vscode.l10n.t` requires `vscode` runtime — it isn't available in pure
   helpers under `common/`. Workbench code routinely imports pure helpers,
   so the `nls` import is a stable choice.
3. `nls.localize2` already provides a tuple shape (`{value, original}`) that
   command palette infrastructure consumes; there is no equivalent in
   `l10n.t`.

## Action items

- [x] Decision recorded (this document).
- [x] In-bundle React strings: continue using prop-injected bundle (`vibeSettingsRu`, `vibeOnboardingRu`).
- [x] Extensions under `extensions/vibeide-*`: `vscode.l10n.t` adopted with `package.json:l10n` + `l10n/bundle.l10n[.<locale>].json` bundles (vibeide-plan-dashboard, vibeide-sample). File headers reference this decision.
- [ ] Periodic re-evaluation: if VS Code ships a unified API in a future
  major release, revisit this decision.

## Adoption check

`scripts/scan-vibeide-i18n.mjs` accepts both `localize()`, `localize2()`,
`l10n.t()`, and `nls.localize()` as wrapped forms — so authors using either
API in the appropriate scope are not flagged.
