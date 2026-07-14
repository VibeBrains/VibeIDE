# VibeIDE CI/CD Integration Guide

## Running VibeIDE in GitHub Actions

### Basic Setup

```yaml
# .github/workflows/vibe-agent.yml
name: VibeIDE Agent

on:
  workflow_dispatch:
    inputs:
      task:
        description: 'Task for the agent'
        required: true

jobs:
  vibe-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      
      - name: Install VibeIDE CLI dependencies
        run: npm install --ignore-scripts
      
      - name: Run vibe doctor (CI mode)
        run: node scripts/vibe-doctor.js --ci
      
      - name: Run vibe agent (dry-run first)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          node scripts/vibe-run.js --dry-run "${{ inputs.task }}"
          # node scripts/vibe-run.js --auto "${{ inputs.task }}" --no-local-constraints
```

### vibe doctor in CI

```bash
# Fast check (≤3s): API keys, .vibe/ schema, Node.js version
node scripts/vibe-doctor.js --ci

# Machine-readable output (for dashboards)
node scripts/vibe-doctor.js --ci --json
```

Output format with `--json`:
```json
[
  {"check": "api-keys-configured", "status": "ok", "message": "API keys found: ANTHROPIC_API_KEY", "severity": "error"},
  {"check": "vibe-schema-valid", "status": "ok", "message": ".vibe/ files are valid", "severity": "error"},
  {"check": "node-version", "status": "ok", "message": "Node.js v22.0.0", "severity": "error"}
]
```

### Skipping local constraints in CI

```bash
# CI environment may conflict with local .vibe/constraints.json
node scripts/vibe-run.js --auto "task" --no-local-constraints

# Or use CI-specific profile:
# Create .vibe/profiles/ci.json with CI-appropriate constraints
```

### vibe review in CI

```yaml
- name: Run code review
  run: node scripts/vibe-review.js ${{ github.head_ref }}

- name: Upload SARIF report
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: review.sarif
  if: always()
```

With SARIF:
```bash
node scripts/vibe-review.js --output sarif > review.sarif
```

### vibe changelog in CI

```yaml
- name: Generate changelog
  run: node scripts/vibe-changelog.js --since ${{ github.event.before }} > CHANGELOG_DRAFT.md

- name: Upload changelog
  uses: actions/upload-artifact@v4
  with:
    name: changelog
    path: CHANGELOG_DRAFT.md
```

### OTel export in CI

```yaml
- name: Export agent spans to Jaeger
  env:
    OTEL_ENDPOINT: http://jaeger:4318
  run: node scripts/vibe-otel-export.js --endpoint $OTEL_ENDPOINT
```

---

## GitLab CI

```yaml
vibe-agent:
  image: node:22
  script:
    - npm install --ignore-scripts
    - node scripts/vibe-doctor.js --ci
    - node scripts/vibe-changelog.js --since $CI_COMMIT_BEFORE_SHA
  artifacts:
    paths:
      - CHANGELOG_DRAFT.md
```

---

## Security Notes

- API keys: use GitHub Secrets / GitLab CI Variables — never hardcode
- `--no-local-constraints`: CI may not have `.vibe/constraints.json` — this flag skips it safely
- Audit logs: `.vibe/audit.jsonl` in CI workspace → artifact for compliance
- `vibe doctor --ci` skips GUI/Electron checks — always exits 0 on headless

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `vibe doctor` fails on API keys | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` secret |
| Loop detector pauses in CI | Use `--loop-threshold 10` for CI scripts |
| Constraints conflict with CI | Create `.vibe/profiles/ci.json` or use `--no-local-constraints` |
| `npm install` fails on native modules | Use `npm install --ignore-scripts` |
