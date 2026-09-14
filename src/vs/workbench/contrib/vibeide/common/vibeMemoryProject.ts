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
	| { readonly project: null; readonly why: string };

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
	const { project, why } = parsed as { project: unknown; why?: unknown };
	if (typeof project === 'string' && project.length > 0) {
		return { project };
	}
	if (project === null) {
		return { project: null, why: typeof why === 'string' ? why : 'no project in the store' };
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
