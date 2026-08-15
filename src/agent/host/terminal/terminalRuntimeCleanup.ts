/** Panel 정리 시 해제할 Webview 구독 하나의 최소 계약이다. */
export interface TerminalRuntimeSubscription {
	dispose(): void;
}

/**
 * Panel 하나가 소유한 terminal runtime 전체를 정리하는 최소 계약이다.
 * `TerminalHost`가 이미 제공하는 정리 경계를 그대로 만족하며 테스트에서 fake로 대체할 수 있다.
 */
export interface DisposableTerminalRuntime {
	dispose(): void | Promise<void>;
}

/**
 * PTY 종료가 플랫폼에 따라 지연되어도 VS Code 종료를 막지 않기 위한 기본 상한 시간이다.
 */
export const TERMINAL_CLEANUP_TIMEOUT_MS = 3000;

/**
 * Panel dispose와 Extension deactivate가 공유하는 단일 정리 함수를 만든다.
 * terminal runtime 정리를 먼저 수행한 뒤 Webview 구독을 해제하며,
 * 개별 실패를 다른 정리 단계나 호출자에게 전파하지 않는다.
 *
 * @param terminalRuntime PTY와 session 참조를 정리하는 Host 소유 runtime
 * @param subscriptions runtime 정리 뒤 해제할 Webview message listener 구독 목록
 * @returns 호출 시 정리를 수행하고 실패해도 항상 이행되는 함수
 */
export function createTerminalRuntimeCleanup(
	terminalRuntime: DisposableTerminalRuntime,
	subscriptions: readonly TerminalRuntimeSubscription[],
): () => Promise<void> {
	return async (): Promise<void> => {
		try {
			await terminalRuntime.dispose();
		} catch {
			/* PTY 정리 실패가 남은 구독 해제를 막지 않게 한다. */
		}

		for (const subscription of subscriptions) {
			try {
				subscription.dispose();
			} catch {
				/* 개별 구독 해제 실패가 나머지 정리를 막지 않게 한다. */
			}
		}
	};
}

/**
 * 정리 함수에 상한 시간을 적용해 Extension 종료가 무기한 지연되지 않게 한다.
 * 상한을 넘기면 남은 정리는 best-effort로 계속 진행되며 반환된 Promise는 즉시 이행된다.
 * 정리 도중 발생한 동기·비동기 오류도 호출자에게 전파하지 않는다.
 *
 * @param cleanup 실행할 정리 함수
 * @param timeoutMs 정리 완료를 기다릴 상한 시간
 * @returns 정리 완료 또는 상한 시간 도달 중 먼저 발생한 시점에 이행되는 Promise
 */
export async function runCleanupWithTimeout(
	cleanup: () => void | Promise<void>,
	timeoutMs: number = TERMINAL_CLEANUP_TIMEOUT_MS,
): Promise<void> {
	const running = (async () => {
		await cleanup();
	})().catch(() => undefined);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});

	try {
		await Promise.race([running, deadline]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}
