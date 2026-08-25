import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { McpSessionRuntime } from '../../mcp/sessionRuntime';
import {
	ACTIVITY_IPC_MAX_UTF8_BYTES,
	PATH_MAX_UTF8_BYTES,
	type AgentActivityRequested,
} from '../../mcp/agentActivityProtocol';
import { ID_MAX_LENGTH } from '../../agent/protocol/limits';
import {
	clearAgentActivitiesBySession,
	setAgentActivity,
	type ExtensionToWebviewMessage,
} from '../../messages';
import {
	ACTIVE_TARGETS_PER_PANEL,
	ACTIVE_TARGETS_PER_SESSION,
	AgentActivityGraphBridge,
	CLEANUP_POST_PENDING_PER_PANEL_BYTES,
	CLEANUP_POST_PENDING_PER_PANEL_EVENTS,
	getAgentActivityGraphRegistrySnapshotForTest,
	HOST_PENDING_PER_EXTENSION_BYTES,
	HOST_PENDING_PER_EXTENSION_EVENTS,
	HOST_PENDING_PER_PANEL_BYTES,
	HOST_PENDING_PER_PANEL_EVENTS,
	HOST_PENDING_PER_SESSION_BYTES,
	HOST_PENDING_PER_SESSION_EVENTS,
	POST_PENDING_PER_PANEL_BYTES,
	POST_PENDING_PER_PANEL_EVENTS,
	POST_PENDING_PER_SESSION_BYTES,
	POST_PENDING_PER_SESSION_EVENTS,
	POST_WORK_PENDING_PER_EXTENSION_BYTES,
	POST_WORK_PENDING_PER_EXTENSION_EVENTS,
	wireUtf8Bytes,
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
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

const ROOT_URI = vscode.Uri.file('/trusted/activity-graph-bridge-caps');
const ROOT_ID = createWorkspaceRootId(ROOT_URI);
const ROOT_FS_PATH = ROOT_URI.fsPath;
const ROOT = {
	id: ROOT_ID,
	scheme: 'file',
	fsPath: ROOT_FS_PATH as ValidatedWorkspaceFsPath,
	workspaceFolder: {
		name: 'activity-graph-bridge-caps',
		index: 0,
		uri: ROOT_URI,
	},
} as unknown as ValidatedWorkspaceRoot;

const IDLE_REGISTRY: AgentActivityGraphRegistrySnapshot = Object.freeze({
	hostPendingEvents: 0,
	hostPendingBytes: 0,
	validationsInFlight: 0,
	postWorkPendingEvents: 0,
	postWorkPendingBytes: 0,
	detachedValidations: 0,
	detachedValidationBytes: 0,
	detachedPosts: 0,
	detachedPostBytes: 0,
});

class Deferred<Value> {
	readonly promise: Promise<Value>;
	settled = false;
	private resolvePromise!: (value: Value) => void;

	constructor() {
		this.promise = new Promise<Value>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: Value): void {
		if (!this.settled) {
			this.settled = true;
			this.resolvePromise(value);
		}
	}
}

interface CapturedPost {
	readonly message: ExtensionToWebviewMessage;
	readonly result: Deferred<boolean>;
}

interface BridgeHarness {
	readonly bridge: AgentActivityGraphBridge;
	readonly posts: CapturedPost[];
	readonly validations: Deferred<boolean>[];
	readonly invalidations: Array<Readonly<{
		lease: ActivityLease;
		failure: WorkspaceValidationFailure;
	}>>;
}

interface ByteCandidate {
	readonly harness: BridgeHarness;
	readonly lease: ActivityLease;
	readonly path: string;
	readonly bytes: number;
}

function captureIdleRegistry(): AgentActivityGraphRegistrySnapshot {
	const baseline = getAgentActivityGraphRegistrySnapshotForTest();
	assert.deepStrictEqual(baseline, IDLE_REGISTRY);
	return baseline;
}

function createLease(sessionId: string, epoch = 1): ActivityLease {
	const generation = `generation-${sessionId}-${epoch}`;
	return {
		session: { sessionId } as TerminalSession,
		assignment: {
			providerId: 'codex',
			workspaceRootId: ROOT_ID,
		},
		providerId: 'codex',
		workspaceRootId: ROOT_ID,
		runtime: {
			sessionId,
			generation,
			lifecycle: 'running',
		} as McpSessionRuntime,
		generation,
		launchRootUri: ROOT_URI.toString(),
		launchRootFsPath: ROOT_FS_PATH,
		epoch,
		revoked: false,
	};
}

function setRequest(lease: ActivityLease, path: string): HostAgentActivityRequest {
	const event: AgentActivityRequested = {
		type: 'session.agentActivityRequested',
		sessionId: lease.session.sessionId,
		generation: lease.generation,
		operation: 'set',
		path,
		targetKind: 'file',
		activity: 'active',
	};
	return { lease, sourceRuntime: lease.runtime, event };
}

function clearRequest(lease: ActivityLease, path: string): HostAgentActivityRequest {
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

function createHarness(
	overrides: Partial<AgentActivityGraphBridgeOptions> = {},
): BridgeHarness {
	const posts: CapturedPost[] = [];
	const validations: Deferred<boolean>[] = [];
	const invalidations: BridgeHarness['invalidations'] = [];
	const bridge = new AgentActivityGraphBridge({
		postMessage: (message) => {
			const result = new Deferred<boolean>();
			posts.push({ message, result });
			return result.promise;
		},
		resolveWorkspace: () => ({ ok: true, root: ROOT }),
		invalidateLease: (lease, failure) => {
			invalidations.push({ lease, failure });
		},
		validateSetTarget: () => {
			const result = new Deferred<boolean>();
			validations.push(result);
			return result.promise;
		},
		...overrides,
	});
	return { bridge, posts, validations, invalidations };
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settleValidations(
	harnesses: readonly BridgeHarness[],
	expectedTotal: number,
	result = true,
): Promise<void> {
	for (let attempt = 0; attempt <= expectedTotal + 2; attempt += 1) {
		const validations = harnesses.flatMap((harness) => harness.validations);
		assert.ok(validations.length <= expectedTotal);
		for (const validation of validations) {
			validation.resolve(result);
		}
		await flushAsyncWork();
		const after = harnesses.flatMap((harness) => harness.validations);
		if (
			after.length === expectedTotal
			&& after.every((validation) => validation.settled)
		) {
			await flushAsyncWork();
			return;
		}
	}
	assert.fail(`validation pump stalled before ${expectedTotal} starts`);
}

async function disposeHarnesses(
	harnesses: readonly BridgeHarness[],
	baseline: AgentActivityGraphRegistrySnapshot,
): Promise<void> {
	for (const harness of harnesses) {
		harness.bridge.disposePanel();
	}
	for (const harness of harnesses) {
		for (const validation of harness.validations) {
			validation.resolve(false);
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
}

function shortPath(prefix: string, index: number): string {
	return `${prefix}-${index.toString().padStart(4, '0')}.ts`;
}

/** Produces a valid, unique event whose exact child IPC wire size is 8 KiB. */
function maxIpcPath(lease: ActivityLease, index: number): string {
	const prefix = `p${index.toString().padStart(5, '0')}-`;
	const baseBytes = wireUtf8Bytes(setRequest(lease, prefix).event);
	const missingBytes = ACTIVITY_IPC_MAX_UTF8_BYTES - baseBytes;
	assert.ok(missingBytes >= 0);
	const quoteCount = Math.floor(missingBytes / 2);
	const asciiCount = missingBytes - (quoteCount * 2);
	const path = `${prefix}${'"'.repeat(quoteCount)}${'x'.repeat(asciiCount)}`;
	assert.ok(Buffer.byteLength(path, 'utf8') <= PATH_MAX_UTF8_BYTES);
	assert.strictEqual(
		wireUtf8Bytes(setRequest(lease, path).event),
		ACTIVITY_IPC_MAX_UTF8_BYTES,
	);
	return path;
}

function createByteCandidate(
	harness: BridgeHarness,
	lease: ActivityLease,
	index: number,
): ByteCandidate {
	const path = maxIpcPath(lease, index);
	const message = setAgentActivity(
		lease.session.sessionId,
		{
			nodeId: `file:${vscode.Uri.joinPath(ROOT_URI, path).toString()}`,
		},
		'active',
	);
	return { harness, lease, path, bytes: wireUtf8Bytes(message) };
}

function submitCandidates(candidates: readonly ByteCandidate[]): void {
	for (const candidate of candidates) {
		candidate.harness.bridge.handleRequest(
			setRequest(candidate.lease, candidate.path),
		);
	}
}

async function occupyTargetRange(
	harness: BridgeHarness,
	lease: ActivityLease,
	prefix: string,
	count: number,
): Promise<void> {
	for (let offset = 0; offset < count; offset += 16) {
		const batchCount = Math.min(16, count - offset);
		const validationTotal = harness.validations.length + batchCount;
		const postStart = harness.posts.length;
		for (let index = 0; index < batchCount; index += 1) {
			harness.bridge.handleRequest(setRequest(
				lease,
				shortPath(prefix, offset + index),
			));
		}
		await settleValidations([harness], validationTotal);
		assert.strictEqual(harness.posts.length - postStart, batchCount);
		for (const post of harness.posts.slice(postStart)) {
			post.result.resolve(true);
		}
		await flushAsyncWork();
		assert.strictEqual(
			harness.bridge.getPanelSnapshotForTest().postPendingEvents,
			0,
		);
	}
}

suite('Host Agent Activity Graph bridge hard caps', () => {
	test('HOST session event N은 허용하고 작은 N+1은 byte cap 전에 거절한다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const lease = createLease('host-session-event');
		try {
			for (let index = 0; index < HOST_PENDING_PER_SESSION_EVENTS; index += 1) {
				harness.bridge.handleRequest(setRequest(
					lease,
					shortPath('host-session-event', index),
				));
			}
			const before = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(before.hostPendingEvents, HOST_PENDING_PER_SESSION_EVENTS);
			assert.ok(before.hostPendingBytes < HOST_PENDING_PER_SESSION_BYTES);

			harness.bridge.handleRequest(setRequest(lease, 'host-session-overflow.ts'));
			assert.deepStrictEqual(harness.bridge.getPanelSnapshotForTest(), before);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('HOST session byte N은 IPC 최대 event N과 함께 차고 N+1은 원자적으로 거절된다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const lease = createLease('host-session-byte');
		try {
			assert.strictEqual(
				HOST_PENDING_PER_SESSION_EVENTS * ACTIVITY_IPC_MAX_UTF8_BYTES,
				HOST_PENDING_PER_SESSION_BYTES,
			);
			for (let index = 0; index < HOST_PENDING_PER_SESSION_EVENTS; index += 1) {
				harness.bridge.handleRequest(setRequest(lease, maxIpcPath(lease, index)));
			}
			const before = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(before.hostPendingEvents, HOST_PENDING_PER_SESSION_EVENTS);
			assert.strictEqual(before.hostPendingBytes, HOST_PENDING_PER_SESSION_BYTES);

			harness.bridge.handleRequest(setRequest(
				lease,
				maxIpcPath(lease, HOST_PENDING_PER_SESSION_EVENTS),
			));
			assert.deepStrictEqual(harness.bridge.getPanelSnapshotForTest(), before);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('HOST panel event N/N+1은 동률인 extension event cap과 함께 경계를 지킨다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const leases = Array.from(
			{ length: 4 },
			(_, index) => createLease(`host-panel-event-${index}`),
		);
		try {
			for (const lease of leases) {
				for (let index = 0; index < HOST_PENDING_PER_SESSION_EVENTS; index += 1) {
					harness.bridge.handleRequest(setRequest(
						lease,
						shortPath('host-panel-event', index),
					));
				}
			}
			const before = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(before.hostPendingEvents, HOST_PENDING_PER_PANEL_EVENTS);
			assert.ok(before.hostPendingBytes < HOST_PENDING_PER_PANEL_BYTES);
			assert.strictEqual(
				getAgentActivityGraphRegistrySnapshotForTest().hostPendingEvents,
				HOST_PENDING_PER_EXTENSION_EVENTS,
			);

			const extra = createLease('host-panel-event-extra');
			harness.bridge.handleRequest(setRequest(extra, 'host-panel-overflow.ts'));
			assert.deepStrictEqual(harness.bridge.getPanelSnapshotForTest(), before);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('HOST panel byte N/N+1은 동일한 panel/extension event+byte 경계에서 보존된다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const leases = Array.from(
			{ length: 4 },
			(_, index) => createLease(`host-panel-byte-${index}`),
		);
		try {
			assert.strictEqual(
				HOST_PENDING_PER_PANEL_EVENTS * ACTIVITY_IPC_MAX_UTF8_BYTES,
				HOST_PENDING_PER_PANEL_BYTES,
			);
			assert.strictEqual(HOST_PENDING_PER_PANEL_EVENTS, HOST_PENDING_PER_EXTENSION_EVENTS);
			assert.strictEqual(HOST_PENDING_PER_PANEL_BYTES, HOST_PENDING_PER_EXTENSION_BYTES);
			for (const lease of leases) {
				for (let index = 0; index < HOST_PENDING_PER_SESSION_EVENTS; index += 1) {
					harness.bridge.handleRequest(setRequest(
						lease,
						maxIpcPath(lease, index),
					));
				}
			}
			const before = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(before.hostPendingEvents, HOST_PENDING_PER_PANEL_EVENTS);
			assert.strictEqual(before.hostPendingBytes, HOST_PENDING_PER_PANEL_BYTES);
			const registry = getAgentActivityGraphRegistrySnapshotForTest();
			assert.strictEqual(registry.hostPendingEvents, HOST_PENDING_PER_EXTENSION_EVENTS);
			assert.strictEqual(registry.hostPendingBytes, HOST_PENDING_PER_EXTENSION_BYTES);

			const extra = createLease('host-panel-byte-extra');
			harness.bridge.handleRequest(setRequest(extra, maxIpcPath(extra, 0)));
			assert.deepStrictEqual(harness.bridge.getPanelSnapshotForTest(), before);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('HOST extension event cap은 여러 panel의 작은 payload 합계 N/N+1을 막는다', async () => {
		const baseline = captureIdleRegistry();
		const first = createHarness();
		const second = createHarness();
		const extra = createHarness();
		const harnesses = [first, second, extra];
		try {
			for (const [panelIndex, harness] of [first, second].entries()) {
				for (let leaseIndex = 0; leaseIndex < 2; leaseIndex += 1) {
					const lease = createLease(`host-extension-event-${panelIndex}-${leaseIndex}`);
					for (let index = 0; index < HOST_PENDING_PER_SESSION_EVENTS; index += 1) {
						harness.bridge.handleRequest(setRequest(
							lease,
							shortPath('host-extension-event', index),
						));
					}
				}
			}
			assert.strictEqual(first.bridge.getPanelSnapshotForTest().hostPendingEvents, 256);
			assert.strictEqual(second.bridge.getPanelSnapshotForTest().hostPendingEvents, 256);
			const registry = getAgentActivityGraphRegistrySnapshotForTest();
			assert.strictEqual(registry.hostPendingEvents, HOST_PENDING_PER_EXTENSION_EVENTS);
			assert.ok(registry.hostPendingBytes < HOST_PENDING_PER_EXTENSION_BYTES);

			const overflowLease = createLease('host-extension-event-overflow');
			extra.bridge.handleRequest(setRequest(overflowLease, 'overflow.ts'));
			assert.strictEqual(extra.bridge.getPanelSnapshotForTest().hostPendingEvents, 0);
		} finally {
			await disposeHarnesses(harnesses, baseline);
		}
	});

	test('HOST extension byte N/N+1은 panel 아래에서 동률인 extension event와 함께 막힌다', async () => {
		const baseline = captureIdleRegistry();
		const first = createHarness();
		const second = createHarness();
		const extra = createHarness();
		const harnesses = [first, second, extra];
		try {
			assert.strictEqual(
				HOST_PENDING_PER_EXTENSION_EVENTS * ACTIVITY_IPC_MAX_UTF8_BYTES,
				HOST_PENDING_PER_EXTENSION_BYTES,
			);
			for (const [panelIndex, harness] of [first, second].entries()) {
				for (let leaseIndex = 0; leaseIndex < 2; leaseIndex += 1) {
					const lease = createLease(`host-extension-byte-${panelIndex}-${leaseIndex}`);
					for (let index = 0; index < HOST_PENDING_PER_SESSION_EVENTS; index += 1) {
						harness.bridge.handleRequest(setRequest(
							lease,
							maxIpcPath(lease, index),
						));
					}
				}
			}
			assert.strictEqual(first.bridge.getPanelSnapshotForTest().hostPendingBytes, 2_097_152);
			assert.strictEqual(second.bridge.getPanelSnapshotForTest().hostPendingBytes, 2_097_152);
			const registry = getAgentActivityGraphRegistrySnapshotForTest();
			assert.strictEqual(registry.hostPendingEvents, HOST_PENDING_PER_EXTENSION_EVENTS);
			assert.strictEqual(registry.hostPendingBytes, HOST_PENDING_PER_EXTENSION_BYTES);

			const overflowLease = createLease('host-extension-byte-overflow');
			extra.bridge.handleRequest(setRequest(
				overflowLease,
				maxIpcPath(overflowLease, 0),
			));
			assert.strictEqual(extra.bridge.getPanelSnapshotForTest().hostPendingBytes, 0);
		} finally {
			await disposeHarnesses(harnesses, baseline);
		}
	});

	test('POST session event N/N+1 거절은 composite state를 남기지 않고 slot 재사용을 허용한다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const lease = createLease('post-session-event');
		try {
			for (let index = 0; index <= POST_PENDING_PER_SESSION_EVENTS; index += 1) {
				harness.bridge.handleRequest(setRequest(
					lease,
					shortPath('post-session-event', index),
				));
			}
			await settleValidations(
				[harness],
				POST_PENDING_PER_SESSION_EVENTS + 1,
			);
			const rejected = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(harness.posts.length, POST_PENDING_PER_SESSION_EVENTS);
			assert.strictEqual(rejected.postPendingEvents, POST_PENDING_PER_SESSION_EVENTS);
			assert.strictEqual(rejected.activeTargets, POST_PENDING_PER_SESSION_EVENTS);
			assert.ok(rejected.postPendingBytes < POST_PENDING_PER_SESSION_BYTES);

			const releasedBytes = wireUtf8Bytes(harness.posts[0]?.message);
			harness.posts[0]?.result.resolve(false);
			await flushAsyncWork();
			const afterRelease = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(afterRelease.postPendingEvents, POST_PENDING_PER_SESSION_EVENTS - 1);
			assert.strictEqual(afterRelease.postPendingBytes, rejected.postPendingBytes - releasedBytes);
			assert.strictEqual(afterRelease.activeTargets, POST_PENDING_PER_SESSION_EVENTS - 1);

			const validationTotal = harness.validations.length + 1;
			harness.bridge.handleRequest(setRequest(
				lease,
				shortPath('post-session-retry', 0),
			));
			await settleValidations([harness], validationTotal);
			const retried = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(harness.posts.length, POST_PENDING_PER_SESSION_EVENTS + 1);
			assert.strictEqual(retried.postPendingEvents, POST_PENDING_PER_SESSION_EVENTS);
			assert.strictEqual(retried.activeTargets, POST_PENDING_PER_SESSION_EVENTS);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('POST panel event cap은 session/extension 아래에서 N/N+1을 원자적으로 막는다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const leases = Array.from(
			{ length: 5 },
			(_, index) => createLease(`post-panel-event-${index}`),
		);
		try {
			for (let leaseIndex = 0; leaseIndex < 4; leaseIndex += 1) {
				const lease = leases[leaseIndex] as ActivityLease;
				for (let index = 0; index < POST_PENDING_PER_SESSION_EVENTS; index += 1) {
					harness.bridge.handleRequest(setRequest(
						lease,
						shortPath(`post-panel-${leaseIndex}`, index),
					));
				}
			}
			harness.bridge.handleRequest(setRequest(
				leases[4] as ActivityLease,
				'post-panel-overflow.ts',
			));
			await settleValidations([harness], POST_PENDING_PER_PANEL_EVENTS + 1);
			const snapshot = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(harness.posts.length, POST_PENDING_PER_PANEL_EVENTS);
			assert.strictEqual(snapshot.postPendingEvents, POST_PENDING_PER_PANEL_EVENTS);
			assert.strictEqual(snapshot.activeTargets, POST_PENDING_PER_PANEL_EVENTS);
			assert.ok(snapshot.postPendingBytes < POST_PENDING_PER_PANEL_BYTES);
			assert.strictEqual(
				getAgentActivityGraphRegistrySnapshotForTest().postWorkPendingEvents,
				POST_PENDING_PER_PANEL_EVENTS,
			);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('POST extension event cap은 여러 panel의 local cap 아래에서 N/N+1을 막는다', async () => {
		const baseline = captureIdleRegistry();
		const first = createHarness();
		const second = createHarness();
		const extra = createHarness();
		const harnesses = [first, second, extra];
		try {
			for (const [panelIndex, harness] of [first, second].entries()) {
				for (let leaseIndex = 0; leaseIndex < 3; leaseIndex += 1) {
					const lease = createLease(`post-extension-event-${panelIndex}-${leaseIndex}`);
					for (let index = 0; index < POST_PENDING_PER_SESSION_EVENTS; index += 1) {
						harness.bridge.handleRequest(setRequest(
							lease,
							shortPath(`post-extension-${leaseIndex}`, index),
						));
					}
				}
			}
			const overflowLease = createLease('post-extension-event-overflow');
			extra.bridge.handleRequest(setRequest(overflowLease, 'overflow.ts'));
			await settleValidations(
				harnesses,
				POST_WORK_PENDING_PER_EXTENSION_EVENTS + 1,
			);
			assert.strictEqual(first.posts.length, 192);
			assert.strictEqual(second.posts.length, 192);
			assert.strictEqual(extra.posts.length, 0);
			const registry = getAgentActivityGraphRegistrySnapshotForTest();
			assert.strictEqual(
				registry.postWorkPendingEvents,
				POST_WORK_PENDING_PER_EXTENSION_EVENTS,
			);
			assert.ok(registry.postWorkPendingBytes < POST_WORK_PENDING_PER_EXTENSION_BYTES);
		} finally {
			await disposeHarnesses(harnesses, baseline);
		}
	});

	test('POST session byte cap은 event cap 전에 N/N+1을 막고 rollback 뒤 재사용된다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const lease = createLease('post-session-byte');
		const accepted: ByteCandidate[] = [];
		let rejected: ByteCandidate | undefined;
		let acceptedBytes = 0;
		try {
			for (let index = 0; rejected === undefined; index += 1) {
				const candidate = createByteCandidate(harness, lease, index);
				if (acceptedBytes + candidate.bytes > POST_PENDING_PER_SESSION_BYTES) {
					rejected = candidate;
				} else {
					accepted.push(candidate);
					acceptedBytes += candidate.bytes;
				}
			}
			assert.ok(rejected !== undefined);
			assert.ok(accepted.length + 1 < POST_PENDING_PER_SESSION_EVENTS);
			assert.strictEqual(rejected.bytes, accepted[0]?.bytes);
			submitCandidates([...accepted, rejected]);
			await settleValidations([harness], accepted.length + 1);
			const beforeRelease = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(harness.posts.length, accepted.length);
			assert.strictEqual(beforeRelease.postPendingEvents, accepted.length);
			assert.strictEqual(beforeRelease.postPendingBytes, acceptedBytes);
			assert.strictEqual(beforeRelease.activeTargets, accepted.length);

			const firstBytes = accepted[0]?.bytes ?? 0;
			harness.posts[0]?.result.resolve(false);
			await flushAsyncWork();
			const validationTotal = harness.validations.length + 1;
			submitCandidates([rejected]);
			await settleValidations([harness], validationTotal);
			const retried = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(harness.posts.length, accepted.length + 1);
			assert.strictEqual(retried.postPendingEvents, accepted.length);
			assert.strictEqual(
				retried.postPendingBytes,
				acceptedBytes - firstBytes + rejected.bytes,
			);
			assert.strictEqual(retried.activeTargets, accepted.length);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('POST panel byte cap은 session/event/extension cap 아래에서 N/N+1을 막는다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const leases = Array.from(
			{ length: 8 },
			(_, index) => createLease(`post-panel-byte-${index}`),
		);
		const accepted: ByteCandidate[] = [];
		const sessionBytes = new Map<ActivityLease, number>();
		let rejected: ByteCandidate | undefined;
		let acceptedBytes = 0;
		try {
			for (let index = 0; rejected === undefined; index += 1) {
				const lease = leases[index % leases.length] as ActivityLease;
				const candidate = createByteCandidate(harness, lease, index);
				if (acceptedBytes + candidate.bytes > POST_PENDING_PER_PANEL_BYTES) {
					rejected = candidate;
				} else {
					accepted.push(candidate);
					acceptedBytes += candidate.bytes;
					sessionBytes.set(
						lease,
						(sessionBytes.get(lease) ?? 0) + candidate.bytes,
					);
				}
			}
			assert.ok(rejected !== undefined);
			assert.ok(accepted.length + 1 < POST_PENDING_PER_PANEL_EVENTS);
			assert.ok(
				(sessionBytes.get(rejected.lease) ?? 0) + rejected.bytes
					<= POST_PENDING_PER_SESSION_BYTES,
			);
			assert.ok(acceptedBytes + rejected.bytes <= POST_WORK_PENDING_PER_EXTENSION_BYTES);
			submitCandidates([...accepted, rejected]);
			await settleValidations([harness], accepted.length + 1);
			const snapshot = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(harness.posts.length, accepted.length);
			assert.strictEqual(snapshot.postPendingEvents, accepted.length);
			assert.strictEqual(snapshot.postPendingBytes, acceptedBytes);
			assert.strictEqual(snapshot.activeTargets, accepted.length);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('POST extension byte cap은 모든 local cap 아래에서 N/N+1을 막는다', async () => {
		const baseline = captureIdleRegistry();
		const harnesses = [createHarness(), createHarness(), createHarness()];
		const leases = harnesses.map((_, panelIndex) => Array.from(
			{ length: 8 },
			(_unused, leaseIndex) => createLease(
				`post-extension-byte-${panelIndex}-${leaseIndex}`,
			),
		));
		const accepted: ByteCandidate[] = [];
		const panelBytes = new Map<BridgeHarness, number>();
		const panelEvents = new Map<BridgeHarness, number>();
		const sessionBytes = new Map<ActivityLease, number>();
		let rejected: ByteCandidate | undefined;
		let acceptedBytes = 0;
		try {
			for (let index = 0; rejected === undefined; index += 1) {
				const panelIndex = index % harnesses.length;
				const harness = harnesses[panelIndex] as BridgeHarness;
				const panelLeases = leases[panelIndex] as ActivityLease[];
				const lease = panelLeases[
					Math.floor(index / harnesses.length) % panelLeases.length
				] as ActivityLease;
				const candidate = createByteCandidate(harness, lease, index);
				if (acceptedBytes + candidate.bytes > POST_WORK_PENDING_PER_EXTENSION_BYTES) {
					rejected = candidate;
				} else {
					accepted.push(candidate);
					acceptedBytes += candidate.bytes;
					panelBytes.set(
						harness,
						(panelBytes.get(harness) ?? 0) + candidate.bytes,
					);
					panelEvents.set(
						harness,
						(panelEvents.get(harness) ?? 0) + 1,
					);
					sessionBytes.set(
						lease,
						(sessionBytes.get(lease) ?? 0) + candidate.bytes,
					);
				}
			}
			assert.ok(rejected !== undefined);
			assert.ok(accepted.length + 1 < POST_WORK_PENDING_PER_EXTENSION_EVENTS);
			assert.ok(
				(panelBytes.get(rejected.harness) ?? 0) + rejected.bytes
					<= POST_PENDING_PER_PANEL_BYTES,
			);
			assert.ok(
				(panelEvents.get(rejected.harness) ?? 0) + 1
					<= POST_PENDING_PER_PANEL_EVENTS,
			);
			assert.ok(
				(sessionBytes.get(rejected.lease) ?? 0) + rejected.bytes
					<= POST_PENDING_PER_SESSION_BYTES,
			);
			submitCandidates([...accepted, rejected]);
			await settleValidations(harnesses, accepted.length + 1);
			assert.strictEqual(
				harnesses.reduce((total, harness) => total + harness.posts.length, 0),
				accepted.length,
			);
			const registry = getAgentActivityGraphRegistrySnapshotForTest();
			assert.strictEqual(registry.postWorkPendingEvents, accepted.length);
			assert.strictEqual(registry.postWorkPendingBytes, acceptedBytes);
		} finally {
			await disposeHarnesses(harnesses, baseline);
		}
	});

	test('CLEANUP panel event N/N+1과 protocol상 도달 불가능한 byte cap 관계를 고정한다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		try {
			const maximumSessionId = 's'.repeat(ID_MAX_LENGTH);
			const maximumTrackedClearBytes = wireUtf8Bytes({
				type: 'agent.activity.clearTracked',
				receiptId: Number.MAX_SAFE_INTEGER,
				publicMessage: clearAgentActivitiesBySession(maximumSessionId),
			});
			assert.ok(
				maximumTrackedClearBytes * CLEANUP_POST_PENDING_PER_PANEL_EVENTS
					< CLEANUP_POST_PENDING_PER_PANEL_BYTES,
			);

			for (let index = 0; index <= CLEANUP_POST_PENDING_PER_PANEL_EVENTS; index += 1) {
				const lease = createLease(`cleanup-panel-${index.toString().padStart(3, '0')}`);
				harness.bridge.handleRequest(clearRequest(lease, 'cleanup-target.ts'));
				harness.bridge.revokeLease(lease);
			}
			const snapshot = harness.bridge.getPanelSnapshotForTest();
			assert.strictEqual(harness.posts.length, CLEANUP_POST_PENDING_PER_PANEL_EVENTS);
			assert.strictEqual(
				snapshot.cleanupPostPendingEvents,
				CLEANUP_POST_PENDING_PER_PANEL_EVENTS,
			);
			assert.ok(snapshot.cleanupPostPendingBytes < CLEANUP_POST_PENDING_PER_PANEL_BYTES);
			assert.strictEqual(snapshot.receiptCount, 0);
			assert.strictEqual(snapshot.retiredQuotaCount, 0);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('ACTIVE session N/N+1은 settled post와 무관하게 session별로 제한된다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const lease = createLease('active-session-cap');
		try {
			await occupyTargetRange(
				harness,
				lease,
				'active-session',
				ACTIVE_TARGETS_PER_SESSION,
			);
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().activeTargets,
				ACTIVE_TARGETS_PER_SESSION,
			);
			const postCount = harness.posts.length;
			const validationTotal = harness.validations.length + 1;
			harness.bridge.handleRequest(setRequest(lease, 'active-session-overflow.ts'));
			await settleValidations([harness], validationTotal);
			assert.strictEqual(harness.posts.length, postCount);
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().activeTargets,
				ACTIVE_TARGETS_PER_SESSION,
			);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});

	test('ACTIVE panel N/N+1은 네 session의 settled occupancy 합계에서 제한된다', async () => {
		const baseline = captureIdleRegistry();
		const harness = createHarness();
		const leases = Array.from(
			{ length: 4 },
			(_, index) => createLease(`active-panel-cap-${index}`),
		);
		try {
			for (const [index, lease] of leases.entries()) {
				await occupyTargetRange(
					harness,
					lease,
					`active-panel-${index}`,
					ACTIVE_TARGETS_PER_SESSION,
				);
			}
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().activeTargets,
				ACTIVE_TARGETS_PER_PANEL,
			);
			const postCount = harness.posts.length;
			const validationTotal = harness.validations.length + 1;
			const extra = createLease('active-panel-cap-extra');
			harness.bridge.handleRequest(setRequest(extra, 'active-panel-overflow.ts'));
			await settleValidations([harness], validationTotal);
			assert.strictEqual(harness.posts.length, postCount);
			assert.strictEqual(
				harness.bridge.getPanelSnapshotForTest().activeTargets,
				ACTIVE_TARGETS_PER_PANEL,
			);
		} finally {
			await disposeHarnesses([harness], baseline);
		}
	});
});
