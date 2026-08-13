import type { TerminalHostMessage } from '../protocol';
import { TERMINAL_POLICY } from '../policy';

/** 숨김 Webview와 비동기 전송 사이에서 Host 메시지 순서와 buffer 상한을 보존한다. */
export class HostMessageBuffer {
	private readonly messages: TerminalHostMessage[] = [];
	private readonly outputBytesBySession = new Map<string, number>();
	private headInFlight = false;

	/**
	 * Host 메시지 버퍼를 생성한다.
	 *
	 * @param maxOutputBytes 세션 하나가 보류할 수 있는 terminal 출력의 최대 byte 수
	 */
	public constructor(
		private readonly maxOutputBytes = TERMINAL_POLICY.maxBufferedOutputBytes,
	) {}

	/** @returns 현재 전송 대기 중인 Host 메시지 수 */
	public get size(): number {
		return this.messages.length;
	}

	/**
	 * 지정 세션의 보류된 terminal 출력 크기를 조회한다.
	 *
	 * @param sessionId 출력 크기를 조회할 Host 소유 세션 ID
	 * @returns UTF-8 기준으로 계산한 보류 출력 byte 수
	 */
	public getBufferedOutputBytes(sessionId: string): number {
		return this.outputBytesBySession.get(sessionId) ?? 0;
	}

	/**
	 * 메시지를 queue에 추가한다. output은 session별 byte 상한을 넘으면 chunk를 자르지 않고 거부한다.
	 * 전송 중인 head는 합치지 않아 retry 경계를 유지한다.
	 *
	 * @param message 순서를 보존하여 Webview에 전달할 Host 메시지
	 * @returns 메시지가 온전히 queue에 추가됐는지 여부
	 */
	public enqueue(message: TerminalHostMessage): boolean {
		if (message.type === 'terminal/output') {
			const byteLength = Buffer.byteLength(message.payload.data, 'utf8');
			const buffered = this.getBufferedOutputBytes(message.payload.sessionId);

			if (buffered + byteLength > this.maxOutputBytes) {
				return false;
			}

			this.outputBytesBySession.set(message.payload.sessionId, buffered + byteLength);
		}

		const lastIndex = this.messages.length - 1;
		const last = this.messages[lastIndex];
		const lastIsNotInFlight = !this.headInFlight || lastIndex > 0;

		if (
			lastIsNotInFlight
			&& message.type === 'terminal/output'
			&& last?.type === 'terminal/output'
			&& last.payload.sessionId === message.payload.sessionId
		) {
			this.messages[lastIndex] = {
				type: 'terminal/output',
				payload: {
					sessionId: message.payload.sessionId,
					data: last.payload.data + message.payload.data,
				},
			};
			return true;
		}

		this.messages.push(message);
		return true;
	}

	/**
	 * queue head를 한 번만 전송 중 상태로 전환한다.
	 *
	 * @returns 전송을 시작할 head 메시지이며, 이미 전송 중이거나 비어 있으면 undefined
	 */
	public beginDelivery(): TerminalHostMessage | undefined {
		if (this.headInFlight) {
			return undefined;
		}

		const message = this.messages[0];
		if (message) {
			this.headInFlight = true;
		}

		return message;
	}

	/**
	 * 성공한 head만 제거하고 output byte 회계를 갱신한다. 실패한 head는 그대로 재시도한다.
	 *
	 * @param delivered Webview가 head 메시지를 수신했는지 여부
	 */
	public completeDelivery(delivered: boolean): void {
		if (!this.headInFlight) {
			return;
		}

		if (delivered) {
			const message = this.messages.shift();
			if (message?.type === 'terminal/output') {
				const sessionId = message.payload.sessionId;
				const remaining = this.getBufferedOutputBytes(sessionId)
					- Buffer.byteLength(message.payload.data, 'utf8');

				if (remaining > 0) {
					this.outputBytesBySession.set(sessionId, remaining);
				} else {
					this.outputBytesBySession.delete(sessionId);
				}
			}
		}

		this.headInFlight = false;
	}

	/** 대기 메시지, byte 회계 및 전송 중 상태를 모두 초기화한다. */
	public clear(): void {
		this.messages.length = 0;
		this.outputBytesBySession.clear();
		this.headInFlight = false;
	}
}
