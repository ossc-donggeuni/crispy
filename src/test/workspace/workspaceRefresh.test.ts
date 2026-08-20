import * as assert from 'assert';
import type { WorkspaceToWebviewMessage } from '../../messages';
import type { Graph } from '../../webview/graph/graphModel';
import {
	createCurrentWorkspaceGraph,
	createWorkspaceRefreshCoordinator,
} from '../../workspace/workspaceRefresh';
import type { WorkspaceSnapshot } from '../../workspace/workspaceModel';

suite('Workspace Refresh Coordinator', () => {
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

		const coordinator = createWorkspaceRefreshCoordinator(dependencies);

		await coordinator.requestWorkspaceRefresh();

		assert.strictEqual(snapshotCalls, 2);
		assert.deepStrictEqual(convertedSnapshots, [snapshot]);
		assert.deepStrictEqual(messages, [{
			type: 'workspace.graphUpdated',
			graph,
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
		const coordinator = createWorkspaceRefreshCoordinator({
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
			messages.map((message) => message.graph.roots[0]?.nodeId),
			['project:a', 'project:b', 'project:c'],
		);
	});

	test('Snapshot 실패 중 pending 요청을 후속 실행하고 이후 요청도 계속 받는다', async () => {
		const firstSnapshot = createDeferred<WorkspaceSnapshot>();
		const secondSnapshot = createDeferred<WorkspaceSnapshot>();
		const messages: WorkspaceToWebviewMessage[] = [];
		let snapshotCalls = 0;
		const coordinator = createWorkspaceRefreshCoordinator({
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
			messages.map((message) => message.graph.roots[0]?.nodeId),
			['project:pending'],
		);

		await coordinator.requestWorkspaceRefresh();
		assert.strictEqual(snapshotCalls, 3);
		assert.deepStrictEqual(
			messages.map((message) => message.graph.roots[0]?.nodeId),
			['project:pending', 'project:recovered'],
		);
	});

	test('Graph 변환 실패는 전송하지 않고 coordinator를 Idle로 복구한다', async () => {
		const messages: WorkspaceToWebviewMessage[] = [];
		let conversionCalls = 0;
		const coordinator = createWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				return createSnapshot(`snapshot-${conversionCalls}`);
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
			messages.map((message) => message.graph.roots[0]?.nodeId),
			['project:converted'],
		);
	});
});

function createSnapshot(name: string): WorkspaceSnapshot {
	return {
		roots: [{
			id: `workspace:${name}`,
			name,
			uri: {} as WorkspaceSnapshot['roots'][number]['uri'],
			status: 'loaded',
			children: [],
		}],
	};
}

function createGraph(name: string): Graph {
	const nodeId = `project:${name}`;

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
