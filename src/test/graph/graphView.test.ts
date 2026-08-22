import * as assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
	createFileGroupId,
	createGraphLayoutNodeId,
	createGraphLayout,
	getGraphRootLayoutNodeId,
	getFileGroupHeight,
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
	applyDetachedGraphRoots,
	createDetachedRootId,
	createFileBacklinkGroupId,
	createFolderBacklinkId,
	createPromotedGraphRootId,
	getDetachedRootOriginId,
} from '../../webview/graph/graphRootPromotion';
import {
	classifyGraphLayoutNodeArrangement,
	rebaseNodePositions,
} from '../../webview/graph/graphLayoutTransition';
import {
	applyGraphLayout,
	focusGraphRoot,
	initializeGraphLayoutReflow,
	initializeGraphView,
} from '../../webview/graph/graphView';
import {
	calculateGraphVisibleArea,
	createFullGraphVisibleArea,
} from '../../webview/graph/graphVisibleArea';

suite('Graph View', () => {
	test('Graph Node와 File Row의 hidden 속성은 flex layout보다 우선한다', () => {
		const graphViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/graph/graphView.css',
		), 'utf8');
		const hiddenRule = graphViewCss.match(
			/\.graph-node\[hidden\],\s*\.graph-file-item\[hidden\]\s*\{[^}]*\}/,
		);

		assert.ok(hiddenRule);
		assert.match(hiddenRule[0], /display:\s*none;/);
	});

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
		const detachedRootId = createPromotedGraphRootId(detachedFolder.id);
		const detachedRootNodeId = createGraphLayoutNodeId(
			detachedRootId,
			detachedFolder.id,
		);
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
			[detachedRootId]: true,
			'folder:temporarily-missing': true,
		});
		const restoredRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedRootNodeId,
		);

		assert.strictEqual(restoredRoot.style.transform, 'translate(840px, 360px)');
		assert.ok(findDescendantByClass(restoredRoot, 'graph-root-context-label'));
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			createGraphLayoutNodeId(
				detachedRootId,
				detachedFolder.children[0].id,
			),
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
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
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
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			addedFolder.id,
		));
		assert.ok(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			addedFolder.id,
		));
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-edge-id',
				`${updatedProject.id}->${removedFolder.id}`,
			),
			undefined,
		);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			removedFolder.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			removedFolder.id,
		), undefined);
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
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			secondaryProject.id,
		));
		assert.ok(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			secondaryProject.id,
		));
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			addedFolder.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			addedFolder.id,
		), undefined);
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

	test('Workspace Refresh는 File Group 경계와 stale page를 최신 DOM/Layout/Minimap에 적용한다', () => {
		const projectId = 'project:refresh-pagination';
		const fileGroupId = createFileGroupId(projectId);
		const files = Array.from({ length: 6 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:refresh-pagination/${index + 1}.ts`,
			name: `${index + 1}.ts`,
		}));
		const createGraph = (nextFiles: typeof files): Graph => createSingleRootGraph({
			kind: 'project',
			id: projectId,
			name: 'refresh-pagination',
			status: 'loaded',
			children: nextFiles,
		});
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 35, y: -20, scale: 1.25 },
			nodePositions: { [fileGroupId]: { x: 520, y: 240 } },
			fileGroupPages: { [fileGroupId]: 1 },
			openedFolders: { [projectId]: true },
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		}, createGraph(files.slice(0, 4)));
		const initialState = graphView.state.getState();
		const initialCamera = graphView.camera.getState();
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const groupEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${projectId}->${fileGroupId}`,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapGroupHeight = Number(getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		).getAttribute('height'));
		const getRenderedIds = (): Array<string | null> => getDescendantsByClass(
			getDescendantByAttribute(root, 'data-graph-node-id', fileGroupId),
			'graph-file-item',
		).map((row) => row.getAttribute('data-file-id'));
		const assertGroupedFiles = (
			expectedFiles: typeof files,
			hasMore: boolean,
		): void => {
			const currentGroup = getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			);

			assert.strictEqual(currentGroup, fileGroup);
			assert.strictEqual(getDescendantByAttribute(
				root,
				'data-graph-edge-id',
				`${projectId}->${fileGroupId}`,
			), groupEdge);
			assert.deepStrictEqual(
				getRenderedIds(),
				expectedFiles.slice(0, 5).map((file) => file.id),
			);
			assert.strictEqual(
				findDescendantByClass(currentGroup, 'graph-file-more') !== undefined,
				hasMore,
			);
			assert.strictEqual(
				currentGroup.style.height,
				`${getFileGroupHeight(
					Math.min(expectedFiles.length, 5),
					hasMore,
				)}px`,
			);
			assert.ok(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				fileGroupId,
			));
		};

		assertGroupedFiles(files.slice(0, 4), false);
		graphView.updateGraph(createGraph(files.slice(0, 5)));
		assertGroupedFiles(files.slice(0, 5), false);
		assert.ok(Number(getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		).getAttribute('height')) > initialMinimapGroupHeight);

		graphView.updateGraph(createGraph(files));
		assertGroupedFiles(files, true);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);

		const fiveAfterVisibleDelete = files.filter((_, index) => index !== 2);

		graphView.updateGraph(createGraph(fiveAfterVisibleDelete));
		assertGroupedFiles(fiveAfterVisibleDelete, false);
		assert.deepStrictEqual(getRenderedIds(), [
			files[0]?.id,
			files[1]?.id,
			files[3]?.id,
			files[4]?.id,
			files[5]?.id,
		]);

		const fourAfterDelete = fiveAfterVisibleDelete.slice(0, 4);

		graphView.updateGraph(createGraph(fourAfterDelete));
		assertGroupedFiles(fourAfterDelete, false);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(4, false)}px`);
		assert.deepStrictEqual(graphView.state.getState(), initialState);

		graphView.updateGraph(createGraph(files));
		graphView.state.showMoreFiles(fileGroupId);
		assert.strictEqual(graphView.state.getFileGroupPage(fileGroupId), 2);
		const expandedState = graphView.state.getState();

		graphView.updateGraph(createGraph(fourAfterDelete));
		assert.deepStrictEqual(getRenderedIds(), fourAfterDelete.map((file) => file.id));
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(4, false)}px`);
		assert.strictEqual(graphView.state.getFileGroupPage(fileGroupId), 2);

		graphView.updateGraph(createGraph(files.slice(0, 1)));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), undefined);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			files[0]?.id as string,
		));
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		), undefined);

		graphView.updateGraph(createGraph([]));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			files[0]?.id as string,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${projectId}->${files[0]?.id}`,
		), undefined);

		graphView.updateGraph(createGraph(files.slice(5)));
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			files[5]?.id as string,
		));
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			files[5]?.id as string,
		));
		assert.deepStrictEqual(graphView.state.getState(), {
			...expandedState,
			nodePositions: initialState.nodePositions,
		});
		assert.deepStrictEqual(graphView.camera.getState(), initialCamera);
		graphView.dispose();
	});

	test('Workspace Filter로 Graph에서 사라진 Node의 모든 Persistent State를 보존한다', () => {
		const filteredFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-state/generated',
			name: 'generated',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:filter-state/generated/output.js',
				name: 'output.js',
			}],
		};
		const createFilteredGraph = (includeFilteredFolder: boolean): Graph => {
			const project: Project = {
				kind: 'project',
				id: 'project:filter-state',
				name: 'workspace',
				status: 'loaded',
				children: includeFilteredFolder ? [filteredFolder] : [],
			};

			return createSingleRootGraph(project, 'root:filter-state');
		};
		const fileGroupId = createFileGroupId(filteredFolder.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 10, y: 20, scale: 1 },
			nodePositions: {
				[filteredFolder.id]: { x: 320, y: 180 },
			},
			openedFolders: { [filteredFolder.id]: true },
			fileGroupPages: { [fileGroupId]: 2 },
			detachedRootNodeIds: { [filteredFolder.id]: true },
			hiddenNodeIds: { [filteredFolder.id]: true },
			}, createFilteredGraph(true));
		const initialState = graphView.state.getState();
		const detachedRootId = createPromotedGraphRootId(filteredFolder.id);
		const detachedRootNodeId = createGraphLayoutNodeId(
			detachedRootId,
			filteredFolder.id,
		);
		const detachedFileGroupId = createGraphLayoutNodeId(
			detachedRootId,
			fileGroupId,
		);

		graphView.updateGraph(createFilteredGraph(false));

		assert.strictEqual(graphView.state.getState(), initialState);
		assert.deepStrictEqual(initialState.nodePositions, {
			[detachedRootNodeId]: { x: 320, y: 180 },
		});
		assert.deepStrictEqual(initialState.openedFolders, {
			[detachedRootNodeId]: true,
		});
		assert.deepStrictEqual(initialState.fileGroupPages, {
			[detachedFileGroupId]: 2,
		});
		assert.deepStrictEqual(initialState.detachedRootNodeIds, {
			[detachedRootId]: true,
		});
		assert.deepStrictEqual(initialState.hiddenNodeIds, {
			[filteredFolder.id]: true,
		});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			filteredFolder.id,
		), undefined);
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
		const detachedRootNodeId = createGraphLayoutNodeId(
			detachedRootId,
			detachedFolder.id,
		);
		const backlinkId = createFolderBacklinkId(detachedRootId);

		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace']);
		const refreshedWorkspaceGraph = createWorkspaceGraph(true);

		graphView.updateGraph(refreshedWorkspaceGraph);

		const detachedRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedRootNodeId,
		);

		assert.strictEqual(detachedRoot.style.transform, 'translate(900px, 500px)');
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		));
		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace', 'detached/']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedRootId]: true,
			'folder:refresh-missing': true,
		});
		assert.strictEqual(refreshedWorkspaceGraph.roots.length, 1);
		assert.strictEqual(
			refreshedWorkspaceGraph.rootNodes[detachedFolder.id],
			undefined,
		);

		const workspaceGraphWithoutDetachedFolder = createWorkspaceGraph(false);

		graphView.updateGraph(workspaceGraphWithoutDetachedFolder);

		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedRootNodeId,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		), undefined);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedRootId]: true,
			'folder:refresh-missing': true,
		});
		assert.strictEqual(workspaceGraphWithoutDetachedFolder.roots.length, 1);
		graphView.dispose();
	});

	test('Navigator Filter Checkbox는 Graph State 경로로 표시를 변경하고 Workspace Refresh Tree를 갱신한다', () => {
		const filteredFile = {
			kind: 'file' as const,
			id: 'file:filter-panel/filtered.ts',
			name: 'filtered.ts',
		};
		const siblingFile = {
			kind: 'file' as const,
			id: 'file:filter-panel/sibling.ts',
			name: 'sibling.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:filter-panel',
			name: 'filter-panel',
			status: 'loaded',
			children: [filteredFile, siblingFile],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true },
			hiddenNodeIds: {},
		}, createSingleRootGraph(project));
		const initialHiddenNodeIds = graphView.state.getState().hiddenNodeIds;
		let checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		);
		const initialFileRow = getDescendantByAttribute(
			root,
			'data-file-id',
			filteredFile.id,
		);

		assert.strictEqual(checkbox.checked, true);
		assert.strictEqual(initialFileRow.hidden, false);
		checkbox.checked = false;
		checkbox.dispatch('change', createClickEvent(checkbox));

		assert.notStrictEqual(
			graphView.state.getState().hiddenNodeIds,
			initialHiddenNodeIds,
		);
		assert.deepStrictEqual(initialHiddenNodeIds, {});
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {
			[filteredFile.id]: true,
		});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-file-id',
			filteredFile.id,
		), undefined);

		checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		);
		assert.strictEqual(checkbox.checked, false);
		checkbox.checked = true;
		checkbox.dispatch('change', createClickEvent(checkbox));
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {});
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-file-id',
			filteredFile.id,
		).hidden, false);

		checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		);
		checkbox.checked = false;
		checkbox.dispatch('change', createClickEvent(checkbox));
		const newFile = {
			kind: 'file' as const,
			id: 'file:filter-panel/new.ts',
			name: 'new.ts',
		};
		const refreshedProject: Project = {
			...project,
			children: [filteredFile, siblingFile, newFile],
		};

		graphView.updateGraph(createSingleRootGraph(refreshedProject));
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		).checked, false);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			newFile.id,
		).checked, true);

		graphView.updateGraph(createSingleRootGraph({
			...refreshedProject,
			children: [siblingFile, newFile],
		}));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		), undefined);
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {
			[filteredFile.id]: true,
		});
		graphView.dispose();
	});

	test('File Filter Checkbox는 File Group Rows, Footer와 높이를 visibleFiles 기준으로 reflow한다', () => {
		const files = Array.from({ length: 6 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:filter-pagination/${index + 1}.ts`,
			name: `${index + 1}.ts`,
		}));
		const project: Project = {
			kind: 'project',
			id: 'project:filter-pagination',
			name: 'filter-pagination',
			status: 'loaded',
			children: files,
		};
		const graph = createSingleRootGraph(project);
		const fileGroupId = createFileGroupId(project.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [fileGroupId]: { x: 520, y: 240 } },
			fileGroupPages: {},
			openedFolders: { [project.id]: true },
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		}, graph);
		const initialState = graphView.state.getState();
		let fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		let checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			files[2]?.id as string,
		);

		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			files.slice(0, 5).map((file) => file.id),
		);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, true)}px`);

		checkbox.checked = false;
		checkbox.dispatch('change', createClickEvent(checkbox));
		fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			[files[0]?.id, files[1]?.id, files[3]?.id, files[4]?.id, files[5]?.id],
		);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-more'), undefined);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, false)}px`);
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		));
		assert.strictEqual(graphView.state.getState().fileGroupPages, initialState.fileGroupPages);
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[fileGroupId]: { x: 520, y: 240 },
		});
		assert.strictEqual(graphView.state.getState().openedFolders, initialState.openedFolders);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds,
			initialState.detachedRootNodeIds,
		);

		checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			files[2]?.id as string,
		);
		checkbox.checked = true;
		checkbox.dispatch('change', createClickEvent(checkbox));
		fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			files.slice(0, 5).map((file) => file.id),
		);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, true)}px`);
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions,
			initialState.nodePositions,
		);
		assert.strictEqual(project.children.length, 6);
		graphView.dispose();
	});

	test('Workspace Refresh와 기존 File Filter를 함께 적용해 Row, Footer와 Tree를 동기화한다', () => {
		const projectId = 'project:refresh-filter';
		const fileGroupId = createFileGroupId(projectId);
		const createFile = (name: string) => ({
			kind: 'file' as const,
			id: `file:refresh-filter/${name}.ts`,
			name: `${name}.ts`,
		});
		const [a, b, c, d, e, f, g, h, i, j, k] = [
			'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
		].map(createFile);

		assert.ok(a && b && c && d && e && f && g && h && i && j && k);
		const createGraph = (children: readonly typeof a[]): Graph => createSingleRootGraph({
			kind: 'project',
			id: projectId,
			name: 'refresh-filter',
			status: 'loaded',
			children,
		});
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 10, y: 20, scale: 1.5 },
			nodePositions: { [fileGroupId]: { x: 480, y: 220 } },
			fileGroupPages: { [fileGroupId]: 1 },
			openedFolders: { [projectId]: true },
			detachedRootNodeIds: {},
			hiddenNodeIds: {
				[c.id]: true,
				[h.id]: true,
				[k.id]: true,
			},
		}, createGraph([a, b, c, d, e, f]));
		const initialState = graphView.state.getState();
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const assertProjection = (
			expected: readonly typeof a[],
			remaining: number,
		): void => {
			const currentGroup = getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			);
			const more = findDescendantByClass(currentGroup, 'graph-file-more');

			assert.strictEqual(currentGroup, fileGroup);
			assert.deepStrictEqual(
				getDescendantsByClass(currentGroup, 'graph-file-item').map(
					(row) => row.getAttribute('data-file-id'),
				),
				expected.slice(0, 5).map((file) => file.id),
			);
			assert.strictEqual(
				more?.textContent,
				remaining > 0 ? `+ ${remaining}개 더보기` : undefined,
			);
			assert.strictEqual(
				currentGroup.style.height,
				`${getFileGroupHeight(Math.min(expected.length, 5), remaining > 0)}px`,
			);
			assert.ok(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				fileGroupId,
			));
			const currentState = graphView.state.getState();

			assert.deepStrictEqual(currentState.nodePositions, {
				[fileGroupId]: { x: 480, y: 220 },
			});
			assert.strictEqual(currentState.fileGroupPages, initialState.fileGroupPages);
			assert.strictEqual(currentState.openedFolders, initialState.openedFolders);
			assert.strictEqual(
				currentState.detachedRootNodeIds,
				initialState.detachedRootNodeIds,
			);
			assert.strictEqual(currentState.hiddenNodeIds, initialState.hiddenNodeIds);
		};

		assertProjection([a, b, d, e, f], 0);
		graphView.updateGraph(createGraph([a, b, c, e, f]));
		assertProjection([a, b, e, f], 0);

		graphView.updateGraph(createGraph([a, b, c, e, f, g]));
		assertProjection([a, b, e, f, g], 0);

		graphView.updateGraph(createGraph([a, b, c, e, f, g, h]));
		assertProjection([a, b, e, f, g], 0);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			h.id,
		).checked, false);

		graphView.updateGraph(createGraph([a, b, c, e, f, g, h, i]));
		assertProjection([a, b, e, f, g, i], 1);

		graphView.updateGraph(createGraph([a, c, e, f, g, h, i]));
		assertProjection([a, e, f, g, i], 0);

		graphView.updateGraph(createGraph([a, b, c, e, f, g, h]));
		assertProjection([a, b, e, f, g], 0);

		graphView.updateGraph(createGraph([a, b, e, f, g, h]));
		assertProjection([a, b, e, f, g], 0);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			c.id,
		), undefined);
		assert.deepStrictEqual(initialState.hiddenNodeIds, {
			[c.id]: true,
			[h.id]: true,
			[k.id]: true,
		});

		graphView.updateGraph(createGraph([h]));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			h.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			h.id,
		), undefined);

		graphView.updateGraph(createGraph([h, j]));
		const restoredGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.notStrictEqual(restoredGroup, fileGroup);
		assert.deepStrictEqual(
			getDescendantsByClass(restoredGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			[j.id],
		);
		assert.strictEqual(restoredGroup.style.height, `${getFileGroupHeight(1, false)}px`);

		graphView.updateGraph(createGraph([h, j, k]));
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), restoredGroup);
		assert.deepStrictEqual(
			getDescendantsByClass(restoredGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			[j.id],
		);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			k.id,
		).checked, false);
		assert.deepStrictEqual(graphView.state.getState(), initialState);
		graphView.dispose();
	});

	test('Folder Filter를 subtree, Edge와 Minimap에 반영하고 해제 시 기존 상태로 복원한다', () => {
		const hiddenFile = {
			kind: 'file' as const,
			id: 'file:filter-folder/hidden.ts',
			name: 'hidden.ts',
		};
		const visibleFile = {
			kind: 'file' as const,
			id: 'file:filter-folder/visible.ts',
			name: 'visible.ts',
		};
		const descendantFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-folder/descendant',
			name: 'descendant',
			status: 'loaded' as const,
			children: [],
		};
		const hiddenFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-folder',
			name: 'filter-folder',
			status: 'loaded' as const,
			children: [descendantFolder, hiddenFile, visibleFile],
		};
		const siblingFile = {
			kind: 'file' as const,
			id: 'file:filter-sibling.ts',
			name: 'filter-sibling.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:filter-folder',
			name: 'filter-folder',
			status: 'loaded',
			children: [hiddenFolder, siblingFile],
		};
		const graph = createSingleRootGraph(project);
		const fileGroupId = createFileGroupId(hiddenFolder.id);
		const initialHiddenNodeIds = {
			[project.id]: true as const,
			[hiddenFolder.id]: true as const,
			[hiddenFile.id]: true as const,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {
				[hiddenFolder.id]: { x: 400, y: 180 },
				[siblingFile.id]: { x: 720, y: 260 },
			},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[project.id]: true,
				[hiddenFolder.id]: true,
				[descendantFolder.id]: true,
			},
			detachedRootNodeIds: {},
			hiddenNodeIds: initialHiddenNodeIds,
		}, graph);
		const projectNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			project.id,
		);
		const folderNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			hiddenFolder.id,
		);
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const descendantFolderNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			descendantFolder.id,
		);
		const siblingNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			siblingFile.id,
		);
		const fileRows = getDescendantsByClass(fileGroup, 'graph-file-item');
		const explicitHiddenRow = fileRows.find(
			(row) => row.getAttribute('data-file-id') === hiddenFile.id,
		);
		const inheritedHiddenRow = fileRows.find(
			(row) => row.getAttribute('data-file-id') === visibleFile.id,
		);
		const projectToFolderEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${project.id}->${hiddenFolder.id}`,
		);
		const folderToFilesEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${hiddenFolder.id}->${fileGroupId}`,
		);
		const folderToDescendantEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${hiddenFolder.id}->${descendantFolder.id}`,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);

		assert.strictEqual(explicitHiddenRow, undefined);
		assert.ok(inheritedHiddenRow);
		assert.strictEqual(projectNode.hidden, false);
		assert.strictEqual(folderNode.hidden, true);
		assert.strictEqual(descendantFolderNode.hidden, true);
		assert.strictEqual(fileGroup.hidden, true);
		assert.strictEqual(siblingNode.hidden, false);
		assert.strictEqual(inheritedHiddenRow.hidden, true);
		assert.strictEqual(projectToFolderEdge.getAttribute('visibility'), 'hidden');
		assert.strictEqual(folderToFilesEdge.getAttribute('visibility'), 'hidden');
		assert.strictEqual(
			folderToDescendantEdge.getAttribute('visibility'),
			'hidden',
		);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			hiddenFolder.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			descendantFolder.id,
		), undefined);
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			siblingFile.id,
		));
		assert.deepStrictEqual(
			graphView.state.getState().hiddenNodeIds,
			initialHiddenNodeIds,
		);

		const preservedState = graphView.state.getState();

		graphView.state.setState({
			camera: preservedState.camera,
			nodePositions: preservedState.nodePositions,
			hiddenNodeIds: {
				[project.id]: true,
				[hiddenFile.id]: true,
			},
		});

		assert.strictEqual(projectNode.hidden, false);
		assert.strictEqual(folderNode.hidden, false);
		assert.strictEqual(descendantFolderNode.hidden, false);
		assert.strictEqual(fileGroup.hidden, false);
		assert.strictEqual(inheritedHiddenRow.hidden, false);
		assert.strictEqual(projectToFolderEdge.getAttribute('visibility'), null);
		assert.strictEqual(folderToFilesEdge.getAttribute('visibility'), null);
		assert.strictEqual(folderToDescendantEdge.getAttribute('visibility'), null);
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			hiddenFolder.id,
		));

		const filteredState = graphView.state.getState();

		graphView.state.setState({
			camera: filteredState.camera,
			nodePositions: filteredState.nodePositions,
			hiddenNodeIds: { [project.id]: true },
		});

		const restoredRows = getDescendantsByClass(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), 'graph-file-item');

		assert.deepStrictEqual(
			restoredRows.map((row) => row.getAttribute('data-file-id')),
			[hiddenFile.id, visibleFile.id],
		);
		assert.ok(restoredRows.every((row) => row.hidden === false));
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions,
			preservedState.nodePositions,
		);
		assert.strictEqual(graphView.state.getState().openedFolders, preservedState.openedFolders);
		assert.strictEqual(graphView.state.getState().fileGroupPages, preservedState.fileGroupPages);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds,
			preservedState.detachedRootNodeIds,
		);
		assert.deepStrictEqual(graph.roots, createSingleRootGraph(project).roots);
		graphView.dispose();
	});

	test('Grouped와 standalone File Filter가 presentation과 저장 page 상태를 유지한다', () => {
		const groupedFiles = Array.from({ length: 7 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:filter-group/${index}.ts`,
			name: `${index}.ts`,
		}));
		const standaloneFile = {
			kind: 'file' as const,
			id: 'file:filter-standalone/index.ts',
			name: 'index.ts',
		};
		const groupedProject: Project = {
			kind: 'project',
			id: 'project:filter-group',
			name: 'filter-group',
			status: 'loaded',
			children: groupedFiles,
		};
		const standaloneProject: Project = {
			kind: 'project',
			id: 'project:filter-standalone',
			name: 'filter-standalone',
			status: 'loaded',
			children: [standaloneFile],
		};
		const graph: Graph = {
			roots: [
				{ id: 'root:filter-group', nodeId: groupedProject.id },
				{ id: 'root:filter-standalone', nodeId: standaloneProject.id },
			],
			rootNodes: {
				[groupedProject.id]: groupedProject,
				[standaloneProject.id]: standaloneProject,
			},
		};
		const fileGroupId = createFileGroupId(groupedProject.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[groupedProject.id]: true,
				[standaloneProject.id]: true,
			},
			detachedRootNodeIds: {},
			hiddenNodeIds: Object.fromEntries([
				...groupedFiles.map((file) => [file.id, true]),
				[standaloneFile.id, true],
			]) as Record<string, true>,
		}, graph);
		const groupedNode = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const standaloneNode = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			standaloneFile.id,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialState = graphView.state.getState();

		assert.strictEqual(groupedNode, undefined);
		assert.strictEqual(standaloneNode, undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			standaloneFile.id,
		), undefined);

		graphView.state.setState({
			camera: initialState.camera,
			nodePositions: initialState.nodePositions,
			hiddenNodeIds: {},
		});

		const restoredGroupedNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const restoredRows = getDescendantsByClass(
			restoredGroupedNode,
			'graph-file-item',
		);
		const restoredStandaloneNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			standaloneFile.id,
		);

		assert.strictEqual(restoredRows.length, groupedFiles.length);
		assert.ok(restoredRows.every((row) => row.hidden === false));
		assert.strictEqual(restoredGroupedNode.hidden, false);
		assert.strictEqual(
			restoredGroupedNode.getAttribute('data-file-group-presentation'),
			'grouped',
		);
		assert.strictEqual(
			restoredStandaloneNode.getAttribute('data-file-group-presentation'),
			'standalone',
		);
		assert.strictEqual(graphView.state.getState().fileGroupPages, initialState.fileGroupPages);
		assert.deepStrictEqual(graphView.state.getState().fileGroupPages, {
			[fileGroupId]: 2,
		});
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		));
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			standaloneFile.id,
		));
		graphView.dispose();
	});

	test('Detached Folder/File Root와 Backlink를 Filter 상태만으로 함께 숨기고 복원한다', () => {
		const folderChild = {
			kind: 'file' as const,
			id: 'file:filter-detached-folder/index.ts',
			name: 'index.ts',
		};
		const detachedFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-detached',
			name: 'filter-detached',
			status: 'loaded' as const,
			children: [folderChild],
		};
		const detachedFile = {
			kind: 'file' as const,
			id: 'file:filter-detached.ts',
			name: 'filter-detached.ts',
		};
		const siblingFile = {
			kind: 'file' as const,
			id: 'file:filter-detached-sibling.ts',
			name: 'filter-detached-sibling.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:filter-detached',
			name: 'filter-detached',
			status: 'loaded',
			children: [detachedFolder, detachedFile, siblingFile],
		};
		const graph = createSingleRootGraph(project);
		const folderRootId = createPromotedGraphRootId(detachedFolder.id);
		const fileRootId = createPromotedGraphRootId(detachedFile.id);
		const folderRootNodeId = createGraphLayoutNodeId(
			folderRootId,
			detachedFolder.id,
		);
		const fileRootNodeId = createGraphLayoutNodeId(
			fileRootId,
			detachedFile.id,
		);
		const folderBacklinkId = createFolderBacklinkId(folderRootId);
		const originalFileGroupId = createFileGroupId(project.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {
				[detachedFolder.id]: { x: 760, y: 300 },
				[detachedFile.id]: { x: 980, y: 420 },
			},
			fileGroupPages: { [originalFileGroupId]: 2 },
			openedFolders: {
				[project.id]: true,
				[detachedFolder.id]: true,
			},
			detachedRootNodeIds: {
				[detachedFolder.id]: true,
				[detachedFile.id]: true,
			},
			hiddenNodeIds: {
				[detachedFolder.id]: true,
				[detachedFile.id]: true,
			},
		}, graph);
		const folderRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderRootNodeId,
		);
		const folderBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderBacklinkId,
		);
		const fileRoot = getDescendantsByClass(root, 'graph-file-group-node').find(
			(node) => node.getAttribute('data-graph-node-id') === fileRootNodeId,
		);
		const fileBacklink = getDescendantsByClass(root, 'graph-file-item').find(
			(row) => row.getAttribute('data-file-id') === detachedFile.id,
		);
		const siblingRow = getDescendantsByClass(root, 'graph-file-item').find(
			(row) => row.getAttribute('data-file-id') === siblingFile.id,
		);
		const folderBacklinkEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${project.id}->${folderBacklinkId}`,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialState = graphView.state.getState();

		assert.ok(fileRoot && siblingRow);
		assert.strictEqual(folderRoot.hidden, true);
		assert.strictEqual(folderBacklink.hidden, true);
		assert.strictEqual(fileRoot.hidden, true);
		assert.strictEqual(fileBacklink, undefined);
		assert.strictEqual(siblingRow.hidden, false);
		assert.strictEqual(folderBacklinkEdge.getAttribute('visibility'), 'hidden');
		for (const hiddenLayoutNodeId of [
			detachedFolder.id,
			folderBacklinkId,
			detachedFile.id,
		]) {
			assert.strictEqual(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				hiddenLayoutNodeId,
			), undefined);
		}

		graphView.state.setState({
			camera: initialState.camera,
			nodePositions: initialState.nodePositions,
			hiddenNodeIds: {},
		});

		assert.strictEqual(folderRoot.hidden, false);
		assert.strictEqual(folderBacklink.hidden, false);
		assert.strictEqual(fileRoot.hidden, false);
		const restoredFileBacklink = getDescendantsByClass(root, 'graph-file-item').find(
			(row) => row.getAttribute('data-file-id') === detachedFile.id,
		);

		assert.ok(restoredFileBacklink);
		assert.strictEqual(restoredFileBacklink.hidden, false);
		assert.strictEqual(
			restoredFileBacklink.getAttribute('data-target-root-id'),
			fileRootId,
		);
		assert.strictEqual(folderBacklinkEdge.getAttribute('visibility'), null);
		for (const restoredLayoutNodeId of [
			folderRootNodeId,
			folderBacklinkId,
			fileRootNodeId,
		]) {
			assert.ok(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				restoredLayoutNodeId,
			));
		}
		const detachedGraph = applyDetachedGraphRoots(
			graph,
			initialState.detachedRootNodeIds,
		);
		const expectedNodePositions = rebaseNodePositions(
			createGraphLayout(detachedGraph, {
				fileGroupPages: initialState.fileGroupPages,
				openedFolders: initialState.openedFolders,
				hiddenNodeIds: initialState.hiddenNodeIds,
			}),
			createGraphLayout(detachedGraph, {
				fileGroupPages: initialState.fileGroupPages,
				openedFolders: initialState.openedFolders,
				hiddenNodeIds: {},
			}),
			initialState.nodePositions,
			{
				stationaryRootNodeIds: new Set([
					folderRootNodeId,
					fileRootNodeId,
				]),
			},
		);

		assert.deepStrictEqual(
			graphView.state.getState().nodePositions,
			expectedNodePositions,
		);
		assert.strictEqual(graphView.state.getState().openedFolders, initialState.openedFolders);
		assert.strictEqual(graphView.state.getState().fileGroupPages, initialState.fileGroupPages);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds,
			initialState.detachedRootNodeIds,
		);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[folderRootId]: true,
			[fileRootId]: true,
		});
		assert.strictEqual(graph.roots.length, 1);
		assert.strictEqual(graph.rootNodes[detachedFolder.id], undefined);
		assert.strictEqual(graph.rootNodes[detachedFile.id], undefined);
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

	test('Navigator Root 선택은 저장 위치와 Layout fallback을 Focus하고 Camera scale을 유지한다', () => {
		const savedFolderPosition = { x: 900, y: 520 };
		const initialScale = 1.4;
		let visibleArea = calculateGraphVisibleArea(
			{ width: 1000, height: 800 },
			{ left: 0, top: 0, width: 1000, height: 800 },
			{ left: 528, top: 12, right: 988, bottom: 788, width: 460, height: 776 },
			'right',
			false,
		);
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
			{ resolveVisibleGraphArea: () => visibleArea },
		);
		const layout = createGraphLayout(GRAPH_MOCK);
		const folderGraphRoot = GRAPH_MOCK.roots.find(
			(root) => root.nodeId === GRAPH_MOCK_FOLDER_ROOT.id,
		);
		const fileGraphRoot = GRAPH_MOCK.roots.find(
			(root) => root.nodeId === GRAPH_MOCK_FILE_ROOT.id,
		);

		assert.ok(folderGraphRoot);
		assert.ok(fileGraphRoot);
		const folderRootNodeId = getGraphRootLayoutNodeId(folderGraphRoot);
		const fileRootNodeId = getGraphRootLayoutNodeId(fileGraphRoot);
		const folderLayout = layout.nodes.find(
			(node) => node.id === folderRootNodeId,
		);
		const fileLayout = layout.nodes.find(
			(node) => node.id === fileRootNodeId,
		);
		const fileRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileRootNodeId,
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
			visibleArea.center,
		);

		visibleArea = createFullGraphVisibleArea({
			width: viewport.clientWidth,
			height: viewport.clientHeight,
		});
		graphView.refreshVisibleGraphArea();

		const fileButton = rootButtons[2];

		assert.ok(fileButton);
		fileButton.dispatch('click', createClickEvent(fileButton));
		assert.strictEqual(graphView.camera.getState().scale, initialScale);
		const currentFilePosition = readTranslate(fileRoot.style.transform);
		assertPointAlmostEqual(
			graphView.camera.worldToViewport({
				x: currentFilePosition.x + fileLayout.width / 2,
				y: currentFilePosition.y + fileLayout.height / 2,
			}),
			visibleArea.center,
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
		const folderRootNodeId = getGraphRootLayoutNodeId(folderAddition.root);
		const fileRootNodeId = getGraphRootLayoutNodeId(fileAddition.root);
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [folderRootNodeId]: { x: 700, y: 300 } },
			openedFolders: { [project.id]: true },
		});
		const layout = createGraphLayout(fileAddition.graph, {
			openedFolders: state.getState().openedFolders,
		});
		const folderLayout = layout.nodes.find(
			(node) => node.id === folderRootNodeId,
		);
		const fileLayout = layout.nodes.find((node) => node.id === fileRootNodeId);
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
			{
				nodeId: getGraphRootLayoutNodeId(folderAddition.root),
				backlink: folderBacklink,
			},
			{
				nodeId: getGraphRootLayoutNodeId(groupedAddition.root),
				backlink: groupedBacklink,
			},
			{
				nodeId: getGraphRootLayoutNodeId(singletonAddition.root),
				backlink: singletonBacklink,
			},
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
			getGraphRootLayoutNodeId(folderAddition.root),
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
		const folderRootNodeId = getGraphRootLayoutNodeId(folderAddition.root);
		const groupedRootNodeId = getGraphRootLayoutNodeId(groupedAddition.root);
		const singletonRootNodeId = getGraphRootLayoutNodeId(singletonAddition.root);
		const fileGroupId = createFileGroupId(groupedFolder.id);
		const siblingPosition = { x: 910, y: 440 };
		const initialCamera = { x: 35, y: -15, scale: 1.5 };
		const siblingPositionAfterProjectDrag = {
			x: siblingPosition.x + 300 / initialCamera.scale,
			y: siblingPosition.y + 121 / initialCamera.scale,
		};
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
			folderRootNodeId,
		);
		const groupedRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			groupedRootNodeId,
		);
		const singletonRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			singletonRootNodeId,
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
		assert.ok(graphView.state.getState().nodePositions[folderRootNodeId]);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[folderAddition.root.id],
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
		assert.ok(graphView.state.getState().nodePositions[folderRootNodeId]);
		assert.ok(findDescendantByClass(folderRoot, 'graph-root-context-label'));
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			initialNavigatorRootNames,
		);

		graphView.state.toggleFolder(project.id);
		backlinks = setBacklinkBounds();
		assert.strictEqual(
			graphView.state.getState().nodePositions[folderTarget.id],
			undefined,
		);
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
			graphView.state.getState().nodePositions[folderRootNodeId],
			undefined,
		);
		const restoredFolderPosition = graphView.state.getState()
			.nodePositions[folderTarget.id];

		assert.ok(restoredFolderPosition);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[folderAddition.root.id],
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
			graphView.state.getState().nodePositions[groupedRootNodeId],
			undefined,
		);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[groupedAddition.root.id],
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

		assert.deepStrictEqual(
			finalState.nodePositions[folderTarget.id],
			restoredFolderPosition,
		);
		assert.strictEqual(finalState.nodePositions[groupedTarget.id], undefined);
		assert.strictEqual(finalState.nodePositions[singletonTarget.id], undefined);
		assert.deepStrictEqual(finalState.detachedRootNodeIds, {});
		assert.deepStrictEqual(getNavigatorRootNames(root), ['reattach']);
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		const finalSiblingPosition = finalState.nodePositions[positionedSibling.id];

		assert.ok(finalSiblingPosition);
		assert.strictEqual(finalSiblingPosition.x, siblingPositionAfterProjectDrag.x);
		assert.ok(
			Math.abs(
				finalSiblingPosition.y - siblingPositionAfterProjectDrag.y,
			) < 1e-10,
		);
		assert.ok(finalState.nodePositions[project.id]);
		assert.deepStrictEqual(finalState.openedFolders, initialOpenedFolders);
		assert.deepStrictEqual(finalState.fileGroupPages, initialFileGroupPages);
		assert.deepStrictEqual(finalState.camera, initialCamera);
		graphView.dispose();
	});

	test('이동된 Parent에서 생성한 Folder/File Backlink는 항상 정렬 위치를 상속한다', () => {
		const targetFolder = {
			kind: 'folder' as const,
			id: 'folder:backlink-arrangement/target',
			name: 'target',
			status: 'loaded' as const,
			children: [],
		};
		const siblingFolder = {
			kind: 'folder' as const,
			id: 'folder:backlink-arrangement/sibling',
			name: 'sibling',
			status: 'loaded' as const,
			children: [],
		};
		const targetFile = {
			kind: 'file' as const,
			id: 'file:backlink-arrangement/index.ts',
			name: 'index.ts',
		};
		const movedParent = {
			kind: 'folder' as const,
			id: 'folder:backlink-arrangement',
			name: 'backlink-arrangement',
			status: 'loaded' as const,
			children: [targetFolder, siblingFolder, targetFile],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:backlink-arrangement',
			name: 'backlink-arrangement',
			status: 'loaded',
			children: [movedParent],
		};
		const graph = createSingleRootGraph(project);
		const folderBacklinkId = createFolderBacklinkId(
			createPromotedGraphRootId(targetFolder.id),
		);
		const fileBacklinkId = createFileBacklinkGroupId(
			createPromotedGraphRootId(targetFile.id),
		);
		const openedFolders = {
			[project.id]: true as const,
			[movedParent.id]: true as const,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			nodePositions: {
				[folderBacklinkId]: { x: -900, y: -700 },
				[fileBacklinkId]: { x: -800, y: -600 },
			},
			openedFolders,
		}, graph);
		const nodeLayer = getDescendantByClass(root, 'graph-node-layer');
		const parent = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			movedParent.id,
		);

		performNodeDrop(parent, 1_200, 900);
		const parentPosition = readTranslate(parent.style.transform);
		const folder = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			targetFolder.id,
		);
		const folderHandle = getDescendantByClass(folder, 'graph-detach-handle');

		folderHandle.dispatch('pointerdown', createPointerEvent(folderHandle, 10, 10));
		folderHandle.dispatch('pointermove', createPointerEvent(folderHandle, 30, 30));
		folderHandle.dispatch('pointerup', createPointerEvent(folderHandle, 1_500, 1_000));

		const folderAddition = addGraphRoot(graph, targetFolder.id);

		assert.ok(folderAddition);
		const folderLayout = createGraphLayout(folderAddition.graph, {
			openedFolders,
			unarrangedNodeIds: new Set([movedParent.id, targetFolder.id]),
		});
		const folderParentLayout = folderLayout.nodes.find(
			(node) => node.id === movedParent.id,
		);
		const folderBacklinkLayout = folderLayout.nodes.find(
			(node) => node.id === folderBacklinkId,
		);
		const folderBacklink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			folderBacklinkId,
		);

		assert.ok(folderParentLayout && folderBacklinkLayout);
		assert.deepStrictEqual(readTranslate(folderBacklink.style.transform), {
			x: folderBacklinkLayout.position.x
				+ parentPosition.x
				- folderParentLayout.position.x,
			y: folderBacklinkLayout.position.y
				+ parentPosition.y
				- folderParentLayout.position.y,
		});
		assert.strictEqual(classifyGraphLayoutNodeArrangement(
			folderLayout,
			graphView.state.getState().nodePositions,
		).unarrangedNodeIds.has(folderBacklinkId), false);

		const file = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			targetFile.id,
		);
		const fileHandle = getDescendantByClass(file, 'graph-detach-handle');

		fileHandle.dispatch('pointerdown', createPointerEvent(fileHandle, 10, 10));
		fileHandle.dispatch('pointermove', createPointerEvent(fileHandle, 30, 30));
		fileHandle.dispatch('pointerup', createPointerEvent(fileHandle, 1_800, 1_200));

		const fileAddition = addGraphRoot(folderAddition.graph, targetFile.id);

		assert.ok(fileAddition);
		const fileLayout = createGraphLayout(fileAddition.graph, {
			openedFolders,
			unarrangedNodeIds: new Set([
				movedParent.id,
				targetFolder.id,
				targetFile.id,
			]),
		});
		const fileParentLayout = fileLayout.nodes.find(
			(node) => node.id === movedParent.id,
		);
		const fileBacklinkLayout = fileLayout.nodes.find(
			(node) => node.id === fileBacklinkId,
		);
		const fileBacklink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileBacklinkId,
		);

		assert.ok(fileParentLayout && fileBacklinkLayout);
		assert.deepStrictEqual(readTranslate(fileBacklink.style.transform), {
			x: fileBacklinkLayout.position.x
				+ parentPosition.x
				- fileParentLayout.position.x,
			y: fileBacklinkLayout.position.y
				+ parentPosition.y
				- fileParentLayout.position.y,
		});
		assert.strictEqual(classifyGraphLayoutNodeArrangement(
			fileLayout,
			graphView.state.getState().nodePositions,
		).unarrangedNodeIds.has(fileBacklinkId), false);
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
		const detachedFileRootId = createPromotedGraphRootId(childFile.id);
		const detachedFileRootNodeId = createGraphLayoutNodeId(
			detachedFileRootId,
			childFile.id,
		);

		handle.dispatch('pointerdown', createPointerEvent(handle, 20, 30));
		handle.dispatch('pointermove', createPointerEvent(handle, 1_000, 800));
		handle.dispatch('pointerup', createPointerEvent(handle, 4_000, 3_000));
		assert.deepStrictEqual(detachDrops, [{
			nodeId: childFile.id,
			clientX: 4_000,
			clientY: 3_000,
		}]);
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[detachedFileRootNodeId]: { x: 1_000, y: 750 },
		});
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedFileRootId]: true,
		});
		const detachedFileNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileRootNodeId,
		);

		assert.strictEqual(
			findDescendantByClass(detachedFileNode, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(
			detachedFileNode.style.transform,
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
			findDescendantByClass(backlinkGroup, 'graph-detach-handle') !== undefined,
			true,
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
			detachedFileRootNodeId,
		), initialMinimapFile);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		graphView.dispose();
	});

	test('Backlink 반복 Detach, Instance 독립 이동, 중간 Reattach와 ordinal 재계산을 통합 처리한다', () => {
		const child = {
			kind: 'file' as const,
			id: 'file:multiple-detach/child.ts',
			name: 'child.ts',
		};
		const source = {
			kind: 'folder' as const,
			id: 'folder:multiple-detach',
			name: 'multiple-detach',
			status: 'loaded' as const,
			children: [child],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:multiple-detach',
			name: 'multiple-detach',
			status: 'loaded',
			children: [source],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true, [source.id]: true },
		}, createSingleRootGraph(project));
		const backlinkId = createFolderBacklinkId(source.id);
		const detachFrom = (
			node: FakeElement,
			target: { readonly x: number; readonly y: number },
		): void => {
			const handle = getDescendantByClass(node, 'graph-detach-handle');

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, target.x, target.y),
			);
		};
		const getBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		);
		const rootId = (ordinal: number) => createDetachedRootId(source.id, ordinal);
		const rootNodeId = (ordinal: number) => createGraphLayoutNodeId(
			rootId(ordinal),
			source.id,
		);
		const childNodeId = (ordinal: number) => createGraphLayoutNodeId(
			rootId(ordinal),
			child.id,
		);
		const getDetachedRoot = (ordinal: number) => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootNodeId(ordinal),
		);

		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			source.id,
		), { x: 500, y: 300 });
		detachFrom(getBacklink(), { x: 1_000, y: 500 });
		detachFrom(getBacklink(), { x: 1_500, y: 700 });

		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(2)]: true,
			[rootId(3)]: true,
		});
		for (const ordinal of [1, 2, 3]) {
			assert.ok(getDetachedRoot(ordinal));
			assert.ok(
				findDescendantByAttribute(
					root,
					'data-graph-node-id',
					childNodeId(ordinal),
				),
				`missing ${childNodeId(ordinal)} in ${getDescendantsByClass(
					root,
					'graph-node',
				).map((node) => node.getAttribute('data-graph-node-id')).join(', ')}`,
			);
			assert.strictEqual(
				getDescendantByClass(
					getDetachedRoot(ordinal),
					'graph-detached-root-badge',
				).textContent,
				String(ordinal),
			);
		}
		const secondPositionBeforeMove = readTranslate(
			getDetachedRoot(2).style.transform,
		);
		const thirdPositionBeforeMove = readTranslate(
			getDetachedRoot(3).style.transform,
		);
		const firstChildPositionBeforeMove = readTranslate(
			getDescendantByAttribute(
				root,
				'data-graph-node-id',
				childNodeId(1),
			).style.transform,
		);

		setClientBounds(getBacklink(), -10_000, -10_000, 1, 1);
		performNodeDrop(getDetachedRoot(1), 120, 80);
		assert.deepStrictEqual(
			readTranslate(getDetachedRoot(2).style.transform),
			secondPositionBeforeMove,
		);
		assert.deepStrictEqual(
			readTranslate(getDetachedRoot(3).style.transform),
			thirdPositionBeforeMove,
		);
		assert.deepStrictEqual(
			readTranslate(getDescendantByAttribute(
				root,
				'data-graph-node-id',
				childNodeId(1),
			).style.transform),
			{
				x: firstChildPositionBeforeMove.x + 120,
				y: firstChildPositionBeforeMove.y + 80,
			},
		);

		const reattach = (ordinal: number): void => {
			const backlink = getBacklink();

			setClientBounds(backlink, 200, 100, 200, 42);
			beginNodeDrag(getDetachedRoot(ordinal), 300, 121);
			getDetachedRoot(ordinal).dispatch(
				'pointerup',
				createPointerEvent(getDetachedRoot(ordinal), 300, 121),
			);
		};

		reattach(2);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(3)]: true,
		});
		assert.ok(getBacklink());
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootNodeId(2),
		), undefined);

		detachFrom(getBacklink(), { x: 1_900, y: 900 });
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(3)]: true,
			[rootId(4)]: true,
		});
		assert.strictEqual(
			getDescendantByClass(
				getDetachedRoot(4),
				'graph-detached-root-badge',
			).textContent,
			'4',
		);

		reattach(1);
		reattach(3);
		reattach(4);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		), undefined);
		const restoredSource = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			source.id,
		);

		detachFrom(restoredSource, { x: 700, y: 400 });
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
		});
		assert.strictEqual(
			findDescendantByClass(
				getDetachedRoot(1),
				'graph-detached-root-badge',
			),
			undefined,
		);
		graphView.dispose();
	});

	test('Folder open과 하위 File Detach/Reattach는 시작한 Root Instance에만 적용된다', () => {
		const file = {
			kind: 'file' as const,
			id: 'file:instance-owned/child.ts',
			name: 'child.ts',
		};
		const folder = {
			kind: 'folder' as const,
			id: 'folder:instance-owned',
			name: 'instance-owned',
			status: 'loaded' as const,
			children: [file],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:instance-owned',
			name: 'instance-owned',
			status: 'loaded',
			children: [folder],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true, [folder.id]: true },
		}, createSingleRootGraph(project));
		const detachFrom = (
			node: FakeElement,
			target: { readonly x: number; readonly y: number },
		): void => {
			const handle = getDescendantByClass(node, 'graph-detach-handle');

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, target.x, target.y),
			);
		};
		const parentRootId = (ordinal: number) => createDetachedRootId(
			folder.id,
			ordinal,
		);
		const parentNodeId = (ordinal: number) => createGraphLayoutNodeId(
			parentRootId(ordinal),
			folder.id,
		);
		const fileNodeId = (ordinal: number) => createGraphLayoutNodeId(
			parentRootId(ordinal),
			file.id,
		);
		const getParent = (ordinal: number) => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentNodeId(ordinal),
		);
		const getOriginalBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(folder.id),
		);

		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folder.id,
		), { x: 500, y: 300 });
		detachFrom(getOriginalBacklink(), { x: 900, y: 500 });
		detachFrom(getOriginalBacklink(), { x: 1_300, y: 700 });

		getParent(2).dispatch('click', createClickEvent(getParent(2)));
		assert.ok(findDescendantByAttribute(root, 'data-graph-node-id', fileNodeId(1)));
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', fileNodeId(2)),
			undefined,
		);
		assert.ok(findDescendantByAttribute(root, 'data-graph-node-id', fileNodeId(3)));
		assert.strictEqual(graphView.state.isFolderOpened(parentNodeId(1)), true);
		assert.strictEqual(graphView.state.isFolderOpened(parentNodeId(2)), false);
		assert.strictEqual(graphView.state.isFolderOpened(parentNodeId(3)), true);

		getParent(2).dispatch('click', createClickEvent(getParent(2)));
		const secondFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(2),
		);

		detachFrom(secondFile, { x: 1_700, y: 900 });
		const detachedFileRootId = createDetachedRootId(
			file.id,
			1,
			parentRootId(2),
		);
		const detachedFileNodeId = createGraphLayoutNodeId(
			detachedFileRootId,
			file.id,
		);
		const secondBacklinkId = createGraphLayoutNodeId(
			parentRootId(2),
			createFileBacklinkGroupId(file.id),
		);
		const firstFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(1),
		);
		const thirdFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(3),
		);
		const secondBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondBacklinkId,
		);

		assert.strictEqual(getDetachedRootOriginId(detachedFileRootId), parentRootId(2));
		assert.strictEqual(firstFile.hasClass('is-backlink'), false);
		assert.strictEqual(thirdFile.hasClass('is-backlink'), false);
		assert.strictEqual(secondBacklink.hasClass('is-backlink'), true);
		assert.strictEqual(
			getDescendantsByClass(secondBacklink, 'graph-detach-handle').length,
			1,
		);
		assert.strictEqual(
			findDescendantByClass(secondBacklink, 'graph-backlink-indicator'),
			undefined,
		);
		const detachedFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileNodeId,
		);

		setClientBounds(secondBacklink, 2_000, 2_000, 200, 42);
		setClientBounds(firstFile, 200, 100, 200, 42);
		beginNodeDrag(detachedFile, 300, 121);
		detachedFile.dispatch(
			'pointerup',
			createPointerEvent(detachedFile, 300, 121),
		);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileNodeId,
		));

		setClientBounds(secondBacklink, 200, 100, 200, 42);
		beginNodeDrag(detachedFile, 300, 121);
		detachedFile.dispatch(
			'pointerup',
			createPointerEvent(detachedFile, 300, 121),
		);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileNodeId,
		), undefined);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(2),
		).hasClass('is-backlink'), false);
		assert.strictEqual(firstFile.hasClass('is-backlink'), false);
		assert.strictEqual(thirdFile.hasClass('is-backlink'), false);
		graphView.dispose();
	});

	test('하위 Detached Root가 있는 복구는 Drag를 즉시 취소하고 목록 확인 후 깊은 Root부터 함께 복구한다', async () => {
		const file = {
			kind: 'file' as const,
			id: 'file:reattach-warning/child/leaf.ts',
			name: 'leaf.ts',
		};
		const childFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-warning/child',
			name: 'child',
			status: 'loaded' as const,
			children: [file],
		};
		const parentFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-warning',
			name: 'reattach-warning',
			status: 'loaded' as const,
			children: [childFolder],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:reattach-warning',
			name: 'warning-workspace',
			status: 'loaded',
			children: [parentFolder],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: {
				[project.id]: true,
				[parentFolder.id]: true,
				[childFolder.id]: true,
			},
		}, createSingleRootGraph(project));
		const detachFrom = (
			node: FakeElement,
			target: { readonly x: number; readonly y: number },
		): void => {
			const handle = getDescendantByClass(node, 'graph-detach-handle');

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, target.x, target.y),
			);
		};
		const parentRootId = createDetachedRootId(parentFolder.id, 1);
		const childRootId = createDetachedRootId(
			childFolder.id,
			1,
			parentRootId,
		);
		const fileRootId = createDetachedRootId(file.id, 1, childRootId);
		const parentRootNodeId = createGraphLayoutNodeId(
			parentRootId,
			parentFolder.id,
		);
		const childNodeInParentId = createGraphLayoutNodeId(
			parentRootId,
			childFolder.id,
		);
		const fileNodeInChildId = createGraphLayoutNodeId(childRootId, file.id);

		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentFolder.id,
		), { x: 600, y: 300 });
		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childNodeInParentId,
		), { x: 1_000, y: 500 });
		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeInChildId,
		), { x: 1_400, y: 700 });

		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[parentRootId]: true,
			[childRootId]: true,
			[fileRootId]: true,
		});
		const getParentRoot = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentRootNodeId,
		);
		const parentBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(parentFolder.id),
		);
		const positionBeforeRestore = getParentRoot().style.transform;

		setClientBounds(parentBacklink, 200, 100, 200, 42);
		beginNodeDrag(getParentRoot(), 300, 121);
		assert.notStrictEqual(getParentRoot().style.transform, positionBeforeRestore);
		getParentRoot().dispatch(
			'pointerup',
			createPointerEvent(getParentRoot(), 300, 121),
		);

		assert.strictEqual(getParentRoot().style.transform, positionBeforeRestore);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[parentRootId]: true,
			[childRootId]: true,
			[fileRootId]: true,
		});
		const warning = getDescendantByClass(
			root,
			'graph-reattach-confirm-overlay',
		);
		const warningItems = getDescendantsByClass(
			warning,
			'graph-reattach-confirm-item',
		);

		assert.strictEqual(warning.hidden, false);
		assert.strictEqual(
			getDescendantByClass(warning, 'graph-reattach-confirm-title').textContent,
			'하위 분리 노드가 있습니다',
		);
		assert.deepStrictEqual(
			warningItems.map((item) => item.getAttribute('data-detached-root-id')),
			[childRootId, fileRootId],
		);
		assert.ok(getText(warningItems[0]).includes(childFolder.name));
		assert.ok(getText(warningItems[1]).includes(file.name));

		getDescendantByClass(warning, 'graph-reattach-confirm-cancel').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				warning,
				'graph-reattach-confirm-cancel',
			)),
		);
		await Promise.resolve();
		assert.strictEqual(warning.hidden, true);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[parentRootId]: true,
			[childRootId]: true,
			[fileRootId]: true,
		});

		beginNodeDrag(getParentRoot(), 300, 121);
		getParentRoot().dispatch(
			'pointerup',
			createPointerEvent(getParentRoot(), 300, 121),
		);
		getDescendantByClass(warning, 'graph-reattach-confirm-accept').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				warning,
				'graph-reattach-confirm-accept',
			)),
		);
		await Promise.resolve();

		assert.strictEqual(warning.hidden, true);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentRootNodeId,
		), undefined);
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentFolder.id,
		));
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
		const folderChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			promotedFolder.children[0].id,
		);
		const initialFolderPosition = readTranslate(folder.style.transform);
		const initialChildPosition = readTranslate(folderChild.style.transform);
		const handle = getDescendantByClass(folder, 'graph-detach-handle');
		const targetRootId = createPromotedGraphRootId(promotedFolder.id);
		const detachedFolderNodeId = createGraphLayoutNodeId(
			targetRootId,
			promotedFolder.id,
		);
		const detachedChildNodeId = createGraphLayoutNodeId(
			targetRootId,
			promotedFolder.children[0].id,
		);
		const detachedFileGroupId = createGraphLayoutNodeId(
			targetRootId,
			`${promotedFolder.id}:files`,
		);

		handle.dispatch('pointerdown', createPointerEvent(handle, 380, 290));
		handle.dispatch('pointermove', createPointerEvent(handle, 1_000, 800));
		handle.dispatch('pointerup', createPointerEvent(handle, 4_120, 3_080));

		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[detachedFolderNodeId],
			{ x: 2_000, y: 1_500 },
		);
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[detachedChildNodeId],
			{
				x: 2_000 + initialChildPosition.x - initialFolderPosition.x,
				y: 1_500 + initialChildPosition.y - initialFolderPosition.y,
			},
		);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[targetRootId]: true,
		});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[sibling.id],
			siblingPosition,
		);
		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[project.id]: true,
			[detachedFolderNodeId]: true,
		});
		assert.deepStrictEqual(graphView.state.getState().fileGroupPages, {
			[detachedFileGroupId]: 3,
		});
		const detachedFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolderNodeId,
		);

		assert.strictEqual(
			findDescendantByClass(detachedFolder, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(detachedFolder.style.transform, 'translate(2000px, 1500px)');
		assert.ok(findDescendantByClass(detachedFolder, 'graph-root-context-label'));
		const detachedFolderChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedChildNodeId,
		);
		const backlink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(targetRootId),
		);

		assert.strictEqual(backlink.hasClass('graph-folder-backlink-node'), true);
		assert.strictEqual(backlink.getAttribute('data-target-root-id'), targetRootId);
		assert.strictEqual(backlink.getAttribute('data-target-node-id'), promotedFolder.id);
		assert.ok(getText(backlink).includes('src/'));
		assert.strictEqual(
			getDescendantsByClass(backlink, 'graph-detach-handle').length,
			1,
		);
		assert.strictEqual(
			findDescendantByClass(backlink, 'graph-backlink-indicator'),
			undefined,
		);
		assert.strictEqual(
			findDescendantByClass(backlink, 'graph-detach-handle') !== undefined,
			true,
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
		assert.strictEqual(graphView.state.isFolderOpened(detachedFolderNodeId), true);
		assert.strictEqual(graphView.state.isFolderOpened(promotedFolder.id), false);
		assert.strictEqual(graph.roots.length, 1);

		setClientBounds(backlink, 200, 100, 200, 42);
		const rootPositionBeforeReattachDrag = readTranslate(
			detachedFolder.style.transform,
		);
		const childPositionBeforeReattachDrag = readTranslate(
			detachedFolderChild.style.transform,
		);
		beginNodeDrag(detachedFolder, 300, 121);
		const rootPositionDuringReattachDrag = readTranslate(
			detachedFolder.style.transform,
		);
		const childPositionDuringReattachDrag = readTranslate(
			detachedFolderChild.style.transform,
		);

		assert.deepStrictEqual({
			x: childPositionDuringReattachDrag.x - childPositionBeforeReattachDrag.x,
			y: childPositionDuringReattachDrag.y - childPositionBeforeReattachDrag.y,
		}, {
			x: rootPositionDuringReattachDrag.x - rootPositionBeforeReattachDrag.x,
			y: rootPositionDuringReattachDrag.y - rootPositionBeforeReattachDrag.y,
		});
		assert.strictEqual(backlink.hasClass('is-reattach-target'), true);
		detachedFolder.dispatch(
			'pointerup',
			createPointerEvent(detachedFolder, 300, 121),
		);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['crispy']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[sibling.id]: siblingPosition,
		});
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
			hiddenNodeIds: {},
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
		const projectTransform = project.style.transform;

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
		assert.strictEqual(project.style.transform, projectTransform);
		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderId,
		);
		const folderIcon = getDescendantByClass(folder, 'graph-folder-icon');
		const folderTransform = folder.style.transform;

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
		assert.strictEqual(folder.style.transform, folderTransform);
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
		assert.strictEqual(folder.style.transform, folderTransform);
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
		assert.strictEqual(project.style.transform, projectTransform);
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

	test('접힌 Parent를 이동한 뒤 열면 하위 Node도 같은 Offset으로 나타난다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const folderId = 'folder:app';
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		const collapsedLayout = createGraphLayout(GRAPH_MOCK);
		const projectLayoutNode = collapsedLayout.nodes.find(
			(node) => node.id === GRAPH_MOCK_PROJECT.id,
		);
		const project = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);

		assert.ok(projectLayoutNode);
		performNodeDrop(project, 120, 75);
		const projectPosition = readTranslate(project.style.transform);
		const projectOffset = {
			x: projectPosition.x - projectLayoutNode.position.x,
			y: projectPosition.y - projectLayoutNode.position.y,
		};

		graphView.state.toggleFolder(GRAPH_MOCK_PROJECT.id);

		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderId,
		);
		const folderPosition = readTranslate(folder.style.transform);
		const expandedFolderLayoutNode = createGraphLayout(GRAPH_MOCK, {
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		}).nodes.find((node) => node.id === folderId);

		assert.ok(expandedFolderLayoutNode);
		assert.deepStrictEqual(folderPosition, {
			x: expandedFolderLayoutNode.position.x + projectOffset.x,
			y: expandedFolderLayoutNode.position.y + projectOffset.y,
		});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[folderId],
			folderPosition,
		);

		graphView.dispose();
	});

	test('따로 이동한 Folder를 열어도 정렬된 sibling 위치는 바뀌지 않는다', () => {
		const targetFolder = {
			kind: 'folder' as const,
			id: 'folder:unarranged-target',
			name: 'unarranged-target',
			status: 'loaded' as const,
			children: [
				{
					kind: 'folder' as const,
					id: 'folder:unarranged-target/first',
					name: 'first',
					status: 'loaded' as const,
					children: [],
				},
				{
					kind: 'folder' as const,
					id: 'folder:unarranged-target/second',
					name: 'second',
					status: 'loaded' as const,
					children: [],
				},
			],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:unarranged-open',
			name: 'unarranged-open',
			status: 'loaded',
			children: [
				{
					kind: 'folder',
					id: 'folder:unarranged-above',
					name: 'above',
					status: 'loaded',
					children: [],
				},
				targetFolder,
				{
					kind: 'folder',
					id: 'folder:unarranged-below',
					name: 'below',
					status: 'loaded',
					children: [],
				},
			],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: { [project.id]: true },
		}, createSingleRootGraph(project));
		const above = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-above',
		);
		const target = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			targetFolder.id,
		);
		const below = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-below',
		);
		performNodeDrop(target, 300, 120);
		const movedTargetPosition = readTranslate(target.style.transform);
		const aboveTransform = above.style.transform;
		const belowTransform = below.style.transform;

		graphView.state.toggleFolder(targetFolder.id);

		assert.strictEqual(above.style.transform, aboveTransform);
		assert.strictEqual(below.style.transform, belowTransform);
		assert.deepStrictEqual(
			readTranslate(target.style.transform),
			movedTargetPosition,
		);
		const firstChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-target/first',
		);
		const secondChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-target/second',
		);

		assert.ok(readTranslateY(firstChild.style.transform) < movedTargetPosition.y);
		assert.ok(readTranslateY(secondChild.style.transform) > movedTargetPosition.y);

		const abovePosition = readTranslate(above.style.transform);

		performNodeDrop(
			target,
			abovePosition.x + 8,
			abovePosition.y + 8,
		);
		const arrangedState = graphView.state.getState();

		assert.strictEqual(arrangedState.nodePositions[targetFolder.id], undefined);
		assert.strictEqual(
			arrangedState.nodePositions['folder:unarranged-target/first'],
			undefined,
		);
		assert.strictEqual(
			arrangedState.nodePositions['folder:unarranged-target/second'],
			undefined,
		);
		assert.ok(readTranslateY(above.style.transform) < readTranslateY(
			target.style.transform,
		));
		assert.ok(readTranslateY(target.style.transform) < readTranslateY(
			below.style.transform,
		));
		graphView.dispose();
	});

	test('grouped File을 밖으로 뺐다가 목록에 놓으면 standalone과 grouped 상태를 왕복한다', () => {
		const files = ['a', 'b', 'c'].map((name) => ({
			kind: 'file' as const,
			id: `file:view-arrangement/${name}.ts`,
			name: `${name}.ts`,
		}));
		const project: Project = {
			kind: 'project',
			id: 'project:view-file-arrangement',
			name: 'view-file-arrangement',
			status: 'loaded',
			children: files,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: { [project.id]: true },
		}, createSingleRootGraph(project));
		const nodeLayer = getDescendantByClass(root, 'graph-node-layer');
		const fileGroupId = createFileGroupId(project.id);
		let fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);
		const file = files[1];

		assert.ok(file);
		const row = getDescendantByAttribute(fileGroup, 'data-file-id', file.id);

		row.dispatch('pointerdown', createPointerEvent(row, 10, 10));
		row.dispatch('pointermove', createPointerEvent(row, -500, -500));
		row.dispatch('pointerup', createPointerEvent(row, -500, -500));

		const standalone = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			file.id,
		);

		fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);
		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(item) => item.getAttribute('data-file-id'),
			),
			[files[0]?.id, files[2]?.id],
		);
		assert.ok(graphView.state.getState().nodePositions[file.id]);
		const parent = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			project.id,
		);
		const parentPosition = readTranslate(parent.style.transform);

		performNodeDrop(
			standalone,
			parentPosition.x + 8,
			parentPosition.y + 8,
		);
		assert.strictEqual(
			findDescendantByAttribute(
				nodeLayer,
				'data-graph-node-id',
				file.id,
			),
			standalone,
		);
		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(item) => item.getAttribute('data-file-id'),
			),
			[files[0]?.id, files[2]?.id],
		);
		assert.ok(graphView.state.getState().nodePositions[file.id]);

		const fileGroupPosition = readTranslate(fileGroup.style.transform);

		performNodeDrop(
			standalone,
			fileGroupPosition.x + 8,
			fileGroupPosition.y + 8,
		);
		fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.strictEqual(findDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			file.id,
		), undefined);
		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(item) => item.getAttribute('data-file-id'),
			),
			files.map((entry) => entry.id),
		);
		assert.strictEqual(graphView.state.getState().nodePositions[file.id], undefined);
		graphView.dispose();
	});

	test('이동된 Folder 아래 File Group을 재정렬해도 Parent Offset을 유지한다', () => {
		const childFolder = {
			kind: 'folder' as const,
			id: 'folder:moved-parent/src',
			name: 'src',
			status: 'loaded' as const,
			children: [],
		};
		const files = Array.from({ length: 6 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:moved-parent/file-${index + 1}.ts`,
			name: `file-${index + 1}.ts`,
		}));
		const movedParent = {
			kind: 'folder' as const,
			id: 'folder:moved-parent',
			name: 'moved-parent',
			status: 'loaded' as const,
			children: [childFolder, ...files],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:moved-parent-arrangement',
			name: 'moved-parent-arrangement',
			status: 'loaded',
			children: [movedParent],
		};
		const graph = createSingleRootGraph(project);
		const openedFolders = {
			[project.id]: true as const,
			[movedParent.id]: true as const,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders,
		}, graph);
		const nodeLayer = getDescendantByClass(root, 'graph-node-layer');
		const fileGroupId = createFileGroupId(movedParent.id);
		const parent = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			movedParent.id,
		);
		const child = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			childFolder.id,
		);
		const fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);

		performNodeDrop(parent, 1_200, 900);
		performNodeDrop(fileGroup, -500, -500);
		const childPosition = readTranslate(child.style.transform);

		performNodeDrop(
			fileGroup,
			childPosition.x + 8,
			childPosition.y + 8,
		);

		const finalParentPosition = readTranslate(parent.style.transform);
		const finalFileGroupPosition = readTranslate(fileGroup.style.transform);
		const arrangedLayout = createGraphLayout(graph, {
			openedFolders,
			unarrangedNodeIds: new Set([movedParent.id]),
		});
		const parentLayout = arrangedLayout.nodes.find(
			(node) => node.id === movedParent.id,
		);
		const fileGroupLayout = arrangedLayout.nodes.find(
			(node) => node.id === fileGroupId,
		);

		assert.ok(parentLayout && fileGroupLayout);
		assert.deepStrictEqual(finalFileGroupPosition, {
			x: fileGroupLayout.position.x
				+ finalParentPosition.x
				- parentLayout.position.x,
			y: fileGroupLayout.position.y
				+ finalParentPosition.y
				- parentLayout.position.y,
		});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[fileGroupId],
			finalFileGroupPosition,
		);
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${movedParent.id}->${fileGroupId}`,
		));
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
		const initialFileGroupY = readTranslateY(fileGroup.style.transform);
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
			initialSiblingY + 75,
		);
		assert.strictEqual(
			readTranslateY(fileGroup.style.transform),
			initialFileGroupY - 75,
		);
		assert.strictEqual(edge.getAttribute('d'), initialEdgePath);
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
			initialSiblingY + 150,
		);
		assert.strictEqual(
			readTranslateY(fileGroup.style.transform),
			initialFileGroupY - 150,
		);

		const collapse = getDescendantByClass(fileGroup, 'graph-file-collapse');

		collapse.dispatch('click', createClickEvent(collapse));

		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		assert.strictEqual(readTranslateY(sibling.style.transform), initialSiblingY);
		assert.strictEqual(readTranslateY(fileGroup.style.transform), initialFileGroupY);
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
		let currentLayout = createGraphLayout(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
		);
		const unsubscribe = initializeGraphLayoutReflow(
			state,
			{
				applyLayout: (layout) => rendererLayouts.push(layout),
			},
			{
				setLayout: (layout) => navigatorLayouts.push(layout),
			},
			() => currentLayout,
			(snapshot) => {
				createLayoutCalls += 1;
				currentLayout = createGraphLayout(
					createSingleRootGraph(GRAPH_MOCK_PROJECT), {
					fileGroupPages: snapshot.fileGroupPages,
					openedFolders: snapshot.openedFolders,
				});

				return currentLayout;
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

		const snapshot = state.getState();

		state.setState({
			camera: snapshot.camera,
			nodePositions: snapshot.nodePositions,
			hiddenNodeIds: { 'folder:app/src': true },
		});
		assert.strictEqual(createLayoutCalls, 3);
		assert.strictEqual(rendererLayouts.length, 3);
		assert.strictEqual(navigatorLayouts.length, 3);
		assert.strictEqual(rendererLayouts[2], navigatorLayouts[2]);

		unsubscribe();
		state.showMoreFiles(createFileGroupId('folder:app/src'));
		state.toggleFolder('folder:app');
		assert.strictEqual(createLayoutCalls, 3);
		assert.strictEqual(rendererLayouts.length, 3);
		assert.strictEqual(navigatorLayouts.length, 3);
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
	checked = false;
	hidden = false;
	indeterminate = false;
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
	return readTranslate(transform).y;
}

function readTranslate(transform: string): { x: number; y: number } {
	const match = /^translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)$/.exec(
		transform,
	);

	assert.ok(match?.[1] && match[2]);
	return { x: Number(match[1]), y: Number(match[2]) };
}

function getText(element: FakeElement): string {
	return [element.textContent, ...element.children.map(getText)].join(' ');
}
