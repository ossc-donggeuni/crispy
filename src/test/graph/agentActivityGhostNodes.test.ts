import * as assert from 'assert';
import { createAgentActivityStore } from '../../agent/webview/agentActivityStore';
import {
	createAgentActivityGhostNodeProjections,
	AGENT_ACTIVITY_GHOST_NODE_LIMIT,
} from '../../webview/graph/agentActivityGhostNodes';
import { createGraphLayout } from '../../webview/graph/graphLayout';
import type { Graph, Project, ProjectEntry } from '../../webview/graph/graphModel';

suite('Agent Activity Ghost Nodes', () => {
	test('actual direct parent가 있을 때만 missing Target을 투영한다', () => {
		const folderId = 'folder:file:///workspace/src';
		const directTarget = { nodeId: 'file:file:///workspace/src/new.ts' };
		const nestedTarget = {
			nodeId: 'file:file:///workspace/src/missing/deep.ts',
		};
		const graph = createWorkspaceGraph([]);
		const store = createAgentActivityStore();

		store.setAgentActivity('direct', directTarget, 'planned');
		store.setAgentActivity('nested', nestedTarget, 'editing');
		const layout = createGraphLayout(graph, {
			openedFolders: {
				'workspace-root:file:///workspace': true,
				[folderId]: true,
			},
		});
		const projections = createAgentActivityGhostNodeProjections(
			store.getSnapshot(),
			graph,
			layout,
			new Map(layout.nodes.map((node) => [node.id, node.position])),
		);

		assert.strictEqual(projections.length, 1);
		assert.strictEqual(projections[0]?.target.nodeId, directTarget.nodeId);
		assert.strictEqual(projections[0]?.parentLayoutNodeId, folderId);
		assert.strictEqual(projections[0]?.name, 'new.ts');
		assert.strictEqual(projections[0]?.targetKind, 'file');
		const parent = layout.nodes.find(({ id }) => id === folderId);

		assert.ok(parent);
		assert.strictEqual(
			projections[0]?.position.y,
			parent.position.y,
			'첫 ghost child는 parent와 같은 arranged row에서 시작해야 한다.',
		);
		const translatedPositions = new Map(layout.nodes.map((node) => [
			node.id,
			{ x: node.position.x + 120, y: node.position.y + 80 },
		]));
		const translatedProjection = createAgentActivityGhostNodeProjections(
			store.getSnapshot(),
			graph,
			layout,
			translatedPositions,
		)[0];

		assert.strictEqual(
			translatedProjection?.position.x,
			(projections[0]?.position.x ?? 0) + 120,
		);
		assert.strictEqual(
			translatedProjection?.position.y,
			(projections[0]?.position.y ?? 0) + 80,
		);

		const actualGraph = createWorkspaceGraph([{
			kind: 'file',
			id: directTarget.nodeId,
			name: 'new.ts',
		}]);
		const actualLayout = createGraphLayout(actualGraph, {
			openedFolders: {
				'workspace-root:file:///workspace': true,
				[folderId]: true,
			},
		});

		assert.deepStrictEqual(createAgentActivityGhostNodeProjections(
			store.getSnapshot(),
			actualGraph,
			actualLayout,
			new Map(actualLayout.nodes.map((node) => [node.id, node.position])),
		), []);
	});

	test('기존 arranged child 뒤의 같은 sibling flow에 ghost를 배치한다', () => {
		const existingFileId = 'file:file:///workspace/src/existing.ts';
		const target = { nodeId: 'file:file:///workspace/src/new.ts' };
		const graph = createWorkspaceGraph([{
			kind: 'file',
			id: existingFileId,
			name: 'existing.ts',
		}]);
		const store = createAgentActivityStore();

		store.setAgentActivity('session', target, 'planned');
		const layout = createGraphLayout(graph, {
			openedFolders: {
				'workspace-root:file:///workspace': true,
				'folder:file:///workspace/src': true,
			},
		});
		const existingFile = layout.nodes.find(({ id }) => id === existingFileId);
		const projection = createAgentActivityGhostNodeProjections(
			store.getSnapshot(),
			graph,
			layout,
			new Map(layout.nodes.map((node) => [node.id, node.position])),
		)[0];

		assert.ok(existingFile && projection);
		assert.strictEqual(projection.position.x, existingFile.position.x);
		assert.strictEqual(
			projection.position.y,
			existingFile.position.y + existingFile.height + 6,
		);
	});

	test('같은 direct parent의 provisional Target은 panel 상한까지만 표시한다', () => {
		const graph = createWorkspaceGraph([]);
		const store = createAgentActivityStore();

		for (let index = 0; index <= AGENT_ACTIVITY_GHOST_NODE_LIMIT; index += 1) {
			store.setAgentActivity(`session-${index}`, {
				nodeId: `file:file:///workspace/src/new-${index}.ts`,
			}, 'planned');
		}
		const layout = createGraphLayout(graph, {
			openedFolders: {
				'workspace-root:file:///workspace': true,
				'folder:file:///workspace/src': true,
			},
		});
		const projections = createAgentActivityGhostNodeProjections(
			store.getSnapshot(),
			graph,
			layout,
			new Map(layout.nodes.map((node) => [node.id, node.position])),
		);

		assert.strictEqual(projections.length, AGENT_ACTIVITY_GHOST_NODE_LIMIT);
		assert.strictEqual(new Set(projections.map(({ key }) => key)).size, 64);
	});
});

function createWorkspaceGraph(folderChildren: readonly ProjectEntry[]): Graph {
	const projectId = 'workspace-root:file:///workspace';
	const project: Project = {
		kind: 'project',
		id: projectId,
		name: 'workspace',
		status: 'loaded',
		children: [{
			kind: 'folder',
			id: 'folder:file:///workspace/src',
			name: 'src',
			status: 'loaded',
			children: folderChildren,
		}],
	};

	return {
		roots: [{ id: `root:${projectId}`, nodeId: projectId }],
		rootNodes: { [projectId]: project },
	};
}
