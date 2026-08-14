import type {
	PtyAdapter,
	PtyExitEvent,
	PtyListenerDisposable,
	PtyProcessHandle,
	PtySpawnOptions,
} from './ptyAdapter';

/**
 * `node-pty` 모듈 로드 또는 process 생성 실패를 나타내는 안정적인 내부 오류 코드다.
 */
export const PTY_SPAWN_ERROR_CODE = 'pty_spawn_failed' as const;

/**
 * `node-pty` 모듈 로드 또는 spawn 실패를 안전하게 감싸는 Host 내부 오류다.
 * 원본 exception, executable, args, cwd와 environment를 저장하거나 노출하지 않는다.
 */
export class PtySpawnError extends Error {
	/** 상위 TerminalSession 계층에서 사용할 안정적인 실패 식별자다. */
	readonly code = PTY_SPAWN_ERROR_CODE;

	/** 고정된 안전 메시지만 가진 PTY 시작 오류를 생성한다. */
	constructor() {
		super('PTY process could not be started.');
		this.name = 'PtySpawnError';
	}
}

/** `node-pty` listener 구독 객체에서 필요한 최소 해제 계약이다. */
interface NodePtyDisposable {
	/** 등록된 listener를 해제한다. */
	dispose(): void;
}

/** `node-pty`의 `IPty` 중 Host adapter가 사용하는 최소 기능 집합이다. */
interface NodePtyProcess {
	/** 생성된 shell process의 PID다. */
	readonly pid: number;

	/** PTY의 표준 입력으로 문자열을 전달한다. */
	write(data: string): void;

	/** PTY의 열과 행 크기를 변경한다. */
	resize(cols: number, rows: number): void;

	/** PTY에 종료를 요청한다. */
	kill(): void;

	/** PTY 출력 listener를 등록하고 해제 객체를 반환한다. */
	onData(listener: (data: string) => void): NodePtyDisposable;

	/** PTY 종료 listener를 등록하고 해제 객체를 반환한다. */
	onExit(
		listener: (event: { exitCode: number; signal?: number }) => void,
	): NodePtyDisposable;
}

/** `node-pty.spawn()`에 전달하는 native binding 전용 옵션이다. */
interface NodePtySpawnOptions {
	/** 검증된 workspace filesystem 경로다. */
	readonly cwd: string;

	/** Extension Host가 소유하는 process 환경 snapshot이다. */
	readonly env: NodeJS.ProcessEnv;

	/** 생성할 PTY의 초기 열 수다. */
	readonly cols: number;

	/** 생성할 PTY의 초기 행 수다. */
	readonly rows: number;

	/** PTY data event를 문자열로 받기 위한 고정 인코딩이다. */
	readonly encoding: 'utf8';
}

/**
 * production adapter가 `node-pty`에서 사용하는 최소 module binding이다.
 * 테스트에서는 이 구조를 구현한 객체를 주입하여 native module 없이 위임 동작을 검증한다.
 */
export interface NodePtyBinding {
	/**
	 * 검증된 Host 실행 계약으로 PTY process를 생성한다.
	 *
	 * @param executable Extension Host가 선택하고 검증한 실행 파일이다.
	 * @param args Extension Host가 결정한 실행 인자다.
	 * @param options workspace와 초기 terminal 크기를 포함한 native 옵션이다.
	 * @returns 생성된 `node-pty` process다.
	 */
	spawn(
		executable: string,
		args: string[],
		options: NodePtySpawnOptions,
	): NodePtyProcess;
}

/**
 * `node-pty` module binding을 반환하는 지연 로더다.
 * production에서는 실제 native module을 불러오고 테스트에서는 가짜 binding을 반환한다.
 */
export type NodePtyBindingLoader = () => NodePtyBinding;

/**
 * 실제 `node-pty` native module을 불러온다.
 * Extension 활성화 중에는 호출되지 않고 `NodePtyAdapter.spawn()` 경계에서만 호출된다.
 *
 * @returns 현재 플랫폼에서 로드한 `node-pty` binding이다.
 */
function loadNodePtyBinding(): NodePtyBinding {
	return require('node-pty') as NodePtyBinding;
}

/** `node-pty` process를 상위 계층의 `PtyProcessHandle` 계약으로 변환한다. */
class NodePtyProcessHandle implements PtyProcessHandle {
	/**
	 * @param process adapter 내부에서만 보관하는 실제 `node-pty` process다.
	 */
	constructor(private readonly process: NodePtyProcess) {}

	/** 생성된 shell process의 PID를 반환한다. */
	get pid(): number {
		return this.process.pid;
	}

	/**
	 * 문자열을 실제 PTY 입력으로 전달한다.
	 *
	 * @param data Host가 전달하기로 결정한 입력 문자열이다.
	 */
	write(data: string): void {
		this.process.write(data);
	}

	/**
	 * 실제 PTY 크기를 변경한다.
	 *
	 * @param cols 변경할 열 수다.
	 * @param rows 변경할 행 수다.
	 */
	resize(cols: number, rows: number): void {
		this.process.resize(cols, rows);
	}

	/** 실제 PTY에 종료를 요청한다. */
	kill(): void {
		this.process.kill();
	}

	/**
	 * 실제 PTY 출력 listener를 등록한다.
	 *
	 * @param listener PTY 출력 문자열을 받을 함수다.
	 * @returns native listener를 해제할 수 있는 구독 객체다.
	 */
	onData(listener: (data: string) => void): PtyListenerDisposable {
		return this.process.onData(listener);
	}

	/**
	 * `node-pty` 종료 이벤트를 Host 내부 이벤트 형태로 복사해 전달한다.
	 * 반환된 구독 객체를 dispose하면 native listener도 해제된다.
	 *
	 * @param listener exit code와 선택적 signal을 받을 함수다.
	 * @returns native listener를 해제할 수 있는 구독 객체다.
	 */
	onExit(listener: (event: PtyExitEvent) => void): PtyListenerDisposable {
		return this.process.onExit((event) => listener({
			exitCode: event.exitCode,
			...(event.signal === undefined ? {} : { signal: event.signal }),
		}));
	}
}

/**
 * 실제 node-pty 접근을 한 파일에 격리하는 production adapter다.
 * 생성만으로 native module을 load하지 않으며 spawn 호출 때 처음 load한다.
 */
export class NodePtyAdapter implements PtyAdapter {
	/**
	 * 지연 binding loader를 사용하는 production adapter를 생성한다.
	 *
	 * @param loadBinding 실제 spawn 시점에 호출할 module loader다.
	 * 테스트에서는 native module을 요구하지 않는 가짜 loader를 주입할 수 있다.
	 */
	constructor(
		private readonly loadBinding: NodePtyBindingLoader = loadNodePtyBinding,
	) {}

	/**
	 * Host가 검증한 실행 계약으로 PTY를 생성한다.
	 * readonly args와 environment는 새 객체로 복사하여 native binding에 전달한다.
	 *
	 * @param options executable, args, cwd, env와 초기 terminal 크기다.
	 * @returns `node-pty` 세부 타입을 노출하지 않는 Host process handle이다.
	 * @throws {PtySpawnError} native module 로드 또는 process 생성에 실패한 경우 발생한다.
	 */
	spawn(options: PtySpawnOptions): PtyProcessHandle {
		try {
			const process = this.loadBinding().spawn(
				options.executable,
				[...options.args],
				{
					cwd: options.cwd,
					env: { ...options.env },
					cols: options.cols,
					rows: options.rows,
					encoding: 'utf8',
				},
			);

			return new NodePtyProcessHandle(process);
		} catch {
			throw new PtySpawnError();
		}
	}
}

/**
 * TerminalSession에 주입하는 기본 production PTY adapter다.
 * 상수 초기화만으로 `node-pty`를 로드하지 않으며 실제 spawn 요청 전까지 지연한다.
 */
export const nodePtyAdapter: PtyAdapter = new NodePtyAdapter();
