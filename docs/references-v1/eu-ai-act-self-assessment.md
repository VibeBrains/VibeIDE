# EU AI Act self-assessment — VibeIDE

> Status: self-assessment, not legal advice.
> Source roadmap entry: «EU AI Act self-assessment».
> Last review: 2026-05-08.

## Classification

VibeIDE is an **assistive coding tool**: a desktop IDE that, on user request, sends code
fragments to large language models and returns code suggestions, plan outlines, and
diagnostic explanations. It is not used for biometric identification, social scoring,
critical infrastructure, employment decisions, education scoring, or any other sector
listed in Annex III of the EU AI Act.

We classify VibeIDE under the Act's **limited-risk** tier (Article 50 transparency
obligations apply; Article 6 high-risk requirements do not).

## Article 50 — transparency obligations

### Disclosure that the user is interacting with an AI

- The Trust Score widget (`Manual` / `Supervised` / `Auto`) is permanently visible in the
  status bar and clearly labels the agent's mode.
- The first-run wizard shows that AI suggestions are produced by external LLM providers,
  with a list of providers and a link to each provider's privacy policy.
- AI-generated code is optionally tagged with `// @ai-generated <model-id> <ts>` (setting
  `vibeide.aiProvenance.markGeneratedCode`). Default is OFF in privacy mode, ON otherwise
  for transparency.

### Disclosure that AI-generated content can be wrong

- The onboarding screen displays the line: «AI may produce mistakes. Review every change
  before committing.»
- Diff preview shows confidence badges (🟢 / 🟡 / 🔴) on every AI-generated edit.

### Synthetic media labelling

Not applicable: VibeIDE does not generate audio, video, or images that could be
mistaken for human-produced media.

## Risk controls already in place

- **Human oversight (Article 14 spirit, even though not strictly required):** Trust Score
  Manual / Supervised modes; Dead-Man's-Switch; loop detector; constraints layer; per-file
  permission gates.
- **Logging (Article 12 spirit):** local audit log with retention, GDPR export, GDPR
  delete; encrypted at rest via `IEncryptionService`.
- **Robustness:** loop detector, auto-repair, rate-limit handling, token budgets, prompt
  injection guard against zero-width / Bidi attacks.
- **Cybersecurity:** SBOM, npm audit, Electron CVE workflow, codesigning planned for
  distribution.

## Deployment and serial obligations

VibeIDE is **open-source**. The provider obligations (Articles 16-17) fall on whoever
distributes a binary build. We document:

- The model providers VibeIDE can call (provider list in `models.json`).
- Training-data policy fields per provider (`trainingPolicy` in registry).
- BYOK by default: the user controls which provider receives their data.

For the maintainer-provided GitHub Releases binary, the obligations are summarized in:

- `docs/SECURITY_FAQ.md` (security and privacy posture).
- `docs/v1/transparency/` (transparency dashboard).

## Items still to do

- A dedicated public-facing AI transparency page on the marketing site (depends on the
  site existing).
- A PDF export of this self-assessment that can be attached to enterprise contracts.
- A `vibe doctor --eu-ai-act` report that lists the active providers, their training
  policy, and the current Trust Score mode for compliance audits.

## Backlog

- Re-review when the Act's implementing acts are published (expected later in 2026).
- Re-review if a new feature (e.g. autonomous PR creation, telemetry) changes the risk
  profile.
- Cross-link from `docs/SECURITY_FAQ.md` once that file's public version is updated.
