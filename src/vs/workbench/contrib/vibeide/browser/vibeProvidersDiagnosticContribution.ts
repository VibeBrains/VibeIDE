/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «VibeIDE: Показать распознанные провайдеры (.vibe/providers.json)» — diagnostic dump of what the
 * dynamic-providers service actually parsed & resolved: file status, parse error, per-provider kind
 * (definition / override / extends-builtin), active flags, baseURL/auth/models, and all warnings.
 * This is the «понять где проблема» surface for the providers format before transport is wired.
 */

import { localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeDynamicProvidersService, ResolvedProviderEntry } from './vibeDynamicProvidersService.js';
import { normalizeAuth } from '../common/vibeProvidersFile.js';
import { providerNames, displayInfoOfProviderName } from '../common/vibeideSettingsTypes.js';

/** The built-in provider ids users can copy for `id` (override) / `extends` / `apiKeyRef`. Pulled
 *  from `providerNames` (single source of truth) so this never drifts from the actual provider set. */
function describeBuiltinIds(): string {
	const lines: string[] = [];
	lines.push('## Встроенные провайдеры — id для `override` / `extends` / `apiKeyRef`');
	lines.push('');
	lines.push('Скопируйте `id` ниже: совпадение с ним в поле `"id"` патчит встроенного провайдера; `"extends": "<id>"` клонирует его; `"apiKeyRef": "<id>"` берёт его сохранённый ключ.');
	lines.push('');
	lines.push('| id | Провайдер |');
	lines.push('|---|---|');
	for (const id of providerNames) {
		lines.push(`| \`${id}\` | ${displayInfoOfProviderName(id).title} |`);
	}
	return lines.join('\n');
}

function describeProvider(p: ResolvedProviderEntry): string {
	const e = p.entry;
	const lines: string[] = [];
	const active = e.active !== false;
	lines.push(`### ${active ? '🟢' : '⚪'} \`${p.id}\` — ${p.kind}${p.extendsBuiltin ? ` (← ${p.extendsBuiltin})` : ''}`);
	lines.push('');
	lines.push(`- active: **${active}**`);
	if (e.name) { lines.push(`- name: ${e.name}`); }
	if (p.kind !== 'override') {
		lines.push(`- baseURL: ${e.baseURL ?? '— (наследуется/не задан)'}`);
		const auth = normalizeAuth(e.auth);
		lines.push(`- auth: ${auth.type}${auth.type === 'header' || auth.type === 'query' ? ` (${auth.name})` : ''}`);
		lines.push(`- apiKey: ${e.apiKeyEnv ? `env:${e.apiKeyEnv}` : e.apiKeyRef ? `ref:${e.apiKeyRef}` : '— (не задан)'}`);
	}
	const fetchSpec = e.models?.fetch;
	const statics = e.models?.static ?? [];
	lines.push(`- models: fetch=${fetchSpec === undefined ? '—' : JSON.stringify(fetchSpec)}, static=${statics.length}`);
	for (const m of statics) {
		const mActive = m.active !== false;
		lines.push(`  - ${mActive ? '🟢' : '⚪'} \`${m.id}\`${m.default ? ' · default' : ''}${m.pinned ? ' · pinned' : ''}${m.contextWindow ? ` · ${m.contextWindow.toLocaleString()} ctx` : ''}${m.toolFormat ? ` · tool:${m.toolFormat}` : ''}${m.vision ? ' · vision' : ''}`);
	}
	return lines.join('\n');
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.providers.showResolved',
			title: localize2('vibeide.providers.showResolved', 'Показать распознанные провайдеры (.vibe/providers.json)'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Capture services synchronously before any await (ServicesAccessor lifetime rule).
		const dynSvc = accessor.get(IVibeDynamicProvidersService);
		const modelSvc = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);

		await dynSvc.reload();
		const s = dynSvc.getState();

		const out: string[] = [];
		out.push('# VibeIDE — распознанные провайдеры (.vibe/providers.json)');
		out.push('');
		if (!s.fileExists) {
			out.push('Файл `.vibe/providers.json` отсутствует. Скопируйте `.vibe/providers.example.jsonc` и переименуйте.');
		} else if (s.parseError) {
			out.push(`❌ Файл не распознан: \`${s.parseError}\``);
		} else {
			out.push(`Провайдеров: **${s.providers.length}**.`);
			out.push('');
			out.push('Легенда: `definition` — новый провайдер · `override` — патч встроенного · `extends-builtin` — клон встроенного.');
			out.push('');
			for (const p of s.providers) { out.push(describeProvider(p)); out.push(''); }
		}
		if (s.warnings.length > 0) {
			out.push('---');
			out.push('## ⚠ Предупреждения');
			for (const w of s.warnings) { out.push(`- ${w}`); }
		} else if (s.fileExists && !s.parseError) {
			out.push('---');
			out.push('Предупреждений нет.');
		}
		out.push('');
		out.push('---');
		out.push('');
		out.push(describeBuiltinIds());

		const uri = URI.parse(`untitled://vibeide-providers-resolved-${Date.now()}.md`);
		const ref = await modelSvc.createModelReference(uri);
		ref.object.textEditorModel?.setValue(out.join('\n'));
		ref.dispose();
		await editorService.openEditor({ resource: uri });
	}
});
