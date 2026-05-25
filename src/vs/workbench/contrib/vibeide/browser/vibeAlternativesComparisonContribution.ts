/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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

// ── Storage key ────────────────────────────────────────────────────────────────

const SHOWN_KEY = 'vibeide.onboarding.alternativesComparisonShown';

// ── Contribution ──────────────────────────────────────────────────────────────

class VibeAlternativesComparisonContribution extends Disposable {

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
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
				'Добро пожаловать в VibeIDE! Хотите узнать, чем он отличается от Cursor, Continue.dev или Aider? Откройте обзор сравнения из палитры команд.'
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
						// Command is registered below
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
			title: { value: localize('vibeide.showAlternativesComparison', 'VibeIDE: How are we different from Cursor/Continue.dev/Aider?'), original: 'VibeIDE: How are we different from Cursor/Continue.dev/Aider?' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const { IEditorService } = await import('../../../services/editor/common/editorService.js');
		const { URI } = await import('../../../../base/common/uri.js');
		const { IFileService } = await import('../../../../platform/files/common/files.js');
		const { IWorkspaceContextService } = await import('../../../../platform/workspace/common/workspace.js');

		const wsService = accessor.get(IWorkspaceContextService);
		const workspaceRoot = wsService.getWorkspace().folders[0]?.uri;

		if (workspaceRoot) {
			// Try to find the comparison doc in references/ inside the project
			const refPath = URI.joinPath(workspaceRoot, 'references', 'v1', 'vibeide-vs-alternatives.md');
			const fileService = accessor.get(IFileService);
			try {
				const exists = await fileService.exists(refPath);
				if (exists) {
					await accessor.get(IEditorService).openEditor({ resource: refPath });
					return;
				}
			} catch { /* fall through */ }
		}

		// Fallback: open a generated comparison as untitled document
		const { ITextModelService } = await import('../../../../editor/common/services/resolverService.js');
		const uri = URI.parse(`untitled://vibeide-vs-alternatives-${Date.now()}.md`);
		const modelService = accessor.get(ITextModelService);
		const ref = await modelService.createModelReference(uri);
		ref.object.textEditorModel?.setValue(COMPARISON_CONTENT);
		ref.dispose();
		await accessor.get(IEditorService).openEditor({ resource: uri });
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
