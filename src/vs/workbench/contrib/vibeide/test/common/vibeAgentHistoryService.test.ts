/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AuditEvent, IAuditLogService } from '../../common/auditLogService.js';
import { VibeAgentHistoryService } from '../../common/vibeAgentHistoryService.js';
import { vibeLog } from '../../common/vibeLog.js';

class DisabledAuditLog implements IAuditLogService {
	declare readonly _serviceBrand: undefined;
	async append(_event: AuditEvent): Promise<void> { }
	isEnabled(): boolean { return false; }
	async exportAll(): Promise<string> { return '[]'; }
	async deleteAll(): Promise<void> { }
	async queryRecent(_limit?: number): Promise<AuditEvent[]> { return []; }
}

suite('vibeAgentHistoryService — recorded actions must be readable back', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// `recordAction` traces through `vibeLog`, and the runner fails any test that writes to the
	// console. Silence it for the suite and restore the development default afterwards.
	setup(() => vibeLog.configure({ enabled: false }));
	teardown(() => vibeLog.configure({ enabled: true }));

	test('an action filed under the service session shows up in the current session', () => {
		const history = disposables.add(new VibeAgentHistoryService(new DisabledAuditLog()));

		history.recordAction({
			sessionId: history.getCurrentSessionId(),
			action: 'refactor:rename',
			description: 'Переименование символа',
			files: ['src/app.ts'],
			canRollback: true,
		});

		// The regression this guards: a caller minting its own `session-<Date.now()>` id wrote
		// into a bucket `getCurrentSessionHistory()` never reads, so the command reported an
		// empty history while the action sat in the map.
		const [current, foreign] = [
			history.getCurrentSessionHistory(),
			history.getSessionHistory('session-42'),
		];

		assert.deepStrictEqual(
			[current.length, current[0]?.action, current[0]?.files, foreign.length, history.getAllSessions().length],
			[1, 'refactor:rename', ['src/app.ts'], 0, 1],
		);
	});
});
