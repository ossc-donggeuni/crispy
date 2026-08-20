import * as assert from 'assert';
import {
	createFileGroupId,
	createGraphLayout,
} from '../../webview/graph/graphLayout';
import {
	GRAPH_MOCK,
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
	focusGraphRoot,
	initializeGraphLayoutReflow,
	initializeGraphView,
} from '../../webview/graph/graphView';

suite('Graph View', () => {
	test('초기 Graph Root를 Navigator 표시 데이터와 같은 순서로 Panel에 연결한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		const rootList = getDescendantByClass(
			root,
			'graph-navigator-root-list',
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

	test('Promoted Folder/grouped/singleton Root는 자신의 Backlink Drop에서만 상태를 보존해 복원된다', () => {
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
			},
			singletonAddition.graph,
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

		performNodeDrop(folderRoot, 550, 235);
		assert.ok(findDescendantByClass(folderRoot, 'graph-root-context-label'));
		assert.ok(graphView.state.getState().nodePositions[folderTarget.id]);
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
		assert.ok(findDescendantByClass(groupedRoot, 'graph-root-context-label'));

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
		assert.ok(findDescendantByClass(singletonRoot, 'graph-root-context-label'));

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

	test('File Detach Drop을 Root/Backlink로 승격하고 기존 Root를 Detach 대상에서 제외한다', () => {
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
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				openedFolders: { [rootFolder.id]: true },
			},
			graph,
			{ onDetachDrop: (request) => detachDrops.push(request) },
		);
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
		handle.dispatch('pointermove', createPointerEvent(handle, 40, 50));
		handle.dispatch('pointerup', createPointerEvent(handle, 64, 72));
		assert.deepStrictEqual(detachDrops, [{
			nodeId: childFile.id,
			clientX: 64,
			clientY: 72,
		}]);
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[childFile.id]: { x: 64, y: 72 },
		});
		assert.strictEqual(
			findDescendantByClass(childFileNode, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(
			childFileNode.style.transform,
			'translate(64px, 72px)',
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
		assert.strictEqual(graph.roots.length, 2);

		graphView.dispose();
	});

	test('Folder Detach 좌표를 viewport-local에서 world로 변환하고 상태를 유지한 채 Backlink를 만든다', () => {
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
		handle.dispatch('pointermove', createPointerEvent(handle, 400, 310));
		handle.dispatch('pointerup', createPointerEvent(handle, 420, 330));

		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[promotedFolder.id],
			{ x: 150, y: 125 },
		);
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
		assert.strictEqual(folder.style.transform, 'translate(150px, 125px)');
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

		backlink.dispatch('pointerdown', createPointerEvent(backlink, 100, 100));
		backlink.dispatch('pointermove', createPointerEvent(backlink, 180, 160));
		backlink.dispatch('pointerup', createPointerEvent(backlink, 180, 160));
		backlink.dispatch('click', createClickEvent(backlink));
		assert.strictEqual(backlink.hasPointerCapture(1), false);
		assert.strictEqual(backlink.style.transform, backlinkPosition);
		assert.strictEqual(graphView.state.isFolderOpened(promotedFolder.id), true);
		assert.strictEqual(graph.roots.length, 1);

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
			overlayLayer?.children[0]?.children[0]?.textContent,
			'(120, -45)',
		);
		assert.strictEqual(
			overlayLayer?.children[0]?.children[1]?.children[1]?.textContent,
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
			camera: { x: 0, y: 0, scale: 1 },
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

		graphView.dispose();
		graphView.state.showMoreFiles(fileGroupId);
		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 0);
	});

	test('Layout 입력 변경만 Reflow하고 Camera와 Node 위치 변경은 건너뛴다', () => {
		const state = createGraphState();
		let createLayoutCalls = 0;
		let applyLayoutCalls = 0;
		const unsubscribe = initializeGraphLayoutReflow(
			state,
			{
				applyLayout: () => {
					applyLayoutCalls += 1;
				},
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
		assert.strictEqual(applyLayoutCalls, 0);

		state.toggleFolder('folder:app');
		assert.strictEqual(createLayoutCalls, 1);
		assert.strictEqual(applyLayoutCalls, 1);

		state.showMoreFiles(createFileGroupId('folder:app/src'));
		assert.strictEqual(createLayoutCalls, 2);
		assert.strictEqual(applyLayoutCalls, 2);

		unsubscribe();
		state.showMoreFiles(createFileGroupId('folder:app/src'));
		state.toggleFolder('folder:app');
		assert.strictEqual(createLayoutCalls, 2);
		assert.strictEqual(applyLayoutCalls, 2);
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
