/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isMcpServerOnInProject, parseMcpWorkspaceOverrides, withMcpWorkspaceOverride } from '../../common/mcpWorkspaceOverrides.js';
import { MCPUserStateOfName } from '../../common/vibeideSettingsTypes.js';

/**
 * Переключатель MCP-сервера в настройках общий для приложения, поэтому личный сервер нельзя было
 * выключить в одном проекте и оставить в другом. Проектное переопределение сильнее глобального
 * переключателя; без записи сервер живёт по глобальному, а без записи в обоих местах — включён.
 */
suite('mcpWorkspaceOverrides — выключатель MCP-сервера для одного проекта', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const globalOn: MCPUserStateOfName = { memory: { isOn: true }, kostros: { isOn: true } };
	const globalOff: MCPUserStateOfName = { memory: { isOn: true }, kostros: { isOn: false } };

	test('переопределение проекта сильнее глобального переключателя в обе стороны', () => {
		assert.deepStrictEqual(
			{
				onOverGloballyOff: isMcpServerOnInProject('kostros', { kostros: true }, globalOff),
				offOverGloballyOn: isMcpServerOnInProject('kostros', { kostros: false }, globalOn),
			},
			{ onOverGloballyOff: true, offOverGloballyOn: false },
		);
	});

	test('без проектной записи действует глобальный переключатель', () => {
		assert.deepStrictEqual(
			{
				globallyOn: isMcpServerOnInProject('memory', {}, globalOn),
				globallyOff: isMcpServerOnInProject('kostros', {}, globalOff),
				globallyAbsent: isMcpServerOnInProject('kostros', {}, {}),
			},
			{ globallyOn: true, globallyOff: false, globallyAbsent: true },
		);
	});

	test('правка карты не меняет исходную и убирает запись вместо записи false', () => {
		const before = { kostros: false };
		assert.deepStrictEqual(
			{
				added: withMcpWorkspaceOverride(before, 'memory', true),
				cleared: withMcpWorkspaceOverride(before, 'kostros', undefined),
				before,
			},
			{ added: { kostros: false, memory: true }, cleared: {}, before: { kostros: false } },
		);
	});

	test('битая карта и не-булевы значения читаются как отсутствие переопределения', () => {
		assert.deepStrictEqual(
			{
				broken: parseMcpWorkspaceOverrides('{not json'),
				notAnObject: parseMcpWorkspaceOverrides('["kostros"]'),
				mixed: parseMcpWorkspaceOverrides('{"kostros":false,"memory":"on"}'),
				empty: parseMcpWorkspaceOverrides(undefined),
			},
			{ broken: {}, notAnObject: {}, mixed: { kostros: false }, empty: {} },
		);
	});
});
