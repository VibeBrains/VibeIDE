/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { VibeCustomCommandsService } from '../../browser/vibeCustomCommandsService.js';
import { IAuditLogService } from '../../common/auditLogService.js';
import { commandFingerprint } from '../../common/projectCommandsFingerprint.js';
import { IVibeConstraintsService } from '../../common/vibeConstraintsService.js';
import { IVibeWorkflowService } from '../../common/vibeWorkflowService.js';

const WORKSPACE = URI.file('/ws');

/** The question the person sees, and the answer they give. */
class StubDialogs extends mock<IDialogService>() {
	readonly questions: string[] = [];
	answer = false;
	override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
		const detail = confirmation.detail;
		this.questions.push(typeof detail === 'string' ? detail : detail?.value ?? '');
		return { confirmed: this.answer };
	}
}

/** A run that got past every gate reaches the terminal; the stub stops it there. */
class StubTerminal extends mock<ITerminalService>() {
	override async createTerminal(): Promise<never> {
		throw new Error('terminal-reached');
	}
}

class StubWorkspaceTrust extends mock<IWorkspaceTrustManagementService>() {
	trusted = true;
	override isWorkspaceTrusted(): boolean {
		return this.trusted;
	}
}

class StubAudit extends mock<IAuditLogService>() {
	override async append(): Promise<void> { }
}

class StubConstraints extends mock<IVibeConstraintsService>() {
	override checkWriteAllowed(): void { }
}

/** The 32-bit FNV-1a of the removed implementation: what an old trust file carries. */
function oldFnv1aOf(command: string, args: string[]): string {
	const text = [command, args.join('\x1f'), '', '', '0'].join('\x1e');
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

suite('VibeCustomCommandsService — разрешение на запуск живёт вне репозитория', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const storage = disposables.add(new InMemoryStorageService());
		const dialogs = new StubDialogs();
		const workspaceTrust = new StubWorkspaceTrust();
		const write = (path: string, text: string) => fileService.writeFile(URI.file(`/ws/${path}`), VSBuffer.fromString(text));
		const writeCommands = (commands: object[]) => write('.vibe/commands.json', JSON.stringify({ vibeVersion: '1', commands }));
		const service = disposables.add(new VibeCustomCommandsService(
			fileService,
			new TestContextService(testWorkspace(WORKSPACE)),
			new TestConfigurationService(),
			new NullLogService(),
			new StubTerminal(),
			dialogs,
			new StubAudit(),
			new class extends mock<IVibeWorkflowService>() { },
			new class extends mock<ISecretStorageService>() { },
			new class extends mock<INotificationService>() { },
			new StubConstraints(),
			storage,
			workspaceTrust,
		));
		return { fileService, storage, dialogs, workspaceTrust, write, writeCommands, service };
	}

	// The repository that brings a command can bring a trust file next to it: the author writes both.
	// Whatever the file says — the removed 32-bit hash or even the exact current fingerprint — it approves nothing.
	test('файл .vibe/commands.trust.json из репозитория не даёт запуск без вопроса', async () => {
		const { fileService, storage, dialogs, write, writeCommands, service } = await setup();
		const old = { id: 'old-hash', name: 'Old hash', command: 'make', args: ['deploy'] };
		const exact = { id: 'exact', name: 'Exact', command: 'make', args: ['release'] };
		await writeCommands([old, exact]);
		await write('.vibe/commands.trust.json', JSON.stringify([
			{ id: old.id, commandShapeHash: oldFnv1aOf(old.command, old.args), trustedAtMs: 1 },
			{ id: exact.id, commandShapeHash: await commandFingerprint(exact), trustedAtMs: 1 },
		]));
		await service.reload();

		const outcomes = [await service.run(old.id), await service.run(exact.id)];

		assert.deepStrictEqual({
			итоги: outcomes.map(o => o.outcome),
			вопросов: dialogs.questions.length,
			оба_впервые: dialogs.questions.every(q => q.includes('впервые')),
			доверенные: await service.getTrustedCommandIds(),
			файлЦел: await fileService.exists(URI.file('/ws/.vibe/commands.trust.json')),
			хранилище: storage.keys(StorageScope.PROFILE, StorageTarget.USER).length + storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE).length,
		}, {
			итоги: ['cancelled', 'cancelled'],
			вопросов: 2,
			оба_впервые: true,
			доверенные: [],
			файлЦел: true,
			хранилище: 0,
		});
	});

	test('одобрение запоминается в хранилище профиля, а в репозиторий ничего не пишется', async () => {
		const { fileService, dialogs, writeCommands, service } = await setup();
		await writeCommands([{ id: 'build', name: 'Build', command: 'npm', args: ['run', 'build'] }]);
		await service.reload();
		dialogs.answer = true;

		const first = await service.run('build');
		const second = await service.run('build');

		assert.deepStrictEqual({
			обаДошлиДоТерминала: [first.reason, second.reason],
			вопросов: dialogs.questions.length,
			доверенные: await service.getTrustedCommandIds(),
			файлВРепозитории: await fileService.exists(URI.file('/ws/.vibe/commands.trust.json')),
		}, {
			обаДошлиДоТерминала: ['terminal-reached', 'terminal-reached'],
			вопросов: 1,
			доверенные: ['build'],
			файлВРепозитории: false,
		});
	});

	test('правка команды после одобрения возвращает вопрос', async () => {
		const { dialogs, writeCommands, service } = await setup();
		await writeCommands([{ id: 'build', name: 'Build', command: 'npm', args: ['run', 'build'] }]);
		await service.reload();
		dialogs.answer = true;
		await service.run('build');

		await writeCommands([{ id: 'build', name: 'Build', command: 'npm', args: ['run', 'build', '--', '--publish'] }]);
		await service.reload();
		await service.run('build');

		assert.deepStrictEqual({
			вопросов: dialogs.questions.length,
			второйВопросПроИзменение: dialogs.questions[1]?.includes('изменилась'),
		}, {
			вопросов: 2,
			второйВопросПроИзменение: true,
		});
	});

	test('в недоверенной папке спрашивает каждый раз и ничего не запоминает', async () => {
		const { dialogs, workspaceTrust, writeCommands, service } = await setup();
		await writeCommands([{ id: 'build', name: 'Build', command: 'npm', args: ['run', 'build'] }]);
		await service.reload();
		dialogs.answer = true;
		await service.run('build');
		assert.deepStrictEqual(await service.getTrustedCommandIds(), ['build'], 'в доверенной папке одобрение сохранилось');

		workspaceTrust.trusted = false;
		await service.run('build');
		await service.run('build');

		assert.deepStrictEqual({
			вопросов: dialogs.questions.length,
			проНедоверенную: dialogs.questions.slice(1).every(q => q.includes('не помечена как доверенная')),
		}, {
			вопросов: 3,
			проНедоверенную: true,
		});
	});
});
