import * as assert from 'assert';
import * as os from 'os';
import { NodePtyAdapter } from '../../agent/host/terminal/nodePtyAdapter';
import type { PtyProcessHandle } from '../../agent/host/terminal/ptyAdapter';
import { TerminalHost } from '../../agent/host/terminal/terminalHost';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';

/**
 * 실제 shell을 사용하는 smoke 흐름의 상한 시간이다.
 * 단위 테스트보다 길지만 전체 test 실행을 막지 않는 값으로 제한한다.
 */
const SMOKE_TIMEOUT_MS = 20_000;

/** 실제 PTY 출력이 도착할 때까지 기다리는 개별 단계의 상한 시간이다. */
const STEP_TIMEOUT_MS = 8_000;

/** 실제 출력 대기 사이의 polling 간격이다. */
const POLL_INTERVAL_MS = 20;

/**
 * 이 환경에서 실제 shell smoke를 실행할 수 있는지 판단한다.
 * POSIX 이외 플랫폼은 별도 실행 계약이 필요하므로 smoke 대상에서 제외한다.
 *
 * @returns POSIX 환경이면 `true`
 */
function isPosixSmokeEnvironment(): boolean {
	return process.platform === 'darwin' || process.platform === 'linux';
}

/**
 * smoke 전용 실행 계약을 만든다.
 * Host 정책 경로 대신 어떤 workspace 설정에서도 재현 가능한 고정 shell을 사용한다.
 *
 * @returns 실제 PTY를 시작할 수 있는 최소 실행 계약
 */
function createSmokeLaunchPolicy(): ShellLaunchPolicy {
	return {
		executable: '/bin/sh',
		args: [],
		cwd: os.tmpdir(),
		env: {
			...process.env,
			PS1: '$ ',
			TERM: 'xterm-256color',
		},
	};
}

/**
 * smoke 실행 계약을 그대로 돌려주는 준비 함수다.
 * workspace 및 Shell 정책 자체는 기존 단위 테스트가 검증하므로 여기서는 고정한다.
 */
const smokePrepareLaunch: PrepareTerminalLaunch = async () => ({
	ok: true,
	policy: createSmokeLaunchPolicy(),
});

/**
 * 지정한 시간만큼 대기한다.
 *
 * @param milliseconds 대기할 시간
 * @returns 대기가 끝나면 완료되는 Promise
 */
function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 조건이 참이 될 때까지 상한 시간 안에서 반복 확인한다.
 * 실패 원인을 노출하지 않기 위해 결과를 boolean으로만 반환한다.
 *
 * @param predicate 매 회 확인할 조건
 * @param timeoutMs 조건 확인을 포기할 상한 시간
 * @returns 상한 시간 안에 조건이 참이 되면 `true`
 */
async function pollUntil(
	predicate: () => boolean,
	timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}

		await delay(POLL_INTERVAL_MS);
	}

	return predicate();
}

/**
 * 실제 PTY 흐름을 관찰하기 위한 Host 메시지 수집기다.
 * terminal 내용은 assertion 결과 boolean으로만 사용하고 로그로 남기지 않는다.
 */
class SmokeMessageLog {
	/** 수신한 Host 메시지를 도착 순서대로 보관한다. */
	readonly messages: HostToWebviewMessage[] = [];

	/**
	 * 특정 session의 output만 순서대로 이어 붙여 돌려준다.
	 *
	 * @param sessionId 확인할 Host 소유 session 식별자
	 * @returns 해당 session이 만든 출력 문자열 전체
	 */
	outputFor(sessionId: string): string {
		return this.messages
			.filter((message): message is Extract<
				HostToWebviewMessage,
				{ type: 'terminal.output' }
			> => message.type === 'terminal.output'
				&& message.sessionId === sessionId)
			.map((message) => message.data)
			.join('');
	}

	/**
	 * 특정 session의 종료 메시지를 찾는다.
	 *
	 * @param sessionId 확인할 Host 소유 session 식별자
	 * @returns 종료 메시지 또는 아직 종료하지 않았으면 `undefined`
	 */
	exitFor(sessionId: string): Extract<
		HostToWebviewMessage,
		{ type: 'terminal.exited' }
	> | undefined {
		return this.messages.find((message): message is Extract<
			HostToWebviewMessage,
			{ type: 'terminal.exited' }
		> => message.type === 'terminal.exited'
			&& message.sessionId === sessionId);
	}

	/**
	 * 특정 tab에서 시작에 성공한 session 식별자를 순서대로 모은다.
	 *
	 * @param tabId 확인할 Webview 탭 식별자
	 * @returns 시작된 session 식별자 목록
	 */
	startedSessionIds(tabId: string): string[] {
		return this.messages
			.filter((message): message is Extract<
				HostToWebviewMessage,
				{ type: 'terminal.started' }
			> => message.type === 'terminal.started' && message.tabId === tabId)
			.map((message) => message.sessionId);
	}
}

suite('node-pty runtime smoke', function () {
	this.timeout(SMOKE_TIMEOUT_MS);

	test('현재 개발 환경에서 실제 shell 하나를 PTY로 실행하고 정리한다', async function () {
		if (!isPosixSmokeEnvironment()) {
			this.skip();
		}

		const adapter = new NodePtyAdapter();
		const policy = createSmokeLaunchPolicy();
		let handle: PtyProcessHandle | undefined;
		let received = '';
		let exited = false;

		try {
			handle = adapter.spawn({
				executable: policy.executable,
				args: policy.args,
				cwd: policy.cwd,
				env: policy.env,
				cols: 80,
				rows: 24,
			});

			assert.strictEqual(Number.isSafeInteger(handle.pid), true);
			assert.strictEqual(handle.pid > 0, true);

			const dataSubscription = handle.onData((data) => {
				received += data;
			});
			const exitSubscription = handle.onExit(() => {
				exited = true;
			});

			handle.write('echo "$(printf CRISPY; printf SMOKE)"\r');
			assert.strictEqual(
				await pollUntil(() => received.includes('CRISPYSMOKE')),
				true,
			);

			handle.write('exit\r');
			assert.strictEqual(await pollUntil(() => exited), true);

			dataSubscription.dispose();
			exitSubscription.dispose();
		} finally {
			try {
				handle?.kill();
			} catch {
				/* 이미 종료된 process의 정리 실패는 smoke 결과에 반영하지 않는다. */
			}
		}
	});
});

suite('Terminal end-to-end smoke', function () {
	this.timeout(SMOKE_TIMEOUT_MS);

	let host: TerminalHost | undefined;

	teardown(() => {
		host?.dispose();
		host = undefined;
	});

	test('자동 시작부터 입출력, 크기 변경, 종료와 재시작까지 실제 shell로 통과한다', async function () {
		if (!isPosixSmokeEnvironment()) {
			this.skip();
		}

		const log = new SmokeMessageLog();
		const tabId = 'tab-smoke';
		host = new TerminalHost({
			ptyAdapter: new NodePtyAdapter(),
			prepareLaunch: smokePrepareLaunch,
			emitMessage: (message) => log.messages.push(message),
		});

		await host.startSession(tabId, 80, 24);

		const firstSession = host.getActiveSession(tabId);
		assert.ok(firstSession);
		assert.strictEqual(firstSession.state.kind, 'running');
		assert.deepStrictEqual(log.startedSessionIds(tabId), [
			firstSession.sessionId,
		]);

		const sessionId = firstSession.sessionId;
		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: 'echo "$(printf CRISPY; printf SMOKE)"\r',
		});
		assert.strictEqual(
			await pollUntil(() => log.outputFor(sessionId).includes('CRISPYSMOKE')),
			true,
		);

		host.routeResize({
			type: 'terminal.resize',
			tabId,
			sessionId,
			cols: 100,
			rows: 30,
		});
		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: 'echo "$(printf SIZE)=$(stty size | tr \' \' x)"\r',
		});
		assert.strictEqual(
			await pollUntil(() => log.outputFor(sessionId).includes('SIZE=30x100')),
			true,
		);

		const outputLengthBeforeInterrupt = log.outputFor(sessionId).length;
		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: '\u0003',
		});
		assert.strictEqual(
			await pollUntil(
				() => log.outputFor(sessionId)
					.slice(outputLengthBeforeInterrupt)
					.includes('$ '),
			),
			true,
		);
		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: 'echo "$(printf AFTER; printf INTERRUPT)"\r',
		});
		assert.strictEqual(
			await pollUntil(
				() => log.outputFor(sessionId).includes('AFTERINTERRUPT'),
			),
			true,
		);
		assert.strictEqual(host.getActiveSession(tabId)?.state.kind, 'running');

		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: 'exit\r',
		});
		assert.strictEqual(
			await pollUntil(() => log.exitFor(sessionId) !== undefined),
			true,
		);
		assert.strictEqual(host.getActiveSession(tabId)?.state.kind, 'exited');

		await host.restartSession(tabId, sessionId);

		const restartedSession = host.getActiveSession(tabId);
		assert.ok(restartedSession);
		assert.strictEqual(restartedSession.state.kind, 'running');
		assert.strictEqual(restartedSession.sessionId === sessionId, false);
		assert.strictEqual(log.startedSessionIds(tabId).length, 2);

		const restartedSessionId = restartedSession.sessionId;
		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId: restartedSessionId,
			data: 'echo "$(printf RESTART; printf OK)"\r',
		});
		assert.strictEqual(
			await pollUntil(
				() => log.outputFor(restartedSessionId).includes('RESTARTOK'),
			),
			true,
		);

		host.dispose();
		host = undefined;
		assert.strictEqual(restartedSession.state.kind, 'disposed');
	});

	test('실제 shell의 ANSI 색상과 한글 출력을 변환 없이 그대로 전달한다', async function () {
		if (!isPosixSmokeEnvironment()) {
			this.skip();
		}

		const log = new SmokeMessageLog();
		const tabId = 'tab-smoke-encoding';
		host = new TerminalHost({
			ptyAdapter: new NodePtyAdapter(),
			prepareLaunch: smokePrepareLaunch,
			emitMessage: (message) => log.messages.push(message),
		});

		await host.startSession(tabId, 80, 24);
		const session = host.getActiveSession(tabId);
		assert.ok(session);
		const sessionId = session.sessionId;

		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: 'printf \'\\033[31mRD\\033[0m\\n\'\r',
		});
		assert.strictEqual(
			await pollUntil(
				() => log.outputFor(sessionId).includes('\u001b[31mRD\u001b[0m'),
			),
			true,
		);

		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: 'printf \'\\033[38;2;215;119;87mTC\\033[0m\\n\'\r',
		});
		assert.strictEqual(
			await pollUntil(
				() => log.outputFor(sessionId).includes(
					'\u001b[38;2;215;119;87mTC\u001b[0m',
				),
			),
			true,
		);

		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: 'printf \'\\355\\225\\234\\352\\270\\200\\n\'\r',
		});
		assert.strictEqual(
			await pollUntil(() => log.outputFor(sessionId).includes('한글')),
			true,
		);

		const beforeKoreanInput = log.outputFor(sessionId).length;
		host.routeInput({
			type: 'terminal.input',
			tabId,
			sessionId,
			data: '한글 입력',
		});
		assert.strictEqual(
			await pollUntil(() => log
				.outputFor(sessionId)
				.slice(beforeKoreanInput)
				.includes('한글 입력')),
			true,
		);
		assert.strictEqual(host.getActiveSession(tabId)?.state.kind, 'running');
	});
});
