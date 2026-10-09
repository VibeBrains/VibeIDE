/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Граф проекта» — the code graph drawn for a person, after graphify (github.com/Graphify-Labs/graphify)
 *
 * The agent has queried this graph since July; a human never saw it, and «как устроен проект» was answered by reading
 * The tab opens on subsystems, not files: a repository is thousands of files, a picture of them all is noise,
 * And the layout pairs every node with every other, so a subsystem is opened one at a time instead
 * The side panel is the report: the files everything flows through, the bridges nobody expects, the files nothing touches
 */

import * as DOM from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { editorErrorForeground, editorForeground, editorWarningForeground, registerColor, transparent } from '../../../../../platform/theme/common/colorRegistry.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ColorScheme, isDark } from '../../../../../platform/theme/common/theme.js';
import { IColorTheme, IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorOpenContext, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	ALL_LINKS_FILTER,
	analyzeCodeGraph,
	CodeGraphAnalysis,
	CodeGraphViewFilter,
	FileLinkKind,
	overviewView,
	subsystemOfNodeId,
	subsystemView,
} from '../../common/codeGraph/codeGraphAnalysis.js';
import { VIBE_COMMAND_CATEGORY } from '../../common/vibeCommandCategory.js';
import { IRepoIndexerService } from '../repoIndexerService.js';
import { VibeGraphCanvas } from '../vibeGraphCanvas.js';
import { IVibeCodeGraphService } from './vibeCodeGraphService.js';

const $ = DOM.$;

export const VIBE_PROJECT_GRAPH_OPEN_CMD = 'vibeide.projectGraph.open';

/** Zoom from which subsystem names show on the map */
const OVERVIEW_LABEL_MIN_SCALE = 0.2;

/** Index updates come in bursts (a save touches many files); one repaint per burst */
const REFRESH_DELAY_MS = 800;

/** Rows of the isolated-files list before it says «и ещё N» */
const ISOLATED_SHOWN = 15;

const VIBE_PROJECT_GRAPH_EDGE = registerColor(
	'vibeide.projectGraph.edge',
	transparent(editorForeground, 0.35),
	localize('vibeide.projectGraph.edge', "Цвет связей в графе проекта."),
);

/**
 * A subsystem's colour: hues spread by the golden angle, so neighbouring ids never look alike
 * Subsystems are found at runtime and there can be dozens, more than any fixed palette of theme tokens,
 * So lightness follows the theme instead: light enough on a dark editor, dark enough on a light one
 */
function subsystemColor(group: string, theme: IColorTheme): string {
	const id = Number(group);
	const hue = Number.isFinite(id) ? (id * 137.508) % 360 : 210;
	const dark = isDark(theme.type);
	const contrast = theme.type === ColorScheme.HIGH_CONTRAST_DARK || theme.type === ColorScheme.HIGH_CONTRAST_LIGHT;
	const lightness = dark ? (contrast ? 70 : 62) : (contrast ? 32 : 42);
	return `hsl(${hue.toFixed(1)}, 58%, ${lightness}%)`;
}

export class VibeProjectGraphInput extends EditorInput {
	static readonly ID = 'workbench.input.vibeProjectGraph';
	static readonly RESOURCE = URI.from({ scheme: 'vibe-project-graph', path: 'graph' });

	readonly resource = VibeProjectGraphInput.RESOURCE;

	override get typeId(): string {
		return VibeProjectGraphInput.ID;
	}

	override getName(): string {
		return localize('vibeProjectGraph.tab', "Граф проекта");
	}

	override getIcon(): ThemeIcon {
		return Codicon.graph;
	}
}

export class VibeProjectGraphPane extends EditorPane {
	static readonly ID = 'workbench.editor.vibeProjectGraph';

	private _host: HTMLElement | undefined;
	private _main: HTMLElement | undefined;
	private _canvasHost: HTMLElement | undefined;
	private _canvas: VibeGraphCanvas | undefined;
	private _back: HTMLElement | undefined;
	private _title: HTMLElement | undefined;
	private _status: HTMLElement | undefined;
	private _empty: HTMLElement | undefined;
	private _report: HTMLElement | undefined;

	private _analysis: CodeGraphAnalysis | undefined;
	/** The subsystem opened up, or undefined for the overview */
	private _open: number | undefined;
	private _filter: CodeGraphViewFilter = ALL_LINKS_FILTER;
	private _loading = false;
	/** Listeners of the report rows, dropped with the rows on every repaint */
	private readonly _reportDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVibeCodeGraphService private readonly _codeGraph: IVibeCodeGraphService,
		@IRepoIndexerService private readonly _indexer: IRepoIndexerService,
		@IEditorService private readonly _editorService: IEditorService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
	) {
		super(VibeProjectGraphPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._host = DOM.append(parent, $('.vibe-project-graph'));
		this._main = DOM.append(this._host, $('.vibe-project-graph-main'));
		const toolbar = DOM.append(this._main, $('.vibe-docs-graph-toolbar'));
		this._canvasHost = DOM.append(this._main, $('.vibe-docs-graph-host'));
		this._report = DOM.append(this._host, $('.vibe-project-graph-report'));

		this._back = DOM.append(toolbar, $('a.vibe-docs-graph-reset'));
		this._back.textContent = localize('vibeProjectGraph.back', "← Подсистемы");
		this._back.tabIndex = 0;
		this._back.style.display = 'none';
		this._register(DOM.addDisposableListener(this._back, DOM.EventType.CLICK, () => this._show(undefined)));
		this._title = DOM.append(toolbar, $('span.vibe-project-graph-title'));

		const search = this._register(new InputBox(DOM.append(toolbar, $('.vibe-docs-graph-search')), this._contextViewService, {
			inputBoxStyles: defaultInputBoxStyles,
			placeholder: localize('vibeProjectGraph.search', "Поиск по имени…"),
			ariaLabel: localize('vibeProjectGraph.search.aria', "Поиск файла или подсистемы в графе"),
		}));
		this._register(search.onDidChange(value => this._canvas?.setSearch(value)));

		this._addToggle(toolbar, localize('vibeProjectGraph.imports', "Импорты"), true, on => this._setKind('imports', on));
		this._addToggle(toolbar, localize('vibeProjectGraph.extends', "Наследование"), true, on => this._setKind('extends', on));
		this._addToggle(toolbar, localize('vibeProjectGraph.facts', "Только факты"), false, on => {
			this._filter = { ...this._filter, factsOnly: on };
			this._render();
		}, localize('vibeProjectGraph.facts.hint', "Показывать только связи, прочитанные в исходнике, без догадок резолвера"));

		const fit = DOM.append(toolbar, $('a.vibe-docs-graph-reset'));
		fit.textContent = localize('vibeProjectGraph.fit', "Вписать в экран");
		fit.tabIndex = 0;
		this._register(DOM.addDisposableListener(fit, DOM.EventType.CLICK, () => this._canvas?.resetView()));

		const refresh = DOM.append(toolbar, $('a.vibe-docs-graph-reset'));
		refresh.textContent = localize('vibeProjectGraph.refresh', "Обновить");
		refresh.tabIndex = 0;
		this._register(DOM.addDisposableListener(refresh, DOM.EventType.CLICK, () => void this._load()));

		this._status = DOM.append(toolbar, $('span.vibe-docs-graph-status'));

		this._empty = DOM.append(this._canvasHost, $('.vibe-docs-graph-empty'));
		this._canvas = this._register(this._instantiationService.createInstance(VibeGraphCanvas, this._canvasHost, {
			onOpen: (id: string) => void this._onNode(id),
			nodeColor: subsystemColor,
			colors: { edge: VIBE_PROJECT_GRAPH_EDGE, flagged: editorWarningForeground, stub: editorErrorForeground },
		}));

		const repaint = this._register(new RunOnceScheduler(() => this._refresh(), REFRESH_DELAY_MS));
		this._register(this._indexer.onDidChangeStructure(() => repaint.schedule()));
	}

	private _addToggle(toolbar: HTMLElement, label: string, checked: boolean, onChange: (on: boolean) => void, hint?: string): void {
		const wrap = DOM.append(toolbar, $('label.vibe-project-graph-toggle'));
		const box = DOM.append(wrap, $<HTMLInputElement>('input', { type: 'checkbox' }));
		box.checked = checked;
		DOM.append(wrap, $('span')).textContent = label;
		if (hint) {
			wrap.title = hint;
		}
		this._register(DOM.addDisposableListener(box, DOM.EventType.CHANGE, () => onChange(box.checked)));
	}

	private _setKind(kind: FileLinkKind, on: boolean): void {
		const kinds = new Set(this._filter.kinds);
		if (on) {
			kinds.add(kind);
		} else {
			kinds.delete(kind);
		}
		this._filter = { ...this._filter, kinds };
		this._render();
	}

	override async setInput(input: VibeProjectGraphInput, options: unknown, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options as never, context, token);
		if (!this._analysis) {
			await this._load();
		}
	}

	/**
	 * The index loads lazily, on the first search or warm-up: a graph read before that is empty
	 * Warm it first and say so, so «пусто» is never shown for «ещё не прочитано»; a rebuild it starts runs in the background
	 * And reports back through `onDidChangeStructure`, which repaints the tab on its own
	 */
	private async _load(): Promise<void> {
		if (this._loading) {
			return;
		}
		this._loading = true;
		this._setEmpty(localize('vibeProjectGraph.loading', "Читаю индекс проекта…"));
		try {
			await this._indexer.warmIndex();
		} finally {
			this._loading = false;
		}
		this._refresh();
	}

	private _refresh(): void {
		const graph = this._codeGraph.getGraph();
		if (graph.nodes.length === 0) {
			this._analysis = undefined;
			this._setEmpty(this._indexer.isRebuilding
				? localize('vibeProjectGraph.building', "Индекс проекта строится — граф появится сам, когда он будет готов.")
				: localize('vibeProjectGraph.cold', "Индекс проекта пуст: откройте папку проекта и нажмите «Обновить»."));
			if (this._back) {
				this._back.style.display = 'none';
			}
			this._setStatus('');
			this._renderReport();
			return;
		}
		this._analysis = analyzeCodeGraph(graph);
		this._setEmpty(undefined);
		if (this._open !== undefined && !this._analysis.subsystems.some(subsystem => subsystem.id === this._open)) {
			this._open = undefined;
		}
		this._render();
		this._renderReport();
	}

	private _setEmpty(text: string | undefined): void {
		if (this._empty) {
			this._empty.textContent = text ?? '';
			this._empty.style.display = text ? '' : 'none';
		}
	}

	private _show(subsystem: number | undefined, focus?: string): void {
		this._open = subsystem;
		this._render();
		if (focus) {
			this._canvas?.revealWhenSettled(focus);
		}
	}

	private _render(): void {
		const analysis = this._analysis;
		if (!analysis || !this._canvas) {
			return;
		}
		const open = this._open === undefined ? undefined : analysis.subsystems.find(subsystem => subsystem.id === this._open);
		if (this._back) {
			this._back.style.display = open ? '' : 'none';
		}
		if (this._title) {
			this._title.textContent = open
				? localize('vibeProjectGraph.title.subsystem', "Подсистема «{0}»", open.label)
				: localize('vibeProjectGraph.title.overview', "Подсистемы проекта");
		}
		if (!open) {
			// A few dozen subsystems: their names are the point of the map, so they show from far out
			this._canvas.setGraph(overviewView(analysis, this._filter), { labelMinScale: OVERVIEW_LABEL_MIN_SCALE });
			this._setStatus(localize(
				'vibeProjectGraph.status.overview',
				"{0} файлов · {1} связей · {2} подсистем · {3} одиноких файлов",
				analysis.report.fileCount, analysis.report.linkCount, analysis.subsystems.length, analysis.report.isolated.length,
			));
			return;
		}
		const view = subsystemView(analysis, open.id, this._filter);
		this._canvas.setGraph(view);
		this._setStatus(view.hiddenFiles > 0
			? localize('vibeProjectGraph.status.limited', "{0} файлов, показаны {1} самых связанных", open.files.length, open.files.length - view.hiddenFiles)
			: localize('vibeProjectGraph.status.subsystem', "{0} файлов · {1} связей внутри", open.files.length, open.internalLinks));
	}

	private _setStatus(text: string): void {
		if (this._status) {
			this._status.textContent = text;
		}
	}

	/** A subsystem node opens it up; a file opens in the editor */
	private async _onNode(id: string): Promise<void> {
		const subsystem = subsystemOfNodeId(id);
		if (subsystem !== undefined) {
			this._show(subsystem);
			return;
		}
		await this._openFile(id);
	}

	private async _openFile(path: string): Promise<void> {
		await this._editorService.openEditor({ resource: URI.file(path), options: { pinned: true } });
	}

	private _renderReport(): void {
		const report = this._report;
		if (!report) {
			return;
		}
		DOM.clearNode(report);
		this._reportDisposables.clear();
		const analysis = this._analysis;
		if (!analysis) {
			return;
		}
		const rel = (path: string) => analysis.root && path.startsWith(`${analysis.root}/`) ? path.slice(analysis.root.length + 1) : path;
		const labelOf = new Map(analysis.subsystems.map(subsystem => [subsystem.id, subsystem.label]));
		const { provenance } = analysis.report;

		DOM.append(report, $('.vibe-project-graph-summary')).textContent = localize(
			'vibeProjectGraph.report.summary',
			"Связи: {0} прочитано в исходнике, {1} достроено резолвером, {2} неоднозначно. Подсистемы найдены по связям (Leiden), а не по папкам.",
			provenance.extracted, provenance.inferred, provenance.ambiguous,
		);

		const subsystems = this._section(report, localize('vibeProjectGraph.report.subsystems', "Подсистемы"));
		for (const subsystem of analysis.subsystems) {
			this._row(subsystems, subsystem.label, String(subsystem.files.length), String(subsystem.id), () => this._show(subsystem.id), rel(subsystem.hub));
		}

		const hubs = this._section(report, localize('vibeProjectGraph.report.hubs', "Главные файлы"), localize('vibeProjectGraph.report.hubs.hint', "Через них проходит больше всего связей — с них начинают знакомство с проектом"));
		for (const hub of analysis.report.hubs) {
			const inSubsystem = labelOf.has(hub.subsystem);
			this._row(hubs, rel(hub.file), String(hub.degree), String(hub.subsystem), () => inSubsystem ? this._show(hub.subsystem, hub.file) : void this._openFile(hub.file));
		}

		const surprising = this._section(report, localize('vibeProjectGraph.report.surprising', "Неожиданные связи"), localize('vibeProjectGraph.report.surprising.hint', "Редкие мосты между подсистемами: часто это протечка слоя или скрытая зависимость"));
		for (const entry of analysis.report.surprising) {
			const bridge = entry.bridgeCount === 1
				? localize('vibeProjectGraph.report.onlyBridge', "единственная связь «{0}» и «{1}»", labelOf.get(entry.fromSubsystem), labelOf.get(entry.toSubsystem))
				: localize('vibeProjectGraph.report.rareBridge', "одна из {0} связей «{1}» и «{2}»", entry.bridgeCount, labelOf.get(entry.fromSubsystem), labelOf.get(entry.toSubsystem));
			this._row(surprising, `${rel(entry.link.from)} → ${rel(entry.link.to)}`, '', String(entry.fromSubsystem), () => void this._openFile(entry.link.from), bridge);
		}

		const isolated = analysis.report.isolated;
		const lonely = this._section(report, localize('vibeProjectGraph.report.isolated', "Одинокие файлы: {0}", isolated.length), localize('vibeProjectGraph.report.isolated.hint', "Ни один известный файл их не импортирует, и они ничего не импортируют: точка входа, мёртвый код или связь, которую индекс не видит"));
		for (const file of isolated.slice(0, ISOLATED_SHOWN)) {
			this._row(lonely, rel(file), '', undefined, () => void this._openFile(file));
		}
		if (isolated.length > ISOLATED_SHOWN) {
			DOM.append(lonely, $('.vibe-project-graph-more')).textContent = localize('vibeProjectGraph.report.more', "и ещё {0}", isolated.length - ISOLATED_SHOWN);
		}
	}

	private _section(parent: HTMLElement, title: string, hint?: string): HTMLElement {
		const section = DOM.append(parent, $('.vibe-project-graph-section'));
		const heading = DOM.append(section, $('.vibe-project-graph-heading'));
		heading.textContent = title;
		if (hint) {
			heading.title = hint;
		}
		return section;
	}

	private _row(parent: HTMLElement, text: string, count: string, group: string | undefined, onClick: () => void, detail?: string): void {
		const row = DOM.append(parent, $('.vibe-project-graph-row'));
		row.tabIndex = 0;
		const dot = DOM.append(row, $('span.vibe-project-graph-dot'));
		if (group !== undefined) {
			dot.style.backgroundColor = subsystemColor(group, this.themeService.getColorTheme());
		}
		const body = DOM.append(row, $('.vibe-project-graph-row-body'));
		DOM.append(body, $('span.vibe-project-graph-row-text')).textContent = text;
		if (detail) {
			DOM.append(body, $('span.vibe-project-graph-row-detail')).textContent = detail;
		}
		if (count) {
			DOM.append(row, $('span.vibe-project-graph-count')).textContent = count;
		}
		row.title = detail ? `${text}\n${detail}` : text;
		this._reportDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, onClick));
		this._reportDisposables.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				onClick();
			}
		}));
	}

	/** Dots in the report are DOM, not canvas: repaint them with the theme like the canvas repaints itself */
	override updateStyles(): void {
		super.updateStyles();
		this._renderReport();
	}

	override layout(dimension: Dimension): void {
		if (!this._host || !this._canvasHost || !this._main) {
			return;
		}
		this._host.style.width = `${dimension.width}px`;
		this._host.style.height = `${dimension.height}px`;
		// Measured, not guessed: a toolbar that wraps to two lines and a report panel of any width both leave the canvas
		// exactly what is left
		const toolbarHeight = this._canvasHost.offsetTop - this._main.offsetTop;
		this._canvas?.layout(this._main.clientWidth, Math.max(0, dimension.height - toolbarHeight));
	}

	override focus(): void {
		super.focus();
		this._canvasHost?.focus();
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibeProjectGraphPane, VibeProjectGraphPane.ID, localize('vibeProjectGraph.paneName', "Граф проекта")),
	[new SyncDescriptor(VibeProjectGraphInput)],
);

/** The tab holds no state of its own — the graph is rebuilt from the index — so a restart just recreates it */
class VibeProjectGraphInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(VibeProjectGraphInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(VibeProjectGraphInput.ID, VibeProjectGraphInputSerializer);

registerAction2(class VibeProjectGraphOpen extends Action2 {
	constructor() {
		super({
			id: VIBE_PROJECT_GRAPH_OPEN_CMD,
			title: localize2('vibeProjectGraph.open', "Граф проекта"),
			icon: Codicon.graph,
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		// One graph tab, not one per invocation
		const existing = editorService.findEditors(VibeProjectGraphInput.RESOURCE)[0];
		await editorService.openEditor(existing?.editor ?? instantiationService.createInstance(VibeProjectGraphInput), { pinned: true });
	}
});
