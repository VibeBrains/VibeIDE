/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Точка входа процесса-песочницы Code Mode
 *
 * Отдельный utility-процесс запускается на каждый скрипт: так зависание, утечка памяти или
 * убийство по таймауту не задевают ни окно, ни главный процесс. Один процесс — один прогон,
 * поэтому состояние между вызовами модели не переносится
 */

import { generateUuid } from '../../../../../base/common/uuid.js';
import { isUtilityProcess, ParentPort } from '../../../../../base/parts/sandbox/node/electronTypes.js';
import { CodeModeWorkerRequest, CodeModeWorkerResponse, ICodeModeOutcome, codeModeErrorMessage } from '../../common/codeMode/codeModeIpc.js';
import { ICodeModeVmToolAnswer, runCodeModeScript } from './codeModeVm.js';

function main(parentPort: ParentPort): void {
	const pending = new Map<string, (answer: ICodeModeVmToolAnswer) => void>();
	const post = (message: CodeModeWorkerResponse) => parentPort.postMessage(message);

	parentPort.on('message', async event => {
		const message = event.data as CodeModeWorkerRequest;
		if (message.t === 'toolResult') {
			const resolve = pending.get(message.callId);
			if (resolve) {
				pending.delete(message.callId);
				resolve({ ok: message.ok, text: message.text });
			}
			return;
		}
		if (message.t !== 'run') {
			return;
		}
		let outcome: ICodeModeOutcome;
		try {
			outcome = await runCodeModeScript({
				script: message.script,
				timeoutMs: message.timeoutMs,
				maxCalls: message.maxCalls,
				callTool: (tool, argsJson) => new Promise<ICodeModeVmToolAnswer>(resolve => {
					const callId = generateUuid();
					pending.set(callId, resolve);
					post({ t: 'toolCall', executionId: message.executionId, callId, tool, argsJson });
				}),
			});
		} catch (error) {
			outcome = { logs: [], calls: [], error: codeModeErrorMessage(error) };
		}
		post({ t: 'done', executionId: message.executionId, outcome });
	});
}

if (isUtilityProcess(process)) {
	main(process.parentPort);
} else {
	throw new Error('codeModeSandboxMain must run inside an Electron utility process');
}
