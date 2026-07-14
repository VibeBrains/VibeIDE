# VibeIDE Codebase Guide

This guide orients you to key areas changed or added for VibeIDE.

- Workspace agent hints: **AGENTS.md** + **.vibe/rules.md** — see `vibeProjectRulesService.ts`
- Product metadata: `product.json`
- Icon generation (macOS): `./scripts/create-vibeide-icons.sh`
- Linux packaging templates: `resources/linux/code.desktop`, `code-url-handler.desktop`, `code.appdata.xml` (substituted at build — see Debian/Snap RPM templates)
- Optional launcher wrappers: `scripts/vibeide.{bat,sh}` → `code.{bat,sh}` (same folder); `vibeide-server*`, `vibeide-web*` → `code-server` / `code-web`
- Provider configs: `resources/provider-config.example.json`
- LLM wiring: `src/vs/workbench/contrib/vibeide/*/llm*` (providers, settings, services)
- Settings UI: `src/vs/workbench/contrib/vibeide/browser/vibeideSettingsPane.ts`
- Chat and sidebar: `src/vs/workbench/contrib/vibeide/browser/sidebar*`

Note: Some internal identifiers may still use the `void` namespace in type names and React CSS prefix (`void-`) for backward compatibility; the workbench contrib folder is **`vibeide`**.
