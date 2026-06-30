/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface MCPServerEntry {
	id: string;
	name: string;
	description: string;
	repoUrl: string;
	installCommand: string;
	tags: string[];
	verified: boolean;
}

const FEATURED_MCP_SERVERS: MCPServerEntry[] = [
	{
		id: 'github', name: 'GitHub MCP', description: 'GitHub Issues, PRs, and repos',
		repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
		installCommand: 'npx @modelcontextprotocol/server-github', tags: ['git', 'github'], verified: true,
	},
	{
		id: 'filesystem', name: 'Filesystem MCP', description: 'Secure filesystem operations',
		repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
		installCommand: 'npx @modelcontextprotocol/server-filesystem', tags: ['files'], verified: true,
	},
	{
		id: 'postgres', name: 'PostgreSQL MCP', description: 'PostgreSQL database access',
		repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
		installCommand: 'npx @modelcontextprotocol/server-postgres', tags: ['database', 'sql'], verified: true,
	},
	{
		id: 'brave-search', name: 'Brave Search MCP', description: 'Web search via Brave API',
		repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
		installCommand: 'npx @modelcontextprotocol/server-brave-search', tags: ['search', 'web'], verified: true,
	},
];

export const IVibeMCPMarketplaceService = createDecorator<IVibeMCPMarketplaceService>('vibeMCPMarketplaceService');

export interface IVibeMCPMarketplaceService {
	readonly _serviceBrand: undefined;
	getFeaturedServers(): MCPServerEntry[];
	searchServers(query: string): MCPServerEntry[];
	getInstalledServers(): MCPServerEntry[];
	installServer(id: string): Promise<void>;
}

class VibeMCPMarketplaceService extends Disposable implements IVibeMCPMarketplaceService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
	}

	getFeaturedServers(): MCPServerEntry[] {
		return [...FEATURED_MCP_SERVERS];
	}

	searchServers(query: string): MCPServerEntry[] {
		const q = query.toLowerCase();
		return FEATURED_MCP_SERVERS.filter(s =>
			s.name.toLowerCase().includes(q) ||
			s.description.toLowerCase().includes(q) ||
			s.tags.some(t => t.includes(q))
		);
	}

	getInstalledServers(): MCPServerEntry[] {
		const stored = this._storageService.get('vibeide.mcp.installed', StorageScope.APPLICATION) || '[]';
		const ids: string[] = JSON.parse(stored);
		return FEATURED_MCP_SERVERS.filter(s => ids.includes(s.id));
	}

	async installServer(id: string): Promise<void> {
		const server = FEATURED_MCP_SERVERS.find(s => s.id === id);
		if (!server) { return; }
		const stored = this._storageService.get('vibeide.mcp.installed', StorageScope.APPLICATION) || '[]';
		const ids: string[] = JSON.parse(stored);
		if (!ids.includes(id)) {
			ids.push(id);
			this._storageService.store('vibeide.mcp.installed', JSON.stringify(ids), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		vibeLog.info('vibeMCPMarketplace', `[VibeIDE MCP Marketplace] Installed: ${server.name}. Run: ${server.installCommand}`);
	}
}

registerSingleton(IVibeMCPMarketplaceService, VibeMCPMarketplaceService, InstantiationType.Delayed);
