/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Canvas renderer for the docs graph — shared by the editor tab and the sidebar's local graph.
 * Owns the animation loop, the viewport (pan/zoom) and pointer interaction; the layout maths and
 * the graph model are pure and live in `common/`. Hosts supply their own chrome (search box,
 * filters) and talk to this through the small API below.
 */

import * as DOM from '../../../../base/browser/dom.js';
import { PixelRatio } from '../../../../base/browser/pixelRatio.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IThemeService, Themable } from '../../../../platform/theme/common/themeService.js';
import {
	descriptionForeground,
	editorBackground,
	editorForeground,
	focusBorder,
} from '../../../../platform/theme/common/colorRegistry.js';
import { IDocGraph } from '../common/vibeDocsGraph.js';
import {
	DEFAULT_LAYOUT_OPTIONS,
	ILayoutNode,
	LAYOUT_SETTLED_ENERGY,
	seedPositions,
	stepLayout,
} from '../common/vibeDocsGraphLayout.js';
import {
	domainColorId,
	VIBE_DOCS_GRAPH_DEAD_LINK,
	VIBE_DOCS_GRAPH_EDGE,
	VIBE_DOCS_GRAPH_UNREACHABLE,
} from './vibeDocsGraphColors.js';

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
/** Labels below this scale turn into unreadable mush and cost a lot of text measuring. */
const LABEL_VISIBLE_SCALE = 0.75;
const DRAG_THRESHOLD_PX = 3;

export interface IGraphCanvasOptions {
	/** Clicking a node — the host decides what "open" means. */
	readonly onOpen: (id: string) => void;
	/** Node drawn as the centre of attention (the active doc in the sidebar's local graph). */
	readonly focusId?: string;
}

interface IRenderNode extends ILayoutNode {
	readonly label: string;
	readonly domain: string;
	readonly reachable: boolean;
	readonly radius: number;
}

export class VibeDocsGraphCanvas extends Themable {

	private readonly _canvas: HTMLCanvasElement;
	private _graph: IDocGraph = { nodes: [], edges: [], deadLinks: [] };
	private _nodes: IRenderNode[] = [];
	private _byId = new Map<string, IRenderNode>();
	private _neighbours = new Map<string, Set<string>>();
	private _deadCount = new Map<string, number>();

	private _width = 0;
	private _height = 0;
	private _scale = 1;
	private _offsetX = 0;
	private _offsetY = 0;

	private _hovered: string | undefined;
	private _search = '';
	private _matches: Set<string> | undefined;
	private _focusId: string | undefined;

	private _animation: IDisposable | undefined;
	/** Deferred viewport moves: the layout is still expanding until it settles. */
	private _fitOnSettle = false;
	private _centerOnSettle: string | undefined;
	private _dragNode: IRenderNode | undefined;
	private _panning = false;
	private _pressOrigin: { x: number; y: number } | undefined;
	private _moved = false;

	constructor(
		container: HTMLElement,
		private readonly _options: IGraphCanvasOptions,
		@IThemeService themeService: IThemeService,
	) {
		super(themeService);
		this._focusId = _options.focusId;

		this._canvas = DOM.append(container, DOM.$('canvas.vibe-docs-graph-canvas'));
		this._register(toDisposable(() => this._stopAnimation()));
		this._register(PixelRatio.getInstance(DOM.getWindow(container)).onDidChange(() => this._resizeBackingStore()));
		this._registerPointerHandlers();
	}

	/** Repaint on theme change — canvas pixels are not restyled by CSS. */
	override updateStyles(): void {
		this._render();
	}

	setGraph(graph: IDocGraph): void {
		this._graph = graph;

		const degrees = new Map(graph.nodes.map(n => [n.id, n.degree]));
		const seeded = seedPositions(graph.nodes.map(n => n.id), degrees);
		const meta = new Map(graph.nodes.map(n => [n.id, n]));

		// Carry positions across a rebuild so an edit to one doc doesn't reshuffle the picture.
		const previous = this._byId;
		this._nodes = seeded.map(node => {
			const info = meta.get(node.id)!;
			const old = previous.get(node.id);
			return {
				...node,
				x: old?.x ?? node.x,
				y: old?.y ?? node.y,
				label: info.label,
				domain: info.domain,
				reachable: info.reachable,
				radius: 3.5 + Math.sqrt(info.degree) * 1.7,
			};
		});
		this._byId = new Map(this._nodes.map(n => [n.id, n]));

		this._neighbours = new Map(graph.nodes.map(n => [n.id, new Set<string>()]));
		for (const edge of graph.edges) {
			this._neighbours.get(edge.from)?.add(edge.to);
			this._neighbours.get(edge.to)?.add(edge.from);
		}
		this._deadCount = new Map();
		for (const dead of graph.deadLinks) {
			this._deadCount.set(dead.from, (this._deadCount.get(dead.from) ?? 0) + 1);
		}

		this._applySearch();
		this._fitOnSettle = true;
		this._centerOnSettle = undefined;
		this._startAnimation();
	}

	/**
	 * Rings a node and brings it into view once the layout stops moving. Supersedes the automatic
	 * fit, which would otherwise pull the viewport back out from under the reveal.
	 */
	revealWhenSettled(id: string): void {
		this.setFocus(id);
		this._fitOnSettle = false;
		this._centerOnSettle = id;
		this._startAnimation();
	}

	setFocus(id: string | undefined): void {
		this._focusId = id;
		this._render();
	}

	/** Matching nodes stay lit, the rest dim. An empty query lights everything. */
	setSearch(query: string): void {
		this._search = query.trim().toLowerCase();
		this._applySearch();
		this._render();
	}

	private _applySearch(): void {
		if (!this._search) {
			this._matches = undefined;
			return;
		}
		this._matches = new Set(
			this._nodes.filter(n => n.id.toLowerCase().includes(this._search)).map(n => n.id),
		);
	}

	layout(width: number, height: number): void {
		if (width === this._width && height === this._height) {
			return;
		}
		const first = this._width === 0;
		this._width = width;
		this._height = height;
		this._resizeBackingStore();
		if (first) {
			this._offsetX = width / 2;
			this._offsetY = height / 2;
		}
		this._render();
	}

	/** Fits the whole graph into the viewport — the "I'm lost" button. */
	resetView(): void {
		if (this._nodes.length === 0 || this._width === 0) {
			return;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const node of this._nodes) {
			minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
			minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
		}
		const margin = 40;
		const spanX = Math.max(maxX - minX, 1);
		const spanY = Math.max(maxY - minY, 1);
		this._scale = Math.min(
			(this._width - margin * 2) / spanX,
			(this._height - margin * 2) / spanY,
			MAX_SCALE,
		);
		this._scale = Math.max(this._scale, MIN_SCALE);
		this._offsetX = this._width / 2 - ((minX + maxX) / 2) * this._scale;
		this._offsetY = this._height / 2 - ((minY + maxY) / 2) * this._scale;
		this._render();
	}

	hasNode(id: string): boolean {
		return this._byId.has(id);
	}

	/** Pans a node into the middle of the viewport, zooming in if the view was pulled way out. */
	centerOn(id: string): void {
		const node = this._byId.get(id);
		if (!node || this._width === 0) {
			return;
		}
		this._scale = Math.max(this._scale, 1);
		this._offsetX = this._width / 2 - node.x * this._scale;
		this._offsetY = this._height / 2 - node.y * this._scale;
		this._render();
	}

	private _resizeBackingStore(): void {
		const ratio = PixelRatio.getInstance(DOM.getWindow(this._canvas)).value;
		this._canvas.style.width = `${this._width}px`;
		this._canvas.style.height = `${this._height}px`;
		this._canvas.width = Math.max(1, Math.round(this._width * ratio));
		this._canvas.height = Math.max(1, Math.round(this._height * ratio));
	}

	// --- animation ----------------------------------------------------------------------------

	/**
	 * The loop runs only while the layout still moves. A permanently spinning rAF on a docs graph
	 * is a laptop-fan bug, so once the energy drops below the settle threshold we stop and only
	 * repaint on demand.
	 */
	private _startAnimation(): void {
		if (this._animation) {
			return;
		}
		const targetWindow = DOM.getWindow(this._canvas);
		let handle = 0;
		const tick = () => {
			const energy = stepLayout(this._nodes, this._graph.edges, DEFAULT_LAYOUT_OPTIONS);
			if (energy < LAYOUT_SETTLED_ENERGY && !this._dragNode) {
				this._stopAnimation();
				// Moving the viewport before the layout has settled frames a graph that is still
				// expanding, so the result is cropped the moment it stops. Do it once, at the end.
				if (this._centerOnSettle) {
					const target = this._centerOnSettle;
					this._centerOnSettle = undefined;
					this.centerOn(target);
				} else if (this._fitOnSettle) {
					this._fitOnSettle = false;
					this.resetView();
				} else {
					this._render();
				}
				return;
			}
			this._render();
			handle = targetWindow.requestAnimationFrame(tick);
		};
		handle = targetWindow.requestAnimationFrame(tick);
		this._animation = toDisposable(() => targetWindow.cancelAnimationFrame(handle));
	}

	private _stopAnimation(): void {
		this._animation?.dispose();
		this._animation = undefined;
	}

	// --- interaction --------------------------------------------------------------------------

	private _toWorld(clientX: number, clientY: number): { x: number; y: number } {
		const rect = this._canvas.getBoundingClientRect();
		return {
			x: (clientX - rect.left - this._offsetX) / this._scale,
			y: (clientY - rect.top - this._offsetY) / this._scale,
		};
	}

	private _nodeAt(clientX: number, clientY: number): IRenderNode | undefined {
		const { x, y } = this._toWorld(clientX, clientY);
		// Topmost first: later nodes paint over earlier ones.
		for (let i = this._nodes.length - 1; i >= 0; i--) {
			const node = this._nodes[i];
			const dx = node.x - x;
			const dy = node.y - y;
			const hit = node.radius + 4 / this._scale;
			if (dx * dx + dy * dy <= hit * hit) {
				return node;
			}
		}
		return undefined;
	}

	private _registerPointerHandlers(): void {
		this._register(DOM.addDisposableListener(this._canvas, DOM.EventType.WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			// Zoom toward the cursor: the point under the pointer must stay put.
			const rect = this._canvas.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			const worldX = (px - this._offsetX) / this._scale;
			const worldY = (py - this._offsetY) / this._scale;
			const factor = Math.exp(-e.deltaY * 0.0015);
			this._scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this._scale * factor));
			this._offsetX = px - worldX * this._scale;
			this._offsetY = py - worldY * this._scale;
			this._render();
		}, { passive: false }));

		this._register(DOM.addDisposableListener(this._canvas, DOM.EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (e.button !== 0) {
				return;
			}
			this._pressOrigin = { x: e.clientX, y: e.clientY };
			this._moved = false;
			const node = this._nodeAt(e.clientX, e.clientY);
			if (node) {
				this._dragNode = node;
				node.pinned = true;
				this._startAnimation();
			} else {
				this._panning = true;
			}
		}));

		this._register(DOM.addDisposableListener(this._canvas, DOM.EventType.MOUSE_MOVE, (e: MouseEvent) => {
			if (this._pressOrigin) {
				const dx = e.clientX - this._pressOrigin.x;
				const dy = e.clientY - this._pressOrigin.y;
				if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
					this._moved = true;
				}
			}
			if (this._dragNode) {
				const { x, y } = this._toWorld(e.clientX, e.clientY);
				this._dragNode.x = x;
				this._dragNode.y = y;
				return; // the animation loop repaints
			}
			if (this._panning) {
				this._offsetX += e.movementX;
				this._offsetY += e.movementY;
				this._render();
				return;
			}
			const hovered = this._nodeAt(e.clientX, e.clientY)?.id;
			if (hovered !== this._hovered) {
				this._hovered = hovered;
				this._canvas.style.cursor = hovered ? 'pointer' : 'default';
				this._canvas.title = hovered ?? '';
				this._render();
			}
		}));

		const endPress = (e: MouseEvent) => {
			if (this._dragNode) {
				this._dragNode.pinned = false;
				this._dragNode = undefined;
				this._startAnimation();
			}
			// A click is a press that didn't travel — otherwise dragging a node would open it.
			if (!this._moved && this._pressOrigin) {
				const node = this._nodeAt(e.clientX, e.clientY);
				if (node) {
					this._options.onOpen(node.id);
				}
			}
			this._panning = false;
			this._pressOrigin = undefined;
		};
		this._register(DOM.addDisposableListener(this._canvas, DOM.EventType.MOUSE_UP, endPress));
		this._register(DOM.addDisposableListener(this._canvas, DOM.EventType.MOUSE_LEAVE, () => {
			this._panning = false;
			this._pressOrigin = undefined;
			if (this._dragNode) {
				this._dragNode.pinned = false;
				this._dragNode = undefined;
			}
			if (this._hovered) {
				this._hovered = undefined;
				this._render();
			}
		}));
	}

	// --- rendering ----------------------------------------------------------------------------

	private _color(id: string, fallback: string): string {
		return this.getColor(id) ?? fallback;
	}

	/** Dimmed nodes stay visible but recede — hover and search both lean on this. */
	private _isLit(id: string): boolean {
		if (this._hovered) {
			return id === this._hovered || (this._neighbours.get(this._hovered)?.has(id) ?? false);
		}
		return !this._matches || this._matches.has(id);
	}

	private _render(): void {
		const ctx = this._canvas.getContext('2d');
		if (!ctx || this._width === 0) {
			return;
		}
		const ratio = PixelRatio.getInstance(DOM.getWindow(this._canvas)).value;
		ctx.save();
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, this._width, this._height);
		ctx.fillStyle = this._color(editorBackground, '#1e1e1e');
		ctx.fillRect(0, 0, this._width, this._height);

		ctx.translate(this._offsetX, this._offsetY);
		ctx.scale(this._scale, this._scale);

		this._renderEdges(ctx);
		this._renderDeadLinks(ctx);
		this._renderNodes(ctx);
		ctx.restore();
	}

	private _renderEdges(ctx: CanvasRenderingContext2D): void {
		const edgeColor = this._color(VIBE_DOCS_GRAPH_EDGE, '#4080c059');
		const litColor = this._color(focusBorder, '#007fd4');
		ctx.lineWidth = 1 / this._scale;
		for (const edge of this._graph.edges) {
			const a = this._byId.get(edge.from);
			const b = this._byId.get(edge.to);
			if (!a || !b) {
				continue;
			}
			const lit = this._isLit(edge.from) && this._isLit(edge.to);
			ctx.globalAlpha = lit ? 0.9 : 0.12;
			ctx.strokeStyle = this._hovered && lit ? litColor : edgeColor;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
	}

	/**
	 * Dead links point at nothing, so there is no target node to draw to: a short dashed stub with
	 * an open end reads as "this goes nowhere" without inventing a phantom node.
	 */
	private _renderDeadLinks(ctx: CanvasRenderingContext2D): void {
		if (this._graph.deadLinks.length === 0) {
			return;
		}
		ctx.strokeStyle = this._color(VIBE_DOCS_GRAPH_DEAD_LINK, '#f14c4c');
		ctx.lineWidth = 1 / this._scale;
		ctx.setLineDash([3 / this._scale, 3 / this._scale]);
		for (const [id, count] of this._deadCount) {
			const node = this._byId.get(id);
			if (!node || !this._isLit(id)) {
				continue;
			}
			for (let i = 0; i < count; i++) {
				const angle = (i / count) * Math.PI * 2;
				const length = node.radius + 14;
				ctx.globalAlpha = 0.85;
				ctx.beginPath();
				ctx.moveTo(node.x + Math.cos(angle) * node.radius, node.y + Math.sin(angle) * node.radius);
				ctx.lineTo(node.x + Math.cos(angle) * length, node.y + Math.sin(angle) * length);
				ctx.stroke();
			}
		}
		ctx.setLineDash([]);
		ctx.globalAlpha = 1;
	}

	private _renderNodes(ctx: CanvasRenderingContext2D): void {
		const unreachableColor = this._color(VIBE_DOCS_GRAPH_UNREACHABLE, '#cca700');
		const labelColor = this._color(editorForeground, '#cccccc');
		const dimLabelColor = this._color(descriptionForeground, '#8c8c8c');
		const focusColor = this._color(focusBorder, '#007fd4');
		const showLabels = this._scale >= LABEL_VISIBLE_SCALE;
		const fontFamily = DOM.getWindow(this._canvas).getComputedStyle(this._canvas).fontFamily || 'sans-serif';

		for (const node of this._nodes) {
			const lit = this._isLit(node.id);
			ctx.globalAlpha = lit ? 1 : 0.15;
			ctx.fillStyle = this._color(domainColorId(node.domain), '#4080c0');
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
			ctx.fill();

			// An unreachable doc is the thing this graph exists to surface — ring it.
			if (!node.reachable) {
				ctx.strokeStyle = unreachableColor;
				ctx.lineWidth = 2 / this._scale;
				ctx.beginPath();
				ctx.arc(node.x, node.y, node.radius + 2.5 / this._scale, 0, Math.PI * 2);
				ctx.stroke();
			}
			if (node.id === this._focusId || node.id === this._hovered) {
				ctx.strokeStyle = focusColor;
				ctx.lineWidth = 2 / this._scale;
				ctx.beginPath();
				ctx.arc(node.x, node.y, node.radius + 4 / this._scale, 0, Math.PI * 2);
				ctx.stroke();
			}
		}

		if (!showLabels) {
			ctx.globalAlpha = 1;
			return;
		}
		ctx.font = `${11 / this._scale}px ${fontFamily}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		for (const node of this._nodes) {
			const lit = this._isLit(node.id);
			ctx.globalAlpha = lit ? 1 : 0.15;
			ctx.fillStyle = lit ? labelColor : dimLabelColor;
			ctx.fillText(node.label, node.x, node.y + node.radius + 2 / this._scale);
		}
		ctx.globalAlpha = 1;
	}
}
