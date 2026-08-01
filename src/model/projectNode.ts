/** type ProjectNodeType
 *
 * - 그래프에서 사용하는 프로젝트, 디렉터리, 파일, Symbol 노드 종류를 정의한다.
 */
export type ProjectNodeType =
	| 'project'
	| 'application'
	| 'directory'
	| 'file'
	| 'symbol';

/** type ProjectNode
 *
 * - 화면 표시 이름과 내부 ID를 분리해 하나의 프로젝트 구조 항목을 표현한다.
 * - parentId와 childrenIds로 Workspace 계층 관계를 연결한다.
 */
export type ProjectNode = {
	id: string;
	type: ProjectNodeType;
	name: string;
	relativePath?: string;
	parentId?: string;
	childrenIds: string[];
};

/** type SharedSelection
 *
 * - GraphView와 외부 화면이 공유할 현재 선택 상태를 정의한다.
 */
export type SharedSelection = {
	selectedTaskId?: string;
	selectedNodeId?: string;
};

/** type NodePlanInfo
 *
 * - 향후 Plan 데이터가 노드에 전달될 때 사용할 강조 정보의 입력 경계를 정의한다.
 */
export type NodePlanInfo = {
	nodeId: string;
	relation: 'direct' | 'reference' | 'possible-impact';
	changes: Array<'create' | 'modify' | 'delete'>;
	taskIds: string[];
	matchStatus: 'resolved' | 'scoped' | 'unresolved';
	hasMultipleWriteTasks: boolean;
};

/** type GraphPosition
 *
 * - 그래프 좌표계에서 이동 가능한 박스의 위치를 정의한다.
 */
export type GraphPosition = {
	x: number;
	y: number;
};

/** type GraphViewport
 *
 * - Canvas의 Pan 좌표와 Zoom 비율을 함께 정의한다.
 */
export type GraphViewport = GraphPosition & {
	zoom: number;
};
