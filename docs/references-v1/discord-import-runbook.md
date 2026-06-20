# Discord Bug Import — Runbook

Maintainer runbook for `bin/vibe-discord-import.mjs` (roadmap §94).

## Prerequisites

- Node.js ≥ 20 (`node --version`)
- Discord Bot Token with **Read Message History** + **View Channel** + **Message Content Intent** enabled
- Bot invited to the target server via OAuth2 URL Generator (`bot` scope, minimal permissions above)

## Setup

Copy `.env.local.example` → `.env.local` and fill in:

```
DISCORD_BOT_TOKEN=<bot token from Discord Developer Portal → Bot → Reset Token>
DISCORD_CHANNEL_ID=<channel ID — second number in the discord.com/channels/SERVER/CHANNEL URL>
```

Never commit `.env.local` — it is git-ignored.

Optional:

```
GITHUB_REPO=owner/repo          # default: vibeideteam/vibeide
GITHUB_TOKEN=<token>            # for private repos or higher rate-limit
```

## Usage

```bash
# Dry run — print verdicts, do not touch roadmap.md
node --env-file=.env.local bin/vibe-discord-import.mjs --dry-run

# Live run — print new items, prompt to append manually
node --env-file=.env.local bin/vibe-discord-import.mjs

# Auto-append new items to docs/roadmap.md (review with git diff before committing)
node --env-file=.env.local bin/vibe-discord-import.mjs --auto-append

# Local dev with fixture file (no live Discord call)
node bin/vibe-discord-import.mjs --fixtures test/fixtures/discord-messages.json --dry-run
```

## PII / Screenshot Policy

- **Text content only.** The importer fetches `message.content` — plain text. Embedded images are not downloaded.
- **Attachment-only messages** (no text body) are classified `malformed: attachment-only` and dropped automatically.
- **PII patterns detected and dropped:** SSN-shaped numbers, 16-digit card numbers, email addresses, IPv4 addresses. Messages matching any pattern are classified `malformed: pii-suspected`.
- **Screenshots in Discord** are attachments. They are never fetched or stored by this tool. If a reporter pastes a screenshot URL as text, it passes through — reviewer must redact before committing to roadmap.
- **Before committing** new `docs/roadmap.md` entries: scan for any personal data (real names, email, phone) and redact or paraphrase.

## Verdict types

| Verdict | Meaning |
|---|---|
| `new` | Not in roadmap or GitHub Issues. Markdown block printed for review. |
| `duplicate` | Title matches existing roadmap entry or open/closed GitHub Issue. Skipped. |
| `malformed` | Too short (< 20 chars), attachment-only, or PII detected. Skipped. |

## Troubleshooting

| Error | Fix |
|---|---|
| `403 Missing Access` | Bot not in server — generate invite URL in OAuth2 → URL Generator, add `bot` scope |
| `401 Unauthorized` | Token wrong or revoked — Reset Token in Developer Portal |
| `message.content` empty / all `too-short` | Enable **Message Content Intent** in Developer Portal → Bot → Privileged Gateway Intents |
| `0 new / 0 duplicate / 0 malformed` | Channel is empty |
