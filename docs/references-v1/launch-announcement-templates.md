# Launch announcement templates

> Status: drafts.
> Source: roadmap §889. Companion: `launch-announcement-runbook.md`.
> Pure helper: `src/vs/workbench/contrib/vibeide/common/launchAnnouncementSpec.ts`.

These templates are **drafts**. Run them through
`validateAnnouncement(...)` before posting to catch length / format / screenshot
violations per channel. Replace bracketed `<...>` placeholders.

## HN — Show HN

> Title format: "Show HN: <project> – <one-sentence pitch>". No URL in title.

```
Show HN: VibeIDE — privacy-first AI IDE forked from VS Code, no telemetry, local Ollama
```

**URL field:** `https://github.com/VibeBrains/VibeIDE`

**First comment from author (post immediately after submission):**

```
Author here. VibeIDE is a fork of VS Code with the AI/agent layer rewritten:

- Zero cloud telemetry by default; the Telemetry service is a local audit channel
  for routing decisions only (full policy in references/v1/telemetry-policy.md
  in the repo).
- Local Ollama / LM Studio support out of the box; cloud providers (Anthropic,
  OpenAI, Gemini) are opt-in.
- Typed plan / skill / constraints API surface for extensions; sample extension
  in extensions/vibeide-sample.
- Code-signed installers for Windows, macOS Universal, ARM Linux on every
  release.

Today's release v<version> ships <new-feature-1>, <new-feature-2>, and
<new-feature-3>. Roadmap is in docs/roadmap.md (committed locally,
public-facing version on the website).

Happy to answer questions on architecture / privacy decisions / extension API.
```

## Reddit — r/programming

```
# VibeIDE 0.4 — privacy-first AI IDE forked from VS Code (no telemetry, local Ollama, typed plan API)

After ~6 months of work, my fork of VS Code that focuses on private AI coding is at v0.4. What's different from upstream:

**No cloud telemetry.** Zero outbound calls except: provider you pick (Anthropic / Ollama / etc), GitHub release check, and any MCP server you configure. The "telemetry" service in code is a local audit channel for routing decisions; reference doc explains this is by-design naming, full rename queued.

**Local-first AI.** First-class Ollama integration: probe-on-startup detects local models without burning network cycles (TCP connect via Node, no Chromium DevTools logs). Optional cloud providers are opt-in.

**Typed plan / skill / constraint API.** Extensions can read agent plans, register skills, observe constraints — all via a stable extension API surface (sample extension in repo).

**Signed builds for all four targets.** Windows EV-cert + macOS notarization + ARM Linux + universal binary.

Repo: https://github.com/VibeBrains/VibeIDE
Download: <release URL>
Roadmap (read-only on website): <website URL>

Open VSX listing: https://open-vsx.org/namespace/vibeide

Asking for: feedback on the architecture, edge cases that break privacy mode,
extension API gaps. Bug reports go to the GitHub Issues or the #bugs forum on Discord.
```

## Reddit — r/vscode

> Requires at least one screenshot. Different angle than r/programming — emphasise UX, not architecture.

```
# Forked VS Code into VibeIDE — here's what the chat sidebar looks like with no telemetry, local Ollama

[screenshot 1: chat sidebar with Ollama running locally]

[screenshot 2: privacy panel showing 0 outbound endpoints in strict mode]

[screenshot 3: extension catalog with vibeide-sample]

I forked VS Code 1.118 to ship an AI-pair-programming IDE that doesn't send telemetry. The fork is mostly the upstream codebase plus the contrib/vibeide module rewritten:

- Local Ollama auto-detect on startup (TCP probe — no Chromium network log if absent).
- Strict-mode "no outbound": one config flag blocks every non-allow-listed network call.
- Plan / skill API for extensions; first sample on Open VSX.
- Code-signed installers; Windows EV cert, macOS notarized, ARM Linux build.

Repo: https://github.com/VibeBrains/VibeIDE
Why fork instead of extension? The privacy guarantees need IDE-level changes (workbench bundle, network policy, etc). An extension can't promise no-telemetry on top of stock VS Code.

Bugs / feature requests welcome — Discord forum is the lowest-friction path; GitHub Issues works too.
```

## Twitter / X (thread, 5-7 tweets)

```
1/ VibeIDE 0.4 is out: privacy-first AI IDE forked from VS Code.

No cloud telemetry. Local Ollama. Typed plan/skill API.

Code-signed for Windows + macOS Universal + ARM Linux.

https://github.com/VibeBrains/VibeIDE

#vscode #ai #vibeide #v0.4.0
```

```
2/ "No telemetry" means zero outbound calls except: the provider you pick
(Anthropic / Ollama / etc), GitHub release check, and any MCP server you
configure. Strict-mode blocks even those.

The audit doc is committed in the repo: references/v1/telemetry-policy.md
```

```
3/ Local Ollama auto-detect runs in electron-main via Node net.connect — no
Chromium DevTools log if Ollama is absent. Tiny detail, but it's the difference
between a clean DevTools console and a perpetual ECONNREFUSED.
```

```
4/ Plan / skill / constraints API for extensions. Sample extension on Open VSX:
https://open-vsx.org/extension/vibeide/vibeide-sample

If you build for VibeIDE specifically, drop a link in r/vscode — happy to
boost.
```

```
5/ Why fork? An extension can't promise no-telemetry on top of stock VS Code —
the workbench bundles in upstream telemetry plumbing that the extension API
can't reach. Privacy guarantees need IDE-level edits.

Repo + roadmap + bugs: https://github.com/VibeBrains/VibeIDE
```

## Discord — pinned `#announcements` post

```
📢 **VibeIDE 0.4 is out** — privacy-first AI IDE forked from VS Code.

Highlights:
• Zero cloud telemetry; local Ollama auto-detect; opt-in cloud providers.
• Typed plan / skill / constraints API for extensions (sample on Open VSX).
• Code-signed installers for Windows, macOS Universal, ARM Linux.
• <new-feature-1>; <new-feature-2>; <new-feature-3>.

Download v0.4.0: <release URL>
Repo: https://github.com/VibeBrains/VibeIDE

Bugs in #bugs, questions in #help. PRs welcome.
```

## Mastodon (single 500-char post)

```
VibeIDE 0.4 — privacy-first AI IDE forked from VS Code. No cloud telemetry, local Ollama auto-detect, typed plan/skill API, code-signed for Win + macOS Universal + ARM Linux. Open-source MIT.

https://github.com/VibeBrains/VibeIDE

#vscode #ai
```

## Lobsters

```
Title: VibeIDE — privacy-first AI IDE forked from VS Code, no telemetry, local Ollama
URL:   https://github.com/VibeBrains/VibeIDE
Tags:  show, vscode, ai

Body:
After ~6 months of forking work, VibeIDE 0.4 ships with the AI/agent layer
rewritten for privacy. Zero outbound calls in strict mode except the LLM
provider you pick. Local Ollama auto-detect runs in main process via TCP
probe (no Chromium network noise). Typed plan / skill / constraint API for
extensions; sample extension on Open VSX. Signed builds for all four
distribution targets.

References:
- references/v1/telemetry-policy.md — privacy contract
- references/v1/distribution-signing-runbook.md — signing process
- bin/vibe-discord-import.mjs — Discord forum bug-intake CLI

Looking for feedback on the architecture and the privacy guarantees, plus
holes in the extension API.
```
