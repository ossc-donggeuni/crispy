import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { McpSessionRuntime } from '../../mcp/sessionRuntime';
import type { AgentActivityRequested } from '../../mcp/agentActivityProtocol';
import type { ExtensionToWebviewMessage } from '../../messages';
import {
	AgentActivityGraphBridge,
	CLEANUP_POST_PENDING_PER_PANEL_EVENTS,
	getAgentActivityGraphRegistrySnapshotForTest,
	POST_PENDING_PER_SESSION_EVENTS,
	type AgentActivityGraphBridgeOptions,
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
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

const ROOT_URI = vscode.Uri.file('/trusted/activity-graph-bridge');
const ROOT_ID = createWorkspaceRootId(ROOT_URI);
const ROOT_FS_PATH = ROOT_URI.fsPath;
const ROOT = {
	id: ROOT_ID,
	scheme: 'file',
	fsPath: ROOT_FS_PATH as ValidatedWorkspaceFsPath,
	workspaceFolder: {
		name: 'activity-graph-bridge',
		index: 0,
		uri: ROOT_URI,
	},
} as unknown as ValidatedWorkspaceRoot;

class Deferred<Value> {
	readonly promise: Promise<Value>;
	settled = false;
	private resolvePromise!: (value: Value) => void;
	private rejectPromise!: (reason?: unknown) => void;

	constructor() {
		this.promise = new Promise<Value>((resolve, reject) => {
			this.resolvePromise = resolve;
			this.rejectPromise = reject;
		});
	}

	resolve(value: Value): void {
		if (!this.settled) {
			this.settled = true;
			this.resolvePromise(value);
		}
	}

	reject(reason?: unknown): void {
		if (!this.settled) {
			this.settled = true;
			this.rejectPromise(reason);
		}
	}
}

interface CapturedPost {
	readonly message: ExtensionToWebviewMessage;
	readonly result: Deferred<boolean>;
}

interface CapturedValidation {
	readonly result: Deferred<boolean>;
}

interface BridgeHarness {
	readonly bridge: AgentActivityGraphBridge;
	readonly posts: CapturedPost[];
	readonly validations: CapturedValidation[];
	readonly invalidations: Array<Readonly<{
		lease: ActivityLease;
		failure: WorkspaceValidationFailure;
	}>>;
	readonly resolverCalls: string[];
}

function createLease(
	sessionId = 'session-activity-a',
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
			workspaceRootId: ROOT_ID,
		},
		providerId: 'codex',
		workspaceRootId: ROOT_ID,
		runtime,
		generation,
		launchRootUri: ROOT_URI.toString(),
		launchRootFsPath: ROOT_FS_PATH,
		epoch,
		revoked: false,
	};
}

function createSuccessorLease(lease: ActivityLease, epoch: number): ActivityLease {
	const generation = `generation-${lease.session.sessionId}-${epoch}`;
	return {
		...lease,
		runtime: {
			sessionId: lease.session.sessionId,
			generation,
			lifecycle: 'running',
		} as McpSessionRuntime,
		generation,
		epoch,
		revoked: false,
	};
}

function setRequest(
	lease: ActivityLease,
	path: string,
	activity: 'planned' | 'active' | 'editing' | 'completed' = 'active',
	targetKind: 'file' | 'folder' = 'file',
): HostAgentActivityRequest {
	const event: AgentActivityRequested = {
		type: 'session.agentActivityRequested',
		sessionId: lease.session.sessionId,
		generation: lease.generation,
		operation: 'set',
		path,
		targetKind,
		activity,
	};
	return { lease, sourceRuntime: lease.runtime, event };
}

function clearRequest(
	lease: ActivityLease,
	path: string,
	targetKind: 'file' | 'folder' = 'file',
): HostAgentActivityRequest {
	const event: AgentActivityRequested = {
		type: 'session.agentActivityRequested',
		sessionId: lease.session.sessionId,
		generation: lease.generation,
		operation: 'clear',
		path,
		targetKind,
	};
	return { lease, sourceRuntime: lease.runtime, event };
}

function createHarness(
	overrides: Partial<AgentActivityGraphBridgeOptions> = {},
): BridgeHarness {
	const posts: CapturedPost[] = [];
	const validations: CapturedValidation[] = [];
	const invalidations: BridgeHarness['invalidations'] = [];
	const resolverCalls: string[] = [];
	const bridge = new AgentActivityGraphBridge({
		postMessage: (message) => {
			const result = new Deferred<boolean>();
			posts.push({ message, result });
			return result.promise;
		},
		resolveWorkspace: (workspaceRootId) => {
			resolverCalls.push(workspaceRootId);
			return { ok: true, root: ROOT };
		},
		invalidateLease: (lease, failure) => {
			invalidations.push({ lease, failure });
		},
		validateSetTarget: () => {
			const result = new Deferred<boolean>();
			validations.push({ result });
			return result.promise;
		},
		...overrides,
	});
	return {
		bridge,
		posts,
		validations,
		invalidations,
		resolverCalls,
	};
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function disposeHarness(harness: BridgeHarness): Promise<void> {
	harness.bridge.disposePanel();
	for (const validation of harness.validations) {
		validation.result.resolve(false);
	}
	for (const post of harness.posts) {
		post.result.resolve(false);
	}
	await flushAsyncWork();
}

async function settleValidationQueue(
	harness: BridgeHarness,
	expectedTotal: number,
): Promise<void> {
	for (let attempt = 0; attempt <= expectedTotal + 2; attempt += 1) {
		for (const validation of harness.validations) {
			validation.result.resolve(true);
		}
		await flushAsyncWork();
		if (
			harness.validations.length === expectedTotal
			&& harness.validations.every(({ result }) => result.settled)
		) {
			return;
		}
	}
	assert.fail(`validation queue stalled before ${expectedTotal} starts`);
}

async function occupyTargetRange(
	harness: BridgeHarness,
	lease: ActivityLease,
	prefix: string,
	count: number,
): Promise<void> {
	const batchSize = 16;
	for (let offset = 0; offset < count; offset += batchSize) {
		const batchCount = Math.min(batchSize, count - offset);
		const validationStart = harness.validations.length;
		const postStart = harness.posts.length;
		for (let index = 0; index < batchCount; index += 1) {
			harness.bridge.handleRequest(setRequest(
				lease,
				`${prefix}-${offset + index}.ts`,
			));
		}
		for (const validation of harness.validations.slice(validationStart)) {
			validation.result.resolve(true);
		}
		await flushAsyncWork();
		assert.strictEqual(harness.posts.length - postStart, batchCount);
		for (const post of harness.posts.slice(postStart)) {
			post.result.resolve(true);
		}
		await flushAsyncWork();
	}
}

function trackedReceiptId(post: CapturedPost): number {
	assert.strictEqual(post.message.type, 'agent.activity.clearTracked');
	return post.message.receiptId;
}

async function establishPendingClearReceipt(
	harness: BridgeHarness,
	lease: ActivityLease,
	path: string,
): Promise<number> {
	harness.bridge.handleRequest(setRequest(lease, path));
	harness.validations.at(-1)?.result.resolve(true);
	await flushAsyncWork();
	harness.posts.at(-1)?.result.resolve(true);
	await flushAsyncWork();
	harness.bridge.handleRequest(clearRequest(lease, path));
	const clearPost = harness.posts.at(-1);
	assert.ok(clearPost);
	const receiptId = trackedReceiptId(clearPost);
	clearPost.result.resolve(true);
	await flushAsyncWork();
	return receiptId;
}

async function establishOverlappingReceiptChain(
	harness: BridgeHarness,
	lease: ActivityLease,
	path: string,
): Promise<Readonly<{
	oldReceiptId: number;
	firstSetPost: CapturedPost;
	replacementClearPost: CapturedPost;
	replacementReceiptId: number;
	secondSetPost: CapturedPost;
}>> {
	const oldReceiptId = await establishPendingClearReceipt(harness, lease, path);
	harness.bridge.handleRequest(setRequest(lease, path, 'editing'));
	harness.validations.at(-1)?.result.resolve(true);
	await flushAsyncWork();
	const firstSetPost = harness.posts.at(-1);
	assert.ok(firstSetPost);

	harness.bridge.handleRequest(clearRequest(lease, path));
	const replacementClearPost = harness.posts.at(-1);
	assert.ok(replacementClearPost);
	const replacementReceiptId = trackedReceiptId(replacementClearPost);

	harness.bridge.handleRequest(setRequest(lease, path, 'completed'));
	harness.validations.at(-1)?.result.resolve(true);
	await flushAsyncWork();
	const secondSetPost = harness.posts.at(-1);
	assert.ok(secondSetPost);
	return {
		oldReceiptId,
		firstSetPost,
		replacementClearPost,
		replacementReceiptId,
		secondSetPost,
	};
}

suite('Host Agent Activity Graph bridge', () => {
	test('set validation은 fresh resolver 3회 뒤 exact Source file/activity를 post한다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleAgentActivityRequest(
				setRequest(lease, 'src/file.ts', 'editing'),
			);
			assert.strictEqual(harness.resolverCalls.length, 2);
			assert.strictEqual(harness.validations.length, 1);
			assert.strictEqual(harness.posts.length, 0);

			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();

			assert.strictEqual(harness.resolverCalls.length, 3);
			assert.deepStrictEqual(harness.posts[0]?.message, {
				type: 'agent.activity.set',
				sessionId: lease.session.sessionId,
				target: {
					nodeId: `file:${vscode.Uri.joinPath(
						ROOT_URI,
						'src',
						'file.ts',
					).toString()}`,
				},
				activity: 'editing',
			});
			harness.posts[0]?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('root와 folder target도 기존 Graph Source ID를 그대로 사용한다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, '.', 'active', 'folder'));
			harness.bridge.handleRequest(
				setRequest(lease, 'src/components', 'planned', 'folder'),
			);
			harness.validations[0]?.result.resolve(true);
			harness.validations[1]?.result.resolve(true);
			await flushAsyncWork();

			assert.deepStrictEqual(
				harness.posts.map(({ message }) => message.type === 'agent.activity.set'
					? message.target.nodeId
					: undefined),
				[
					ROOT_ID,
					`folder:${vscode.Uri.joinPath(
						ROOT_URI,
						'src',
						'components',
					).toString()}`,
				],
			);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('set1→set2 validation 역순 settlement은 latest set 하나만 post한다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, 'same.ts', 'planned'));
			harness.bridge.handleRequest(setRequest(lease, 'same.ts', 'completed'));
			assert.strictEqual(harness.validations.length, 2);

			harness.validations[1]?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, 1);
			assert.strictEqual(
				harness.posts[0]?.message.type === 'agent.activity.set'
					? harness.posts[0].message.activity
					: undefined,
				'completed',
			);

			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, 1);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('set→clear tombstone은 running validation의 늦은 set post를 차단한다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, 'tombstone.ts'));
			harness.bridge.handleRequest(clearRequest(lease, 'tombstone.ts'));
			/** clear는 set 전용 filesystem validator 경계를 호출하지 않는다. */
			assert.strictEqual(harness.validations.length, 1);
			assert.strictEqual(harness.posts.length, 0);

			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, 0);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('clear→set은 이전 post settlement를 기다리지 않고 invocation FIFO를 지킨다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, 'fifo.ts', 'active'));
			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts[0]?.message.type, 'agent.activity.set');

			harness.bridge.handleRequest(clearRequest(lease, 'fifo.ts'));
			assert.strictEqual(harness.posts[1]?.message.type, 'agent.activity.clearTracked');
			harness.bridge.handleRequest(setRequest(lease, 'fifo.ts', 'editing'));
			harness.validations[1]?.result.resolve(true);
			await flushAsyncWork();

			assert.deepStrictEqual(
				harness.posts.map(({ message }) => message.type),
				[
					'agent.activity.set',
					'agent.activity.clearTracked',
					'agent.activity.set',
				],
			);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('overlapping set post가 모두 false여도 settlement 순서와 무관하게 slot을 복원한다', async () => {
		for (const settlementOrder of [[0, 1], [1, 0]] as const) {
			const harness = createHarness();
			const lease = createLease(`session-set-race-${settlementOrder[0]}`);
			try {
				harness.bridge.handleRequest(setRequest(lease, 'race.ts', 'active'));
				harness.validations[0]?.result.resolve(true);
				await flushAsyncWork();
				harness.bridge.handleRequest(setRequest(lease, 'race.ts', 'editing'));
				harness.validations[1]?.result.resolve(true);
				await flushAsyncWork();
				assert.strictEqual(harness.posts.length, 2);
				assert.strictEqual(
					harness.bridge.getPanelSnapshotForTest().activeTargets,
					1,
				);

				harness.posts[settlementOrder[0]]?.result.resolve(false);
				await flushAsyncWork();
				harness.posts[settlementOrder[1]]?.result.resolve(false);
				await flushAsyncWork();
				assert.strictEqual(
					harness.bridge.getPanelSnapshotForTest().activeTargets,
					0,
				);
			} finally {
				await disposeHarness(harness);
			}
		}
	});

	test('older set posted=true와 newer set false 조합은 conservative slot을 유지한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-set-mixed-settlement');
		try {
			harness.bridge.handleRequest(setRequest(lease, 'mixed.ts', 'active'));
			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.bridge.handleRequest(setRequest(lease, 'mixed.ts', 'editing'));
			harness.validations[1]?.result.resolve(true);
			await flushAsyncWork();

			harness.posts[1]?.result.resolve(false);
			harness.posts[0]?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('set→clear post가 모두 false인 두 settlement 순서도 provisional slot을 복원한다', async () => {
		for (const settlementOrder of [[0, 1], [1, 0]] as const) {
			const harness = createHarness();
			const lease = createLease(`session-clear-race-${settlementOrder[0]}`);
			try {
				harness.bridge.handleRequest(setRequest(lease, 'clear-race.ts'));
				harness.validations[0]?.result.resolve(true);
				await flushAsyncWork();
				harness.bridge.handleRequest(clearRequest(lease, 'clear-race.ts'));
				assert.strictEqual(harness.posts.length, 2);

				harness.posts[settlementOrder[0]]?.result.resolve(false);
				await flushAsyncWork();
				harness.posts[settlementOrder[1]]?.result.resolve(false);
				await flushAsyncWork();
				assert.strictEqual(
					harness.bridge.getPanelSnapshotForTest().activeTargets,
					0,
				);
			} finally {
				await disposeHarness(harness);
			}
		}
	});

	test('clear post synchronous throw 뒤 pending set false도 slot을 복원한다', async () => {
		const setPost = new Deferred<boolean>();
		const invocations: ExtensionToWebviewMessage[] = [];
		const harness = createHarness({
			postMessage: (message) => {
				invocations.push(message);
				if (message.type === 'agent.activity.clearTracked') {
					throw new Error('synthetic clear post failure');
				}
				return setPost.promise;
			},
		});
		const lease = createLease('session-clear-throw');
		try {
			harness.bridge.handleRequest(setRequest(lease, 'throw.ts'));
			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.bridge.handleRequest(clearRequest(lease, 'throw.ts'));
			assert.deepStrictEqual(
				invocations.map(({ type }) => type),
				['agent.activity.set', 'agent.activity.clearTracked'],
			);
			setPost.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('target clear receipt-first는 occupancy만 정산하고 post cap은 settlement까지 유지한다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, 'receipt.ts'));
			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.posts[0]?.result.resolve(true);
			await flushAsyncWork();

			harness.bridge.handleRequest(clearRequest(lease, 'receipt.ts'));
			const clearPost = harness.posts[1];
			assert.ok(clearPost);
			const receiptId = trackedReceiptId(clearPost);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().postPendingEvents, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().postPendingEvents, 1);

			clearPost.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().postPendingEvents, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('newer set validation=false는 기존 clear receipt와 occupancy 정산 경로를 보존한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-validation-drop');
		try {
			const receiptId = await establishPendingClearReceipt(
				harness,
				lease,
				'validation-drop.ts',
			);
			harness.bridge.handleRequest(setRequest(lease, 'validation-drop.ts'));
			harness.validations.at(-1)?.result.resolve(false);
			await flushAsyncWork();

			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('newer set post=false의 receipt-first/failure-first 모두 기존 clear를 복원한다', async () => {
		for (const receiptFirst of [false, true]) {
			const harness = createHarness();
			const lease = createLease(`session-receipt-set-false-${receiptFirst}`);
			try {
				const receiptId = await establishPendingClearReceipt(
					harness,
					lease,
					'set-false.ts',
				);
				harness.bridge.handleRequest(setRequest(lease, 'set-false.ts', 'editing'));
				harness.validations.at(-1)?.result.resolve(true);
				await flushAsyncWork();
				const replacementPost = harness.posts.at(-1);
				assert.ok(replacementPost);

				if (receiptFirst) {
					assert.strictEqual(harness.bridge.handleWebviewMessage({
						type: 'agent.activity.clearApplied',
						receiptId,
					}), true);
					assert.strictEqual(
						harness.bridge.getPanelSnapshotForTest().activeTargets,
						1,
					);
					replacementPost.result.resolve(false);
					await flushAsyncWork();
				} else {
					replacementPost.result.resolve(false);
					await flushAsyncWork();
					assert.strictEqual(
						harness.bridge.getPanelSnapshotForTest().receiptCount,
						1,
					);
					assert.strictEqual(harness.bridge.handleWebviewMessage({
						type: 'agent.activity.clearApplied',
						receiptId,
					}), true);
				}
				assert.strictEqual(
					harness.bridge.getPanelSnapshotForTest().activeTargets,
					0,
				);
			} finally {
				await disposeHarness(harness);
			}
		}
	});

	test('newer set post synchronous throw도 기존 clear receipt를 복원한다', async () => {
		const invocations: ExtensionToWebviewMessage[] = [];
		const postResults: Deferred<boolean>[] = [];
		const harness = createHarness({
			postMessage: (message) => {
				invocations.push(message);
				if (invocations.length === 3) {
					throw new Error('synthetic replacement post failure');
				}
				const result = new Deferred<boolean>();
				postResults.push(result);
				return result.promise;
			},
		});
		const lease = createLease('session-receipt-set-throw');
		try {
			harness.bridge.handleRequest(setRequest(lease, 'set-throw.ts'));
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			postResults[0]?.resolve(true);
			await flushAsyncWork();

			harness.bridge.handleRequest(clearRequest(lease, 'set-throw.ts'));
			const clearMessage = invocations[1];
			assert.strictEqual(clearMessage?.type, 'agent.activity.clearTracked');
			const receiptId = clearMessage.receiptId;
			postResults[1]?.resolve(true);
			await flushAsyncWork();

			harness.bridge.handleRequest(setRequest(lease, 'set-throw.ts', 'editing'));
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(invocations.length, 3);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('겹친 set/clear가 모두 false여도 old receipt를 settlement 순서와 무관하게 복원한다', async () => {
		for (const receiptFirst of [false, true]) {
			const harness = createHarness();
			const lease = createLease(`session-receipt-chain-${receiptFirst}`);
			try {
				const chain = await establishOverlappingReceiptChain(
					harness,
					lease,
					'chain.ts',
				);
				assert.strictEqual(
					harness.bridge.getPanelSnapshotForTest().deferredReceiptLineageCount,
					2,
				);
				assert.strictEqual(
					harness.bridge.getPanelSnapshotForTest().receiptCount,
					2,
				);
				if (receiptFirst) {
					assert.strictEqual(harness.bridge.handleWebviewMessage({
						type: 'agent.activity.clearApplied',
						receiptId: chain.oldReceiptId,
					}), true);
					assert.strictEqual(
						harness.bridge.getPanelSnapshotForTest().activeTargets,
						1,
					);
				}

				const settlementOrder = receiptFirst
					? [chain.firstSetPost, chain.replacementClearPost, chain.secondSetPost]
					: [chain.secondSetPost, chain.replacementClearPost, chain.firstSetPost];
				for (const post of settlementOrder) {
					post.result.resolve(false);
					await flushAsyncWork();
				}

				if (!receiptFirst) {
					assert.strictEqual(
						harness.bridge.getPanelSnapshotForTest().receiptCount,
						1,
					);
					assert.strictEqual(harness.bridge.handleWebviewMessage({
						type: 'agent.activity.clearApplied',
						receiptId: chain.oldReceiptId,
					}), true);
				}
				assert.strictEqual(
					harness.bridge.getPanelSnapshotForTest().activeTargets,
					0,
				);
			} finally {
				await disposeHarness(harness);
			}
		}
	});

	test('receipt-first clear와 rotating set anchor 반복은 deferred lineage를 상수로 fold한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-lineage-fold');
		const cycleCount = 200;
		try {
			harness.bridge.handleRequest(setRequest(lease, 'fold.ts'));
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			harness.posts.at(-1)?.result.resolve(true);
			await flushAsyncWork();

			harness.bridge.handleRequest(clearRequest(lease, 'fold.ts'));
			const initialClear = harness.posts.at(-1);
			assert.ok(initialClear);
			const initialReceiptId = trackedReceiptId(initialClear);
			initialClear.result.resolve(true);
			await flushAsyncWork();

			harness.bridge.handleRequest(setRequest(lease, 'fold.ts', 'editing'));
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			let anchor = harness.posts.at(-1);
			assert.ok(anchor);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: initialReceiptId,
			}), true);

			for (let index = 0; index < cycleCount; index += 1) {
				harness.bridge.handleRequest(clearRequest(lease, 'fold.ts'));
				const clearPost = harness.posts.at(-1);
				assert.ok(clearPost);
				const receiptId = trackedReceiptId(clearPost);

				harness.bridge.handleRequest(setRequest(
					lease,
					'fold.ts',
					index % 2 === 0 ? 'active' : 'completed',
				));
				harness.validations.at(-1)?.result.resolve(true);
				await flushAsyncWork();
				const nextAnchor = harness.posts.at(-1);
				assert.ok(nextAnchor);

				assert.strictEqual(harness.bridge.handleWebviewMessage({
					type: 'agent.activity.clearApplied',
					receiptId,
				}), true);
				let snapshot = harness.bridge.getPanelSnapshotForTest();
				assert.strictEqual(snapshot.deferredReceiptLineageCount, 1);
				assert.strictEqual(snapshot.receiptCount, 0);
				assert.strictEqual(snapshot.postPendingEvents, 3);
				assert.strictEqual(snapshot.activeTargets, 1);

				clearPost.result.resolve(false);
				anchor.result.resolve(false);
				await flushAsyncWork();
				anchor = nextAnchor;
				snapshot = harness.bridge.getPanelSnapshotForTest();
				assert.strictEqual(snapshot.deferredReceiptLineageCount, 1);
				assert.strictEqual(snapshot.receiptCount, 0);
				assert.strictEqual(snapshot.postPendingEvents, 1);
				assert.strictEqual(snapshot.activeTargets, 1);
			}

			anchor.result.resolve(false);
			await flushAsyncWork();
			const finalSnapshot = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(finalSnapshot.deferredReceiptLineageCount, 0);
			assert.strictEqual(finalSnapshot.receiptCount, 0);
			assert.strictEqual(finalSnapshot.postPendingEvents, 0);
			assert.strictEqual(finalSnapshot.activeTargets, 0);
			assert.strictEqual(harness.invalidations.length, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('newer applied clear는 그때까지 보존된 older unapplied receipt만 fold한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-unapplied-fold');
		try {
			const chain = await establishOverlappingReceiptChain(
				harness,
				lease,
				'unapplied-fold.ts',
			);
			let snapshot = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(snapshot.deferredReceiptLineageCount, 2);
			assert.strictEqual(snapshot.receiptCount, 2);

			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: chain.replacementReceiptId,
			}), true);
			snapshot = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(snapshot.deferredReceiptLineageCount, 1);
			assert.strictEqual(snapshot.receiptCount, 0);

			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: chain.oldReceiptId,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
			chain.replacementClearPost.result.resolve(false);
			chain.firstSetPost.result.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
			chain.secondSetPost.result.resolve(false);
			await flushAsyncWork();
			snapshot = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(snapshot.deferredReceiptLineageCount, 0);
			assert.strictEqual(snapshot.activeTargets, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('deferred newer clear post=true는 old receipt만 stale 처리한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-clear-replacement');
		try {
			const chain = await establishOverlappingReceiptChain(
				harness,
				lease,
				'clear-replacement.ts',
			);
			chain.replacementClearPost.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: chain.oldReceiptId,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);

			chain.secondSetPost.result.resolve(false);
			chain.firstSetPost.result.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: chain.replacementReceiptId,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('later set post=true는 자신보다 오래된 clear receipt를 모두 stale 처리한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-set-replacement');
		try {
			const chain = await establishOverlappingReceiptChain(
				harness,
				lease,
				'set-replacement.ts',
			);
			chain.secondSetPost.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 0);
			for (const receiptId of [
				chain.oldReceiptId,
				chain.replacementReceiptId,
			]) {
				assert.strictEqual(harness.bridge.handleWebviewMessage({
					type: 'agent.activity.clearApplied',
					receiptId,
				}), true);
			}
			chain.replacementClearPost.result.resolve(false);
			chain.firstSetPost.result.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('newer set POST cap drop은 기존 clear receipt를 stale 처리하지 않는다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-post-cap');
		try {
			const receiptId = await establishPendingClearReceipt(
				harness,
				lease,
				'post-cap.ts',
			);
			for (let index = 0; index < POST_PENDING_PER_SESSION_EVENTS; index += 1) {
				harness.bridge.handleRequest(setRequest(lease, `cap-${index}.ts`));
			}
			await settleValidationQueue(
				harness,
				1 + POST_PENDING_PER_SESSION_EVENTS,
			);
			const postCountAtCap = harness.posts.length;
			const activeAtCap = harness.bridge.getPanelSnapshotForTest().activeTargets;

			harness.bridge.handleRequest(setRequest(lease, 'post-cap.ts', 'editing'));
			await settleValidationQueue(
				harness,
				2 + POST_PENDING_PER_SESSION_EVENTS,
			);
			assert.strictEqual(harness.posts.length, postCountAtCap);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId,
			}), true);
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().activeTargets,
				activeAtCap - 1,
			);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('newer clear POST cap drop도 deferred old receipt를 보존한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-clear-post-cap');
		try {
			const receiptId = await establishPendingClearReceipt(
				harness,
				lease,
				'clear-post-cap.ts',
			);
			harness.bridge.handleRequest(
				setRequest(lease, 'clear-post-cap.ts', 'editing'),
			);
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			const replacementSet = harness.posts.at(-1);
			assert.ok(replacementSet);

			for (let index = 0; index < POST_PENDING_PER_SESSION_EVENTS - 1; index += 1) {
				harness.bridge.handleRequest(setRequest(lease, `clear-cap-${index}.ts`));
			}
			await settleValidationQueue(
				harness,
				1 + POST_PENDING_PER_SESSION_EVENTS,
			);
			const postsAtCap = harness.posts.length;
			harness.bridge.handleRequest(clearRequest(lease, 'clear-post-cap.ts'));
			assert.strictEqual(harness.posts.length, postsAtCap);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);

			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId,
			}), true);
			assert.ok(harness.bridge.getPanelSnapshotForTest().activeTargets > 0);
			replacementSet.result.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().activeTargets,
				POST_PENDING_PER_SESSION_EVENTS - 1,
			);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('failure-first late receipt는 무시하고 clearSession receipt만 retired quota를 푼다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, 'quota.ts'));
			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.posts[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.bridge.handleRequest(clearRequest(lease, 'quota.ts'));
			const targetClear = harness.posts[1];
			assert.ok(targetClear);
			const targetReceipt = trackedReceiptId(targetClear);
			targetClear.result.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: targetReceipt,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);

			harness.bridge.revokeLease(lease);
			const cleanup = harness.posts[2];
			assert.ok(cleanup);
			assert.strictEqual(cleanup.message.type, 'agent.activity.clearTracked');
			assert.strictEqual(cleanup.message.publicMessage.type, 'agent.activity.clearSession');
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().retiredQuotaCount, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: trackedReceiptId(cleanup),
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().retiredQuotaCount, 0);
			cleanup.result.resolve(true);
			await flushAsyncWork();
		} finally {
			await disposeHarness(harness);
		}
	});

	test('settled target receipt는 revoke clearSession이 subsume한다', async () => {
		const harness = createHarness();
		const lease = createLease('session-receipt-subsumption');
		try {
			harness.bridge.handleRequest(setRequest(lease, 'subsumed.ts'));
			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.posts[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.bridge.handleRequest(clearRequest(lease, 'subsumed.ts'));
			const oldReceiptId = trackedReceiptId(harness.posts[1] as CapturedPost);
			harness.posts[1]?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);

			harness.bridge.revokeLease(lease);
			const cleanup = harness.posts[2];
			assert.ok(cleanup);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: oldReceiptId,
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1);
			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: trackedReceiptId(cleanup),
			}), true);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('count=0 revoke는 receipt state 없이 public clearSession을 same-turn invoke한다', async () => {
		const harness = createHarness();
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, 'dropped.ts'));
			harness.validations[0]?.result.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, 0);

			harness.bridge.revokeLease(lease);
			assert.deepStrictEqual(harness.posts[0]?.message, {
				type: 'agent.activity.clearSession',
				sessionId: lease.session.sessionId,
			});
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 0);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().retiredQuotaCount, 0);
			harness.posts[0]?.result.resolve(true);
			await flushAsyncWork();
		} finally {
			await disposeHarness(harness);
		}
	});

	test('sequence overflow는 exact lease를 fail-closed cleanup한다', async () => {
		const harness = createHarness({ initialSequence: Number.MAX_SAFE_INTEGER });
		const lease = createLease();
		try {
			harness.bridge.handleRequest(setRequest(lease, 'first.ts'));
			harness.bridge.handleRequest(setRequest(lease, 'overflow.ts'));
			assert.strictEqual(harness.invalidations.length, 1);
			assert.strictEqual(harness.invalidations[0]?.lease, lease);
			assert.deepStrictEqual(harness.invalidations[0]?.failure, {
				ok: false,
				code: 'workspace_root_unavailable',
			});
			assert.strictEqual(harness.posts[0]?.message.type, 'agent.activity.clearSession');
		} finally {
			await disposeHarness(harness);
		}
	});

	test('receipt overflow도 quota를 유지한 public clearSession을 same-turn invoke한다', async () => {
		const harness = createHarness({ initialReceiptId: Number.MAX_SAFE_INTEGER });
		const lease = createLease('session-receipt-overflow');
		try {
			for (const path of ['one.ts', 'two.ts']) {
				harness.bridge.handleRequest(setRequest(lease, path));
				harness.validations.at(-1)?.result.resolve(true);
				await flushAsyncWork();
				harness.posts.at(-1)?.result.resolve(true);
				await flushAsyncWork();
			}
			harness.bridge.handleRequest(clearRequest(lease, 'one.ts'));
			assert.strictEqual(
				trackedReceiptId(harness.posts[2] as CapturedPost),
				Number.MAX_SAFE_INTEGER,
			);

			harness.bridge.handleRequest(clearRequest(lease, 'two.ts'));
			assert.strictEqual(harness.invalidations.length, 1);
			assert.deepStrictEqual(harness.posts[3]?.message, {
				type: 'agent.activity.clearSession',
				sessionId: lease.session.sessionId,
			});
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 2);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().retiredQuotaCount, 1);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('target clear POST cap drop은 MAX_SAFE_INTEGER receipt ID를 소모하지 않는다', async () => {
		const harness = createHarness({ initialReceiptId: Number.MAX_SAFE_INTEGER });
		const lease = createLease('session-target-clear-id-admission');
		try {
			harness.bridge.handleRequest(setRequest(lease, 'target.ts'));
			harness.validations[0]?.result.resolve(true);
			await flushAsyncWork();
			harness.posts[0]?.result.resolve(true);
			await flushAsyncWork();

			for (let index = 0; index < POST_PENDING_PER_SESSION_EVENTS; index += 1) {
				harness.bridge.handleRequest(setRequest(lease, `filler-${index}.ts`));
			}
			await settleValidationQueue(
				harness,
				1 + POST_PENDING_PER_SESSION_EVENTS,
			);
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().postPendingEvents,
				POST_PENDING_PER_SESSION_EVENTS,
			);
			const postsAtCap = harness.posts.length;

			harness.bridge.handleRequest(clearRequest(lease, 'target.ts'));
			assert.strictEqual(harness.posts.length, postsAtCap);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 0);
			assert.strictEqual(harness.invalidations.length, 0);

			harness.posts[1]?.result.resolve(false);
			await flushAsyncWork();
			harness.bridge.handleRequest(clearRequest(lease, 'target.ts'));
			const admittedClear = harness.posts.at(-1);
			assert.ok(admittedClear);
			assert.strictEqual(harness.posts.length, postsAtCap + 1);
			assert.strictEqual(
				trackedReceiptId(admittedClear),
				Number.MAX_SAFE_INTEGER,
			);
			assert.strictEqual(harness.invalidations.length, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('cleanup POST cap drop은 MAX_SAFE_INTEGER receipt ID를 소모하지 않는다', async () => {
		const harness = createHarness({ initialReceiptId: Number.MAX_SAFE_INTEGER });
		const firstLease = createLease('session-cleanup-id-first');
		const secondLease = createLease('session-cleanup-id-second');
		try {
			harness.bridge.handleRequest(setRequest(firstLease, 'first.ts'));
			harness.bridge.handleRequest(setRequest(secondLease, 'second.ts'));
			harness.validations[0]?.result.resolve(true);
			harness.validations[1]?.result.resolve(true);
			await flushAsyncWork();
			harness.posts[0]?.result.resolve(true);
			harness.posts[1]?.result.resolve(true);
			await flushAsyncWork();

			for (
				let index = 0;
				index < CLEANUP_POST_PENDING_PER_PANEL_EVENTS;
				index += 1
			) {
				const fillerLease = createLease(`session-cleanup-id-filler-${index}`);
				harness.bridge.handleRequest(clearRequest(fillerLease, 'unused.ts'));
				harness.bridge.revokeLease(fillerLease);
			}
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().cleanupPostPendingEvents,
				CLEANUP_POST_PENDING_PER_PANEL_EVENTS,
			);
			const postsAtCap = harness.posts.length;

			harness.bridge.revokeLease(firstLease);
			assert.strictEqual(harness.posts.length, postsAtCap);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().receiptCount, 0);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().retiredQuotaCount, 1);

			harness.posts[2]?.result.resolve(false);
			await flushAsyncWork();
			harness.bridge.revokeLease(secondLease);
			const admittedCleanup = harness.posts.at(-1);
			assert.ok(admittedCleanup);
			assert.strictEqual(harness.posts.length, postsAtCap + 1);
			assert.strictEqual(
				trackedReceiptId(admittedCleanup),
				Number.MAX_SAFE_INTEGER,
			);
			assert.strictEqual(
				admittedCleanup.message.type === 'agent.activity.clearTracked'
					? admittedCleanup.message.publicMessage.type
					: undefined,
				'agent.activity.clearSession',
			);
			assert.strictEqual(harness.invalidations.length, 0);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('ACTIVE target session/panel N은 허용하고 N+1은 post하지 않는다', async () => {
		const harness = createHarness();
		const leases = [
			createLease('session-active-cap-a'),
			createLease('session-active-cap-b'),
			createLease('session-active-cap-c'),
			createLease('session-active-cap-d'),
		];
		try {
			await occupyTargetRange(harness, leases[0] as ActivityLease, 'a', 256);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 256);
			const sessionCapPosts = harness.posts.length;
			harness.bridge.handleRequest(
				setRequest(leases[0] as ActivityLease, 'a-overflow.ts'),
			);
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, sessionCapPosts);

			await occupyTargetRange(harness, leases[1] as ActivityLease, 'b', 256);
			await occupyTargetRange(harness, leases[2] as ActivityLease, 'c', 256);
			await occupyTargetRange(harness, leases[3] as ActivityLease, 'd', 256);
			assert.strictEqual(harness.bridge.getPanelSnapshotForTest().activeTargets, 1_024);
			const panelCapPosts = harness.posts.length;
			const extraLease = createLease('session-active-cap-extra');
			harness.bridge.handleRequest(setRequest(extraLease, 'panel-overflow.ts'));
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, panelCapPosts);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('same-session retired quota도 ACTIVE per-session N+1 admission을 막는다', async () => {
		const harness = createHarness();
		const firstLease = createLease('session-retired-active-cap');
		try {
			await occupyTargetRange(harness, firstLease, 'retired', 256);
			harness.bridge.revokeLease(firstLease);
			const cleanup = harness.posts.at(-1);
			assert.ok(cleanup);
			assert.strictEqual(cleanup.message.type, 'agent.activity.clearTracked');
			cleanup.result.resolve(true);
			await flushAsyncWork();

			const successor = createSuccessorLease(firstLease, 2);
			const postCount = harness.posts.length;
			harness.bridge.handleRequest(setRequest(successor, 'blocked-by-retired.ts'));
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, postCount);

			assert.strictEqual(harness.bridge.handleWebviewMessage({
				type: 'agent.activity.clearApplied',
				receiptId: trackedReceiptId(cleanup),
			}), true);
			harness.bridge.handleRequest(setRequest(successor, 'after-retired-receipt.ts'));
			harness.validations.at(-1)?.result.resolve(true);
			await flushAsyncWork();
			assert.strictEqual(harness.posts.length, postCount + 1);
		} finally {
			await disposeHarness(harness);
		}
	});

	test('extension validation 16 cap은 disposed panel work settlement까지 새 panel을 막는다', async () => {
		const baseline = getAgentActivityGraphRegistrySnapshotForTest();
		const first = createHarness();
		const second = createHarness();
		const firstLease = createLease('session-global-validation-a');
		const secondLease = createLease('session-global-validation-b');
		try {
			for (let index = 0; index < 17; index += 1) {
				first.bridge.handleRequest(setRequest(firstLease, `hung-${index}.ts`));
			}
			assert.strictEqual(first.validations.length, 16);
			assert.strictEqual(first.bridge.getPanelSnapshotForTest().validationQueueLength, 1);
			second.bridge.handleRequest(setRequest(secondLease, 'waiting.ts'));
			assert.strictEqual(second.validations.length, 0);

			first.bridge.disposePanel();
			assert.strictEqual(second.validations.length, 0);
			assert.strictEqual(
				getAgentActivityGraphRegistrySnapshotForTest().detachedValidations,
				baseline.detachedValidations + 16,
			);

			first.validations[0]?.result.resolve(false);
			await flushAsyncWork();
			assert.strictEqual(second.validations.length, 1);
			second.validations[0]?.result.resolve(false);
			for (const validation of first.validations.slice(1)) {
				validation.result.resolve(false);
			}
			await flushAsyncWork();
			assert.strictEqual(
				getAgentActivityGraphRegistrySnapshotForTest().detachedValidations,
				baseline.detachedValidations,
			);
		} finally {
			await disposeHarness(first);
			await disposeHarness(second);
		}
	});

	test('panel dispose는 hung work를 path-free global ownership으로 옮기고 settlement만 release한다', async () => {
		const baseline = getAgentActivityGraphRegistrySnapshotForTest();
		const validationHarness = createHarness();
		const validationLease = createLease('session-detached-validation');
		validationHarness.bridge.handleRequest(setRequest(validationLease, 'secret/path.ts'));
		validationHarness.bridge.disposePanel();
		let snapshot = getAgentActivityGraphRegistrySnapshotForTest();
		assert.strictEqual(
			snapshot.detachedValidations,
			baseline.detachedValidations + 1,
		);
		assert.strictEqual(
			snapshot.hostPendingEvents,
			baseline.hostPendingEvents + 1,
		);
		validationHarness.validations[0]?.result.resolve(false);
		await flushAsyncWork();
		snapshot = getAgentActivityGraphRegistrySnapshotForTest();
		assert.strictEqual(snapshot.detachedValidations, baseline.detachedValidations);
		assert.strictEqual(snapshot.hostPendingEvents, baseline.hostPendingEvents);

		const postHarness = createHarness();
		const postLease = createLease('session-detached-post');
		postHarness.bridge.handleRequest(setRequest(postLease, 'post/path.ts'));
		postHarness.validations[0]?.result.resolve(true);
		await flushAsyncWork();
		postHarness.bridge.disposePanel();
		snapshot = getAgentActivityGraphRegistrySnapshotForTest();
		assert.strictEqual(snapshot.detachedPosts, baseline.detachedPosts + 1);
		assert.strictEqual(
			snapshot.postWorkPendingEvents,
			baseline.postWorkPendingEvents + 1,
		);
		postHarness.posts[0]?.result.resolve(false);
		await flushAsyncWork();
		snapshot = getAgentActivityGraphRegistrySnapshotForTest();
		assert.strictEqual(snapshot.detachedPosts, baseline.detachedPosts);
		assert.strictEqual(
			snapshot.postWorkPendingEvents,
			baseline.postWorkPendingEvents,
		);
	});
});
