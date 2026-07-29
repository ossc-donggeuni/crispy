import type {
	GraphPosition,
	GraphViewport,
	NodePlanInfo,
	ProjectNode,
	SharedSelection,
} from '../model/projectNode';
import type {
	FileAnalysisResult,
	SymbolMetadata,
} from '../model/fileAnalysis';
import { createDirectoryBox } from './components/DirectoryBox';
import { createFileDetailBox } from './components/FileDetailBox';
import {
	createGraphToolbar,
	type GraphToolbar,
} from './components/GraphToolbar';
import { createProjectBox } from './components/ProjectBox';
import {
	createElement,
	type GraphComponentContext,
} from './components/componentTypes';
import { FileAnalysisStateStore } from './fileAnalysisState';

export type GraphViewOptions = {
	nodes: readonly ProjectNode[];
	planInfo?: readonly NodePlanInfo[];
	onSelectionChange?: (selection: SharedSelection) => void;
	onFileAnalysisRequest?: (
		fileNode: ProjectNode,
		requestId: string,
	) => void;
};

type DragState = {
	nodeId: string;
	element: HTMLElement;
	startClientX: number;
	startClientY: number;
	startPosition: GraphPosition;
	moved: boolean;
};

type PanState = {
	pointerId: number;
	startClientX: number;
	startClientY: number;
	startViewportX: number;
	startViewportY: number;
	moved: boolean;
};

const minimumZoom = 0.45;
const maximumZoom = 1.8;

export class GraphView {
	private readonly root: HTMLElement;
	private readonly nodesById: Map<string, ProjectNode>;
	private readonly planInfoByNodeId: ReadonlyMap<string, NodePlanInfo>;
	private readonly symbolMetadataByNodeId = new Map<string, SymbolMetadata>();
	private readonly fileAnalysisStates = new FileAnalysisStateStore();
	private readonly onSelectionChange?: (selection: SharedSelection) => void;
	private readonly onFileAnalysisRequest?: (
		fileNode: ProjectNode,
		requestId: string,
	) => void;
	private readonly projectNode?: ProjectNode;
	private readonly expandedDirectoryIds = new Set<string>();
	private readonly expandedFileIds = new Set<string>();
	private readonly positions = new Map<string, GraphPosition>();
	private readonly boxElements = new Map<string, HTMLElement>();

	private selection: SharedSelection = {};
	private viewport: GraphViewport = { x: 0, y: 0, zoom: 1 };
	private shell!: HTMLElement;
	private canvas!: HTMLElement;
	private stage!: HTMLElement;
	private statusValue!: HTMLElement;
	private connections!: SVGSVGElement;
	private toolbar!: GraphToolbar;
	private dragState?: DragState;
	private panState?: PanState;
	private suppressNextClick = false;
	private suppressNextCanvasClick = false;
	private initialFitFrame?: number;

	public constructor(root: HTMLElement, options: GraphViewOptions) {
		this.root = root;
		this.nodesById = new Map(
			options.nodes.map((node) => [
				node.id,
				{
					...node,
					childrenIds: [...node.childrenIds],
				},
			]),
		);
		this.planInfoByNodeId = new Map(
			(options.planInfo ?? []).map((info) => [info.nodeId, info]),
		);
		this.onSelectionChange = options.onSelectionChange;
		this.onFileAnalysisRequest = options.onFileAnalysisRequest;
		this.projectNode = [...this.nodesById.values()]
			.find((node) => node.type === 'project');
		this.positions.set(this.projectNode?.id ?? 'project', { x: 70, y: 180 });

		this.renderShell();
		this.renderGraph();
		this.initialFitFrame = window.requestAnimationFrame(() => this.fitView());
	}

	public dispose(): void {
		if (this.initialFitFrame !== undefined) {
			window.cancelAnimationFrame(this.initialFitFrame);
		}
		window.removeEventListener('pointermove', this.handlePointerMove);
		window.removeEventListener('pointerup', this.handlePointerUp);
		this.root.replaceChildren();
	}

	public setFileAnalysisResult(result: FileAnalysisResult): boolean {
		const fileNode = this.nodesById.get(result.fileNodeId);
		if (
			fileNode?.type !== 'file'
			|| !this.fileAnalysisStates.applyResult(result)
		) {
			return false;
		}

		const previousSymbolIds = new Set(
			fileNode.childrenIds.filter(
				(childId) => this.nodesById.get(childId)?.type === 'symbol',
			),
		);
		for (const symbolId of previousSymbolIds) {
			this.nodesById.delete(symbolId);
			this.symbolMetadataByNodeId.delete(symbolId);
		}

		const nextSymbolIds: string[] = [];
		const nextSymbolIdSet = new Set<string>();
		for (const symbolNode of result.symbolNodes) {
			if (
				symbolNode.type !== 'symbol'
				|| symbolNode.parentId !== fileNode.id
				|| nextSymbolIdSet.has(symbolNode.id)
			) {
				continue;
			}

			nextSymbolIdSet.add(symbolNode.id);
			nextSymbolIds.push(symbolNode.id);
			this.nodesById.set(symbolNode.id, {
				...symbolNode,
				childrenIds: [...symbolNode.childrenIds],
			});
		}

		for (const metadata of result.symbolMetadata) {
			if (nextSymbolIdSet.has(metadata.nodeId)) {
				this.symbolMetadataByNodeId.set(metadata.nodeId, metadata);
			}
		}

		this.nodesById.set(fileNode.id, {
			...fileNode,
			childrenIds: nextSymbolIds,
		});

		const selectedNodeId = this.selection.selectedNodeId;
		if (
			selectedNodeId
			&& previousSymbolIds.has(selectedNodeId)
			&& !nextSymbolIdSet.has(selectedNodeId)
		) {
			this.setSelection(fileNode.id);
		}

		this.renderGraph();
		return true;
	}

	private renderShell(): void {
		this.root.replaceChildren();
		this.shell = createElement('main', 'graph-shell');

		const topbar = createElement('header', 'graph-topbar');
		const brand = createElement('div', 'graph-brand');
		const mark = createElement('span', 'brand-mark', 'C');
		mark.setAttribute('aria-hidden', 'true');
		const brandCopy = createElement('div', 'brand-copy');
		const title = createElement('h1', 'brand-title', 'Crispy');
		const subtitle = createElement(
			'span',
			'brand-subtitle',
			'Project structure graph',
		);
		brandCopy.append(title, subtitle);
		brand.append(mark, brandCopy);

		this.toolbar = createGraphToolbar({
			onFitView: () => this.fitView(),
			onZoomIn: () => this.zoomBy(1.16),
			onZoomOut: () => this.zoomBy(1 / 1.16),
		});
		topbar.append(brand, this.toolbar.element);

		this.canvas = createElement('div', 'graph-canvas');
		this.canvas.tabIndex = 0;
		this.canvas.setAttribute(
			'aria-label',
			'Project structure canvas. Drag empty space to pan and use the mouse wheel to zoom.',
		);
		this.stage = createElement('div', 'graph-stage');
		this.canvas.append(this.stage);

		const status = createElement('footer', 'graph-status');
		const statusLabel = createElement('span', 'status-label', 'Selected:');
		this.statusValue = createElement('code', 'status-value', 'None');
		const help = createElement(
			'span',
			'status-help',
			'Drag headers to move boxes · Drag canvas to pan',
		);
		status.append(statusLabel, this.statusValue, help);

		this.shell.append(topbar, this.canvas, status);
		this.root.append(this.shell);

		this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
		this.canvas.addEventListener('pointerdown', this.handleCanvasPointerDown);
		this.canvas.addEventListener('click', this.handleCanvasClick);
		window.addEventListener('pointermove', this.handlePointerMove);
		window.addEventListener('pointerup', this.handlePointerUp);
	}

	private renderGraph(): void {
		try {
			this.stage.replaceChildren();
			this.boxElements.clear();
			this.connections = document.createElementNS(
				'http://www.w3.org/2000/svg',
				'svg',
			);
			this.connections.classList.add('graph-connections');
			this.connections.setAttribute('aria-hidden', 'true');
			this.stage.append(this.connections);

			if (!this.projectNode) {
				const empty = createElement(
					'div',
					'graph-empty-state',
					'No project structure loaded.',
				);
				this.canvas.append(empty);
				this.statusValue.textContent = 'None';
				return;
			}

			this.canvas.querySelector('.graph-empty-state')?.remove();
			const context = this.createComponentContext();
			this.addBox(this.projectNode, createProjectBox(this.projectNode, context));

			for (const node of this.nodesById.values()) {
				if (node.type === 'directory' && this.isDirectoryVisible(node.id)) {
					this.ensurePosition(node);
					this.addBox(node, createDirectoryBox(node, context));
				}
			}

			for (const node of this.nodesById.values()) {
				if (node.type === 'file' && this.isFileDetailVisible(node)) {
					this.ensurePosition(node);
					this.addBox(node, createFileDetailBox(node, context));
				}
			}

			this.renderConnections();
			this.applyViewport();
			this.statusValue.textContent = this.selection.selectedNodeId ?? 'None';
		} catch (error) {
			this.renderError(error);
		}
	}

	private createComponentContext(): GraphComponentContext {
		return {
			nodesById: this.nodesById,
			selectedNodeId: this.selection.selectedNodeId,
			expandedDirectoryIds: this.expandedDirectoryIds,
			expandedFileIds: this.expandedFileIds,
			planInfoByNodeId: this.planInfoByNodeId,
			fileAnalysisStates: this.fileAnalysisStates.all,
			symbolMetadataByNodeId: this.symbolMetadataByNodeId,
			onSelect: (nodeId) => this.selectNode(nodeId),
			onToggleDirectory: (nodeId) => this.toggleDirectory(nodeId),
			onToggleFile: (nodeId) => this.toggleFile(nodeId),
			onRetryFileAnalysis: (nodeId) => this.retryFileAnalysis(nodeId),
			onBoxPointerDown: this.handleBoxPointerDown,
		};
	}

	private addBox(node: ProjectNode, element: HTMLElement): void {
		const position = this.positions.get(node.id) ?? { x: 70, y: 180 };
		element.style.left = `${position.x}px`;
		element.style.top = `${position.y}px`;
		this.boxElements.set(node.id, element);
		this.stage.append(element);
	}

	private ensurePosition(node: ProjectNode): void {
		if (this.positions.has(node.id)) {
			return;
		}

		const parent = node.parentId ? this.nodesById.get(node.parentId) : undefined;
		const parentPosition = parent
			? this.positions.get(parent.id) ?? { x: 70, y: 180 }
			: { x: 70, y: 180 };
		const siblingIndex = parent?.childrenIds.indexOf(node.id) ?? 0;

		if (node.type === 'directory' && parent?.type === 'project') {
			this.positions.set(node.id, {
				x: parentPosition.x + 480,
				y: 50 + siblingIndex * 300,
			});
			return;
		}

		this.positions.set(node.id, {
			x: parentPosition.x + 470,
			y: parentPosition.y + 40 + Math.max(0, siblingIndex) * 205,
		});
	}

	private isDirectoryVisible(directoryId: string): boolean {
		if (!this.expandedDirectoryIds.has(directoryId)) {
			return false;
		}

		let current = this.nodesById.get(directoryId);
		while (current?.parentId) {
			const parent = this.nodesById.get(current.parentId);
			if (!parent || parent.type === 'project') {
				return Boolean(parent);
			}
			if (
				parent.type === 'directory'
				&& !this.expandedDirectoryIds.has(parent.id)
			) {
				return false;
			}
			current = parent;
		}
		return false;
	}

	private isFileDetailVisible(file: ProjectNode): boolean {
		if (!this.expandedFileIds.has(file.id) || !file.parentId) {
			return false;
		}
		return this.isDirectoryVisible(file.parentId);
	}

	private toggleDirectory(nodeId: string): void {
		if (this.expandedDirectoryIds.has(nodeId)) {
			this.expandedDirectoryIds.delete(nodeId);
		} else {
			this.expandedDirectoryIds.add(nodeId);
			const node = this.nodesById.get(nodeId);
			if (node) {
				this.ensurePosition(node);
			}
		}
		this.setSelection(nodeId);
		this.renderGraph();
	}

	private toggleFile(nodeId: string): void {
		if (this.expandedFileIds.has(nodeId)) {
			this.expandedFileIds.delete(nodeId);
		} else {
			this.expandedFileIds.add(nodeId);
			const node = this.nodesById.get(nodeId);
			if (node?.type === 'file') {
				this.ensurePosition(node);
				this.requestFileAnalysis(node, false);
			}
		}
		this.setSelection(nodeId);
		this.renderGraph();
	}

	private retryFileAnalysis(nodeId: string): void {
		const fileNode = this.nodesById.get(nodeId);
		if (fileNode?.type !== 'file') {
			return;
		}

		this.requestFileAnalysis(fileNode, true);
		this.renderGraph();
	}

	private requestFileAnalysis(
		fileNode: ProjectNode,
		isRetry: boolean,
	): void {
		if (!this.onFileAnalysisRequest) {
			return;
		}

		if (!fileNode.relativePath) {
			this.fileAnalysisStates.markUnsupported(fileNode.id);
			return;
		}

		const requestId = isRetry
			? this.fileAnalysisStates.retry(fileNode.id)
			: this.fileAnalysisStates.beginOnOpen(fileNode.id);
		if (requestId) {
			this.onFileAnalysisRequest(fileNode, requestId);
		}
	}

	private selectNode(nodeId: string): void {
		if (this.suppressNextClick) {
			this.suppressNextClick = false;
			return;
		}
		this.setSelection(nodeId);
		this.renderGraph();
	}

	private clearSelection(): void {
		if (!this.selection.selectedNodeId) {
			return;
		}
		this.setSelection(undefined);
		this.renderGraph();
	}

	private setSelection(nodeId: string | undefined): void {
		this.selection = { selectedNodeId: nodeId };
		this.onSelectionChange?.(this.selection);
	}

	private renderConnections(): void {
		this.connections.replaceChildren();

		for (const [nodeId, targetElement] of this.boxElements) {
			const node = this.nodesById.get(nodeId);
			if (!node?.parentId) {
				continue;
			}

			const sourceElement = this.boxElements.get(node.parentId);
			const sourcePosition = this.positions.get(node.parentId);
			const targetPosition = this.positions.get(nodeId);
			if (!sourceElement || !sourcePosition || !targetPosition) {
				continue;
			}

			const sourceX = sourcePosition.x + sourceElement.offsetWidth;
			const sourceY = sourcePosition.y + Math.min(82, sourceElement.offsetHeight / 2);
			const targetX = targetPosition.x;
			const targetY = targetPosition.y + Math.min(82, targetElement.offsetHeight / 2);
			const direction = targetX >= sourceX ? 1 : -1;
			const curve = Math.max(70, Math.abs(targetX - sourceX) * 0.45);
			const path = document.createElementNS(
				'http://www.w3.org/2000/svg',
				'path',
			);
			path.setAttribute(
				'd',
				`M ${sourceX} ${sourceY} C ${sourceX + curve * direction} ${sourceY}, ${targetX - curve * direction} ${targetY}, ${targetX} ${targetY}`,
			);
			path.classList.add('graph-connection');
			this.connections.append(path);
		}
	}

	private fitView(): void {
		const entries = [...this.boxElements.entries()];
		if (entries.length === 0 || this.canvas.clientWidth === 0) {
			return;
		}

		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const [nodeId, element] of entries) {
			const position = this.positions.get(nodeId);
			if (!position) {
				continue;
			}
			minX = Math.min(minX, position.x);
			minY = Math.min(minY, position.y);
			maxX = Math.max(maxX, position.x + element.offsetWidth);
			maxY = Math.max(maxY, position.y + element.offsetHeight);
		}

		const padding = 72;
		const contentWidth = Math.max(1, maxX - minX);
		const contentHeight = Math.max(1, maxY - minY);
		const zoom = this.clampZoom(
			Math.min(
				(this.canvas.clientWidth - padding * 2) / contentWidth,
				(this.canvas.clientHeight - padding * 2) / contentHeight,
				1.1,
			),
		);

		this.viewport = {
			zoom,
			x: (this.canvas.clientWidth - contentWidth * zoom) / 2 - minX * zoom,
			y: (this.canvas.clientHeight - contentHeight * zoom) / 2 - minY * zoom,
		};
		this.applyViewport();
	}

	private zoomBy(factor: number): void {
		const rect = this.canvas.getBoundingClientRect();
		this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
	}

	private zoomAt(clientX: number, clientY: number, factor: number): void {
		const rect = this.canvas.getBoundingClientRect();
		const previousZoom = this.viewport.zoom;
		const nextZoom = this.clampZoom(previousZoom * factor);
		const worldX = (clientX - rect.left - this.viewport.x) / previousZoom;
		const worldY = (clientY - rect.top - this.viewport.y) / previousZoom;

		this.viewport = {
			zoom: nextZoom,
			x: clientX - rect.left - worldX * nextZoom,
			y: clientY - rect.top - worldY * nextZoom,
		};
		this.applyViewport();
	}

	private clampZoom(zoom: number): number {
		return Math.min(maximumZoom, Math.max(minimumZoom, zoom));
	}

	private applyViewport(): void {
		this.stage.style.transform =
			`translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.zoom})`;
		this.toolbar.updateZoom(this.viewport.zoom);
	}

	private renderError(error: unknown): void {
		this.stage.replaceChildren();
		const message = error instanceof Error ? error.message : 'Unknown rendering error';
		const errorState = createElement('div', 'graph-error-state');
		const title = createElement('strong', undefined, 'Unable to render graph.');
		const detail = createElement('span', undefined, message);
		errorState.append(title, detail);
		this.stage.append(errorState);
		this.statusValue.textContent = 'Render error';
		console.error('[Crispy] Graph render failed:', error);
	}

	private readonly handleWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const factor = Math.exp(-event.deltaY * 0.0015);
		this.zoomAt(event.clientX, event.clientY, factor);
	};

	private readonly handleCanvasPointerDown = (event: PointerEvent): void => {
		if (
			event.button !== 0
			|| (event.target as HTMLElement).closest('.graph-box, .graph-toolbar')
		) {
			return;
		}

		this.panState = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startViewportX: this.viewport.x,
			startViewportY: this.viewport.y,
			moved: false,
		};
		this.canvas.classList.add('is-panning');
		this.canvas.setPointerCapture(event.pointerId);
		event.preventDefault();
	};

	private readonly handleBoxPointerDown = (event: PointerEvent): void => {
		const target = event.target as HTMLElement;
		if (event.button !== 0 || target.closest('button')) {
			return;
		}

		const box = target.closest<HTMLElement>('.graph-box');
		const nodeId = box?.dataset.boxId;
		const position = nodeId ? this.positions.get(nodeId) : undefined;
		if (!box || !nodeId || !position) {
			return;
		}

		this.dragState = {
			nodeId,
			element: box,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startPosition: { ...position },
			moved: false,
		};
		box.classList.add('is-dragging');
		event.preventDefault();
		event.stopPropagation();
	};

	private readonly handlePointerMove = (event: PointerEvent): void => {
		if (this.dragState) {
			const deltaX = (event.clientX - this.dragState.startClientX) / this.viewport.zoom;
			const deltaY = (event.clientY - this.dragState.startClientY) / this.viewport.zoom;
			if (Math.abs(deltaX) + Math.abs(deltaY) > 2) {
				this.dragState.moved = true;
			}
			const position = {
				x: this.dragState.startPosition.x + deltaX,
				y: this.dragState.startPosition.y + deltaY,
			};
			this.positions.set(this.dragState.nodeId, position);
			this.dragState.element.style.left = `${position.x}px`;
			this.dragState.element.style.top = `${position.y}px`;
			this.renderConnections();
			return;
		}

		if (this.panState && event.pointerId === this.panState.pointerId) {
			const deltaX = event.clientX - this.panState.startClientX;
			const deltaY = event.clientY - this.panState.startClientY;
			if (Math.abs(deltaX) + Math.abs(deltaY) > 3) {
				this.panState.moved = true;
			}
			this.viewport = {
				...this.viewport,
				x: this.panState.startViewportX + deltaX,
				y: this.panState.startViewportY + deltaY,
			};
			this.applyViewport();
		}
	};

	private readonly handlePointerUp = (event: PointerEvent): void => {
		if (this.dragState) {
			this.dragState.element.classList.remove('is-dragging');
			this.suppressNextClick = this.dragState.moved;
			if (this.suppressNextClick) {
				window.setTimeout(() => {
					this.suppressNextClick = false;
				}, 0);
			}
			this.dragState = undefined;
		}

		if (this.panState && event.pointerId === this.panState.pointerId) {
			this.suppressNextCanvasClick = this.panState.moved;
			if (this.suppressNextCanvasClick) {
				window.setTimeout(() => {
					this.suppressNextCanvasClick = false;
				}, 0);
			}
			this.panState = undefined;
			this.canvas.classList.remove('is-panning');
			if (this.canvas.hasPointerCapture(event.pointerId)) {
				this.canvas.releasePointerCapture(event.pointerId);
			}
		}
	};

	private readonly handleCanvasClick = (event: MouseEvent): void => {
		if (this.suppressNextCanvasClick) {
			this.suppressNextCanvasClick = false;
			return;
		}
		if (!(event.target as HTMLElement).closest('.graph-box, .graph-toolbar')) {
			this.clearSelection();
		}
	};
}
