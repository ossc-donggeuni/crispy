import * as assert from 'assert';
import {
	createFileGroupId,
	createGraphLayout as createBaseGraphLayout,
	getFileGroupHeight,
	GRAPH_FILE_GROUP_CONTROL_HEIGHT,
	GRAPH_FILE_GROUP_NODE_WIDTH,
	GRAPH_FILE_GROUP_PADDING,
	GRAPH_FILE_GROUP_ROW_HEIGHT,
	GRAPH_FOLDER_NODE_HEIGHT,
	GRAPH_FOLDER_NODE_WIDTH,
	type GraphFileGroupNode,
	type GraphLayoutOptions,
} from '../../webview/graph/graphLayout';
import { GRAPH_MOCK_PROJECT } from '../../webview/graph/graphMockData';
import {
	isFile,
	isFolder,
	type Project,
} from '../../webview/graph/graphModel';
import { FILE_GROUP_PAGE_SIZE } from '../../webview/graph/graphState';

const ALL_OPENED_FOLDERS = openAllFolders(GRAPH_MOCK_PROJECT);

/** 기존 전체 Layout 검증에서는 모든 Folder를 명시적으로 연다. */
function createGraphLayout(
	project: Project,
	options: GraphLayoutOptions = {},
): ReturnType<typeof createBaseGraphLayout> {
	return createBaseGraphLayout(project, {
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

suite('Graph Model / Layout', () => {
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

	test('기본 상태는 모든 Folder를 닫고 Project Root는 항상 연다', () => {
		const defaultLayout = createBaseGraphLayout(GRAPH_MOCK_PROJECT);
		const rootStateLayout = createBaseGraphLayout(GRAPH_MOCK_PROJECT, {
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		});
		const nodeIds = new Set(defaultLayout.nodes.map((node) => node.id));

		assert.ok(nodeIds.has(GRAPH_MOCK_PROJECT.id));
		assert.ok(nodeIds.has('folder:app'));
		assert.ok(nodeIds.has('folder:src'));
		assert.ok(nodeIds.has('folder:pagination-samples'));
		assert.ok(nodeIds.has(createFileGroupId(GRAPH_MOCK_PROJECT.id)));
		assert.strictEqual(nodeIds.has('folder:app/src'), false);
		assert.deepStrictEqual(rootStateLayout, defaultLayout);
	});

	test('열린 Folder의 직계 children만 포함하고 닫힌 descendant subtree는 제외한다', () => {
		const folderId = 'folder:app';
		const layout = createBaseGraphLayout(GRAPH_MOCK_PROJECT, {
			openedFolders: { [folderId]: true },
		});
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
		assert.deepStrictEqual(
			appSrcFiles.files.map((file) => file.name),
			expectedFiles,
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
			getFileGroup(layout.nodes, seventeenFiles.id).files.length,
			17,
		);
		assert.strictEqual(
			getFileGroup(layout.nodes, twentyOneFiles.id).files.length,
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
		assert.strictEqual(GRAPH_FOLDER_NODE_WIDTH, 200);
		assert.strictEqual(GRAPH_FOLDER_NODE_HEIGHT, 42);
		assert.strictEqual(GRAPH_FILE_GROUP_NODE_WIDTH, 200);
		assert.strictEqual(root.width, folder.width);
		assert.strictEqual(folder.width, fileGroup.width);
		assert.strictEqual(folder.position.x - root.position.x, 262);
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
		assert.strictEqual(fileGroup.files.length, 7);
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
	return node;
}
