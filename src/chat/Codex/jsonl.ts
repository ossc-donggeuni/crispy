/** stdout의 임의 chunk를 손실 없는 JSONL 줄로 조립하는 stream decoder 모듈이다. */

import { StringDecoder } from 'node:string_decoder';

/** stdout에서 받은 Buffer 또는 테스트에서 전달하는 문자열 chunk다. */
export type JsonlChunk = Buffer | string;

/**
 * 임의의 stream chunk를 손실 없이 JSONL 원문 줄로 조립한다.
 * UTF-8 문자가 Buffer 경계에서 나뉘는 경우도 StringDecoder로 보존한다.
 */
export class JsonlLineDecoder {
	/** Buffer 경계에서 분할된 UTF-8 byte를 다음 chunk까지 보존하는 decoder다. */
	private readonly decoder = new StringDecoder('utf8');
	/** 아직 개행으로 끝나지 않아 다음 chunk와 합쳐야 하는 문자열이다. */
	private buffered = '';
	/** finish 이후 추가 입력을 거부하기 위한 lifecycle flag다. */
	private finished = false;

	/**
	 * 아직 종료되지 않은 decoder에 다음 chunk를 추가한다.
	 *
	 * @param chunk stdout에서 수신한 원문 chunk
	 * @returns 이번 chunk로 완성된 개행 제외 JSONL 원문 줄
	 */
	public push(chunk: JsonlChunk): string[] {
		if (this.finished) {
			throw new Error('종료된 JSONL decoder에는 chunk를 추가할 수 없습니다.');
		}

		const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		this.buffered += this.decoder.write(buffer);
		return this.takeCompleteLines();
	}

	/**
	 * UTF-8 decoder와 마지막 미개행 줄을 비우고 decoder를 종료한다.
	 *
	 * @returns stream 종료 시 새로 완성된 마지막 원문 줄
	 */
	public finish(): string[] {
		if (this.finished) {
			return [];
		}
		this.finished = true;
		this.buffered += this.decoder.end();

		const lines = this.takeCompleteLines();
		if (this.buffered.length > 0) {
			lines.push(this.stripCarriageReturn(this.buffered));
			this.buffered = '';
		}
		return lines;
	}

	/**
	 * buffered 문자열에서 개행으로 끝난 줄만 순서대로 분리한다.
	 *
	 * @returns 개행과 선택적 carriage return을 제거한 완성 JSONL 줄.
	 */
	private takeCompleteLines(): string[] {
		const lines: string[] = [];
		let newlineIndex = this.buffered.indexOf('\n');
		while (newlineIndex !== -1) {
			lines.push(this.stripCarriageReturn(this.buffered.slice(0, newlineIndex)));
			this.buffered = this.buffered.slice(newlineIndex + 1);
			newlineIndex = this.buffered.indexOf('\n');
		}
		return lines;
	}

	/**
	 * @param line 개행을 제외한 JSONL 원문 후보.
	 * @returns CRLF 입력의 마지막 carriage return만 제거한 문자열.
	 */
	private stripCarriageReturn(line: string): string {
		return line.endsWith('\r') ? line.slice(0, -1) : line;
	}
}
