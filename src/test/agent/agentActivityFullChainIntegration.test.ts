import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	Client,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import * as vscode from 'vscode';
import {
	AgentActivityGraphBridge,
	createAgentActivityGraphBridge,
} from '../../agent/host/terminal/agentActivityGraphBridge';
import { validateSetAgentActivityTarget } from '../../agent/host/terminal/agentActivityTargetValidator';
import { TerminalHost } from '../../agent/host/terminal/terminalHost';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';
import {
	createAgentActivityStore,
	type AgentActivityStore,
} from '../../agent/webview/agentActivityStore';
import { McpAdapterSupervisor } from '../../mcp/adapterSupervisor';
import { buildCodexMcpLaunchPlan } from '../../mcp/codexLaunchPlan';
import type { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
} from '../../mcp/toolServer';
import {
	parseAgentActivityToWebviewMessage,
	parseAgentActivityTrackedClearMessage,
	type ExtensionToWebviewMessage,
} from '../../messages';
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';
import { createCaptureFailureProcessTreeController } from './support/fakeProcessTreeController';
import { FakePtyAdapter } from './support/fakePtyAdapter';

interface PendingPost {
	readonly message: ExtensionToWebviewMessage;
	readonly resolve: (posted: boolean) => void;
	settled: boolean;
}

/** Same-panel delivery uses invocation order; Promise settlement is controlled separately. */
class FakeActivityWebview {
	readonly messages: ExtensionToWebviewMessage[] = [];
	readonly pendingReceipts: Array<Readonly<{
		type: 'agent.activity.clearApplied';
		receiptId: number;
	}>> = [];
	private readonly posts: PendingPost[] = [];
	private receiptSink: ((value: unknown) => boolean) | undefined;

	constructor(readonly store: AgentActivityStore) {}

	bindReceiptSink(sink: (value: unknown) => boolean): void {
		this.receiptSink = sink;
	}

	postMessage = (message: ExtensionToWebviewMessage): Promise<boolean> => {
		this.messages.push(message);
		this.apply(message);
		return new Promise<boolean>((resolve) => {
			this.posts.push({ message, resolve, settled: false });
		});
	};

	async settlePost(index: number, posted: boolean): Promise<void> {
		const pending = this.posts[index];
		assert.ok(pending !== undefined, `missing fake Webview post ${index}`);
		if (!pending.settled) {
			pending.settled = true;
			pending.resolve(posted);
		}
		await Promise.resolve();
	}

	async settleAllReverse(posted = true): Promise<void> {
		for (let index = this.posts.length - 1; index >= 0; index -= 1) {
			await this.settlePost(index, posted);
		}
	}

	deliverNextReceipt(): void {
		const receipt = this.pendingReceipts.shift();
		assert.ok(receipt !== undefined, 'missing fake Webview receipt');
		assert.strictEqual(this.receiptSink?.(receipt), true);
	}

	deliverAllReceipts(): void {
		while (this.pendingReceipts.length > 0) {
			this.deliverNextReceipt();
		}
	}

	private apply(message: ExtensionToWebviewMessage): void {
		const tracked = parseAgentActivityTrackedClearMessage(message);
		if (tracked !== undefined) {
			this.applyPublicActivityMessage(tracked.publicMessage);
			this.pendingReceipts.push(Object.freeze({
				type: 'agent.activity.clearApplied',
				receiptId: tracked.receiptId,
			}));
			return;
		}

		const publicMessage = parseAgentActivityToWebviewMessage(message);
		assert.ok(publicMessage !== undefined, 'unexpected fake Webview message');
		this.applyPublicActivityMessage(publicMessage);
	}

	private applyPublicActivityMessage(
		message: NonNullable<ReturnType<typeof parseAgentActivityToWebviewMessage>>,
	): void {
		if (message.type === 'agent.activity.set') {
			this.store.setAgentActivity(
				message.sessionId,
				message.target,
				message.activity,
			);
			return;
		}
		if (message.type === 'agent.activity.clear') {
			this.store.clearAgentActivity(message.sessionId, message.target);
			return;
		}
		this.store.clearAgentActivitiesBySession(message.sessionId);
	}
}

interface FullChainFixture {
	readonly host: TerminalHost;
	readonly supervisor: McpAdapterSupervisor;
	readonly bridge: AgentActivityGraphBridge | undefined;
	readonly webview: FakeActivityWebview;
	readonly store: AgentActivityStore;
	readonly root: ValidatedWorkspaceRoot;
	readonly rootUri: vscode.Uri;
	readonly tempRoot: string;
	readonly connection: McpConnectionDescriptor;
	readonly supervisorEvents: Parameters<TerminalHost['handleMcpRuntimeEvent']>[0][];
	readonly firstValidationStarted: Promise<void>;
	readonly releaseFirstValidation: () => void;
	readonly validationCalls: () => number;
	readonly client: Client;
	cleanup(): Promise<void>;
}

suite('Agent Activity production full-chain integration', () => {
	test('HTTP SDK crosses child ownership, selected root, Store and tracked quota', async () => {
		const fixture = await createFullChainFixture(true);
		try {
			const listed = await fixture.client.listTools();
			assert.deepStrictEqual(listed.tools.map(({ name }) => name), [
				CRISPY_PING_TOOL_NAME,
				CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			]);

			const firstSet = fixture.client.callTool({
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: {
					path: 'src//./feature.ts',
					targetKind: 'file',
					activity: 'editing',
				},
			});
			await fixture.firstValidationStarted;
			assertAccepted(await firstSet);
			/** Child acceptance is deliberately observed before Host validation/Store apply. */
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);

			const activityEnvelopes = fixture.supervisorEvents.filter(
				({ event }) => event.type === 'session.agentActivityRequested',
			);
			assert.strictEqual(activityEnvelopes.length, 1);
			const firstEnvelope = activityEnvelopes[0];
			assert.strictEqual(
				firstEnvelope.sourceRuntime,
				fixture.supervisor.getSessionRuntime(firstEnvelope.event.sessionId),
			);
			assert.deepStrictEqual(firstEnvelope.event, {
				type: 'session.agentActivityRequested',
				sessionId: firstEnvelope.event.sessionId,
				generation: firstEnvelope.event.generation,
				operation: 'set',
				path: 'src/feature.ts',
				targetKind: 'file',
				activity: 'editing',
			});

			fixture.releaseFirstValidation();
			await waitFor(() => fixture.webview.messages.length === 1);
			const expectedTarget = {
				nodeId: `file:${vscode.Uri.joinPath(
					fixture.rootUri,
					'src',
					'feature.ts',
				).toString()}`,
			};
			assert.deepStrictEqual(fixture.store.getSnapshot(), [{
				target: expectedTarget,
				activities: [{
					sessionId: firstEnvelope.event.sessionId,
					activity: 'editing',
					sequence: 1,
				}],
			}]);
			await fixture.webview.settlePost(0, true);
			assert.strictEqual(
				fixture.bridge?.getPanelSnapshotForTest().activeTargets,
				1,
			);

			/** Clear must preserve the deterministic target after the file disappears. */
			await unlink(path.join(fixture.tempRoot, 'src', 'feature.ts'));
			assertAccepted(await fixture.client.callTool({
				name: CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
				arguments: { path: 'src/feature.ts', targetKind: 'file' },
			}));
			await waitFor(() => fixture.webview.messages.length === 2);
			assert.strictEqual(fixture.validationCalls(), 1);
			assert.deepStrictEqual(readPublicTypes(fixture.webview.messages), [
				'agent.activity.set',
				'agent.activity.clear',
			]);
			assert.deepStrictEqual(
				readPublicTarget(fixture.webview.messages[1]),
				expectedTarget,
			);
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);
			assert.deepStrictEqual(
				pickQuota(fixture.bridge!.getPanelSnapshotForTest()),
				{ activeTargets: 1, receiptCount: 1 },
			);
			fixture.webview.deliverNextReceipt();
			assert.deepStrictEqual(
				pickQuota(fixture.bridge!.getPanelSnapshotForTest()),
				{ activeTargets: 0, receiptCount: 0 },
			);
			await fixture.webview.settlePost(1, true);

			/** set→clear delivery stays FIFO even when post Promises settle clear→set. */
			assertAccepted(await fixture.client.callTool({
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: {
					path: 'src/reverse.ts',
					targetKind: 'file',
					activity: 'active',
				},
			}));
			await waitFor(() => fixture.webview.messages.length === 3);
			assertAccepted(await fixture.client.callTool({
				name: CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
				arguments: { path: 'src/reverse.ts', targetKind: 'file' },
			}));
			await waitFor(() => fixture.webview.messages.length === 4);
			assert.deepStrictEqual(
				readPublicTypes(fixture.webview.messages.slice(2, 4)),
				['agent.activity.set', 'agent.activity.clear'],
			);
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);
			await fixture.webview.settlePost(3, true);
			await fixture.webview.settlePost(2, true);
			fixture.webview.deliverNextReceipt();
			await waitFor(() => (
				fixture.bridge!.getPanelSnapshotForTest().activeTargets === 0
			));

			/** clear→set preserves the newer set and an older receipt cannot clear it. */
			assertAccepted(await fixture.client.callTool({
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: {
					path: 'src/revive.ts',
					targetKind: 'file',
					activity: 'planned',
				},
			}));
			await waitFor(() => fixture.webview.messages.length === 5);
			await fixture.webview.settlePost(4, true);
			assertAccepted(await fixture.client.callTool({
				name: CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
				arguments: { path: 'src/revive.ts', targetKind: 'file' },
			}));
			await waitFor(() => fixture.webview.messages.length === 6);
			assertAccepted(await fixture.client.callTool({
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: {
					path: 'src/revive.ts',
					targetKind: 'file',
					activity: 'completed',
				},
			}));
			await waitFor(() => fixture.webview.messages.length === 7);
			assert.deepStrictEqual(
				readPublicTypes(fixture.webview.messages.slice(5, 7)),
				['agent.activity.clear', 'agent.activity.set'],
			);
			assert.strictEqual(
				fixture.store.getSnapshot()[0]?.activities[0]?.activity,
				'completed',
			);
			await fixture.webview.settlePost(6, true);
			await fixture.webview.settlePost(5, true);
			fixture.webview.deliverNextReceipt();
			assert.strictEqual(
				fixture.bridge!.getPanelSnapshotForTest().activeTargets,
				1,
			);
			assert.strictEqual(
				fixture.store.getSnapshot()[0]?.activities[0]?.activity,
				'completed',
			);

			/** Leave a settled target-clear receipt for clearSession to subsume. */
			assertAccepted(await fixture.client.callTool({
				name: CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
				arguments: { path: 'src/revive.ts', targetKind: 'file' },
			}));
			await waitFor(() => fixture.webview.messages.length === 8);
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);
			await fixture.webview.settlePost(7, true);
			assert.deepStrictEqual(
				pickQuota(fixture.bridge!.getPanelSnapshotForTest()),
				{ activeTargets: 1, receiptCount: 1 },
			);

			/** Lease teardown invokes clearSession after the target clear. */
			fixture.host.detach();
			await waitFor(() => fixture.webview.messages.length === 9);
			assert.deepStrictEqual(
				readPublicTypes(fixture.webview.messages.slice(6, 9)),
				[
					'agent.activity.set',
					'agent.activity.clear',
					'agent.activity.clearSession',
				],
			);
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);
			assert.strictEqual(
				fixture.bridge!.getPanelSnapshotForTest().retiredQuotaCount,
				1,
			);
			/** The subsumed target receipt cannot release retired quota. */
			fixture.webview.deliverNextReceipt();
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);
			assert.strictEqual(
				fixture.bridge!.getPanelSnapshotForTest().retiredQuotaCount,
				1,
			);
			/** Only the clearSession receipt releases the retired quota. */
			fixture.webview.deliverNextReceipt();
			assert.strictEqual(
				fixture.bridge!.getPanelSnapshotForTest().retiredQuotaCount,
				0,
			);
			await fixture.webview.settleAllReverse(true);
			await waitFor(() => (
				fixture.bridge!.getPanelSnapshotForTest().activeTargets === 0
				&& fixture.bridge!.getPanelSnapshotForTest().receiptCount === 0
			));
		} finally {
			await fixture.cleanup();
		}
	});

	test('unsupported Host remains ping-only with no Activity lifecycle state', async () => {
		const fixture = await createFullChainFixture(false);
		try {
			const listed = await fixture.client.listTools();
			assert.deepStrictEqual(
				listed.tools.map(({ name }) => name),
				[CRISPY_PING_TOOL_NAME],
			);
			assertPing(await fixture.client.callTool({
				name: CRISPY_PING_TOOL_NAME,
				arguments: {},
			}));
			await assert.rejects(() => fixture.client.callTool({
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: {
					path: 'src/feature.ts',
					targetKind: 'file',
					activity: 'editing',
				},
			}));

			const hostInternals = fixture.host as unknown as {
				readonly activityLeaseStateBySession: unknown;
			};
			assert.strictEqual(hostInternals.activityLeaseStateBySession, undefined);
			assert.strictEqual(fixture.bridge, undefined);
			assert.deepStrictEqual(fixture.webview.messages, []);
			assert.deepStrictEqual(fixture.webview.pendingReceipts, []);
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);
			assert.strictEqual(fixture.validationCalls(), 0);
			assert.deepStrictEqual(fixture.supervisorEvents.filter(
				({ event }) => event.type === 'session.agentActivityRequested',
			), []);

			fixture.host.handleAgentActivityWorkspaceFoldersChanged([fixture.root.id]);
			fixture.host.detach();
			await fixture.webview.settleAllReverse(true);
			assert.deepStrictEqual(fixture.store.getSnapshot(), []);
		} finally {
			await fixture.cleanup();
		}
	});
});

async function createFullChainFixture(
	agentActivityCompatible: boolean,
): Promise<FullChainFixture> {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'crispy-activity-chain-'));
	await mkdir(path.join(tempRoot, 'src'));
	await writeFile(path.join(tempRoot, 'src', 'feature.ts'), 'export {};\n');
	const rootUri = vscode.Uri.file(tempRoot);
	const workspaceRootId = createWorkspaceRootId(rootUri);
	const root = {
		id: workspaceRootId,
		scheme: 'file',
		fsPath: tempRoot as ValidatedWorkspaceFsPath,
		workspaceFolder: {
			uri: rootUri,
			name: 'activity-full-chain',
			index: 0,
		},
	} as ValidatedWorkspaceRoot;
	const store = createAgentActivityStore();
	const webview = new FakeActivityWebview(store);
	const supervisorEvents: Parameters<TerminalHost['handleMcpRuntimeEvent']>[0][] = [];
	let host!: TerminalHost;
	let bridge: AgentActivityGraphBridge | undefined;
	let connection: McpConnectionDescriptor | undefined;
	let validationCalls = 0;
	let releaseFirstValidation!: () => void;
	const firstValidationGate = new Promise<void>((resolve) => {
		releaseFirstValidation = resolve;
	});
	let markFirstValidationStarted!: () => void;
	const firstValidationStarted = new Promise<void>((resolve) => {
		markFirstValidationStarted = resolve;
	});
	let shouldGateFirstValidation = true;

	if (agentActivityCompatible) {
		bridge = createAgentActivityGraphBridge({
			postMessage: webview.postMessage,
			resolveWorkspace: () => ({ ok: true, root }),
			invalidateLease: (lease, failure) => {
				host.handleAgentActivityWorkspaceFailure(lease, failure);
			},
			validateSetTarget: async (lease, freshRoot, request) => {
				validationCalls += 1;
				if (shouldGateFirstValidation) {
					shouldGateFirstValidation = false;
					markFirstValidationStarted();
					await firstValidationGate;
				}
				return validateSetAgentActivityTarget(lease, freshRoot, request);
			},
		});
		webview.bindReceiptSink((receipt) => bridge!.handleWebviewMessage(receipt));
	}

	const extensionRoot = path.resolve(__dirname, '../../..');
	const supervisor = new McpAdapterSupervisor({
		extensionUri: { fsPath: extensionRoot },
		parentEnvironment: { ...process.env },
		agentActivityCompatible,
		timeouts: {
			readyMs: 5_000,
			registrationMs: 5_000,
			revokeMs: 2_000,
			shutdownMs: 2_000,
			killMs: 1_000,
		},
		onEvent: (envelope) => {
			supervisorEvents.push(envelope);
			host.handleMcpRuntimeEvent(envelope);
		},
	});
	const adapter = new FakePtyAdapter(9_101);
	host = new TerminalHost({
		ptyAdapter: adapter,
		workspaceResolver: () => ({ ok: true, root }),
		readWorkspaceTrust: () => true,
		prepareCodexLaunch: async () => ({
			ok: true,
			preparation: {
				executable: {
					executable: '/resolved/codex',
					launcherKind: 'direct',
				},
				cwd: tempRoot,
				environment: { PATH: '/bin' },
				platform: process.platform,
				shellEnvironmentPolicyStyle: 'keyed-filters',
			},
		}),
		mcpSupervisor: supervisor,
		agentActivityCompatible,
		onAgentActivityRequest: (request) => {
			bridge?.handleAgentActivityRequest(request);
		},
		onActivityLeaseRevoked: (lease) => {
			bridge?.revokeLease(lease);
		},
		buildCodexMcpLaunchPlan: (options) => {
			assert.strictEqual(
				options.agentActivityCompatible,
				agentActivityCompatible,
			);
			connection = options.connection;
			return buildCodexMcpLaunchPlan(options);
		},
		processTreeController: createCaptureFailureProcessTreeController(),
		sessionIdNonce: agentActivityCompatible
			? 'activity-full-chain-enabled'
			: 'activity-full-chain-disabled',
		emitMessage: () => undefined,
	});

	let client: Client | undefined;
	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned) {
			return;
		}
		cleaned = true;
		releaseFirstValidation();
		await client?.close().catch(() => undefined);
		host.detach();
		webview.deliverAllReceipts();
		await webview.settleAllReverse(true);
		await host.terminate().catch(() => undefined);
		await supervisor.dispose().catch(() => undefined);
		bridge?.disposePanel();
		await rm(tempRoot, { recursive: true, force: true });
	};

	try {
		host.createTab('tab-activity-full-chain');
		await host.handleTerminalReady('tab-activity-full-chain', 100, 30);
		await host.switchAgent(
			'tab-activity-full-chain',
			'codex',
			workspaceRootId,
			1,
		);
		assert.ok(connection !== undefined, 'full-chain MCP connection was not prepared');
		client = new Client(
			{ name: 'crispy-activity-full-chain', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto' } },
		);
		const transport = connection.withBearerToken((token) => (
			new StreamableHTTPClientTransport(new URL(connection!.url), {
				requestInit: {
					headers: { Authorization: `Bearer ${token}` },
				},
			})
		));
		await client.connect(transport);
	} catch (error) {
		await cleanup();
		throw error;
	}

	return {
		host,
		supervisor,
		bridge,
		webview,
		store,
		root,
		rootUri,
		tempRoot,
		connection,
		supervisorEvents,
		firstValidationStarted,
		releaseFirstValidation,
		validationCalls: () => validationCalls,
		client,
		cleanup,
	};
}

function readPublicTypes(
	messages: readonly ExtensionToWebviewMessage[],
): string[] {
	return messages.map((message) => {
		const tracked = parseAgentActivityTrackedClearMessage(message);
		if (tracked !== undefined) {
			return tracked.publicMessage.type;
		}
		const publicMessage = parseAgentActivityToWebviewMessage(message);
		assert.ok(publicMessage !== undefined);
		return publicMessage.type;
	});
}

function readPublicTarget(
	message: ExtensionToWebviewMessage,
): Readonly<{ readonly nodeId: string; readonly rootId?: string }> | undefined {
	const tracked = parseAgentActivityTrackedClearMessage(message);
	const publicMessage = tracked?.publicMessage
		?? parseAgentActivityToWebviewMessage(message);
	return publicMessage?.type === 'agent.activity.set'
		|| publicMessage?.type === 'agent.activity.clear'
		? publicMessage.target
		: undefined;
}

function assertAccepted(result: Awaited<ReturnType<Client['callTool']>>): void {
	assert.deepStrictEqual(readToolJson(result), { ok: true, accepted: true });
}

function assertPing(result: Awaited<ReturnType<Client['callTool']>>): void {
	assert.deepStrictEqual(readToolJson(result), {
		ok: true,
		server: 'crispy',
		mode: 'observation-only',
	});
}

function readToolJson(
	result: Awaited<ReturnType<Client['callTool']>>,
): unknown {
	assert.strictEqual(result.content.length, 1);
	const content = result.content[0];
	assert.strictEqual(content.type, 'text');
	assert.ok('text' in content && typeof content.text === 'string');
	return JSON.parse(content.text);
}

function pickQuota(snapshot: Readonly<{
	activeTargets: number;
	receiptCount: number;
}>): Readonly<{ activeTargets: number; receiptCount: number }> {
	return {
		activeTargets: snapshot.activeTargets,
		receiptCount: snapshot.receiptCount,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('Timed out waiting for full-chain state.');
}
