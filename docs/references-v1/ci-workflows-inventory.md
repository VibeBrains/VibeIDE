# CI workflows inventory

> Status: normative — every workflow has a row.
> Source roadmap entries: L.9 «Workflow inventory», CI gaps.

## Format

| Workflow file                                | Purpose                                        | Status      | Owner / area              |
|----------------------------------------------|------------------------------------------------|-------------|---------------------------|
| `pr.yml`                                     | Top-level PR gate, fans out to platform jobs.  | ACTIVE      | Build                     |
| `pr-linux-test.yml`                          | Linux platform test job (called by `pr.yml`).  | ACTIVE      | Build                     |
| `pr-linux-cli-test.yml`                      | Linux CLI build / test.                        | ACTIVE      | Build                     |
| `pr-darwin-test.yml`                         | macOS platform test job.                       | ACTIVE      | Build                     |
| `pr-win32-test.yml`                          | Windows platform test job.                     | ACTIVE      | Build                     |
| `pr-node-modules.yml`                        | Verifies node_modules diff against lockfile.   | ACTIVE      | Build                     |
| `release.yml`                                | Release artefact assembly + manifest write.    | ACTIVE      | Release                   |
| `e2e-tests.yml`                              | Phase-1 E2E (Win/Mac/Linux matrix).            | ACTIVE      | QA                        |
| `perf-sla.yml`                               | Performance SLA runbook (cold start, mem).     | ACTIVE      | Performance               |
| `sbom.yml`                                   | CycloneDX SBOM + bundled extensions list.      | ACTIVE      | Security                  |
| `security-audit.yml`                         | Electron CVE monitor + npm audit on lockfile.  | ACTIVE      | Security                  |
| `upstream-lag-check.yml`                     | Alerts when fork lags upstream > 2 weeks.      | ACTIVE      | Build                     |
| `sync-vibe-neon-upstream.yml`                | Vibe Neon theme sync from upstream.            | ACTIVE      | UX / themes               |
| `sync-project-manager.yml`                   | Project Manager extension upstream sync.       | ACTIVE      | Extensions                |
| `chat-lib-package.yml`                       | Chat library packaging (legacy CortexIDE?).    | UNDER AUDIT | Chat                      |
| `chat-perf.yml`                              | Chat performance gate.                         | UNDER AUDIT | Chat                      |
| `sessions-e2e.yml`                           | Sessions export/replay E2E.                    | UNDER AUDIT | Replay / Compliance       |
| `screenshot-test.yml`                        | Visual regression (component fixtures).        | UNDER AUDIT | UX                        |
| `component-fixture-tests.yml`                | Component fixture tests.                       | UNDER AUDIT | UX                        |
| `monaco-editor.yml`                          | Upstream Monaco editor regression.             | LEGACY      | Build (consider retire)   |
| `copilot-setup-steps.yml`                    | Copilot setup probe.                           | LEGACY      | Retire                    |
| `api-proposal-version-check.yml`             | VS Code proposed-API version pin guard.        | LEGACY      | Retire (see policy below) |
| `no-engineering-system-changes.yml`          | Guard against engineering-system file edits.   | LEGACY      | Adapt or retire           |
| `no-package-lock-changes.yml`                | Guard against `package-lock.json` edits.       | LEGACY      | Retire                    |
| `no-yarn-lock-changes.yml`                   | Guard against `yarn.lock` edits.               | LEGACY      | Retire                    |
| `telemetry-audit.yml`                        | Audits the source for telemetry call sites.    | ACTIVE      | Privacy                   |
| `check-clean-git-state.sh`                   | Helper script for a workflow.                  | ACTIVE      | Build                     |

## Retire policy

`LEGACY` rows are kept only because they predate the fork. They block normal updates
(e.g. `no-package-lock-changes.yml` flags every `npm install` that updates the lockfile).
The retire procedure:

1. Open a PR titled `ci: retire <workflow>` with a short rationale and link to this row.
2. Delete the file.
3. Update this table to remove the row.
4. Add a one-line entry under `## ♻️ Внутреннее` of the next release notes.

The four `no-*-changes.yml` workflows are designed for upstream contribution flow and
must be retired or significantly relaxed before VibeIDE can keep its own dependency
hygiene.

## Telemetry workflow policy

`telemetry.yml` runs `vscode-telemetry-extractor`. The Phase 1 audit declared "telemetry
disabled / local-only", so this workflow's purpose has to be one of:

- **Audit** — verify no new telemetry has leaked in upstream merges. **Action:** rename to
  `telemetry-audit.yml` and document this purpose in `references/v1/telemetry-policy.md`.
- **Stale** — leftover from upstream. **Action:** retire.

Decision: keep as audit. See `references/v1/telemetry-policy.md`.

## Backlog (new workflows from K/L sections)

Rows below are planned, not yet present:

| Workflow file                                | Source roadmap entry                |
|----------------------------------------------|-------------------------------------|
| `.github/workflows/test-coverage.yml`        | L.0 — coverage gate                 |
| `.github/workflows/privacy-verify.yml`       | L.5 — sniffer for privacy-strict    |
| `.github/workflows/docs-links.yml`           | L.2 — markdown-link-check           |
| `.github/workflows/i18n-coverage.yml`        | _ACTIVE_ — soft gate (K.4)          |
| `.github/workflows/i18n-lint.yml`            | _ACTIVE_ — warning-only (K.4)       |
| `.github/workflows/fork-changes-sync.yml`    | K.1 — auto-update FORK_CHANGES.md   |

When a backlog row lands, move it to the main table with status `ACTIVE`.
