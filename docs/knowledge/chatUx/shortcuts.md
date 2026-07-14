# Шорткаты и скрытие builtin chat

← [Knowledge Index](../README.md)

`Ctrl+Alt+I`, отвязка `workbench.action.chat.open`, скрытие встроенного VS Code chat.

---

## [vscode] Открыть чат VibeIDE: Ctrl+Alt+I и отвязка `workbench.action.chat.open`

**Контекст:** единый шорткат как у Cursor/Copilot и подсказка на пустом редакторе должны открывать **панель VibeIDE**, а не встроенный Chat (2026-05).

**Суть:** команда **`vibeide.sidebar.open`** (`sidebarActions.ts`) — контейнер **`workbench.view.vibeide`** + **`focusCurrentChat`**. Клавиши: **Windows/Linux** `Ctrl+Alt+I`; **macOS** `⌘⌃I` (`KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyI`). Вес **`KeybindingWeight.ExternalExtension`**. Тот же аккорд по умолчанию был у **`workbench.action.chat.open`** — добавлено правило удаления **`KeybindingsRegistry.registerKeybindingRule({ id: '-workbench.action.chat.open', … })`** с теми же клавишами, чтобы chord не дублировался. В **`editorGroupWatermark.ts`** пункт «Open Chat» указывает на **`vibeide.sidebar.open`** (не на MS Chat), без `when` по chat setup. После правок keybinding — **`npm run compile`**, перезапуск Electron.

**Применение:** менять шорткат или вернуть MS Chat на отдельное сочетание — `sidebarActions.ts` + при необходимости пользовательский `keybindings.json`.

---

## [договорённость] Встроенный Workbench Chat (upstream) скрыт — сделано коллегой

**Контекст:** в части чат-сессий ассистента полное выключение видимости встроенного чата VS Code не удавалось; фактический фикс внёс коллега (2026-05).

**Суть:** интерфейс встроенного чата (**`workbench.panel.chat`**, вкладки/кнопки в aux bar и activity bar, inline chat widget, точки входа со sparkle в title bar) **скрывается CSS** вкладкой **`HideBuiltinChatContribution`** — `src/vs/workbench/contrib/vibeide/browser/hideBuiltinChat.ts`, фаза `WorkbenchPhase.BlockRestore`. Сервисы чата в core **не выпиливались**: `chatThreadService` и смежное завязано на них. Если дубль «чата» появится после синка апстрима — смотреть селекторы в `HIDE_CSS` (`data-action-id`, `.inline-chat-widget`, unified-agents-bar и т.д.).

**Применение:** при регрессиях «виден два чата» / вернулся Copilot pane — дополнять селекторы или перепроверить регистрацию contribution.

---

## [vscode] Модалка «Welcome to VS Code» / Copilot vs VibeIDE onboarding

**Контекст:** перепутаны два разных экрана; отключение VibeIDE onboarding не убирает мастер Microsoft (2026-05-04).

**Суть:** полноэкранный мастер с «Continue with GitHub» — `OnboardingVariationA` (`welcomeOnboarding`), вызов из `StartupPageRunnerContribution.tryShowOnboarding()` в `startupPage.ts` при `workbench.welcomePage.experimentalOnboarding` и новом application storage. Оверлей VibeIDE — `vibeideOnboardingService.ts` + React `vibe-onboarding`. Для форка: ранний `return` при `productService.applicationName === 'vibeide'`, дефолт `experimentalOnboarding: false`.

**Применение:** не трогать VibeIDE onboarding, если жалоба на GitHub/Copilot sign-in.
