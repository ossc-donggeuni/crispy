import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';

/** function getTypeLabel( node )
 *
 * - Directory에는 DIR을, File에는 확장자 기반 종류 Label을 반환한다.
 *
 * @param node Label을 계산할 Directory 또는 File 노드
 * @returns 	Bubble에 표시할 짧은 종류 문자열
 */
function getTypeLabel(node: ProjectNode): string {
	if (node.type === 'directory') {
		return 'DIR';
	}

	const extension = node.name.split('.').pop();
	return extension?.toUpperCase() ?? 'FILE';
}

/** function createStructureBubble( node, context )
 *
 * - 접힌 Directory 또는 File을 종류 Badge와 이름이 있는 작은 Card로 표시한다.
 * - Directory 주 버튼은 펼침을, File 주 버튼은 선택을 실행한다.
 * - 별도 Action 버튼으로 Directory 또는 File Detail Box를 펼치고 접는다.
 *
 * @param node 	표시할 Directory 또는 File 노드
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		렌더링된 Structure Bubble 요소
 */
export function createStructureBubble(
	node: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const isDirectory = node.type === 'directory';
	const isExpanded = isDirectory
		? context.expandedDirectoryIds.has(node.id)
		: context.expandedFileIds.has(node.id);

	const bubble = createElement('article', 'structure-bubble');
	bubble.dataset.nodeId = node.id;
	bubble.dataset.kind = node.type;
	bubble.classList.toggle('is-expanded', isExpanded);
	applyNodeState(bubble, node.id, context);

	const selectButton = createElement('button', 'bubble-main');
	selectButton.type = 'button';
	selectButton.title = isDirectory
		? `${isExpanded ? 'Collapse' : 'Open'} ${node.name}`
		: `Select ${node.name}`;
	selectButton.setAttribute('aria-pressed', String(context.selectedNodeId === node.id));

	const typeBadge = createElement('span', 'bubble-type', getTypeLabel(node));
	typeBadge.setAttribute('aria-hidden', 'true');
	const label = createElement('span', 'bubble-label', node.name);
	selectButton.append(typeBadge, label);

	selectButton.addEventListener('click', (event) => {
		event.stopPropagation();
		// Directory Bubble은 선택과 펼침을 한 번에 처리한다.
		if (isDirectory) {
			context.onToggleDirectory(node.id);
			return;
		}
		context.onSelect(node.id);
	});

	const actionButton = createElement(
		'button',
		'bubble-action',
		isExpanded ? '−' : '+',
	);
	actionButton.type = 'button';
	actionButton.title = isDirectory
		? `${isExpanded ? 'Collapse' : 'Open'} directory`
		: `${isExpanded ? 'Close' : 'Open'} file details`;
	actionButton.setAttribute('aria-label', actionButton.title);
	actionButton.setAttribute('aria-expanded', String(isExpanded));
	actionButton.addEventListener('click', (event) => {
		event.stopPropagation();
		// 별도 Action 버튼은 현재 종류에 맞는 상세 Box 상태만 변경한다.
		if (isDirectory) {
			context.onToggleDirectory(node.id);
			return;
		}
		context.onToggleFile(node.id);
	});

	bubble.append(selectButton, actionButton);
	return bubble;
}
