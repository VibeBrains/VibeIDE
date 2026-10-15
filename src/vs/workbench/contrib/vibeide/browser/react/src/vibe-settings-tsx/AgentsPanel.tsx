/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor, useMCPServiceState } from '../util/services.js';
import { VibeButtonBgDarken } from '../util/inputs.js';
import { IAcpAgentUpdate, VIBE_ACP_ADD_FROM_REGISTRY_COMMAND_ID, VIBE_ACP_UPDATE_FROM_REGISTRY_COMMAND_ID } from '../../../../common/acp/vibeAcpRegistryImport.js';
import { VibeAgentEntry, VibeAgentSource } from '../../../../common/acp/vibeAgentsFile.js';
import { agentsS } from './vibeSettingsRu.js';

/** Слои от сильного к слабому: при совпадении id побеждает проект, потом машина, потом JetBrains */
const LAYERS: readonly VibeAgentSource[] = ['project', 'machine', 'jetbrains'];

/** Подпись выбора MCP-сервера — компонент, а не константа: scope-tailwind префиксует только литералы в JSX */
const McpChoice = ({ name, checked, disabled, onChange }: { name: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) =>
	<label className='flex items-center gap-1.5 text-xs text-vibe-fg-2 cursor-pointer'>
		<input type='checkbox' className='h-3 w-3' checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
		<span className='font-mono'>{name}</span>
	</label>;

const AgentCard = ({ agent, source, update }: { agent: VibeAgentEntry; source: VibeAgentSource; update: IAcpAgentUpdate | undefined }) => {
	const accessor = useAccessor();
	const registry = accessor.get('IVibeAcpRegistryService');
	const mcpService = accessor.get('IMCPService');
	const commands = accessor.get('ICommandService');
	const mcpState = useMCPServiceState();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const editable = source !== 'jetbrains';
	const exported = agent.mcpServers ?? [];
	const available = Object.keys(mcpState.mcpServerOfName);
	// Имя, записанное в agents.json, но пропавшее из mcp.json, всё равно показывается: иначе его нельзя было бы снять
	const names = useMemo(() => [...new Set([...available, ...exported])], [available, exported]);
	// Пропуск называется вслух: гость без сервера ведёт себя так, будто сервер сломан
	const skipped = useMemo(() => exported.length > 0 ? mcpService.getAcpMcpServers(exported).skipped : [], [mcpService, exported, mcpState]);

	const toggle = useCallback(async (name: string, on: boolean) => {
		setSaving(true);
		setError(undefined);
		try {
			await registry.setMcpServers(agent.id, on ? [...exported, name] : exported.filter(item => item !== name));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [registry, agent.id, exported]);

	return <div className='rounded-lg border border-vibe-border-3 bg-vibe-bg-2 px-3 py-3'>
		<div className='flex flex-wrap items-center justify-between gap-2'>
			<div className='min-w-0'>
				<span className='text-sm font-semibold text-vibe-fg-0'>{agent.name ?? agent.id}</span>
				<span className='ml-2 font-mono text-xs text-vibe-fg-3'>{agent.id}</span>
				{agent.registry && <span className='ml-2 text-xs text-vibe-fg-3'>{agentsS.fromRegistry(agent.registry.version)}</span>}
			</div>
			{update && <VibeButtonBgDarken
				className='px-3 py-1 text-xs'
				title={agentsS.updateTitle}
				onClick={() => { void commands.executeCommand(VIBE_ACP_UPDATE_FROM_REGISTRY_COMMAND_ID, agent.id); }}
			>
				{agentsS.update(agent.name ?? agent.id, update.from, update.to)}
			</VibeButtonBgDarken>}
		</div>
		<div className='mt-1 break-all font-mono text-xs text-vibe-fg-3'>{[agent.command, ...(agent.args ?? [])].join(' ')}</div>

		<div className='mt-3'>
			<div className='text-xs font-medium text-vibe-fg-2'>{agentsS.mcpTitle}</div>
			{editable
				? names.length === 0
					? <div className='mt-1 text-xs text-vibe-fg-3'>{agentsS.mcpNone}</div>
					: <div className='mt-1 flex flex-wrap gap-x-4 gap-y-1'>
						{names.map(name => <McpChoice key={name} name={name} checked={exported.includes(name)} disabled={saving} onChange={on => void toggle(name, on)} />)}
					</div>
				: <div className='mt-1 text-xs text-vibe-fg-3'>{agentsS.mcpReadOnly}</div>}
			{skipped.map(miss => <div key={miss.name} className='mt-1 text-xs text-vibe-warning'>{agentsS.mcpSkipped(miss.name, miss.reason)}</div>)}
			{error && <div className='mt-1 text-xs text-vibe-warning'>{error}</div>}
		</div>
	</div>;
};

/**
 * Реестр внешних агентов: кто есть в трёх файлах, откуда пришёл, что обновилось и какие MCP-серверы проекта он получает
 * Звать агента — в списке моделей чата, группа «Внешние агенты»; здесь он только описывается
 */
export const AgentsPanel = () => {
	const accessor = useAccessor();
	const registry = accessor.get('IVibeAcpRegistryService');
	const importer = accessor.get('IVibeAcpRegistryImportService');
	const commands = accessor.get('ICommandService');
	const editors = accessor.get('IEditorService');

	const [agents, setAgents] = useState<readonly VibeAgentEntry[]>(registry.agents);
	const [problems, setProblems] = useState<readonly string[]>(registry.problems);
	const [updates, setUpdates] = useState<ReadonlyMap<string, IAcpAgentUpdate>>(importer.updates);

	useEffect(() => {
		const listener = registry.onDidChange(() => {
			setAgents(registry.agents);
			setProblems(registry.problems);
		});
		return () => listener.dispose();
	}, [registry]);

	useEffect(() => {
		const listener = importer.onDidChangeUpdates(() => setUpdates(importer.updates));
		// Спрашивается тихо при открытии: реестр, который не прочитался, значит лишь отсутствие бейджей обновления
		void importer.checkUpdates().catch(() => { });
		return () => listener.dispose();
	}, [importer]);

	const openFile = useCallback(async (layer: 'project' | 'machine') => {
		const resource = await registry.fileOf(layer);
		if (resource) { await editors.openEditor({ resource }); }
	}, [registry, editors]);

	return <div className='flex flex-col gap-4 max-w-[640px]'>
		<h4 className='text-vibe-fg-3'>{agentsS.intro}</h4>

		<div className='flex flex-wrap items-center gap-2'>
			<VibeButtonBgDarken className='px-4 py-1' onClick={() => { void commands.executeCommand(VIBE_ACP_ADD_FROM_REGISTRY_COMMAND_ID); }}>
				{agentsS.addFromRegistry}
			</VibeButtonBgDarken>
			<span className='text-xs text-vibe-fg-3'>{agentsS.addFromRegistryHint}</span>
		</div>

		{problems.length > 0 && <div className='rounded-md border border-vibe-border-3 bg-vibe-bg-2 px-3 py-2 text-xs text-vibe-warning'>
			<div className='font-semibold'>{agentsS.problems}</div>
			{problems.map((problem, index) => <div key={index}>{problem}</div>)}
		</div>}

		{agents.length === 0 && <div className='rounded-lg border border-dashed border-vibe-border-3 px-4 py-8 text-center text-sm text-vibe-fg-3'>
			{agentsS.empty}
		</div>}

		{LAYERS.map(layer => {
			const inLayer = agents.filter(agent => registry.sourceOf(agent.id) === layer);
			return <div key={layer} className='flex flex-col gap-2'>
				<div className='flex flex-wrap items-baseline justify-between gap-2'>
					<h3 className='text-base font-medium text-vibe-fg-1'>{agentsS.layerTitle[layer]}</h3>
					{layer !== 'jetbrains' && <button
						className='text-xs text-vibe-fg-3 underline decoration-dotted hover:text-vibe-fg-1'
						onClick={() => void openFile(layer)}
					>
						{agentsS.openFile(layer === 'project' ? '.vibe/agents.json' : '~/.vibe/agents.json')}
					</button>}
				</div>
				<div className='text-xs text-vibe-fg-3'>{agentsS.layerHint[layer]}</div>
				{inLayer.length === 0
					? <div className='text-xs text-vibe-fg-4 italic'>{agentsS.layerEmpty}</div>
					: inLayer.map(agent => <AgentCard key={agent.id} agent={agent} source={layer} update={updates.get(agent.id)} />)}
			</div>;
		})}

		<div className='text-xs text-vibe-fg-3'>
			{agentsS.moreSettings}
			<button
				className='ml-1 underline decoration-dotted hover:text-vibe-fg-1'
				onClick={() => void commands.executeCommand('workbench.action.openSettings', 'vibeide.acp')}
			>
				{agentsS.openAcpSettings}
			</button>
		</div>
	</div>;
};
