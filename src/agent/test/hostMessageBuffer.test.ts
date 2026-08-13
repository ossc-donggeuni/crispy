import * as assert from 'assert';
import { HostMessageBuffer } from '../host/hostMessageBuffer';
import type { TerminalHostMessage } from '../protocol';

/**
 * 숨김 Webview 출력의 병합, in-flight 경계, retry 및 byte 상한을 검증한다.
 */
suite('Agent Terminal Host Message Buffer', () => {
	test('연속 output을 합치되 in-flight head와 상태 경계를 보존한다', () => {
		const buffer = new HostMessageBuffer();
		buffer.enqueue(output('A'));
		buffer.enqueue(output('B'));

		assert.strictEqual(buffer.size, 1);
		assert.deepStrictEqual(buffer.beginDelivery(), output('AB'));
		buffer.enqueue(output('C'));
		assert.strictEqual(buffer.size, 2);
		buffer.completeDelivery(true);
		assert.deepStrictEqual(buffer.beginDelivery(), output('C'));
		buffer.completeDelivery(false);
		assert.strictEqual(buffer.size, 1);
		assert.deepStrictEqual(buffer.beginDelivery(), output('C'));
		buffer.completeDelivery(true);
		assert.strictEqual(buffer.size, 0);

		buffer.enqueue(output('D'));
		buffer.enqueue({
			type: 'terminal/exited',
			payload: { sessionId: 'session-1', exitCode: 0 },
		});
		buffer.enqueue(output('E'));
		assert.strictEqual(buffer.size, 3);
	});

	test('session별 UTF-8 byte 상한에서 chunk를 자르지 않고 overflow를 거부한다', () => {
		const buffer = new HostMessageBuffer(4);

		assert.strictEqual(buffer.enqueue(output('😀')), true);
		assert.strictEqual(buffer.getBufferedOutputBytes('session-1'), 4);
		assert.strictEqual(buffer.enqueue(output('A')), false);
		assert.strictEqual(buffer.getBufferedOutputBytes('session-1'), 4);
		assert.deepStrictEqual(buffer.beginDelivery(), output('😀'));
		buffer.completeDelivery(true);
		assert.strictEqual(buffer.getBufferedOutputBytes('session-1'), 0);
	});
});

/**
 * 테스트용 terminal 출력 메시지를 생성한다.
 *
 * @param data session-1에 연결할 terminal 출력 문자열
 * @returns Host message buffer에 넣을 terminal 출력 메시지
 */
function output(data: string): TerminalHostMessage {
	return { type: 'terminal/output', payload: { sessionId: 'session-1', data } };
}
