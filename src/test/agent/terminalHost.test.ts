import * as assert from 'assert';
import {
	generateTerminalSessionId,
	TerminalHost,
	TerminalHostRegistrationError,
	type TerminalHostRegistrationErrorCode,
} from '../../agent/host/terminal/terminalHost';
import type { TerminalSession } from '../../agent/host/terminal/terminalSession';
import { ID_MAX_LENGTH, ID_PATTERN } from '../../agent/protocol/limits';
import { FakePtyAdapter } from './support/fakePtyAdapter';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** createSession에는 Webview sessionId를 받을 수 있는 인자가 없음을 검증한다. */
type CreateSessionAcceptsOnlyTabId = Assert<Equal<
	Parameters<TerminalHost['createSession']>,
	[tabId: string]
>>;

function assertRegistrationError(
	action: () => void,
	code: TerminalHostRegistrationErrorCode,
): void {
	assert.throws(action, (error: unknown) => {
		assert.ok(error instanceof TerminalHostRegistrationError);
		assert.strictEqual(error.code, code);
		return true;
	});
}

suite('TerminalHost session registry', () => {
	test('Host generator로 protocol 규칙을 만족하는 sessionId를 생성한다', () => {
		const first = generateTerminalSessionId();
		const second = generateTerminalSessionId();

		assert.match(first, ID_PATTERN);
		assert.ok(first.length <= ID_MAX_LENGTH);
		assert.notStrictEqual(first, second);
	});

	test('주입한 Host generator만 사용하고 Webview 추가 값을 sessionId로 사용하지 않는다', () => {
		const adapter = new FakePtyAdapter();
		const host = new TerminalHost({
			ptyAdapter: adapter,
			sessionIdGenerator: () => 'session-host-generated',
		});
		const createWithUntrustedExtra = host.createSession.bind(host) as unknown as (
			tabId: string,
			webviewSessionId: string,
		) => TerminalSession;

		const session = createWithUntrustedExtra(
			'tab-one',
			'session-from-webview',
		);

		assert.strictEqual(session.sessionId, 'session-host-generated');
		assert.notStrictEqual(session.sessionId, 'session-from-webview');
		assert.strictEqual(adapter.spawnCalls.length, 0);
	});

	test('한 tab에 현재 session을 하나만 등록한다', () => {
		let generatorCalls = 0;
		const host = new TerminalHost({
			ptyAdapter: new FakePtyAdapter(),
			sessionIdGenerator: () => {
				generatorCalls += 1;
				return `session-${generatorCalls}`;
			},
		});
		const first = host.createSession('tab-one');

		assertRegistrationError(
			() => host.createSession('tab-one'),
			'tab_already_has_session',
		);
		assert.strictEqual(generatorCalls, 1);
		assert.strictEqual(host.getActiveSession('tab-one'), first);
	});

	test('sessionId와 tabId lookup 및 양방향 ownership을 제공한다', () => {
		const generatedIds = ['session-one', 'session-two'];
		const host = new TerminalHost({
			ptyAdapter: new FakePtyAdapter(),
			sessionIdGenerator: () => generatedIds.shift() ?? 'session-unused',
		});
		const first = host.createSession('tab-one');
		const second = host.createSession('tab-two');

		assert.strictEqual(host.getSession('session-one'), first);
		assert.strictEqual(host.getSession('session-two'), second);
		assert.strictEqual(host.getSession('session-unknown'), undefined);
		assert.strictEqual(host.getActiveSession('tab-one'), first);
		assert.strictEqual(host.getActiveSession('tab-two'), second);
		assert.strictEqual(host.getActiveSession('tab-unknown'), undefined);
		assert.strictEqual(host.ownsSession('tab-one', 'session-one'), true);
		assert.strictEqual(host.ownsSession('tab-two', 'session-two'), true);
		assert.strictEqual(host.ownsSession('tab-one', 'session-two'), false);
		assert.strictEqual(host.ownsSession('tab-two', 'session-one'), false);
	});

	test('sessionId collision 시 기존 session과 tab mapping을 덮어쓰지 않는다', () => {
		const host = new TerminalHost({
			ptyAdapter: new FakePtyAdapter(),
			sessionIdGenerator: () => 'session-collision',
		});
		const existing = host.createSession('tab-existing');

		assertRegistrationError(
			() => host.createSession('tab-new'),
			'session_id_collision',
		);
		assert.strictEqual(host.getSession('session-collision'), existing);
		assert.strictEqual(host.getActiveSession('tab-existing'), existing);
		assert.strictEqual(host.getActiveSession('tab-new'), undefined);
		assert.strictEqual(
			host.ownsSession('tab-existing', 'session-collision'),
			true,
		);
	});

	test('잘못 생성된 sessionId를 Map에 등록하지 않는다', () => {
		for (const generatedId of ['', 'invalid id', `s${'x'.repeat(ID_MAX_LENGTH)}`]) {
			const host = new TerminalHost({
				ptyAdapter: new FakePtyAdapter(),
				sessionIdGenerator: () => generatedId,
			});

			assertRegistrationError(
				() => host.createSession('tab-invalid-id'),
				'invalid_generated_session_id',
			);
			assert.strictEqual(host.getActiveSession('tab-invalid-id'), undefined);
		}
	});

	test('session을 두 Map에서 제거하고 같은 tab에 새 session을 등록한다', () => {
		const generatedIds = ['session-before-remove', 'session-after-remove'];
		const adapter = new FakePtyAdapter();
		const host = new TerminalHost({
			ptyAdapter: adapter,
			sessionIdGenerator: () => generatedIds.shift() ?? 'session-unused',
		});
		const before = host.createSession('tab-reusable');

		assert.strictEqual(host.removeSession(before.sessionId), before);
		assert.strictEqual(host.removeSession(before.sessionId), undefined);
		assert.strictEqual(host.getSession(before.sessionId), undefined);
		assert.strictEqual(host.getActiveSession('tab-reusable'), undefined);
		assert.strictEqual(
			host.ownsSession('tab-reusable', before.sessionId),
			false,
		);

		const after = host.createSession('tab-reusable');
		assert.strictEqual(after.sessionId, 'session-after-remove');
		assert.strictEqual(host.getActiveSession('tab-reusable'), after);
		assert.strictEqual(adapter.spawnCalls.length, 0);
	});
});

