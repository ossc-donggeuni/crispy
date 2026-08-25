import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Graph } from '../../webview/graph/graphModel';
import type { WorkspaceSnapshot } from '../../workspace/workspaceModel';
import {
	deserializeWorkspacePresentationFromWebview,
	parseWorkspacePresentation,
	serializeWorkspacePresentationForWebview,
	type WorkspacePresentation,
} from '../../workspace/workspacePresentation';
import {
	createCurrentWorkspaceGraph,
	createCurrentWorkspacePresentation,
	createCurrentWorkspaceSnapshot,
} from '../../workspace/workspaceRefresh';
import { createWorkspaceRootCatalog } from '../../workspace/workspaceRootCatalog';
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

suite('Workspace Presentation', () => {
	test('Snapshot orchestration이 filter를 한 번 로드해 그대로 수집 경계에 전달한다', async () => {
		const filters = [{
			rootUri: vscode.Uri.file('/workspace/app'),
			filter: { version: 1 as const, rules: [] },
		}];
		let receivedFilters: unknown;
		const snapshot = createSnapshot('app');

		assert.strictEqual(await createCurrentWorkspaceSnapshot({
			loadWorkspaceFilters: async () => filters,
			async createWorkspaceSnapshot(rootFilters) {
				receivedFilters = rootFilters;
				return snapshot;
			},
		}), snapshot);
		assert.strictEqual(receivedFilters, filters);
	});

	test('기존 Graph 경계는 Presentation wrapper 없이 Snapshot만 변환한다', async () => {
		const snapshot = createSnapshot('graph-only');
		const graph = createGraph(snapshot, 'graph-only');
		let convertedSnapshot: WorkspaceSnapshot | undefined;

		assert.strictEqual(await createCurrentWorkspaceGraph({
			createWorkspaceSnapshot: async () => snapshot,
			convertWorkspaceSnapshotToGraph(value) {
				convertedSnapshot = value;
				return graph;
			},
		}), graph);
		assert.strictEqual(convertedSnapshot, snapshot);
	});

	test('Graph와 Catalog를 같은 Snapshot에서 만들고 Snapshot 후 Trust를 읽는다', async () => {
		const events: string[] = [];
		const snapshot = createSnapshot('shared');
		const graph = createGraph(snapshot, 'shared');
		let graphSnapshot: WorkspaceSnapshot | undefined;
		let catalogSnapshot: WorkspaceSnapshot | undefined;
		let catalogTrust: boolean | undefined;

		const presentation = await createCurrentWorkspacePresentation({
			async createWorkspaceSnapshot() {
				events.push('snapshot');
				return snapshot;
			},
			readWorkspaceTrust() {
				events.push('trust');
				return false;
			},
			convertWorkspaceSnapshotToGraph(value) {
				events.push('graph');
				graphSnapshot = value;
				return graph;
			},
			createWorkspaceRootCatalog(value, isTrusted) {
				events.push('catalog');
				catalogSnapshot = value;
				catalogTrust = isTrusted;
				return createWorkspaceRootCatalog(value, isTrusted, 'linux');
			},
		});

		assert.deepStrictEqual(events, ['snapshot', 'trust', 'graph', 'catalog']);
		assert.strictEqual(graphSnapshot, snapshot);
		assert.strictEqual(catalogSnapshot, snapshot);
		assert.strictEqual(catalogTrust, false);
		assert.strictEqual(presentation.graph, graph);
		assert.deepStrictEqual(
			presentation.rootCatalog.map(({ id }) => id),
			snapshot.roots.map(({ id }) => id),
		);
	});

	test('Graph와 Catalog 전체를 HTML-safe한 단일 값으로 round-trip한다', () => {
		const snapshot = createSnapshot('app & api "preview"');
		const presentation: WorkspacePresentation = {
			graph: createGraph(snapshot, 'app & api "preview"'),
			rootCatalog: createWorkspaceRootCatalog(snapshot, true, 'linux'),
		};
		const serialized = serializeWorkspacePresentationForWebview(presentation);

		assert.doesNotMatch(serialized, /["&<>]/);
		assert.deepStrictEqual(
			deserializeWorkspacePresentationFromWebview(serialized),
			presentation,
		);
	});

	test('매우 긴 root ID를 Graph와 Catalog 양쪽에서 손실 없이 파싱한다', () => {
		const uri = vscode.Uri.parse(
			`vscode-remote://ssh-remote+dev/${'nested/'.repeat(3_000)}`,
		);
		const snapshot = createSnapshot('long', uri);
		const presentation: WorkspacePresentation = {
			graph: createGraph(snapshot, 'long'),
			rootCatalog: createWorkspaceRootCatalog(snapshot, true, 'linux'),
		};
		const parsed = parseWorkspacePresentation(presentation);

		assert.ok(parsed && parsed.rootCatalog[0]!.id.length > 16_384);
		assert.strictEqual(
			parsed.graph.roots[0]?.nodeId,
			parsed.rootCatalog[0]?.id,
		);
	});

	test('Graph 또는 Catalog가 잘못되면 Presentation 전체를 거부한다', () => {
		const snapshot = createSnapshot('invalid');
		const graph = createGraph(snapshot, 'invalid');

		assert.strictEqual(parseWorkspacePresentation({
			graph: {
				roots: [{ id: 'root:missing', nodeId: 'project:missing' }],
				rootNodes: {},
			},
			rootCatalog: createWorkspaceRootCatalog(snapshot, true, 'linux'),
		}), undefined);
		assert.strictEqual(parseWorkspacePresentation({
			graph,
			rootCatalog: [{
				id: 'workspace-root:',
				name: 'invalid',
				description: 'invalid',
				selectable: true,
			}],
		}), undefined);
		assert.throws(
			() => deserializeWorkspacePresentationFromWebview('%not-json'),
			/Invalid initial Workspace Presentation/,
		);
		assert.throws(
			() => deserializeWorkspacePresentationFromWebview(undefined),
			/Missing initial Workspace Presentation/,
		);
	});

	test('Catalog entry의 selectable/reason 조합과 unknown field를 strict하게 거부한다', () => {
		const snapshot = createSnapshot('strict');
		const graph = createGraph(snapshot, 'strict');
		const id = snapshot.roots[0]!.id;
		const baseEntry = {
			id,
			name: 'strict',
			description: 'file:///workspace/strict',
		};

		for (const rootCatalog of [
			[{ ...baseEntry, selectable: true, reason: 'workspace_untrusted' }],
			[{ ...baseEntry, selectable: false }],
			[{ ...baseEntry, selectable: false, reason: 'unknown' }],
			[{ ...baseEntry, selectable: true, unexpected: true }],
		]) {
			assert.strictEqual(parseWorkspacePresentation({ graph, rootCatalog }), undefined);
		}

		assert.deepStrictEqual(parseWorkspacePresentation({
			graph,
			rootCatalog: [{
				...baseEntry,
				selectable: false,
				reason: 'workspace_root_unavailable',
			}],
		})?.rootCatalog[0]?.reason, 'workspace_root_unavailable');
	});
});

function createSnapshot(
	name: string,
	uri: vscode.Uri = vscode.Uri.file(`/workspace/${name}`),
): WorkspaceSnapshot {
	return {
		roots: [{
			id: createWorkspaceRootId(uri),
			name,
			uri,
			status: 'loaded',
			children: [],
		}],
	};
}

function createGraph(snapshot: WorkspaceSnapshot, name: string): Graph {
	const nodeId = snapshot.roots[0]!.id;

	return {
		roots: [{ id: `root:${nodeId}`, nodeId }],
		rootNodes: {
			[nodeId]: {
				kind: 'project',
				id: nodeId,
				name,
				status: 'loaded',
				children: [],
			},
		},
	};
}
