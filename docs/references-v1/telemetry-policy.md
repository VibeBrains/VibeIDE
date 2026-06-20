# Telemetry policy

> Status: normative.
> Source roadmap entries: L.9 «`telemetry.yml` audit», Phase 1 audit «телеметрия отключена».

## Statement

VibeIDE **does not** transmit telemetry to Microsoft, Anthropic, OpenAI, the maintainer,
or any third party by default. There is no `telemetry.cloudflare.io`-style endpoint, no
crash-report aggregation service, no usage beacon.

## What is and is not telemetry

| Term                 | What it actually means in VibeIDE                                  | Outbound? |
|----------------------|--------------------------------------------------------------------|-----------|
| Telemetry            | Cloud-bound usage / crash data.                                    | No.       |
| Audit log            | Local file of agent actions, retained per user policy.             | No.       |
| Provider call        | LLM request to the provider the user picked (Anthropic, etc).      | Yes.      |
| Update check         | GitHub Releases API request for new versions.                      | Yes.      |
| Models registry sync | `models.json` fetch from the registry CDN (ETag-cached).           | Yes.      |
| MCP server call      | Whatever endpoints the user-configured MCP servers reach.          | User-set. |

The only outbound traffic VibeIDE initiates is the four bottom rows. Each is gated by an
explicit user decision (provider key entered, update channel chosen, registry URL kept at
default, MCP server configured).

## `vscode-telemetry-extractor` workflow

`telemetry.yml` runs `vscode-telemetry-extractor` on each PR. Given the policy above, the
purpose is **audit**, not collection: the workflow fails if a PR introduces new
`/* __GDPR__ */`-style telemetry entries that we did not knowingly add.

Action items:

- Rename `.github/workflows/telemetry.yml` to `.github/workflows/telemetry-audit.yml` so
  the intent is visible from the file name.
- Add a top-of-file comment: «Verifies that no new telemetry call sites have been
  introduced. VibeIDE does not transmit telemetry; this workflow exists as a leak
  detector only.»
- Update `references/v1/ci-workflows-inventory.md` to reflect the rename when it lands.

## Privacy mode (`vibeide.privacy.strict`)

When `strict = true`:

- Outbound LLM calls are restricted to the configured local providers (Ollama, LM Studio,
  any provider whose endpoint is `127.0.0.1` / `localhost`).
- Update checks are disabled.
- Models registry sync is disabled (offline cached `models.json` is used).
- MCP servers are still allowed only if the user explicitly added them; the strict mode
  warns when a configured MCP server is non-local.

## Logging policy

The audit log lives at:

- Local OS application data dir, encrypted via `IEncryptionService`.
- Retention is configurable; default is 30 days.
- GDPR export (`vibe doctor --gdpr-export`) and delete (`vibe doctor --gdpr-delete`)
  cover the audit log together with `.vibe/snapshots/`, settings, and history.

## Verification (manual until `privacy-verify.yml` lands)

To confirm a build does not phone home:

1. Set `vibeide.privacy.strict = true`.
2. Open a workspace, run agent in Auto mode against a local model.
3. Watch outbound traffic with `Get-NetTCPConnection -State Established` (Windows) or
   `lsof -i -P` (macOS / Linux).
4. Only `127.0.0.1` connections (Ollama / LM Studio) should appear.

The L.5 backlog automates this check via `.github/workflows/privacy-verify.yml`.

## Backlog

- Rename `telemetry.yml` → `telemetry-audit.yml` and add the policy header.
- Land `privacy-verify.yml` (L.5) as the automated equivalent of the manual check above.
- Link this document from `docs/SECURITY_FAQ.md` for public visibility.
