# Public-launch announcement runbook

> Status: operator runbook.
> Source: roadmap §889 (GitHub Sponsors / Open Collective / Marketing / Discord launch).
> Pure helper: `src/vs/workbench/contrib/vibeide/common/launchAnnouncementSpec.ts`.
> Templates: `references/v1/launch-announcement-templates.md`.
> Dependency: §888 (Distribution readiness gate must be `ready` — signed builds for all
> four platforms — before public launch).

## TL;DR sequence

1. **Wait for §888 ready**: code-signed Windows + macOS-notarized + ARM Linux build
   pass `evaluateReadinessGate({platforms, credentials}) = 'ready'`. Without
   signed binaries the announcement converts visitors into SmartScreen / Gatekeeper
   bounces, not adopters.
2. **Open monetization channels** (GitHub Sponsors + Open Collective).
3. **Stand up the marketing site** (single-page README, deployable to GitHub Pages
   from `VibeBrains/VibeIDE-website` repo or similar — out-of-tree).
4. **Pre-validate announcement copy** with `validateAnnouncement(...)` against every
   channel you plan to post to. Fix errors before posting anywhere.
5. **Stage posts in this order**: Discord (private community first) → Mastodon
   (low-stakes warmup) → Reddit r/vscode (largest pool of target users) → r/programming
   (broader) → HN Show HN (peak attention) → Twitter/X thread (reach amplifier) →
   Lobsters (programming-tier signal-boost). 24-hour gap between Reddit and HN to
   avoid burning attention.

## Operator setup tasks

### A. GitHub Sponsors

1. https://github.com/sponsors/borodatych/dashboard → "Set up Sponsors profile".
2. Connect Stripe (US/EU) or Stripe Atlas (other regions). 14-day review.
3. Add tier rewards (suggested):
   - **$5/mo** — name in CONTRIBUTORS.md.
   - **$25/mo** — early access to nightly builds.
   - **$100/mo** — priority issue response (24 h).
   - **$500/mo** — custom feature consultation (1 h/mo).
4. After approval, edit `.github/FUNDING.yml` and **uncomment** the `github:` line.
   The "Sponsor" button appears on the repo automatically.

### B. Open Collective

1. https://opencollective.com → Apply for fiscal host (Open Source Collective is
   the canonical option). Requires open-source license declared on repo.
2. Set up tiers mirroring Sponsors. Connect Stripe.
3. After approval, edit `.github/FUNDING.yml` and uncomment `open_collective:`.

### C. Marketing site

Out-of-tree (the docs-policy contract keeps `docs/` local-only). Recommended:

1. New repo `VibeBrains/VibeIDE-website` — single-page README + GitHub Pages.
2. Use the content scaffold in `references/v1/website-readme-template.md`.
3. Domain: optional vibeide.dev or equivalent (~$15/y at Namecheap or Porkbun).
4. Pin to the "Marketing site" cell in this runbook once live.

### D. Discord server

1. Create server `VibeIDE Community`.
2. Channels: `#announcements` (locked, mod-only post), `#bugs` (forum channel for
   §94 ingest), `#help`, `#showcase`, `#dev`, `#off-topic`.
3. Add bot token for §94 (see `bin/vibe-discord-import.mjs`).
4. Invite link: post in repo README footer + on `vibeide.dev`.

## Pre-launch validator

Before any post:

```bash
# Compile the helper:
npm run compile-build

# Validate announcement payload (script-side; the helper is the truth source).
node -e "
  const { validateAnnouncement, describeChannelValidation } = require('./out/vs/workbench/contrib/vibeide/common/launchAnnouncementSpec.js');
  const announcement = {
    title: 'VibeIDE 0.4 — privacy-first AI IDE forked from VS Code',
    summary: '...',
    url: 'https://github.com/VibeBrains/VibeIDE',
    downloadUrl: 'https://github.com/VibeBrains/VibeIDE/releases/tag/v0.4.0',
    screenshots: ['https://example.com/sshot1.png'],
    version: '0.4.0',
  };
  const r = validateAnnouncement(announcement, ['hn','reddit-rprogramming','reddit-rvscode','twitter','discord','mastodon','lobsters']);
  console.log(describeChannelValidation(r));
  if (!r.ok) process.exit(1);
"
```

If it returns errors, edit copy until clean.

## Stage timing

| Day | Channel | Notes |
|---|---|---|
| **D-7** | §888 readiness gate verified `ready`. Tag v0.4.0. | Without this, abort. |
| **D-3** | Discord server soft-open to friendly testers. | Catch obvious bugs. |
| **D-2** | Mastodon post. | Warmup; small reach but kind feedback. |
| **D-1** | Reddit r/vscode post. | Peak: 10am EST Tuesday-Thursday. |
| **D+0** | Reddit r/programming post (different angle, 24h after r/vscode). | Avoid identical title. |
| **D+0** | HN "Show HN" submission. | Peak: 8am-10am PST weekday. Stay on the post for 4h to reply. |
| **D+1** | Twitter/X thread. | Quote-tweet the HN link if it gets traction. |
| **D+1** | Lobsters submission (account-permitting). | Tags: show, vscode, ai. |
| **D+3** | Mid-week Discord recap with metrics so far. | Community signal. |

## Post-launch checklist

- Monitor `vibe doctor --network` on canary builds for first 48 h: any unexpected
  outbound endpoints would be a privacy regression visible to first-day users.
- Triage Discord `#bugs` daily for the first week: run
  `bin/vibe-discord-import.mjs --dry-run` to surface candidate roadmap items.
- Acknowledge top 10 GitHub Sponsors in CONTRIBUTORS.md (CHANGELOG-style: dated
  list, no PII beyond display name).
- Pin a "What's coming" repo issue listing the next 3-5 roadmap milestones so
  early adopters can see direction.

## Acceptance gate for §889

- [ ] §888 readiness gate `ready` (signed Win + macOS Universal + ARM Linux).
- [ ] GitHub Sponsors live (`.github/FUNDING.yml` `github:` uncommented).
- [ ] Open Collective live (`open_collective:` uncommented).
- [ ] Marketing site live at a stable URL.
- [ ] Discord server with `#announcements` + `#bugs` channels.
- [ ] Announcement validator returns OK for the planned channel set.
- [ ] First HN/Reddit/Twitter staging completed; metrics logged for retro.
