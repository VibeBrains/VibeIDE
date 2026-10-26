/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { providerFromTemplate, PROVIDER_TEMPLATE_PATH } from '../common/providerTemplate.js';
import { vibeDefaultContent } from '../common/vibeDefaults.js';

export interface AddProviderServices {
	readonly fileService: IFileService;
	readonly workspaceContextService: IWorkspaceContextService;
	readonly pathService: IPathService;
	readonly editorService: IEditorService;
}

export type AddProviderResult =
	| { readonly ok: true; readonly resource: URI }
	| { readonly ok: false; readonly message: string };

/**
 * «Добавить провайдера»: копия образца набора в `.vibe/providers/<id>.jsonc` проекта — а без открытой папки в `~/.vibe/providers/` —
 * и открытие копии в редакторе. Образец берётся из зашитого манифеста набора, поэтому кнопка работает и в проекте, который ещё не засеян.
 *
 * @param existingIds id провайдеров, которые уже есть: новый с тем же id затёр бы чужие поля слиянием слоёв
 */
export async function addProviderFromTemplate(services: AddProviderServices, displayName: string, existingIds: readonly string[]): Promise<AddProviderResult> {
	const made = providerFromTemplate(vibeDefaultContent(PROVIDER_TEMPLATE_PATH), displayName);
	if (!made.ok) {
		return {
			ok: false,
			message: made.reason === 'empty-name'
				? localize('vibeide.addProvider.emptyName', "Назовите провайдера латиницей — по имени строится id и имя файла.")
				: localize('vibeide.addProvider.noTemplate', "Образец провайдера не найден в наборе. Обновите окружение `.vibe` командой «Показать новое в окружении из релиза»."),
		};
	}
	const { provider } = made;
	if (existingIds.some(id => id.toLowerCase() === provider.id)) {
		return { ok: false, message: localize('vibeide.addProvider.idTaken', "Провайдер с id «{0}» уже есть — выберите другое имя.", provider.id) };
	}

	const folder = services.workspaceContextService.getWorkspace().folders[0]?.uri;
	const home = folder ? undefined : await services.pathService.userHome();
	const directory = joinPath(folder ?? home!, '.vibe', 'providers');
	const target = joinPath(directory, provider.fileName);
	if (await services.fileService.exists(target)) {
		return { ok: false, message: localize('vibeide.addProvider.fileExists', "Файл {0} уже существует — выберите другое имя.", provider.fileName) };
	}
	await services.fileService.writeFile(target, VSBuffer.fromString(provider.text));
	await services.editorService.openEditor({ resource: target, options: { pinned: true } });
	return { ok: true, resource: target };
}
