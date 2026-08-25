import * as assert from 'assert';
import * as vscode from 'vscode';
import type { WorkspaceToWebviewMessage } from '../../messages';
import type { Graph } from '../../webview/graph/graphModel';
import {
	createCurrentWorkspaceGraph,
	createWorkspaceRefreshCoordinator,
	type WorkspaceRefreshDependencies,
} from '../../workspace/workspaceRefresh';
import type { WorkspaceSnapshot } from '../../workspace/workspaceModel';
import { createDefaultWorkspacePersistentState } from '../../workspace/workspaceMetadata';
import { createWorkspaceRootCatalog } from '../../workspace/workspaceRootCatalog';
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

suite('Workspace Refresh Coordinator', () => {
	test('Idle dispose는 멱등하며 이후 요청을 안전한 no-op으로 처리한다', async () => {
		let snapshotCalls = 0;
		let conversionCalls = 0;
		let postMessageCalls = 0;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				return createSnapshot('disposed');
			},
			convertWorkspaceSnapshotToGraph() {
				conversionCalls += 1;
				return createGraph('disposed');
			},
			async postMessage() {
				postMessageCalls += 1;
				return true;
			},
		});

		coordinator.dispose();
		coordinator.dispose();
		coordinator.dispose();
		await assert.doesNotReject(coordinator.requestWorkspaceRefresh());

		assert.strictEqual(snapshotCalls, 0);
		assert.strictEqual(conversionCalls, 0);
		assert.strictEqual(postMessageCalls, 0);
	});

	test('Snapshot 실행 중 dispose는 결과와 모든 pending 후속 실행을 폐기한다', async () => {
		const snapshot = createDeferred<WorkspaceSnapshot>();
		let snapshotCalls = 0;
		let conversionCalls = 0;
		let postMessageCalls = 0;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			createWorkspaceSnapshot() {
				snapshotCalls += 1;
				return snapshot.promise;
			},
			convertWorkspaceSnapshotToGraph() {
				conversionCalls += 1;
				return createGraph('disposed-running');
			},
			async postMessage() {
				postMessageCalls += 1;
				return true;
			},
		});
		const activeRefresh = coordinator.requestWorkspaceRefresh();

		await waitFor(() => snapshotCalls === 1);
		coordinator.requestWorkspaceRefresh();
		coordinator.requestWorkspaceRefresh();
		coordinator.dispose();
		coordinator.dispose();
		snapshot.resolve(createSnapshot('disposed-running'));
		await assert.doesNotReject(activeRefresh);

		assert.strictEqual(snapshotCalls, 1);
		assert.strictEqual(conversionCalls, 1);
		assert.strictEqual(postMessageCalls, 0);
	});

	test('Graph 변환 완료 뒤 dispose되어도 예약된 Webview 전송을 차단한다', async () => {
		const snapshot = createDeferred<WorkspaceSnapshot>();
		let conversionCalls = 0;
		let postMessageCalls = 0;
		let coordinator: ReturnType<typeof createWorkspaceRefreshCoordinator>;
		coordinator = createTestWorkspaceRefreshCoordinator({
			createWorkspaceSnapshot: () => snapshot.promise,
			convertWorkspaceSnapshotToGraph() {
				conversionCalls += 1;
				coordinator.dispose();
				return createGraph('converted-before-dispose');
			},
			async postMessage() {
				postMessageCalls += 1;
				return true;
			},
		});
		const activeRefresh = coordinator.requestWorkspaceRefresh();

		await Promise.resolve();
		snapshot.resolve(createSnapshot('converted-before-dispose'));
		await activeRefresh;

		assert.strictEqual(conversionCalls, 1);
		assert.strictEqual(postMessageCalls, 0);
	});

	test('Workspace State load 중 dispose는 signal을 즉시 abort하고 결과 전송을 차단한다', async () => {
		const stateLoad = createDeferred<void>();
		let receivedSignal: AbortSignal | undefined;
		let postMessageCalls = 0;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				return createSnapshot('state-load-dispose');
			},
			convertWorkspaceSnapshotToGraph() {
				return createGraph('state-load-dispose');
			},
			async loadWorkspaceState(_graph, _rootIds, signal) {
				receivedSignal = signal;
				await stateLoad.promise;
				return undefined;
			},
			async postMessage() {
				postMessageCalls += 1;
				return true;
			},
		});
		const activeRefresh = coordinator.requestWorkspaceRefresh();

		await waitFor(() => receivedSignal !== undefined);
		assert.strictEqual(coordinator.signal.aborted, false);
		assert.strictEqual(receivedSignal?.aborted, false);

		coordinator.dispose();
		assert.strictEqual(coordinator.signal.aborted, true);
		assert.strictEqual(receivedSignal?.aborted, true);

		stateLoad.resolve(undefined);
		await assert.doesNotReject(activeRefresh);

		assert.strictEqual(postMessageCalls, 0);
	});

	test('Idle 요청은 현재 Snapshot을 기존 Graph 변환 후 Webview에 전송한다', async () => {
		const snapshot = createSnapshot('initial');
		const graph = createGraph('initial');
		const convertedSnapshots: WorkspaceSnapshot[] = [];
		const messages: WorkspaceToWebviewMessage[] = [];
		let snapshotCalls = 0;
		const dependencies = {
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				return snapshot;
			},
			convertWorkspaceSnapshotToGraph(value: WorkspaceSnapshot) {
				convertedSnapshots.push(value);
				return graph;
			},
			async postMessage(message: WorkspaceToWebviewMessage) {
				messages.push(message);
				return true;
			},
		};

		assert.strictEqual(
			await createCurrentWorkspaceGraph(dependencies),
			graph,
		);
		assert.strictEqual(snapshotCalls, 1);
		convertedSnapshots.length = 0;

		const coordinator = createTestWorkspaceRefreshCoordinator(dependencies);

		await coordinator.requestWorkspaceRefresh();

		assert.strictEqual(snapshotCalls, 2);
		assert.deepStrictEqual(convertedSnapshots, [snapshot]);
		assert.deepStrictEqual(messages, [{
			type: 'workspace.snapshotUpdated',
			presentation: {
				graph,
				rootCatalog: createWorkspaceRootCatalog(snapshot, true, 'linux'),
			},
			contextGeneration: 0,
			rootIds: [snapshot.roots[0]?.id],
		}]);
	});

	test('Presentation과 Root context state를 같은 generation의 하나의 메시지로 전송한다', async () => {
		const snapshot = createSnapshot('stateful');
		const graph = createGraph('stateful');
		const state = createDefaultWorkspacePersistentState();
		const messages: WorkspaceToWebviewMessage[] = [];
		let receivedGraph: Graph | undefined;
		let receivedRootIds: readonly string[] | undefined;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			createWorkspaceSnapshot: async () => snapshot,
			convertWorkspaceSnapshotToGraph: () => graph,
			async loadWorkspaceState(value, rootIds) {
				receivedGraph = value;
				receivedRootIds = rootIds;
				return state;
			},
			getWorkspaceContextGeneration: () => 7,
			async postMessage(message) {
				messages.push(message);
				return true;
			},
		});

		await coordinator.requestWorkspaceRefresh();

		assert.strictEqual(receivedGraph, graph);
		assert.deepStrictEqual(receivedRootIds, [snapshot.roots[0]?.id]);
		assert.deepStrictEqual(messages, [{
			type: 'workspace.snapshotUpdated',
			presentation: {
				graph,
				rootCatalog: createWorkspaceRootCatalog(snapshot, true, 'linux'),
			},
			contextGeneration: 7,
			rootIds: [snapshot.roots[0]?.id],
			state,
		}]);
	});

	test('Filter 로드 실패는 빈 Filter로 격리하고 Workspace Graph 생성을 계속한다', async () => {
		const messages: WorkspaceToWebviewMessage[] = [];
		let receivedFilterCount = -1;
		const dependencies = {
			async loadWorkspaceFilters() {
				throw new Error('filter load failed');
			},
			async createWorkspaceSnapshot(rootFilters: readonly unknown[]) {
				receivedFilterCount = rootFilters.length;
				return createSnapshot('filter-fallback');
			},
			convertWorkspaceSnapshotToGraph: () => createGraph('filter-fallback'),
			async postMessage(message: WorkspaceToWebviewMessage) {
				messages.push(message);
				return true;
			},
		};

		assert.deepStrictEqual(
			await createCurrentWorkspaceGraph(dependencies),
			createGraph('filter-fallback'),
		);
		const coordinator = createTestWorkspaceRefreshCoordinator(dependencies);

		await coordinator.requestWorkspaceRefresh();

		assert.strictEqual(receivedFilterCount, 0);
		assert.deepStrictEqual(messages, [{
			type: 'workspace.snapshotUpdated',
			presentation: {
				graph: createGraph('filter-fallback'),
				rootCatalog: createWorkspaceRootCatalog(
					createSnapshot('filter-fallback'),
					true,
					'linux',
				),
			},
			contextGeneration: 0,
			rootIds: [createSnapshot('filter-fallback').roots[0]?.id],
		}]);
	});

	test('실행 중 요청을 실행별 후속 Refresh 한 번으로 병합하고 탐색을 직렬화한다', async () => {
		const snapshots = [
			createDeferred<WorkspaceSnapshot>(),
			createDeferred<WorkspaceSnapshot>(),
			createDeferred<WorkspaceSnapshot>(),
		];
		const messages: WorkspaceToWebviewMessage[] = [];
		let snapshotCalls = 0;
		let activeSnapshots = 0;
		let maxActiveSnapshots = 0;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				const index = snapshotCalls;
				snapshotCalls += 1;
				activeSnapshots += 1;
				maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);

				try {
					return await snapshots[index]?.promise;
				} finally {
					activeSnapshots -= 1;
				}
			},
			convertWorkspaceSnapshotToGraph: (snapshot) => (
				createGraph(snapshot.roots[0]?.name ?? 'empty')
			),
			async postMessage(message) {
				messages.push(message);
				return true;
			},
		});

		const refreshA = coordinator.requestWorkspaceRefresh();

		await waitFor(() => snapshotCalls === 1);
		const pendingB1 = coordinator.requestWorkspaceRefresh();
		const pendingB2 = coordinator.requestWorkspaceRefresh();

		assert.strictEqual(pendingB1, refreshA);
		assert.strictEqual(pendingB2, refreshA);
		assert.strictEqual(snapshotCalls, 1);

		snapshots[0]?.resolve(createSnapshot('a'));
		await waitFor(() => snapshotCalls === 2);
		coordinator.requestWorkspaceRefresh();
		coordinator.requestWorkspaceRefresh();

		assert.strictEqual(snapshotCalls, 2);
		snapshots[1]?.resolve(createSnapshot('b'));
		await waitFor(() => snapshotCalls === 3);

		assert.strictEqual(maxActiveSnapshots, 1);
		snapshots[2]?.resolve(createSnapshot('c'));
		await refreshA;

		assert.strictEqual(snapshotCalls, 3);
		assert.strictEqual(maxActiveSnapshots, 1);
		assert.strictEqual(activeSnapshots, 0);
		assert.deepStrictEqual(
			messages.map(getWorkspaceMessageRootName),
			['a', 'b', 'c'],
		);
	});

	test('Snapshot 실패 중 pending 요청을 후속 실행하고 이후 요청도 계속 받는다', async () => {
		const firstSnapshot = createDeferred<WorkspaceSnapshot>();
		const secondSnapshot = createDeferred<WorkspaceSnapshot>();
		const messages: WorkspaceToWebviewMessage[] = [];
		let snapshotCalls = 0;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			createWorkspaceSnapshot() {
				snapshotCalls += 1;
				if (snapshotCalls === 1) {
					return firstSnapshot.promise;
				}
				if (snapshotCalls === 2) {
					return secondSnapshot.promise;
				}

				return Promise.resolve(createSnapshot('recovered'));
			},
			convertWorkspaceSnapshotToGraph: (snapshot) => (
				createGraph(snapshot.roots[0]?.name ?? 'empty')
			),
			async postMessage(message) {
				messages.push(message);
				return true;
			},
		});

		const failedWithPending = coordinator.requestWorkspaceRefresh();

		await waitFor(() => snapshotCalls === 1);
		coordinator.requestWorkspaceRefresh();
		firstSnapshot.reject(new Error('snapshot failed'));
		await waitFor(() => snapshotCalls === 2);

		assert.strictEqual(messages.length, 0);
		secondSnapshot.resolve(createSnapshot('pending'));
		await failedWithPending;

		assert.deepStrictEqual(
			messages.map(getWorkspaceMessageRootName),
			['pending'],
		);

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(snapshotCalls, 3);
		assert.deepStrictEqual(
			messages.map(getWorkspaceMessageRootName),
			['pending', 'recovered'],
		);
	});

		test('Graph 변환 실패는 전송하지 않고 coordinator를 Idle로 복구한다', async () => {
			const messages: WorkspaceToWebviewMessage[] = [];
			let conversionCalls = 0;
			const coordinator = createTestWorkspaceRefreshCoordinator({
				async createWorkspaceSnapshot() {
					return createSnapshot('converted');
				},
			convertWorkspaceSnapshotToGraph() {
				conversionCalls += 1;
				if (conversionCalls === 1) {
					throw new Error('conversion failed');
				}

				return createGraph('converted');
			},
			async postMessage(message) {
				messages.push(message);
				return true;
			},
		});

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(messages.length, 0);

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(conversionCalls, 2);
		assert.deepStrictEqual(
			messages.map(getWorkspaceMessageRootName),
			['converted'],
		);
	});

	test('Catalog 생성 실패는 Graph만 부분 전송하지 않고 마지막 정상 Presentation을 유지한다', async () => {
		const snapshot = createSnapshot('catalog');
		const graph = createGraph('catalog');
		const messages: WorkspaceToWebviewMessage[] = [];
		let catalogCalls = 0;
		const coordinator = createWorkspaceRefreshCoordinator({
			createWorkspaceSnapshot: async () => snapshot,
			convertWorkspaceSnapshotToGraph: () => graph,
			readWorkspaceTrust: () => true,
			createWorkspaceRootCatalog(value) {
				catalogCalls += 1;
				if (catalogCalls === 1) {
					throw new Error('catalog failed');
				}

				return createWorkspaceRootCatalog(value, true, 'linux');
			},
			async postMessage(message) {
				messages.push(message);
				return true;
			},
		});

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(messages.length, 0);

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0]?.presentation.graph, graph);
		assert.deepStrictEqual(
			messages[0]?.presentation.rootCatalog.map(({ id }) => id),
			[snapshot.roots[0]?.id],
		);
	});

	test('postMessage false는 retry나 dispose로 해석하지 않고 다음 요청을 허용한다', async () => {
		let snapshotCalls = 0;
		let postMessageCalls = 0;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				return createSnapshot(`delivery-${snapshotCalls}`);
			},
			convertWorkspaceSnapshotToGraph: (snapshot) => (
				createGraph(snapshot.roots[0]?.name ?? 'empty')
			),
			async postMessage() {
				postMessageCalls += 1;
				return postMessageCalls > 1;
			},
		});

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(snapshotCalls, 1);
		assert.strictEqual(postMessageCalls, 1);

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(snapshotCalls, 2);
		assert.strictEqual(postMessageCalls, 2);
	});

	test('postMessage rejection은 완료 Promise에 노출하지 않고 다음 요청을 허용한다', async () => {
		let postMessageCalls = 0;
		const coordinator = createTestWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				return createSnapshot(`rejection-${postMessageCalls}`);
			},
			convertWorkspaceSnapshotToGraph: (snapshot) => (
				createGraph(snapshot.roots[0]?.name ?? 'empty')
			),
			async postMessage() {
				postMessageCalls += 1;
				if (postMessageCalls === 1) {
					throw new Error('delivery failed');
				}

				return true;
			},
		});

		await assert.doesNotReject(coordinator.requestWorkspaceRefresh());
		await assert.doesNotReject(coordinator.requestWorkspaceRefresh());

		assert.strictEqual(postMessageCalls, 2);
	});

	test('dispose된 이전 Coordinator 결과는 새 Coordinator 전송과 격리된다', async () => {
		const oldSnapshot = createDeferred<WorkspaceSnapshot>();
		const oldMessages: WorkspaceToWebviewMessage[] = [];
		const newMessages: WorkspaceToWebviewMessage[] = [];
		const oldCoordinator = createTestWorkspaceRefreshCoordinator({
			createWorkspaceSnapshot: () => oldSnapshot.promise,
			convertWorkspaceSnapshotToGraph: () => createGraph('old'),
			async postMessage(message) {
				oldMessages.push(message);
				return true;
			},
		});
		const oldRefresh = oldCoordinator.requestWorkspaceRefresh();

		await Promise.resolve();
		oldCoordinator.dispose();
		const newCoordinator = createTestWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				return createSnapshot('new');
			},
			convertWorkspaceSnapshotToGraph: () => createGraph('new'),
			async postMessage(message) {
				newMessages.push(message);
				return true;
			},
		});

		await newCoordinator.requestWorkspaceRefresh();
		oldSnapshot.resolve(createSnapshot('old'));
		await oldRefresh;

		assert.strictEqual(oldMessages.length, 0);
		assert.deepStrictEqual(
			newMessages.map(getWorkspaceMessageRootName),
			['new'],
		);
	});
});

function createTestWorkspaceRefreshCoordinator(
	dependencies: Omit<
		WorkspaceRefreshDependencies,
		'readWorkspaceTrust' | 'createWorkspaceRootCatalog'
	>,
) {
	return createWorkspaceRefreshCoordinator({
		...dependencies,
		readWorkspaceTrust: () => true,
		createWorkspaceRootCatalog: (snapshot) => createWorkspaceRootCatalog(
			snapshot,
			true,
			'linux',
		),
	});
}

function createSnapshot(name: string): WorkspaceSnapshot {
	const uri = vscode.Uri.file(`/workspace/${name}`);

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

function createGraph(name: string): Graph {
	const nodeId = createWorkspaceRootId(vscode.Uri.file(`/workspace/${name}`));

	return {
		roots: [{ id: `root:${name}`, nodeId }],
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

function getWorkspaceMessageRootName(
	message: WorkspaceToWebviewMessage,
): string | undefined {
	const root = message.presentation.graph.roots[0];

	return root
		? message.presentation.graph.rootNodes[root.nodeId]?.name
		: undefined;
}

function createDeferred<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
	readonly reject: (error: Error) => void;
} {
	let resolve!: (value: Value) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
		await Promise.resolve();
	}

	assert.strictEqual(predicate(), true);
}
