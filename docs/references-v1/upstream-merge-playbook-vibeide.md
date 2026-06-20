# Upstream merge playbook — `product.json` / `package.json` (VibeIDE)

**Goal:** After merging `microsoft/vscode` (or CortexIDE baseline), restore fork-specific identity and distribution knobs without losing upstream fixes.

## `product.json` — verify / restore

| Area | VibeIDE expectation | Typical upstream drift |
|------|---------------------|------------------------|
| Names | `nameShort` / `nameLong` / `applicationName` / `win32*` labels → **VibeIDE** | Reverted to Code OSS strings |
| Data dirs | `dataFolderName`, `sharedDataFolderName`, `serverDataFolderName`, `urlProtocol` → **`.vibeide`** / **`vibeide`** | Microsoft `.vscode` paths |
| Locale | `defaultLocale` → **`ru`** (product choice) | Often `en` |
| Gallery | `extensionsGallery` → **Open VSX** URLs | Marketplace endpoints |
| Trusted links | `linkProtectionTrustedDomains` includes **`vibeide.io`**, **`VibeIDETeam`** GitHub | MS domains only |
| Themes onboarding | `onboardingThemes` pins **Vibe Neon** (`vibe-neon`) | Default VS themes only |
| Built-ins | `builtInExtensions` list / hashes — align with **`product.json` in main** after upstream bump | Missing vibe-specific extensions |
| Update service | Auto-update URL / release notes → **VibeIDETeam/VibeIDE** (see `cortexideUpdateMainService` / product wiring) | MS update endpoints |
| Remote debugging | **`disableRemoteDebugging`** (or equivalent in merged schema) must stay **enabled for production** per roadmap Phase 1 | Upstream dev defaults |

**Process:** merge upstream → `git diff HEAD~1 -- product.json` → walk table → run `npm run compile` → smoke launch.

## `package.json` (repository root)

| Area | Watch |
|------|--------|
| `name`, `version` | Keep **VibeIDE** naming policy / versioning rules |
| Scripts | Preserve **`vibe:*`** scripts added under `scripts/` |
| Dependencies | Upstream may add packages — re-run **`npm install`**; watch native modules / Electron alignment |
| Overrides / patches | Directory **`patches/`** + `package.json` `patchedDependencies` — re-apply after lockfile conflict resolution |

## Extensions workspace (`extensions/**`)

See **`references/v1/extensions-lockfile-policy.md`** — lockfile strategy and CI expectations after upstream sync.

## Quick validation after merge

1. `npm run compile` (or CI equivalent).
2. Grep branding slips: `code-oss`, `Visual Studio Code` in **user-visible** `product.json` fields.
3. Optional: `node scripts/vibe-doctor.js --ci` in a workspace with `.vibe/`.
