/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolApprovalType } from '../toolsServiceTypes.js';

/**
 * Which approval requests the bridge mirrors into the chat.
 *
 * Note what this does NOT do: nothing here ever approves anything by itself. A request that is
 * not mirrored simply keeps waiting in the IDE, exactly as if the bridge were switched off —
 * auto-approval is a separate, deliberate setting of the IDE and must not be reachable by
 * loosening a Telegram setting.
 */
export type VibeTelegramApprovalPolicy = 'all' | 'dangerous' | 'off';

/** Approval categories treated as dangerous: they run commands or reach outside the workspace. */
const DANGEROUS_APPROVAL_TYPES: readonly ToolApprovalType[] = ['terminal', 'MCP tools'];

/**
 * Whether a pending approval of this category should be sent to the phone.
 *
 * An unknown category (a tool whose approval type we cannot classify) counts as dangerous: the
 * failure mode of showing one extra confirmation is a tap, while the failure mode of hiding it
 * is a run silently stuck until the owner returns to the desk.
 */
export function shouldMirrorApproval(approvalType: ToolApprovalType | undefined, policy: VibeTelegramApprovalPolicy): boolean {
	switch (policy) {
		case 'off':
			return false;
		case 'all':
			return true;
		case 'dangerous':
			return approvalType === undefined || DANGEROUS_APPROVAL_TYPES.includes(approvalType);
	}
}
