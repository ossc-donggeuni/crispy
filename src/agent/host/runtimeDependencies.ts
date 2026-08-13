import * as nodePty from 'node-pty';

/** Extension Host에서 사용하는 native PTY runtime의 최소 공개 표면이다. */
export const HOST_TERMINAL_RUNTIME = Object.freeze({
	spawn: nodePty.spawn,
});

/**
 * 현재 플랫폼용 node-pty native module이 실제로 로드되었는지 확인한다.
 * PTY를 생성하지 않으며 실행 정책이나 workspace 경로도 다루지 않는다.
 */
export function assertHostTerminalRuntimeAvailable(): void {
	if (typeof HOST_TERMINAL_RUNTIME.spawn !== 'function') {
		throw new Error('Crispy terminal runtime is unavailable.');
	}
}
