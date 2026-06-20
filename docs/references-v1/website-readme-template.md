# Website README template (out-of-tree)

> Status: scaffold for `borodatych/VibeIDE-website` (separate repo, GitHub Pages).
> Source: roadmap §889. Companion: `launch-announcement-runbook.md`.

This file is a template. Copy into a new repository (do **not** add it to the
VibeIDE source tree — `docs/` is local-only per the docs-policy contract).

---

# VibeIDE

> Privacy-first AI IDE forked from VS Code. No telemetry. Local Ollama. Typed plan/skill API.

[![Release](https://img.shields.io/github/v/release/borodatych/VibeIDE?label=release)](https://github.com/borodatych/VibeIDE/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/borodatych/VibeIDE/blob/main/LICENSE.txt)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-vibeide-blue)](https://open-vsx.org/namespace/vibeide)
[![Sponsor](https://img.shields.io/github/sponsors/borodatych)](https://github.com/sponsors/borodatych)

## Why VibeIDE

VibeIDE is a fork of VS Code with the AI / agent layer rewritten around a
privacy-first contract:

- **Zero cloud telemetry by default.** The "telemetry" service in code is a
  local audit channel for routing decisions; full policy at
  [`references/v1/telemetry-policy.md`](https://github.com/borodatych/VibeIDE/blob/main/references/v1/telemetry-policy.md).
- **Local-first AI.** First-class Ollama / LM Studio support; cloud providers
  (Anthropic, OpenAI, Gemini) are opt-in.
- **Typed extension API.** Plans, skills, constraints are first-class objects
  with a stable read API. Sample extension on Open VSX.
- **Signed builds for all four targets.** Windows EV-cert, macOS notarized
  (Universal Binary), ARM Linux.

## Download

| OS | Download |
|---|---|
| Windows x64 | [VibeIDE-x64.exe](https://github.com/borodatych/VibeIDE/releases/latest) |
| macOS Universal | [VibeIDE-mac.dmg](https://github.com/borodatych/VibeIDE/releases/latest) |
| Linux x64 | [VibeIDE.AppImage](https://github.com/borodatych/VibeIDE/releases/latest) |
| Linux ARM64 | [VibeIDE-arm64.AppImage](https://github.com/borodatych/VibeIDE/releases/latest) |

All releases are signed; verification instructions in the release notes.

## Quick start

1. Install your preferred local model: `ollama pull qwen2.5-coder:7b`.
2. Open VibeIDE — the Ollama probe runs once on first start; if Ollama is
   running, you get a "🦙 Ollama detected" notification.
3. `Ctrl+I` opens the chat sidebar. Pick a model, start typing.
4. Privacy mode: `Settings → vibeide.privacy.strict = true` blocks every
   non-allow-listed outbound call.

## Compared to alternatives

| | VibeIDE | Cursor | Copilot |
|---|---|---|---|
| Source available | ✅ MIT | ❌ closed | ❌ closed |
| Local model first-class | ✅ Ollama probe + provider picker | ⚠️ via OpenAI-compat | ❌ |
| Cloud telemetry default | ❌ none | ✅ on | ✅ on |
| Typed plan/skill API | ✅ stable | ⚠️ closed surface | ❌ |
| Signed Linux ARM build | ✅ | ⚠️ x64 only | ❌ |

## For extension authors

Build VibeIDE-specific extensions against the typed API in
`extensions/vibeide-sample`. Publish to Open VSX under the `vibeide`
namespace. See [`references/v1/openvsx-publishing-runbook.md`](https://github.com/borodatych/VibeIDE/blob/main/references/v1/openvsx-publishing-runbook.md)
for the publishing flow.

## Support the project

- ⭐ Star the [GitHub repo](https://github.com/borodatych/VibeIDE).
- 💸 [GitHub Sponsors](https://github.com/sponsors/borodatych) — recurring funding
  goes into infrastructure (signing certs, CI, build hosts).
- 💬 Join the [Discord](https://discord.gg/vibeide) — `#bugs` for issue intake,
  `#showcase` for community projects.
- 🐛 [GitHub Issues](https://github.com/borodatych/VibeIDE/issues) for tracked bugs.

## Privacy & security

- Privacy contract: `references/v1/telemetry-policy.md` (no cloud telemetry).
- Distribution signing: `references/v1/distribution-signing-runbook.md`.
- Audit log: `.vibe/audit.json` (local, append-only, redacted).

Built audit-friendly: every roadmap milestone has a discriminated-union pure
helper + tests under `src/vs/workbench/contrib/vibeide/common/`. See the
roadmap's `[~]` entries for the implementation pointers.

## License

[MIT](https://github.com/borodatych/VibeIDE/blob/main/LICENSE.txt) — fork of
[microsoft/vscode](https://github.com/microsoft/vscode) (also MIT).
