# Config Guard — статический скан `.vibe/providers.json` и `mcp.json`

← [Knowledge Index](../README.md)

---

## [архитектура] Config Guard: валидация недоверенных machine-config при загрузке

**Контекст:** VibeIDE грузит из (потенциально чужого) воркспейса два machine-config файла, которые управляют сетью и запуском процессов: `.vibe/providers.json` (динамические LLM-провайдеры — `baseURL`, `headers`, `apiKeyEnv`) и `mcp.json` (MCP-серверы — `command`, `args`, `env`, `url`). До Config Guard оба грузились без проверки: подмена `baseURL` уводила весь модельный трафик на чужую инфраструктуру, а `mcp.json` мог запустить произвольный процесс (`curl|sh`, `npx -y`, `--no-sandbox`). Идея и набор эвристик перенесены из AgentShield (победитель Claude Code Hackathon, Feb 2026), но **только узкий срез под реальную поверхность VibeIDE** — остальное уже покрыто `vibePromptGuardService` (prompt-injection/unicode в правилах) и `secretDetection` (секреты в исходящих сообщениях). Дублировать их Config Guard не должен.

**Суть:**
- Чистый модуль детекта — [common/vibeConfigGuard.ts](../../../src/vs/workbench/contrib/vibeide/common/vibeConfigGuard.ts). Без I/O, без VS Code-зависимостей, без чтения конфига → тестируем из `test/common/`. Две функции: `scanProviderConfig(entries)` и `scanMcpConfig(servers)` → `ConfigGuardFinding[]` (`ruleId`, `severity`, `subject`, `message`).
- **12 правил** (provider × 3, mcp × 9):

  | Файл | ruleId | Severity |
  |---|---|---|
  | providers | `provider-endpoint-non-https` | critical |
  | providers | `provider-endpoint-raw-ip` | high |
  | providers | `provider-hardcoded-secret` (baseURL userinfo / header / query литерал) | critical |
  | mcp | `mcp-remote-command` (`curl\|sh`) | critical |
  | mcp | `mcp-shell-wrapper` (`sh -c`) | high |
  | mcp | `mcp-disabled-security` (`--no-sandbox` …) | critical |
  | mcp | `mcp-npx-no-pin` (`-y` / без фиксации версии) | medium |
  | mcp | `mcp-env-override-critical` (PATH/LD_PRELOAD/NODE_OPTIONS…) | critical |
  | mcp | `mcp-hardcoded-env-secret` | critical |
  | mcp | `mcp-shell-metacharacters` | medium |
  | mcp | `mcp-url-non-https` | high |
  | mcp | `mcp-url-credentials` (user:pass@) | high |

- **Где НЕ ловит (осознанно):** секреты в исходящих сообщениях (→ `secretDetection`), prompt-injection в правилах (→ `vibePromptGuardService`), серверные правила AgentShield `bind 0.0.0.0` / wildcard-CORS — VibeIDE MCP-**клиент**, он подключается, а не слушает порт. Локальный `http://localhost` / `127.0.0.1` не флагается (легитимный прокси).
- Конфиг: `vibeide.configGuard.enabled` (bool, default `true`), `vibeide.configGuard.mode` (`warn`/`block`, default `warn`) — [common/vibeConfigGuardConfiguration.ts](../../../src/vs/workbench/contrib/vibeide/common/vibeConfigGuardConfiguration.ts). Дефолт `warn` ничего не отключает — это анти-DoS на легитимные proxy-конфиги.
- Точки врезки (скан при загрузке, существующий парсинг не тронут):
  - провайдеры — `reload()` в [browser/vibeDynamicProvidersService.ts](../../../src/vs/workbench/contrib/vibeide/browser/vibeDynamicProvidersService.ts) (`_runConfigGuard`): находки → `state.warnings` + лог; в `block` критичные провайдеры выпадают из transport.
  - MCP — `_refreshMCPServers()` в [common/mcpService.ts](../../../src/vs/workbench/contrib/vibeide/common/mcpService.ts) (`_runConfigGuard`): в `block` критичные серверы вырезаются из конфига до старта.
  - Уведомление — одно консолидированное `INotificationService.warn` на сет находок, дедуп по сигнатуре (`_lastGuardSig`), чтобы правки файла не спамили.
- Диагностика: команда `vibeide.configGuard.showFindings` («VibeIDE: Config Guard — показать находки») — [browser/vibeConfigGuardDiagnosticContribution.ts](../../../src/vs/workbench/contrib/vibeide/browser/vibeConfigGuardDiagnosticContribution.ts). Оба сервиса отдают `getLastGuardFindings()`; команда reload'ит провайдеры и рендерит таблицу по severity в untitled-md.

**Применение:**
- Добавляешь новое правило → пиши его в `scanProviderConfig`/`scanMcpConfig` (чистая функция) + кейс в [test/common/vibeConfigGuard.test.ts](../../../src/vs/workbench/contrib/vibeide/test/common/vibeConfigGuard.test.ts) (срабатывание + «чистый конфиг»). Сервисы и UI трогать не надо — они работают по `ConfigGuardFinding[]`.
- Прежде чем добавить правило про секреты/инъекции — проверь, не покрыто ли уже `secretDetection`/`vibePromptGuardService`. Config Guard — только config-as-code риск.
- `block`-режим включать осознанно: он не активирует провайдер/не стартует MCP-сервер с critical-находкой; для proxy на сыром IP или `http://` это может «отключить» рабочий канал.
- Тест: положить в `.vibe/providers.json` запись с `baseURL: "http://1.2.3.4/v1"` → уведомление Config Guard + строка `[critical]` в логе VibeIDE; команда показывает её в таблице.

**Антипаттерны:**
- Не тащить из AgentShield все 125 правил «на будущее» — большинство мимо поверхности VibeIDE (хуки `.claude/`, серверные bind/CORS, дубли secret/injection). Правило трёх и реальная поверхность, не маркетинговая полнота.
- Не делать `mode="block"` дефолтом — тихий DoS на легитимные конфиги.

**Связано:** [[russianFirst]] (тексты находок — на русском, ruleId — английский идентификатор) · [dynamicProviders.md](../architecture/dynamicProviders.md) · [.vibe/ config](../vibeDotfolder/).
