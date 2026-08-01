import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';
import { createStructureBubble } from './StructureBubble';

/** function createProjectBox( project, context )
 *
 * - 프로젝트 이름, 경로, 직접 자식 수를 표시하는 루트 Box를 만든다.
 * - 직접 포함된 Directory와 File을 Structure Bubble로 배치한다.
 * - Box 드래그와 프로젝트 선택 이벤트를 GraphView 컨텍스트에 연결한다.
 *
 * @param project 표시할 Project 노드
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		렌더링된 Project Box 요소
 */
export function createProjectBox(
	project: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const box = createElement('section', 'graph-box project-box');
	box.dataset.boxId = project.id;
	box.dataset.nodeId = project.id;
	applyNodeState(box, project.id, context);

	const header = createElement('header', 'box-header box-drag-handle');
	header.dataset.dragHandle = 'true';
	header.addEventListener('pointerdown', context.onBoxPointerDown);

	const heading = createElement('div', 'box-heading');
	const eyebrow = createElement('span', 'box-eyebrow', 'PROJECT');
	const title = createElement('h2', 'box-title', project.name);
	const path = createElement('span', 'box-path', project.relativePath ?? project.name);
	heading.append(eyebrow, title, path);

	const count = createElement(
		'span',
		'box-count',
		`${project.childrenIds.length} direct items`,
	);
	header.append(heading, count);

	const body = createElement('div', 'box-body');
	const hint = createElement(
		'p',
		'box-hint',
		'Open directories to arrange the project structure.',
	);
	const grid = createElement('div', 'bubble-grid');

	// Project의 childrenIds 순서를 유지해 직접 자식 Bubble을 배치한다.
	for (const childId of project.childrenIds) {
		const child = context.nodesById.get(childId);
		if (child) {
			grid.append(createStructureBubble(child, context));
		}
	}

	body.append(hint, grid);
	box.append(header, body);
	box.addEventListener('click', (event) => {
		// 내부 버튼 동작이 아닌 Box 빈 영역 Click에서 프로젝트를 선택한다.
		const target = event.target as HTMLElement;
		if (!target.closest('button')) {
			context.onSelect(project.id);
		}
	});
	return box;
}
