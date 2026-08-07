import * as assert from 'node:assert';

import type { ClientRequest } from '../generated/ClientRequest';
import { CodexConversationController } from '../conversationController';
import type { CodexConversationClient } from '../conversationController';
import type { CodexConnectionState } from '../contracts';
import type { CodexInboundMessage } from '../runtimeValidation';

/** 테스트에서 controller가 보낸 요청을 기록하고 method별 응답을 반환한다. */
class FakeConversationClient implements CodexConversationClient {
	/** controller의 Composer를 활성화하는 고정 ready 상태다. */
	public readonly state: Readonly<CodexConnectionState> = { phase: 'ready' };
	/** controller가 실제로 생성한 요청 순서다. */
	public readonly requests: ClientRequest[] = [];
	/** Host request ID 생성 순번이다. */
	private requestSequence = 0;

	/**
	 * @param responder method별 unknown 결과를 만드는 테스트 callback.
	 */
	public constructor(
		private readonly responder: (request: ClientRequest) => unknown | Promise<unknown>,
	) {}

	/** @returns 서로 충돌하지 않는 테스트 request ID. */
	public createRequestId(): string {
		this.requestSequence += 1;
		return `request-${this.requestSequence}`;
	}

	/**
	 * 요청을 기록하고 주입된 응답을 반환한다.
	 *
	 * @param request controller가 생성한 ClientRequest.
	 * @returns method별 테스트 결과.
	 */
	public async request<Response>(request: ClientRequest): Promise<Response> {
		this.requests.push(request);
		return await this.responder(request) as Response;
	}
}

suite('CodexConversationController', () => {
	test('첫 전송에서만 thread/start를 보내고 후속 Turn은 같은 Thread를 사용한다', async () => {
		let turnSequence = 0;
		const client = new FakeConversationClient((request) => {
			if (request.method === 'thread/start') {
				return threadStartResult('thread-1');
			}
			turnSequence += 1;
			return turnStartResult(`turn-${turnSequence}`);
		});
		const controller = createController(client);
		const conversationId = controller.snapshot.selectedConversationId;

		await send(controller, conversationId, '첫 질문');
		const firstTurnRequest = client.requests[1];
		assert.strictEqual(client.requests[0]?.method, 'thread/start');
		assert.deepStrictEqual(client.requests[0]?.params, {
			cwd: '/workspace',
			runtimeWorkspaceRoots: ['/workspace'],
			approvalPolicy: 'on-request',
			approvalsReviewer: 'user',
			sandbox: 'workspace-write',
			ephemeral: false,
			threadSource: 'crispy',
		});
		assert.strictEqual(firstTurnRequest?.method, 'turn/start');
		assert.strictEqual(firstTurnRequest?.params.threadId, 'thread-1');
		assert.ok(firstTurnRequest?.params.clientUserMessageId);
		assert.deepStrictEqual(firstTurnRequest?.params.input, [{
			type: 'text',
			text: '첫 질문',
			text_elements: [],
		}]);
		assert.ok(!Object.hasOwn(firstTurnRequest?.params ?? {}, 'model'));
		assert.ok(!Object.hasOwn(firstTurnRequest?.params ?? {}, 'effort'));
		await send(controller, conversationId, '중복 요청');
		assert.strictEqual(client.requests.length, 2);
		assert.strictEqual(controller.snapshot.isRunning, true);
		assert.match(controller.snapshot.error ?? '', /이미 Turn이 실행 중/);

		controller.handleAppServerMessage(notification('turn/completed', {
			threadId: 'thread-1',
			turn: turn('turn-1', 'completed'),
		}));
		await send(controller, conversationId, '후속 질문');

		assert.deepStrictEqual(
			client.requests.map((request) => request.method),
			['thread/start', 'turn/start', 'turn/start'],
		);
		const secondTurnRequest = client.requests[2];
		assert.ok(secondTurnRequest && secondTurnRequest.method === 'turn/start');
		assert.strictEqual(secondTurnRequest.params.threadId, 'thread-1');
		controller.dispose();
	});

	test('client ID로 사용자 메시지를 중복 제거하고 core 5 delta와 완료 원본을 반영한다', async () => {
		const client = new FakeConversationClient((request) =>
			request.method === 'thread/start'
				? threadStartResult('thread-1')
				: turnStartResult('turn-1'));
		const controller = createController(client);
		const conversationId = controller.snapshot.selectedConversationId;
		await send(controller, conversationId, '코드를 확인해 줘');
		const turnRequest = client.requests.find((request) => request.method === 'turn/start');
		assert.ok(turnRequest && turnRequest.method === 'turn/start');
		const clientId = turnRequest.params.clientUserMessageId;
		assert.strictEqual(typeof clientId, 'string');

		applyItem(controller, 'item/completed', userItem('user-1', clientId as string), 1_100);
		applyItem(controller, 'item/started', agentItem('agent-1', ''), 1_200);
		controller.handleAppServerMessage(notification('item/agentMessage/delta', {
			threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: '임시 답변',
		}));
		applyItem(controller, 'item/completed', agentItem('agent-1', '최종 답변'), 1_300);
		applyItem(controller, 'item/completed', reasoningItem('reasoning-1'), 1_400);
		applyItem(controller, 'item/started', commandItem('command-1', null), 1_500);
		controller.handleAppServerMessage(notification(
			'item/commandExecution/outputDelta',
			{
				threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', delta: 'delta output',
			},
		));
		applyItem(controller, 'item/completed', commandItem('command-1', 'final output'), 1_600);
		applyItem(controller, 'item/completed', fileItem('file-1'), 1_700);

		const snapshot = controller.snapshot;
		assert.deepStrictEqual(
			snapshot.items.map((item) => item.type),
			['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange'],
		);
		assert.strictEqual(
			snapshot.items.filter((item) => item.type === 'userMessage').length,
			1,
		);
		assert.strictEqual(snapshot.items[1]?.text, '최종 답변');
		assert.strictEqual(snapshot.items[3]?.text, '$ pnpm test\nfinal output');
		assert.ok(snapshot.items.every((item) => item.status === 'completed'));
		controller.dispose();
	});

	test('thread/status idle은 Turn 성공으로 처리하지 않고 turn/completed만 실행을 끝낸다', async () => {
		const client = new FakeConversationClient((request) =>
			request.method === 'thread/start'
				? threadStartResult('thread-1')
				: turnStartResult('turn-1'));
		const controller = createController(client);
		const conversationId = controller.snapshot.selectedConversationId;
		await send(controller, conversationId, '실패 상태 확인');

		controller.handleAppServerMessage(notification('thread/status/changed', {
			threadId: 'thread-1',
			status: { type: 'idle' },
		}));
		assert.strictEqual(controller.snapshot.isRunning, true);

		controller.handleAppServerMessage(notification('turn/completed', {
			threadId: 'thread-1',
			turn: turn('turn-1', 'failed', [], {
				message: '모델 요청 실패',
				codexErrorInfo: null,
				additionalDetails: null,
			}),
		}));
		assert.strictEqual(controller.snapshot.isRunning, false);
		assert.strictEqual(controller.snapshot.error, '모델 요청 실패');
		controller.dispose();
	});

	test('summary Turn을 기존 Item에 병합하고 서로 다른 draft의 Turn을 동시에 시작한다', async () => {
		let threadSequence = 0;
		const pendingTurnResolvers: Array<(value: unknown) => void> = [];
		const client = new FakeConversationClient((request) => {
			if (request.method === 'thread/start') {
				threadSequence += 1;
				return threadStartResult(`thread-${threadSequence}`);
			}
			return new Promise((resolve) => pendingTurnResolvers.push(resolve));
		});
		const controller = createController(client);
		const firstConversationId = controller.snapshot.selectedConversationId;
		const firstSend = send(controller, firstConversationId, '첫 대화');
		await flushMicrotasks();
		await controller.handleWebviewMessage({ type: 'codexChat/newDraft' });
		const secondConversationId = controller.snapshot.selectedConversationId;
		const secondSend = send(controller, secondConversationId, '둘째 대화');
		await flushMicrotasks();

		assert.strictEqual(client.requests.filter((request) =>
			request.method === 'turn/start').length, 2);
		assert.strictEqual(controller.snapshot.isRunning, true);

		pendingTurnResolvers[0]?.(turnStartResult('turn-1'));
		pendingTurnResolvers[1]?.(turnStartResult('turn-2'));
		await Promise.all([firstSend, secondSend]);
		controller.handleAppServerMessage(notification('item/started', {
			threadId: 'thread-2',
			turnId: 'turn-2',
			item: agentItem('agent-1', '기존 답변'),
			startedAtMs: 1_200,
		}));
		controller.handleAppServerMessage(notification('turn/completed', {
			threadId: 'thread-2',
			turn: turn('turn-2', 'completed', [reasoningItem('reasoning-1')], null, 'summary'),
		}));
		assert.deepStrictEqual(
			controller.snapshot.items.map((item) => item.type),
			['agentMessage', 'reasoning', 'userMessage'],
		);
		controller.dispose();
	});
});

/**
 * 결정적 ID와 시각을 사용하는 controller를 만든다.
 *
 * @param client 요청을 기록할 fake client.
 * @returns 테스트 controller.
 */
function createController(client: CodexConversationClient): CodexConversationController {
	let idSequence = 0;
	return new CodexConversationController({
		client,
		workspacePath: '/workspace',
		createId: () => `local-${++idSequence}`,
		now: () => 1_000,
	});
}

/**
 * controller에 텍스트 Webview 메시지를 전달한다.
 *
 * @param controller 대상 controller.
 * @param conversationId 대상 대화 ID.
 * @param text 사용자 입력.
 * @returns 요청 처리가 끝나면 완료되는 Promise.
 */
function send(
	controller: CodexConversationController,
	conversationId: string,
	text: string,
): Promise<void> {
	return controller.handleWebviewMessage({
		type: 'codexChat/send',
		payload: { conversationId, text },
	});
}

/**
 * thread/start parser가 소비하는 최소 유효 결과를 만든다.
 *
 * @param threadId 생성할 Thread ID.
 * @returns 최소 Thread start result.
 */
function threadStartResult(threadId: string): unknown {
	return {
		thread: {
			id: threadId,
			updatedAt: 1,
			status: { type: 'idle' },
			turns: [],
		},
	};
}

/**
 * turn/start parser가 소비하는 최소 유효 결과를 만든다.
 *
 * @param turnId 생성할 Turn ID.
 * @returns inProgress Turn start result.
 */
function turnStartResult(turnId: string): unknown {
	return { turn: turn(turnId, 'inProgress') };
}

/**
 * notification용 최소 유효 Turn을 만든다.
 *
 * @param id Turn ID.
 * @param status Turn 실행 상태.
 * @param items 포함할 core Item 목록.
 * @param error 실패 오류.
 * @param itemsView Item 배열 범위.
 * @returns 상태 reducer가 검증할 Turn 객체.
 */
function turn(
	id: string,
	status: 'inProgress' | 'completed' | 'interrupted' | 'failed',
	items: unknown[] = [],
	error: unknown = null,
	itemsView: 'notLoaded' | 'summary' | 'full' = 'full',
): unknown {
	return {
		id,
		items,
		itemsView,
		status,
		error,
		startedAt: 1,
		completedAt: status === 'inProgress' ? null : 2,
		durationMs: status === 'inProgress' ? null : 1_000,
	};
}

/**
 * runtime envelope validation을 통과한 형태의 notification을 만든다.
 *
 * @param method app-server method.
 * @param params method별 params.
 * @returns controller에 전달할 inbound notification.
 */
function notification(method: string, params: unknown): CodexInboundMessage {
	return {
		kind: 'notification',
		method,
		params,
		value: { method, params },
	};
}

/**
 * item started 또는 completed notification을 controller에 전달한다.
 *
 * @param controller 대상 controller.
 * @param method Item lifecycle method.
 * @param item core 5 Item.
 * @param timestamp Unix milliseconds.
 */
function applyItem(
	controller: CodexConversationController,
	method: 'item/started' | 'item/completed',
	item: unknown,
	timestamp: number,
): void {
	controller.handleAppServerMessage(notification(method, {
		threadId: 'thread-1',
		turnId: 'turn-1',
		item,
		[method === 'item/started' ? 'startedAtMs' : 'completedAtMs']: timestamp,
	}));
}

/** @returns 중복 제거 client ID를 가진 userMessage Item. */
function userItem(id: string, clientId: string): unknown {
	return {
		type: 'userMessage',
		id,
		clientId,
		content: [{ type: 'text', text: '코드를 확인해 줘', text_elements: [] }],
	};
}

/** @returns 지정 본문을 가진 agentMessage Item. */
function agentItem(id: string, text: string): unknown {
	return { type: 'agentMessage', id, text, phase: null, memoryCitation: null };
}

/** @returns summary와 content를 가진 reasoning Item. */
function reasoningItem(id: string): unknown {
	return { type: 'reasoning', id, summary: ['요약'], content: ['근거'] };
}

/** @returns 테스트 명령과 선택적 출력을 가진 commandExecution Item. */
function commandItem(id: string, output: string | null): unknown {
	return {
		type: 'commandExecution',
		id,
		pluginId: null,
		scriptPath: null,
		command: 'pnpm test',
		cwd: '/workspace',
		processId: null,
		source: 'agent',
		status: output === null ? 'inProgress' : 'completed',
		commandActions: [{ type: 'unknown', command: 'pnpm test' }],
		aggregatedOutput: output,
		exitCode: output === null ? null : 0,
		durationMs: output === null ? null : 100,
	};
}

/** @returns 하나의 update diff를 가진 fileChange Item. */
function fileItem(id: string): unknown {
	return {
		type: 'fileChange',
		id,
		changes: [{
			path: 'src/example.ts',
			kind: { type: 'update', move_path: null },
			diff: '+changed',
		}],
		status: 'completed',
	};
}

/** @returns 현재 queue에 예약된 Promise callback을 처리할 기회. */
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
