import * as assert from 'assert';
import {
	createFileGroupId,
	createGraphLayout,
	GRAPH_FOLDER_NODE_HEIGHT,
	GRAPH_FOLDER_NODE_WIDTH,
} from '../../webview/graph/graphLayout';
import {
	GRAPH_MOCK,
	GRAPH_MOCK_FILE_ROOT,
	GRAPH_MOCK_FOLDER_ROOT,
	GRAPH_MOCK_PROJECT,
} from '../../webview/graph/graphMockData';
import {
	createSingleRootGraph,
	type Graph,
	type Project,
} from '../../webview/graph/graphModel';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
} from '../../webview/graph/graphState';
import {
	addGraphRoot,
	createFileBacklinkGroupId,
	createFolderBacklinkId,
	createPromotedGraphRootId,
} from '../../webview/graph/graphRootPromotion';
import {
	applyGraphLayout,
	focusGraphRoot,
	initializeGraphLayoutReflow,
	initializeGraphView,
	promoteToGraphRoot,
} from '../../webview/graph/graphView';

suite('Graph View', () => {
	test('한 번 생성한 Layout reference를 Renderer와 Navigator에 함께 적용한다', () => {
		const layout = createGraphLayout(GRAPH_MOCK);
		let rendererLayout: typeof layout | undefined;
		let navigatorLayout: typeof layout | undefined;

		applyGraphLayout(
			{ applyLayout: (nextLayout) => { rendererLayout = nextLayout; } },
			{ setLayout: (nextLayout) => { navigatorLayout = nextLayout; } },
			layout,
		);

		assert.strictEqual(rendererLayout, layout);
		assert.strictEqual(navigatorLayout, layout);
		assert.strictEqual(rendererLayout, navigatorLayout);
	});

	test('초기 Graph Root를 Navigator 표시 데이터와 같은 순서로 Panel에 연결한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		graphView.camera.setState({ x: 0, y: 0, scale: 4 });
		const rootList = getDescendantByClass(
			root,
			'graph-navigator-root-list',
		);
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapNodeLayer = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapNodeCount = minimapNodeLayer.children.length;
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		assert.deepStrictEqual(
			rootList.children.map((item) => (
				getDescendantByClass(item, 'graph-navigator-root-name').textContent
			)),
			['crispy', 'multi-root-demo/', 'standalone-root.ts'],
		);
		assert.deepStrictEqual(
			getDescendantsByClass(rootList, 'graph-navigator-root-path')
				.map((path) => path.textContent),
			[
				'crispy/packages/demo/src/',
				'crispy/src/webview/graph/examples/promoted/standalone/file/',
			],
		);
		graphView.state.toggleFolder(GRAPH_MOCK_PROJECT.id);
		assert.strictEqual(
			getDescendantByClass(root, 'graph-navigator-minimap'),
			minimap,
		);
		assert.ok(minimapNodeLayer.children.length > initialMinimapNodeCount);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		graphView.state.toggleFolder(GRAPH_MOCK_PROJECT.id);
		assert.strictEqual(minimapNodeLayer.children.length, initialMinimapNodeCount);
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		graphView.dispose();
	});

	test('persisted Detached Root와 위치를 초기 Workspace Graph에 복원하고 누락 Node는 무시한다', () => {
		const detachedFolder = {
			kind: 'folder' as const,
			id: 'folder:persisted-src',
			name: 'src',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:persisted-src/index.ts',
				name: 'index.ts',
			}],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:persisted-root',
			name: 'workspace',
			status: 'loaded',
			children: [detachedFolder],
		};
		const graph = createSingleRootGraph(project, 'root:workspace');
		const savedPosition = { x: 840, y: 360 };
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 25, y: -15, scale: 1.25 },
			nodePositions: { [detachedFolder.id]: savedPosition },
			openedFolders: {
				[project.id]: true,
				[detachedFolder.id]: true,
			},
			detachedRootNodeIds: {
				[detachedFolder.id]: true,
				'folder:temporarily-missing': true,
			},
		}, graph);

		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace', 'src/']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedFolder.id]: true,
			'folder:temporarily-missing': true,
		});
		const restoredRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolder.id,
		);

		assert.strictEqual(restoredRoot.style.transform, 'translate(840px, 360px)');
		assert.ok(findDescendantByClass(restoredRoot, 'graph-root-context-label'));
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolder.children[0].id,
		));
		const backlink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(createPromotedGraphRootId(detachedFolder.id)),
		);

		assert.strictEqual(backlink.hasClass('graph-folder-backlink-node'), true);
		assert.strictEqual(
			backlink.getAttribute('data-target-node-id'),
			detachedFolder.id,
		);
		assert.strictEqual(graph.roots.length, 1);
		assert.strictEqual(graph.rootNodes[detachedFolder.id], undefined);
		graphView.dispose();
	});

	test('새 Workspace Graph를 기존 View와 State에 적용하고 Renderer와 Navigator를 동기화한다', () => {
		const existingFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-existing',
			name: 'existing',
			status: 'loaded' as const,
			children: Array.from({ length: 7 }, (_, index) => ({
				kind: 'file' as const,
				id: `file:refresh-existing/${index}.ts`,
				name: `${index}.ts`,
			})),
		};
		const removedFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-removed',
			name: 'removed',
			status: 'loaded' as const,
			children: [],
		};
		const addedFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-added',
			name: 'added',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:refresh-added/index.ts',
				name: 'index.ts',
			}],
		};
		const initialProject: Project = {
			kind: 'project',
			id: 'project:refresh-primary',
			name: 'primary',
			status: 'loaded',
			children: [existingFolder, removedFolder],
		};
		const updatedProject: Project = {
			...initialProject,
			children: [existingFolder, addedFolder],
		};
		const secondaryProject: Project = {
			kind: 'project',
			id: 'project:refresh-secondary',
			name: 'secondary',
			status: 'loaded',
			children: [],
		};
		const initialGraph = createSingleRootGraph(
			initialProject,
			'root:refresh-primary',
		);
		const updatedGraph: Graph = {
			roots: [
				{ id: 'root:refresh-primary', nodeId: updatedProject.id },
				{ id: 'root:refresh-secondary', nodeId: secondaryProject.id },
			],
			rootNodes: {
				[updatedProject.id]: updatedProject,
				[secondaryProject.id]: secondaryProject,
			},
		};
		const secondaryOnlyGraph = createSingleRootGraph(
			secondaryProject,
			'root:refresh-secondary',
		);
		const fileGroupId = createFileGroupId(existingFolder.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 125, y: -75, scale: 1.5 },
			nodePositions: {
				[existingFolder.id]: { x: 320, y: 180 },
				[addedFolder.id]: { x: 760, y: 420 },
				'folder:stale': { x: -500, y: -300 },
			},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[initialProject.id]: true,
				[existingFolder.id]: true,
				[addedFolder.id]: true,
				'folder:stale': true,
			},
			detachedRootNodeIds: {},
		}, initialGraph);
		const viewport = root.children[0];
		const existingNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			existingFolder.id,
		);
		const stateStore = graphView.state;
		const initialState = stateStore.getState();
		const initialCamera = graphView.camera.getState();

		graphView.updateGraph(updatedGraph);

		assert.strictEqual(root.children[0], viewport);
		assert.strictEqual(graphView.state, stateStore);
		assert.strictEqual(graphView.state.getState(), initialState);
		assert.deepStrictEqual(graphView.camera.getState(), initialCamera);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			existingFolder.id,
		), existingNode);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				removedFolder.id,
			),
			undefined,
		);
		const addedNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			addedFolder.id,
		);

		assert.strictEqual(addedNode.style.transform, 'translate(760px, 420px)');
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			addedFolder.children[0].id,
		));
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${updatedProject.id}->${addedFolder.id}`,
		));
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-edge-id',
				`${updatedProject.id}->${removedFolder.id}`,
			),
			undefined,
		);
		assert.strictEqual(
			getDescendantsByClass(
				getDescendantByAttribute(root, 'data-graph-node-id', fileGroupId),
				'graph-file-item',
			).length,
			7,
		);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['primary', 'secondary']);

		graphView.updateGraph(secondaryOnlyGraph);

		assert.strictEqual(root.children[0], viewport);
		assert.strictEqual(graphView.state.getState(), initialState);
		assert.deepStrictEqual(graphView.camera.getState(), initialCamera);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				updatedProject.id,
			),
			undefined,
		);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondaryProject.id,
		));
		assert.deepStrictEqual(getNavigatorRootNames(root), ['secondary']);
		assert.deepStrictEqual(initialState.nodePositions, {
			[existingFolder.id]: { x: 320, y: 180 },
			[addedFolder.id]: { x: 760, y: 420 },
			'folder:stale': { x: -500, y: -300 },
		});
		assert.deepStrictEqual(initialState.openedFolders, {
			[initialProject.id]: true,
			[existingFolder.id]: true,
			[addedFolder.id]: true,
			'folder:stale': true,
		});
		assert.deepStrictEqual(initialState.fileGroupPages, { [fileGroupId]: 2 });
		graphView.dispose();
	});

	test('Graph 갱신마다 persisted Detached Root를 재적용하고 누락 상태는 보존한다', () => {
		const detachedFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-detached',
			name: 'detached',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:refresh-detached/index.ts',
				name: 'index.ts',
			}],
		};
		const createWorkspaceGraph = (includeDetachedFolder: boolean): Graph => {
			const project: Project = {
				kind: 'project',
				id: 'project:refresh-detached',
				name: 'workspace',
				status: 'loaded',
				children: includeDetachedFolder ? [detachedFolder] : [],
			};

			return createSingleRootGraph(project, 'root:workspace');
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [detachedFolder.id]: { x: 900, y: 500 } },
			openedFolders: { 'project:refresh-detached': true },
			detachedRootNodeIds: {
				[detachedFolder.id]: true,
				'folder:refresh-missing': true,
			},
		}, createWorkspaceGraph(false));
		const detachedRootId = createPromotedGraphRootId(detachedFolder.id);
		const backlinkId = createFolderBacklinkId(detachedRootId);

		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace']);
		graphView.updateGraph(createWorkspaceGraph(true));

		const detachedRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolder.id,
		);

		assert.strictEqual(detachedRoot.style.transform, 'translate(900px, 500px)');
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		));
		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace', 'detached/']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedFolder.id]: true,
			'folder:refresh-missing': true,
		});

		graphView.updateGraph(createWorkspaceGraph(false));

		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolder.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		), undefined);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedFolder.id]: true,
			'folder:refresh-missing': true,
		});
		graphView.dispose();
	});

	test('dispose 이후 Graph 갱신 요청을 무시한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);

		graphView.dispose();
		assert.doesNotThrow(() => graphView.updateGraph(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
		));
		assert.strictEqual(root.children.length, 0);
	});

	test('Root Promotion 실패는 Graph와 Detached Root 상태를 변경하지 않는다', () => {
		const graph = createSingleRootGraph(GRAPH_MOCK_PROJECT);
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			detachedRootNodeIds: { 'folder:existing': true },
		});
		const initialSnapshot = state.getState();

		const result = promoteToGraphRoot(
			graph,
			{ nodeId: 'folder:missing', clientX: 100, clientY: 200 },
			{} as HTMLElement,
			{} as ReturnType<typeof initializeGraphView>['camera'],
			state,
		);

		assert.strictEqual(result, undefined);
		assert.strictEqual(state.getState(), initialSnapshot);
		assert.deepStrictEqual(state.getState().detachedRootNodeIds, {
			'folder:existing': true,
		});
	});

	test('Navigator Root 선택은 저장 위치와 Layout fallback을 Focus하고 Camera scale을 유지한다', () => {
		const savedFolderPosition = { x: 900, y: 520 };
		const initialScale = 1.4;
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 20, y: -30, scale: initialScale },
				nodePositions: {
					[GRAPH_MOCK_FOLDER_ROOT.id]: savedFolderPosition,
				},
			},
			GRAPH_MOCK,
		);
		const layout = createGraphLayout(GRAPH_MOCK);
		const folderLayout = layout.nodes.find(
			(node) => node.id === GRAPH_MOCK_FOLDER_ROOT.id,
		);
		const fileLayout = layout.nodes.find(
			(node) => node.id === GRAPH_MOCK_FILE_ROOT.id,
		);
		const viewport = getDescendantByClass(root, 'graph-viewport');
		const rootButtons = getDescendantsByClass(
			root,
			'graph-navigator-root-button',
		);

		assert.ok(folderLayout);
		assert.ok(fileLayout);
		assert.strictEqual(rootButtons.length, 3);
		assert.notDeepStrictEqual(savedFolderPosition, folderLayout.position);
		const focusOn = graphView.camera.focusOn;

		graphView.camera.focusOn = (point) => focusOn(point, { duration: 0 });
		const initialCamera = graphView.camera.getState();
		const folderButton = rootButtons[1];

		assert.ok(folderButton);
		folderButton.dispatch('click', createClickEvent(folderButton));
		assert.notDeepStrictEqual(graphView.camera.getState(), initialCamera);
		assert.strictEqual(graphView.camera.getState().scale, initialScale);
		assertPointAlmostEqual(
			graphView.camera.worldToViewport({
				x: savedFolderPosition.x + folderLayout.width / 2,
				y: savedFolderPosition.y + folderLayout.height / 2,
			}),
			{ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 },
		);

		const fileButton = rootButtons[2];

		assert.ok(fileButton);
		fileButton.dispatch('click', createClickEvent(fileButton));
		assert.strictEqual(graphView.camera.getState().scale, initialScale);
		assertPointAlmostEqual(
			graphView.camera.worldToViewport({
				x: fileLayout.position.x + fileLayout.width / 2,
				y: fileLayout.position.y + fileLayout.height / 2,
			}),
			{ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 },
		);
		graphView.dispose();
	});

	test('여러 Root의 저장 위치를 독립적으로 같은 Graph World에 렌더링한다', () => {
		const secondaryProject: Project = {
			kind: 'project',
			id: 'project:secondary',
			name: 'secondary',
			status: 'loaded',
			children: [{
				kind: 'file',
				id: 'file:secondary/index.ts',
				name: 'index.ts',
			}],
		};
		const graph: Graph = {
			roots: [
				{ id: 'root:primary', nodeId: GRAPH_MOCK_PROJECT.id },
				{ id: 'root:secondary', nodeId: secondaryProject.id },
			],
			rootNodes: {
				[GRAPH_MOCK_PROJECT.id]: GRAPH_MOCK_PROJECT,
				[secondaryProject.id]: secondaryProject,
			},
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const primaryPosition = { x: 320, y: 180 };
		const secondaryPosition = { x: 760, y: 420 };
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {
				[GRAPH_MOCK_PROJECT.id]: primaryPosition,
				[secondaryProject.id]: secondaryPosition,
			},
		}, graph);
		const primaryRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const secondaryRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondaryProject.id,
		);

		assert.strictEqual(
			primaryRoot.style.transform,
			'translate(320px, 180px)',
		);
		assert.strictEqual(
			secondaryRoot.style.transform,
			'translate(760px, 420px)',
		);

		const nextPrimaryPosition = { x: 540, y: 260 };
		const currentState = graphView.state.getState();

		graphView.state.setState({
			camera: { ...currentState.camera },
			nodePositions: {
				...currentState.nodePositions,
				[GRAPH_MOCK_PROJECT.id]: nextPrimaryPosition,
			},
			fileGroupPages: { ...currentState.fileGroupPages },
			openedFolders: { ...currentState.openedFolders },
		});

		assert.strictEqual(
			primaryRoot.style.transform,
			'translate(540px, 260px)',
		);
		assert.strictEqual(
			secondaryRoot.style.transform,
			'translate(760px, 420px)',
		);
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[secondaryProject.id],
			secondaryPosition,
		);
		graphView.dispose();
	});

	test('Node Drag 중 transient 위치는 무시하고 pointerup 저장 뒤 Minimap을 갱신한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		graphView.camera.setState({ x: 0, y: 0, scale: 4 });
		const project = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapNode = getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const minimapViewportIndicator = getDescendantByClass(
			root,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		beginNodeDrag(project, 4_000, 2_500);
		assert.strictEqual(
			getDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				GRAPH_MOCK_PROJECT.id,
			),
			initialMinimapNode,
		);
		assert.strictEqual(
			graphView.state.getState().nodePositions[GRAPH_MOCK_PROJECT.id],
			undefined,
		);
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		project.dispatch('pointerup', createPointerEvent(project, 4_000, 2_500));
		assert.notStrictEqual(
			getDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				GRAPH_MOCK_PROJECT.id,
			),
			initialMinimapNode,
		);
		assert.ok(graphView.state.getState().nodePositions[GRAPH_MOCK_PROJECT.id]);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		graphView.dispose();
	});

	test('Root Focus는 저장 위치를 우선하고 Layout 크기로 Folder/File 중심을 공통 계산한다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:focus-target',
			name: 'focus-target',
			status: 'loaded' as const,
			children: [],
		};
		const file = {
			kind: 'file' as const,
			id: 'file:focus-target.ts',
			name: 'focus-target.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:focus',
			name: 'focus',
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
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [folder.id]: { x: 700, y: 300 } },
			openedFolders: { [project.id]: true },
		});
		const layout = createGraphLayout(fileAddition.graph, {
			openedFolders: state.getState().openedFolders,
		});
		const folderLayout = layout.nodes.find((node) => node.id === folder.id);
		const fileLayout = layout.nodes.find((node) => node.id === file.id);
		const focusPoints: Array<{ x: number; y: number }> = [];
		const camera = { focusOn: (point: { x: number; y: number }) => {
			focusPoints.push(point);
		} };

		assert.ok(folderLayout);
		assert.ok(fileLayout);
		assert.strictEqual(focusGraphRoot(
			fileAddition.graph,
			layout,
			state,
			camera,
			folderAddition.root.id,
		), true);
		assert.strictEqual(focusGraphRoot(
			fileAddition.graph,
			layout,
			state,
			camera,
			fileAddition.root.id,
		), true);
		assert.deepStrictEqual(focusPoints, [
			{
				x: 700 + folderLayout.width / 2,
				y: 300 + folderLayout.height / 2,
			},
			{
				x: fileLayout.position.x + fileLayout.width / 2,
				y: fileLayout.position.y + fileLayout.height / 2,
			},
		]);
		assert.strictEqual(focusGraphRoot(
			fileAddition.graph,
			layout,
			state,
			camera,
			'root:missing',
		), false);
		assert.strictEqual(focusPoints.length, 2);
	});

	test('Folder/grouped/singleton Root Context는 실제 Backlink client 중심을 World로 변환해 Focus한다', () => {
		const folderTarget = {
			kind: 'folder' as const,
			id: 'folder:context-focus-target',
			name: 'context-focus-target',
			status: 'loaded' as const,
			children: [],
		};
		const groupedTarget = {
			kind: 'file' as const,
			id: 'file:grouped/context-focus.ts',
			name: 'context-focus.ts',
		};
		const groupedFolder = {
			kind: 'folder' as const,
			id: 'folder:grouped-context',
			name: 'grouped-context',
			status: 'loaded' as const,
			children: [groupedTarget, {
				kind: 'file' as const,
				id: 'file:grouped/sibling.ts',
				name: 'sibling.ts',
			}],
		};
		const singletonTarget = {
			kind: 'file' as const,
			id: 'file:singleton/context-focus.ts',
			name: 'context-focus.ts',
		};
		const singletonFolder = {
			kind: 'folder' as const,
			id: 'folder:singleton-context',
			name: 'singleton-context',
			status: 'loaded' as const,
			children: [singletonTarget],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:context-focus',
			name: 'context-focus',
			status: 'loaded',
			children: [folderTarget, groupedFolder, singletonFolder],
		};
		const folderAddition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folderTarget.id,
		);

		assert.ok(folderAddition);
		const groupedAddition = addGraphRoot(
			folderAddition.graph,
			groupedTarget.id,
		);

		assert.ok(groupedAddition);
		const singletonAddition = addGraphRoot(
			groupedAddition.graph,
			singletonTarget.id,
		);

		assert.ok(singletonAddition);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 100, y: 50, scale: 2 },
				nodePositions: {},
				openedFolders: {
					[project.id]: true,
					[groupedFolder.id]: true,
					[singletonFolder.id]: true,
				},
			},
			singletonAddition.graph,
		);
		const viewport = root.children[0];

		assert.ok(viewport);
		viewport.boundsLeft = 20;
		viewport.boundsTop = 30;
		const folderBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(folderAddition.root.id),
		);
		const groupedFileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileGroupId(groupedFolder.id),
		);
		const groupedBacklink = getDescendantByAttribute(
			groupedFileGroup,
			'data-file-id',
			groupedTarget.id,
		);
		const singletonBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileBacklinkGroupId(singletonAddition.root.id),
		);

		setClientBounds(folderBacklink, 220, 180, 200, 42);
		setClientBounds(groupedBacklink, 480, 300, 180, 30);
		setClientBounds(singletonBacklink, 740, 420, 200, 42);
		const focusPoints: Array<{ x: number; y: number }> = [];

		graphView.camera.focusOn = (point) => focusPoints.push(point);
		const roots = [
			{ nodeId: folderTarget.id, backlink: folderBacklink },
			{ nodeId: groupedTarget.id, backlink: groupedBacklink },
			{ nodeId: singletonTarget.id, backlink: singletonBacklink },
		];

		for (const entry of roots) {
			const rootNode = getDescendantByAttribute(
				root,
				'data-graph-node-id',
				entry.nodeId,
			);
			const label = getDescendantByClass(rootNode, 'graph-root-context-label');
			const clickEvent = createClickEvent(label);

			label.dispatch('click', clickEvent);
			assert.strictEqual(clickEvent.propagationStopped, true);
		}

		assert.deepStrictEqual(focusPoints, roots.map(({ backlink }) => {
			const bounds = backlink.getBoundingClientRect();

			return {
				x: (bounds.left + bounds.width / 2 - viewport.boundsLeft - 100) / 2,
				y: (bounds.top + bounds.height / 2 - viewport.boundsTop - 50) / 2,
			};
		}));
		assert.strictEqual(graphView.state.isFolderOpened(folderTarget.id), false);

		graphView.state.toggleFolder(project.id);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				createFolderBacklinkId(folderAddition.root.id),
			),
			undefined,
		);
		const folderRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderTarget.id,
		);
		const folderLabel = getDescendantByClass(
			folderRoot,
			'graph-root-context-label',
		);

		folderLabel.dispatch('click', createClickEvent(folderLabel));
		assert.strictEqual(focusPoints.length, 3);
		graphView.dispose();
	});

	test('Promoted Folder/grouped/singleton Root는 Backlink Reattach 시 Navigator에서 제거된다', () => {
		const folderChild = {
			kind: 'file' as const,
			id: 'file:reattach-folder/child.ts',
			name: 'child.ts',
		};
		const folderTarget = {
			kind: 'folder' as const,
			id: 'folder:reattach-target',
			name: 'reattach-target',
			status: 'loaded' as const,
			children: [folderChild],
		};
		const groupedFiles = Array.from({ length: 7 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:reattach-group/file-${index + 1}.ts`,
			name: `file-${index + 1}.ts`,
		}));
		const groupedTarget = groupedFiles[5];

		assert.ok(groupedTarget);
		const groupedFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-group',
			name: 'reattach-group',
			status: 'loaded' as const,
			children: groupedFiles,
		};
		const singletonTarget = {
			kind: 'file' as const,
			id: 'file:reattach-singleton/index.ts',
			name: 'index.ts',
		};
		const singletonFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-singleton',
			name: 'reattach-singleton',
			status: 'loaded' as const,
			children: [singletonTarget],
		};
		const positionedSibling = {
			kind: 'folder' as const,
			id: 'folder:reattach-positioned-sibling',
			name: 'positioned-sibling',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:reattach',
			name: 'reattach',
			status: 'loaded',
			children: [
				folderTarget,
				groupedFolder,
				singletonFolder,
				positionedSibling,
			],
		};
		const folderAddition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folderTarget.id,
		);

		assert.ok(folderAddition);
		const groupedAddition = addGraphRoot(
			folderAddition.graph,
			groupedTarget.id,
		);

		assert.ok(groupedAddition);
		const singletonAddition = addGraphRoot(
			groupedAddition.graph,
			singletonTarget.id,
		);

		assert.ok(singletonAddition);
		const fileGroupId = createFileGroupId(groupedFolder.id);
		const siblingPosition = { x: 910, y: 440 };
		const initialCamera = { x: 35, y: -15, scale: 1.5 };
		const initialOpenedFolders = {
			[project.id]: true as const,
			[folderTarget.id]: true as const,
			[groupedFolder.id]: true as const,
			[singletonFolder.id]: true as const,
		};
		const initialFileGroupPages = { [fileGroupId]: 2 };
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: initialCamera,
				nodePositions: {
					[folderTarget.id]: { x: 520, y: 180 },
					[groupedTarget.id]: { x: 670, y: 260 },
					[singletonTarget.id]: { x: 820, y: 340 },
					[positionedSibling.id]: siblingPosition,
				},
				openedFolders: initialOpenedFolders,
				fileGroupPages: initialFileGroupPages,
				detachedRootNodeIds: {
					[folderTarget.id]: true,
					[groupedTarget.id]: true,
					[singletonTarget.id]: true,
				},
			},
			singletonAddition.graph,
		);
		const rootListButton = getDescendantByClass(
			root,
			'graph-navigator-action-button',
		);
		const rootListPanel = getDescendantByClass(
			root,
			'graph-navigator-root-list-panel',
		);
		const initialNavigatorRootNames = [
			'reattach',
			'reattach-target/',
			'file-6.ts',
			'index.ts',
		];

		rootListButton.dispatch('click', createClickEvent(rootListButton));
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			initialNavigatorRootNames,
		);
		const getFolderBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(folderAddition.root.id),
		);
		const getGroupedBacklink = () => getDescendantByAttribute(
			getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			),
			'data-file-id',
			groupedTarget.id,
		);
		const getSingletonBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileBacklinkGroupId(singletonAddition.root.id),
		);
		const setBacklinkBounds = (): {
			folder: FakeElement;
			grouped: FakeElement;
			singleton: FakeElement;
		} => {
			const folder = getFolderBacklink();
			const grouped = getGroupedBacklink();
			const singleton = getSingletonBacklink();

			setClientBounds(folder, 200, 100, 200, 42);
			setClientBounds(grouped, 460, 220, 180, 30);
			setClientBounds(singleton, 720, 340, 200, 42);
			return { folder, grouped, singleton };
		};
		let backlinks = setBacklinkBounds();
		const folderRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderTarget.id,
		);
		const groupedRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			groupedTarget.id,
		);
		const singletonRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			singletonTarget.id,
		);
		const projectRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			project.id,
		);

		performNodeDrop(projectRoot, 300, 121);
		assert.ok(graphView.state.getState().nodePositions[project.id]);
		assert.strictEqual(backlinks.folder.hasClass('is-reattach-target'), false);
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			initialNavigatorRootNames,
		);

		performNodeDrop(folderRoot, 550, 235);
		assert.ok(findDescendantByClass(folderRoot, 'graph-root-context-label'));
		assert.ok(graphView.state.getState().nodePositions[folderTarget.id]);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[folderTarget.id],
			true,
		);
		assert.strictEqual(backlinks.grouped.hasClass('is-reattach-target'), false);

		graphView.state.toggleFolder(project.id);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				createFolderBacklinkId(folderAddition.root.id),
			),
			undefined,
		);
		performNodeDrop(folderRoot, 300, 121);
		assert.ok(graphView.state.getState().nodePositions[folderTarget.id]);
		assert.ok(findDescendantByClass(folderRoot, 'graph-root-context-label'));
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			initialNavigatorRootNames,
		);

		graphView.state.toggleFolder(project.id);
		backlinks = setBacklinkBounds();
		beginNodeDrag(folderRoot, 300, 121);
		assert.strictEqual(backlinks.folder.hasClass('is-reattach-target'), true);
		folderRoot.dispatch('pointerup', createPointerEvent(folderRoot, 300, 121));
		assert.strictEqual(backlinks.folder.hasClass('is-reattach-target'), false);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				createFolderBacklinkId(folderAddition.root.id),
			),
			undefined,
		);
		const restoredFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderTarget.id,
		);

		assert.strictEqual(
			findDescendantByClass(restoredFolder, 'graph-root-context-label'),
			undefined,
		);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderChild.id,
		));
		assert.strictEqual(
			graphView.state.getState().nodePositions[folderTarget.id],
			undefined,
		);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[folderTarget.id],
			undefined,
		);
		assert.ok(findDescendantByClass(groupedRoot, 'graph-root-context-label'));
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['reattach', 'file-6.ts', 'index.ts'],
		);

		backlinks.grouped = getGroupedBacklink();
		setClientBounds(backlinks.grouped, 460, 220, 180, 30);
		beginNodeDrag(groupedRoot, 550, 235);
		assert.strictEqual(backlinks.grouped.hasClass('is-reattach-target'), true);
		groupedRoot.dispatch('pointerup', createPointerEvent(groupedRoot, 550, 235));
		const restoredGroupedRow = getDescendantByAttribute(
			getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			),
			'data-file-id',
			groupedTarget.id,
		);

		assert.strictEqual(restoredGroupedRow.hasClass('is-backlink'), false);
		assert.strictEqual(
			findDescendantByClass(restoredGroupedRow, 'graph-root-context-label'),
			undefined,
		);
		assert.strictEqual(
			graphView.state.getState().nodePositions[groupedTarget.id],
			undefined,
		);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[groupedTarget.id],
			undefined,
		);
		assert.ok(findDescendantByClass(singletonRoot, 'graph-root-context-label'));
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['reattach', 'index.ts'],
		);

		backlinks.singleton = getSingletonBacklink();
		setClientBounds(backlinks.singleton, 720, 340, 200, 42);
		beginNodeDrag(singletonRoot, 820, 361);
		assert.strictEqual(backlinks.singleton.hasClass('is-reattach-target'), true);
		singletonRoot.dispatch(
			'pointerup',
			createPointerEvent(singletonRoot, 820, 361),
		);
		const restoredSingleton = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			singletonTarget.id,
		);

		assert.strictEqual(restoredSingleton.hasClass('is-backlink'), false);
		assert.strictEqual(
			findDescendantByClass(restoredSingleton, 'graph-root-context-label'),
			undefined,
		);
		const finalState = graphView.state.getState();

		assert.strictEqual(finalState.nodePositions[folderTarget.id], undefined);
		assert.strictEqual(finalState.nodePositions[groupedTarget.id], undefined);
		assert.strictEqual(finalState.nodePositions[singletonTarget.id], undefined);
		assert.deepStrictEqual(finalState.detachedRootNodeIds, {});
		assert.deepStrictEqual(getNavigatorRootNames(root), ['reattach']);
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		assert.deepStrictEqual(
			finalState.nodePositions[positionedSibling.id],
			siblingPosition,
		);
		assert.ok(finalState.nodePositions[project.id]);
		assert.deepStrictEqual(finalState.openedFolders, initialOpenedFolders);
		assert.deepStrictEqual(finalState.fileGroupPages, initialFileGroupPages);
		assert.deepStrictEqual(finalState.camera, initialCamera);
		graphView.dispose();
	});

	test('File Detach Drop은 Root/Backlink 승격 후 Navigator 목록에 즉시 추가된다', () => {
		const childFolder = {
			kind: 'folder' as const,
			id: 'folder:detach-child',
			name: 'detach-child',
			status: 'loaded' as const,
			children: [],
		};
		const childFile = {
			kind: 'file' as const,
			id: 'file:detach-child/index.ts',
			name: 'index.ts',
		};
		const rootFolder = {
			kind: 'folder' as const,
			id: 'folder:detach-root',
			name: 'detach-root',
			status: 'loaded' as const,
			children: [childFolder, childFile],
		};
		const rootFile = {
			kind: 'file' as const,
			id: 'file:detach-root.ts',
			name: 'detach-root.ts',
		};
		const graph: Graph = {
			roots: [
				{ id: 'root:folder', nodeId: rootFolder.id },
				{ id: 'root:file', nodeId: rootFile.id },
			],
			rootNodes: {
				[rootFolder.id]: rootFolder,
				[rootFile.id]: rootFile,
			},
		};
		const detachDrops: Array<{
			readonly nodeId: string;
			readonly clientX: number;
			readonly clientY: number;
		}> = [];
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 0, y: 0, scale: 4 },
				nodePositions: {},
				openedFolders: { [rootFolder.id]: true },
			},
			graph,
			{ onDetachDrop: (request) => detachDrops.push(request) },
		);
		const rootListButton = getDescendantByClass(
			root,
			'graph-navigator-action-button',
		);
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapNodeLayer = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-node-layer',
		);

		const initialMinimapFile = getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			childFile.id,
		);
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['detach-root/', 'detach-root.ts'],
		);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'false');
		const rootFolderNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootFolder.id,
		);
		const childFolderNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childFolder.id,
		);
		const childFileNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childFile.id,
		);
		const rootFileNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootFile.id,
		);

		assert.strictEqual(
			findDescendantByClass(rootFolderNode, 'graph-detach-handle'),
			undefined,
		);
		assert.ok(findDescendantByClass(childFolderNode, 'graph-detach-handle'));
		assert.ok(findDescendantByClass(childFileNode, 'graph-detach-handle'));
		assert.strictEqual(
			findDescendantByClass(rootFileNode, 'graph-detach-handle'),
			undefined,
		);

		const handle = getDescendantByClass(childFileNode, 'graph-detach-handle');

		handle.dispatch('pointerdown', createPointerEvent(handle, 20, 30));
		handle.dispatch('pointermove', createPointerEvent(handle, 1_000, 800));
		handle.dispatch('pointerup', createPointerEvent(handle, 4_000, 3_000));
		assert.deepStrictEqual(detachDrops, [{
			nodeId: childFile.id,
			clientX: 4_000,
			clientY: 3_000,
		}]);
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[childFile.id]: { x: 1_000, y: 750 },
		});
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[childFile.id]: true,
		});
		assert.strictEqual(
			findDescendantByClass(childFileNode, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(
			childFileNode.style.transform,
			'translate(1000px, 750px)',
		);
		const backlinkGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileBacklinkGroupId(createPromotedGraphRootId(childFile.id)),
		);

		assert.strictEqual(backlinkGroup.hasClass('is-backlink'), true);
		assert.strictEqual(
			backlinkGroup.getAttribute('data-target-root-id'),
			createPromotedGraphRootId(childFile.id),
		);
		assert.strictEqual(
			findDescendantByClass(backlinkGroup, 'graph-detach-handle'),
			undefined,
		);
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['detach-root/', 'detach-root.ts', 'index.ts'],
		);
		assert.deepStrictEqual(getNavigatorRootPaths(root), ['detach-root/']);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(graph.roots.length, 2);
		assert.strictEqual(getDescendantByClass(root, 'graph-navigator-minimap'), minimap);
		assert.notStrictEqual(getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			childFile.id,
		), initialMinimapFile);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		graphView.dispose();
	});

	test('Folder Detach는 Navigator에 추가되고 Focus 후 Reattach 시 즉시 제거된다', () => {
		const promotedFolder = {
			kind: 'folder' as const,
			id: 'folder:src',
			name: 'src',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:src/index.ts',
				name: 'index.ts',
			}],
		};
		const sibling = {
			kind: 'folder' as const,
			id: 'folder:docs',
			name: 'docs',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:promotion',
			name: 'crispy',
			status: 'loaded',
			children: [promotedFolder, sibling],
		};
		const graph = createSingleRootGraph(project, 'root:project');
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const siblingPosition = { x: 700, y: 240 };
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 100, y: 50, scale: 2 },
			nodePositions: { [sibling.id]: siblingPosition },
			openedFolders: {
				[project.id]: true,
				[promotedFolder.id]: true,
			},
			fileGroupPages: { [`${promotedFolder.id}:files`]: 3 },
		}, graph);
		const viewport = root.children[0];
		const rootListButton = getDescendantByClass(
			root,
			'graph-navigator-action-button',
		);
		const rootListPanel = getDescendantByClass(
			root,
			'graph-navigator-root-list-panel',
		);
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapNodeLayer = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapNodeCount = minimapNodeLayer.children.length;
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		rootListButton.dispatch('click', createClickEvent(rootListButton));
		assert.strictEqual(rootListPanel.hidden, false);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['crispy']);

		assert.ok(viewport);
		viewport.boundsLeft = 20;
		viewport.boundsTop = 30;
		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			promotedFolder.id,
		);
		const handle = getDescendantByClass(folder, 'graph-detach-handle');

		handle.dispatch('pointerdown', createPointerEvent(handle, 380, 290));
		handle.dispatch('pointermove', createPointerEvent(handle, 1_000, 800));
		handle.dispatch('pointerup', createPointerEvent(handle, 4_120, 3_080));

		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[promotedFolder.id],
			{ x: 2_000, y: 1_500 },
		);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[promotedFolder.id]: true,
		});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[sibling.id],
			siblingPosition,
		);
		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[project.id]: true,
			[promotedFolder.id]: true,
		});
		assert.deepStrictEqual(graphView.state.getState().fileGroupPages, {
			[`${promotedFolder.id}:files`]: 3,
		});
		assert.strictEqual(
			findDescendantByClass(folder, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(folder.style.transform, 'translate(2000px, 1500px)');
		assert.ok(findDescendantByClass(folder, 'graph-root-context-label'));
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			promotedFolder.children[0].id,
		));
		const targetRootId = createPromotedGraphRootId(promotedFolder.id);
		const backlink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(targetRootId),
		);

		assert.strictEqual(backlink.hasClass('graph-folder-backlink-node'), true);
		assert.strictEqual(backlink.getAttribute('data-target-root-id'), targetRootId);
		assert.strictEqual(backlink.getAttribute('data-target-node-id'), promotedFolder.id);
		assert.ok(getText(backlink).includes('src/'));
		assert.ok(getText(backlink).includes('↗'));
		assert.strictEqual(
			findDescendantByClass(backlink, 'graph-detach-handle'),
			undefined,
		);
		const backlinkPosition = backlink.style.transform;
		assert.deepStrictEqual(getNavigatorRootNames(root), ['crispy', 'src/']);
		assert.deepStrictEqual(getNavigatorRootPaths(root), ['crispy/']);
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		assert.ok(minimapNodeLayer.children.length > initialMinimapNodeCount);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		const focusPoints: Array<{ readonly x: number; readonly y: number }> = [];
		const detachedRootButton = getNavigatorRootButtons(root)[1];

		assert.ok(detachedRootButton);
		graphView.camera.focusOn = (point) => focusPoints.push(point);
		detachedRootButton.dispatch('click', createClickEvent(detachedRootButton));
		assert.deepStrictEqual(focusPoints, [{
			x: 2_000 + GRAPH_FOLDER_NODE_WIDTH / 2,
			y: 1_500 + GRAPH_FOLDER_NODE_HEIGHT / 2,
		}]);

		backlink.dispatch('pointerdown', createPointerEvent(backlink, 100, 100));
		backlink.dispatch('pointermove', createPointerEvent(backlink, 180, 160));
		backlink.dispatch('pointerup', createPointerEvent(backlink, 180, 160));
		backlink.dispatch('click', createClickEvent(backlink));
		assert.strictEqual(backlink.hasPointerCapture(1), false);
		assert.strictEqual(backlink.style.transform, backlinkPosition);
		assert.strictEqual(graphView.state.isFolderOpened(promotedFolder.id), true);
		assert.strictEqual(graph.roots.length, 1);

		setClientBounds(backlink, 200, 100, 200, 42);
		beginNodeDrag(folder, 300, 121);
		assert.strictEqual(backlink.hasClass('is-reattach-target'), true);
		folder.dispatch('pointerup', createPointerEvent(folder, 300, 121));
		assert.deepStrictEqual(getNavigatorRootNames(root), ['crispy']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.strictEqual(getDescendantByClass(root, 'graph-navigator-minimap'), minimap);
		assert.strictEqual(minimapNodeLayer.children.length, initialMinimapNodeCount);
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		const focusCountAfterReattach = focusPoints.length;

		detachedRootButton.dispatch('click', createClickEvent(detachedRootButton));
		assert.strictEqual(focusPoints.length, focusCountAfterReattach);

		graphView.dispose();
	});

	test('초기 Graph Camera 상태를 Store와 World transform에 복원한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 120, y: -45, scale: 1.5 },
				nodePositions: {},
			},
			GRAPH_MOCK,
		);

		assert.deepStrictEqual(graphView.state.getState(), {
			camera: { x: 120, y: -45, scale: 1.5 },
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
		});
		assert.deepStrictEqual(graphView.camera.getState(), {
			x: 120,
			y: -45,
			scale: 1.5,
		});
		assert.strictEqual(
			root.children[0]?.children[0]?.style.transform,
			'translate(120px, -45px) scale(1.5)',
		);
		const overlayLayer = root.children[0]?.children[1];
		assert.strictEqual(overlayLayer?.className, 'graph-overlay-layer');
		assert.strictEqual(
			getDescendantByClass(root, 'graph-navigator-coordinate').textContent,
			'(120, -45)',
		);
		assert.strictEqual(
			getDescendantByClass(root, 'graph-navigator-scale').textContent,
			'150%',
		);

		graphView.dispose();
		assert.strictEqual(root.children.length, 0);
	});

	test('Project Root와 Folder가 같은 Open/Close interaction으로 subtree를 제어한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const folderId = 'folder:app';
		const childId = 'folder:app/src';
		const rootEdgeId = `${GRAPH_MOCK_PROJECT.id}->${folderId}`;
		const edgeId = `${folderId}->${childId}`;
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		const project = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);

		assert.strictEqual(project.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(project.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', folderId),
			undefined,
		);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-edge-id', rootEdgeId),
			undefined,
		);

		project.dispatch('click', createClickEvent(project));

		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[GRAPH_MOCK_PROJECT.id]: true,
		});
		assert.strictEqual(
			getDescendantByAttribute(root, 'data-graph-node-id', GRAPH_MOCK_PROJECT.id),
			project,
		);
		assert.strictEqual(project.getAttribute('data-folder-icon'), 'folder-open.svg');
		assert.strictEqual(project.getAttribute('aria-expanded'), 'true');
		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderId,
		);
		const folderIcon = getDescendantByClass(folder, 'graph-folder-icon');

		assert.strictEqual(folder.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(folder.getAttribute('aria-expanded'), 'false');
		assert.ok(findDescendantByAttribute(root, 'data-graph-edge-id', rootEdgeId));

		folder.dispatch('click', createClickEvent(folder));

		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[GRAPH_MOCK_PROJECT.id]: true,
			[folderId]: true,
		});
		assert.strictEqual(
			getDescendantByAttribute(root, 'data-graph-node-id', folderId),
			folder,
		);
		assert.strictEqual(
			getDescendantByClass(folder, 'graph-folder-icon'),
			folderIcon,
		);
		assert.strictEqual(
			folder.getAttribute('data-folder-icon'),
			'folder-open.svg',
		);
		assert.strictEqual(folder.getAttribute('aria-expanded'), 'true');
		assert.ok(findDescendantByAttribute(root, 'data-graph-node-id', childId));
		assert.ok(findDescendantByAttribute(root, 'data-graph-edge-id', edgeId));

		folder.dispatch('click', createClickEvent(folder));

		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[GRAPH_MOCK_PROJECT.id]: true,
		});
		assert.strictEqual(
			getDescendantByAttribute(root, 'data-graph-node-id', folderId),
			folder,
		);
		assert.strictEqual(folder.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(folder.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', childId),
			undefined,
		);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-edge-id', edgeId),
			undefined,
		);

		project.dispatch('click', createClickEvent(project));
		assert.deepStrictEqual(graphView.state.getState().openedFolders, {});
		assert.strictEqual(project.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(project.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', folderId),
			undefined,
		);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-edge-id', rootEdgeId),
			undefined,
		);
		graphView.dispose();
	});

	test('복원된 File Group page를 최초 Layout 높이와 Renderer contents에 반영한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const fileGroupId = createFileGroupId(
			'folder:pagination-samples/seventeen-files',
		);
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:pagination-samples': true,
				'folder:pagination-samples/seventeen-files': true,
			},
		}, GRAPH_MOCK);
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.strictEqual(fileGroup.style.height, '348px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 10);
		assert.ok(getText(fileGroup).includes('+ 7개 더보기'));
		assert.strictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-collapse').length,
			1,
		);

		graphView.dispose();
	});

	test('더보기와 접기가 File Group size, sibling 위치와 Edge를 함께 Reflow한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const parentId = 'folder:pagination-samples/seventeen-files';
		const fileGroupId = createFileGroupId(parentId);
		const siblingId = 'folder:pagination-samples/twenty-one-files';
		const edgeId = `${parentId}->${fileGroupId}`;
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 4 },
			nodePositions: {},
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:pagination-samples': true,
				[parentId]: true,
			},
		}, GRAPH_MOCK);
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const sibling = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			siblingId,
		);
		const edge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			edgeId,
		);
		const initialSiblingY = readTranslateY(sibling.style.transform);
		const initialEdgePath = edge.getAttribute('d');
		const more = getDescendantByClass(fileGroup, 'graph-file-more');
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapFileGroup = getDescendantByAttribute(
			getDescendantByClass(minimap, 'graph-navigator-minimap-node-layer'),
			'data-graph-node-id',
			fileGroupId,
		);
		const initialMinimapHeight = minimapFileGroup.getAttribute('height');
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		more.dispatch('click', createClickEvent(more));

		assert.strictEqual(fileGroup.style.height, '348px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 10);
		assert.strictEqual(
			readTranslateY(sibling.style.transform),
			initialSiblingY + 150,
		);
		assert.notStrictEqual(edge.getAttribute('d'), initialEdgePath);
		assert.notStrictEqual(
			getDescendantByAttribute(
				getDescendantByClass(minimap, 'graph-navigator-minimap-node-layer'),
				'data-graph-node-id',
				fileGroupId,
			).getAttribute('height'),
			initialMinimapHeight,
		);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		getDescendantByClass(fileGroup, 'graph-file-more').dispatch(
			'click',
			createClickEvent(getDescendantByClass(fileGroup, 'graph-file-more')),
		);
		assert.strictEqual(fileGroup.style.height, '498px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 15);
		assert.strictEqual(
			readTranslateY(sibling.style.transform),
			initialSiblingY + 300,
		);

		const collapse = getDescendantByClass(fileGroup, 'graph-file-collapse');

		collapse.dispatch('click', createClickEvent(collapse));

		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		assert.strictEqual(readTranslateY(sibling.style.transform), initialSiblingY);
		assert.strictEqual(edge.getAttribute('d'), initialEdgePath);
		assert.ok(getText(fileGroup).includes('+ 12개 더보기'));
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		graphView.dispose();
		graphView.state.showMoreFiles(fileGroupId);
		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 0);
	});

	test('Layout 입력 변경만 Reflow하고 Camera와 Node 위치 변경은 건너뛴다', () => {
		const state = createGraphState();
		let createLayoutCalls = 0;
		const rendererLayouts: ReturnType<typeof createGraphLayout>[] = [];
		const navigatorLayouts: ReturnType<typeof createGraphLayout>[] = [];
		const unsubscribe = initializeGraphLayoutReflow(
			state,
			{
				applyLayout: (layout) => rendererLayouts.push(layout),
			},
			{
				setLayout: (layout) => navigatorLayouts.push(layout),
			},
			(snapshot) => {
				createLayoutCalls += 1;
				return createGraphLayout(createSingleRootGraph(GRAPH_MOCK_PROJECT), {
					fileGroupPages: snapshot.fileGroupPages,
					openedFolders: snapshot.openedFolders,
				});
			},
		);

		state.setState({
			camera: { x: 80, y: -30, scale: 1.5 },
			nodePositions: {},
		});
		state.setState({
			camera: { x: 80, y: -30, scale: 1.5 },
			nodePositions: { 'folder:app': { x: 700, y: 250 } },
		});
		assert.strictEqual(createLayoutCalls, 0);
		assert.strictEqual(rendererLayouts.length, 0);
		assert.strictEqual(navigatorLayouts.length, 0);

		state.toggleFolder('folder:app');
		assert.strictEqual(createLayoutCalls, 1);
		assert.strictEqual(rendererLayouts.length, 1);
		assert.strictEqual(navigatorLayouts.length, 1);
		assert.strictEqual(rendererLayouts[0], navigatorLayouts[0]);

		state.showMoreFiles(createFileGroupId('folder:app/src'));
		assert.strictEqual(createLayoutCalls, 2);
		assert.strictEqual(rendererLayouts.length, 2);
		assert.strictEqual(navigatorLayouts.length, 2);
		assert.strictEqual(rendererLayouts[1], navigatorLayouts[1]);

		unsubscribe();
		state.showMoreFiles(createFileGroupId('folder:app/src'));
		state.toggleFolder('folder:app');
		assert.strictEqual(createLayoutCalls, 2);
		assert.strictEqual(rendererLayouts.length, 2);
		assert.strictEqual(navigatorLayouts.length, 2);
	});
});

type GraphEventListener = (event: Event) => void;

class FakeDocument {
	createElement(_tagName?: string): FakeElement {
		return new FakeElement(this);
	}

	createElementNS(_namespace?: string, _qualifiedName?: string): FakeElement {
		return new FakeElement(this);
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly style = {
		transform: '',
		backgroundPosition: '',
		backgroundSize: '',
		width: '',
		height: '',
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
	hidden = false;
	textContent = '';
	type = '';
	clientWidth = 1000;
	clientHeight = 800;
	boundsLeft = 0;
	boundsTop = 0;
	private readonly classNames = new Set<string>();
	private readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(readonly ownerDocument: FakeDocument) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	append(...children: FakeElement[]): void {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}

	replaceChildren(...children: FakeElement[]): void {
		for (const child of this.children) {
			child.parent = undefined;
		}
		this.children.length = 0;
		this.append(...children);
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

	dispatch(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
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

function getDescendantsByClass(
	element: FakeElement,
	className: string,
): FakeElement[] {
	return element.children.flatMap((child) => [
		...(child.hasClass(className) ? [child] : []),
		...getDescendantsByClass(child, className),
	]);
}

function getNavigatorRootNames(root: FakeElement): string[] {
	const rootList = getDescendantByClass(root, 'graph-navigator-root-list');

	return rootList.children.map((item) => (
		getDescendantByClass(item, 'graph-navigator-root-name').textContent
	));
}

function getNavigatorRootPaths(root: FakeElement): string[] {
	return getDescendantsByClass(root, 'graph-navigator-root-path')
		.map((path) => path.textContent);
}

function getNavigatorRootButtons(root: FakeElement): FakeElement[] {
	const rootList = getDescendantByClass(root, 'graph-navigator-root-list');

	return rootList.children.map((item) => (
		getDescendantByClass(item, 'graph-navigator-root-button')
	));
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

function readMinimapViewportAttributes(
	indicator: FakeElement,
): Record<string, string | null> {
	return {
		x: indicator.getAttribute('x'),
		y: indicator.getAttribute('y'),
		width: indicator.getAttribute('width'),
		height: indicator.getAttribute('height'),
		visibility: indicator.getAttribute('visibility'),
	};
}

function createClickEvent(
	target: FakeElement,
): MouseEvent & { readonly propagationStopped: boolean } {
	let propagationStopped = false;

	return {
		target: target.asHtmlElement(),
		preventDefault: () => undefined,
		stopPropagation: () => {
			propagationStopped = true;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as unknown as MouseEvent & { readonly propagationStopped: boolean };
}

function createPointerEvent(
	target: FakeElement,
	clientX: number,
	clientY: number,
): PointerEvent {
	let propagationStopped = false;

	return {
		isPrimary: true,
		button: 0,
		pointerId: 1,
		clientX,
		clientY,
		target: target.asHtmlElement(),
		preventDefault: () => undefined,
		stopPropagation: () => {
			propagationStopped = true;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as unknown as PointerEvent;
}

function setClientBounds(
	element: FakeElement,
	left: number,
	top: number,
	width: number,
	height: number,
): void {
	element.boundsLeft = left;
	element.boundsTop = top;
	element.clientWidth = width;
	element.clientHeight = height;
}

function assertPointAlmostEqual(
	actual: { readonly x: number; readonly y: number },
	expected: { readonly x: number; readonly y: number },
): void {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
}

function beginNodeDrag(
	node: FakeElement,
	clientX: number,
	clientY: number,
): void {
	node.dispatch('pointerdown', createPointerEvent(node, 0, 0));
	node.dispatch('pointermove', createPointerEvent(node, clientX, clientY));
}

function performNodeDrop(
	node: FakeElement,
	clientX: number,
	clientY: number,
): void {
	beginNodeDrag(node, clientX, clientY);
	node.dispatch('pointerup', createPointerEvent(node, clientX, clientY));
}

function readTranslateY(transform: string): number {
	const match = /translate\([^,]+, ([^)]+)px\)/.exec(transform);

	assert.ok(match?.[1]);
	return Number(match[1]);
}

function getText(element: FakeElement): string {
	return [element.textContent, ...element.children.map(getText)].join(' ');
}
