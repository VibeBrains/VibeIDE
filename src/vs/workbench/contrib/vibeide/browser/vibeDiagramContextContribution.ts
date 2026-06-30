/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeDiagramContextContribution — @diagram mention: picker + LLM context injection.
 *
 * Flow:
 *   1. User types @diagram or uses command `vibeide.context.pickDiagram` → QuickPick
 *   2. Selected file path inserted as @diagram:path in chat composer
 *   3. On send: `IVibeDiagramContextService.resolveDiagramForContext()` reads the file,
 *      applies privacy gate + size check (reusing IVibeBinaryDiffPolicyService),
 *      returns a context block for the LLM (base64 for vision or text placeholder)
 *
 * Supported image types:  png, jpg, jpeg, gif, webp, svg, bmp, ico
 * Other diagram formats:  drawio, excalidraw, mermaid, plantuml → as text/XML
 * FigJam / remote URLs:   placeholder with link (user opens Figma MCP separately)
 *
 * Privacy:
 *  - Stealth mode → never send binary content to LLM (placeholder only)
 *  - `vibeide.context.diagram.allowBase64` (default: true) — opt-out base64 embedding
 *  - Workspace path stripped via IVibePrivacyStripperService (filename only in context label)
 *  - Size gate: same as Large file policy (200KB); larger → placeholder
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IVibeStealthModeService } from '../common/vibeStealthModeService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.context.diagram.allowBase64': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.context.diagram.allowBase64', 'Разрешить встраивание файлов диаграмм/изображений как base64 в контекст LLM (требуется vision-capable модель). Когда выключено — отправляется только текстовый плейсхолдер.'),
		},
		'vibeide.context.diagram.maxSizeBytes': {
			type: 'number',
			default: 204800, // 200KB — same as Large file policy
			minimum: 1024,
			maximum: 2097152,
			description: localize('vibeide.context.diagram.maxSizeBytes', 'Максимальный размер файла изображения (в байтах) для встраивания как base64 в контекст LLM. Большие файлы заменяются текстовым плейсхолдером.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

/** The MIME type → base64 prefix for inline data URIs */
const MIME_MAP: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
};

/** Extensions that are rendered as text/XML (not base64) */
const TEXT_DIAGRAM_EXTS = new Set(['drawio', 'excalidraw', 'mermaid', 'md', 'puml', 'plantuml', 'txt']);

export interface DiagramContextBlock {
	/** Label shown in the system/user message */
	label: string;
	/** Content injected into LLM context */
	content: string;
	/** True if content is base64 image data (needs vision model) */
	isBase64: boolean;
	/** MIME type if base64 */
	mimeType?: string;
	/** True if stealth/size gate was triggered (placeholder only) */
	isPlaceholder: boolean;
}

export const IVibeDiagramContextService = createDecorator<IVibeDiagramContextService>('vibeDiagramContextService');

export interface IVibeDiagramContextService {
	readonly _serviceBrand: undefined;

	/**
	 * Resolve a diagram mention (path or URL) to a context block for LLM injection.
	 * Handles: images (base64), text diagrams (raw XML/text), remote URLs (placeholder).
	 */
	resolveDiagramForContext(value: string): Promise<DiagramContextBlock>;

	/**
	 * Scan workspace for diagram/image files for the picker.
	 * Returns relative paths.
	 */
	scanWorkspaceDiagramFiles(maxResults?: number): Promise<string[]>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(Object.keys(MIME_MAP));
const EXCLUDED_DIRS = ['node_modules', '.git', 'out', 'dist', '.vibe'];

class VibeDiagramContextService extends Disposable implements IVibeDiagramContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IVibeStealthModeService private readonly _stealth: IVibeStealthModeService,
	) {
		super();
	}

	async resolveDiagramForContext(value: string): Promise<DiagramContextBlock> {
		// Remote URL (FigJam / external)
		if (!value || value.startsWith('http://') || value.startsWith('https://')) {
			const label = value ? `Diagram (remote): ${value}` : 'Diagram (unspecified)';
			return {
				label,
				content: value
					? `[Diagram: remote URL — ${value}. Use Figma MCP or open in browser to include content.]`
					: `[Diagram: use @diagram:path/to/file.png to specify a file, or run vibeide.context.pickDiagram]`,
				isBase64: false,
				isPlaceholder: true,
			};
		}

		const ext = value.split('.').pop()?.toLowerCase() ?? '';
		const filename = value.split(/[\\/]/).pop() ?? value;
		const maxBytes = this._config.getValue<number>('vibeide.context.diagram.maxSizeBytes') ?? 204800;
		const allowBase64 = this._config.getValue<boolean>('vibeide.context.diagram.allowBase64') ?? true;
		const stealthMode = this._stealth.isEnabled();

		// Resolve absolute path
		const workspaceRoot = this._workspace.getWorkspace().folders[0]?.uri;
		const uri = value.startsWith('/') || /^[a-zA-Z]:/.test(value)
			? URI.file(value)
			: workspaceRoot
				? joinPath(workspaceRoot, value)
				: URI.file(value);

		try {
			const stat = await this._fileService.stat(uri);

			// Size gate
			if (stat.size > maxBytes) {
				this._log.warn(`[VibeDiagram] File too large: ${value} (${stat.size} > ${maxBytes})`);
				return {
					label: `Diagram: ${filename}`,
					content: `[Diagram: ${filename} — ${(stat.size / 1024).toFixed(1)} KB, exceeds size limit (${(maxBytes / 1024).toFixed(0)} KB). Reduce file or increase vibeide.context.diagram.maxSizeBytes.]`,
					isBase64: false,
					isPlaceholder: true,
				};
			}

			const file = await this._fileService.readFile(uri);

			// Text/XML diagram formats
			if (TEXT_DIAGRAM_EXTS.has(ext)) {
				const text = file.value.toString().slice(0, maxBytes);
				return {
					label: `Diagram (${ext}): ${filename}`,
					content: `\`\`\`${ext}\n${text}\n\`\`\``,
					isBase64: false,
					isPlaceholder: false,
				};
			}

			// Image formats
			if (IMAGE_EXTS.has(ext)) {
				const mimeType = MIME_MAP[ext] ?? 'image/png';

				// Stealth or user opted out → placeholder
				if (stealthMode || !allowBase64) {
					return {
						label: `Diagram: ${filename}`,
						content: `[Diagram: ${filename} (${mimeType}, ${(stat.size / 1024).toFixed(1)} KB) — base64 embedding ${stealthMode ? 'blocked in stealth mode' : 'disabled by setting vibeide.context.diagram.allowBase64'}]`,
						isBase64: false,
						isPlaceholder: true,
					};
				}

				// SVG → inline as text (no base64 needed; model reads it fine)
				if (ext === 'svg') {
					const svgText = file.value.toString().slice(0, maxBytes);
					return {
						label: `Diagram (SVG): ${filename}`,
						content: `\`\`\`svg\n${svgText}\n\`\`\``,
						isBase64: false,
						isPlaceholder: false,
					};
				}

				// Binary image → base64 data URI
				const bytes = file.value.buffer;
				const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
				return {
					label: `Diagram: ${filename}`,
					content: `data:${mimeType};base64,${b64}`,
					isBase64: true,
					mimeType,
					isPlaceholder: false,
				};
			}

			// Unknown extension → raw text
			const rawText = file.value.toString().slice(0, maxBytes);
			return {
				label: `Diagram (unknown type): ${filename}`,
				content: `\`\`\`\n${rawText}\n\`\`\``,
				isBase64: false,
				isPlaceholder: false,
			};

		} catch (err) {
			this._log.warn(`[VibeDiagram] Cannot read ${value}: ${err}`);
			return {
				label: `Diagram: ${filename}`,
				content: `[Diagram: ${filename} — file not found or cannot be read: ${err}]`,
				isBase64: false,
				isPlaceholder: true,
			};
		}
	}

	async scanWorkspaceDiagramFiles(maxResults = 200): Promise<string[]> {
		const roots = this._workspace.getWorkspace().folders;
		if (roots.length === 0) { return []; }

		const root = roots[0].uri;
		const results: string[] = [];

		const scan = async (dir: URI, depth: number): Promise<void> => {
			if (depth > 5 || results.length >= maxResults) { return; }
			try {
				const stat = await this._fileService.resolve(dir);
				for (const child of stat.children ?? []) {
					if (results.length >= maxResults) { break; }
					const name = child.name;
					if (EXCLUDED_DIRS.includes(name)) { continue; }
					if (child.isDirectory) {
						await scan(child.resource, depth + 1);
					} else {
						const ext = name.split('.').pop()?.toLowerCase() ?? '';
						if (IMAGE_EXTS.has(ext) || TEXT_DIAGRAM_EXTS.has(ext) || ext === 'drawio' || ext === 'excalidraw') {
							// Make path relative to workspace root
							const rel = child.resource.path.replace(root.path, '').replace(/^\//, '');
							results.push(rel);
						}
					}
				}
			} catch { /* skip unreadable dirs */ }
		};

		await scan(root, 0);
		return results.sort();
	}
}

registerSingleton(IVibeDiagramContextService, VibeDiagramContextService, InstantiationType.Delayed);

// ── Commands ──────────────────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.context.pickDiagram',
			title: { value: localize('vibeide.context.pickDiagram', 'Выбрать диаграмму / изображение для контекста агента (@diagram)'), original: 'Pick Diagram / Image for Agent Context (@diagram)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const diagramSvc = accessor.get(IVibeDiagramContextService);
		const quickInputSvc = accessor.get(IQuickInputService);
		const notifSvc = accessor.get(INotificationService);

		// Scan workspace for diagram files
		notifSvc.notify({ severity: Severity.Info, message: localize('vibeide.context.pickDiagram.scanning', 'Сканирование рабочего пространства на диаграммы...') });
		const files = await diagramSvc.scanWorkspaceDiagramFiles(200);

		if (files.length === 0) {
			notifSvc.notify({
				severity: Severity.Info,
				message: localize('vibeide.context.pickDiagram.none', 'В рабочем пространстве не найдено диаграмм или изображений. Поддерживаются: png, svg, jpg, webp, drawio, excalidraw.'),
			});
			return;
		}

		const selected = await quickInputSvc.pick(
			files.map(f => ({
				label: f.split('/').pop() ?? f,
				description: f,
				detail: f,
			})),
			{
				title: localize('vibeide.context.pickDiagram.title', 'Выберите диаграмму для вставки как @diagram:<path>'),
				matchOnDescription: true,
			}
		);

		if (!selected) { return; }

		const path = (selected as { description?: string }).description ?? files[0];
		const mention = `@diagram:${path}`;

		// Copy to clipboard for pasting into chat
		try {
			await navigator.clipboard.writeText(mention);
			notifSvc.notify({
				severity: Severity.Info,
				message: localize('vibeide.context.pickDiagram.copied', 'Скопировано в буфер обмена: {0} — вставьте в чат для включения в контекст агента.', mention),
			});
		} catch {
			notifSvc.notify({
				severity: Severity.Info,
				message: localize('vibeide.context.pickDiagram.use', 'Добавьте в чат: {0}', mention),
			});
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.context.previewDiagram',
			title: { value: localize('vibeide.context.previewDiagram', 'Предпросмотр блока контекста диаграммы (что видит агент)'), original: 'Preview Diagram Context Block' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const diagramSvc = accessor.get(IVibeDiagramContextService);
		const quickInputSvc = accessor.get(IQuickInputService);
		const editorSvc = accessor.get(IEditorService);
		const modelSvc = accessor.get(ITextModelService);

		const path = await quickInputSvc.input({
			prompt: localize('vibeide.context.previewDiagram.prompt', 'Введите путь к диаграмме или URL для предпросмотра'),
			placeHolder: 'src/docs/architecture.png',
		});
		if (!path) { return; }

		const block = await diagramSvc.resolveDiagramForContext(path);
		const preview = [
			`# Diagram Context Preview`,
			``,
			`**Label:** ${block.label}`,
			`**Is base64:** ${block.isBase64}`,
			`**Is placeholder:** ${block.isPlaceholder}`,
			`**MIME type:** ${block.mimeType ?? 'N/A'}`,
			``,
			`## Content (first 2000 chars)`,
			``,
			block.content.slice(0, 2000),
			block.content.length > 2000 ? `\n... [truncated, total ${block.content.length} chars]` : '',
		].join('\n');

		const uri = URI.parse(`untitled://diagram-preview-${Date.now()}.md`);
		const ref = await modelSvc.createModelReference(uri);
		ref.object.textEditorModel?.setValue(preview);
		ref.dispose();
		await editorSvc.openEditor({ resource: uri });
	}
});
