/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Registers the IAgentSessionsService singleton without the 70+ agent-sessions
 * actions and view container that VibeIDE does not expose to the user.
 *
 * Background: chat.contribution.ts has the full agentSessions.contribution.ts
 * commented out (those actions and the LocalAgentsSessionsController are not
 * needed in VibeIDE). However, several platform contributors (MainThreadChatSessions,
 * ChatLifecycleHandler, chatSlashCommands, ConfirmTerminalCommandTool) still depend
 * on the `agentSessions` service token — if it is never registered VS Code's DI
 * container throws "[createInstance] X depends on UNKNOWN service agentSessions"
 * and the settings panel / those contributions fail to instantiate.
 *
 * We register the real AgentSessionsService (Delayed — only instantiated if
 * something actually calls it) so all dependents resolve correctly while the
 * chat UI actions remain hidden.
 */

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAgentSessionsService, AgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';

registerSingleton(IAgentSessionsService, AgentSessionsService, InstantiationType.Delayed);
