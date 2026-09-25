/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which VibeMemory project a workspace folder writes to.
 *
 * WHY the IDE asks and not the model: the memory server runs from the home folder (see
 * vibeMemoryServerDiscovery.ts), so a write without `project` is refused. The name cannot be guessed
 * from the folder — the store names a repository by its git root, and the owner may rename or exclude
 * folders by rule. VibeMemory answers that with the `project_resolve` tool; the IDE calls it once per
 * folder and states the answer in the system prompt, so the model never has to remember the step.
 *
 * Pure: the server's text answer in, prompt lines out.
 */

/** The read-only tool of the memory server that names a folder's project. */
export const MEMORY_PROJECT_RESOLVE_TOOL = 'project_resolve';

export type MemoryProjectAnswer =
	| { readonly project: string }
	/** `projects` — what a team's host offers instead: it cannot see this disk, so the model must name one */
	| { readonly project: null; readonly why: string; readonly projects?: readonly string[] };

/** A team's memory server and what its `project_resolve` answered */
export interface TeamMemoryProject {
	readonly serverName: string;
	/** How the model sees the server's tools: `<server>_` */
	readonly toolPrefix: string;
	readonly answer: MemoryProjectAnswer;
}

/** The server's JSON answer; undefined when it is not one — a guessed name is worse than none. */
export function parseProjectResolveAnswer(text: string): MemoryProjectAnswer | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || !('project' in parsed)) {
		return undefined;
	}
	const { project, why, projects } = parsed as { project: unknown; why?: unknown; projects?: unknown };
	if (typeof project === 'string' && project.length > 0) {
		return { project };
	}
	if (project === null) {
		const offered = Array.isArray(projects) ? projects.filter((name): name is string => typeof name === 'string' && name.length > 0) : [];
		return { project: null, why: typeof why === 'string' ? why : 'no project in the store', ...(offered.length > 0 ? { projects: offered } : {}) };
	}
	return undefined;
}

/** Prompt lines for the folders the server answered for; undefined when it answered for none. */
export function memoryProjectPromptLines(entries: readonly { readonly folder: string; readonly answer: MemoryProjectAnswer | undefined }[]): string | undefined {
	const lines = entries.flatMap(({ folder, answer }) => {
		if (!answer) {
			return [];
		}
		return answer.project !== null
			? [`- ${folder}: VibeMemory project "${answer.project}" — pass project: "${answer.project}" to memory tools that write.`]
			: [`- ${folder}: no VibeMemory project (${answer.why}) — do not write to memory for this folder.`];
	});
	return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Prompt lines for the teams' memory; undefined when no team answered
 * A team's host sees no folder, so every write names its project, and only one the token may use
 */
export function teamMemoryPromptLines(teams: readonly TeamMemoryProject[]): string | undefined {
	const lines = teams.map(({ serverName, toolPrefix, answer }) => {
		if (answer.project !== null) {
			return `- ${serverName} (tools ${toolPrefix}*): team memory, project "${answer.project}" — pass project: "${answer.project}" to tools that write.`;
		}
		return answer.projects && answer.projects.length > 0
			? `- ${serverName} (tools ${toolPrefix}*): team memory; it cannot see this disk — pass project explicitly on every write, one of: ${answer.projects.map(name => `"${name}"`).join(', ')}.`
			: `- ${serverName} (tools ${toolPrefix}*): team memory with no project this token may write to (${answer.why}) — do not write to it.`;
	});
	return lines.length > 0 ? lines.join('\n') : undefined;
}
