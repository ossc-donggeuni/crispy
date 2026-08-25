import { randomUUID } from 'node:crypto';
import type { SessionId } from '../../protocol/messages';
import { ID_MAX_LENGTH, ID_PATTERN } from '../../protocol/limits';

/** TerminalHost panel lifetime에 한 번 생성되는 session ID allocator 설정이다. */
export interface TerminalSessionIdAllocatorOptions {
	/** Production은 CSPRNG UUID를 사용하며 deterministic test만 고정 nonce를 주입한다. */
	readonly nonce?: string;

	/** Overflow 경계 test를 위한 최초 counter이며 production은 1에서 시작한다. */
	readonly initialCounter?: number;
}

/** Candidate가 현재 Host registry에 이미 살아 있는지 확인하는 read-only 경계다. */
export type ActiveTerminalSessionIdReader = (sessionId: SessionId) => boolean;

const SESSION_ID_NONCE_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Panel lifetime 전체가 공유하는 ASCII nonce와 단조 증가 counter로 session ID를 만든다.
 * 제거된 ID의 historical Set은 보관하지 않으며 collision/overflow에서 재시도하지 않는다.
 */
export class TerminalSessionIdAllocator {
	private readonly nonce!: string;
	private nextCounter: number;
	private exhausted = false;

	constructor(options: TerminalSessionIdAllocatorOptions = {}) {
		Object.defineProperty(this, 'nonce', {
			value: options.nonce ?? randomUUID(),
			enumerable: false,
			writable: false,
			configurable: false,
		});
		this.nextCounter = options.initialCounter ?? 1;
	}

	/** 현재 counter 하나만 소비하며 validation이나 active collision 실패는 fail-closed다. */
	allocate(isActive: ActiveTerminalSessionIdReader): SessionId | undefined {
		const counter = this.nextCounter;
		if (
			this.exhausted
			|| !Number.isSafeInteger(counter)
			|| counter < 1
			|| counter > Number.MAX_SAFE_INTEGER
		) {
			return undefined;
		}
		if (counter === Number.MAX_SAFE_INTEGER) {
			this.exhausted = true;
		} else {
			this.nextCounter = counter + 1;
		}

		if (!SESSION_ID_NONCE_PATTERN.test(this.nonce)) {
			return undefined;
		}

		const candidate = `session-${this.nonce}-${counter}`;
		if (
			candidate.length > ID_MAX_LENGTH
			|| !ID_PATTERN.test(candidate)
		) {
			return undefined;
		}

		try {
			return isActive(candidate) ? undefined : candidate;
		} catch {
			return undefined;
		}
	}
}
