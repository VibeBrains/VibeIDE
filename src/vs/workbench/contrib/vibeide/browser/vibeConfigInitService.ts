/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IVibeideModelService } from '../common/vibeideModelService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { getDefaultVibeReadmeMarkdown, VIBE_WORKSPACE_FORMAT_VERSION } from '../common/vibeDefaultWorkspaceReadme.js';
import { serializeProjectCommandsInitTemplate } from '../common/projectCommandsInitTemplate.js';

const VIBE_VERSION = VIBE_WORKSPACE_FORMAT_VERSION;

const DEFAULT_CONSTRAINTS = {
	vibeVersion: VIBE_VERSION,
	rules: [] as unknown[],
	_comment:
		'Правила ограничений VibeIDE (блокировки на уровне IDE, агент их не обходит). Документация: https://github.com/VibeIDETeam/VibeIDE'
};

const DEFAULT_RULES_MD = `# Правила ИИ для проекта

<!-- VibeIDE: vibeVersion: ${VIBE_VERSION} -->

## Руководящие принципы

<!-- Добавьте сюда инструкции для агента: они подмешиваются перед задачами. -->
<!-- Примеры: -->
<!-- - Пишем TypeScript, не JavaScript -->
<!-- - Не больше 100 строк на функцию -->
<!-- - Новые публичные функции — с тестами -->

## Папка \`.vibe/\`

Базовые сценарии «что куда класть» (импорт правил из Cursor, цели, планы, workflows) IDE дополнительно подмешивает в системный контекст; здесь держите **только** специфику **этого** репозитория.
`;

const DEFAULT_IGNORE = `# VibeIDE — игнор для агента (не читает, не индексирует, не подмешивает в контекст)

# Секреты и учётные данные
.env
.env.*
*.key
*.pem
*.p12
secrets/
credentials/

# Сборка и тяжёлые артефакты
dist/
build/
out/
*.min.js
*.bundle.js

# Зависимости
node_modules/
vendor/
`;

const DEFAULT_ALLOWED_MODELS = {
	vibeVersion: VIBE_VERSION,
	models: [] as string[],
	_comment:
		'Оставьте models пустым — разрешены все модели. Иначе укажите whitelist имён, например: ["claude-3-5-sonnet", "gpt-4o"]'
};

const DEFAULT_PINNED = {
	vibeVersion: VIBE_VERSION,
	files: [] as string[],
	symbols: [] as string[],
	_comment: 'Файлы и символы, которые всегда включаются в контекст агента'
};

/**
 * VibeIDE: Initializes .vibe/ directory structure on first workspace open.
 * Creates default configuration files if they don't exist.
 */
export class VibeConfigInitContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeConfigInit';

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVibeideModelService private readonly _vibeideModelService: IVibeideModelService,
		@IVibeideSettingsService private readonly _vibeideSettingsService: IVibeideSettingsService,
	) {
		super();
		this._initVibeDirectory();
	}

	private async _initVibeDirectory(): Promise<void> {
		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) return;

		const workspaceRoot = workspaceFolders[0].uri;
		const vibeDir = joinPath(workspaceRoot, '.vibe');

		try {
			await this._vibeideSettingsService.waitForInitState;

			// Create .vibe/ directory
			await this._fileService.createFolder(vibeDir);
			vibeLog.debug('vibeConfigInit', '.vibe/ directory ready');

			// Create default files (only if they don't exist)
			await this._createIfMissing(
				joinPath(vibeDir, 'constraints.json'),
				JSON.stringify(DEFAULT_CONSTRAINTS, null, '\t') + '\n'
			);

			await this._createIfMissing(
				joinPath(vibeDir, 'rules.md'),
				DEFAULT_RULES_MD
			);
			await this._vibeideModelService.initializeModel(joinPath(vibeDir, 'rules.md'));

			const createReadme = this._vibeideSettingsService.state.globalSettings.createVibeReadmeOnWorkspaceInit !== false;
			if (createReadme) {
				await this._createIfMissing(joinPath(vibeDir, 'README.md'), getDefaultVibeReadmeMarkdown());
			}

			await this._createIfMissing(
				joinPath(vibeDir, 'ignore'),
				DEFAULT_IGNORE
			);

			await this._createIfMissing(
				joinPath(vibeDir, 'allowed-models.json'),
				JSON.stringify(DEFAULT_ALLOWED_MODELS, null, '\t') + '\n'
			);

			await this._createIfMissing(
				joinPath(vibeDir, 'pinned.json'),
				JSON.stringify(DEFAULT_PINNED, null, '\t') + '\n'
			);

			await this._createIfMissing(
				joinPath(vibeDir, 'agent-locks.json'),
				`{\n\t"vibeVersion": "${VIBE_VERSION}",\n\t"locks": []\n}\n`
			);

			// Create snapshots directory for RollbackSnapshotService
			await this._fileService.createFolder(joinPath(vibeDir, 'snapshots'));

			// Create .vibe/goals.md template (writes allowed unless workspace adds deny_write in constraints.json)
			await this._createIfMissing(
				joinPath(vibeDir, 'goals.md'),
				`# Цели сессии\n\n<!-- vibeVersion: ${VIBE_VERSION} -->\n<!-- Опишите цели периода. Агент может обновлять файл по вашей просьбе; чтобы запретить — deny_write для .vibe/goals.md в constraints.json. -->\n\n`
			);

			// Create .vibe/prompts/ directory for Prompt Library
			await this._fileService.createFolder(joinPath(vibeDir, 'prompts'));
			// Example prompt template
			await this._createIfMissing(
				joinPath(vibeDir, 'prompts', 'example.md'),
				`# Пример шаблона промпта\n\n<!-- В чате: /my:example -->\n<!-- Плейсхолдеры: только $LATIN_NAME (буквы A-Z, цифры, _). Остаток строки после команды попадает в $ARGS. -->\n\nПроверь код ниже с точки зрения $ASPECT:\n\n\`\`\`\n$CODE\n\`\`\`\n`
			);

			// Create .vibe/workflows/ directory
			await this._fileService.createFolder(joinPath(vibeDir, 'workflows'));
			await this._createIfMissing(
				joinPath(vibeDir, 'workflows', 'example.json'),
				[
					'{',
					`\t"vibeVersion": "${VIBE_VERSION}",`,
					'\t"name": "example",',
					'\t"description": "Демонстрационный workflow. В чате вызывайте /workflow:example",',
					'\t"steps": [',
					'\t\t{',
					'\t\t\t"name": "Уточнить цель",',
					'\t\t\t"description": "Подтвердить понимание задачи или запросить недостающие детали."',
					'\t\t},',
					'\t\t{',
					'\t\t\t"name": "План",',
					'\t\t\t"description": "Краткий план файлов и шагов без правок до согласования."',
					'\t\t},',
					'\t\t{',
					'\t\t\t"name": "Реализация",',
					'\t\t\t"description": "Выполнить согласованный план; добавить тесты при необходимости."',
					'\t\t}',
					'\t]',
					'}',
					'',
				].join('\n'),
			);

			// Plans live under .vibe/plans/ (project convention)
			await this._fileService.createFolder(joinPath(vibeDir, 'plans'));

			// Create .vibe/commands.json with starter template (roadmap L355)
			await this._createIfMissing(
				joinPath(vibeDir, 'commands.json'),
				serializeProjectCommandsInitTemplate({ vibeVersion: VIBE_VERSION })
			);

			// Create .vibe/skills/ — Agent Skills (SKILL.md + /skill:id + GUIDELINES discovery)
			const skillsDir = joinPath(vibeDir, 'skills');
			await this._fileService.createFolder(skillsDir);
			const skillsExampleDir = joinPath(skillsDir, 'example');
			await this._fileService.createFolder(skillsExampleDir);
			await this._createIfMissing(
				joinPath(skillsExampleDir, 'SKILL.md'),
				`---
name: example
description: Когда нужна короткая демонстрация Agent Skill или проверка команд /skill: в этом проекте.
vibeVersion: ${VIBE_VERSION}
# depends:        # опционально — skill packs (DAG без циклов; см. vibe skills validate)
#   - other-skill
---

# Пример навыка (Agent Skill)

Когда навык активен (пользователь вызвал \`/skill:example\` или задача явно совпадает с описанием):

1. Одним предложением подтвердите цель пользователя.
2. Предложите минимально безопасный план (файлы, команды) без лишних абстракций.
3. Следуйте принятым в репозитории соглашениям по стилю кода.

`,
			);

			vibeLog.info('vibeConfigInit', '.vibe/ configuration initialized');
		} catch (e) {
			// Non-blocking: .vibe/ init failure should never crash the IDE
			vibeLog.warn('vibeConfigInit', 'Failed to initialize .vibe/ directory:', e);
		}
	}

	private async _createIfMissing(uri: URI, content: string): Promise<void> {
		try {
			await this._fileService.stat(uri);
			// File exists — skip
		} catch {
			// File doesn't exist — create it
			try {
				await this._fileService.writeFile(uri, VSBuffer.fromString(content));
				vibeLog.debug('vibeConfigInit', `Created ${uri.fsPath}`);
			} catch (e) {
				vibeLog.warn('vibeConfigInit', `Failed to create ${uri.fsPath}:`, e);
			}
		}
	}
}

registerWorkbenchContribution2(
	VibeConfigInitContribution.ID,
	VibeConfigInitContribution,
	WorkbenchPhase.BlockRestore
);
