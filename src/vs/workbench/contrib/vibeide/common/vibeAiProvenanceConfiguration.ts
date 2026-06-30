/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

/**
 * Vibe AI provenance settings.
 *
 * `vibeide.aiProvenance.markGeneratedCode` — when true, agent-generated blocks are
 * tagged with a single-line comment (`// @ai-generated <model> <ts>`) using the
 * comment syntax of the file's language.
 *
 * Default OFF for privacy mode (the marker leaks model id into committed code) and
 * ON for transparency mode. Users override per-workspace.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.aiProvenance',
	title: localize('vibeide.aiProvenance.title', 'AI provenance'),
	type: 'object',
	properties: {
		'vibeide.aiProvenance.markGeneratedCode': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.aiProvenance.markGeneratedCode',
				'Помечать блоки, сгенерированные агентом, однострочным комментарием `// @ai-generated <модель> <время>` (синтаксис комментария по языку файла). Полезно для прозрачности code review; в privacy-режиме рекомендуется выключить, потому что метка попадает в коммиты и раскрывает использованную модель.'),
			scope: ConfigurationScope.RESOURCE,
		},
	},
});

/**
 * Comment syntaxes per language id, used by `formatProvenanceMarker`. Block-only
 * languages (HTML/CSS/MD) get the block form; everything else gets the line form.
 */
type CommentSyntax =
	| { kind: 'line'; prefix: string }
	| { kind: 'block'; open: string; close: string };

const LANGUAGE_COMMENT_SYNTAX: Readonly<Record<string, CommentSyntax>> = Object.freeze({
	typescript: { kind: 'line', prefix: '//' },
	typescriptreact: { kind: 'line', prefix: '//' },
	javascript: { kind: 'line', prefix: '//' },
	javascriptreact: { kind: 'line', prefix: '//' },
	go: { kind: 'line', prefix: '//' },
	rust: { kind: 'line', prefix: '//' },
	java: { kind: 'line', prefix: '//' },
	csharp: { kind: 'line', prefix: '//' },
	cpp: { kind: 'line', prefix: '//' },
	c: { kind: 'line', prefix: '//' },
	swift: { kind: 'line', prefix: '//' },
	kotlin: { kind: 'line', prefix: '//' },
	dart: { kind: 'line', prefix: '//' },
	php: { kind: 'line', prefix: '//' },
	scala: { kind: 'line', prefix: '//' },
	python: { kind: 'line', prefix: '#' },
	ruby: { kind: 'line', prefix: '#' },
	shellscript: { kind: 'line', prefix: '#' },
	bash: { kind: 'line', prefix: '#' },
	yaml: { kind: 'line', prefix: '#' },
	dockerfile: { kind: 'line', prefix: '#' },
	powershell: { kind: 'line', prefix: '#' },
	makefile: { kind: 'line', prefix: '#' },
	toml: { kind: 'line', prefix: '#' },
	r: { kind: 'line', prefix: '#' },
	perl: { kind: 'line', prefix: '#' },
	sql: { kind: 'line', prefix: '--' },
	lua: { kind: 'line', prefix: '--' },
	html: { kind: 'block', open: '<!--', close: '-->' },
	xml: { kind: 'block', open: '<!--', close: '-->' },
	svg: { kind: 'block', open: '<!--', close: '-->' },
	markdown: { kind: 'block', open: '<!--', close: '-->' },
	css: { kind: 'block', open: '/*', close: '*/' },
	scss: { kind: 'block', open: '/*', close: '*/' },
	less: { kind: 'block', open: '/*', close: '*/' },
	jsonc: { kind: 'line', prefix: '//' },
});

const DEFAULT_SYNTAX: CommentSyntax = { kind: 'line', prefix: '//' };

/**
 * Pure helper. Produces the AI-provenance marker line for a given language id.
 *
 *   formatProvenanceMarker('typescript', 'claude-sonnet-4-6', '2026-05-08T12:34:56Z')
 *     → '// @ai-generated claude-sonnet-4-6 2026-05-08T12:34:56Z'
 *
 *   formatProvenanceMarker('html', 'claude-sonnet-4-6', '2026-05-08')
 *     → '<!-- @ai-generated claude-sonnet-4-6 2026-05-08 -->'
 *
 * Unknown languages default to `//`. Callers handle the "is this language supported"
 * decision themselves; this helper never refuses a language.
 */
export function formatProvenanceMarker(languageId: string, modelId: string, isoTimestamp: string): string {
	const syntax = LANGUAGE_COMMENT_SYNTAX[languageId.toLowerCase()] ?? DEFAULT_SYNTAX;
	const body = `@ai-generated ${modelId} ${isoTimestamp}`;
	if (syntax.kind === 'line') {
		return `${syntax.prefix} ${body}`;
	}
	return `${syntax.open} ${body} ${syntax.close}`;
}

/**
 * Pure helper. Determines whether the marker should be inserted given the user's
 * config + the file's language. Privacy mode caller can OR this with its own
 * suppress-list. Returns true when the user has explicitly enabled marking.
 */
export function shouldMarkProvenance(setting: unknown): boolean {
	return setting === true;
}
