# VibeIDE v1 — Нормативные Contracts (Internal)

> **🔒 Internal contract** — эта папка содержит внутреннюю нормативную документацию для мейнтейнеров VibeIDE: ADR-ы, протоколы безопасности, спецификации контрактов между сервисами. Она **не публикуется на сайте**. Публичная документация → [`docs/v1/`](../../docs/v1/README.md).

---

## Категории

### Агент и инструменты
| Файл | Тема |
|---|---|
| [agent-locks-contract.md](agent-locks-contract.md) | Advisory territorial locks — контракт между окнами |
| [agent-guards-hierarchy.md](agent-guards-hierarchy.md) | Иерархия guard-ов (constraints → permissions → prompt) |
| [a2ui-allowed-commands.md](a2ui-allowed-commands.md) | A2UI: список разрешённых команд без confirm |
| [ai-rules-and-skills.md](ai-rules-and-skills.md) | `.claude/rules/` и skills — контракт |
| [context-filtering-policy.md](context-filtering-policy.md) | Политика фильтрации контекста |
| [spec-context-contract.md](spec-context-contract.md) | Spec context slot — контракт |

### Планы и checkpoint
| Файл | Тема |
|---|---|
| [persisted-plan-contract.md](persisted-plan-contract.md) | Контракт персистированных планов |
| [checkpoint-coordinator.md](checkpoint-coordinator.md) | CheckpointCoordinator — протокол |
| [plan-steps.schema.json](plan-steps.schema.json) | JSON-схема шагов плана |
| [plan-mcp-allowlist.md](plan-mcp-allowlist.md) | MCP tool allowlist в планах |
| [plan-rollback-acceptance.md](plan-rollback-acceptance.md) | Критерии приёмки rollback |
| [plan-steps-single-writer.md](plan-steps-single-writer.md) | Single-writer инвариант для шагов |
| [plan-token-budget-ceiling.md](plan-token-budget-ceiling.md) | Token budget ceiling |
| [plan-worktree-branch.md](plan-worktree-branch.md) | Worktree/branch политика в планах |
| [qa-gate-persisted-plans.md](qa-gate-persisted-plans.md) | QA gate для планов |
| [vibe-sync-plans-policy.md](vibe-sync-plans-policy.md) | Sync политика планов |

### Безопасность и политика
| Файл | Тема |
|---|---|
| [nl-shell-safety-contract.md](nl-shell-safety-contract.md) | NL→shell safety — три актора + reason-коды |
| [git-autostash-contract.md](git-autostash-contract.md) | Auto-stash контракт |
| [edit-risk-vs-confidence.md](edit-risk-vs-confidence.md) | Edit risk vs. confidence scoring |
| [privacy-vs-replay.md](privacy-vs-replay.md) | Privacy vs. audit-replay trade-off |
| [eu-ai-act-self-assessment.md](eu-ai-act-self-assessment.md) | EU AI Act self-assessment |
| [telemetry-policy.md](telemetry-policy.md) | Политика телеметрии |
| [telemetry-service-scope.md](telemetry-service-scope.md) | Scope telemetry service (local audit channel) |
| [windows-controlled-folder-access-vibeide.md](windows-controlled-folder-access-vibeide.md) | Windows CFA — обходные пути |

### Расширения и API
| Файл | Тема |
|---|---|
| [extension-api-stability.md](extension-api-stability.md) | Stability guarantees для extension API |
| [extensions-lockfile-policy.md](extensions-lockfile-policy.md) | Lock-file политика |

### Память и мульти-агент
| Файл | Тема |
|---|---|
| [memory-layers-contract.md](memory-layers-contract.md) | Три слоя памяти — контракт |
| [multi-agent-scenarios.md](multi-agent-scenarios.md) | Multi-agent сценарии |
| [background-agent.md](background-agent.md) | Background agent — архитектура |
| [background-agent-hybrid-compute.md](background-agent-hybrid-compute.md) | Hybrid compute |
| [background-agent-remote-runner.md](background-agent-remote-runner.md) | Remote runner |
| [subagents.md](subagents.md) | Subagents — контракт |

### Дистрибуция и релизы
| Файл | Тема |
|---|---|
| [distribution-signing-runbook.md](distribution-signing-runbook.md) | Подпись артефактов |
| [openvsx-publishing-runbook.md](openvsx-publishing-runbook.md) | OpenVSX публикация |
| [electron-cve-triage-runbook.md](electron-cve-triage-runbook.md) | CVE-триаж Electron |
| [launch-announcement-runbook.md](launch-announcement-runbook.md) | Launch runbook |
| [upstream-merge-playbook-vibeide.md](upstream-merge-playbook-vibeide.md) | Upstream merge playbook |

### Tabs, UX и прочее
| Файл | Тема |
|---|---|
| [multi-chat-tabs-design.md](multi-chat-tabs-design.md) | Multi-chat tabs — дизайн |
| [tab-completion-sla.md](tab-completion-sla.md) | Tab completion SLA |
| [persona-vs-modes.md](persona-vs-modes.md) | Persona vs. modes |
| [vibeide-vs-alternatives.md](vibeide-vs-alternatives.md) | Сравнение с Cursor / Windsurf |

### Политика документации
| Файл | Тема |
|---|---|
| [docs-policy.md](docs-policy.md) | Split `docs/` (публичное) vs `docs/references-v1/` (нормативное) |
| [ci-workflows-inventory.md](ci-workflows-inventory.md) | CI workflows inventory |
| [l10n-vs-nls-decision.md](l10n-vs-nls-decision.md) | **[нормативное]** `nls.localize()` vs `vscode.l10n.t()` — выбранный путь |
| [worktree-merge-policy.md](worktree-merge-policy.md) | Git worktree merge policy при изоляции агентов: кто и как мержит в основную ветку |

### Аудиты и снимки состояния
| Файл | Тема |
|---|---|
| [audit-2026-05-07-acceptance.md](audit-2026-05-07-acceptance.md) | DoD / acceptance criteria аудита 2026-05-07 (living document — обновляется по мере закрытия K/L) |
| [services/orphan-services-2026-05-08.md](services/orphan-services-2026-05-08.md) | Снимок инвентаризации orphan-сервисов (`vibe-services-inventory.js --orphans`, 2026-05-08) |

### Контракты рантайма
| Файл | Тема |
|---|---|
| [perf-guardrails-contract.md](perf-guardrails-contract.md) | Контракт `performanceGuardrailsService.ts` + `perfGuardrailsAggregator.ts` |
| [remote-vector-store-split-brain.md](remote-vector-store-split-brain.md) | Split-brain вектор-стора при Remote SSH / Dev Container / WSL: кэши привязаны к тому, где пишет Node-процесс, а не к «репозиторию» в голове разработчика |

### Комьюнити, запуск, операционка
| Файл | Тема |
|---|---|
| [community-plan-templates.md](community-plan-templates.md) | **[черновик]** Подпись и установка community-шаблонов планов (Phase 3a; CLI/CDN/crypto — в бэклоге) |
| [discord-import-runbook.md](discord-import-runbook.md) | Runbook мейнтейнера для `bin/vibe-discord-import.mjs` (импорт багов из Discord) |
| [launch-announcement-templates.md](launch-announcement-templates.md) | **[черновики]** Шаблоны анонсов запуска |
| [website-readme-template.md](website-readme-template.md) | Скелет README для отдельного репо сайта (`VibeIDE-website`, GitHub Pages) |

---

> **Важно:** `docs/references-v1/` **отслеживается git** (57 файлов). Прежнее утверждение «вся папка в `.gitignore`» осталось от предшественника — local-only дерева `docs/references-v1/`, которое действительно игнорируется; проверено 2026-07-15 (`git check-ignore` + `git ls-files`). Это нормативные справки и контракты: пишутся для разработчиков, но живут в репозитории и ревьюятся как код.
