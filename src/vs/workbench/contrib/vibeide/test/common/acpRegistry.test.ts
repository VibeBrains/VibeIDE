/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentEntryOf, compareVersions, installPlanOf, parseAcpRegistry, platformTargetOf, registryUpdateOf } from '../../common/acp/acpRegistry.js';

// Shapes copied from the live registry (cdn.agentclientprotocol.com, 2026-09-23), trimmed to what is read.
const SHA = '240a1a464f2a400ae51e9613b7f52b2abb6e7a29759001e9185291325671ccf1';
const REGISTRY = {
	version: '1',
	agents: [
		{ id: 'minimax-code', name: 'MiniMax Code', version: '0.2.7', description: 'MiniMax Code', license: 'MIT', distribution: { npx: { package: '@minimax-ai/code@0.2.7', args: ['acp'] } } },
		{ id: 'fast-agent', name: 'fast-agent', version: '0.10.1', description: '', distribution: { uvx: { package: 'fast-agent-acp==0.10.1', args: ['-x'], env: { FAST_AGENT_MODEL: 'codexplan' } } } },
		{ id: 'amp-acp', name: 'Amp', version: '0.9.0', description: '', distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/amp-acp-darwin-aarch64.tar.gz', cmd: './amp-acp', sha256: SHA } } } },
		{ id: 'no-checksum', name: 'No checksum', version: '1.0.0', description: '', distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.zip', cmd: './a' } } } },
		{ id: 'bzip', name: 'Bzip', version: '1.0.0', description: '', distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.bz2', cmd: './a', sha256: SHA } } } },
		{ id: 'escape', name: 'Escape', version: '1.0.0', description: '', distribution: { binary: { 'darwin-aarch64': { archive: 'https://example.com/a.zip', cmd: '../../bin/sh', sha256: SHA } } } },
		{ id: 'floating', name: 'Floating', version: '1.0.0', description: '', distribution: { npx: { package: 'floating-agent@latest' } } },
		{ name: 'no id', version: '1.0.0' },
	],
};

suite('acpRegistry — импорт агентов из реестра ACP', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const { agents, problems } = parseAcpRegistry(REGISTRY);
	const byId = (id: string) => agents.find(agent => agent.id === id)!;
	const plan = (id: string, target = platformTargetOf('darwin', 'arm64')) => {
		const result = installPlanOf(byId(id), target);
		return result.kind === 'refused' ? `отказ: ${result.reason}` : result.kind === 'package' ? `${result.runner} ${result.spec.package}` : `binary ${result.format} ${result.binary.cmd}`;
	};

	test('сборка выбирается под платформу, и без контрольной суммы бинарь не ставится', () => {
		assert.deepStrictEqual({
			проблемы: problems,
			npx: plan('minimax-code'),
			uvx: plan('fast-agent'),
			бинарь: plan('amp-acp'),
			чужаяПлатформа: plan('amp-acp', platformTargetOf('win32', 'x64')),
			безСуммы: plan('no-checksum'),
			bzip2: plan('bzip'),
			выходЗаАрхив: plan('escape'),
			плавающаяВерсия: plan('floating'),
			неизвестнаяПлатформа: platformTargetOf('freebsd', 'x64'),
		}, {
			проблемы: ['запись №8: нет "id" или "version" — пропущена'],
			npx: 'npx @minimax-ai/code@0.2.7',
			uvx: 'uvx fast-agent-acp==0.10.1',
			бинарь: 'binary tar.gz ./amp-acp',
			чужаяПлатформа: 'отказ: noBuildForPlatform',
			безСуммы: 'отказ: noChecksum',
			bzip2: 'отказ: unsupportedArchive',
			выходЗаАрхив: 'отказ: unsafeCommandPath',
			плавающаяВерсия: 'отказ: unpinnedPackage',
			неизвестнаяПлатформа: undefined,
		});
	});

	test('запись agents.json: точная версия, без --yes, с происхождением из реестра', () => {
		const target = platformTargetOf('darwin', 'arm64');
		assert.deepStrictEqual([
			agentEntryOf(byId('minimax-code'), installPlanOf(byId('minimax-code'), target)),
			agentEntryOf(byId('fast-agent'), installPlanOf(byId('fast-agent'), target)),
			agentEntryOf(byId('amp-acp'), installPlanOf(byId('amp-acp'), target), '/profile/acp-agents/amp-acp/0.9.0/amp-acp'),
			// A binary without an install path has nothing to point at.
			agentEntryOf(byId('amp-acp'), installPlanOf(byId('amp-acp'), target)),
		], [
			{ id: 'minimax-code', name: 'MiniMax Code', command: 'npx', args: ['@minimax-ai/code@0.2.7', 'acp'], registry: { id: 'minimax-code', version: '0.2.7' } },
			{ id: 'fast-agent', name: 'fast-agent', command: 'uvx', args: ['fast-agent-acp==0.10.1', '-x'], env: { FAST_AGENT_MODEL: 'codexplan' }, registry: { id: 'fast-agent', version: '0.10.1' } },
			{ id: 'amp-acp', name: 'Amp', command: '/profile/acp-agents/amp-acp/0.9.0/amp-acp', registry: { id: 'amp-acp', version: '0.9.0' } },
			undefined,
		]);
	});

	test('обновление предлагается только записи из реестра и только на более новую версию', () => {
		const entry = (version: string) => ({ id: 'mm', command: 'npx', registry: { id: 'minimax-code', version } });
		assert.deepStrictEqual({
			старая: registryUpdateOf(entry('0.2.6'), agents)?.to,
			таЖе: registryUpdateOf(entry('0.2.7'), agents),
			новееРеестра: registryUpdateOf(entry('0.3.0'), agents),
			написанаРуками: registryUpdateOf({ id: 'mm', command: 'npx' }, agents),
			числаНеСтроки: compareVersions('0.10.0', '0.9.9'),
		}, {
			старая: '0.2.7',
			таЖе: undefined,
			новееРеестра: undefined,
			написанаРуками: undefined,
			числаНеСтроки: 1,
		});
	});
});
