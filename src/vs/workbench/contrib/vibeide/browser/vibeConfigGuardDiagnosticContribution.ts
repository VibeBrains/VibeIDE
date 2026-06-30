/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «VibeIDE: Config Guard — показать находки» — a read-only dump of what the Config Guard static
 * scan flagged in `.vibe/providers.json` and `mcp.json` on their last load: severity, rule id,
 * subject (provider id / server name) and the human explanation. This is the «что именно небезопасно
 * в моих конфигах» surface; the scan itself runs automatically at load (see vibeConfigGuard).
 */

import { localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeDynamicProvidersService } from './vibeDynamicProvidersService.js';
import { IMCPService } from '../common/mcpService.js';
import { ConfigGuardFinding, ConfigGuardSeverity } from '../common/vibeConfigGuard.js';

const SEVERITY_ORDER: Record<ConfigGuardSeverity, number> = { critical: 0, high: 1, medium: 2 };
const SEVERITY_BADGE: Record<ConfigGuardSeverity, string> = { critical: '🔴 critical', high: '🟠 high', medium: '🟡 medium' };

/** Render one config source's findings as a markdown section (sorted by severity, then subject). */
function describeSource(title: string, findings: readonly ConfigGuardFinding[]): string {
	const lines: string[] = [`## ${title}`, ''];
	if (findings.length === 0) {
		lines.push('✅ Находок нет.');
		return lines.join('\n');
	}
	const crit = findings.filter(f => f.severity === 'critical').length;
	lines.push(`Находок: **${findings.length}** (критичных: **${crit}**).`);
	lines.push('');
	lines.push('| Severity | Правило | Объект | Описание |');
	lines.push('|---|---|---|---|');
	const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.subject.localeCompare(b.subject));
	for (const f of sorted) {
		// Escape pipes so a message never breaks the markdown table layout.
		const msg = f.message.replace(/\|/g, '\\|');
		lines.push(`| ${SEVERITY_BADGE[f.severity]} | \`${f.ruleId}\` | \`${f.subject}\` | ${msg} |`);
	}
	return lines.join('\n');
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.configGuard.showFindings',
			title: localize2('vibeide.configGuard.showFindings', 'Config Guard — показать находки (.vibe/providers.json, mcp.json)'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Capture services synchronously before any await (ServicesAccessor lifetime rule).
		const dynSvc = accessor.get(IVibeDynamicProvidersService);
		const mcpSvc = accessor.get(IMCPService);
		const configurationService = accessor.get(IConfigurationService);
		const modelSvc = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);

		// Re-read providers.json so the dump reflects the file on disk right now; the MCP scan refreshes
		// on its own file watcher, so its last findings are already current.
		await dynSvc.reload();
		const providerFindings = dynSvc.getLastGuardFindings();
		const mcpFindings = mcpSvc.getLastGuardFindings();

		const enabled = configurationService.getValue<boolean>('vibeide.configGuard.enabled') !== false;
		const mode = configurationService.getValue<string>('vibeide.configGuard.mode') ?? 'warn';
		const total = providerFindings.length + mcpFindings.length;

		const out: string[] = [];
		out.push('# VibeIDE — Config Guard');
		out.push('');
		out.push(`- Статус: **${enabled ? 'включён' : 'выключен'}** (\`vibeide.configGuard.enabled\`)`);
		out.push(`- Режим: **${mode}** (\`vibeide.configGuard.mode\` — "warn" предупреждает, "block" не активирует объекты с critical-находкой)`);
		out.push(`- Всего находок: **${total}**`);
		out.push('');
		if (!enabled) {
			out.push('> ⚠ Config Guard выключен — находки ниже могут быть устаревшими. Включите `vibeide.configGuard.enabled`, чтобы сканировать заново.');
			out.push('');
		}
		out.push('---');
		out.push('');
		out.push(describeSource('.vibe/providers.json', providerFindings));
		out.push('');
		out.push(describeSource('mcp.json', mcpFindings));

		const uri = URI.parse(`untitled://vibeide-configguard-findings-${Date.now()}.md`);
		const ref = await modelSvc.createModelReference(uri);
		ref.object.textEditorModel?.setValue(out.join('\n'));
		ref.dispose();
		await editorService.openEditor({ resource: uri });
	}
});
