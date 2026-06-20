# Community plan templates — signing & install (design)

**Status:** normative draft for Phase 3a marketplace parity with **`scripts/vibe-schema-templates.js`** and community custom modes. Implementation (CLI, CDN manifest, crypto verify) is backlog.

## Goals

- Ship **curated `.plan.md` / packaged plan stubs** the same way as `.vibe/schema/` templates: discover → preview hash → explicit install.
- **No silent writes:** default flow shows SHA-256 (or manifest signature) before files land under `.vibe/plans/` or `.vibe/templates/plans/`.

## Threat model (aligned with persisted plans)

- Treat downloaded templates like **untrusted markdown + YAML:** they expand into the prompt and disk; same boundaries as **`IVibePromptGuardService`** / secret-detection roadmap (§ F).
- **Signature:** prefer **manifest + detached signature** (Ed25519 or minisign) over «trust HTTPS» alone; mirror **`references/v1/persisted-plan-contract.md`** rules: no raw secrets in frontmatter.

## Install pipeline (target)

1. **List** — static JSON index URL (versioned); entries: `id`, `title`, `digest`, `signature`, `artifactUrl`, `minVibeide`.
2. **Fetch artifact** — tarball or single `.plan.md`; compute digest; verify signature with **pinned publisher keys** (rolling key id in manifest).
3. **Preview** — print frontmatter fields + first N lines of body; refuse if `workspaceRootUri` present and mismatched (optional `--force` for template-only packs).
4. **Write** — extract only under `.vibe/plans/` or documented template dir; never overwrite without `--force`.

## Parallels

| Mechanism | Schema templates (`vibe-schema-templates.js`) | Plan templates (this doc) |
|-----------|-----------------------------------------------|---------------------------|
| Preview before apply | JSON snippet + SHA-256 of body | Plan frontmatter + SHA-256 of pack |
| Built-in registry | `BUILT_IN_TEMPLATES` | To be added when CLI ships |
| Remote URL | HTTPS fetch + review | Same + signature verify |

## Related

- **`references/v1/persisted-plan-contract.md`** — on-disk plan contract.
- **`references/v1/plan-steps.schema.json`** — machine steps shape.
