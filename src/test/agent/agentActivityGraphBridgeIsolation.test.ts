import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
	AgentActivityGraphBridge,
	getAgentActivityGraphRegistrySnapshotForTest,
	type AgentActivityGraphBridgeOptions,
	type AgentActivityGraphRegistrySnapshot,
} from '../../agent/host/terminal/agentActivityGraphBridge';
import type {
	ActivityLease,
	HostAgentActivityRequest,
} from '../../agent/host/terminal/terminalHost';
import type { TerminalSession } from '../../agent/host/terminal/terminalSession';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
	WorkspaceValidationFailure,
} from '../../agent/host/workspace/types';
import type { AgentActivityRequested } from '../../mcp/agentActivityProtocol';
import type { McpSessionRuntime } from '../../mcp/sessionRuntime';
import type { ExtensionToWebviewMessage } from '../../messages';
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

interface RootFixture {
	readonly uri: vscode.Uri;
	readonly id: ReturnType<typeof createWorkspaceRootId>;
	readonly root: ValidatedWorkspaceRoot;
}

function createRootFixture(name: string): RootFixture {
	const uri = vscode.Uri.file(`/trusted/activity-isolation/${name}`);
	const id = createWorkspaceRootId(uri);
	return {
		uri,
		id,
		root: {
			id,
			scheme: 'file',
			fsPath: uri.fsPath as ValidatedWorkspaceFsPath,
			workspaceFolder: { name, index: 0, uri },
		} as unknown as ValidatedWorkspaceRoot,
	};
}

const ROOT_A = createRootFixture('root-a');
const ROOT_B = createRootFixture('root-b');
const ROOTS = new Map([
	[ROOT_A.id, ROOT_A.root],
	[ROOT_B.id, ROOT_B.root],
]);

class Deferred<Value> {
	readonly promise: Promise<Value>;
	private settled = false;
	private resolvePromise!: (value: Value) => void;

	constructor() {
		this.promise = new Promise<Value>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: Value): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.resolvePromise(value);
	}
}

interface CapturedPost {
	readonly message: ExtensionToWebviewMessage;
	readonly result: Deferred<boolean>;
}

interface CapturedValidation {
	readonly lease: ActivityLease;
	readonly path: string;
	readonly result: Deferred<boolean>;
}

interface IsolationHarness {
	readonly bridge: AgentActivityGraphBridge;
	readonly posts: CapturedPost[];
	readonly validations: CapturedValidation[];
	readonly invalidations: Array<Readonly<{
		lease: ActivityLease;
		failure: WorkspaceValidationFailure;
	}>>;
}

function createHarness(
	overrides: Partial<AgentActivityGraphBridgeOptions> = {},
): IsolationHarness {
	const posts: CapturedPost[] = [];
	const validations: CapturedValidation[] = [];
	const invalidations: IsolationHarness['invalidations'] = [];
	const bridge = new AgentActivityGraphBridge({
		postMessage: (message) => {
			const result = new Deferred<boolean>();
			posts.push({ message, result });
			return result.promise;
		},
		resolveWorkspace: (workspaceRootId) => {
			const root = ROOTS.get(workspaceRootId);
			return root === undefined
				? { ok: false, code: 'workspace_root_unavailable' }
				: { ok: true, root };
		},
		invalidateLease: (lease, failure) => {
			invalidations.push({ lease, failure });
		},
		validateSetTarget: (lease, _root, request) => {
			const result = new Deferred<boolean>();
			validations.push({ lease, path: request.path, result });
			return result.promise;
		},
		...overrides,
	});
	return { bridge, posts, validations, invalidations };
}

function createLease(
	sessionId: string,
	rootFixture: RootFixture = ROOT_A,
	epoch = 1,
): ActivityLease {
	const generation = `generation-${sessionId}-${epoch}`;
	const runtime = {
		sessionId,
		generation,
		lifecycle: 'running',
	} as McpSessionRuntime;
	return {
		session: { sessionId } as TerminalSession,
		assignment: {
			providerId: 'codex',
			workspaceRootId: rootFixture.id,
		},
		providerId: 'codex',
		workspaceRootId: rootFixture.id,
		runtime,
		generation,
		launchRootUri: rootFixture.uri.toString(),
		launchRootFsPath: rootFixture.uri.fsPath,
		epoch,
		revoked: false,
	};
}

function setRequest(
	lease: ActivityLease,
	path: string,
	activity: 'planned' | 'active' | 'editing' | 'completed' = 'active',
): HostAgentActivityRequest {
	const event: AgentActivityRequested = {
		type: 'session.agentActivityRequested',
		sessionId: lease.session.sessionId,
		generation: lease.generation,
		operation: 'set',
		path,
		targetKind: 'file',
		activity,
	};
	return { lease, sourceRuntime: lease.runtime, event };
}

function clearRequest(
	lease: ActivityLease,
	path: string,
): HostAgentActivityRequest {
	const event: AgentActivityRequested = {
		type: 'session.agentActivityRequested',
		sessionId: lease.session.sessionId,
		generation: lease.generation,
		operation: 'clear',
		path,
		targetKind: 'file',
	};
	return { lease, sourceRuntime: lease.runtime, event };
}

function trackedReceiptId(post: CapturedPost | undefined): number {
	assert.ok(post);
	assert.strictEqual(post.message.type, 'agent.activity.clearTracked');
	return post.message.receiptId;
}

function setPostSessionId(post: CapturedPost | undefined): string | undefined {
	return post?.message.type === 'agent.activity.set'
		? post.message.sessionId
		: undefined;
}

function setPostNodeId(post: CapturedPost | undefined): string | undefined {
	return post?.message.type === 'agent.activity.set'
		? post.message.target.nodeId
		: undefined;
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

suite('Host Agent Activity Graph bridge isolation', () => {
	let baseline: AgentActivityGraphRegistrySnapshot;
	let harnesses: IsolationHarness[];

	setup(() => {
		baseline = getAgentActivityGraphRegistrySnapshotForTest();
		harnesses = [];
	});

	teardown(async () => {
		for (const harness of harnesses) {
			harness.bridge.disposePanel();
		}
		for (const harness of harnesses) {
			for (const validation of harness.validations) {
				validation.result.resolve(false);
			}
			for (const post of harness.posts) {
				post.result.resolve(false);
			}
		}
		await flushAsyncWork();
		await flushAsyncWork();
		assert.deepStrictEqual(
			getAgentActivityGraphRegistrySnapshotForTest(),
			baseline,
		);
	});

	const registerHarness = (
		overrides: Partial<AgentActivityGraphBridgeOptions> = {},
	): IsolationHarness => {
		const harness = createHarness(overrides);
		harnesses.push(harness);
		return harness;
	};

	test('cross-target validation과 post settlement는 서로의 target state를 변경하지 않는다', async () => {
		const harness = registerHarness();
		const lease = createLease('session-cross-target');

		harness.bridge.handleRequest(setRequest(lease, 'first.ts', 'planned'));
		harness.bridge.handleRequest(setRequest(lease, 'second.ts', 'editing'));
		assert.deepStrictEqual(
			harness.validations.map(({ path }) => path),
			['first.ts', 'second.ts'],
		);

		harness.validations[1]?.result.resolve(true);
		await flushAsyncWork();
		assert.strictEqual(
			setPostNodeId(harness.posts[0]),
			`file:${vscode.Uri.joinPath(ROOT_A.uri, 'second.ts').toString()}`,
		);
		harness.posts[0]?.result.resolve(false);
		await flushAsyncWork();
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().validationsInFlight, 1);

		harness.validations[0]?.result.resolve(true);
		await flushAsyncWork();
		assert.strictEqual(
			setPostNodeId(harness.posts[1]),
			`file:${vscode.Uri.joinPath(ROOT_A.uri, 'first.ts').toString()}`,
		);
		harness.posts[1]?.result.resolve(true);
		await flushAsyncWork();
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
	});

	test('cross-session의 같은 Graph target은 validation과 occupancy를 독립 소유한다', async () => {
		const harness = registerHarness();
		const leaseA = createLease('session-cross-a');
		const leaseB = createLease('session-cross-b');

		harness.bridge.handleRequest(setRequest(leaseA, 'shared.ts', 'planned'));
		harness.bridge.handleRequest(setRequest(leaseB, 'shared.ts', 'editing'));
		harness.validations[1]?.result.resolve(true);
		harness.validations[0]?.result.resolve(true);
		await flushAsyncWork();
		assert.deepStrictEqual(
			harness.posts.map(setPostSessionId),
			['session-cross-b', 'session-cross-a'],
		);

		harness.posts[0]?.result.resolve(true);
		harness.posts[1]?.result.resolve(false);
		await flushAsyncWork();
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);

		harness.bridge.handleRequest(clearRequest(leaseA, 'shared.ts'));
		assert.strictEqual(harness.posts.length, 2);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);

		harness.bridge.handleRequest(clearRequest(leaseB, 'shared.ts'));
		assert.strictEqual(harness.posts[2]?.message.type, 'agent.activity.clearTracked');
		assert.strictEqual(harness.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId: trackedReceiptId(harness.posts[2]),
		}), true);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		harness.posts[2]?.result.resolve(true);
		await flushAsyncWork();
	});

	test('root A resolver failure는 root B lease validation과 settlement를 보존한다', async () => {
		const harness = registerHarness({
			resolveWorkspace: (workspaceRootId) => {
				if (workspaceRootId === ROOT_A.id) {
					return { ok: false, code: 'workspace_root_unavailable' };
				}
				const root = ROOTS.get(workspaceRootId);
				return root === undefined
					? { ok: false, code: 'workspace_root_unavailable' }
					: { ok: true, root };
			},
		});
		const leaseA = createLease('session-root-a', ROOT_A);
		const leaseB = createLease('session-root-b', ROOT_B);

		harness.bridge.handleRequest(setRequest(leaseA, 'failed.ts'));
		assert.strictEqual(harness.invalidations.length, 1);
		assert.strictEqual(harness.invalidations[0]?.lease, leaseA);
		assert.deepStrictEqual(harness.posts[0]?.message, {
			type: 'agent.activity.clearSession',
			sessionId: 'session-root-a',
		});

		harness.bridge.handleRequest(setRequest(leaseB, 'healthy.ts', 'editing'));
		assert.strictEqual(harness.validations.length, 1);
		assert.strictEqual(harness.validations[0]?.lease, leaseB);
		harness.validations[0]?.result.resolve(true);
		await flushAsyncWork();
		assert.strictEqual(setPostSessionId(harness.posts[1]), 'session-root-b');
		assert.strictEqual(
			setPostNodeId(harness.posts[1]),
			`file:${vscode.Uri.joinPath(ROOT_B.uri, 'healthy.ts').toString()}`,
		);
		harness.posts[1]?.result.resolve(true);
		await flushAsyncWork();

		assert.strictEqual(harness.invalidations.length, 1);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
	});

	test('newer set 뒤 old target-clear receipt는 새 occupancy를 해제하지 않는다', async () => {
		const harness = registerHarness();
		const lease = createLease('session-newer-set');

		harness.bridge.handleRequest(setRequest(lease, 'newer.ts', 'planned'));
		harness.validations[0]?.result.resolve(true);
		await flushAsyncWork();
		harness.posts[0]?.result.resolve(true);
		await flushAsyncWork();

		harness.bridge.handleRequest(clearRequest(lease, 'newer.ts'));
		const oldReceiptId = trackedReceiptId(harness.posts[1]);
		harness.posts[1]?.result.resolve(true);
		await flushAsyncWork();
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);

		harness.bridge.handleRequest(setRequest(lease, 'newer.ts', 'editing'));
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
		harness.validations[1]?.result.resolve(true);
		await flushAsyncWork();
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
		harness.posts[2]?.result.resolve(true);
		await flushAsyncWork();
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 0);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);

		assert.strictEqual(harness.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId: oldReceiptId,
		}), true);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
	});

	test('wrong, duplicate, failure-first late receipt는 모두 occupancy를 잘못 정산하지 않는다', async () => {
		const harness = registerHarness();
		const lease = createLease('session-receipt-isolation');

		harness.bridge.handleRequest(setRequest(lease, 'receipt-one.ts'));
		harness.validations[0]?.result.resolve(true);
		await flushAsyncWork();
		harness.posts[0]?.result.resolve(true);
		await flushAsyncWork();
		harness.bridge.handleRequest(clearRequest(lease, 'receipt-one.ts'));
		const receiptId = trackedReceiptId(harness.posts[1]);

		assert.strictEqual(harness.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId: receiptId + 10_000,
		}), true);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
		assert.strictEqual(harness.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId,
		}), true);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		assert.strictEqual(harness.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId,
		}), true);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		harness.posts[1]?.result.resolve(true);
		await flushAsyncWork();

		harness.bridge.handleRequest(setRequest(lease, 'receipt-two.ts'));
		harness.validations[1]?.result.resolve(true);
		await flushAsyncWork();
		harness.posts[2]?.result.resolve(true);
		await flushAsyncWork();
		harness.bridge.handleRequest(clearRequest(lease, 'receipt-two.ts'));
		const lateReceiptId = trackedReceiptId(harness.posts[3]);
		harness.posts[3]?.result.resolve(false);
		await flushAsyncWork();
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 0);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
		assert.strictEqual(harness.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId: lateReceiptId,
		}), true);
		assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
	});

	test('두 panel의 같은 receiptId는 호출된 exact bridge에서만 정산된다', async () => {
		const panelA = registerHarness();
		const panelB = registerHarness();
		const leaseA = createLease('session-panel-a');
		const leaseB = createLease('session-panel-b');

		panelA.bridge.handleRequest(setRequest(leaseA, 'panel.ts'));
		panelB.bridge.handleRequest(setRequest(leaseB, 'panel.ts'));
		panelA.validations[0]?.result.resolve(true);
		panelB.validations[0]?.result.resolve(true);
		await flushAsyncWork();
		panelA.posts[0]?.result.resolve(true);
		panelB.posts[0]?.result.resolve(true);
		await flushAsyncWork();

		panelA.bridge.handleRequest(clearRequest(leaseA, 'panel.ts'));
		panelB.bridge.handleRequest(clearRequest(leaseB, 'panel.ts'));
		const panelAReceipt = trackedReceiptId(panelA.posts[1]);
		const panelBReceipt = trackedReceiptId(panelB.posts[1]);
		assert.strictEqual(panelAReceipt, 0);
		assert.strictEqual(panelBReceipt, 0);

		assert.strictEqual(panelA.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId: panelAReceipt,
		}), true);
		assert.strictEqual(panelA.bridge.getPanelSnapshotForTest().activeTargets, 0);
		assert.strictEqual(panelB.bridge.getPanelSnapshotForTest().activeTargets, 1);
		assert.strictEqual(panelB.bridge.getPanelSnapshotForTest().receiptCount, 1);

		assert.strictEqual(panelB.bridge.handleWebviewMessage({
			type: 'agent.activity.clearApplied',
			receiptId: panelBReceipt,
		}), true);
		assert.strictEqual(panelB.bridge.getPanelSnapshotForTest().activeTargets, 0);
		panelA.posts[1]?.result.resolve(true);
		panelB.posts[1]?.result.resolve(true);
		await flushAsyncWork();
	});
});
