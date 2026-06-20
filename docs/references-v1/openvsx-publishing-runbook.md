# Open VSX publishing runbook

> Status: operator runbook.
> Source: roadmap §1124 (Open VSX category VibeIDE + промо).
> Pure validator: `src/vs/workbench/contrib/vibeide/common/openVsxManifestValidator.ts`.
> Workflow: `.github/workflows/openvsx-publish.yml`.

## Why Open VSX (not MS Marketplace)

VibeIDE is a fork; using the Microsoft VS Code Marketplace from a fork
violates the marketplace ToS (it is gated to "Visual Studio Code" and its
official derivatives). **Open VSX (https://open-vsx.org)** is the
open-source, vendor-neutral marketplace operated by the Eclipse Foundation
and is the canonical store for VS Code-compatible IDEs.

## One-time setup (operator)

### 1. Eclipse Foundation Account

1. Sign up: https://accounts.eclipse.org/user/register
2. Sign the Eclipse Contributor Agreement (ECA): https://accounts.eclipse.org/user/eca
   (no fee; ID-document upload not required for ECA-only).

### 2. Open VSX namespace

1. Sign in: https://open-vsx.org → "Log In" (uses Eclipse account).
2. Generate an access token: Profile → Access Tokens → Create new token.
   Copy the token immediately — it is shown only once.
3. Claim the `vibeide` namespace: https://open-vsx.org/admin → request
   namespace ownership. The publisher field in every extension manifest
   must match this namespace.

### 3. Add token to repo secrets

```
gh secret set OPEN_VSX_TOKEN --body '<paste-the-token>'
```

Or via GitHub web UI: Settings → Secrets and variables → Actions → New
repository secret → name `OPEN_VSX_TOKEN`.

## Publishing flow

### Pre-publish: manifest validation

Every PR that touches `extensions/vibeide-*/package.json` runs the
`openvsx-publish` workflow's validate job. It mirrors the rules from
`openVsxManifestValidator.ts`:

- `name`, `displayName`, `publisher`, `description`, `version` (SemVer),
  `license` (SPDX), `engines.vscode` (with prefix), `repository` are
  required.
- Categories must come from the Open VSX standard set; non-standard names
  (e.g. `VibeIDE`) get a warning and file under `Other`.

Run locally before pushing:

```powershell
node -e "const m = JSON.parse(require('fs').readFileSync('extensions/vibeide-sample/package.json', 'utf8')); const { validateOpenVsxManifest, describeValidationResult } = require('./out/vs/workbench/contrib/vibeide/common/openVsxManifestValidator.js'); console.log(describeValidationResult(validateOpenVsxManifest(m)));"
```

(Requires `npm run compile-build` first so the .js exists under `out/`.)

### Publish: workflow_dispatch

1. Repo → Actions → openvsx-publish → "Run workflow".
2. Pick the extension folder (default `vibeide-sample`).
3. Dry-run first: `dry_run = true`. Verifies packaging without actually
   pushing to the registry.
4. After dry-run passes, re-run with `dry_run = false` to publish.

The workflow installs `ovsx` CLI, packages the extension via
`@vscode/vsce package`, then runs `ovsx publish <file>.vsix` with the
`OVSX_PAT` env var.

## Custom category "VibeIDE"

Open VSX uses a fixed category list (same as MS Marketplace plus a few
extensions). To register a custom **VibeIDE** category for IDE-specific
extensions:

1. Open an issue at https://github.com/eclipse/openvsx requesting a new
   category. Justify with use case (extensions that target VibeIDE-specific
   APIs, e.g. the proposed `vibeideReadonly` namespace from §877).
2. Until accepted, extensions list a standard category (e.g. `Other`)
   plus a `keywords` entry containing `vibeide` so users can find them
   via search.

## Promotion

Once `vibeide-sample` is published:

1. Add a "Available on Open VSX" badge to the extension's README:
   `[![Open VSX](https://img.shields.io/open-vsx/v/vibeide/vibeide-sample)](https://open-vsx.org/extension/vibeide/vibeide-sample)`.
2. Add a link in the main repo README under "Extensions": e.g.
   "Build extensions for VibeIDE — see `extensions/vibeide-sample` and
   the Open VSX category".
3. Announcement coverage: include the Open VSX listing in the public
   launch (see `references/v1/launch-announcement-runbook.md`).

## Sample extensions to publish (priority order)

1. **`vibeide-sample`** — minimal acceptance proof. Always first.
2. **`vibeide-neon`** — palette of agent commands. Already in repo.
3. **`vibeide-plan-dashboard`** — when L.3 dashboard ships.
4. **`vibeide-language-pack-ru`** — when §521 VSIX zip step lands
   (currently skeleton awaits `npm install @vscode/vsce`).

## Acceptance gate for §1124

- [x] Manifest validator + tests landed.
- [x] Pre-publish CI workflow (validate on every PR).
- [x] `vibeide-sample/package.json` has `repository` / `bugs` / `homepage`.
- [ ] Eclipse Foundation account + ECA signed (operator).
- [ ] Open VSX namespace `vibeide` claimed (operator).
- [ ] `OPEN_VSX_TOKEN` added to repo secrets (operator).
- [ ] First successful workflow_dispatch run (`dry_run=true` then `false`).
- [ ] Sample listing visible at `https://open-vsx.org/namespace/vibeide`.
- [ ] (Optional) Custom category accepted by Open VSX maintainers.
