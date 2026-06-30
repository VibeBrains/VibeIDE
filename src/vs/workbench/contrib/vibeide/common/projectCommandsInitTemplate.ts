/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — first-run init template generator
 * (roadmap §"Init: при первом открытии workspace без `.vibe/commands.json` —
 * создать пример `example` (`echo Hello from VibeIDE`) с RU-комментариями").
 *
 * Pure helper — `vscode`-free — so the bytes-on-disk shape can be unit-tested
 * without `IFileService`. Caller is responsible for the atomic temp+rename
 * write and for dispatching the toast «Закрепить команду в верхнем баре?».
 */

import { ProjectCommandsFile } from './projectCommandsTypes.js';

export interface InitTemplateOptions {
	readonly vibeVersion: string;
}

/**
 * The example command that ships with the empty workspace template. Pinned by
 * default so the user immediately sees the top-bar contribution.
 */
export const PROJECT_COMMANDS_INIT_EXAMPLE_ID = 'example';

export function buildProjectCommandsInitTemplate(opts: InitTemplateOptions): ProjectCommandsFile {
	return {
		vibeVersion: opts.vibeVersion,
		commands: [
			{
				id: PROJECT_COMMANDS_INIT_EXAMPLE_ID,
				name: 'Hello from VibeIDE',
				description: 'Пример проектной команды. Замените на свою (например, npm run build).',
				command: 'echo',
				args: ['Hello', 'from', 'VibeIDE'],
				terminal: 'integrated',
				pinned: true,
				order: 0,
			},
		],
	};
}

/**
 * Serialise to the on-disk JSON shape with RU `_comment` fields. JSON does not
 * support real comments, so VibeIDE convention is leading `_comment*` keys
 * (preserved by the JSONC-aware loader, ignored by strict decoder).
 */
export function serializeProjectCommandsInitTemplate(opts: InitTemplateOptions): string {
	const file = buildProjectCommandsInitTemplate(opts);
	const annotated: Record<string, unknown> = {
		_comment_top: 'VibeIDE Project Commands — workspace-first shell shortcuts.',
		_comment_docs: 'Документация: docs/v1/project-commands.md (разделы security, миграция из tasks.json).',
		vibeVersion: file.vibeVersion,
		commands: file.commands.map(c => ({
			_comment_id: 'id: латиница, цифры, дефисы; до 64 символов; уникален в файле.',
			_comment_pin: 'pinned:true показывает кнопку в верхнем баре; order сортирует слева направо.',
			...c,
		})),
	};
	return JSON.stringify(annotated, null, '\t') + '\n';
}
