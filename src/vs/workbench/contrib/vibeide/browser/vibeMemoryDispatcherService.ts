/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Memory dispatcher (roadmap L1057) — routes a generic write request to the
 * right layer using the pure `routeMemoryWrite` helper, then forwards to:
 *
 *  - explicit / long-term → `IMemoriesService.addMemory` (project-scoped,
 *    persists via storage; lives across sessions; visible in vibe doctor)
 *  - short-term → `IVibeSessionMemoryService.append` (per-thread, decays
 *    after 7d, never leaves the workspace)
 *
 * Caller passes scope hints; the router picks the layer deterministically.
 * Pure decision logic is 100% in `common/memoryLayerRouter.ts` (already
 * unit-tested 14 ways).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMemoriesService } from '../common/memoriesService.js';
import { IVibeSessionMemoryService } from '../common/vibeSessionMemoryService.js';
import { routeMemoryWrite, MemoryLayer } from '../common/memoryLayerRouter.js';

export interface MemoryWriteInput {
	readonly key: string;
	readonly value: string;
	readonly userExplicit: boolean;
	readonly workspaceScoped: boolean;
	readonly threadOnly: boolean;
	readonly threadId?: string;
	readonly ttlHintMs?: number;
	readonly tags?: readonly string[];
}

export interface MemoryWriteOutcome {
	readonly layer: MemoryLayer;
	readonly reason: string;
	readonly skipped?: 'missing-threadId-for-short-term';
}

export const IVibeMemoryDispatcherService = createDecorator<IVibeMemoryDispatcherService>('vibeMemoryDispatcherService');

export interface IVibeMemoryDispatcherService {
	readonly _serviceBrand: undefined;
	dispatch(input: MemoryWriteInput): Promise<MemoryWriteOutcome>;
}

class VibeMemoryDispatcherService extends Disposable implements IVibeMemoryDispatcherService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IMemoriesService private readonly _memories: IMemoriesService,
		@IVibeSessionMemoryService private readonly _session: IVibeSessionMemoryService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
	}

	async dispatch(input: MemoryWriteInput): Promise<MemoryWriteOutcome> {
		const decision = routeMemoryWrite(
			{
				userExplicit: input.userExplicit,
				workspaceScoped: input.workspaceScoped,
				threadOnly: input.threadOnly,
				ttlHintMs: input.ttlHintMs,
			},
			Date.now(),
		);

		switch (decision.layer) {
			case 'explicit':
			case 'long-term': {
				// `preference` is the closest existing MemoryEntry type for
				// user-explicit or scoped facts that should persist. Other
				// types ('decision' / 'recentFile' / 'context') are reserved
				// for callers that know they want those — this dispatcher
				// keeps the type stable so the routing is the only variable.
				await this._memories.addMemory('preference', input.key, input.value, input.tags ? [...input.tags] : undefined);
				return { layer: decision.layer, reason: decision.reason };
			}
			case 'short-term': {
				if (!input.threadId) {
					this._log.warn(`[VibeMemoryDispatcher] short-term routing requires threadId; dropping write for key=${input.key}`);
					return { layer: decision.layer, reason: decision.reason, skipped: 'missing-threadId-for-short-term' };
				}
				await this._session.append({
					threadId: input.threadId,
					kind: 'observation',
					content: `${input.key}: ${input.value}`,
				});
				return { layer: decision.layer, reason: decision.reason };
			}
		}
	}
}

registerSingleton(IVibeMemoryDispatcherService, VibeMemoryDispatcherService, InstantiationType.Delayed);
