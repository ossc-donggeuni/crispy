import * as assert from 'assert';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
	type GraphAnimationFrameScheduler,
} from '../../webview/graph/graphCamera';
import {
	createFileGroupId,
	createGraphLayout,
	createGraphLayoutNodeId,
	getGraphRootLayoutNodeId,
	getFileGroupHeight,
	GRAPH_FOLDER_NODE_WIDTH,
	type GraphLayout,
	type GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import { GRAPH_MOCK_PROJECT } from '../../webview/graph/graphMockData';
import {
	createSingleRootGraph,
	isFolder,
	type GraphRootContext,
	type GraphRootNode,
	type Project,
} from '../../webview/graph/graphModel';
import {
	addGraphRoot,
	createDetachedRootId,
	createFileBacklinkGroupId,
	createFolderBacklinkId,
	removeGraphRoot,
} from '../../webview/graph/graphRootPromotion';
import { GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE } from '../../webview/graph/graphNodeDrag';
import {
	initializeGraphRenderer,
	type GraphNodeArrangementRequest,
	type GraphRendererInteractions,
	type GraphRendererOptions,
} from '../../webview/graph/graphRenderer';
import {
	createGraphState,
	type GraphState,
} from '../../webview/graph/graphState';

suite('Graph Renderer / Node Drag', () => {
	test('unreadable Project와 Folder에만 상태 Class를 적용한다', () => {
		const loadedFolder = {
			kind: 'folder' as const,
			id: 'folder:loaded',
			name: 'loaded',
			status: 'loaded' as const,
			children: [],
		};
		const unreadableFolder = {
			kind: 'folder' as const,
			id: 'folder:unreadable',
			name: 'unreadable',
			status: 'unreadable' as const,
			children: [],
		};
		const file = {
			kind: 'file' as const,
			id: 'file:index.ts',
			name: 'index.ts',
		};
		const loadedProject: Project = {
			kind: 'project',
			id: 'project:loaded',
			name: 'loaded',
			status: 'loaded',
			children: [loadedFolder, unreadableFolder, file],
		};
		const loadedFixture = createRendererFixture(
			1,
			undefined,
			{},
			loadedProject,
		);

		assert.strictEqual(
			loadedFixture.getNode(loadedProject.id).hasClass('is-unreadable'),
			false,
		);
		assert.strictEqual(
			loadedFixture.getNode(loadedFolder.id).hasClass('is-unreadable'),
			false,
		);
		assert.strictEqual(
			loadedFixture.getNode(unreadableFolder.id).hasClass('is-unreadable'),
			true,
		);
		assert.strictEqual(
			loadedFixture.getNode(file.id).hasClass('is-unreadable'),
			false,
		);
		loadedFixture.renderer.dispose();

		const unreadableProject: Project = {
			kind: 'project',
			id: 'project:unreadable',
			name: 'unreadable',
			status: 'unreadable',
			children: [],
		};
		const unreadableFixture = createRendererFixture(
			1,
			undefined,
			{},
			unreadableProject,
		);

		assert.strictEqual(
			unreadableFixture.getNode(unreadableProject.id).hasClass('is-unreadable'),
			true,
		);
		unreadableFixture.renderer.dispose();
	});

	test('applyLayout은 유지된 Project/Folder DOM의 상태 Class를 동기화한다', () => {
		const projectId = 'project:status';
		const folderId = 'folder:status/child';
		const createStatusProject = (
			projectStatus: Project['status'],
			folderStatus: Project['status'],
		): Project => ({
			kind: 'project',
			id: projectId,
			name: 'status',
			status: projectStatus,
			children: [{
				kind: 'folder',
				id: folderId,
				name: 'child',
				status: folderStatus,
				children: [{
					kind: 'file',
					id: 'file:status/child/index.ts',
					name: 'index.ts',
				}],
			}],
		});
		const fixture = createRendererFixture(
			1,
			undefined,
			{},
			createStatusProject('loaded', 'loaded'),
		);
		const applyStatus = (
			projectStatus: Project['status'],
			folderStatus: Project['status'],
		): void => {
			fixture.renderer.applyLayout(createGraphLayout(
				createSingleRootGraph(createStatusProject(projectStatus, folderStatus)),
				{
					fileGroupPages: fixture.graphState.getState().fileGroupPages,
					openedFolders: fixture.graphState.getState().openedFolders,
				},
			));
		};
		const projectNode = fixture.getNode(projectId);
		const folderNode = fixture.getNode(folderId);
		const folderEdge = fixture.getConnectedEdge(folderId);
		const folderTransform = folderNode.style.transform;
		const folderEdgePath = folderEdge.getAttribute('d');
		const nodeCount = fixture.nodeLayer.children.length;
		const edgeCount = fixture.edgeLayer.children.length;

		assert.strictEqual(projectNode.hasClass('is-unreadable'), false);
		assert.strictEqual(folderNode.hasClass('is-unreadable'), false);

		applyStatus('unreadable', 'unreadable');

		assert.strictEqual(fixture.getNode(projectId), projectNode);
		assert.strictEqual(fixture.getNode(folderId), folderNode);
		assert.strictEqual(projectNode.hasClass('is-unreadable'), true);
		assert.strictEqual(folderNode.hasClass('is-unreadable'), true);
		assert.strictEqual(fixture.getConnectedEdge(folderId), folderEdge);
		assert.strictEqual(folderEdge.getAttribute('d'), folderEdgePath);
		assert.strictEqual(folderNode.style.transform, folderTransform);
		assert.strictEqual(folderNode.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(fixture.nodeLayer.children.length, nodeCount);
		assert.strictEqual(fixture.edgeLayer.children.length, edgeCount);

		applyStatus('loaded', 'loaded');

		assert.strictEqual(fixture.getNode(projectId), projectNode);
		assert.strictEqual(fixture.getNode(folderId), folderNode);
		assert.strictEqual(projectNode.hasClass('is-unreadable'), false);
		assert.strictEqual(folderNode.hasClass('is-unreadable'), false);
		fixture.renderer.dispose();
	});

	test('Context가 있는 Folder/File Root에만 좌측 정렬 Label을 렌더링한다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:context-root',
			name: 'context-root',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:context-root/child.ts',
				name: 'child.ts',
			}],
		};
		const folderContext = { relativePath: 'packages/demo/src/context-root' };
		const folderFixture = createRendererFixture(
			1,
			undefined,
			{},
			folder,
			folderContext,
		);
		const folderRoot = folderFixture.getNode(folder.id);
		const folderLabel = getDescendantByClass(
			folderRoot,
			'graph-root-context-label',
		);
		const child = folderFixture.getNode(folder.children[0].id);

		assert.strictEqual(folderLabel.textContent, folderContext.relativePath);
		assert.strictEqual(folderLabel.style.left, '0px');
		assert.strictEqual(
			folderLabel.style.maxWidth,
			`${GRAPH_FOLDER_NODE_WIDTH * 1.5}px`,
		);
		assert.strictEqual(
			findDescendantByClass(child, 'graph-root-context-label'),
			undefined,
		);
		folderFixture.renderer.dispose();

		const file = {
			kind: 'file' as const,
			id: 'file:context-root.ts',
			name: 'context-root.ts',
		};
		const fileContext = { relativePath: 'src/webview/graph/context-root.ts' };
		const fileClicks: string[] = [];
		const fileFixture = createRendererFixture(
			1,
			undefined,
			{ onFileClick: (fileId) => fileClicks.push(fileId) },
			file,
			fileContext,
		);
		const fileLabel = getDescendantByClass(
			fileFixture.getNode(file.id),
			'graph-root-context-label',
		);

		assert.strictEqual(fileLabel.textContent, fileContext.relativePath);
		fileLabel.dispatch('click', createClickEvent(fileLabel));
		assert.deepStrictEqual(fileClicks, []);
		fileFixture.renderer.dispose();

		const noContext = createRendererFixture(1, undefined, {}, folder);

		assert.strictEqual(
			findDescendantByClass(
				noContext.getNode(folder.id),
				'graph-root-context-label',
			),
			undefined,
		);
		noContext.renderer.dispose();
	});

	test('Root Label은 Node 이동을 함께 따르며 Graph interaction을 시작하지 않는다', () => {
		const folderClicks: string[] = [];
		const detachDrops: string[] = [];
		const rootContextClicks: string[] = [];
		const fixture = createRendererFixture(
			1,
			undefined,
			{
				onFolderClick: (folderId) => folderClicks.push(folderId),
				onDetachDrop: (request) => detachDrops.push(request.nodeId),
				onRootContextClick: (rootId) => rootContextClicks.push(rootId),
				resolveRootId: () => 'root:context-project',
			},
			GRAPH_MOCK_PROJECT,
			{ relativePath: 'src/webview/graph' },
		);
		const root = fixture.getNode(GRAPH_MOCK_PROJECT.id);
		const label = getDescendantByClass(root, 'graph-root-context-label');
		const pointerDown = createPointerEvent(label, 10, 10);

		label.dispatch('pointerdown', pointerDown);
		label.dispatch('pointermove', createPointerEvent(label, 50, 40));
		label.dispatch('pointerup', createPointerEvent(label, 50, 40));
		label.dispatch('click', createClickEvent(label));
		assert.strictEqual(pointerDown.defaultPrevented, true);
		assert.strictEqual(pointerDown.propagationStopped, true);
		assert.deepStrictEqual(folderClicks, []);
		assert.deepStrictEqual(detachDrops, []);
		assert.deepStrictEqual(rootContextClicks, ['root:context-project']);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
		assert.strictEqual(root.hasClass('is-dragging'), false);

		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);

		viewport.dispatch('pointerdown', createPointerEvent(label, 10, 10, 2));
		viewport.dispatch('pointermove', createPointerEvent(label, 60, 50, 2));
		assert.deepStrictEqual(camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(viewport.hasClass('is-panning'), false);

		const movedPosition = { x: 420, y: 260 };
		const state = fixture.graphState.getState();

		fixture.graphState.setState({
			...state,
			nodePositions: {
				...state.nodePositions,
				[GRAPH_MOCK_PROJECT.id]: movedPosition,
			},
		});
		assert.strictEqual(root.style.transform, 'translate(420px, 260px)');
		assert.strictEqual(
			getDescendantByClass(root, 'graph-root-context-label'),
			label,
		);

		camera.dispose();
		fixture.renderer.dispose();
	});

	test('applyLayout은 기존 Root DOM에서 Context Label을 추가, 갱신, 제거한다', () => {
		const fixture = createRendererFixture();
		const root = fixture.getNode(GRAPH_MOCK_PROJECT.id);
		const firstContext = { relativePath: 'src/first' };
		const secondContext = { relativePath: 'src/second' };

		fixture.renderer.applyLayout({
			...fixture.layout,
			rootContexts: { [GRAPH_MOCK_PROJECT.id]: firstContext },
		});
		const label = getDescendantByClass(root, 'graph-root-context-label');

		assert.strictEqual(label.textContent, firstContext.relativePath);
		fixture.renderer.applyLayout({
			...fixture.layout,
			rootContexts: { [GRAPH_MOCK_PROJECT.id]: secondContext },
		});
		assert.strictEqual(
			getDescendantByClass(root, 'graph-root-context-label'),
			label,
		);
		assert.strictEqual(label.textContent, secondContext.relativePath);

		fixture.renderer.applyLayout({ ...fixture.layout, rootContexts: {} });
		assert.strictEqual(
			findDescendantByClass(root, 'graph-root-context-label'),
			undefined,
		);
		assert.strictEqual(label.getEventListenerCount(), 0);
		fixture.renderer.dispose();
	});

	test('File Root를 저장 위치와 File interaction을 쓰는 standalone File Group으로 렌더링한다', () => {
		const file = {
			kind: 'file' as const,
			id: 'file:standalone/graphRenderer.ts',
			name: 'graphRenderer.ts',
		};
		const savedPosition = { x: 640, y: 280 };
		const fileClicks: string[] = [];
		const fileOpenRequests: string[] = [];
		const fixture = createRendererFixture(1, {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [file.id]: savedPosition },
		}, {
			onFileClick: (fileId) => fileClicks.push(fileId),
			onFileOpenRequest: (fileId) => fileOpenRequests.push(fileId),
		}, file);
		const layoutNode = getLayoutNode(fixture.layout, file.id);
		const node = fixture.getNode(file.id);
		const icon = getDescendantByClass(node, 'graph-file-icon');

		assert.strictEqual(fixture.layout.nodes.length, 1);
		assert.strictEqual(fixture.layout.edges.length, 0);
		assert.strictEqual(layoutNode.kind, 'file-group');
		assert.ok(layoutNode.kind === 'file-group');
		assert.strictEqual(layoutNode.presentation, 'standalone');
		assert.strictEqual(layoutNode.children[0]?.id, file.id);
		assert.strictEqual(node.hasClass('graph-file-group-node'), true);
		assert.strictEqual(node.hasClass('graph-file-node'), false);
		assert.strictEqual(
			node.getAttribute('data-file-group-presentation'),
			'standalone',
		);
		assert.strictEqual(node.style.transform, 'translate(640px, 280px)');
		assert.strictEqual(node.getAttribute('data-file-id'), file.id);
		assert.strictEqual(node.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE), false);
		assert.strictEqual(icon.getAttribute('data-file-icon'), 'typescript');
		assert.ok(getText(node).includes(file.name));
		assert.strictEqual(findDescendantByClass(node, 'graph-file-item'), undefined);

		node.dispatch('click', createClickEvent(node));
		assert.deepStrictEqual(fileClicks, [file.id]);
		assert.deepStrictEqual(fixture.graphState.getState().openedFolders, {});
		let bubbledDoubleClicks = 0;
		fixture.nodeLayer.addEventListener('dblclick', () => {
			bubbledDoubleClicks += 1;
		});
		const doubleClick = createClickEvent(node);

		node.dispatch('dblclick', doubleClick);

		assert.deepStrictEqual(fileOpenRequests, [file.id]);
		assert.strictEqual(bubbledDoubleClicks, 0);
		assert.strictEqual(doubleClick.defaultPrevented, true);
		assert.strictEqual(doubleClick.propagationStopped, true);
		fixture.renderer.dispose();
		node.dispatch('dblclick', createClickEvent(node));
		assert.deepStrictEqual(fileOpenRequests, [file.id]);
	});

	test('Folder의 Singleton은 standalone Group, 두 File은 grouped Row로 렌더링한다', () => {
		const singletonProject = createPaginationProject([1]);
		const singletonFileId = 'file:pagination-0/file-1.ts';
		const singleton = createRendererFixture(
			1,
			undefined,
			{},
			singletonProject,
		);
		const fileNode = singleton.getNode(singletonFileId);

		assert.strictEqual(fileNode.hasClass('graph-file-group-node'), true);
		assert.strictEqual(
			fileNode.getAttribute('data-file-group-presentation'),
			'standalone',
		);
		assert.strictEqual(findDescendantByClass(fileNode, 'graph-file-item'), undefined);
		assert.strictEqual(
			singleton.nodeLayer.children.some(
				(node) => node.getAttribute('data-graph-node-id')
					=== createFileGroupId('folder:pagination-0'),
			),
			false,
		);
		assert.ok(singleton.layout.edges.some((edge) => (
			edge.sourceId === 'folder:pagination-0'
				&& edge.targetId === singletonFileId
		)));
		singleton.renderer.dispose();

		const grouped = createRendererFixture(1, undefined, {}, createPaginationProject([2]));
		const fileGroup = grouped.getNode(createFileGroupId('folder:pagination-0'));

		assert.strictEqual(fileGroup.hasClass('graph-file-group-node'), true);
		assert.strictEqual(
			fileGroup.getAttribute('data-file-group-presentation'),
			'grouped',
		);
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 2);
		assert.strictEqual(
			grouped.nodeLayer.children.some(
				(node) => node.getAttribute('data-graph-node-id') === singletonFileId,
			),
			false,
		);
		grouped.renderer.dispose();
	});

	test('Root가 아닌 Folder와 standalone/grouped File에만 Detach Handle을 렌더링한다', () => {
		const standaloneFile = {
			kind: 'file' as const,
			id: 'file:detach-standalone/index.ts',
			name: 'index.ts',
		};
		const standaloneProject: Project = {
			kind: 'project',
			id: 'project:detach-standalone',
			name: 'detach-standalone',
			status: 'loaded',
			children: [standaloneFile],
		};
		const standalone = createRendererFixture(
			1,
			undefined,
			{},
			standaloneProject,
		);
		const project = standalone.getNode(standaloneProject.id);
		const fileNode = standalone.getNode(standaloneFile.id);

		assert.strictEqual(
			findDescendantByClass(project, 'graph-detach-handle'),
			undefined,
		);
		assert.ok(findDescendantByClass(fileNode, 'graph-detach-handle'));
		standalone.renderer.dispose();

		const groupedProject = createPaginationProject([2]);
		const allGrouped = createRendererFixture(
			1,
			undefined,
			{},
			groupedProject,
		);
		const allGroupedFileGroup = allGrouped.getNode(
			createFileGroupId('folder:pagination-0'),
		);

		assert.strictEqual(
			getDescendantsByClass(allGroupedFileGroup, 'graph-detach-handle').length,
			2,
		);
		allGrouped.renderer.dispose();

		const rootFolder = {
			kind: 'folder' as const,
			id: 'folder:detach-root',
			name: 'detach-root',
			status: 'loaded' as const,
			children: [],
		};
		const folderRoot = createRendererFixture(1, undefined, {}, rootFolder);

		assert.strictEqual(
			findDescendantByClass(
				folderRoot.getNode(rootFolder.id),
				'graph-detach-handle',
			),
			undefined,
		);
		folderRoot.renderer.dispose();

		const fileRoot = createRendererFixture(1, undefined, {}, standaloneFile);

		assert.strictEqual(
			findDescendantByClass(
				fileRoot.getNode(standaloneFile.id),
				'graph-detach-handle',
			),
			undefined,
		);
		fileRoot.renderer.dispose();
	});

	test('Folder Detach Handle은 Node Click/Move와 Camera Pan 없이 threshold Drag만 전달한다', () => {
		const detachDrops: Array<{
			readonly nodeId: string;
			readonly clientX: number;
			readonly clientY: number;
		}> = [];
		const folderClicks: string[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onFolderClick: (folderId) => folderClicks.push(folderId),
			onDetachDrop: (request) => detachDrops.push(request),
		});
		const folder = fixture.getNode('folder:app');
		const handle = getDescendantByClass(folder, 'graph-detach-handle');
		const initialTransform = folder.style.transform;
		const pointerDown = createPointerEvent(handle, 10, 20);

		assert.strictEqual(
			handle.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
			true,
		);
		handle.dispatch('pointerdown', pointerDown);
		assert.strictEqual(pointerDown.defaultPrevented, true);
		assert.strictEqual(pointerDown.propagationStopped, true);
		assert.strictEqual(handle.hasPointerCapture(1), true);
		assert.strictEqual(handle.hasClass('is-detach-active'), true);
		assert.strictEqual(folder.hasPointerCapture(1), false);
		assert.strictEqual(folder.hasClass('is-dragging'), false);

		handle.dispatch('pointermove', createPointerEvent(handle, 12, 22));
		handle.dispatch('pointerup', createPointerEvent(handle, 12, 22));
		handle.dispatch('click', createClickEvent(handle));
		assert.deepStrictEqual(detachDrops, []);
		assert.deepStrictEqual(folderClicks, []);

		handle.dispatch('pointerdown', createPointerEvent(handle, 30, 40, 2));
		handle.dispatch('pointermove', createPointerEvent(handle, 50, 65, 2));
		assert.strictEqual(handle.hasClass('is-detach-dragging'), true);
		handle.dispatch('pointerup', createPointerEvent(handle, 72, 84, 2));

		assert.deepStrictEqual(detachDrops, [{
			nodeId: 'folder:app',
			clientX: 72,
			clientY: 84,
		}]);
		assert.strictEqual(handle.hasPointerCapture(2), false);
		assert.strictEqual(handle.hasClass('is-detach-active'), false);
		assert.strictEqual(handle.hasClass('is-detach-dragging'), false);
		assert.strictEqual(folder.style.transform, initialTransform);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});

		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);

		viewport.dispatch('pointerdown', createPointerEvent(handle, 72, 84, 3));
		viewport.dispatch('pointermove', createPointerEvent(handle, 120, 140, 3));
		assert.deepStrictEqual(camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(viewport.hasPointerCapture(3), false);
		assert.strictEqual(viewport.hasClass('is-panning'), false);

		camera.dispose();
		fixture.renderer.dispose();
	});

	test('grouped File Handle은 Row Click 없이 해당 File ID의 Detach Drop만 전달한다', () => {
		const detachDrops: Array<{
			readonly nodeId: string;
			readonly clientX: number;
			readonly clientY: number;
		}> = [];
		const fileClicks: string[] = [];
		const fixture = createRendererFixture(
			1,
			undefined,
			{
				onFileClick: (fileId) => fileClicks.push(fileId),
				onDetachDrop: (request) => detachDrops.push(request),
			},
			createPaginationProject([2]),
		);
		const fileGroup = fixture.getNode(createFileGroupId('folder:pagination-0'));
		const fileIds = [
			'file:pagination-0/file-1.ts',
			'file:pagination-0/file-2.ts',
		];

		for (const [index, fileId] of fileIds.entries()) {
			const fileRow = getDescendantByAttribute(
				fileGroup,
				'data-file-id',
				fileId,
			);
			const handle = getDescendantByClass(fileRow, 'graph-detach-handle');
			const pointerId = index + 1;

			handle.dispatch(
				'pointerdown',
				createPointerEvent(handle, 100, 120, pointerId),
			);
			handle.dispatch(
				'pointermove',
				createPointerEvent(handle, 116, 138, pointerId),
			);
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, 130 + index, 150 + index, pointerId),
			);
			handle.dispatch('click', createClickEvent(handle));

			assert.strictEqual(fileRow.hasClass('is-file-clicking'), false);
		}

		assert.deepStrictEqual(detachDrops, fileIds.map((nodeId, index) => ({
			nodeId,
			clientX: 130 + index,
			clientY: 150 + index,
		})));
		assert.deepStrictEqual(fileClicks, []);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
		fixture.renderer.dispose();
	});

	test('승격된 File Row는 순서/페이지를 유지한 반투명 Backlink이고 새 Root는 standalone이다', () => {
		const project = createPaginationProject([7]);
		const fileGroupId = createFileGroupId('folder:pagination-0');
		const targetFileId = 'file:pagination-0/file-4.ts';
		const addition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			targetFileId,
		);

		assert.ok(addition);
		const document = new FakeDocument();
		const edgeLayer = document.createElementNS('', 'svg');
		const nodeLayer = document.createElement('div');
		const graphState = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[project.id]: true,
				'folder:pagination-0': true,
			},
		});
		const layout = createGraphLayout(addition.graph, {
			fileGroupPages: graphState.getState().fileGroupPages,
			openedFolders: graphState.getState().openedFolders,
		});
		const fileClicks: string[] = [];
		const fileOpenRequests: string[] = [];
		const backlinkClicks: string[] = [];
		const rootContextClicks: string[] = [];
		const renderer = initializeGraphRenderer(
			edgeLayer.asSvgElement(),
			nodeLayer.asHtmlElement(),
			layout,
			graphState,
			{
				onFileClick: (fileId) => fileClicks.push(fileId),
				onFileOpenRequest: (fileId) => fileOpenRequests.push(fileId),
				onBacklinkClick: (rootId) => backlinkClicks.push(rootId),
				onRootContextClick: (rootId) => rootContextClicks.push(rootId),
				resolveRootId: (rootNodeId) => addition.graph.roots.find(
					(root) => getGraphRootLayoutNodeId(root) === rootNodeId,
				)?.id,
			},
		);
		const fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);
		const rows = getDescendantsByClass(fileGroup, 'graph-file-item');
		const backlinkRow = getDescendantByAttribute(
			fileGroup,
			'data-file-id',
			targetFileId,
		);
		const actualRoot = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			getGraphRootLayoutNodeId(addition.root),
		);

		assert.deepStrictEqual(
			rows.map((row) => row.getAttribute('data-file-id')),
			Array.from({ length: 7 }, (_, index) => (
				`file:pagination-0/file-${index + 1}.ts`
			)),
		);
		assert.strictEqual(rows.length, 7);
		assert.strictEqual(graphState.getFileGroupPage(fileGroupId), 2);
		assert.strictEqual(backlinkRow.hasClass('is-backlink'), true);
		assert.strictEqual(backlinkRow.getAttribute('data-graph-backlink'), 'file');
		assert.strictEqual(
			backlinkRow.getAttribute('data-target-root-id'),
			addition.root.id,
		);
		assert.ok(findDescendantByClass(backlinkRow, 'graph-detach-handle'));
		assert.strictEqual(
			getDescendantsByClass(backlinkRow, 'graph-detach-handle').length,
			1,
		);
		assert.strictEqual(
			findDescendantByClass(backlinkRow, 'graph-backlink-indicator'),
			undefined,
		);
		backlinkRow.boundsLeft = 120;
		backlinkRow.boundsTop = 80;
		backlinkRow.clientWidth = 160;
		backlinkRow.clientHeight = 30;
		assert.deepStrictEqual(
			renderer.getBacklinkClientCenter(addition.root.id),
			{ clientX: 200, clientY: 95 },
		);
		backlinkRow.dispatch('pointerdown', createPointerEvent(backlinkRow, 10, 10));
		backlinkRow.dispatch('pointermove', createPointerEvent(backlinkRow, 50, 60));
		backlinkRow.dispatch('pointerup', createPointerEvent(backlinkRow, 50, 60));
		backlinkRow.dispatch('click', createClickEvent(backlinkRow));
		const backlinkDoubleClick = createClickEvent(backlinkRow);
		backlinkRow.dispatch('dblclick', backlinkDoubleClick);
		assert.strictEqual(fileGroup.hasPointerCapture(1), false);
		assert.deepStrictEqual(graphState.getState().nodePositions, {});
		assert.deepStrictEqual(fileClicks, []);
		assert.deepStrictEqual(fileOpenRequests, []);
		assert.strictEqual(backlinkDoubleClick.defaultPrevented, true);
		assert.strictEqual(backlinkDoubleClick.propagationStopped, true);
		assert.deepStrictEqual(backlinkClicks, [addition.root.id]);
		assert.strictEqual(
			backlinkRow.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
			true,
		);
		assert.strictEqual(
			actualRoot.getAttribute('data-file-group-presentation'),
			'standalone',
		);
		assert.strictEqual(
			findDescendantByClass(actualRoot, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(
			getDescendantByClass(
				actualRoot,
				'graph-root-context-label',
			).textContent,
			'pagination/pagination-0/',
		);
		getDescendantByClass(actualRoot, 'graph-root-context-label').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				actualRoot,
				'graph-root-context-label',
			)),
		);
		assert.deepStrictEqual(rootContextClicks, [addition.root.id]);

		renderer.applyLayout(createGraphLayout(
			createSingleRootGraph(project, 'root:project'),
			{
				fileGroupPages: graphState.getState().fileGroupPages,
				openedFolders: graphState.getState().openedFolders,
			},
		));
		assert.strictEqual(
			renderer.getBacklinkClientCenter(addition.root.id),
			undefined,
		);

		renderer.dispose();
	});

	test('Folder와 singleton File Backlink은 일반 Click을 막고 각 targetRootId를 전달한다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:backlink-target',
			name: 'backlink-target',
			status: 'loaded' as const,
			children: [],
		};
		const file = {
			kind: 'file' as const,
			id: 'file:singleton-target.ts',
			name: 'singleton-target.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:backlink-click',
			name: 'backlink-click',
			status: 'loaded',
			children: [folder, file],
		};
		const folderAddition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folder.id,
		);

		assert.ok(folderAddition);
		const fileAddition = addGraphRoot(folderAddition.graph, file.id);

		assert.ok(fileAddition);
		const document = new FakeDocument();
		const edgeLayer = document.createElementNS('', 'svg');
		const nodeLayer = document.createElement('div');
		const graphState = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true },
		});
		const layout = createGraphLayout(fileAddition.graph, {
			openedFolders: graphState.getState().openedFolders,
		});
		const folderClicks: string[] = [];
		const fileClicks: string[] = [];
		const backlinkClicks: string[] = [];
		const rootContextClicks: string[] = [];
		const renderer = initializeGraphRenderer(
			edgeLayer.asSvgElement(),
			nodeLayer.asHtmlElement(),
			layout,
			graphState,
			{
				onFolderClick: (folderId) => folderClicks.push(folderId),
				onFileClick: (fileId) => fileClicks.push(fileId),
				onBacklinkClick: (rootId) => backlinkClicks.push(rootId),
				onRootContextClick: (rootId) => rootContextClicks.push(rootId),
				resolveRootId: (rootNodeId) => fileAddition.graph.roots.find(
					(root) => getGraphRootLayoutNodeId(root) === rootNodeId,
				)?.id,
			},
		);
		const folderBacklink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			createFolderBacklinkId(folder.id),
		);
		const fileBacklink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			createFileBacklinkGroupId(file.id),
		);
		const folderEvent = createClickEvent(folderBacklink);
		const fileEvent = createClickEvent(fileBacklink);

		folderBacklink.boundsLeft = 40;
		folderBacklink.boundsTop = 60;
		folderBacklink.clientWidth = 200;
		folderBacklink.clientHeight = 42;
		fileBacklink.boundsLeft = 310;
		fileBacklink.boundsTop = 180;
		fileBacklink.clientWidth = 200;
		fileBacklink.clientHeight = 42;
		assert.deepStrictEqual(
			renderer.getBacklinkClientCenter(folderAddition.root.id),
			{ clientX: 140, clientY: 81 },
		);
		assert.deepStrictEqual(
			renderer.getBacklinkClientCenter(fileAddition.root.id),
			{ clientX: 410, clientY: 201 },
		);

		folderBacklink.dispatch('click', folderEvent);
		fileBacklink.dispatch('click', fileEvent);

		assert.deepStrictEqual(backlinkClicks, [
			folderAddition.root.id,
			fileAddition.root.id,
		]);
		assert.deepStrictEqual(folderClicks, []);
		assert.deepStrictEqual(fileClicks, []);
		assert.strictEqual(folderEvent.defaultPrevented, true);
		assert.strictEqual(fileEvent.defaultPrevented, true);
		assert.strictEqual(folderEvent.propagationStopped, true);
		assert.strictEqual(fileEvent.propagationStopped, true);
		assert.strictEqual(
			folderBacklink.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
			true,
		);
		assert.strictEqual(
			fileBacklink.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
			true,
		);
		const folderRoot = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			getGraphRootLayoutNodeId(folderAddition.root),
		);
		const fileRoot = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			getGraphRootLayoutNodeId(fileAddition.root),
		);

		for (const root of [folderRoot, fileRoot]) {
			const label = getDescendantByClass(root, 'graph-root-context-label');

			label.dispatch('click', createClickEvent(label));
		}

		assert.deepStrictEqual(rootContextClicks, [
			folderAddition.root.id,
			fileAddition.root.id,
		]);

		renderer.applyLayout(createGraphLayout(
			createSingleRootGraph(project, 'root:project'),
			{ openedFolders: graphState.getState().openedFolders },
		));
		assert.strictEqual(
			renderer.getBacklinkClientCenter(folderAddition.root.id),
			undefined,
		);
		assert.strictEqual(
			renderer.getBacklinkClientCenter(fileAddition.root.id),
			undefined,
		);

		renderer.dispose();
	});

	test('동일 Source Detached Root가 둘 이상일 때만 우측 하단 ordinal Badge를 표시한다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:badge-source',
			name: 'badge-source',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:badge-source',
			name: 'badge-source',
			status: 'loaded',
			children: [folder],
		};
		const first = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folder.id,
		);

		assert.ok(first);
		const document = new FakeDocument();
		const edgeLayer = document.createElementNS('', 'svg');
		const nodeLayer = document.createElement('div');
		const graphState = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true },
		});
		const renderer = initializeGraphRenderer(
			edgeLayer.asSvgElement(),
			nodeLayer.asHtmlElement(),
			createGraphLayout(first.graph, {
				openedFolders: graphState.getState().openedFolders,
			}),
			graphState,
		);
		const getRoot = (rootId: string) => getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			getGraphRootLayoutNodeId({ id: rootId, nodeId: folder.id }),
		);
		const getBadge = (rootId: string) => findDescendantByClass(
			getRoot(rootId),
			'graph-detached-root-badge',
		);

		assert.strictEqual(getBadge(first.root.id), undefined);
		const second = addGraphRoot(first.graph, folder.id);
		assert.ok(second);
		renderer.applyLayout(createGraphLayout(second.graph, {
			openedFolders: graphState.getState().openedFolders,
		}));
		assert.strictEqual(getBadge(first.root.id)?.textContent, '1');
		assert.strictEqual(getBadge(second.root.id)?.textContent, '2');

		const onlySecondGraph = removeGraphRoot(second.graph, first.root.id);
		renderer.applyLayout(createGraphLayout(onlySecondGraph, {
			openedFolders: graphState.getState().openedFolders,
		}));
		assert.strictEqual(getBadge(second.root.id), undefined);
		const third = addGraphRoot(onlySecondGraph, folder.id);
		assert.ok(third);
		renderer.applyLayout(createGraphLayout(third.graph, {
			openedFolders: graphState.getState().openedFolders,
		}));
		assert.strictEqual(getBadge(second.root.id)?.textContent, '2');
		assert.strictEqual(getBadge(third.root.id)?.textContent, '3');
		assert.strictEqual(
			getBadge(third.root.id)?.getAttribute('data-detached-ordinal'),
			'3',
		);
		renderer.dispose();
	});

	test('Detached Root에만 asset 기반 Hover Action을 붙이고 Button 입력을 Graph Drag에서 격리한다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:hover-actions',
			name: 'hover-actions',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:hover-actions',
			name: 'hover-actions',
			status: 'loaded',
			children: [folder],
		};
		const addition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folder.id,
		);

		assert.ok(addition);
		const document = new FakeDocument();
		const edgeLayer = document.createElementNS('', 'svg');
		const nodeLayer = document.createElement('div');
		const graphState = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true },
		});
		const duplicateRequests: string[] = [];
		const deleteRequests: string[] = [];
		const folderClicks: string[] = [];
		const renderer = initializeGraphRenderer(
			edgeLayer.asSvgElement(),
			nodeLayer.asHtmlElement(),
			createGraphLayout(addition.graph, {
				openedFolders: graphState.getState().openedFolders,
			}),
			graphState,
			{
				onFolderClick: (folderId) => folderClicks.push(folderId),
				onDetachedRootDuplicate: (rootId) => duplicateRequests.push(rootId),
				onDetachedRootDelete: (rootId) => deleteRequests.push(rootId),
			},
		);
		const original = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			project.id,
		);
		const backlink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			createFolderBacklinkId(folder.id),
		);
		const detached = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			getGraphRootLayoutNodeId(addition.root),
		);

		assert.strictEqual(
			findDescendantByClass(original, 'graph-detached-root-actions'),
			undefined,
		);
		assert.strictEqual(
			findDescendantByClass(backlink, 'graph-detached-root-actions'),
			undefined,
		);
		const actions = getDescendantByClass(detached, 'graph-detached-root-actions');
		const duplicate = getDescendantByAttribute(
			actions,
			'data-detached-root-action',
			'duplicate',
		);
		const remove = getDescendantByAttribute(
			actions,
			'data-detached-root-action',
			'delete',
		);

		assert.strictEqual(
			getDescendantByClass(duplicate, 'graph-detached-root-action-icon')
				.getAttribute('data-ui-icon'),
			'duplicate.svg',
		);
		assert.strictEqual(
			getDescendantByClass(remove, 'graph-detached-root-action-icon')
				.getAttribute('data-ui-icon'),
			'delete.svg',
		);
		assert.strictEqual(actions.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE), true);
		assert.strictEqual(actions.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE), true);
		const pointerDown = createPointerEvent(duplicate, 10, 10);

		duplicate.dispatch('pointerdown', pointerDown);
		assert.strictEqual(pointerDown.defaultPrevented, true);
		assert.strictEqual(pointerDown.propagationStopped, true);
		assert.strictEqual(detached.hasPointerCapture(1), false);
		const duplicateClick = createClickEvent(duplicate);
		const deleteClick = createClickEvent(remove);

		duplicate.dispatch('click', duplicateClick);
		remove.dispatch('click', deleteClick);
		assert.deepStrictEqual(duplicateRequests, [addition.root.id]);
		assert.deepStrictEqual(deleteRequests, [addition.root.id]);
		assert.deepStrictEqual(folderClicks, []);
		assert.strictEqual(duplicateClick.propagationStopped, true);
		assert.strictEqual(deleteClick.propagationStopped, true);

		renderer.dispose();
		assert.strictEqual(actions.getEventListenerCount(), 0);
		assert.strictEqual(duplicate.getEventListenerCount(), 0);
		assert.strictEqual(remove.getEventListenerCount(), 0);
	});

	test('Root Drag의 자기 Backlink Target은 진입/이탈하고 cancel·layout·dispose에서 정리된다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:reattach-lifecycle',
			name: 'reattach-lifecycle',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:reattach-lifecycle',
			name: 'reattach-lifecycle',
			status: 'loaded',
			children: [folder],
		};
		const addition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folder.id,
		);

		assert.ok(addition);
		const document = new FakeDocument();
		const edgeLayer = document.createElementNS('', 'svg');
		const nodeLayer = document.createElement('div');
		const rootNodeId = getGraphRootLayoutNodeId(addition.root);
		const graphState = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [rootNodeId]: { x: 600, y: 300 } },
			openedFolders: { [project.id]: true },
		});
		const layout = createGraphLayout(addition.graph, {
			openedFolders: graphState.getState().openedFolders,
		});
		const reattachRequests: string[] = [];
		const renderer = initializeGraphRenderer(
			edgeLayer.asSvgElement(),
			nodeLayer.asHtmlElement(),
			layout,
			graphState,
			{
				resolveRootId: (nodeId) => addition.graph.roots.find(
					(root) => getGraphRootLayoutNodeId(root) === nodeId,
				)?.id,
				onRootReattach: ({ rootId }) => {
					reattachRequests.push(rootId);
					return true;
				},
			},
		);
		const rootNode = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			rootNodeId,
		);
		const backlink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			createFolderBacklinkId(folder.id),
		);

		backlink.boundsLeft = 200;
		backlink.boundsTop = 100;
		backlink.clientWidth = 200;
		backlink.clientHeight = 42;
		rootNode.dispatch('pointerdown', createPointerEvent(rootNode, 0, 0));
		rootNode.dispatch('pointermove', createPointerEvent(rootNode, 300, 121));
		assert.strictEqual(backlink.hasClass('is-reattach-target'), true);
		rootNode.dispatch('pointermove', createPointerEvent(rootNode, 500, 300));
		assert.strictEqual(backlink.hasClass('is-reattach-target'), false);
		rootNode.dispatch('pointermove', createPointerEvent(rootNode, 300, 121));
		assert.strictEqual(backlink.hasClass('is-reattach-target'), true);
		rootNode.dispatch('pointercancel', createPointerEvent(rootNode, 300, 121));
		assert.strictEqual(backlink.hasClass('is-reattach-target'), false);
		assert.deepStrictEqual(reattachRequests, []);

		rootNode.dispatch('pointerdown', createPointerEvent(rootNode, 0, 0));
		rootNode.dispatch('pointermove', createPointerEvent(rootNode, 300, 121));
		rootNode.releasePointerCapture(1);
		rootNode.dispatch(
			'lostpointercapture',
			createPointerEvent(rootNode, 300, 121),
		);
		assert.strictEqual(backlink.hasClass('is-reattach-target'), false);
		assert.deepStrictEqual(reattachRequests, []);

		rootNode.dispatch('pointerdown', createPointerEvent(rootNode, 0, 0));
		rootNode.dispatch('pointermove', createPointerEvent(rootNode, 300, 121));
		assert.strictEqual(backlink.hasClass('is-reattach-target'), true);
		renderer.applyLayout(layout);
		assert.strictEqual(backlink.hasClass('is-reattach-target'), false);
		rootNode.dispatch('pointercancel', createPointerEvent(rootNode, 300, 121));

		rootNode.dispatch('pointerdown', createPointerEvent(rootNode, 0, 0));
		rootNode.dispatch('pointermove', createPointerEvent(rootNode, 300, 121));
		assert.strictEqual(backlink.hasClass('is-reattach-target'), true);
		renderer.dispose();
		assert.strictEqual(backlink.hasClass('is-reattach-target'), false);
		assert.deepStrictEqual(reattachRequests, []);
		assert.deepStrictEqual(
			graphState.getState().nodePositions[rootNodeId],
			{ x: 600, y: 300 },
		);
	});

	for (const eventType of ['pointercancel', 'lostpointercapture'] as const) {
		test(`${eventType}은 Detach 요청 없이 Handle session을 정리한다`, () => {
			const detachDrops: string[] = [];
			const fixture = createRendererFixture(1, undefined, {
				onDetachDrop: (request) => detachDrops.push(request.nodeId),
			});
			const handle = getDescendantByClass(
				fixture.getNode('folder:app'),
				'graph-detach-handle',
			);

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 40));

			if (eventType === 'lostpointercapture') {
				handle.releasePointerCapture(1);
			}

			handle.dispatch(eventType, createPointerEvent(handle, 30, 40));
			handle.dispatch('pointerup', createPointerEvent(handle, 50, 60));

			assert.deepStrictEqual(detachDrops, []);
			assert.strictEqual(handle.hasPointerCapture(1), false);
			assert.strictEqual(handle.hasClass('is-detach-active'), false);
			assert.strictEqual(handle.hasClass('is-detach-dragging'), false);
			fixture.renderer.dispose();
		});
	}

	test('Renderer dispose 이후 Detach interaction이 동작하지 않는다', () => {
		const detachDrops: string[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onDetachDrop: (request) => detachDrops.push(request.nodeId),
		});
		const handle = getDescendantByClass(
			fixture.getNode('folder:app'),
			'graph-detach-handle',
		);

		fixture.renderer.dispose();
		handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
		handle.dispatch('pointermove', createPointerEvent(handle, 40, 50));
		handle.dispatch('pointerup', createPointerEvent(handle, 40, 50));

		assert.deepStrictEqual(detachDrops, []);
		assert.strictEqual(handle.hasPointerCapture(1), false);
		assert.strictEqual(handle.hasClass('is-detach-active'), false);
	});

	test('standalone File Group은 File ID로 기존 Graph Node Drag lifecycle을 사용한다', () => {
		const file = {
			kind: 'file' as const,
			id: 'file:standalone/index.ts',
			name: 'index.ts',
		};
		const fixture = createRendererFixture(2, undefined, {}, file);
		const layoutNode = getLayoutNode(fixture.layout, file.id);
		const node = fixture.getNode(file.id);

		node.dispatch('pointerdown', createPointerEvent(node, 100, 80));
		assert.strictEqual(node.hasPointerCapture(1), true);
		assert.strictEqual(node.hasClass('is-dragging'), true);
		node.dispatch('pointermove', createPointerEvent(node, 140, 60));
		assert.strictEqual(
			node.style.transform,
			`translate(${layoutNode.position.x + 20}px, ${layoutNode.position.y - 10}px)`,
		);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});

		node.dispatch('pointerup', createPointerEvent(node, 140, 60));
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {
			[file.id]: {
				x: layoutNode.position.x + 20,
				y: layoutNode.position.y - 10,
			},
		});
		assert.strictEqual(node.hasPointerCapture(1), false);
		assert.strictEqual(node.hasClass('is-dragging'), false);
		fixture.renderer.dispose();
	});

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
		assert.strictEqual(root.getAttribute('aria-expanded'), 'true');
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

	test('File Filter projection은 Row를 당기고 현재 page의 remaining count를 갱신한다', () => {
		const project = createPaginationProject([7]);
		const folder = project.children[0];

		assert.ok(folder && isFolder(folder));
		const fileIds = folder.children.map((file) => file.id);
		const fileGroupId = createFileGroupId(folder.id);
		const fixture = createRendererFixture(1, undefined, {}, project);
		let fileGroup = fixture.getNode(fileGroupId);
		const initialHeight = fileGroup.style.height;

		assert.deepStrictEqual(getRenderedFileIds(fileGroup), fileIds.slice(0, 5));
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 2개 더보기',
		);

		applyRendererHiddenNodeIds(fixture, project, {
			[fileIds[2] as string]: true,
		});
		fileGroup = fixture.getNode(fileGroupId);

		assert.deepStrictEqual(getRenderedFileIds(fileGroup), [
			fileIds[0],
			fileIds[1],
			fileIds[3],
			fileIds[4],
			fileIds[5],
		]);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		assert.strictEqual(fileGroup.style.height, initialHeight);

		applyRendererHiddenNodeIds(fixture, project, {
			[fileIds[6] as string]: true,
		});
		fileGroup = fixture.getNode(fileGroupId);

		assert.deepStrictEqual(getRenderedFileIds(fileGroup), fileIds.slice(0, 5));
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		assert.strictEqual(fileGroup.style.height, initialHeight);
		fixture.renderer.dispose();
	});

	test('+ 1개 더보기에서 visible 또는 overflow File을 숨기면 Footer 없이 5개만 표시한다', () => {
		const project = createPaginationProject([6]);
		const folder = project.children[0];

		assert.ok(folder && isFolder(folder));
		const fileIds = folder.children.map((file) => file.id);
		const fileGroupId = createFileGroupId(folder.id);
		const fixture = createRendererFixture(1, undefined, {}, project);
		const applyHiddenFile = (fileId: string): FakeElement => {
			applyRendererHiddenNodeIds(fixture, project, { [fileId]: true });

			return fixture.getNode(fileGroupId);
		};
		const initialGroup = fixture.getNode(fileGroupId);

		assert.strictEqual(
			getDescendantByClass(initialGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		let fileGroup = applyHiddenFile(fileIds[2] as string);

		assert.deepStrictEqual(getRenderedFileIds(fileGroup), [
			fileIds[0],
			fileIds[1],
			fileIds[3],
			fileIds[4],
			fileIds[5],
		]);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-more'), undefined);

		fileGroup = applyHiddenFile(fileIds[5] as string);

		assert.deepStrictEqual(getRenderedFileIds(fileGroup), fileIds.slice(0, 5));
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-more'), undefined);
		fixture.renderer.dispose();
	});

	test('펼친 File Group Filter는 높이를 줄이고 all-hidden Group을 projection에서 제거한다', () => {
		const project = createPaginationProject([7]);
		const folder = project.children[0];

		assert.ok(folder && isFolder(folder));
		const fileIds = folder.children.map((file) => file.id);
		const fileGroupId = createFileGroupId(folder.id);
		const savedPosition = { x: 640, y: 320 };
		const fixture = createRendererFixture(1, {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [fileGroupId]: savedPosition },
			fileGroupPages: { [fileGroupId]: 2 },
		}, {}, project);
		const initialState = fixture.graphState.getState();
		const connectedEdge = fixture.getConnectedEdge(fileGroupId);
		const applyHiddenFiles = (hiddenNodeIds: Record<string, true>): void => {
			applyRendererHiddenNodeIds(fixture, project, hiddenNodeIds);
		};
		let fileGroup = fixture.getNode(fileGroupId);

		assert.strictEqual(getRenderedFileIds(fileGroup).length, 7);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(7, true)}px`);

		applyHiddenFiles({ [fileIds[2] as string]: true });
		fileGroup = fixture.getNode(fileGroupId);

		assert.deepStrictEqual(getRenderedFileIds(fileGroup), [
			fileIds[0],
			fileIds[1],
			fileIds[3],
			fileIds[4],
			fileIds[5],
			fileIds[6],
		]);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(6, true)}px`);
		assert.strictEqual(fixture.graphState.getState().fileGroupPages, initialState.fileGroupPages);
		assert.strictEqual(fixture.graphState.getState().nodePositions, initialState.nodePositions);
		assert.strictEqual(fixture.graphState.getState().openedFolders, initialState.openedFolders);
		assert.strictEqual(
			fixture.graphState.getState().detachedRootNodeIds,
			initialState.detachedRootNodeIds,
		);

		const removedFileGroup = fileGroup;

		applyHiddenFiles(Object.fromEntries(
			fileIds.map((fileId) => [fileId, true]),
		) as Record<string, true>);

		assert.strictEqual(fixture.nodeLayer.children.includes(removedFileGroup), false);
		assert.strictEqual(fixture.edgeLayer.children.includes(connectedEdge), false);
		assert.strictEqual(removedFileGroup.getEventListenerCount(), 0);

		applyHiddenFiles(Object.fromEntries(
			fileIds.slice(0, 6).map((fileId) => [fileId, true]),
		) as Record<string, true>);
		fileGroup = fixture.getNode(fileGroupId);

		assert.notStrictEqual(fileGroup, removedFileGroup);
		assert.strictEqual(
			fileGroup.getAttribute('data-file-group-presentation'),
			'grouped',
		);
		assert.deepStrictEqual(getRenderedFileIds(fileGroup), [fileIds[6]]);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(1, false)}px`);
		assert.strictEqual(fixture.getConnectedEdge(fileGroupId).getAttribute('visibility'), null);
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 2);

		applyHiddenFiles({});
		fileGroup = fixture.getNode(fileGroupId);

		assert.deepStrictEqual(getRenderedFileIds(fileGroup), fileIds);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(7, true)}px`);
		assert.ok(findDescendantByClass(fileGroup, 'graph-file-collapse'));
		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 2);
		assert.strictEqual(folder.children.length, 7);
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
		assert.strictEqual(more.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE), true);
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
			collapse.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
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
		assert.strictEqual(firstRow.getEventListenerCount(), 0);
		const refreshedFirstRow = getDescendantByClass(first, 'graph-file-item');
		assert.notStrictEqual(refreshedFirstRow, firstRow);
		assert.strictEqual(refreshedFirstRow.getEventListenerCount(), 3);
		assert.strictEqual(getDescendantByClass(second, 'graph-file-item'), secondRow);
		assert.strictEqual(getDescendantByClass(second, 'graph-file-more'), secondMore);
		fixture.renderer.dispose();
		assert.strictEqual(refreshedFirstRow.getEventListenerCount(), 0);
		assert.strictEqual(secondRow.getEventListenerCount(), 0);
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

	test('grouped File Row Double Click은 원본 File ID로 Open 요청하고 상위 전파를 막는다', () => {
		const firstFileId = 'file:file:///workspace/src/first.ts';
		const folder = {
			kind: 'folder' as const,
			id: 'folder:file:///workspace/src',
			name: 'src',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: firstFileId,
				name: 'first.ts',
			}, {
				kind: 'file' as const,
				id: 'file:file:///workspace/src/second.ts',
				name: 'second.ts',
			}],
		};
		const rootId = createDetachedRootId(folder.id, 1);
		const graphState = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [folder.id]: true },
		});
		const layout = createGraphLayout(createSingleRootGraph(folder, rootId), {
			openedFolders: graphState.getState().openedFolders,
		});
		const document = new FakeDocument();
		const edgeLayer = document.createElementNS('', 'svg');
		const nodeLayer = document.createElement('div');
		const fileClicks: string[] = [];
		const fileOpenRequests: string[] = [];
		const renderer = initializeGraphRenderer(
			edgeLayer.asSvgElement(),
			nodeLayer.asHtmlElement(),
			layout,
			graphState,
			{
				onFileClick: (fileId) => fileClicks.push(fileId),
				onFileOpenRequest: (fileId) => fileOpenRequests.push(fileId),
			},
		);
		const fileGroupId = createGraphLayoutNodeId(
			rootId,
			createFileGroupId(folder.id),
		);
		const fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);
		const fileRow = getDescendantByAttribute(
			fileGroup,
			'data-file-id',
			firstFileId,
		);
		const layoutFileId = createGraphLayoutNodeId(rootId, firstFileId);
		const layoutFileGroup = getLayoutNode(layout, fileGroupId);

		assert.strictEqual(layoutFileGroup.kind, 'file-group');
		assert.ok(layoutFileGroup.kind === 'file-group');
		assert.strictEqual(layoutFileGroup.children[0]?.id, layoutFileId);
		assert.notStrictEqual(layoutFileId, firstFileId);
		let bubbledDoubleClicks = 0;
		fileGroup.addEventListener('dblclick', () => {
			bubbledDoubleClicks += 1;
		});
		const doubleClick = createClickEvent(fileRow);

		fileRow.dispatch('dblclick', doubleClick);

		assert.deepStrictEqual(fileOpenRequests, [firstFileId]);
		assert.strictEqual(bubbledDoubleClicks, 0);
		assert.strictEqual(doubleClick.defaultPrevented, true);
		assert.strictEqual(doubleClick.propagationStopped, true);
		assert.deepStrictEqual(fileClicks, []);

		fileRow.dispatch('click', createClickEvent(fileRow));
		assert.deepStrictEqual(fileClicks, [firstFileId]);
		assert.strictEqual(fileRow.hasClass('is-file-clicking'), true);
		fileRow.dispatch('animationend', createAnimationEvent(fileRow));
		assert.strictEqual(fileRow.hasClass('is-file-clicking'), false);
		renderer.dispose();
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

	test('Folder, File Group, File Row 위 Wheel Pan과 Zoom Gesture를 모두 처리한다', () => {
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
			const cameraBeforePan = camera.getState();
			const panEvent = createWheelEvent(target, cursor.x, cursor.y, 24);

			viewport.dispatch('wheel', panEvent);

			assert.deepStrictEqual(camera.getState(), {
				x: cameraBeforePan.x,
				y: cameraBeforePan.y - 24,
				scale: cameraBeforePan.scale,
			});
			assert.strictEqual(panEvent.defaultPrevented, true);

			const scaleBefore = camera.getState().scale;
			const worldBefore = camera.viewportToWorld(cursor);
			const wheelEvent = createWheelEvent(target, cursor.x, cursor.y, -120, true);

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
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
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
		assert.strictEqual(restoredFileRow.getEventListenerCount(), 3);

		restoredFolder.dispatch('click', createClickEvent(restoredFolder));
		restoredFileRow.dispatch('click', createClickEvent(restoredFileRow));
		assert.deepStrictEqual(folderClicks, [removedFolderId]);
		assert.deepStrictEqual(fileClicks, ['file:app/src/graphView.ts']);
		fixture.renderer.dispose();
	});

	test('applyLayout은 같은 grouped File Group DOM을 유지하며 File 증감과 Footer를 갱신한다', () => {
		const project = createPaginationProject([6]);
		const folder = project.children[0];

		assert.ok(folder && isFolder(folder));
		const fileGroupId = createFileGroupId(folder.id);
		const fixture = createRendererFixture(1, undefined, {}, project);
		const fileGroup = fixture.getNode(fileGroupId);
		const edge = fixture.getConnectedEdge(fileGroupId);
		const initialRows = getDescendantsByClass(fileGroup, 'graph-file-item');
		const initialFileIds = folder.children.map((file) => file.id);
		const removedVisibleProject: Project = {
			...project,
			children: [{
				...folder,
				children: folder.children.filter((_, index) => index !== 2),
			}],
		};
		const applyProject = (nextProject: Project): void => {
			const state = fixture.graphState.getState();

			fixture.renderer.applyLayout(createGraphLayout(
				createSingleRootGraph(nextProject),
				{
					fileGroupPages: state.fileGroupPages,
					openedFolders: state.openedFolders,
					hiddenNodeIds: state.hiddenNodeIds,
				},
			));
		};

		applyProject(removedVisibleProject);

		assert.strictEqual(fixture.getNode(fileGroupId), fileGroup);
		assert.strictEqual(fixture.getConnectedEdge(fileGroupId), edge);
		assert.deepStrictEqual(getRenderedFileIds(fileGroup), [
			initialFileIds[0],
			initialFileIds[1],
			initialFileIds[3],
			initialFileIds[4],
			initialFileIds[5],
		]);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, false)}px`);
		assert.ok(initialRows.every((row) => row.getEventListenerCount() === 0));
		const retainedRows = getDescendantsByClass(fileGroup, 'graph-file-item');

		applyProject(removedVisibleProject);

		assert.strictEqual(fixture.getNode(fileGroupId), fileGroup);
		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item'),
			retainedRows,
		);
		assert.ok(retainedRows.every((row) => row.getEventListenerCount() === 3));

		const addedFile = {
			kind: 'file' as const,
			id: 'file:pagination-0/file-7.ts',
			name: 'file-7.ts',
		};
		const addedProject: Project = {
			...removedVisibleProject,
			children: [{
				...(removedVisibleProject.children[0] as typeof folder),
				children: [
					...(removedVisibleProject.children[0] as typeof folder).children,
					addedFile,
				],
			}],
		};

		applyProject(addedProject);

		assert.strictEqual(fixture.getNode(fileGroupId), fileGroup);
		assert.deepStrictEqual(getRenderedFileIds(fileGroup), [
			initialFileIds[0],
			initialFileIds[1],
			initialFileIds[3],
			initialFileIds[4],
			initialFileIds[5],
		]);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, true)}px`);
		assert.ok(retainedRows.every((row) => row.getEventListenerCount() === 0));
		fixture.renderer.dispose();
		assert.strictEqual(fileGroup.getEventListenerCount(), 0);
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
			openedFolders: { [project.id]: true },
		}));

		assert.strictEqual(fixture.graphState.getFileGroupPage(fileGroupId), 3);

		fixture.renderer.applyLayout(createGraphLayout(createSingleRootGraph(project), {
			fileGroupPages: fixture.graphState.getState().fileGroupPages,
			openedFolders: {
				[project.id]: true,
				[folderId]: true,
			},
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
		let fileOpenRequests = 0;
		const fixture = createRendererFixture(1, undefined, {
			onFileGroupClick: () => {
				fileGroupClicks += 1;
			},
			onFileClick: () => {
				fileClicks += 1;
			},
			onFileOpenRequest: () => {
				fileOpenRequests += 1;
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
			assert.strictEqual(restoredFileRow.getEventListenerCount(), 3);

			fixture.renderer.applyLayout(openLayout);
			assert.strictEqual(fixture.getNode(fileGroupId), restoredFileGroup);
			assert.strictEqual(restoredFileGroup.getEventListenerCount(), 6);
			assert.strictEqual(restoredFileRow.getEventListenerCount(), 3);

			restoredFileGroup.dispatch(
				'click',
				createClickEvent(restoredFileGroup),
			);
			restoredFileRow.dispatch('click', createClickEvent(restoredFileRow));
			restoredFileRow.dispatch('dblclick', createClickEvent(restoredFileRow));
			assert.strictEqual(fileGroupClicks, cycle);
			assert.strictEqual(fileClicks, cycle);
			assert.strictEqual(fileOpenRequests, cycle);
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
		activeFileRow.dispatch('dblclick', createClickEvent(activeFileRow));
		fixture.renderer.applyLayout(openLayout);
		assert.strictEqual(fileGroupClicks, 3);
		assert.strictEqual(fileClicks, 3);
		assert.strictEqual(fileOpenRequests, 3);
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

	test('Layout 전환은 기존 Node DOM과 연결 Edge를 같은 Frame에서 보간한다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createRendererFixture(
			1,
			undefined,
			{},
			GRAPH_MOCK_PROJECT,
			undefined,
			{
				animationFrameScheduler: scheduler,
				transitionDuration: 200,
			},
		);
		const nodeId = 'folder:app';
		const node = fixture.getNode(nodeId);
		const edge = fixture.getConnectedEdge(nodeId);
		const initialNode = getLayoutNode(fixture.layout, nodeId);
		const initialEdgePath = edge.getAttribute('d');
		const edgeWritesBefore = edge.getAttributeWriteCount('d');
		const targetPosition = {
			x: initialNode.position.x + 120,
			y: initialNode.position.y + 200,
		};

		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, {
			...initialNode,
			position: targetPosition,
		}));

		assert.strictEqual(fixture.getNode(nodeId), node);
		assert.deepStrictEqual(readTranslate(node.style.transform), initialNode.position);
		assert.strictEqual(scheduler.pendingCount, 1);

		scheduler.runNext(0);
		assert.deepStrictEqual(readTranslate(node.style.transform), initialNode.position);
		scheduler.runNext(100);
		const interpolatedPosition = readTranslate(node.style.transform);

		assert.ok(interpolatedPosition.x > initialNode.position.x);
		assert.ok(interpolatedPosition.x < targetPosition.x);
		assert.ok(interpolatedPosition.y > initialNode.position.y);
		assert.ok(interpolatedPosition.y < targetPosition.y);
		assert.notStrictEqual(edge.getAttribute('d'), initialEdgePath);
		assert.ok(edge.getAttributeWriteCount('d') > edgeWritesBefore);

		scheduler.runNext(200);
		assert.deepStrictEqual(readTranslate(node.style.transform), targetPosition);
		assert.strictEqual(scheduler.pendingCount, 0);
		fixture.renderer.dispose();
	});

	test('Folder 펼침과 접힘은 하위 Node 및 Edge를 부모 기준으로 출입시킨다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const folderId = 'folder:app';
		const childId = 'folder:app/src';
		const edgeId = `${folderId}->${childId}`;
		const collapsedFolders: Record<string, true> = {
			[GRAPH_MOCK_PROJECT.id]: true,
		};
		const expandedFolders: Record<string, true> = {
			...collapsedFolders,
			[folderId]: true,
		};
		const fixture = createRendererFixture(
			1,
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				openedFolders: collapsedFolders,
			},
			{},
			GRAPH_MOCK_PROJECT,
			undefined,
			{
				animationFrameScheduler: scheduler,
				transitionDuration: 200,
			},
		);
		const parentStart = readTranslate(
			fixture.getNode(folderId).style.transform,
		);
		const expandedLayout = createGraphLayout(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
			{ openedFolders: expandedFolders },
		);
		const childTarget = getLayoutNode(expandedLayout, childId).position;

		fixture.renderer.applyLayout(expandedLayout);
		const child = fixture.getNode(childId);
		const edge = fixture.getEdge(edgeId);

		assert.deepStrictEqual(readTranslate(child.style.transform), parentStart);
		assert.strictEqual(child.style.opacity, '0');
		assert.strictEqual(child.style.scale, '0.96');
		assert.strictEqual(edge.style.opacity, '0');
		assert.strictEqual(child.hasClass('is-layout-transitioning'), true);
		assert.strictEqual(scheduler.pendingCount, 1);

		scheduler.runNext(0);
		scheduler.runNext(100);
		const enteringPosition = readTranslate(child.style.transform);
		const enteringOpacity = Number(child.style.opacity);

		assert.ok(enteringPosition.x > parentStart.x);
		assert.ok(enteringPosition.x < childTarget.x);
		assert.ok(enteringOpacity > 0 && enteringOpacity < 1);
		assert.strictEqual(edge.style.opacity, child.style.opacity);

		scheduler.runNext(200);
		assert.deepStrictEqual(readTranslate(child.style.transform), childTarget);
		assert.strictEqual(child.style.opacity, '');
		assert.strictEqual(child.style.scale, '');
		assert.strictEqual(edge.style.opacity, '');
		assert.strictEqual(child.hasClass('is-layout-transitioning'), false);

		const collapsedLayout = createGraphLayout(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
			{ openedFolders: collapsedFolders },
		);
		const parentTarget = getLayoutNode(collapsedLayout, folderId).position;

		fixture.renderer.applyLayout(collapsedLayout);
		assert.strictEqual(fixture.nodeLayer.children.includes(child), true);
		assert.strictEqual(fixture.edgeLayer.children.includes(edge), true);
		assert.strictEqual(child.hasClass('is-layout-exiting'), true);
		assert.strictEqual(child.getEventListenerCount(), 0);
		assert.strictEqual(child.style.opacity, '1');
		assert.strictEqual(edge.style.opacity, '1');

		scheduler.runNext(200);
		scheduler.runNext(300);
		const exitingPosition = readTranslate(child.style.transform);
		const exitingOpacity = Number(child.style.opacity);

		assert.ok(exitingPosition.x < childTarget.x);
		assert.ok(exitingPosition.x > parentTarget.x);
		assert.ok(exitingOpacity > 0 && exitingOpacity < 1);

		scheduler.runNext(400);
		assert.strictEqual(fixture.nodeLayer.children.includes(child), false);
		assert.strictEqual(fixture.edgeLayer.children.includes(edge), false);
		assert.strictEqual(scheduler.pendingCount, 0);
		fixture.renderer.dispose();
	});

	test('Duplicate는 선택 Instance에서 새 subtree를 출발시키고 Delete는 Backlink로 수렴 후 제거한다', () => {
		const child = {
			kind: 'folder' as const,
			id: 'folder:action-animation/child',
			name: 'child',
			status: 'loaded' as const,
			children: [],
		};
		const folder = {
			kind: 'folder' as const,
			id: 'folder:action-animation',
			name: 'action-animation',
			status: 'loaded' as const,
			children: [child],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:action-animation',
			name: 'action-animation',
			status: 'loaded',
			children: [folder],
		};
		const first = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folder.id,
		);

		assert.ok(first);
		const second = addGraphRoot(first.graph, folder.id);
		assert.ok(second);
		const firstRootNodeId = getGraphRootLayoutNodeId(first.root);
		const secondRootNodeId = getGraphRootLayoutNodeId(second.root);
		const firstChildNodeId = createGraphLayoutNodeId(first.root.id, child.id);
		const secondChildNodeId = createGraphLayoutNodeId(second.root.id, child.id);
		const positions = {
			[firstRootNodeId]: { x: 600, y: 320 },
			[firstChildNodeId]: { x: 902, y: 320 },
			[secondRootNodeId]: { x: 600, y: 620 },
			[secondChildNodeId]: { x: 902, y: 620 },
		};
		const openedFolders = {
			[project.id]: true as const,
			[firstRootNodeId]: true as const,
			[secondRootNodeId]: true as const,
		};
		const document = new FakeDocument();
		const edgeLayer = document.createElementNS('', 'svg');
		const nodeLayer = document.createElement('div');
		const graphState = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: positions,
			openedFolders,
		});
		const scheduler = new FakeAnimationFrameScheduler();
		const firstLayout = createGraphLayout(first.graph, { openedFolders });
		const secondLayout = createGraphLayout(second.graph, { openedFolders });
		const renderer = initializeGraphRenderer(
			edgeLayer.asSvgElement(),
			nodeLayer.asHtmlElement(),
			firstLayout,
			graphState,
			{},
			{
				animationFrameScheduler: scheduler,
				transitionDuration: 200,
			},
		);
		const getNode = (nodeId: string) => getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			nodeId,
		);
		const firstRoot = getNode(firstRootNodeId);
		const firstChild = getNode(firstChildNodeId);
		const firstRootTransform = firstRoot.style.transform;
		const firstChildTransform = firstChild.style.transform;

		renderer.applyLayout(secondLayout, positions, {
			enteringSourceRootId: first.root.id,
		});
		const secondRoot = getNode(secondRootNodeId);
		const secondChild = getNode(secondChildNodeId);

		assert.strictEqual(secondRoot.style.transform, firstRootTransform);
		assert.strictEqual(secondChild.style.transform, firstChildTransform);
		assert.strictEqual(firstRoot.style.transform, firstRootTransform);
		assert.strictEqual(firstChild.style.transform, firstChildTransform);
		scheduler.runNext(0);
		scheduler.runNext(100);
		assert.ok(readTranslate(secondRoot.style.transform).y > 320);
		assert.ok(readTranslate(secondRoot.style.transform).y < 620);
		assert.strictEqual(firstRoot.style.transform, firstRootTransform);
		scheduler.runNext(200);
		assert.deepStrictEqual(readTranslate(secondRoot.style.transform), {
			x: 600,
			y: 620,
		});
		assert.deepStrictEqual(readTranslate(secondChild.style.transform), {
			x: 902,
			y: 620,
		});

		renderer.applyLayout(firstLayout, positions);
		assert.strictEqual(nodeLayer.children.includes(secondRoot), true);
		assert.strictEqual(secondRoot.hasClass('is-layout-exiting'), true);
		assert.strictEqual(
			findDescendantByClass(secondRoot, 'graph-detached-root-actions'),
			undefined,
		);
		scheduler.runNext(200);
		scheduler.runNext(300);
		assert.ok(readTranslate(secondRoot.style.transform).y < 620);
		assert.strictEqual(firstRoot.style.transform, firstRootTransform);
		scheduler.runNext(400);
		assert.strictEqual(nodeLayer.children.includes(secondRoot), false);
		assert.strictEqual(nodeLayer.children.includes(secondChild), false);
		assert.strictEqual(scheduler.pendingCount, 0);
		renderer.dispose();
	});

	test('새 Layout은 진행 중 전환을 현재 위치에서 취소하고 새 목표로 이어간다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createRendererFixture(
			1,
			undefined,
			{},
			GRAPH_MOCK_PROJECT,
			undefined,
			{
				animationFrameScheduler: scheduler,
				transitionDuration: 200,
			},
		);
		const nodeId = 'folder:app';
		const node = fixture.getNode(nodeId);
		const initialNode = getLayoutNode(fixture.layout, nodeId);
		const firstNode = {
			...initialNode,
			position: {
				x: initialNode.position.x + 100,
				y: initialNode.position.y + 100,
			},
		};
		const secondNode = {
			...initialNode,
			position: {
				x: initialNode.position.x + 300,
				y: initialNode.position.y + 240,
			},
		};

		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, firstNode));
		scheduler.runNext(0);
		scheduler.runNext(50);
		const interruptedPosition = readTranslate(node.style.transform);

		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, secondNode));

		assert.strictEqual(scheduler.cancelCount, 1);
		assert.strictEqual(scheduler.pendingCount, 1);
		assert.deepStrictEqual(readTranslate(node.style.transform), interruptedPosition);
		scheduler.runNext(50);
		assert.deepStrictEqual(readTranslate(node.style.transform), interruptedPosition);
		scheduler.runNext(250);
		assert.deepStrictEqual(readTranslate(node.style.transform), secondNode.position);
		fixture.renderer.dispose();
	});

	test('Drag 시작은 Layout 전환을 종료하고 Pointer 이동을 즉시 반영한다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createRendererFixture(
			1,
			undefined,
			{},
			GRAPH_MOCK_PROJECT,
			undefined,
			{
				animationFrameScheduler: scheduler,
				transitionDuration: 200,
			},
		);
		const nodeId = 'folder:app';
		const node = fixture.getNode(nodeId);
		const initialNode = getLayoutNode(fixture.layout, nodeId);
		const targetPosition = {
			x: initialNode.position.x + 160,
			y: initialNode.position.y + 120,
		};

		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, {
			...initialNode,
			position: targetPosition,
		}));
		scheduler.runNext(0);
		scheduler.runNext(50);
		node.dispatch('pointerdown', createPointerEvent(node, 10, 10));

		assert.strictEqual(scheduler.cancelCount, 1);
		assert.strictEqual(scheduler.pendingCount, 0);
		assert.deepStrictEqual(readTranslate(node.style.transform), targetPosition);
		node.dispatch('pointermove', createPointerEvent(node, 30, 40));
		assert.deepStrictEqual(readTranslate(node.style.transform), {
			x: targetPosition.x + 20,
			y: targetPosition.y + 30,
		});
		assert.strictEqual(scheduler.pendingCount, 0);
		node.dispatch('pointerup', createPointerEvent(node, 30, 40));
		fixture.renderer.dispose();
	});

	test('dispose와 reduced motion은 예약 RAF를 남기지 않는다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createRendererFixture(
			1,
			undefined,
			{},
			GRAPH_MOCK_PROJECT,
			undefined,
			{
				animationFrameScheduler: scheduler,
				transitionDuration: 200,
			},
		);
		const nodeId = 'folder:app';
		const initialNode = getLayoutNode(fixture.layout, nodeId);
		const movedNode = {
			...initialNode,
			position: {
				x: initialNode.position.x + 100,
				y: initialNode.position.y + 100,
			},
		};

		fixture.renderer.applyLayout(replaceLayoutNode(fixture.layout, movedNode));
		assert.strictEqual(scheduler.pendingCount, 1);
		fixture.renderer.dispose();
		assert.strictEqual(scheduler.pendingCount, 0);
		assert.strictEqual(scheduler.cancelCount, 1);

		const reducedScheduler = new FakeAnimationFrameScheduler();
		const reducedFixture = createRendererFixture(
			1,
			undefined,
			{},
			GRAPH_MOCK_PROJECT,
			undefined,
			{
				animationFrameScheduler: reducedScheduler,
				transitionDuration: 200,
				prefersReducedMotion: true,
			},
		);
		const reducedNode = getLayoutNode(reducedFixture.layout, nodeId);
		const reducedTarget = {
			x: reducedNode.position.x + 90,
			y: reducedNode.position.y + 70,
		};

		reducedFixture.renderer.applyLayout(replaceLayoutNode(
			reducedFixture.layout,
			{ ...reducedNode, position: reducedTarget },
		));
		assert.deepStrictEqual(
			readTranslate(reducedFixture.getNode(nodeId).style.transform),
			reducedTarget,
		);
		assert.strictEqual(reducedScheduler.pendingCount, 0);
		reducedFixture.renderer.dispose();
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
			const savedPositions = fixture.graphState.getState().nodePositions;

			assert.deepStrictEqual(savedPositions[nodeId], {
				x: layoutNode.position.x + 20,
				y: layoutNode.position.y - 10,
			});
			if (label === 'File Group') {
				assert.deepStrictEqual(Object.keys(savedPositions), [nodeId]);
			} else {
				assert.ok(Object.keys(savedPositions).length > 1);
			}
			assert.strictEqual(stateChanges, 1);
			assert.strictEqual(node.hasPointerCapture(1), false);
			assert.strictEqual(node.hasClass('is-dragging'), false);
			unsubscribe();
			fixture.renderer.dispose();
		});
	}

	test('부모 Node Drag은 현재 Edge subtree 전체를 같은 Delta로 이동·저장한다', () => {
		const fixture = createRendererFixture();
		const parentId = 'folder:app';
		const childId = 'folder:app/src';
		const unrelatedId = 'folder:src';
		const parent = fixture.getNode(parentId);
		const child = fixture.getNode(childId);
		const unrelated = fixture.getNode(unrelatedId);
		const parentStart = readTranslate(parent.style.transform);
		const childStart = readTranslate(child.style.transform);
		const unrelatedStart = unrelated.style.transform;
		const edge = fixture.getEdge(`${parentId}->${childId}`);
		const edgePathBefore = edge.getAttribute('d');

		parent.dispatch('pointerdown', createPointerEvent(parent, 10, 10));
		parent.dispatch('pointermove', createPointerEvent(parent, 90, 60));

		assert.deepStrictEqual(readTranslate(parent.style.transform), {
			x: parentStart.x + 80,
			y: parentStart.y + 50,
		});
		assert.deepStrictEqual(readTranslate(child.style.transform), {
			x: childStart.x + 80,
			y: childStart.y + 50,
		});
		assert.strictEqual(unrelated.style.transform, unrelatedStart);
		assert.notStrictEqual(edge.getAttribute('d'), edgePathBefore);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});

		parent.dispatch('pointerup', createPointerEvent(parent, 90, 60));

		assert.deepStrictEqual(
			fixture.graphState.getState().nodePositions[parentId],
			{ x: parentStart.x + 80, y: parentStart.y + 50 },
		);
		assert.deepStrictEqual(
			fixture.graphState.getState().nodePositions[childId],
			{ x: childStart.x + 80, y: childStart.y + 50 },
		);
		assert.strictEqual(
			fixture.graphState.getState().nodePositions[unrelatedId],
			undefined,
		);
		fixture.renderer.dispose();
	});

	test('정렬 Node를 목록 밖으로 Drag하면 목록 drop zone과 placeholder를 정리한다', () => {
		const requests: GraphNodeArrangementRequest[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onNodeArrangementChange: (request) => {
				requests.push(request);
				return true;
			},
		});
		const nodeId = 'folder:app';
		const siblingId = 'folder:src';
		const node = fixture.getNode(nodeId);
		const sibling = fixture.getNode(siblingId);
		const nodePosition = getLayoutNode(fixture.layout, nodeId).position;
		const siblingPosition = getLayoutNode(fixture.layout, siblingId).position;

		node.dispatch('pointerdown', createPointerEvent(
			node,
			nodePosition.x + 8,
			nodePosition.y + 8,
		));
		node.dispatch('pointermove', createPointerEvent(node, -500, -500));
		const placeholder = getDescendantByAttribute(
			fixture.nodeLayer,
			'data-graph-arrangement-placeholder-id',
			nodeId,
		);

		assert.strictEqual(
			placeholder.style.transform,
			`translate(${nodePosition.x}px, ${nodePosition.y}px)`,
		);
		assert.strictEqual(placeholder.hasClass('is-arrangement-target'), false);
		assert.notStrictEqual(
			node.style.transform,
			`translate(${nodePosition.x}px, ${nodePosition.y}px)`,
		);

		node.dispatch('pointermove', createPointerEvent(
			node,
			siblingPosition.x + 8,
			siblingPosition.y + 8,
		));
		assert.strictEqual(sibling.hasClass('is-arrangement-target'), true);
		assert.strictEqual(placeholder.hasClass('is-arrangement-target'), true);

		node.dispatch('pointermove', createPointerEvent(
			node,
			nodePosition.x + 8,
			nodePosition.y + 8,
		));
		assert.strictEqual(sibling.hasClass('is-arrangement-target'), true);
		assert.strictEqual(placeholder.hasClass('is-arrangement-target'), true);

		node.dispatch('pointermove', createPointerEvent(node, -500, -500));
		assert.strictEqual(sibling.hasClass('is-arrangement-target'), false);
		assert.strictEqual(placeholder.hasClass('is-arrangement-target'), false);
		node.dispatch('pointerup', createPointerEvent(node, -500, -500));

		assert.deepStrictEqual(requests, [{ nodeId, arranged: false }]);
		assert.strictEqual(findDescendantByAttribute(
			fixture.nodeLayer,
			'data-graph-arrangement-placeholder-id',
			nodeId,
		), undefined);
		fixture.renderer.dispose();
	});

	test('열린 Subtree로 벌어진 형제 Card 사이 공백은 정렬 대상이 아니다', () => {
		const expanded = {
			kind: 'folder' as const,
			id: 'folder:arrangement-gap/expanded',
			name: 'expanded',
			status: 'loaded' as const,
			children: Array.from({ length: 8 }, (_, index) => ({
				kind: 'folder' as const,
				id: `folder:arrangement-gap/expanded/child-${index + 1}`,
				name: `child-${index + 1}`,
				status: 'loaded' as const,
				children: [],
			})),
		};
		const source = {
			kind: 'folder' as const,
			id: 'folder:arrangement-gap/source',
			name: 'source',
			status: 'loaded' as const,
			children: [],
		};
		const trailing = {
			kind: 'folder' as const,
			id: 'folder:arrangement-gap/trailing',
			name: 'trailing',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:arrangement-gap',
			name: 'arrangement-gap',
			status: 'loaded',
			children: [expanded, source, trailing],
		};
		const requests: GraphNodeArrangementRequest[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onNodeArrangementChange: (request) => {
				requests.push(request);
				return true;
			},
		}, project);
		const sourceNode = fixture.getNode(source.id);
		const expandedNode = fixture.getNode(expanded.id);
		const trailingNode = fixture.getNode(trailing.id);
		const sourcePosition = getLayoutNode(fixture.layout, source.id).position;
		const expandedLayoutNode = getLayoutNode(fixture.layout, expanded.id);
		const gapTop = expandedLayoutNode.position.y + expandedLayoutNode.height + 10;
		const gapBottom = sourcePosition.y - 10;

		assert.ok(gapBottom > gapTop);
		const gapPoint = {
			x: sourcePosition.x + 8,
			y: (gapTop + gapBottom) / 2,
		};

		sourceNode.dispatch('pointerdown', createPointerEvent(
			sourceNode,
			sourcePosition.x + 8,
			sourcePosition.y + 8,
		));
		sourceNode.dispatch('pointermove', createPointerEvent(
			sourceNode,
			gapPoint.x,
			gapPoint.y,
		));
		const placeholder = getDescendantByAttribute(
			fixture.nodeLayer,
			'data-graph-arrangement-placeholder-id',
			source.id,
		);

		assert.strictEqual(expandedNode.hasClass('is-arrangement-target'), false);
		assert.strictEqual(trailingNode.hasClass('is-arrangement-target'), false);
		assert.strictEqual(placeholder.hasClass('is-arrangement-target'), false);
		sourceNode.dispatch('pointerup', createPointerEvent(
			sourceNode,
			gapPoint.x,
			gapPoint.y,
		));

		assert.deepStrictEqual(requests, [{ nodeId: source.id, arranged: false }]);
		fixture.renderer.dispose();
	});

	test('비정렬 Node를 sibling 목록 또는 빈 Parent에 놓으면 정렬 요청을 보낸다', () => {
		for (const allChildrenUnarranged of [false, true]) {
			const first = {
				kind: 'folder' as const,
				id: `folder:arrangement-${allChildrenUnarranged}/first`,
				name: 'first',
				status: 'loaded' as const,
				children: [],
			};
			const second = {
				kind: 'folder' as const,
				id: `folder:arrangement-${allChildrenUnarranged}/second`,
				name: 'second',
				status: 'loaded' as const,
				children: [],
			};
			const project: Project = {
				kind: 'project',
				id: `project:arrangement-${allChildrenUnarranged}`,
				name: 'arrangement',
				status: 'loaded',
				children: [first, second],
			};
			const requests: GraphNodeArrangementRequest[] = [];
			const fixture = createRendererFixture(1, {
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {
					[first.id]: { x: 820, y: 320 },
					...(allChildrenUnarranged
						? { [second.id]: { x: 900, y: 500 } }
						: {}),
				},
			}, {
				onNodeArrangementChange: (request) => {
					requests.push(request);
					return true;
				},
			}, project);
			const state = fixture.graphState.getState();
			const unarrangedNodeIds = new Set([
				first.id,
				...(allChildrenUnarranged ? [second.id] : []),
			]);
			const nextLayout = createGraphLayout(createSingleRootGraph(project), {
				openedFolders: state.openedFolders,
				unarrangedNodeIds,
			});

			fixture.renderer.applyLayout(nextLayout, state.nodePositions);
			const firstNode = fixture.getNode(first.id);
			const targetId = allChildrenUnarranged ? project.id : second.id;
			const target = fixture.getNode(targetId);
			const targetPosition = getLayoutNode(nextLayout, targetId).position;

			firstNode.dispatch('pointerdown', createPointerEvent(firstNode, 828, 328));
			firstNode.dispatch('pointermove', createPointerEvent(
				firstNode,
				targetPosition.x + 8,
				targetPosition.y + 8,
			));

			assert.strictEqual(target.hasClass('is-arrangement-target'), true);
			assert.strictEqual(findDescendantByAttribute(
				fixture.nodeLayer,
				'data-graph-arrangement-placeholder-id',
				first.id,
			), undefined);

			firstNode.dispatch('pointerup', createPointerEvent(
				firstNode,
				targetPosition.x + 8,
				targetPosition.y + 8,
			));
			assert.deepStrictEqual(requests, [{ nodeId: first.id, arranged: true }]);
			assert.strictEqual(target.hasClass('is-arrangement-target'), false);
			fixture.renderer.dispose();
		}
	});

	test('비정렬 Card가 정렬 목록과 겹치면 Pointer가 밖에 있어도 목록 전체를 강조한다', () => {
		const floating = {
			kind: 'folder' as const,
			id: 'folder:overlap-target/floating',
			name: 'floating',
			status: 'loaded' as const,
			children: [],
		};
		const arrangedNodes = ['first', 'second', 'third'].map((name) => ({
			kind: 'folder' as const,
			id: `folder:overlap-target/${name}`,
			name,
			status: 'loaded' as const,
			children: [],
		}));
		const project: Project = {
			kind: 'project',
			id: 'project:overlap-target',
			name: 'overlap-target',
			status: 'loaded',
			children: [floating, ...arrangedNodes],
		};
		const requests: GraphNodeArrangementRequest[] = [];
		const fixture = createRendererFixture(1, {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {
				[floating.id]: { x: 820, y: 320 },
			},
		}, {
			onNodeArrangementChange: (request) => {
				requests.push(request);
				return true;
			},
		}, project);
		const state = fixture.graphState.getState();
		const layout = createGraphLayout(createSingleRootGraph(project), {
			openedFolders: state.openedFolders,
			unarrangedNodeIds: new Set([floating.id]),
		});

		fixture.renderer.applyLayout(layout, state.nodePositions);
		const floatingNode = fixture.getNode(floating.id);
		const arrangedElements = arrangedNodes.map(({ id }) => fixture.getNode(id));
		const floatingPosition = readTranslate(floatingNode.style.transform);
		const arrangedLayoutNode = getLayoutNode(layout, arrangedNodes[1].id);
		const pointerOffset = {
			x: arrangedLayoutNode.width - 8,
			y: arrangedLayoutNode.height / 2,
		};
		const overlappingPosition = {
			x: arrangedLayoutNode.position.x + 100,
			y: arrangedLayoutNode.position.y,
		};
		const pointerPosition = {
			x: overlappingPosition.x + pointerOffset.x,
			y: overlappingPosition.y + pointerOffset.y,
		};

		floatingNode.dispatch('pointerdown', createPointerEvent(
			floatingNode,
			floatingPosition.x + pointerOffset.x,
			floatingPosition.y + pointerOffset.y,
		));
		floatingNode.dispatch('pointermove', createPointerEvent(
			floatingNode,
			pointerPosition.x,
			pointerPosition.y,
		));

		assert.strictEqual(floatingNode.hasClass('is-arrangement-target'), false);
		assert.ok(arrangedElements.every(
			(element) => element.hasClass('is-arrangement-target'),
		));
		floatingNode.dispatch('pointerup', createPointerEvent(
			floatingNode,
			pointerPosition.x,
			pointerPosition.y,
		));
		assert.deepStrictEqual(requests, [{ nodeId: floating.id, arranged: true }]);
		assert.ok(arrangedElements.every(
			(element) => !element.hasClass('is-arrangement-target'),
		));
		fixture.renderer.dispose();
	});

	test('grouped File Row Drag는 standalone preview나 비정렬 요청을 만들지 않는다', () => {
		const files = ['a', 'b', 'c'].map((name) => ({
			kind: 'file' as const,
			id: `file:arrangement/${name}.ts`,
			name: `${name}.ts`,
		}));
		const project: Project = {
			kind: 'project',
			id: 'project:file-arrangement-drag',
			name: 'file-arrangement-drag',
			status: 'loaded',
			children: files,
		};
		const requests: GraphNodeArrangementRequest[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onNodeArrangementChange: (request) => {
				requests.push(request);
				return true;
			},
		}, project);
		const file = files[1];

		assert.ok(file);
		const fileGroupId = createFileGroupId(project.id);
		const fileGroup = fixture.getNode(fileGroupId);
		const row = getDescendantByAttribute(fileGroup, 'data-file-id', file.id);

		row.dispatch('pointerdown', createPointerEvent(row, 10, 10));
		row.dispatch('pointermove', createPointerEvent(row, -500, -500));
		row.dispatch('pointerup', createPointerEvent(row, -500, -500));

		assert.deepStrictEqual(requests, []);
		assert.strictEqual(fixture.graphState.getState().nodePositions[file.id], undefined);
		assert.ok(findDescendantByClass(row, 'graph-detach-handle'));
		assert.strictEqual(findDescendantByAttribute(
			fixture.nodeLayer,
			'data-graph-arrangement-preview-id',
			file.id,
		), undefined);
		assert.strictEqual(fileGroup.hasClass('is-arrangement-target'), false);
		fixture.renderer.dispose();
	});

	test('pointercancel과 lostpointercapture는 임시 위치를 복원하고 저장하지 않는다', () => {
		for (const eventType of ['pointercancel', 'lostpointercapture'] as const) {
			const fixture = createRendererFixture();
			const nodeId = 'folder:app';
			const layoutNode = getLayoutNode(fixture.layout, nodeId);
			const node = fixture.getNode(nodeId);
			const child = fixture.getNode('folder:app/src');
			const childTransform = child.style.transform;
			const edge = fixture.getConnectedEdge(nodeId);
			const edgePathBefore = edge.getAttribute('d');

			node.dispatch('pointerdown', createPointerEvent(node, 10, 10));
			node.dispatch('pointermove', createPointerEvent(node, 50, 40));
			assert.notStrictEqual(edge.getAttribute('d'), edgePathBefore);
			assert.notStrictEqual(child.style.transform, childTransform);

			if (eventType === 'lostpointercapture') {
				node.releasePointerCapture(1);
			}

			node.dispatch(eventType, createPointerEvent(node, 50, 40));

			assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
			assert.strictEqual(
				node.style.transform,
				`translate(${layoutNode.position.x}px, ${layoutNode.position.y}px)`,
			);
			assert.strictEqual(child.style.transform, childTransform);
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

	test('Node 이동을 Runtime State에 반영하고 새 Store/Renderer에 다시 적용한다', () => {
		const first = createRendererFixture(1, {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		});
		const movedId = 'folder:app';
		const untouchedId = 'folder:src';
		const movedLayout = getLayoutNode(first.layout, movedId);
		const untouchedLayout = getLayoutNode(first.layout, untouchedId);
		const movedNode = first.getNode(movedId);
		movedNode.dispatch('pointerdown', createPointerEvent(movedNode, 20, 30));
		movedNode.dispatch('pointermove', createPointerEvent(movedNode, 100, 70));
		assert.deepStrictEqual(first.graphState.getState().nodePositions, {});
		movedNode.dispatch('pointerup', createPointerEvent(movedNode, 100, 70));
		const movedState = first.graphState.getState();

		assert.deepStrictEqual(movedState.nodePositions, {
			[movedId]: {
				x: movedLayout.position.x + 80,
				y: movedLayout.position.y + 40,
			},
		});
		first.renderer.dispose();

		const second = createRendererFixture(1, {
			camera: { ...movedState.camera },
			nodePositions: Object.fromEntries(
				Object.entries(movedState.nodePositions).map(([id, position]) => [
					id,
					{ x: position.x, y: position.y },
				]),
			),
			fileGroupPages: { ...movedState.fileGroupPages },
			openedFolders: { ...movedState.openedFolders },
			detachedRootNodeIds: { ...movedState.detachedRootNodeIds },
		});

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
	rootNode: GraphRootNode = GRAPH_MOCK_PROJECT,
	rootContext?: GraphRootContext,
	rendererOptions: GraphRendererOptions = {},
) {
	const document = new FakeDocument();
	const edgeLayer = document.createElementNS('', 'svg');
	const nodeLayer = document.createElement('div');
	const graphState = createGraphState({
		...initialState,
		openedFolders: initialState.openedFolders ?? openAllContainers(rootNode),
	});
	const singleRootGraph = createSingleRootGraph(rootNode);
	const graph = rootContext
		? {
			...singleRootGraph,
			roots: singleRootGraph.roots.map((root) => ({ ...root, context: rootContext })),
		}
		: singleRootGraph;
	const layout = createGraphLayout(graph, {
		fileGroupPages: graphState.getState().fileGroupPages,
		openedFolders: graphState.getState().openedFolders,
		hiddenNodeIds: graphState.getState().hiddenNodeIds,
	});
	const renderer = initializeGraphRenderer(
		edgeLayer.asSvgElement(),
		nodeLayer.asHtmlElement(),
		layout,
		graphState,
		interactions,
		rendererOptions,
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
		status: 'loaded',
		children: fileCounts.map((fileCount, groupIndex) => ({
			kind: 'folder' as const,
			id: `folder:pagination-${groupIndex}`,
			name: `pagination-${groupIndex}`,
			status: 'loaded' as const,
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

function getRenderedFileIds(fileGroup: FakeElement): Array<string | null> {
	return getDescendantsByClass(fileGroup, 'graph-file-item').map(
		(row) => row.getAttribute('data-file-id'),
	);
}

function applyRendererHiddenNodeIds(
	fixture: ReturnType<typeof createRendererFixture>,
	rootNode: GraphRootNode,
	hiddenNodeIds: Record<string, true>,
): void {
	const state = fixture.graphState.getState();

	fixture.graphState.setState({
		camera: state.camera,
		nodePositions: state.nodePositions,
		hiddenNodeIds,
	});
	const nextState = fixture.graphState.getState();

	fixture.renderer.applyLayout(createGraphLayout(createSingleRootGraph(rootNode), {
		fileGroupPages: nextState.fileGroupPages,
		openedFolders: nextState.openedFolders,
		hiddenNodeIds: nextState.hiddenNodeIds,
	}));
}

/** Renderer 단위 테스트의 기존 Container Tree fixture를 명시적으로 연다. */
function openAllContainers(rootNode: GraphRootNode): Record<string, true> {
	const openedFolders: Record<string, true> = {};
	const visit = (node: GraphRootNode): void => {
		if (node.kind === 'file') {
			return;
		}

		openedFolders[node.id] = true;

		for (const entry of node.children) {
			if (isFolder(entry)) {
				visit(entry);
			}
		}
	};

	visit(rootNode);
	return openedFolders;
}

function replaceLayoutNode(
	layout: GraphLayout,
	nextNode: GraphLayoutNode,
): GraphLayout {
	return {
		nodes: layout.nodes.map((node) => node.id === nextNode.id ? nextNode : node),
		edges: layout.edges,
		rootContexts: layout.rootContexts,
		rootNodeIds: layout.rootNodeIds,
		arrangedNodeIds: layout.arrangedNodeIds,
		unarrangedNodeIds: layout.unarrangedNodeIds,
	};
}

function createPointerEvent(
	target: FakeElement,
	clientX: number,
	clientY: number,
	pointerId = 1,
): PointerEvent & {
	readonly defaultPrevented: boolean;
	readonly propagationStopped: boolean;
} {
	let defaultPrevented = false;
	let propagationStopped = false;

	return {
		isPrimary: true,
		button: 0,
		pointerId,
		clientX,
		clientY,
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
	} as PointerEvent & {
		readonly defaultPrevented: boolean;
		readonly propagationStopped: boolean;
	};
}

function createWheelEvent(
	target: FakeElement,
	clientX: number,
	clientY: number,
	deltaY: number,
	ctrlKey = false,
): WheelEvent & { defaultPrevented: boolean } {
	let defaultPrevented = false;

	return {
		target: target.asEventTarget(),
		clientX,
		clientY,
		ctrlKey,
		deltaX: 0,
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

function readTranslate(transform: string): { x: number; y: number } {
	const match = transform.match(
		/^translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)$/,
	);

	assert.ok(match, `translate transform이어야 한다: ${transform}`);
	return {
		x: Number(match[1]),
		y: Number(match[2]),
	};
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

class FakeAnimationFrameScheduler implements GraphAnimationFrameScheduler {
	private readonly callbacks = new Map<number, FrameRequestCallback>();
	private nextRequestId = 1;
	cancelCount = 0;

	get pendingCount(): number {
		return this.callbacks.size;
	}

	request(callback: FrameRequestCallback): number {
		const requestId = this.nextRequestId;

		this.nextRequestId += 1;
		this.callbacks.set(requestId, callback);
		return requestId;
	}

	cancel(requestId: number): void {
		if (this.callbacks.delete(requestId)) {
			this.cancelCount += 1;
		}
	}

	runNext(timestamp: number): void {
		const entry = this.callbacks.entries().next().value as
			| [number, FrameRequestCallback]
			| undefined;

		assert.ok(entry, '실행할 Animation Frame이 있어야 한다.');
		const [requestId, callback] = entry;

		this.callbacks.delete(requestId);
		callback(timestamp);
	}
}

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
	readonly style = {
		transform: '',
		backgroundPosition: '',
		backgroundSize: '',
		setProperty(name: string, value: string): void {
			(this as Record<string, unknown>)[name] = value;
		},
		removeProperty(name: string): string {
			const previous = (this as Record<string, unknown>)[name];

			delete (this as Record<string, unknown>)[name];
			return typeof previous === 'string' ? previous : '';
		},
	} as unknown as Record<string, string>
		& Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
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
	hidden = false;
	textContent = '';
	type = '';
	clientWidth: number;
	clientHeight: number;
	boundsLeft = 0;
	boundsTop = 0;
	private readonly attributes = new Map<string, string>();
	private readonly attributeWriteCounts = new Map<string, number>();
	private readonly classNames = new Set<string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(
		readonly ownerDocument: FakeDocument,
		readonly tagName: string,
		clientWidth = 0,
		clientHeight = 0,
	) {
		this.clientWidth = clientWidth;
		this.clientHeight = clientHeight;
	}

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

	removeAttribute(name: string): void {
		this.attributes.delete(name);
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
			x: this.boundsLeft,
			y: this.boundsTop,
			left: this.boundsLeft,
			top: this.boundsTop,
			right: this.boundsLeft + this.clientWidth,
			bottom: this.boundsTop + this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
			toJSON: () => ({}),
		};
	}
}
