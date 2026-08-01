import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';
import { createStructureBubble } from './StructureBubble';

/** function createDirectoryBox( directory, context )
 *
 * - 디렉터리 이름, 상대 경로, 직접 항목 수와 Collapse 버튼을 표시한다.
 * - 직접 포함된 Directory와 File을 Structure Bubble Grid로 배치한다.
 * - Box 드래그, 접기, 디렉터리 선택 이벤트를 GraphView에 연결한다.
 *
 * @param directory 표시할 Directory 노드
 * @param context 	그래프 컴포넌트 공통 컨텍스트
 * @returns 			렌더링된 Directory Box 요소
 */
export function createDirectoryBox(
	directory: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const box = createElement('section', 'graph-box directory-box');
	box.dataset.boxId = directory.id;
	box.dataset.nodeId = directory.id;
	applyNodeState(box, directory.id, context);

	const header = createElement('header', 'box-header box-drag-handle');
	header.dataset.dragHandle = 'true';
	header.addEventListener('pointerdown', context.onBoxPointerDown);

	const heading = createElement('div', 'box-heading');
	const eyebrow = createElement('span', 'box-eyebrow', 'DIRECTORY');
	const titleRow = createElement('div', 'box-title-row');
	const title = createElement('h2', 'box-title', directory.name);
	const count = createElement(
		'span',
		'box-count compact',
		String(directory.childrenIds.length),
	);
	titleRow.append(title, count);
	const path = createElement(
		'span',
		'box-path',
		directory.relativePath ?? directory.name,
	);
	heading.append(eyebrow, titleRow, path);

	const collapseButton = createElement('button', 'box-collapse', 'Collapse');
	collapseButton.type = 'button';
	collapseButton.title = `Collapse ${directory.name}`;
	collapseButton.addEventListener('click', (event) => {
		event.stopPropagation();
		context.onToggleDirectory(directory.id);
	});

	header.append(heading, collapseButton);

	const body = createElement('div', 'box-body');
	if (directory.childrenIds.length === 0) {
		// 직접 자식이 없는 실제 빈 디렉터리는 별도 안내 문구를 표시한다.
		body.append(createElement('p', 'box-empty', 'This directory is empty.'));
	} else {
		const grid = createElement('div', 'bubble-grid');
		for (const childId of directory.childrenIds) {
			const child = context.nodesById.get(childId);
			if (child) {
				grid.append(createStructureBubble(child, context));
			}
		}
		body.append(grid);
	}

	box.append(header, body);
	box.addEventListener('click', (event) => {
		// Collapse와 Bubble 버튼이 아닌 Box 빈 영역에서 디렉터리를 선택한다.
		const target = event.target as HTMLElement;
		if (!target.closest('button')) {
			context.onSelect(directory.id);
		}
	});
	return box;
}
