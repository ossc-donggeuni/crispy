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

/** type GraphViewOptions
 *
 * - GraphView가 표시할 ProjectNode와 선택적 Plan 정보를 외부에서 주입받는다.
 * - 선택 변경과 파일 분석 요청을 Webview 진입점에 전달할 콜백을 정의한다.
 */
export type GraphViewOptions = {
	nodes: readonly ProjectNode[];
	planInfo?: readonly NodePlanInfo[];
	onSelectionChange?: (selection: SharedSelection) => void;
	onFileAnalysisRequest?: (
		fileNode: ProjectNode,
		requestId: string,
	) => void;
};

/** type DragState
 *
 * - 그래프 박스를 드래그하는 동안 필요한 시작 좌표와 이동 여부를 저장한다.
 */
type DragState = {
	nodeId: string;
	element: HTMLElement;
	startClientX: number;
	startClientY: number;
	startPosition: GraphPosition;
	moved: boolean;
};

/** type PanState
 *
 * - 빈 Canvas를 Pan하는 동안 Pointer와 Viewport 시작 상태를 저장한다.
 */
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

/** class GraphView
 *
 * - ProjectNode를 중첩 가능한 프로젝트 구조 박스로 렌더링한다.
 * - 디렉터리와 파일 펼침, 선택, 박스 이동, Pan, Zoom, Fit View를 관리한다.
 * - 파일 분석 결과를 현재 인스턴스에 부분 반영해 사용자 배치 상태를 유지한다.
 */
export class GraphView {
	private readonly root: HTMLElement; // GraphView가 렌더링되는 Webview 루트 요소
	private readonly nodesById: Map<string, ProjectNode>; // 노드 ID별 복제된 현재 그래프 데이터
	private readonly planInfoByNodeId: ReadonlyMap<string, NodePlanInfo>; // 외부 Plan 강조 정보
	private readonly symbolMetadataByNodeId = new Map<string, SymbolMetadata>(); // Symbol ID별 표시 정보
	private readonly fileAnalysisStates = new FileAnalysisStateStore(); // 파일 ID별 분석 상태
	private readonly onSelectionChange?: (selection: SharedSelection) => void;
	private readonly onFileAnalysisRequest?: (
		fileNode: ProjectNode,
		requestId: string,
	) => void;
	private readonly projectNode?: ProjectNode; // 그래프의 최상위 Project 노드
	private readonly expandedDirectoryIds = new Set<string>(); // 열린 디렉터리 ID 집합
	private readonly expandedFileIds = new Set<string>(); // 열린 파일 상세 ID 집합
	private readonly positions = new Map<string, GraphPosition>(); // 이동 가능한 박스별 좌표
	private readonly boxElements = new Map<string, HTMLElement>(); // 현재 렌더링된 박스 DOM

	private selection: SharedSelection = {}; // 현재 단일 노드 선택 상태
	private viewport: GraphViewport = { x: 0, y: 0, zoom: 1 }; // 현재 Canvas Pan과 Zoom 상태
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

	/** constructor ( root, options )
	 *
	 * - 외부 노드와 Plan 정보를 GraphView 내부 상태로 복제한다.
	 * - Project 초기 위치를 정하고 Canvas Shell과 그래프를 렌더링한다.
	 * - 첫 렌더링 다음 Frame에 전체 구조가 보이도록 Fit View를 실행한다.
	 *
	 * @param root 	GraphView를 렌더링할 Webview 루트 요소
	 * @param options 노드 데이터와 외부 콜백을 포함한 GraphView 옵션
	 */
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

	/** function dispose()
	 *
	 * - 예약된 초기 Fit View와 전역 Pointer 이벤트를 정리한다.
	 * - GraphView가 생성한 루트 DOM을 제거한다.
	 *
	 * @returns 반환값 없음
	 */
	public dispose(): void {
		if (this.initialFitFrame !== undefined) {
			window.cancelAnimationFrame(this.initialFitFrame);
		}
		window.removeEventListener('pointermove', this.handlePointerMove);
		window.removeEventListener('pointerup', this.handlePointerUp);
		this.root.replaceChildren();
	}

	/** function setFileAnalysisResult( result )
	 *
	 * - 최신 requestId와 일치하는 파일 분석 결과만 적용한다.
	 * - 파일의 기존 Symbol 자식을 제거하고 새 노드와 메타데이터로 교체한다.
	 * - 박스 위치, Viewport, 펼침 상태를 유지한 채 그래프만 다시 렌더링한다.
	 *
	 * @param result Extension에서 전달받은 파일 분석 결과
	 * @returns 		결과 적용 여부
	 */
	public setFileAnalysisResult(result: FileAnalysisResult): boolean {
		const fileNode = this.nodesById.get(result.fileNodeId);
		if (
			fileNode?.type !== 'file'
			|| !this.fileAnalysisStates.applyResult(result)
		) {
			return false;
		}

		// 이전 분석에서 생성된 Symbol 노드와 메타데이터를 내부 Map에서 제거한다.
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
		// 요청한 파일의 유효한 Symbol 자식만 중복 없이 추가한다.
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

		// 실제로 추가된 Symbol 노드에 해당하는 메타데이터만 저장한다.
		for (const metadata of result.symbolMetadata) {
			if (nextSymbolIdSet.has(metadata.nodeId)) {
				this.symbolMetadataByNodeId.set(metadata.nodeId, metadata);
			}
		}

		this.nodesById.set(fileNode.id, {
			...fileNode,
			childrenIds: nextSymbolIds,
		});

		// 선택한 Symbol이 새 결과에서 사라졌다면 선택을 부모 파일로 이동한다.
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

	/** function renderShell()
	 *
	 * - 상단 브랜드와 GraphToolbar, Canvas, 선택 상태 Footer를 생성한다.
	 * - Wheel, Canvas Pointer, 전역 Pointer 이동 및 종료 이벤트를 등록한다.
	 *
	 * @returns 반환값 없음
	 */
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

	/** function renderGraph()
	 *
	 * - 현재 노드, 펼침, 분석 상태를 사용해 Stage의 박스를 다시 생성한다.
	 * - 보이는 Project, Directory, File Detail Box와 연결선을 렌더링한다.
	 * - 현재 Viewport와 선택 상태를 다시 적용하고 렌더링 오류를 처리한다.
	 *
	 * @returns 반환값 없음
	 */
	private renderGraph(): void {
		try {
			// 기존 Stage 자식은 교체하되 positions와 viewport 상태 Map은 유지한다.
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
				// 입력 노드에 Project가 없으면 빈 상태를 표시한다.
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

			// 열린 상위 경로가 모두 보이는 Directory Box만 렌더링한다.
			for (const node of this.nodesById.values()) {
				if (node.type === 'directory' && this.isDirectoryVisible(node.id)) {
					this.ensurePosition(node);
					this.addBox(node, createDirectoryBox(node, context));
				}
			}

			// 열린 디렉터리 안에서 펼쳐진 파일의 상세 박스만 렌더링한다.
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

	/** function createComponentContext()
	 *
	 * - 하위 DOM 컴포넌트가 필요한 읽기 전용 상태와 동작 콜백을 구성한다.
	 * - VS Code API를 노출하지 않고 GraphView 메서드만 컴포넌트에 전달한다.
	 *
	 * @returns 모든 그래프 컴포넌트가 공유할 렌더링 컨텍스트
	 */
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

	/** function addBox( node, element )
	 *
	 * - 저장된 그래프 좌표를 Box DOM 스타일에 적용한다.
	 * - 연결선 계산용 DOM Map과 Stage에 Box를 등록한다.
	 *
	 * @param node 	추가할 ProjectNode
	 * @param element 렌더링된 Box DOM 요소
	 * @returns 		반환값 없음
	 */
	private addBox(node: ProjectNode, element: HTMLElement): void {
		const position = this.positions.get(node.id) ?? { x: 70, y: 180 };
		element.style.left = `${position.x}px`;
		element.style.top = `${position.y}px`;
		this.boxElements.set(node.id, element);
		this.stage.append(element);
	}

	/** function ensurePosition( node )
	 *
	 * - 아직 배치되지 않은 Directory 또는 File Detail Box의 초기 위치를 계산한다.
	 * - 부모 위치와 형제 순서를 기준으로 겹침을 줄인 단순 가로 배치를 적용한다.
	 * - 사용자가 이미 이동한 좌표는 변경하지 않는다.
	 *
	 * @param node 초기 위치가 필요한 노드
	 * @returns 	반환값 없음
	 */
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

	/** function isDirectoryVisible( directoryId )
	 *
	 * - 디렉터리 자체와 모든 상위 디렉터리가 펼쳐져 있는지 검사한다.
	 * - Project에 연결된 열린 디렉터리만 화면에 표시하도록 판정한다.
	 *
	 * @param directoryId 검사할 디렉터리 노드 ID
	 * @returns 			Directory Box 표시 여부
	 */
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

	/** function isFileDetailVisible( file )
	 *
	 * - 파일 상세가 펼쳐져 있고 부모 디렉터리가 보이는지 검사한다.
	 *
	 * @param file 검사할 파일 노드
	 * @returns 	File Detail Box 표시 여부
	 */
	private isFileDetailVisible(file: ProjectNode): boolean {
		if (!this.expandedFileIds.has(file.id) || !file.parentId) {
			return false;
		}
		return this.isDirectoryVisible(file.parentId);
	}

	/** function toggleDirectory( nodeId )
	 *
	 * - 하나의 디렉터리 ID를 펼침 집합에서 독립적으로 추가하거나 제거한다.
	 * - 새로 연 박스의 위치를 정하고 해당 디렉터리를 선택한다.
	 *
	 * @param nodeId 펼치거나 접을 디렉터리 노드 ID
	 * @returns 	반환값 없음
	 */
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

	/** function toggleFile( nodeId )
	 *
	 * - 파일 상세 박스를 펼침 집합에서 추가하거나 제거한다.
	 * - 처음 펼치는 실제 파일은 위치를 정하고 Symbol 분석을 요청한다.
	 *
	 * @param nodeId 펼치거나 접을 파일 노드 ID
	 * @returns 	반환값 없음
	 */
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

	/** function retryFileAnalysis( nodeId )
	 *
	 * - 파일 노드의 failed 분석 상태를 새 requestId로 재시도한다.
	 *
	 * @param nodeId 다시 분석할 파일 노드 ID
	 * @returns 	반환값 없음
	 */
	private retryFileAnalysis(nodeId: string): void {
		const fileNode = this.nodesById.get(nodeId);
		if (fileNode?.type !== 'file') {
			return;
		}

		this.requestFileAnalysis(fileNode, true);
		this.renderGraph();
	}

	/** function requestFileAnalysis( fileNode, isRetry )
	 *
	 * - 파일 상대 경로와 현재 분석 상태를 확인해 중복 요청을 방지한다.
	 * - 최초 펼침 또는 명시적 Retry에서만 외부 분석 요청 콜백을 호출한다.
	 *
	 * @param fileNode 분석할 파일 노드
	 * @param isRetry 실패 후 명시적 재시도 여부
	 * @returns 		반환값 없음
	 */
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

	/** function selectNode( nodeId )
	 *
	 * - 박스 드래그 직후 발생한 Click을 선택 동작으로 오인하지 않도록 막는다.
	 * - 정상 Click이면 단일 선택 상태를 변경하고 그래프 강조를 다시 렌더링한다.
	 *
	 * @param nodeId 선택할 노드 ID
	 * @returns 	반환값 없음
	 */
	private selectNode(nodeId: string): void {
		if (this.suppressNextClick) {
			this.suppressNextClick = false;
			return;
		}
		this.setSelection(nodeId);
		this.renderGraph();
	}

	/** function clearSelection()
	 *
	 * - 현재 선택된 노드가 있으면 선택을 해제하고 그래프를 다시 렌더링한다.
	 *
	 * @returns 반환값 없음
	 */
	private clearSelection(): void {
		if (!this.selection.selectedNodeId) {
			return;
		}
		this.setSelection(undefined);
		this.renderGraph();
	}

	/** function setSelection( nodeId )
	 *
	 * - 내부 단일 선택 상태를 교체하고 외부 선택 변경 콜백에 전달한다.
	 *
	 * @param nodeId 선택할 노드 ID 또는 선택 해제를 위한 undefined
	 * @returns 	반환값 없음
	 */
	private setSelection(nodeId: string | undefined): void {
		this.selection = { selectedNodeId: nodeId };
		this.onSelectionChange?.(this.selection);
	}

	/** function renderConnections()
	 *
	 * - 현재 보이는 부모 Box와 자식 Box 사이의 SVG 곡선을 다시 계산한다.
	 * - Box 이동과 펼침 상태에 맞춰 연결선 DOM을 교체한다.
	 *
	 * @returns 반환값 없음
	 */
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

	/** function fitView()
	 *
	 * - 현재 보이는 모든 Box의 경계 영역을 계산한다.
	 * - 최소·최대 Zoom 범위 안에서 전체 구조가 Canvas 중앙에 오도록 맞춘다.
	 *
	 * @returns 반환값 없음
	 */
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

	/** function zoomBy( factor )
	 *
	 * - Canvas 중앙을 기준으로 현재 Zoom에 배율을 적용한다.
	 *
	 * @param factor 현재 Zoom에 곱할 배율
	 * @returns 	반환값 없음
	 */
	private zoomBy(factor: number): void {
		const rect = this.canvas.getBoundingClientRect();
		this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
	}

	/** function zoomAt( clientX, clientY, factor )
	 *
	 * - 지정한 화면 좌표 아래의 그래프 지점이 고정되도록 Zoom과 Pan을 함께 계산한다.
	 *
	 * @param clientX Zoom 기준점의 화면 X 좌표
	 * @param clientY Zoom 기준점의 화면 Y 좌표
	 * @param factor  현재 Zoom에 곱할 배율
	 * @returns 	  반환값 없음
	 */
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

	/** function clampZoom( zoom )
	 *
	 * - Zoom 값을 GraphView가 허용하는 최소·최대 범위로 제한한다.
	 *
	 * @param zoom 제한할 Zoom 값
	 * @returns 	허용 범위로 조정한 Zoom 값
	 */
	private clampZoom(zoom: number): number {
		return Math.min(maximumZoom, Math.max(minimumZoom, zoom));
	}

	/** function applyViewport()
	 *
	 * - 현재 Pan과 Zoom을 Stage transform에 적용한다.
	 * - GraphToolbar에 현재 Zoom 백분율을 갱신한다.
	 *
	 * @returns 반환값 없음
	 */
	private applyViewport(): void {
		this.stage.style.transform =
			`translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.zoom})`;
		this.toolbar.updateZoom(this.viewport.zoom);
	}

	/** function renderError( error )
	 *
	 * - 그래프 렌더링 예외를 빈 화면 대신 기본 오류 상태로 표시한다.
	 * - 개발자 확인을 위해 Webview Console에도 원본 오류를 기록한다.
	 *
	 * @param error 렌더링 중 발생한 오류
	 * @returns 	반환값 없음
	 */
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

	/** function handleWheel( event )
	 *
	 * - 브라우저 기본 Scroll을 막고 Pointer 위치를 기준으로 Canvas를 확대·축소한다.
	 *
	 * @param event Canvas에서 발생한 Wheel 이벤트
	 * @returns 	반환값 없음
	 */
	private readonly handleWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const factor = Math.exp(-event.deltaY * 0.0015);
		this.zoomAt(event.clientX, event.clientY, factor);
	};

	/** function handleCanvasPointerDown( event )
	 *
	 * - 왼쪽 버튼으로 빈 Canvas를 누른 경우 Pan 시작 상태를 저장한다.
	 * - Box와 Toolbar 내부 Pointer는 Canvas Pan으로 처리하지 않는다.
	 *
	 * @param event Canvas에서 발생한 PointerDown 이벤트
	 * @returns 	반환값 없음
	 */
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

	/** function handleBoxPointerDown( event )
	 *
	 * - 버튼이 아닌 Box 헤더 또는 빈 영역에서 드래그 시작 상태를 저장한다.
	 * - 내부 Bubble Click이 부모 Box 드래그나 Canvas Pan으로 전파되지 않게 한다.
	 *
	 * @param event Box에서 발생한 PointerDown 이벤트
	 * @returns 	반환값 없음
	 */
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

	/** function handlePointerMove( event )
	 *
	 * - Box 드래그 중에는 Zoom을 고려한 그래프 좌표로 위치와 연결선을 갱신한다.
	 * - Canvas Pan 중에는 Pointer 이동량으로 Viewport 좌표를 갱신한다.
	 *
	 * @param event Window에서 발생한 PointerMove 이벤트
	 * @returns 	반환값 없음
	 */
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

	/** function handlePointerUp( event )
	 *
	 * - Box 드래그와 Canvas Pan 상태 및 Pointer Capture를 종료한다.
	 * - 이동 직후 발생하는 Click이 선택이나 해제로 처리되지 않도록 잠시 억제한다.
	 *
	 * @param event Window에서 발생한 PointerUp 이벤트
	 * @returns 	반환값 없음
	 */
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

	/** function handleCanvasClick( event )
	 *
	 * - Pan 직후 Click은 무시하고 실제 빈 Canvas Click에서만 선택을 해제한다.
	 *
	 * @param event Canvas에서 발생한 Click 이벤트
	 * @returns 	반환값 없음
	 */
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
