/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Файл MCP-серверов семейства — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/mcpServersFile.json`).
 *
 * Один и тот же `~/.vibe/mcp.json` читают оба продукта. Расхождение в разборе значило бы, что сервер работает в одной IDE
 * и молча пропадает в другой, а жалоба на опечатку видна лишь в одной из двух. Файл читается через `fs`,
 * поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MCPConfigFileEntryJSON } from '../../common/mcpServiceTypes.js';
import { McpFileProblem, McpLayer, mergeMcpLayers, parseMcpServersFile } from '../../common/mcpServersFile.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelRoutesVectors.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

interface StdioView {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly disabled: boolean;
}

interface ServersView {
	readonly stdio: Readonly<Record<string, StdioView>>;
	readonly remote: readonly string[];
}

interface ParseCase {
	readonly name: string;
	readonly lines: readonly string[];
	readonly expect: ServersView & { readonly problems: readonly McpFileProblem[] };
}

interface LayersCase {
	readonly name: string;
	readonly user: readonly string[];
	readonly project: readonly string[];
	readonly expect: ServersView & {
		readonly sourceOfName: Readonly<Record<string, string>>;
		readonly problems: { readonly user: readonly McpFileProblem[]; readonly project: readonly McpFileProblem[] };
	};
}

interface McpServersFileVectors {
	readonly parse: readonly ParseCase[];
	readonly layers: readonly LayersCase[];
}

/** Our entries in the vectors' terms: the stdio ones in their normal form, the remote ones by name */
function viewOf(servers: Readonly<Record<string, MCPConfigFileEntryJSON>>): ServersView {
	const stdio: Record<string, StdioView> = {};
	const remote: string[] = [];
	for (const [name, entry] of Object.entries(servers)) {
		if (entry.command) {
			stdio[name] = { command: entry.command, args: entry.args ?? [], env: entry.env ?? {}, disabled: entry.disabled === true };
		} else {
			remote.push(name);
		}
	}
	return { stdio, remote };
}

suite('mcpServersFile — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: McpServersFileVectors = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'mcpServersFile.json'), 'utf8'));

	test('файл даёт те же серверы и те же жалобы, что в VibeIDEA', () => {
		assert.ok(vectors.parse.length > 0, 'в векторах нет ни одного случая');
		const actual = vectors.parse.map(({ name, lines }) => {
			const parsed = parseMcpServersFile(lines.join('\n'));
			return { name, ...viewOf(parsed.servers), problems: parsed.problems };
		});
		assert.deepStrictEqual(actual, vectors.parse.map(({ name, expect }) => ({ name, ...expect })));
	});

	test('слой проекта ложится на общий файл так же, как в VibeIDEA', () => {
		assert.ok(vectors.layers.length > 0, 'в векторах нет ни одного случая');
		const actual = vectors.layers.map(({ name, user, project }) => {
			const userFile = parseMcpServersFile(user.join('\n'));
			const projectFile = parseMcpServersFile(project.join('\n'));
			const layers: McpLayer[] = [{ source: 'user', servers: userFile.servers }, { source: 'project', servers: projectFile.servers }];
			const merged = mergeMcpLayers(layers);
			return { name, ...viewOf(merged.servers), sourceOfName: merged.sourceOfName, problems: { user: userFile.problems, project: projectFile.problems } };
		});
		assert.deepStrictEqual(actual, vectors.layers.map(({ name, expect }) => ({ name, ...expect })));
	});
});
