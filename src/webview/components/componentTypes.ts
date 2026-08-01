import type { NodePlanInfo, ProjectNode } from '../../model/projectNode';
import type {
	FileAnalysisState,
	SymbolMetadata,
} from '../../model/fileAnalysis';

/** type GraphComponentContext
 *
 * - 그래프 DOM 컴포넌트가 공유할 읽기 전용 상태와 사용자 동작 콜백을 정의한다.
 * - 컴포넌트가 GraphView 내부 구현이나 VS Code API에 직접 의존하지 않게 한다.
 */
export type GraphComponentContext = {
	nodesById: ReadonlyMap<string, ProjectNode>;
	selectedNodeId?: string;
	expandedDirectoryIds: ReadonlySet<string>;
	expandedFileIds: ReadonlySet<string>;
	planInfoByNodeId: ReadonlyMap<string, NodePlanInfo>;
	fileAnalysisStates: ReadonlyMap<string, FileAnalysisState>;
	symbolMetadataByNodeId: ReadonlyMap<string, SymbolMetadata>;
	onSelect: (nodeId: string) => void;
	onToggleDirectory: (nodeId: string) => void;
	onToggleFile: (nodeId: string) => void;
	onRetryFileAnalysis: (nodeId: string) => void;
	onBoxPointerDown: (event: PointerEvent) => void;
};

/** function applyNodeState( element, nodeId, context )
 *
 * - 현재 선택된 노드에 선택 강조 Class를 적용한다.
 * - 선택적으로 주입된 Plan 관계를 data 속성에 연결한다.
 *
 * @param element 상태를 적용할 노드 DOM 요소
 * @param nodeId 	요소가 표현하는 ProjectNode ID
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		반환값 없음
 */
export function applyNodeState(
	element: HTMLElement,
	nodeId: string,
	context: GraphComponentContext,
): void {
	if (context.selectedNodeId === nodeId) {
		element.classList.add('is-selected');
	}

	const planInfo = context.planInfoByNodeId.get(nodeId);
	if (planInfo) {
		element.dataset.relation = planInfo.relation;
	}
}

/** function createElement( tagName, className, text )
 *
 * - 지정한 HTML Tag를 생성하고 선택적 Class와 Text를 적용한다.
 *
 * @param tagName 		생성할 HTML Tag 이름
 * @param className 	선택적으로 적용할 CSS Class
 * @param text 			선택적으로 설정할 Text Content
 * @returns 			Tag 이름에 해당하는 타입의 HTML 요소
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tagName);
	if (className) {
		element.className = className;
	}
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}
