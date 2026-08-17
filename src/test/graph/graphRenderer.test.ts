import * as assert from 'assert';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
} from '../../webview/graph/graphCamera';
import {
	createFileGroupId,
	createGraphLayout,
	type GraphLayout,
	type GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import { GRAPH_MOCK_PROJECT } from '../../webview/graph/graphMockData';
import {
	createSingleRootGraph,
	isFolder,
	type Project,
} from '../../webview/graph/graphModel';
import { GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE } from '../../webview/graph/graphNodeDrag';
import {
	initializeGraphRenderer,
	type GraphRendererInteractions,
} from '../../webview/graph/graphRenderer';
import {
	createGraphState,
	type GraphState,
} from '../../webview/graph/graphState';
import { DEFAULT_PANEL_LAYOUT_STATE } from '../../webview/panel/panelState';
import {
	restoreWebviewState,
	saveWebviewState,
	type PersistedWebviewState,
	type WebviewStateApi,
} from '../../webview/webviewState';

suite('Graph Renderer / Node Drag', () => {
	test('Project Root, Folder, File Group과 Edge를 지정된 Layer에 렌더링한다', () => {
		const fixture = createRendererFixture();
		const root = fixture.getNode(GRAPH_MOCK_PROJECT.id);
		const folder = fixture.getNode('folder:app/src');
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));

		assert.strictEqual(fixture.nodeLayer.children.length, fixture.layout.nodes.length);
		assert.strictEqual(fixture.edgeLayer.children.length, fixture.layout.edges.length);
		assert.strictEqual(root.hasClass('graph-project-node'), true);
		assert.strictEqual(folder.hasClass('graph-folder-node'), true);
		assert.strictEqual(fileGroup.hasClass('graph-file-group-node'), true);
		const containerNodes = fixture.nodeLayer.children
			.filter((node) => !node.hasClass('graph-file-group-node'));
		const folderIcons = containerNodes.map(
			(node) => getDescendantByClass(node, 'graph-folder-icon'),
		);

		assert.ok(folderIcons.every((icon) => icon.tagName === 'span'));
		assert.ok(folderIcons.every(
			(icon) => icon.getAttribute('aria-hidden') === 'true',
		));
		assert.ok(containerNodes.every(
			(node) => node.getAttribute('data-folder-icon') === 'folder-open.svg',
		));
		assert.strictEqual(root.getAttribute('aria-expanded'), null);
		assert.strictEqual(folder.getAttribute('aria-expanded'), 'true');
		assert.ok(!getText(root).includes('📁'));
		assert.ok(getText(root).includes('crispy/'));
		assert.ok(getText(folder).includes('src/'));
		assert.ok(getText(fileGroup).includes('graphView.ts'));
		assert.ok(getText(fileGroup).includes('graphRenderer.ts'));
		assert.ok(!getText(fileGroup).includes('graphNodeDrag.ts'));
		assert.ok(!getText(fileGroup).includes('▣'));
		assert.ok(getText(fileGroup).includes('+ 2개 더보기'));
		assert.strictEqual(
			fixture.edgeLayer.children.every((edge) => edge.hasClass('graph-edge')),
			true,
		);
		fixture.renderer.dispose();
	});

	test('File Row에 파일명 규칙과 확장자별 공통 아이콘 식별값을 렌더링한다', () => {
		const fixture = createRendererFixture();
		const cases = [
			['file:app/src/graphRenderer.ts', 'typescript'],
			['file:README.md', 'readme'],
			['file:src/webview/webview.css', 'css'],
			['file:package.json', 'npm'],
		] as const;

		for (const [fileId, expectedIcon] of cases) {
			const row = getDescendantByAttribute(
				fixture.nodeLayer,
				'data-file-id',
				fileId,
			);
			const icon = getDescendantByClass(row, 'graph-file-icon');

			assert.strictEqual(icon.getAttribute('data-file-icon'), expectedIcon);
			assert.strictEqual(icon.getAttribute('aria-hidden'), 'true');
			assert.strictEqual(icon.textContent, '');
		}

		fixture.renderer.dispose();
	});

	test('파일이 5개 이하이면 pagination control을 렌더링하지 않는다', () => {
		const project = createPaginationProject([5]);
		const fileGroupId = createFileGroupId('folder:pagination-0');
		const fixture = createRendererFixture(1, {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			fileGroupPages: { [fileGroupId]: 2 },
		}, {}, project);
		const fileGroup = fixture.getNode(fileGroupId);

		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-more'), undefined);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-collapse'), undefined);
		fixture.renderer.dispose();
	});

	test('17개 파일을 더보기로 모두 표시하고 Ghost 접기로 최초 상태에 복원한다', () => {
		const fileGroupClicks: string[] = [];
		const project = createPaginationProject([17]);
		const fixture = createRendererFixture(1, undefined, {
			onFileGroupClick: (folderId) => fileGroupClicks.push(folderId),
		}, project);
		const fileGroupId = createFileGroupId('folder:pagination-0');
		const fileGroup = fixture.getNode(fileGroupId);
		const initialHeight = fileGroup.style.height;
		const connectedEdge = fixture.getConnectedEdge(fileGroupId);
		const edgeWrites = connectedEdge.getAttributeWriteCount('d');
		let more = getDescendantByClass(fileGroup, 'graph-file-more');

		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		assert.strictEqual(more.tagName, 'button');
		assert.strictEqual(more.type, 'button');
		assert.strictEqual(more.textContent, '+ 12개 더보기');
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-collapse'), undefined);
		assert.strictEqual(more.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE), true);
		more.dispatch('pointerdown', createPointerEvent(more, 10, 10));
		more.dispatch('pointermove', createPointerEvent(more, 60, 40));
		assert.strictEqual(fileGroup.hasPointerCapture(1), false);

		const firstMoreClick = createClickEvent(more);
		more.dispatch('click', firstMoreClick);
		more = getDescendantByClass(fileGroup, 'graph-file-more');
		let collapse = getDescendantByClass(fileGroup, 'graph-file-collapse');

		assert.strictEqual(firstMoreClick.propagationStopped, true);
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 2);
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 10);
		assert.strictEqual(more.textContent, '+ 7개 더보기');
		assert.strictEqual(collapse.tagName, 'button');
		assert.strictEqual(collapse.type, 'button');
		assert.strictEqual(collapse.getAttribute('aria-label'), '파일 목록 접기');
		assert.strictEqual(
			collapse.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE),
			true,
		);
		assert.strictEqual(
			getDescendantByClass(collapse, 'graph-file-collapse-icon').tagName,
			'svg',
		);

		more.dispatch('click', createClickEvent(more));
		more = getDescendantByClass(fileGroup, 'graph-file-more');
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 3);
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 15);
		assert.strictEqual(more.textContent, '+ 2개 더보기');

		more.dispatch('click', createClickEvent(more));
		collapse = getDescendantByClass(fileGroup, 'graph-file-collapse');
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 4);
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 17);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-more'), undefined);
		assert.strictEqual(fileGroup.style.height, initialHeight);
		assert.strictEqual(connectedEdge.getAttributeWriteCount('d'), edgeWrites);

		const collapseClick = createClickEvent(collapse);
		collapse.dispatch('click', collapseClick);
		const moreAfterCollapse = getDescendantByClass(fileGroup, 'graph-file-more');

		assert.strictEqual(collapseClick.propagationStopped, true);
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 1);
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		assert.strictEqual(moreAfterCollapse.textContent, '+ 12개 더보기');
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-collapse'), undefined);
		assert.deepStrictEqual(fileGroupClicks, []);

		fixture.renderer.dispose();
		moreAfterCollapse.dispatch('click', createClickEvent(moreAfterCollapse));
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 1);
		assert.deepStrictEqual(fileGroupClicks, []);
	});

	test('File Group page를 독립 관리하고 변경된 그룹 contents만 갱신한다', () => {
		const project = createPaginationProject([17, 17]);
		const fixture = createRendererFixture(1, undefined, {}, project);
		const firstId = createFileGroupId('folder:pagination-0');
		const secondId = createFileGroupId('folder:pagination-1');
		const first = fixture.getNode(firstId);
		const second = fixture.getNode(secondId);
		const firstRow = getDescendantByClass(first, 'graph-file-item');
		const secondRow = getDescendantByClass(second, 'graph-file-item');
		const secondMore = getDescendantByClass(second, 'graph-file-more');

		fixture.graphState.setState({
			camera: { x: 40, y: -20, scale: 1.5 },
			nodePositions: {},
		});

		assert.strictEqual(getDescendantByClass(first, 'graph-file-item'), firstRow);
		assert.strictEqual(getDescendantByClass(second, 'graph-file-item'), secondRow);
		fixture.graphState.setState({
			camera: { x: 40, y: -20, scale: 1.5 },
			nodePositions: { 'folder:pagination-0': { x: 700, y: 240 } },
		});
		assert.strictEqual(getDescendantByClass(first, 'graph-file-item'), firstRow);
		assert.strictEqual(getDescendantByClass(second, 'graph-file-item'), secondRow);

		getDescendantByClass(first, 'graph-file-more').dispatch(
			'click',
			createClickEvent(getDescendantByClass(first, 'graph-file-more')),
		);

		assert.strictEqual(fixture.graphState.getFileGroupPage(firstId), 2);
		assert.strictEqual(fixture.graphState.getFileGroupPage(secondId), 1);
		assert.strictEqual(getDescendantsByClass(first, 'graph-file-item').length, 10);
		assert.strictEqual(getDescendantsByClass(second, 'graph-file-item').length, 5);
		assert.strictEqual(getDescendantByClass(second, 'graph-file-item'), secondRow);
		assert.strictEqual(getDescendantByClass(second, 'graph-file-more'), secondMore);
		fixture.renderer.dispose();
	});

	test('Folder, File Group, File Row Click을 각각 Callback으로 구분한다', () => {
		const folderClicks: string[] = [];
		const fileGroupClicks: string[] = [];
		const fileClicks: string[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onFolderClick: (folderId) => folderClicks.push(folderId),
			onFileGroupClick: (folderId) => fileGroupClicks.push(folderId),
			onFileClick: (fileId) => fileClicks.push(fileId),
		});
		const folder = fixture.getNode('folder:app');
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));
		const fileRow = getDescendantByClass(fileGroup, 'graph-file-item');
		const fileClick = createClickEvent(fileRow);

		folder.dispatch('click', createClickEvent(folder));
		fileGroup.dispatch('click', createClickEvent(fileGroup));
		fileRow.dispatch('click', fileClick);

		assert.deepStrictEqual(folderClicks, ['folder:app']);
		assert.deepStrictEqual(fileGroupClicks, ['folder:app/src']);
		assert.deepStrictEqual(fileClicks, ['file:app/src/graphView.ts']);
		assert.strictEqual(fileClick.propagationStopped, true);
		assert.strictEqual(fileRow.hasClass('is-file-clicking'), true);
		fileRow.dispatch('animationend', createAnimationEvent(fileRow));
		assert.strictEqual(fileRow.hasClass('is-file-clicking'), false);
		assert.strictEqual(
			fileRow.getAttribute('data-file-id'),
			'file:app/src/graphView.ts',
		);
		assert.strictEqual(
			fileRow.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE),
			true,
		);
		fixture.renderer.dispose();
	});

	test('Threshold를 넘긴 Node Drag 뒤 Click Callback을 실행하지 않는다', () => {
		const folderClicks: string[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onFolderClick: (folderId) => folderClicks.push(folderId),
		});
		const folder = fixture.getNode('folder:app');

		folder.dispatch('pointerdown', createPointerEvent(folder, 10, 10));
		folder.dispatch('pointermove', createPointerEvent(folder, 40, 30));
		folder.dispatch('pointerup', createPointerEvent(folder, 40, 30));
		folder.dispatch('click', createClickEvent(folder));
		assert.deepStrictEqual(folderClicks, []);

		folder.dispatch('pointerdown', createPointerEvent(folder, 40, 30));
		folder.dispatch('pointermove', createPointerEvent(folder, 42, 31));
		folder.dispatch('pointerup', createPointerEvent(folder, 42, 31));
		folder.dispatch('click', createClickEvent(folder));
		assert.deepStrictEqual(folderClicks, ['folder:app']);
		fixture.renderer.dispose();
	});

	test('File Row Pointer 입력은 File Group Drag와 Camera Pan을 시작하지 않는다', () => {
		const fixture = createRendererFixture();
		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));
		const fileRow = getDescendantByClass(fileGroup, 'graph-file-item');
		const pointerDown = createPointerEvent(fileRow, 10, 10);

		fileRow.dispatch('pointerdown', pointerDown);
		fileRow.dispatch('pointermove', createPointerEvent(fileRow, 60, 40));
		viewport.dispatch('pointerdown', pointerDown);
		viewport.dispatch('pointermove', createPointerEvent(fileRow, 60, 40));

		assert.strictEqual(fileGroup.hasPointerCapture(1), false);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
		assert.deepStrictEqual(camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(viewport.hasPointerCapture(1), false);
		camera.dispose();
		fixture.renderer.dispose();
	});

	test('Folder, File Group, File Row 위 Wheel은 Cursor 기준 Camera Zoom을 수행한다', () => {
		const fixture = createRendererFixture();
		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);
		const folder = fixture.getNode('folder:app');
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));
		const fileRow = getDescendantByClass(fileGroup, 'graph-file-item');
		const cursor = { x: 160, y: 120 };

		for (const target of [folder, fileGroup, fileRow]) {
			const scaleBefore = camera.getState().scale;
			const worldBefore = camera.viewportToWorld(cursor);
			const wheelEvent = createWheelEvent(target, cursor.x, cursor.y, -120);

			viewport.dispatch('wheel', wheelEvent);

			assert.ok(camera.getState().scale > scaleBefore);
			assertPointAlmostEqual(camera.viewportToWorld(cursor), worldBefore);
			assert.strictEqual(wheelEvent.defaultPrevented, true);
		}

		camera.dispose();
		fixture.renderer.dispose();
	});

	test('Camera-only 변경은 Edge를 다시 계산하지 않고 Node 위치 변경만 반영한다', () => {
		const fixture = createRendererFixture();
		const nodeId = 'folder:app';
		const node = fixture.getNode(nodeId);
		const edge = fixture.getConnectedEdge(nodeId);
		const edgeWritesBeforeCamera = edge.getAttributeWriteCount('d');

		fixture.graphState.setState({
			camera: { x: 100, y: -40, scale: 2 },
			nodePositions: {},
		});

		assert.strictEqual(edge.getAttributeWriteCount('d'), edgeWritesBeforeCamera);

		fixture.graphState.setState({
			camera: { x: 100, y: -40, scale: 2 },
			nodePositions: { [nodeId]: { x: 700, y: 240 } },
		});

		assert.strictEqual(node.style.transform, 'translate(700px, 240px)');
		assert.ok(edge.getAttributeWriteCount('d') > edgeWritesBeforeCamera);
		fixture.renderer.dispose();
	});

	test('applyLayout은 Node와 Edge를 제거·추가하고 유지 DOM을 재사용한다', () => {
		const removedFolderId = 'folder:app/src';
		const removedFileGroupId = createFileGroupId(removedFolderId);
		const removedEdgeId = `folder:app->${removedFolderId}`;
		const retainedNodeId = 'folder:app';
		const retainedEdgeId = `${GRAPH_MOCK_PROJECT.id}->${retainedNodeId}`;
		const savedPosition = { x: 820, y: 260 };
		const folderClicks: string[] = [];
		const fileClicks: string[] = [];
		const fixture = createRendererFixture(1, {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [removedFolderId]: savedPosition },
			fileGroupPages: { [removedFileGroupId]: 2 },
		}, {
			onFolderClick: (folderId) => folderClicks.push(folderId),
			onFileClick: (fileId) => fileClicks.push(fileId),
		});
		const removedFolder = fixture.getNode(removedFolderId);
		const removedFileGroup = fixture.getNode(removedFileGroupId);
		const removedFileRow = getDescendantByClass(
			removedFileGroup,
			'graph-file-item',
		);
		const removedEdge = fixture.getEdge(removedEdgeId);
		const retainedNode = fixture.getNode(retainedNodeId);
		const retainedEdge = fixture.getEdge(retainedEdgeId);
		const collapsedLayout = createGraphLayout(createSingleRootGraph(GRAPH_MOCK_PROJECT), {
			fileGroupPages: fixture.graphState.getState().fileGroupPages,
			openedFolders: {},
		});

		fixture.renderer.applyLayout(collapsedLayout);

		assert.strictEqual(fixture.nodeLayer.children.length, collapsedLayout.nodes.length);
		assert.strictEqual(fixture.edgeLayer.children.length, collapsedLayout.edges.length);
		assert.strictEqual(fixture.nodeLayer.children.includes(removedFolder), false);
		assert.strictEqual(
			fixture.nodeLayer.children.includes(removedFileGroup),
			false,
		);
		assert.strictEqual(fixture.edgeLayer.children.includes(removedEdge), false);
		assert.strictEqual(removedFolder.getEventListenerCount(), 0);
		assert.strictEqual(removedFileRow.getEventListenerCount(), 0);
		assert.strictEqual(fixture.getNode(retainedNodeId), retainedNode);
		assert.strictEqual(fixture.getEdge(retainedEdgeId), retainedEdge);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {
			[removedFolderId]: savedPosition,
		});
		assert.deepStrictEqual(fixture.graphState.getState().fileGroupPages, {
			[removedFileGroupId]: 2,
		});

		removedFolder.dispatch('click', createClickEvent(removedFolder));
		removedFileRow.dispatch('click', createClickEvent(removedFileRow));
		assert.deepStrictEqual(folderClicks, []);
		assert.deepStrictEqual(fileClicks, []);

		const restoredLayout = createGraphLayout(createSingleRootGraph(GRAPH_MOCK_PROJECT), {
			fileGroupPages: fixture.graphState.getState().fileGroupPages,
			openedFolders: fixture.graphState.getState().openedFolders,
		});

		fixture.renderer.applyLayout(restoredLayout);

		const restoredFolder = fixture.getNode(removedFolderId);
		const restoredFileGroup = fixture.getNode(removedFileGroupId);
		const restoredFileRow = getDescendantByClass(
			restoredFileGroup,
			'graph-file-item',
		);
		const restoredEdge = fixture.getEdge(removedEdgeId);

		assert.strictEqual(fixture.nodeLayer.children.length, restoredLayout.nodes.length);
		assert.strictEqual(fixture.edgeLayer.children.length, restoredLayout.edges.length);
		assert.notStrictEqual(restoredFolder, removedFolder);
		assert.notStrictEqual(restoredFileGroup, removedFileGroup);
		assert.notStrictEqual(restoredEdge, removedEdge);
		assert.strictEqual(fixture.getNode(retainedNodeId), retainedNode);
		assert.strictEqual(fixture.getEdge(retainedEdgeId), retainedEdge);
		assert.strictEqual(
			restoredFolder.style.transform,
			`translate(${savedPosition.x}px, ${savedPosition.y}px)`,
		);
		assert.ok(restoredEdge.getAttribute('d'));
		assert.strictEqual(restoredFolder.getEventListenerCount(), 6);
		assert.strictEqual(restoredFileRow.getEventListenerCount(), 2);

		restoredFolder.dispatch('click', createClickEvent(restoredFolder));
		restoredFileRow.dispatch('click', createClickEvent(restoredFileRow));
		assert.deepStrictEqual(folderClicks, [removedFolderId]);
		assert.deepStrictEqual(fileClicks, ['file:app/src/graphView.ts']);
		fixture.renderer.dispose();
	});

	test('재추가된 File Group은 저장된 page만큼 File Row를 복원한다', () => {
		const project = createPaginationProject([17]);
		const folderId = 'folder:pagination-0';
		const fileGroupId = createFileGroupId(folderId);
		const fixture = createRendererFixture(1, undefined, {}, project);

		fixture.graphState.showMoreFiles(fileGroupId);
		fixture.graphState.showMoreFiles(fileGroupId);
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 3);
		assert.strictEqual(
			getDescendantsByClass(
				fixture.getNode(fileGroupId),
				'graph-file-item',
			).length,
			15,
		);

		fixture.renderer.applyLayout(createGraphLayout(createSingleRootGraph(project), {
			fileGroupPages: fixture.graphState.getState().fileGroupPages,
			openedFolders: {},
		}));

		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 3);

		fixture.renderer.applyLayout(createGraphLayout(createSingleRootGraph(project), {
			fileGroupPages: fixture.graphState.getState().fileGroupPages,
			openedFolders: { [folderId]: true },
		}));

		const restoredFileGroup = fixture.getNode(fileGroupId);

		assert.strictEqual(
			getDescendantsByClass(restoredFileGroup, 'graph-file-item').length,
			15,
		);
		assert.strictEqual(
			getDescendantByClass(restoredFileGroup, 'graph-file-more').textContent,
			'+ 2개 더보기',
		);
		fixture.renderer.dispose();
	});

	test('반복 reconciliation과 dispose가 listener를 중복 생성·정리하지 않는다', () => {
		const project = createPaginationProject([2]);
		const folderId = 'folder:pagination-0';
		const fileGroupId = createFileGroupId(folderId);
		let fileGroupClicks = 0;
		let fileClicks = 0;
		const fixture = createRendererFixture(1, undefined, {
			onFileGroupClick: () => {
				fileGroupClicks += 1;
			},
			onFileClick: () => {
				fileClicks += 1;
			},
		}, project);
		const openLayout = fixture.layout;
		const collapsedLayout = createGraphLayout(createSingleRootGraph(project), {
			openedFolders: {},
		});
		let activeFileGroup = fixture.getNode(fileGroupId);
		let activeFileRow = getDescendantByClass(activeFileGroup, 'graph-file-item');

		for (let cycle = 1; cycle <= 3; cycle += 1) {
			fixture.renderer.applyLayout(collapsedLayout);
			assert.strictEqual(activeFileGroup.getEventListenerCount(), 0);
			assert.strictEqual(activeFileRow.getEventListenerCount(), 0);

			fixture.renderer.applyLayout(openLayout);
			const restoredFileGroup = fixture.getNode(fileGroupId);
			const restoredFileRow = getDescendantByClass(
				restoredFileGroup,
				'graph-file-item',
			);

			assert.notStrictEqual(restoredFileGroup, activeFileGroup);
			assert.strictEqual(restoredFileGroup.getEventListenerCount(), 6);
			assert.strictEqual(restoredFileRow.getEventListenerCount(), 2);

			fixture.renderer.applyLayout(openLayout);
			assert.strictEqual(fixture.getNode(fileGroupId), restoredFileGroup);
			assert.strictEqual(restoredFileGroup.getEventListenerCount(), 6);
			assert.strictEqual(restoredFileRow.getEventListenerCount(), 2);

			restoredFileGroup.dispatch(
				'click',
				createClickEvent(restoredFileGroup),
			);
			restoredFileRow.dispatch('click', createClickEvent(restoredFileRow));
			assert.strictEqual(fileGroupClicks, cycle);
			assert.strictEqual(fileClicks, cycle);
			activeFileGroup = restoredFileGroup;
			activeFileRow = restoredFileRow;
		}

		fixture.renderer.dispose();
		fixture.renderer.dispose();
		assert.strictEqual(activeFileGroup.getEventListenerCount(), 0);
		assert.strictEqual(activeFileRow.getEventListenerCount(), 0);
		assert.strictEqual(fixture.nodeLayer.children.length, 0);
		assert.strictEqual(fixture.edgeLayer.children.length, 0);

		activeFileGroup.dispatch('click', createClickEvent(activeFileGroup));
		activeFileRow.dispatch('click', createClickEvent(activeFileRow));
		fixture.renderer.applyLayout(openLayout);
		assert.strictEqual(fileGroupClicks, 3);
		assert.strictEqual(fileClicks, 3);
		assert.strictEqual(fixture.nodeLayer.children.length, 0);
		assert.strictEqual(fixture.edgeLayer.children.length, 0);
	});

	test('applyLayout은 동일 Node DOM의 size와 기본 위치 및 Edge geometry를 갱신한다', () => {
		const fixture = createRendererFixture();
		const nodeId = 'folder:app';
		const element = fixture.getNode(nodeId);
		const initialNode = getLayoutNode(fixture.layout, nodeId);
		const edge = fixture.getConnectedEdge(nodeId);
		const initialEdgePath = edge.getAttribute('d');
		const nextNode = {
			...initialNode,
			position: {
				x: initialNode.position.x + 30,
				y: initialNode.position.y + 150,
			},
			width: initialNode.width + 20,
			height: initialNode.height + 40,
		};
		const nextLayout = replaceLayoutNode(fixture.layout, nextNode);

		fixture.renderer.applyLayout(nextLayout);

		assert.strictEqual(fixture.getNode(nodeId), element);
		assert.strictEqual(element.style.width, `${nextNode.width}px`);
		assert.strictEqual(element.style.height, `${nextNode.height}px`);
		assert.strictEqual(
			element.style.transform,
			`translate(${nextNode.position.x}px, ${nextNode.position.y}px)`,
		);
		assert.notStrictEqual(edge.getAttribute('d'), initialEdgePath);
		assert.ok(edge.getAttributeWriteCount('d') > 1);
		fixture.renderer.dispose();
	});

	test('applyLayout은 저장된 위치를 유지하면서 File Group height와 Edge를 갱신한다', () => {
		const project = createPaginationProject([17]);
		const fileGroupId = createFileGroupId('folder:pagination-0');
		const savedPosition = { x: 720, y: 260 };
		const fixture = createRendererFixture(1, {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [fileGroupId]: savedPosition },
			fileGroupPages: {},
		}, {}, project);
		const fileGroup = fixture.getNode(fileGroupId);
		const edge = fixture.getConnectedEdge(fileGroupId);
		const initialEdgePath = edge.getAttribute('d');
		const nextLayout = createGraphLayout(createSingleRootGraph(project), {
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: fixture.graphState.getState().openedFolders,
		});

		fixture.renderer.applyLayout(nextLayout);

		assert.strictEqual(fileGroup.style.height, '348px');
		assert.strictEqual(
			fileGroup.style.transform,
			`translate(${savedPosition.x}px, ${savedPosition.y}px)`,
		);
		assert.notStrictEqual(edge.getAttribute('d'), initialEdgePath);
		fixture.renderer.dispose();
	});

	test('applyLayout은 Node 위치가 같아도 height가 바뀐 Edge endpoint를 갱신한다', () => {
		const fixture = createRendererFixture();
		const fileGroupId = createFileGroupId('folder:app/src');
		const fileGroup = fixture.getNode(fileGroupId);
		const initialNode = getLayoutNode(fixture.layout, fileGroupId);
		const edge = fixture.getConnectedEdge(fileGroupId);
		const initialTransform = fileGroup.style.transform;
		const initialEdgePath = edge.getAttribute('d');
		const nextNode = {
			...initialNode,
			height: initialNode.height + 150,
		};

		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, nextNode));

		assert.strictEqual(fileGroup.style.transform, initialTransform);
		assert.strictEqual(fileGroup.style.height, `${nextNode.height}px`);
		assert.notStrictEqual(edge.getAttribute('d'), initialEdgePath);
		assert.ok(edge.getAttribute('d')?.endsWith(
			`${nextNode.position.x} ${nextNode.position.y + nextNode.height / 2}`,
		));
		fixture.renderer.dispose();
	});

	test('Reflow 뒤 최초 Drag는 갱신된 Layout 기본 위치를 기준으로 시작한다', () => {
		const nodeId = 'folder:app';
		const fixture = createRendererFixture();
		const node = fixture.getNode(nodeId);
		const initialNode = getLayoutNode(fixture.layout, nodeId);
		const edge = fixture.getConnectedEdge(nodeId);
		const initialEdgePath = edge.getAttribute('d');
		const nextNode = {
			...initialNode,
			position: { x: initialNode.position.x, y: 250 },
		};

		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, nextNode));
		assert.strictEqual(
			node.style.transform,
			`translate(${nextNode.position.x}px, 250px)`,
		);
		assert.notStrictEqual(edge.getAttribute('d'), initialEdgePath);

		node.dispatch('pointerdown', createPointerEvent(node, 10, 10));
		node.dispatch('pointermove', createPointerEvent(node, 10, 20));
		node.dispatch('pointerup', createPointerEvent(node, 10, 20));

		assert.deepStrictEqual(fixture.graphState.getState().nodePositions[nodeId], {
			x: nextNode.position.x,
			y: 260,
		});
		assert.strictEqual(
			node.style.transform,
			`translate(${nextNode.position.x}px, 260px)`,
		);
		fixture.renderer.dispose();
	});

	test('dispose 이후 applyLayout은 기존 DOM geometry를 변경하지 않는다', () => {
		const fixture = createRendererFixture();
		const nodeId = 'folder:app';
		const node = fixture.getNode(nodeId);
		const initialNode = getLayoutNode(fixture.layout, nodeId);
		const initialWidth = node.style.width;
		const initialHeight = node.style.height;

		fixture.renderer.dispose();
		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, {
			...initialNode,
			width: initialNode.width + 100,
			height: initialNode.height + 100,
		}));

		assert.strictEqual(node.style.width, initialWidth);
		assert.strictEqual(node.style.height, initialHeight);
	});

	for (const [label, nodeId] of [
		['Project Root', GRAPH_MOCK_PROJECT.id],
		['Folder', 'folder:app'],
		['File Group', createFileGroupId('folder:app/src')],
	] as const) {
		test(`${label} Node를 Capture하여 Camera scale 기준 World 좌표로 이동한다`, () => {
			const fixture = createRendererFixture(2);
			const layoutNode = getLayoutNode(fixture.layout, nodeId);
			const node = fixture.getNode(nodeId);
			const connectedEdge = fixture.getConnectedEdge(nodeId);
			const edgePathBefore = connectedEdge.getAttribute('d');
			let stateChanges = 0;
			const unsubscribe = fixture.graphState.subscribe(() => {
				stateChanges += 1;
			});

			node.dispatch('pointerdown', createPointerEvent(node, 100, 80));
			assert.strictEqual(node.hasPointerCapture(1), true);
			assert.strictEqual(node.hasClass('is-dragging'), true);
			assert.strictEqual(
				node.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
				true,
			);
			assert.strictEqual(node.hasAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE), false);

			node.dispatch('pointermove', createPointerEvent(node, 140, 60));
			assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
			assert.strictEqual(stateChanges, 0);
			assert.strictEqual(
				node.style.transform,
				`translate(${layoutNode.position.x + 20}px, ${layoutNode.position.y - 10}px)`,
			);
			assert.notStrictEqual(connectedEdge.getAttribute('d'), edgePathBefore);

			node.dispatch('pointerup', createPointerEvent(node, 140, 60));
			assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {
				[nodeId]: {
					x: layoutNode.position.x + 20,
					y: layoutNode.position.y - 10,
				},
			});
			assert.strictEqual(stateChanges, 1);
			assert.strictEqual(node.hasPointerCapture(1), false);
			assert.strictEqual(node.hasClass('is-dragging'), false);
			unsubscribe();
			fixture.renderer.dispose();
		});
	}

	test('pointercancel과 lostpointercapture는 임시 위치를 복원하고 저장하지 않는다', () => {
		for (const eventType of ['pointercancel', 'lostpointercapture'] as const) {
			const fixture = createRendererFixture();
			const nodeId = 'folder:app';
			const layoutNode = getLayoutNode(fixture.layout, nodeId);
			const node = fixture.getNode(nodeId);
			const edge = fixture.getConnectedEdge(nodeId);
			const edgePathBefore = edge.getAttribute('d');

			node.dispatch('pointerdown', createPointerEvent(node, 10, 10));
			node.dispatch('pointermove', createPointerEvent(node, 50, 40));
			assert.notStrictEqual(edge.getAttribute('d'), edgePathBefore);

			if (eventType === 'lostpointercapture') {
				node.releasePointerCapture(1);
			}

			node.dispatch(eventType, createPointerEvent(node, 50, 40));

			assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
			assert.strictEqual(
				node.style.transform,
				`translate(${layoutNode.position.x}px, ${layoutNode.position.y}px)`,
			);
			assert.strictEqual(edge.getAttribute('d'), edgePathBefore);
			assert.strictEqual(node.hasPointerCapture(1), false);
			assert.strictEqual(node.hasClass('is-dragging'), false);
			fixture.renderer.dispose();
		}
	});

	test('Node 입력 차단 규약으로 Drag 중 Camera Pan을 시작하지 않는다', () => {
		const fixture = createRendererFixture();
		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);
		const folder = fixture.getNode('folder:app');

		viewport.dispatch('pointerdown', createPointerEvent(folder, 10, 10));
		viewport.dispatch('pointermove', createPointerEvent(folder, 60, 40));

		assert.deepStrictEqual(camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(viewport.hasPointerCapture(1), false);
		assert.strictEqual(viewport.hasClass('is-panning'), false);
		camera.dispose();
		fixture.renderer.dispose();
	});

	test('Node 이동을 기존 Webview State로 저장하고 새 Store/Renderer에서 일부 위치만 복원한다', () => {
		let savedState: PersistedWebviewState | undefined;
		const api: WebviewStateApi = {
			getState: () => savedState,
			setState: (state) => {
				savedState = state;
			},
		};
		const firstState = restoreWebviewState(api);
		const first = createRendererFixture(1, firstState.graph);
		const movedId = 'folder:app';
		const untouchedId = 'folder:src';
		const movedLayout = getLayoutNode(first.layout, movedId);
		const untouchedLayout = getLayoutNode(first.layout, untouchedId);
		const unsubscribe = first.graphState.subscribe((graph) => {
			saveWebviewState(api, {
				panel: { ...DEFAULT_PANEL_LAYOUT_STATE },
				graph,
			});
		});

		const movedNode = first.getNode(movedId);
		movedNode.dispatch('pointerdown', createPointerEvent(movedNode, 20, 30));
		movedNode.dispatch('pointermove', createPointerEvent(movedNode, 100, 70));
		assert.strictEqual(savedState, undefined);
		movedNode.dispatch('pointerup', createPointerEvent(movedNode, 100, 70));
		const savedAfterPointerUp = api.getState() as PersistedWebviewState | undefined;

		assert.deepStrictEqual(savedAfterPointerUp?.graph.nodePositions, {
			[movedId]: {
				x: movedLayout.position.x + 80,
				y: movedLayout.position.y + 40,
			},
		});
		unsubscribe();
		first.renderer.dispose();

		const restored = restoreWebviewState(api);
		const second = createRendererFixture(1, restored.graph);

		assert.notStrictEqual(second.graphState, first.graphState);
		assert.strictEqual(
			second.getNode(movedId).style.transform,
			`translate(${movedLayout.position.x + 80}px, ${movedLayout.position.y + 40}px)`,
		);
		assert.strictEqual(
			second.getNode(untouchedId).style.transform,
			`translate(${untouchedLayout.position.x}px, ${untouchedLayout.position.y}px)`,
		);
		assert.deepStrictEqual(
			Object.keys(second.graphState.getState().nodePositions),
			[movedId],
		);
		second.renderer.dispose();
	});
});

function createRendererFixture(
	scale = 1,
	initialState: GraphState = {
		camera: { x: 0, y: 0, scale },
		nodePositions: {},
	},
	interactions: GraphRendererInteractions = {},
	project: Project = GRAPH_MOCK_PROJECT,
) {
	const document = new FakeDocument();
	const edgeLayer = document.createElementNS('', 'svg');
	const nodeLayer = document.createElement('div');
	const graphState = createGraphState({
		...initialState,
		openedFolders: initialState.openedFolders ?? openAllFolders(project),
	});
	const layout = createGraphLayout(createSingleRootGraph(project), {
		fileGroupPages: graphState.getState().fileGroupPages,
		openedFolders: graphState.getState().openedFolders,
	});
	const renderer = initializeGraphRenderer(
		edgeLayer.asSvgElement(),
		nodeLayer.asHtmlElement(),
		layout,
		graphState,
		interactions,
	);
	const getNode = (nodeId: string): FakeElement => {
		const node = nodeLayer.children.find(
			(child) => child.getAttribute('data-graph-node-id') === nodeId,
		);

		assert.ok(node, `${nodeId} Node가 렌더링되어야 한다.`);
		return node;
	};
	const getEdge = (edgeId: string): FakeElement => {
		const edge = edgeLayer.children.find(
			(child) => child.getAttribute('data-graph-edge-id') === edgeId,
		);

		assert.ok(edge, `${edgeId} Edge가 렌더링되어야 한다.`);
		return edge;
	};
	const getConnectedEdge = (nodeId: string): FakeElement => {
		const edge = layout.edges.find(
			(candidate) => candidate.sourceId === nodeId || candidate.targetId === nodeId,
		);

		assert.ok(edge, `${nodeId}에 연결된 Edge가 있어야 한다.`);
		return getEdge(edge.id);
	};

	return {
		document,
		edgeLayer,
		nodeLayer,
		layout,
		graphState,
		renderer,
		getNode,
		getEdge,
		getConnectedEdge,
	};
}

function createPaginationProject(fileCounts: readonly number[]): Project {
	return {
		kind: 'project',
		id: 'project:pagination',
		name: 'pagination',
		children: fileCounts.map((fileCount, groupIndex) => ({
			kind: 'folder' as const,
			id: `folder:pagination-${groupIndex}`,
			name: `pagination-${groupIndex}`,
			children: Array.from({ length: fileCount }, (_, fileIndex) => ({
				kind: 'file' as const,
				id: `file:pagination-${groupIndex}/file-${fileIndex + 1}.ts`,
				name: `file-${fileIndex + 1}.ts`,
			})),
		})),
	};
}

function getLayoutNode(layout: GraphLayout, nodeId: string): GraphLayoutNode {
	const node = layout.nodes.find((candidate) => candidate.id === nodeId);

	assert.ok(node);
	return node;
}

/** Renderer 단위 테스트의 기존 전체 Tree fixture를 명시적으로 연다. */
function openAllFolders(project: Project): Record<string, true> {
	const openedFolders: Record<string, true> = {};
	const visit = (entries: Project['children']): void => {
		for (const entry of entries) {
			if (!isFolder(entry)) {
				continue;
			}

			openedFolders[entry.id] = true;
			visit(entry.children);
		}
	};

	visit(project.children);
	return openedFolders;
}

function replaceLayoutNode(
	layout: GraphLayout,
	nextNode: GraphLayoutNode,
): GraphLayout {
	return {
		nodes: layout.nodes.map((node) => node.id === nextNode.id ? nextNode : node),
		edges: layout.edges,
	};
}

function createPointerEvent(
	target: FakeElement,
	clientX: number,
	clientY: number,
	pointerId = 1,
): PointerEvent {
	return {
		isPrimary: true,
		button: 0,
		pointerId,
		clientX,
		clientY,
		target: target.asEventTarget(),
		preventDefault: () => undefined,
	} as PointerEvent;
}

function createWheelEvent(
	target: FakeElement,
	clientX: number,
	clientY: number,
	deltaY: number,
): WheelEvent & { defaultPrevented: boolean } {
	let defaultPrevented = false;

	return {
		target: target.asEventTarget(),
		clientX,
		clientY,
		deltaY,
		deltaMode: 0,
		preventDefault: () => {
			defaultPrevented = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
	} as WheelEvent & { defaultPrevented: boolean };
}

function assertPointAlmostEqual(
	actual: { x: number; y: number },
	expected: { x: number; y: number },
): void {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
}

function createClickEvent(
	target: FakeElement,
): MouseEvent & { readonly propagationStopped: boolean } {
	let propagationStopped = false;
	let defaultPrevented = false;

	return {
		target: target.asEventTarget(),
		preventDefault: () => {
			defaultPrevented = true;
		},
		stopPropagation: () => {
			propagationStopped = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as unknown as MouseEvent & { readonly propagationStopped: boolean };
}

function createAnimationEvent(target: FakeElement): AnimationEvent {
	return {
		target: target.asEventTarget(),
	} as AnimationEvent;
}

function getDescendantByClass(
	element: FakeElement,
	className: string,
): FakeElement {
	for (const child of element.children) {
		if (child.hasClass(className)) {
			return child;
		}

		const descendant = findDescendantByClass(child, className);

		if (descendant) {
			return descendant;
		}
	}

	assert.fail(`${className} 요소가 있어야 한다.`);
}

function getDescendantByAttribute(
	element: FakeElement,
	attributeName: string,
	attributeValue: string,
): FakeElement {
	for (const child of element.children) {
		if (child.getAttribute(attributeName) === attributeValue) {
			return child;
		}

		const descendant = findDescendantByAttribute(
			child,
			attributeName,
			attributeValue,
		);

		if (descendant) {
			return descendant;
		}
	}

	assert.fail(`${attributeName}="${attributeValue}" 요소가 있어야 한다.`);
}

function findDescendantByAttribute(
	element: FakeElement,
	attributeName: string,
	attributeValue: string,
): FakeElement | undefined {
	for (const child of element.children) {
		if (child.getAttribute(attributeName) === attributeValue) {
			return child;
		}

		const descendant = findDescendantByAttribute(
			child,
			attributeName,
			attributeValue,
		);

		if (descendant) {
			return descendant;
		}
	}

	return undefined;
}

function findDescendantByClass(
	element: FakeElement,
	className: string,
): FakeElement | undefined {
	for (const child of element.children) {
		if (child.hasClass(className)) {
			return child;
		}

		const descendant = findDescendantByClass(child, className);

		if (descendant) {
			return descendant;
		}
	}

	return undefined;
}

function getDescendantsByClass(
	element: FakeElement,
	className: string,
): FakeElement[] {
	return element.children.flatMap((child) => [
		...(child.hasClass(className) ? [child] : []),
		...getDescendantsByClass(child, className),
	]);
}

function getText(element: FakeElement): string {
	return [element.textContent, ...element.children.map(getText)].join(' ');
}

type GraphEventListener = (event: never) => void;

class FakeDocument {
	createElement(tagName = 'div'): FakeElement {
		return new FakeElement(this, tagName);
	}

	createElementNS(_namespace: string, tagName: string): FakeElement {
		return new FakeElement(this, tagName);
	}

	createSizedElement(width: number, height: number): FakeElement {
		return new FakeElement(this, 'div', width, height);
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly style: Record<string, string> = {
		transform: '',
		backgroundPosition: '',
		backgroundSize: '',
	};
	readonly classList = {
		add: (...tokens: string[]) => {
			for (const token of tokens) {
				this.classNames.add(token);
			}
		},
		remove: (...tokens: string[]) => {
			for (const token of tokens) {
				this.classNames.delete(token);
			}
		},
	};
	className = '';
	textContent = '';
	type = '';
	private readonly attributes = new Map<string, string>();
	private readonly attributeWriteCounts = new Map<string, number>();
	private readonly classNames = new Set<string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(
		readonly ownerDocument: FakeDocument,
		readonly tagName: string,
		readonly clientWidth = 0,
		readonly clientHeight = 0,
	) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	asSvgElement(): SVGSVGElement {
		return this as unknown as SVGSVGElement;
	}

	asEventTarget(): EventTarget {
		return this as unknown as EventTarget;
	}

	append(...children: FakeElement[]): void {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}

	remove(): void {
		if (!this.parent) {
			return;
		}

		const index = this.parent.children.indexOf(this);

		if (index >= 0) {
			this.parent.children.splice(index, 1);
		}
	}

	setAttribute(name: string, value = ''): void {
		this.attributes.set(name, value);
		this.attributeWriteCounts.set(
			name,
			(this.attributeWriteCounts.get(name) ?? 0) + 1,
		);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	getAttributeWriteCount(name: string): number {
		return this.attributeWriteCounts.get(name) ?? 0;
	}

	closest(selector: string): FakeElement | null {
		const attribute = selector.slice(1, -1);

		if (this.hasAttribute(attribute)) {
			return this;
		}

		return this.parent?.closest(selector) ?? null;
	}

	hasClass(className: string): boolean {
		return this.classNames.has(className)
			|| this.className.split(/\s+/).includes(className);
	}

	addEventListener(type: string, listener: GraphEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: GraphEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	getEventListenerCount(): number {
		return [...this.listeners.values()].reduce(
			(count, listeners) => count + listeners.size,
			0,
		);
	}

	dispatch(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event as never);
		}

		if (!(event as Event & { propagationStopped?: boolean }).propagationStopped) {
			this.parent?.dispatch(type, event);
		}
	}

	setPointerCapture(pointerId: number): void {
		this.capturedPointers.add(pointerId);
	}

	hasPointerCapture(pointerId: number): boolean {
		return this.capturedPointers.has(pointerId);
	}

	releasePointerCapture(pointerId: number): void {
		this.capturedPointers.delete(pointerId);
	}

	getBoundingClientRect(): DOMRect {
		return {
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: this.clientWidth,
			bottom: this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
			toJSON: () => ({}),
		};
	}
}
