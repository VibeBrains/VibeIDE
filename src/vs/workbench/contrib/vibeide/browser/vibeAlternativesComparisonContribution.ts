/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeAlternativesComparisonContribution — honest "how we're different" screen.
 *
 * Shows a short comparison panel (Continue.dev / Cursor / Aider) in onboarding
 * when the user has imported settings from another tool or on first run.
 *
 * Philosophy: direct, honest, no marketing superlatives.
 * Source of truth: references/v1/vibeide-vs-alternatives.md
 *
 * Trigger conditions:
 *  - User has completed vibe init --from cursor/continue/windsurf/aider in this session
 *  - OR user clicks "How is VibeIDE different?" in onboarding step 3
 *  - NOT shown more than once per workspace (stored in workspaceStorage)
 *
 * Phase MVP: notification with "Learn more" → opens vibeide-vs-alternatives.md
 * Phase 3b: dedicated onboarding step rendered in the welcome sidebar
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeModalService } from '../common/vibeModalService.js';

// ── Storage key ────────────────────────────────────────────────────────────────

const SHOWN_KEY = 'vibeide.onboarding.alternativesComparisonShown';

// ── Contribution ──────────────────────────────────────────────────────────────

class VibeAlternativesComparisonContribution extends Disposable {

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
		@ICommandService private readonly _commands: ICommandService,
	) {
		super();
		// Show at most once per workspace
		this._maybeShowComparison();
	}

	private _maybeShowComparison(): void {
		const alreadyShown = !!this._storage.get(SHOWN_KEY, StorageScope.WORKSPACE);
		if (alreadyShown) { return; }

		// Show after a short delay to not compete with other onboarding notifications
		const timer = setTimeout(() => this._show(), 5000);
		this._register({ dispose: () => clearTimeout(timer) });
	}

	private _show(): void {
		this._storage.store(SHOWN_KEY, 'true', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._log.info('[VibeIDE] Showing alternatives comparison notification (once per workspace)');

		this._notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.comparison.notification',
				'Добро пожаловать в VibeIDE! Хотите узнать, чем он отличается от Cursor, Continue.dev или Aider? Нажмите кнопку ниже.'
			),
			actions: {
				primary: [{
					id: 'vibeide.showAlternativesComparison',
					label: localize('vibeide.comparison.action', 'Чем мы отличаемся?'),
					tooltip: '',
					class: undefined,
					enabled: true,
					checked: false,
					run: () => {
						// Open the comparison preview modal via the registered command.
						this._commands.executeCommand('vibeide.showAlternativesComparison')
							.catch(err => this._log.error('[VibeIDE] showAlternativesComparison failed', err));
					},
				}],
			},
		});
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	VibeAlternativesComparisonContribution,
	LifecyclePhase.Restored
);

// ── Command ────────────────────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.showAlternativesComparison',
			title: { value: localize('vibeide.showAlternativesComparison', 'Чем мы отличаемся от Cursor/Continue.dev/Aider?'), original: 'How are we different from Cursor/Continue.dev/Aider?' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Capture services synchronously BEFORE any await — a ServicesAccessor is valid only during
		// the synchronous portion of run(); the previous `await import(...)` + accessor.get() after it
		// threw "service accessor is only valid during the invocation of its target method" (the command
		// is auto-triggered in onboarding, so it failed silently on every run). Static imports now.
		const workspaceService = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);
		const modalService = accessor.get(IVibeModalService);

		// Source of truth: the project's comparison doc if present, else the
		// embedded fallback. Read failures degrade silently to the fallback.
		let content = COMPARISON_CONTENT;
		const workspaceRoot = workspaceService.getWorkspace().folders[0]?.uri;
		if (workspaceRoot) {
			const refPath = URI.joinPath(workspaceRoot, 'references', 'v1', 'vibeide-vs-alternatives.md');
			try {
				if (await fileService.exists(refPath)) {
					content = (await fileService.readFile(refPath)).value.toString();
				}
			} catch { /* fall through to embedded content */ }
		}

		// Render as a Markdown preview inside a large modal.
		await modalService.showModal<'ok'>({
			title: localize('vibeide.comparison.modalTitle', 'Чем VibeIDE отличается'),
			body: content,
			bodyMarkdown: true,
			size: 'large',
			dismissible: true,
			buttons: [{ id: 'ok', label: localize('vibeide.comparison.modalClose', 'Закрыть'), role: 'primary' }],
		});
	}
});

const COMPARISON_CONTENT = `# VibeIDE vs Alternatives

## vs Continue.dev

| Feature | Continue.dev | VibeIDE |
|---|---|---|
| Standalone app | VS Code extension | Standalone IDE — no extension tax |
| Transparency Suite | Not built-in | Built-in: context visualizer, audit log, debug prompt |
| Audit log | None | GDPR-exportable, encrypted opt-in |
| Privacy mode | Partial | First-class: stealth mode, fingerprint stripping |
| Agent Plans | None | Persisted .vibe/plans/ with resume after crash |
| Constraints | No | .vibe/constraints.json — hard rules before agent executes |
| Dead Man's Switch | No | Built-in: auto-pause after inactivity |
| Price | Free / open-source | Free / open-source |

## vs Cursor

| Feature | Cursor | VibeIDE |
|---|---|---|
| Open source | No (proprietary) | Yes (MIT) |
| Audit log | No | Yes |
| Privacy mode | Paid | Free, first-class |
| Agent constraints | No | Yes |
| Subscription | Required | No — BYOK |

## vs Aider

| Feature | Aider | VibeIDE |
|---|---|---|
| UI | CLI | Full IDE |
| Transparency | Git diffs | Transparency Suite + audit |
| MCP | No | Yes |

Full comparison: references/v1/vibeide-vs-alternatives.md
`;
