import * as assert from 'assert';
import {
	createFileGroupId,
	createGraphLayout as createBaseGraphLayout,
	getFileGroupHeight,
	GRAPH_FILE_GROUP_CONTROL_HEIGHT,
	GRAPH_FILE_GROUP_NODE_WIDTH,
	GRAPH_FILE_GROUP_PADDING,
	GRAPH_FILE_GROUP_ROW_HEIGHT,
	GRAPH_FILE_GROUP_STANDALONE_HEIGHT,
	GRAPH_FOLDER_NODE_HEIGHT,
	GRAPH_FOLDER_NODE_WIDTH,
	type GraphFileGroupNode,
	type GraphFolderBacklinkNode,
	type GraphLayoutNode,
	type GraphLayoutOptions,
} from '../../webview/graph/graphLayout';
import { GRAPH_MOCK_PROJECT } from '../../webview/graph/graphMockData';
import {
	createSingleRootGraph,
	isFile,
	isFolder,
	type Folder,
	type Graph,
	type Project,
} from '../../webview/graph/graphModel';
import {
	addGraphRoot,
	createFileBacklinkGroupId,
	createFolderBacklinkId,
} from '../../webview/graph/graphRootPromotion';
import { FILE_GROUP_PAGE_SIZE } from '../../webview/graph/graphState';

const ALL_OPENED_FOLDERS = openAllFolders(GRAPH_MOCK_PROJECT);
const SECOND_PROJECT: Project = {
	kind: 'project',
	id: 'project:secondary',
	name: 'secondary',
	status: 'loaded',
	children: [
		{
			kind: 'folder',
			id: 'folder:secondary/src',
			name: 'src',
			status: 'loaded',
			children: [
				{
					kind: 'file',
					id: 'file:secondary/src/index.ts',
					name: 'index.ts',
				},
			],
		},
		{
			kind: 'file',
			id: 'file:secondary/package.json',
			name: 'package.json',
		},
	],
};

/** 기존 전체 Layout 검증에서는 모든 Folder를 명시적으로 연다. */
function createGraphLayout(
	project: Project,
	options: GraphLayoutOptions = {},
): ReturnType<typeof createBaseGraphLayout> {
	return createBaseGraphLayout(createSingleRootGraph(project), {
		openedFolders: ALL_OPENED_FOLDERS,
		...options,
	});
}

/** 전체 opened Map에서 지정 Folder만 제거한다. */
function closeFolders(...folderIds: string[]): Record<string, true> {
	const openedFolders = { ...ALL_OPENED_FOLDERS };

	for (const folderId of folderIds) {
		delete openedFolders[folderId];
	}

	return openedFolders;
}

/** Layout 단위 테스트의 전체 Tree를 열기 위한 test-only sparse Map을 만든다. */
function openAllFolders(project: Project): Record<string, true> {
	const openedFolders: Record<string, true> = { [project.id]: true };
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

suite('Graph Model / Layout', () => {
	test('Graph Root 모델이 Project, Folder, File Node를 모두 표현한다', () => {
		const folder = SECOND_PROJECT.children[0];
		const file = SECOND_PROJECT.children[1];

		assert.ok(folder && file);
		const graph: Graph = {
			roots: [
				{ id: 'root:project', nodeId: SECOND_PROJECT.id },
				{ id: 'root:folder', nodeId: folder.id },
				{ id: 'root:file', nodeId: file.id },
			],
			rootNodes: {
				[SECOND_PROJECT.id]: SECOND_PROJECT,
				[folder.id]: folder,
				[file.id]: file,
			},
		};

		assert.strictEqual(graph.rootNodes[SECOND_PROJECT.id]?.kind, 'project');
		assert.strictEqual(graph.rootNodes[folder.id]?.kind, 'folder');
		assert.strictEqual(graph.rootNodes[file.id]?.kind, 'file');
	});

	test('unreadable 상태가 기존 Root, Node ID와 Edge 계층을 변경하지 않는다', () => {
		const loadedFolder: Folder = {
			kind: 'folder',
			id: 'folder:status-check',
			name: 'status-check',
			status: 'loaded',
			children: [],
		};
		const loadedProject: Project = {
			kind: 'project',
			id: 'project:status-check',
			name: 'status-check',
			status: 'loaded',
			children: [loadedFolder],
		};
		const unreadableProject: Project = {
			...loadedProject,
			children: [{ ...loadedFolder, status: 'unreadable' }],
		};
		const loadedGraph = createSingleRootGraph(loadedProject);
		const unreadableGraph = createSingleRootGraph(unreadableProject);
		const layoutOptions = { openedFolders: { [loadedProject.id]: true as const } };
		const loadedLayout = createBaseGraphLayout(loadedGraph, layoutOptions);
		const unreadableLayout = createBaseGraphLayout(unreadableGraph, layoutOptions);
		const loadedFolderNode = loadedLayout.nodes.find(
			(node) => node.id === loadedFolder.id,
		);
		const unreadableFolderNode = unreadableLayout.nodes.find(
			(node) => node.id === loadedFolder.id,
		);
		const selectNodeStructure = (
			{ id, kind, depth, position, width, height }: GraphLayoutNode,
		) => ({ id, kind, depth, position, width, height });

		assert.ok(loadedFolderNode && loadedFolderNode.kind === 'folder');
		assert.ok(unreadableFolderNode && unreadableFolderNode.kind === 'folder');
		assert.strictEqual(loadedFolderNode.status, 'loaded');
		assert.strictEqual(unreadableFolderNode.status, 'unreadable');
		assert.deepStrictEqual(unreadableGraph.roots, loadedGraph.roots);
		assert.deepStrictEqual(
			unreadableLayout.nodes.map(selectNodeStructure),
			loadedLayout.nodes.map(selectNodeStructure),
		);
		assert.deepStrictEqual(unreadableLayout.edges, loadedLayout.edges);
		assert.deepStrictEqual(
			unreadableLayout.rootContexts,
			loadedLayout.rootContexts,
		);
		assert.deepStrictEqual(
			unreadableLayout.rootNodeIds,
			loadedLayout.rootNodeIds,
		);
	});

	test('Context가 있는 Root만 Layout rootContexts로 전달하고 일반 Node는 확장하지 않는다', () => {
		const folder = SECOND_PROJECT.children[0];
		const file = SECOND_PROJECT.children[1];

		assert.ok(folder && file);
		const graph: Graph = {
			roots: [
				{ id: 'root:project', nodeId: SECOND_PROJECT.id },
				{
					id: 'root:folder',
					nodeId: folder.id,
					context: { relativePath: 'packages/demo/src' },
				},
				{
					id: 'root:file',
					nodeId: file.id,
					context: { relativePath: 'src/package.json' },
				},
			],
			rootNodes: {
				[SECOND_PROJECT.id]: SECOND_PROJECT,
				[folder.id]: folder,
				[file.id]: file,
			},
		};
		const layout = createBaseGraphLayout(graph);

		assert.deepStrictEqual(layout.rootContexts, {
			[folder.id]: { relativePath: 'packages/demo/src' },
			[file.id]: { relativePath: 'src/package.json' },
		});
		assert.strictEqual(layout.rootContexts[SECOND_PROJECT.id], undefined);
		assert.ok(layout.nodes.every((node) => !('context' in node)));
	});

	test('File Root를 edge 없는 standalone File Group으로 배치한다', () => {
		const file = SECOND_PROJECT.children.find(isFile);

		assert.ok(file);
		const layout = createBaseGraphLayout(createSingleRootGraph(file));

		assert.strictEqual(layout.nodes.length, 1);
		assert.strictEqual(layout.edges.length, 0);
		assert.deepStrictEqual(layout.nodes[0], {
			kind: 'file-group',
			id: file.id,
			name: file.name,
			depth: 0,
			position: { x: 48, y: 48 },
			width: GRAPH_FILE_GROUP_NODE_WIDTH,
			height: GRAPH_FILE_GROUP_STANDALONE_HEIGHT,
			children: [{
				kind: 'file',
				id: file.id,
				name: file.name,
				presentation: 'normal',
			}],
			presentation: 'standalone',
		});
	});

	test('Folder의 File이 하나이면 File ID 기반 standalone File Group과 edge를 만든다', () => {
		const layout = createBaseGraphLayout(
			createSingleRootGraph(SECOND_PROJECT),
			{
				openedFolders: {
					[SECOND_PROJECT.id]: true,
					'folder:secondary/src': true,
				},
			},
		);
		const fileId = 'file:secondary/src/index.ts';
		const fileNode = layout.nodes.find((node) => node.id === fileId);

		assert.ok(fileNode && fileNode.kind === 'file-group');
		assert.strictEqual(fileNode.presentation, 'standalone');
		assert.strictEqual(fileNode.parentId, 'folder:secondary/src');
		assert.deepStrictEqual(fileNode.children, [{
			kind: 'file',
			id: fileId,
			name: 'index.ts',
			presentation: 'normal',
		}]);
		assert.strictEqual(
			layout.nodes.some(
				(node) => node.id === createFileGroupId('folder:secondary/src'),
			),
			false,
		);
		assert.ok(layout.edges.some((edge) => (
			edge.sourceId === 'folder:secondary/src' && edge.targetId === fileId
		)));
	});

	test('승격된 Folder는 원래 Parent 아래 Backlink로, 자신의 Root에서는 실제 subtree로 배치한다', () => {
		const graph = createSingleRootGraph(SECOND_PROJECT, 'root:project');
		const addition = addGraphRoot(graph, 'folder:secondary/src');

		assert.ok(addition);
		const layout = createBaseGraphLayout(addition.graph, {
			openedFolders: {
				[SECOND_PROJECT.id]: true,
				'folder:secondary/src': true,
			},
		});
		const backlinkId = createFolderBacklinkId(addition.root.id);
		const backlink = layout.nodes.find(
			(node): node is GraphFolderBacklinkNode => node.id === backlinkId,
		);
		const actualFolders = layout.nodes.filter(
			(node) => node.id === 'folder:secondary/src',
		);

		assert.ok(backlink);
		assert.strictEqual(backlink.kind, 'folder-backlink');
		assert.strictEqual(backlink.name, 'src');
		assert.strictEqual(backlink.targetRootId, addition.root.id);
		assert.strictEqual(backlink.targetNodeId, 'folder:secondary/src');
		assert.strictEqual(actualFolders.length, 1);
		assert.ok(layout.nodes.some(
			(node) => node.id === 'file:secondary/src/index.ts',
		));
		assert.ok(layout.edges.some((edge) => (
			edge.sourceId === SECOND_PROJECT.id && edge.targetId === backlinkId
		)));
		assert.ok(!layout.edges.some((edge) => (
			edge.sourceId === backlinkId
				&& edge.targetId === 'folder:secondary/src'
		)));
		assert.strictEqual(
			layout.rootNodeIds.has('folder:secondary/src'),
			true,
		);
	});

	test('승격된 grouped File은 순서와 item 수를 유지한 Backlink Row와 standalone Root를 만든다', () => {
		const project: Project = {
			kind: 'project',
			id: 'project:file-backlink',
			name: 'crispy',
			status: 'loaded',
			children: [
				{ kind: 'file', id: 'file:a', name: 'a.ts' },
				{ kind: 'file', id: 'file:index', name: 'index.ts' },
				{ kind: 'file', id: 'file:b', name: 'b.ts' },
			],
		};
		const addition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			'file:index',
		);

		assert.ok(addition);
		const layout = createBaseGraphLayout(addition.graph, {
			openedFolders: { [project.id]: true },
		});
		const group = layout.nodes.find(
			(node): node is GraphFileGroupNode => (
				node.id === createFileGroupId(project.id)
					&& node.kind === 'file-group'
			),
		);
		const fileRoot = layout.nodes.find((node) => node.id === 'file:index');

		assert.ok(group);
		assert.deepStrictEqual(
			group.children.map((file) => file.id),
			['file:a', 'file:index', 'file:b'],
		);
		assert.deepStrictEqual(
			group.children.map((file) => file.presentation),
			['normal', 'backlink', 'normal'],
		);
		assert.strictEqual(group.children[1]?.targetRootId, addition.root.id);
		assert.ok(fileRoot && fileRoot.kind === 'file-group');
		assert.strictEqual(fileRoot.presentation, 'standalone');
		assert.strictEqual(fileRoot.children[0]?.presentation, 'normal');
		assert.strictEqual(
			layout.nodes.filter((node) => node.id === 'file:index').length,
			1,
		);
	});

	test('Singleton File Backlink Group은 실제 File Root와 충돌하지 않는 ID를 사용한다', () => {
		const graph = createSingleRootGraph(SECOND_PROJECT, 'root:project');
		const addition = addGraphRoot(graph, 'file:secondary/package.json');

		assert.ok(addition);
		const layout = createBaseGraphLayout(addition.graph, {
			openedFolders: { [SECOND_PROJECT.id]: true },
		});
		const backlinkGroupId = createFileBacklinkGroupId(addition.root.id);
		const backlinkGroup = layout.nodes.find(
			(node) => node.id === backlinkGroupId,
		);
		const actualRoot = layout.nodes.find(
			(node) => node.id === 'file:secondary/package.json',
		);

		assert.ok(backlinkGroup && backlinkGroup.kind === 'file-group');
		assert.strictEqual(backlinkGroup.children[0]?.presentation, 'backlink');
		assert.strictEqual(
			backlinkGroup.children[0]?.targetRootId,
			addition.root.id,
		);
		assert.ok(actualRoot && actualRoot.kind === 'file-group');
		assert.strictEqual(actualRoot.children[0]?.presentation, 'normal');
	});

	test('기존 Project 하나를 roots.length === 1인 Graph Layout으로 생성한다', () => {
		const graph = createSingleRootGraph(GRAPH_MOCK_PROJECT);
		const layout = createBaseGraphLayout(graph, {
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		});
		const projectRoots = layout.nodes.filter((node) => node.kind === 'project');

		assert.strictEqual(graph.roots.length, 1);
		assert.deepStrictEqual(graph.roots[0], {
			id: `root:${GRAPH_MOCK_PROJECT.id}`,
			nodeId: GRAPH_MOCK_PROJECT.id,
		});
		assert.strictEqual(projectRoots.length, 1);
		assert.strictEqual(projectRoots[0]?.id, GRAPH_MOCK_PROJECT.id);
		assert.ok(layout.edges.some(
			(edge) => edge.sourceId === GRAPH_MOCK_PROJECT.id,
		));
	});

	test('여러 Root와 각 하위 구조를 독립적으로 하나의 World에 배치한다', () => {
		const graph: Graph = {
			roots: [
				{ id: 'root:primary', nodeId: GRAPH_MOCK_PROJECT.id },
				{ id: 'root:secondary', nodeId: SECOND_PROJECT.id },
			],
			rootNodes: {
				[GRAPH_MOCK_PROJECT.id]: GRAPH_MOCK_PROJECT,
				[SECOND_PROJECT.id]: SECOND_PROJECT,
			},
		};
		const layout = createBaseGraphLayout(graph, {
			openedFolders: {
				...ALL_OPENED_FOLDERS,
				[SECOND_PROJECT.id]: true,
				'folder:secondary/src': true,
			},
		});
		const primaryNodeIds = new Set(
			layout.nodes
				.filter((node) => !node.id.includes('secondary'))
				.map((node) => node.id),
		);
		const secondaryNodeIds = new Set(
			layout.nodes
				.filter((node) => node.id.includes('secondary'))
				.map((node) => node.id),
		);
		const primaryNodes = layout.nodes.filter((node) => primaryNodeIds.has(node.id));
		const secondaryNodes = layout.nodes.filter(
			(node) => secondaryNodeIds.has(node.id),
		);

		assert.ok(primaryNodeIds.has(GRAPH_MOCK_PROJECT.id));
		assert.ok(primaryNodeIds.has('folder:app'));
		assert.ok(secondaryNodeIds.has(SECOND_PROJECT.id));
		assert.ok(secondaryNodeIds.has('folder:secondary/src'));
		assert.ok(secondaryNodeIds.has('file:secondary/package.json'));
		assert.ok(secondaryNodeIds.has('file:secondary/src/index.ts'));
		assert.strictEqual(
			secondaryNodeIds.has(createFileGroupId(SECOND_PROJECT.id)),
			false,
		);
		assert.strictEqual(
			secondaryNodeIds.has(createFileGroupId('folder:secondary/src')),
			false,
		);
		assert.strictEqual(
			layout.edges.every((edge) => (
				(primaryNodeIds.has(edge.sourceId) && primaryNodeIds.has(edge.targetId))
				|| (secondaryNodeIds.has(edge.sourceId) && secondaryNodeIds.has(edge.targetId))
			)),
			true,
		);

		const primaryBottom = Math.max(
			...primaryNodes.map((node) => node.position.y + node.height),
		);
		const secondaryTop = Math.min(
			...secondaryNodes.map((node) => node.position.y),
		);

		assert.ok(secondaryTop > primaryBottom);
		assert.deepStrictEqual(
			createBaseGraphLayout(graph, {
				openedFolders: {
					...ALL_OPENED_FOLDERS,
					[SECOND_PROJECT.id]: true,
					'folder:secondary/src': true,
				},
			}),
			layout,
		);
	});

	test('실제 Graph Mock이 중첩 Folder와 Folder별 여러 File을 포함한다', () => {
		const app = GRAPH_MOCK_PROJECT.children.find(
			(entry) => isFolder(entry) && entry.id === 'folder:app',
		);

		assert.ok(app && isFolder(app));
		const appSrc = app.children.find(
			(entry) => isFolder(entry) && entry.id === 'folder:app/src',
		);
		const appDocs = app.children.find(
			(entry) => isFolder(entry) && entry.id === 'folder:app/docs',
		);
		assert.ok(appSrc && isFolder(appSrc));
		assert.ok(appDocs && isFolder(appDocs));
		assert.ok(app.children.filter(isFile).length > 1);
		assert.ok(appSrc.children.filter(isFile).length > FILE_GROUP_PAGE_SIZE);
		assert.ok(appSrc.children.some(isFolder));
	});

	test('Project Root가 Open 상태가 아니면 children을 제외한 닫힌 Layout을 만든다', () => {
		const graph = createSingleRootGraph(GRAPH_MOCK_PROJECT);
		const closedLayout = createBaseGraphLayout(graph);
		const openedLayout = createBaseGraphLayout(graph, {
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		});
		const closedNodeIds = new Set(closedLayout.nodes.map((node) => node.id));
		const openedNodeIds = new Set(openedLayout.nodes.map((node) => node.id));

		assert.deepStrictEqual([...closedNodeIds], [GRAPH_MOCK_PROJECT.id]);
		assert.deepStrictEqual(closedLayout.edges, []);
		assert.ok(openedNodeIds.has('folder:app'));
		assert.ok(openedNodeIds.has('folder:src'));
		assert.ok(openedNodeIds.has('folder:pagination-samples'));
		assert.ok(openedNodeIds.has(createFileGroupId(GRAPH_MOCK_PROJECT.id)));
		assert.strictEqual(openedNodeIds.has('folder:app/src'), false);
	});

	test('열린 Folder의 직계 children만 포함하고 닫힌 descendant subtree는 제외한다', () => {
		const folderId = 'folder:app';
		const layout = createBaseGraphLayout(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
			{
				openedFolders: {
					[GRAPH_MOCK_PROJECT.id]: true,
					[folderId]: true,
				},
			},
		);
		const nodeIds = new Set(layout.nodes.map((node) => node.id));
		const excludedDescendantIds = [
			'folder:app/src/components',
			createFileGroupId('folder:app/src'),
			createFileGroupId('folder:app/src/components'),
			createFileGroupId('folder:app/docs'),
		];

		assert.ok(nodeIds.has(folderId));
		assert.ok(nodeIds.has('folder:app/src'));
		assert.ok(nodeIds.has('folder:app/docs'));
		assert.ok(nodeIds.has(createFileGroupId(folderId)));
		assert.ok(layout.edges.some(
			(edge) => edge.sourceId === GRAPH_MOCK_PROJECT.id
				&& edge.targetId === folderId,
		));

		for (const excludedId of excludedDescendantIds) {
			assert.strictEqual(nodeIds.has(excludedId), false);
			assert.strictEqual(
				layout.edges.some(
					(edge) => edge.sourceId === excludedId
						|| edge.targetId === excludedId,
				),
				false,
			);
		}

		assert.strictEqual(
			layout.edges.every(
				(edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId),
			),
			true,
		);
	});

	test('Folder를 닫으면 sibling을 남은 구조 기준으로 재배치한다', () => {
		const folderId = 'folder:app';
		const openLayout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const collapsedLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			openedFolders: closeFolders(folderId),
		});
		const folder = GRAPH_MOCK_PROJECT.children.find(
			(entry) => isFolder(entry) && entry.id === folderId,
		);

		assert.ok(folder && isFolder(folder));
		const projectWithEmptyFolder: Project = {
			...GRAPH_MOCK_PROJECT,
			children: GRAPH_MOCK_PROJECT.children.map((entry) => (
				entry === folder ? { ...folder, children: [] } : entry
			)),
		};
		const expectedLayout = createGraphLayout(projectWithEmptyFolder);
		const openSibling = getLayoutNode(openLayout.nodes, 'folder:src');
		const collapsedSibling = getLayoutNode(
			collapsedLayout.nodes,
			'folder:src',
		);

		assert.deepStrictEqual(collapsedLayout, expectedLayout);
		assert.ok(collapsedSibling.position.y < openSibling.position.y);
	});

	test('opened 상태를 제거하면 닫히고 다시 추가하면 전체 Layout을 복원한다', () => {
		const openLayout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const collapsedLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			openedFolders: closeFolders('folder:app'),
		});
		const reopenedLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			openedFolders: ALL_OPENED_FOLDERS,
		});

		assert.notDeepStrictEqual(collapsedLayout, openLayout);
		assert.deepStrictEqual(reopenedLayout, openLayout);
	});

	test('여러 Folder의 opened 상태를 독립적으로 제거한다', () => {
		const firstFolderId = 'folder:app/src';
		const secondFolderId = 'folder:src/webview';
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			openedFolders: closeFolders(firstFolderId, secondFolderId),
		});
		const nodeIds = new Set(layout.nodes.map((node) => node.id));

		assert.ok(nodeIds.has(firstFolderId));
		assert.ok(nodeIds.has(secondFolderId));
		assert.strictEqual(nodeIds.has('folder:app/src/components'), false);
		assert.strictEqual(nodeIds.has(createFileGroupId(firstFolderId)), false);
		assert.strictEqual(nodeIds.has(createFileGroupId(secondFolderId)), false);
		assert.ok(nodeIds.has('folder:app/docs'));
		assert.ok(nodeIds.has(createFileGroupId('folder:app/docs')));
		assert.ok(nodeIds.has(createFileGroupId('folder:src')));
		assert.ok(nodeIds.has('folder:pagination-samples/seventeen-files'));
	});

	test('각 Container의 직접 File을 하나의 안정적인 File Group으로 만든다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const appSrcFiles = getFileGroup(layout.nodes, 'folder:app/src');
		const expectedFiles = [
			'graphView.ts',
			'graphCamera.ts',
			'graphState.ts',
			'graphLayout.ts',
			'graphRenderer.ts',
			'graphNodeDrag.ts',
			'index.ts',
		];

		assert.strictEqual(appSrcFiles.id, createFileGroupId('folder:app/src'));
		assert.strictEqual(appSrcFiles.presentation, 'grouped');
		assert.deepStrictEqual(
			appSrcFiles.children.map((file) => file.name),
			expectedFiles,
		);
		assert.strictEqual(
			appSrcFiles.children.every((file) => file.kind === 'file'),
			true,
		);
		assert.strictEqual(
			layout.nodes.some(
				(node) => appSrcFiles.children.some((file) => file.id === node.id),
			),
			false,
		);
		assert.strictEqual('visibleFiles' in appSrcFiles, false);
		assert.strictEqual('hiddenFileCount' in appSrcFiles, false);
	});

	test('Pagination 확인용 하위 Folder에 17개와 21개 File Group을 만든다', () => {
		const samples = GRAPH_MOCK_PROJECT.children.find(
			(entry) => isFolder(entry) && entry.id === 'folder:pagination-samples',
		);

		assert.ok(samples && isFolder(samples));
		const seventeenFiles = samples.children.find(
			(entry) => isFolder(entry)
				&& entry.id === 'folder:pagination-samples/seventeen-files',
		);
		const twentyOneFiles = samples.children.find(
			(entry) => isFolder(entry)
				&& entry.id === 'folder:pagination-samples/twenty-one-files',
		);

		assert.ok(seventeenFiles && isFolder(seventeenFiles));
		assert.ok(twentyOneFiles && isFolder(twentyOneFiles));
		assert.strictEqual(seventeenFiles.children.filter(isFile).length, 17);
		assert.strictEqual(twentyOneFiles.children.filter(isFile).length, 21);

		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		assert.strictEqual(
			getFileGroup(layout.nodes, seventeenFiles.id).children.length,
			17,
		);
		assert.strictEqual(
			getFileGroup(layout.nodes, twentyOneFiles.id).children.length,
			21,
		);
	});

	test('17개 File Group 높이를 page별 visible File 수에 맞게 계산한다', () => {
		const parentId = 'folder:pagination-samples/seventeen-files';
		const fileGroupId = createFileGroupId(parentId);
		const heights = [1, 2, 3, 4].map((page) => getFileGroup(
			createGraphLayout(GRAPH_MOCK_PROJECT, {
				fileGroupPages: { [fileGroupId]: page },
			}).nodes,
			parentId,
		).height);

		assert.deepStrictEqual(heights, [198, 348, 498, 558]);
		assert.strictEqual(
			getFileGroup(
				createGraphLayout(GRAPH_MOCK_PROJECT, {
					fileGroupPages: { [fileGroupId]: 10 },
				}).nodes,
				parentId,
			).height,
			558,
		);
	});

	test('File 수와 page 상태에 맞는 단일 pagination control 높이를 적용한다', () => {
		const smallParentId = 'folder:app/docs';
		const smallFileGroupId = createFileGroupId(smallParentId);
		const largeParentId = 'folder:pagination-samples/seventeen-files';
		const largeFileGroupId = createFileGroupId(largeParentId);
		const smallLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages: { [smallFileGroupId]: 2 },
		});
		const pageOneLayout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const pageTwoLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages: { [largeFileGroupId]: 2 },
		});
		const pageFourLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages: { [largeFileGroupId]: 4 },
		});

		assert.strictEqual(
			getFileGroup(smallLayout.nodes, smallParentId).height,
			getFileGroupHeight(2, false),
		);
		assert.strictEqual(
			getFileGroup(pageOneLayout.nodes, largeParentId).height,
			getFileGroupHeight(5, true),
		);
		assert.strictEqual(
			getFileGroup(pageTwoLayout.nodes, largeParentId).height,
			getFileGroupHeight(10, true),
		);
		assert.strictEqual(
			getFileGroup(pageFourLayout.nodes, largeParentId).height,
			getFileGroupHeight(17, true),
		);
		assert.strictEqual(
			getFileGroupHeight(10, true) - getFileGroupHeight(10, false),
			GRAPH_FILE_GROUP_CONTROL_HEIGHT,
		);
	});

	test('File Group 높이 증가를 기존 subtree 계산으로 다음 sibling 위치에 반영한다', () => {
		const firstParentId = 'folder:pagination-samples/seventeen-files';
		const firstFileGroupId = createFileGroupId(firstParentId);
		const secondFolderId = 'folder:pagination-samples/twenty-one-files';
		const pageOneLayout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const pageTwoLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages: { [firstFileGroupId]: 2 },
		});
		const pageOneGroup = getFileGroup(pageOneLayout.nodes, firstParentId);
		const pageTwoGroup = getFileGroup(pageTwoLayout.nodes, firstParentId);
		const pageOneSibling = getLayoutNode(pageOneLayout.nodes, secondFolderId);
		const pageTwoSibling = getLayoutNode(pageTwoLayout.nodes, secondFolderId);

		assert.ok(pageTwoGroup.height > pageOneGroup.height);
		assert.ok(pageTwoSibling.position.y > pageOneSibling.position.y);
		assert.strictEqual(
			pageTwoSibling.position.y - pageOneSibling.position.y,
			pageTwoGroup.height - pageOneGroup.height,
		);
	});

	test('여러 File Group의 page별 높이를 독립적으로 계산한다', () => {
		const firstParentId = 'folder:pagination-samples/seventeen-files';
		const secondParentId = 'folder:pagination-samples/twenty-one-files';
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages: {
				[createFileGroupId(firstParentId)]: 2,
				[createFileGroupId(secondParentId)]: 1,
			},
		});

		assert.strictEqual(getFileGroup(layout.nodes, firstParentId).height, 348);
		assert.strictEqual(getFileGroup(layout.nodes, secondParentId).height, 198);
	});

	test('Project/Folder에서 직접 Child Folder와 File Group으로만 Edge를 만든다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const rootTargets = layout.edges
			.filter((edge) => edge.sourceId === GRAPH_MOCK_PROJECT.id)
			.map((edge) => edge.targetId);
		const appTargets = layout.edges
			.filter((edge) => edge.sourceId === 'folder:app')
			.map((edge) => edge.targetId);

		assert.deepStrictEqual(rootTargets, [
			'folder:app',
			'folder:src',
			'folder:pagination-samples',
			createFileGroupId(GRAPH_MOCK_PROJECT.id),
		]);
		assert.deepStrictEqual(appTargets, [
			'folder:app/src',
			'folder:app/docs',
			createFileGroupId('folder:app'),
		]);
		assert.strictEqual(
			layout.edges.some((edge) => edge.targetId.startsWith('file:')),
			false,
		);
	});

	test('동일 입력은 동일 Layout이며 같은 Depth는 같은 X Column에 놓는다', () => {
		const first = createGraphLayout(GRAPH_MOCK_PROJECT);
		const second = createGraphLayout(GRAPH_MOCK_PROJECT);

		assert.deepStrictEqual(second, first);
		const xByDepth = new Map<number, number>();

		for (const node of first.nodes) {
			const columnX = xByDepth.get(node.depth);

			if (columnX === undefined) {
				xByDepth.set(node.depth, node.position.x);
			} else {
				assert.strictEqual(node.position.x, columnX);
			}
		}

		for (const edge of first.edges) {
			const source = first.nodes.find((node) => node.id === edge.sourceId);
			const target = first.nodes.find((node) => node.id === edge.targetId);

			assert.ok(source && target);
			assert.ok(target.position.x > source.position.x);
		}
	});

	test('Folder와 File Group을 동일한 폭과 조밀한 Depth 간격으로 배치한다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const root = layout.nodes.find((node) => node.kind === 'project');
		const folder = layout.nodes.find((node) => node.kind === 'folder');
		const fileGroup = layout.nodes.find((node) => node.kind === 'file-group');

		assert.ok(root && folder && fileGroup);
		assert.strictEqual(GRAPH_FOLDER_NODE_WIDTH, 240);
		assert.strictEqual(GRAPH_FOLDER_NODE_HEIGHT, 42);
		assert.strictEqual(GRAPH_FILE_GROUP_NODE_WIDTH, 240);
		assert.strictEqual(root.width, folder.width);
		assert.strictEqual(folder.width, fileGroup.width);
		assert.strictEqual(folder.position.x - root.position.x, 302);
	});

	test('Filter 표시 상태를 Project를 제외한 Folder subtree와 File presentation에 계산한다', () => {
		const childFolder: Folder = {
			kind: 'folder',
			id: 'folder:filter/parent/child',
			name: 'child',
			status: 'loaded',
			children: [],
		};
		const parentFolder: Folder = {
			kind: 'folder',
			id: 'folder:filter/parent',
			name: 'parent',
			status: 'loaded',
			children: [childFolder],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:filter',
			name: 'filter',
			status: 'loaded',
			children: [
				parentFolder,
				{ kind: 'file', id: 'file:filter/a.ts', name: 'a.ts' },
				{ kind: 'file', id: 'file:filter/b.ts', name: 'b.ts' },
			],
		};
		const hiddenNodeIds = {
			[project.id]: true as const,
			[parentFolder.id]: true as const,
			'file:filter/a.ts': true as const,
		};
		const layout = createBaseGraphLayout(createSingleRootGraph(project), {
			openedFolders: {
				[project.id]: true,
				[parentFolder.id]: true,
				[childFolder.id]: true,
			},
			hiddenNodeIds,
		});
		const projectNode = getLayoutNode(layout.nodes, project.id);
		const parentNode = getLayoutNode(layout.nodes, parentFolder.id);
		const childNode = getLayoutNode(layout.nodes, childFolder.id);
		const fileGroup = getFileGroup(layout.nodes, project.id);
		const hiddenFile = fileGroup.children.find(
			(file) => file.id === 'file:filter/a.ts',
		);
		const visibleFile = fileGroup.children.find(
			(file) => file.id === 'file:filter/b.ts',
		);

		assert.strictEqual(projectNode.hidden, undefined);
		assert.strictEqual(parentNode.hidden, true);
		assert.strictEqual(childNode.hidden, true);
		assert.strictEqual(fileGroup.hidden, undefined);
		assert.strictEqual(fileGroup.presentation, 'grouped');
		assert.strictEqual(hiddenFile, undefined);
		assert.strictEqual(visibleFile?.hidden, undefined);
		assert.deepStrictEqual(
			fileGroup.children.map((file) => file.id),
			['file:filter/b.ts'],
		);
		assert.strictEqual(
			layout.edges.find((edge) => edge.targetId === parentFolder.id)?.hidden,
			true,
		);
		assert.strictEqual(
			layout.edges.find((edge) => edge.targetId === childFolder.id)?.hidden,
			true,
		);
		assert.deepStrictEqual(hiddenNodeIds, {
			[project.id]: true,
			[parentFolder.id]: true,
			'file:filter/a.ts': true,
		});
	});

	test('File Group pagination과 높이는 hidden File을 제외한 projection을 기준으로 계산한다', () => {
		const parentId = 'folder:app/src';
		const fileGroupId = createFileGroupId(parentId);
		const originalGroup = getFileGroup(
			createGraphLayout(GRAPH_MOCK_PROJECT).nodes,
			parentId,
		);
		const fileIds = originalGroup.children.map((file) => file.id);
		const hiddenCurrentGroup = getFileGroup(createGraphLayout(
			GRAPH_MOCK_PROJECT,
			{ hiddenNodeIds: { [fileIds[2] as string]: true } },
		).nodes, parentId);
		const hiddenOverflowGroup = getFileGroup(createGraphLayout(
			GRAPH_MOCK_PROJECT,
			{ hiddenNodeIds: { [fileIds[6] as string]: true } },
		).nodes, parentId);

		assert.strictEqual(fileIds.length, 7);
		assert.deepStrictEqual(
			hiddenCurrentGroup.children.map((file) => file.id),
			[fileIds[0], fileIds[1], fileIds[3], fileIds[4], fileIds[5], fileIds[6]],
		);
		assert.deepStrictEqual(
			hiddenOverflowGroup.children.map((file) => file.id),
			fileIds.slice(0, 6),
		);
		assert.strictEqual(
			hiddenCurrentGroup.height,
			getFileGroupHeight(5, true),
		);
		assert.strictEqual(hiddenOverflowGroup.height, hiddenCurrentGroup.height);
		assert.strictEqual(originalGroup.children.length, 7);
	});

	test('펼친 File Group은 visible Row 수로 줄고 모두 hidden이면 projection에서 Group과 Edge를 제외한다', () => {
		const parentId = 'folder:app/src';
		const fileGroupId = createFileGroupId(parentId);
		const originalGraph = createGraphLayout(GRAPH_MOCK_PROJECT);
		const originalGroup = getFileGroup(originalGraph.nodes, parentId);
		const fileIds = originalGroup.children.map((file) => file.id);
		const fileGroupPages = { [fileGroupId]: 2 };
		const expandedGroup = getFileGroup(createGraphLayout(
			GRAPH_MOCK_PROJECT,
			{ fileGroupPages },
		).nodes, parentId);
		const filteredExpandedLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages,
			hiddenNodeIds: { [fileIds[2] as string]: true },
		});
		const filteredExpandedGroup = getFileGroup(
			filteredExpandedLayout.nodes,
			parentId,
		);
		const allHiddenNodeIds = Object.fromEntries(
			fileIds.map((fileId) => [fileId, true]),
		) as Record<string, true>;
		const allHiddenLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages,
			hiddenNodeIds: allHiddenNodeIds,
		});
		const oneVisibleId = fileIds[6] as string;
		const oneVisibleLayout = createGraphLayout(GRAPH_MOCK_PROJECT, {
			fileGroupPages,
			hiddenNodeIds: Object.fromEntries(
				fileIds.slice(0, 6).map((fileId) => [fileId, true]),
			) as Record<string, true>,
		});
		const oneVisibleGroup = getFileGroup(oneVisibleLayout.nodes, parentId);

		assert.strictEqual(expandedGroup.height, getFileGroupHeight(7, true));
		assert.strictEqual(
			filteredExpandedGroup.height,
			getFileGroupHeight(6, true),
		);
		assert.deepStrictEqual(
			filteredExpandedGroup.children.map((file) => file.id),
			[fileIds[0], fileIds[1], fileIds[3], fileIds[4], fileIds[5], fileIds[6]],
		);
		assert.strictEqual(
			allHiddenLayout.nodes.find((node) => node.id === fileGroupId),
			undefined,
		);
		assert.strictEqual(
			allHiddenLayout.edges.find((edge) => edge.targetId === fileGroupId),
			undefined,
		);
		assert.strictEqual(oneVisibleGroup.hidden, undefined);
		assert.strictEqual(oneVisibleGroup.presentation, 'grouped');
		assert.deepStrictEqual(
			oneVisibleGroup.children.map((file) => file.id),
			[oneVisibleId],
		);
		assert.strictEqual(oneVisibleGroup.height, getFileGroupHeight(1, false));
		assert.deepStrictEqual(fileGroupPages, { [fileGroupId]: 2 });
	});

	test('30px File Row와 pagination control 높이를 File Group Layout 높이에 반영한다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const fileGroup = getFileGroup(layout.nodes, 'folder:app/src');
		const borderSize = 4;
		const expectedHeight = borderSize
			+ GRAPH_FILE_GROUP_PADDING * 2
			+ FILE_GROUP_PAGE_SIZE * GRAPH_FILE_GROUP_ROW_HEIGHT
			+ GRAPH_FILE_GROUP_CONTROL_HEIGHT;

		assert.strictEqual(GRAPH_FILE_GROUP_ROW_HEIGHT, 30);
		assert.strictEqual(fileGroup.children.length, 7);
		assert.strictEqual(fileGroup.height, expectedHeight);
		assert.strictEqual(fileGroup.height, 198);
	});
});

function getLayoutNode(
	nodes: ReturnType<typeof createGraphLayout>['nodes'],
	nodeId: string,
) {
	const node = nodes.find((candidate) => candidate.id === nodeId);

	assert.ok(node, `${nodeId} Layout Node가 있어야 한다.`);
	return node;
}

function getFileGroup(
	nodes: ReturnType<typeof createGraphLayout>['nodes'],
	parentId: string,
): GraphFileGroupNode {
	const node = nodes.find(
		(candidate): candidate is GraphFileGroupNode =>
			candidate.kind === 'file-group' && candidate.parentId === parentId,
	);

	assert.ok(node, `${parentId}의 File Group이 있어야 한다.`);
	assert.strictEqual(node.presentation, 'grouped');
	return node;
}
