/**
 * Codex app-server의 stdio transport와 initialize handshake를 관리하는 모듈이다.
 * 프로세스 출력은 JSONL 단위로 검증하고, 모든 송수신과 lifecycle 이벤트를 구조화해 기록한다.
 */

import {
	execFile,
	spawn,
	type ChildProcess,
	type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type { ClientInfo } from './generated/ClientInfo';
import type { ClientNotification } from './generated/ClientNotification';
import type { ClientRequest } from './generated/ClientRequest';
import type { RequestId } from './generated/RequestId';
import type { CodexConnectionState } from './contracts';
import { JsonlLineDecoder, type JsonlChunk } from './jsonl';
import {
	CodexAppServerLogger,
	type CodexLogClock,
	type CodexOutputWriter,
} from './logging';
import {
	defaultTerminationGraceMs,
	terminateCodexProcessTree,
} from './processTree';
import type {
	CrispyInitializeRequest,
	InitializedNotification,
} from './protocol';
import {
	isInitializeResponse,
	type CodexInboundMessage,
	type CodexRpcErrorPayload,
	validateCodexInboundMessage,
} from './runtimeValidation';

/** 이번 protocol 생성과 호환성 검사의 기준이 되는 Codex CLI 버전이다. */
export const codexProtocolCliVersion = '0.146.0';

/** PATH에서 Codex CLI를 실행할 때 사용하는 기본 실행 파일 이름이다. */
export const defaultCodexExecutable = 'codex';

/** stdio transport app-server를 시작하는 기본 CLI 인자다. */
export const defaultAppServerArguments = ['app-server', '--stdio'] as const;

/** Codex CLI 버전을 조회하는 기본 인자다. */
export const defaultVersionArguments = ['--version'] as const;

/** CLI 버전 조회 프로세스의 기본 제한 시간이다. */
export const defaultVersionTimeoutMs = 5_000;

/** app-server RPC 요청이 응답을 기다리는 기본 제한 시간이다. */
export const defaultRequestTimeoutMs = 30_000;

/** Host가 자동 생성하는 요청 ID의 기본 접두사다. */
export const defaultRequestIdPrefix = 'crispy';

/** child process 생성 함수에 전달하는 작업 디렉터리와 process group 설정이다. */
interface SpawnAppServerOptions {
	/** app-server 프로세스의 선택적 작업 디렉터리다. */
	cwd?: string;
	/** POSIX process group을 별도로 만들지 여부다. */
	detached: boolean;
}

/** 테스트가 app-server 프로세스 생성을 교체할 때 사용하는 함수 계약이다. */
export type SpawnAppServerProcess = (
	command: string,
	args: readonly string[],
	options: SpawnAppServerOptions,
) => ChildProcessWithoutNullStreams;

/** CLI 버전 조회 결과와 조회 과정의 원문 출력을 보존한다. */
export interface CodexCliVersionResult {
	/** `codex-cli x.y.z`에서 추출한 버전이며 해석할 수 없으면 존재하지 않는다. */
	version?: string;
	/** 버전 명령이 stdout에 쓴 수정하지 않은 문자열이다. */
	stdout: string;
	/** 버전 명령이 stderr에 쓴 수정하지 않은 문자열이다. */
	stderr: string;
}

/** 단위 테스트가 실제 CLI와 process tree에 의존하지 않게 하는 교체 지점이다. */
export interface CodexAppServerDependencies {
	/** app-server root process를 생성하는 함수다. */
	spawnProcess?: SpawnAppServerProcess;
	/** Codex CLI 버전과 원문 출력을 조회하는 함수다. */
	readCliVersion?: (
		command: string,
		args: readonly string[],
		timeoutMs: number,
	) => Promise<CodexCliVersionResult>;
	/** app-server와 그 하위 process tree를 종료하는 함수다. */
	terminateProcessTree?: (child: ChildProcess) => Promise<void>;
}

/** app-server 연결에서 제품 설정과 외부 callback을 주입하는 옵션이다. */
export interface CodexAppServerClientOptions {
	/** initialize에 전달할 실제 Crispy 이름, 표시 이름과 Extension 버전이다. */
	clientInfo: ClientInfo;
	/** 구조화된 전체 로그를 받을 기존 Crispy Output Channel writer다. */
	outputWriter: CodexOutputWriter;
	/** PATH 이름 대신 사용할 수 있는 Codex CLI 절대 경로 또는 실행 파일 이름이다. */
	executable?: string;
	/** 기본 `app-server --stdio` 대신 전달할 app-server CLI 인자다. */
	appServerArguments?: readonly string[];
	/** 기본 `--version` 대신 CLI 버전 조회에 사용할 인자다. */
	versionArguments?: readonly string[];
	/** 생성 타입 기준과 비교할 기대 CLI 버전이다. */
	expectedCliVersion?: string;
	/** CLI 버전 조회 프로세스 제한 시간이다. */
	versionTimeoutMs?: number;
	/** 각 app-server RPC 요청이 응답을 기다리는 제한 시간이다. */
	requestTimeoutMs?: number;
	/** app-server process tree의 정상 종료 유예 시간이다. */
	terminationGraceMs?: number;
	/** app-server root process에 전달할 선택적 작업 디렉터리다. */
	cwd?: string;
	/** Host가 자동 생성하는 request ID의 충돌 방지 접두사다. */
	requestIdPrefix?: string;
	/** Output Channel에서 이 연결의 로그를 구분하는 선택적 접두사다. */
	logPrefix?: string;
	/** 테스트에서 고정 시각을 공급할 수 있는 로그 clock이다. */
	logClock?: CodexLogClock;
	/** runtime validation을 통과한 모든 app-server 메시지 소비자다. */
	onMessage?: (message: CodexInboundMessage) => void;
	/** 연결 단계가 바뀔 때 불변 snapshot을 받는 소비자다. */
	onConnectionStateChanged?: (state: Readonly<CodexConnectionState>) => void;
	/** 실제 프로세스와 CLI 조회를 테스트 구현으로 교체하는 의존성이다. */
	dependencies?: CodexAppServerDependencies;
}

/** 응답 전까지 request ID Map에 보관하는 method, settlement callback과 timer다. */
interface PendingRequest {
	/** 응답 오류 진단에 사용하는 요청 method다. */
	method: string;
	/** 성공 응답의 result를 원래 호출 Promise로 전달한다. */
	resolve: (result: unknown) => void;
	/** protocol 오류나 process 종료를 원래 호출 Promise로 전달한다. */
	reject: (error: Error) => void;
	/** 응답을 무기한 기다리지 않도록 하는 요청별 제한 시간 timer다. */
	timeout: NodeJS.Timeout;
}

/** Host가 app-server의 역방향 요청에 보내는 성공 응답 envelope다. */
export interface CodexHostResponse<Result = unknown> {
	/** app-server가 보낸 요청의 ID다. */
	id: RequestId;
	/** method별 생성 응답 타입을 만족하는 결과다. */
	result: Result;
}

/** Host가 app-server의 역방향 요청에 보내는 오류 응답 envelope다. */
export interface CodexHostErrorResponse {
	/** app-server가 보낸 요청의 ID다. */
	id: RequestId;
	/** app-server에 전달할 JSON-RPC 오류 정보다. */
	error: CodexRpcErrorPayload;
}

/** app-server error response를 request Promise에서 구분하는 오류다. */
export class CodexAppServerRpcError extends Error {
	/** app-server가 반환한 숫자 오류 코드다. */
	public readonly code: number;
	/** app-server가 반환한 선택적 추가 오류 정보다. */
	public readonly data?: unknown;

	/** @param payload runtime validation을 통과한 app-server 오류 payload */
	public constructor(payload: CodexRpcErrorPayload) {
		super(payload.message);
		this.name = 'CodexAppServerRpcError';
		this.code = payload.code;
		this.data = payload.data;
	}
}

/**
 * VS Code Extension manifest에서 initialize용 client metadata를 만든다.
 * 제품 이름과 버전을 별도 문자열로 복제하지 않고 설치된 Extension 정보를 기준으로 사용한다.
 *
 * @param extensionId manifest name이 없을 때 사용할 VS Code Extension 식별자
 * @param manifest `Extension.packageJSON`에서 받은 외부 값
 * @returns 생성된 ClientInfo 계약
 */
export function createCodexClientInfo(extensionId: string, manifest: unknown): ClientInfo {
	if (!isPlainRecord(manifest)) {
		throw new Error('Extension manifest가 JSON 객체가 아닙니다.');
	}
	const name = nonEmptyString(manifest.name) ?? extensionId;
	const title = nonEmptyString(manifest.displayName) ?? null;
	const version = nonEmptyString(manifest.version);
	if (!version) {
		throw new Error('Extension manifest에 유효한 version이 없습니다.');
	}
	return { name, title, version };
}

/**
 * Codex app-server process, JSONL transport, request 상관관계와 initialize handshake를 소유한다.
 */
export class CodexAppServerClient {
	/** 생성 시 전달된 client metadata, 실행 설정과 외부 callback이다. */
	private readonly options: CodexAppServerClientOptions;
	/** 기존 Crispy Output Channel에 구조화된 app-server 로그를 기록하는 writer다. */
	private readonly logger: CodexAppServerLogger;
	/** PATH 이름 또는 호출자가 주입한 Codex CLI 실행 파일 경로다. */
	private readonly executable: string;
	/** stdio app-server process를 시작할 때 전달하는 CLI 인자다. */
	private readonly appServerArguments: readonly string[];
	/** Codex CLI 버전을 조회할 때 전달하는 CLI 인자다. */
	private readonly versionArguments: readonly string[];
	/** 생성된 protocol 타입과 비교하는 기준 Codex CLI 버전이다. */
	private readonly expectedCliVersion: string;
	/** CLI 버전 조회 process가 완료되기를 기다리는 최대 밀리초다. */
	private readonly versionTimeoutMs: number;
	/** 각 RPC 요청이 같은 ID의 응답을 기다리는 최대 밀리초다. */
	private readonly requestTimeoutMs: number;
	/** 정상 종료 신호 뒤 강제 종료로 전환하기 전 대기하는 밀리초다. */
	private readonly terminationGraceMs: number;
	/** 자동 생성되는 Host request ID 앞에 붙는 충돌 방지 문자열이다. */
	private readonly requestIdPrefix: string;
	/** 실제 또는 테스트 app-server child process 생성 함수다. */
	private readonly spawnProcess: SpawnAppServerProcess;
	/** 실제 또는 테스트 Codex CLI 버전 조회 함수다. */
	private readonly readCliVersion: NonNullable<CodexAppServerDependencies['readCliVersion']>;
	/** 실제 또는 테스트 process tree 종료 함수다. */
	private readonly terminateProcessTree: NonNullable<CodexAppServerDependencies['terminateProcessTree']>;
	/** Host request ID별 resolve·reject callback과 timeout timer다. */
	private readonly pendingRequests = new Map<RequestId, PendingRequest>();
	/** 외부에 snapshot으로 노출하는 현재 app-server 연결 상태다. */
	private connectionState: CodexConnectionState = { phase: 'stopped' };
	/** 현재 연결이 소유하는 app-server root process다. */
	private child: ChildProcessWithoutNullStreams | undefined;
	/** stdout chunk를 완전한 JSONL 줄로 조립하는 decoder다. */
	private stdoutDecoder: JsonlLineDecoder | undefined;
	/** stderr의 UTF-8 경계가 chunk 사이에서 손상되지 않게 하는 decoder다. */
	private stderrDecoder: StringDecoder | undefined;
	/** stdout decoder가 마지막 미개행 줄까지 비웠는지 나타낸다. */
	private stdoutFinished = true;
	/** stderr decoder가 마지막 UTF-8 조각까지 비웠는지 나타낸다. */
	private stderrFinished = true;
	/** 동시에 호출된 start가 공유하는 단일 시작 작업이다. */
	private startPromise: Promise<Readonly<CodexConnectionState>> | undefined;
	/** 동시에 호출된 stop과 종료 중 start가 공유하는 단일 종료 작업이다. */
	private stopPromise: Promise<void> | undefined;
	/** 여러 오류 경로가 중복 process tree 종료를 요청하지 않게 하는 작업이다. */
	private terminationPromise: Promise<void> | undefined;
	/** 현재 child의 close event가 도착하면 완료되는 작업이다. */
	private closePromise: Promise<void> | undefined;
	/** closePromise를 child close handler에서 완료하는 callback이다. */
	private resolveClose: (() => void) | undefined;
	/** 의도된 종료와 예기치 않은 process 종료를 구분하는 flag다. */
	private stopRequested = false;
	/** 자동 생성 request ID를 같은 client 생명주기에서 중복하지 않는 순번이다. */
	private requestSequence = 0;
	/** child process가 `error` event로 보고한 가장 최근 시작·실행 오류다. */
	private processError: Error | undefined;

	/** @param options client metadata, 로그, 실행 설정과 callback */
	public constructor(options: CodexAppServerClientOptions) {
		this.options = options;
		this.executable = options.executable ?? defaultCodexExecutable;
		this.appServerArguments = options.appServerArguments ?? defaultAppServerArguments;
		this.versionArguments = options.versionArguments ?? defaultVersionArguments;
		this.expectedCliVersion = options.expectedCliVersion ?? codexProtocolCliVersion;
		this.versionTimeoutMs = options.versionTimeoutMs ?? defaultVersionTimeoutMs;
		this.requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
		this.terminationGraceMs = options.terminationGraceMs ?? defaultTerminationGraceMs;
		this.requestIdPrefix = options.requestIdPrefix ?? defaultRequestIdPrefix;
		if (!Number.isFinite(this.versionTimeoutMs) || this.versionTimeoutMs <= 0) {
			throw new Error('CLI 버전 조회 제한 시간은 0보다 큰 유한한 값이어야 합니다.');
		}
		if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
			throw new Error('app-server 요청 제한 시간은 0보다 큰 유한한 값이어야 합니다.');
		}
		if (!Number.isFinite(this.terminationGraceMs) || this.terminationGraceMs < 0) {
			throw new Error('app-server 종료 유예 시간은 0 이상의 유한한 값이어야 합니다.');
		}
		if (this.requestIdPrefix.length === 0) {
			throw new Error('request ID 접두사는 비어 있을 수 없습니다.');
		}

		this.logger = new CodexAppServerLogger(
			options.outputWriter,
			options.logClock,
			options.logPrefix,
		);
		this.spawnProcess = options.dependencies?.spawnProcess ?? defaultSpawnAppServer;
		this.readCliVersion = options.dependencies?.readCliVersion ?? readCodexCliVersion;
		this.terminateProcessTree = options.dependencies?.terminateProcessTree
			?? ((child) => terminateCodexProcessTree(child, {
				graceMs: this.terminationGraceMs,
			}));
	}

	/** @returns 현재 연결 상태를 호출자가 변경할 수 없도록 복제한 snapshot. */
	public get state(): Readonly<CodexConnectionState> {
		return { ...this.connectionState };
	}

	/** @returns 아직 app-server 응답을 기다리는 Host 요청 수. */
	public get pendingRequestCount(): number {
		return this.pendingRequests.size;
	}

	/** @returns 서로 다른 요청에서 재사용되지 않는 Host request ID. */
	public createRequestId(): RequestId {
		this.requestSequence += 1;
		return `${this.requestIdPrefix}-${this.requestSequence}`;
	}

	/**
	 * CLI 버전을 확인하고 app-server를 실행해 initialize handshake를 완료한다.
	 * 종료 중 호출되면 현재 종료가 끝난 다음 하나의 새 연결을 시작한다.
	 *
	 * @returns ready 또는 종료 요청으로 stopped가 된 연결 상태 snapshot.
	 * @throws process 실행이나 initialize handshake가 실패한 경우.
	 */
	public start(): Promise<Readonly<CodexConnectionState>> {
		if (this.stopPromise) {
			return this.stopPromise.then(() => this.start());
		}
		if (this.connectionState.phase === 'ready') {
			return Promise.resolve(this.state);
		}
		if (this.startPromise) {
			return this.startPromise;
		}

		this.stopRequested = false;
		const startOperation = Promise.resolve().then(() => this.startInternal());
		this.startPromise = startOperation.finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	/**
	 * ready 연결에 생성된 Host 요청을 보내고 같은 ID의 result를 기다린다.
	 *
	 * @param request 생성된 ClientRequest union에 포함되는 요청.
	 * @returns 같은 request ID를 가진 성공 응답의 result.
	 * @throws 연결이 ready가 아니거나 오류 응답·timeout·transport 오류가 발생한 경우.
	 */
	public request<Response>(request: ClientRequest): Promise<Response> {
		this.assertReady();
		return this.sendRequestInternal<Response>(request);
	}

	/**
	 * ready 연결에 응답을 요구하지 않는 Host Notification을 보낸다.
	 *
	 * @param notification 생성된 ClientNotification union에 포함되는 알림.
	 * @returns stdin write가 완료되면 resolve되는 Promise.
	 * @throws 연결이 ready가 아니거나 stdin write가 실패한 경우.
	 */
	public sendNotification(notification: ClientNotification): Promise<void> {
		this.assertReady();
		return this.writeOutbound(notification);
	}

	/**
	 * app-server 역방향 요청에 method별 성공 결과를 돌려준다.
	 *
	 * @param response 원래 request ID와 생성된 method별 result를 포함한 응답.
	 * @returns stdin write가 완료되면 resolve되는 Promise.
	 * @throws 연결이 ready가 아니거나 stdin write가 실패한 경우.
	 */
	public sendResponse<Result>(response: CodexHostResponse<Result>): Promise<void> {
		this.assertReady();
		return this.writeOutbound(response);
	}

	/**
	 * app-server 역방향 요청에 검증된 JSON-RPC 오류를 돌려준다.
	 *
	 * @param response 원래 request ID와 숫자 code를 포함한 오류 응답.
	 * @returns stdin write가 완료되면 resolve되는 Promise.
	 * @throws 연결이 ready가 아니거나 stdin write가 실패한 경우.
	 */
	public sendErrorResponse(response: CodexHostErrorResponse): Promise<void> {
		this.assertReady();
		return this.writeOutbound(response);
	}

	/**
	 * app-server process tree를 종료하고 모든 pending request와 timer를 정리한다.
	 * 동시에 호출되면 같은 종료 작업을 반환한다.
	 *
	 * @returns process 종료와 pending request 정리가 끝나면 resolve되는 Promise.
	 */
	public stop(): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise;
		}
		const stopOperation = Promise.resolve().then(() => this.stopInternal());
		this.stopPromise = stopOperation.finally(() => {
			this.stopPromise = undefined;
		});
		return this.stopPromise;
	}

	/**
	 * 단일 start 작업의 버전 확인, process 생성과 initialize 순서를 수행한다.
	 *
	 * @returns handshake가 도달한 최종 연결 상태 snapshot.
	 */
	private async startInternal(): Promise<Readonly<CodexConnectionState>> {
		this.setState({ phase: 'starting' });
		await this.checkCliVersion();
		if (this.stopRequested) {
			this.setState({ ...this.connectionState, phase: 'stopped' });
			return this.state;
		}

		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnProcess(this.executable, this.appServerArguments, {
				cwd: this.options.cwd,
				detached: process.platform !== 'win32',
			});
		} catch (error) {
			const message = `app-server 프로세스를 시작할 수 없습니다: ${errorMessage(error)}`;
			this.logger.write('process', 'lifecycle', message);
			this.setState({ ...this.connectionState, phase: 'failed', error: message });
			throw new Error(message);
		}

		this.bindProcess(child);
		this.logger.write(
			'process',
			'lifecycle',
			`app-server started pid=${child.pid ?? 'unknown'} command=${this.executable}`,
		);
		this.setState({ ...this.connectionState, phase: 'initializing' });

		try {
			const initializeRequest: CrispyInitializeRequest = {
				id: this.createRequestId(),
				method: 'initialize',
				params: {
					clientInfo: this.options.clientInfo,
					capabilities: {
						experimentalApi: true,
						requestAttestation: false,
					},
				},
			};
			const result = await this.sendRequestInternal<unknown>(initializeRequest);
			if (!isInitializeResponse(result)) {
				throw new Error('initialize 응답이 생성된 InitializeResponse 계약과 다릅니다.');
			}

			const initialized: InitializedNotification = { method: 'initialized' };
			await this.writeOutbound(initialized);
			if (this.stopRequested) {
				return this.state;
			}
			this.setState({
				...this.connectionState,
				phase: 'ready',
				serverUserAgent: result.userAgent,
			});
			return this.state;
		} catch (error) {
			if (this.stopRequested) {
				this.setState({ ...this.connectionState, phase: 'stopped' });
				return this.state;
			}
			const message = `app-server 초기화에 실패했습니다: ${errorMessage(error)}`;
			this.logger.write('process', 'lifecycle', message);
			this.rejectPendingRequests(new Error(message));
			await this.terminateCurrentProcess();
			this.setState({ ...this.connectionState, phase: 'failed', error: message });
			throw new Error(message);
		}
	}

	/**
	 * Codex CLI 버전과 원문 stdout·stderr를 기록하고 기준 버전 차이는 경고로 남긴다.
	 * 조회 실패나 버전 해석 실패는 연결을 막지 않는다.
	 */
	private async checkCliVersion(): Promise<void> {
		try {
			const result = await this.readCliVersion(
				this.executable,
				this.versionArguments,
				this.versionTimeoutMs,
			);
			if (result.stdout.length > 0) {
				this.logger.write('process', 'lifecycle', result.stdout);
			}
			if (result.stderr.length > 0) {
				this.logger.write('process', 'stderr', result.stderr);
			}
			if (result.version) {
				this.setState({ ...this.connectionState, cliVersion: result.version });
				if (result.version !== this.expectedCliVersion) {
					this.logger.write(
						'process',
						'lifecycle',
						`CLI version mismatch expected=${this.expectedCliVersion} actual=${result.version}; continuing`,
					);
				}
			} else {
				this.logger.write('process', 'lifecycle', 'CLI version output could not be parsed; continuing');
			}
		} catch (error) {
			this.logger.write(
				'process',
				'lifecycle',
				`CLI version check failed; continuing: ${errorMessage(error)}`,
			);
		}
	}

	/**
	 * 새 child process에 stdout, stderr, stdin, error와 close listener를 연결한다.
	 *
	 * @param child 이번 연결이 소유할 app-server process.
	 */
	private bindProcess(child: ChildProcessWithoutNullStreams): void {
		this.child = child;
		this.processError = undefined;
		this.stdoutDecoder = new JsonlLineDecoder();
		this.stderrDecoder = new StringDecoder('utf8');
		this.stdoutFinished = false;
		this.stderrFinished = false;
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
		});

		child.stdout.on('data', (chunk: JsonlChunk) => {
			for (const line of this.stdoutDecoder?.push(chunk) ?? []) {
				this.handleStdoutLine(line);
			}
		});
		child.stdout.once('end', () => this.finishStdout());
		child.stdout.on('error', (error) => this.handleStreamError('stdout', error));
		child.stderr.on('data', (chunk: JsonlChunk) => {
			const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
			const raw = this.stderrDecoder?.write(buffer) ?? '';
			if (raw.length > 0) {
				this.logger.write('process', 'stderr', raw);
			}
		});
		child.stderr.once('end', () => this.finishStderr());
		child.stderr.on('error', (error) => this.handleStreamError('stderr', error));
		child.stdin.on('error', (error) => {
			this.logger.write('process', 'lifecycle', `app-server stdin error: ${error.message}`);
			if (!this.stopRequested) {
				this.rejectPendingRequests(error);
			}
		});
		child.once('error', (error) => {
			this.processError = error;
			this.logger.write('process', 'lifecycle', `app-server process error: ${error.message}`);
		});
		child.once('close', (code, signal) => this.handleProcessClose(child, code, signal));
	}

	/**
	 * stdout JSONL 한 줄을 파싱·검증·분류한 뒤 로그, pending 요청과 callback에 전달한다.
	 *
	 * @param raw 개행 문자를 제외한 수정되지 않은 stdout JSONL 문자열.
	 */
	private handleStdoutLine(raw: string): void {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			this.logger.write(
				'serverToHost',
				'parseError',
				raw,
				{ parseError: errorMessage(error) },
			);
			return;
		}

		const validation = validateCodexInboundMessage(value);
		if (!validation.valid) {
			this.logger.write(
				'serverToHost',
				'validationError',
				raw,
				value,
			);
			this.logger.write('process', 'lifecycle', `Rejected app-server message: ${validation.error}`);
			return;
		}

		const message = validation.message;
		const logKind = message.kind === 'notification'
			? 'notification'
			: message.kind === 'request'
				? 'request'
				: 'response';
		this.logger.write('serverToHost', logKind, raw, message.value);
		this.resolveResponse(message);
		this.emitMessage(message);
	}

	/**
	 * 성공 또는 오류 응답을 같은 ID의 pending request와 연결하고 timeout을 해제한다.
	 *
	 * @param message runtime validation을 통과한 app-server 메시지.
	 */
	private resolveResponse(message: CodexInboundMessage): void {
		if (message.kind !== 'response' && message.kind !== 'errorResponse') {
			return;
		}
		const pending = this.pendingRequests.get(message.id);
		if (!pending) {
			this.logger.write(
				'process',
				'lifecycle',
				`Received response for unknown request id=${String(message.id)}`,
			);
			return;
		}
		this.pendingRequests.delete(message.id);
		clearTimeout(pending.timeout);
		if (message.kind === 'errorResponse') {
			pending.reject(new CodexAppServerRpcError(message.error));
			return;
		}
		pending.resolve(message.result);
	}

	/**
	 * 검증된 모든 inbound 메시지를 외부 소비자에게 전달하되 callback 예외를 격리한다.
	 *
	 * @param message runtime validation을 통과한 app-server 메시지.
	 */
	private emitMessage(message: CodexInboundMessage): void {
		try {
			this.options.onMessage?.(message);
		} catch (error) {
			this.logger.write(
				'process',
				'lifecycle',
				`app-server message callback failed: ${errorMessage(error)}`,
			);
		}
	}

	/**
	 * 현재 child의 마지막 stream 조각과 pending request를 정리하고 종료 의도에 맞는 상태를 설정한다.
	 *
	 * @param child close event를 발생시킨 process.
	 * @param code process exit code이며 signal 종료면 `null`일 수 있다.
	 * @param signal process를 종료한 signal이며 일반 종료면 `null`이다.
	 */
	private handleProcessClose(
		child: ChildProcessWithoutNullStreams,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (child !== this.child) {
			return;
		}
		this.finishStdout();
		this.finishStderr();
		const detail = this.processError?.message
			?? `exitCode=${String(code)} signal=${signal ?? 'none'}`;
		this.logger.write('process', 'lifecycle', `app-server exited ${detail}`);
		this.rejectPendingRequests(new Error(`app-server가 종료되었습니다: ${detail}`));
		this.child = undefined;
		this.resolveClose?.();
		this.resolveClose = undefined;
		this.closePromise = undefined;

		if (this.stopRequested) {
			this.setState({ ...this.connectionState, phase: 'stopped' });
		} else {
			this.setState({
				...this.connectionState,
				phase: 'failed',
				error: `app-server가 예기치 않게 종료되었습니다: ${detail}`,
			});
		}
	}

	/** stdout decoder를 한 번만 종료하고 마지막 미개행 JSONL 줄까지 처리한다. */
	private finishStdout(): void {
		if (this.stdoutFinished) {
			return;
		}
		this.stdoutFinished = true;
		for (const line of this.stdoutDecoder?.finish() ?? []) {
			this.handleStdoutLine(line);
		}
	}

	/** stderr decoder를 한 번만 종료하고 남은 UTF-8 문자열까지 기록한다. */
	private finishStderr(): void {
		if (this.stderrFinished) {
			return;
		}
		this.stderrFinished = true;
		const raw = this.stderrDecoder?.end() ?? '';
		if (raw.length > 0) {
			this.logger.write('process', 'stderr', raw);
		}
	}

	/**
	 * stdout 또는 stderr 오류를 기록하고 의도된 종료가 아니면 pending 요청과 process를 정리한다.
	 *
	 * @param stream 오류가 발생한 child stream 이름.
	 * @param error Node stream이 전달한 오류.
	 */
	private handleStreamError(stream: 'stdout' | 'stderr', error: Error): void {
		this.logger.write('process', 'lifecycle', `app-server ${stream} error: ${error.message}`);
		if (this.stopRequested) {
			return;
		}
		this.rejectPendingRequests(error);
		void this.terminateCurrentProcess();
	}

	/**
	 * initialize 중에도 사용할 수 있도록 ready 검사 없이 요청을 등록하고 전송한다.
	 * 요청별 timer는 응답, write 실패, process 종료 또는 timeout 중 먼저 발생한 경로에서 정리한다.
	 *
	 * @param request 전송할 생성 ClientRequest.
	 * @returns 같은 ID의 성공 응답 result.
	 */
	private sendRequestInternal<Response>(request: ClientRequest): Promise<Response> {
		if (this.pendingRequests.has(request.id)) {
			return Promise.reject(new Error(`중복된 app-server request id입니다: ${String(request.id)}`));
		}

		return new Promise<Response>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pendingRequests.get(request.id) !== pending) {
					return;
				}
				this.pendingRequests.delete(request.id);
				const message = `${pending.method} 요청(${String(request.id)})이 ${this.requestTimeoutMs}ms 안에 응답하지 않았습니다.`;
				this.logger.write('process', 'lifecycle', message, request);
				pending.reject(new Error(message));
			}, this.requestTimeoutMs);
			timeout.unref();
			const pending: PendingRequest = {
				method: request.method,
				resolve: (result) => resolve(result as Response),
				reject,
				timeout,
			};
			this.pendingRequests.set(request.id, pending);
			void this.writeOutbound(request).catch((error: unknown) => {
				if (this.pendingRequests.get(request.id) === pending) {
					this.pendingRequests.delete(request.id);
					clearTimeout(pending.timeout);
					pending.reject(new Error(
						`app-server 요청을 전송할 수 없습니다: ${errorMessage(error)}`,
					));
				}
			});
		});
	}

	/**
	 * JSON 객체를 한 줄 JSONL로 직렬화해 로그를 먼저 남기고 app-server stdin에 쓴다.
	 *
	 * @param value request, notification 또는 역방향 request 응답 객체.
	 * @returns stdin write callback이 성공하면 resolve되는 Promise.
	 */
	private async writeOutbound(value: object): Promise<void> {
		const child = this.child;
		if (!child || child.stdin.destroyed || !child.stdin.writable) {
			throw new Error('app-server stdin이 열려 있지 않습니다.');
		}

		const raw = JSON.stringify(value);
		this.logger.write('hostToServer', classifyOutbound(value), raw, value);
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(`${raw}\n`, 'utf8', (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	/** 단일 stop 작업에서 stopping 상태, process 종료, pending 정리와 stopped 상태를 순서대로 적용한다. */
	private async stopInternal(): Promise<void> {
		this.stopRequested = true;
		this.setState({ ...this.connectionState, phase: 'stopping' });
		this.logger.write('process', 'lifecycle', 'app-server stop requested');
		await this.terminateCurrentProcess();
		try {
			await this.startPromise;
		} catch {
			// start 실패 상태는 이미 로그와 connection state에 반영됐다.
		}
		this.rejectPendingRequests(new Error('Extension 비활성화로 app-server 연결이 종료되었습니다.'));
		this.setState({ ...this.connectionState, phase: 'stopped' });
	}

	/** @returns 중복 종료 요청이 공유하는 현재 process tree 종료 Promise. */
	private terminateCurrentProcess(): Promise<void> {
		if (this.terminationPromise) {
			return this.terminationPromise;
		}
		this.terminationPromise = this.terminateCurrentProcessInternal().finally(() => {
			this.terminationPromise = undefined;
		});
		return this.terminationPromise;
	}

	/** app-server stdin을 닫고 주입된 process tree 종료 정책과 fallback 강제 종료를 수행한다. */
	private async terminateCurrentProcessInternal(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}
		const closed = this.closePromise;
		try {
			child.stdin.end();
		} catch {
			// stdin이 이미 닫힌 경우에도 process tree 종료를 계속한다.
		}
		try {
			await this.terminateProcessTree(child);
		} catch (error) {
			this.logger.write(
				'process',
				'lifecycle',
				`app-server process tree termination failed: ${errorMessage(error)}`,
			);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}
		if (closed && !await resolvesWithin(closed, this.terminationGraceMs)) {
			this.logger.write(
				'process',
				'lifecycle',
				'app-server close event did not arrive within the configured grace period',
			);
		}
	}

	/**
	 * 모든 pending request의 timer를 해제하고 method·ID가 포함된 오류로 거부한다.
	 *
	 * @param error 각 요청 오류에 원인으로 덧붙일 lifecycle 또는 transport 오류.
	 */
	private rejectPendingRequests(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(
				`${pending.method} 요청(${String(id)})을 완료할 수 없습니다: ${error.message}`,
			));
		}
		this.pendingRequests.clear();
	}

	/** @throws 현재 연결이 외부 request·notification을 보낼 수 있는 ready 상태가 아닌 경우. */
	private assertReady(): void {
		if (this.connectionState.phase !== 'ready') {
			throw new Error(`app-server 연결이 ready 상태가 아닙니다: ${this.connectionState.phase}`);
		}
	}

	/**
	 * 내부 연결 상태를 복제해 저장하고 외부 상태 callback 예외를 격리한다.
	 *
	 * @param state 새로 게시할 연결 상태.
	 */
	private setState(state: CodexConnectionState): void {
		this.connectionState = { ...state };
		try {
			this.options.onConnectionStateChanged?.(this.state);
		} catch (error) {
			this.logger.write(
				'process',
				'lifecycle',
				`connection state callback failed: ${errorMessage(error)}`,
			);
		}
	}
}

/**
 * shell 해석 없이 pipe stdio와 독립 POSIX process group으로 app-server를 실행한다.
 *
 * @param command Codex CLI 실행 파일 이름 또는 경로.
 * @param args app-server 실행 인자.
 * @param options 작업 디렉터리와 process group 설정.
 * @returns 생성된 child process.
 */
function defaultSpawnAppServer(
	command: string,
	args: readonly string[],
	options: SpawnAppServerOptions,
): ChildProcessWithoutNullStreams {
	return spawn(command, [...args], {
		cwd: options.cwd,
		detached: options.detached,
		shell: false,
		stdio: 'pipe',
		windowsHide: true,
	});
}

/**
 * 별도 process에서 Codex CLI 버전 명령을 실행하고 원문 출력과 해석한 버전을 반환한다.
 *
 * @param command Codex CLI 실행 파일 이름 또는 경로.
 * @param args 버전 조회 인자.
 * @param timeoutMs version process 제한 시간.
 * @returns 해석한 버전과 stdout·stderr 원문.
 */
function readCodexCliVersion(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<CodexCliVersionResult> {
	return new Promise<CodexCliVersionResult>((resolve, reject) => {
		execFile(
			command,
			[...args],
			{ encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({
					version: parseCodexCliVersion(stdout),
					stdout,
					stderr,
				});
			},
		);
	});
}

/**
 * @param stdout `codex --version`의 stdout 원문.
 * @returns `codex-cli` 뒤의 버전 문자열 또는 해석할 수 없을 때 `undefined`.
 */
function parseCodexCliVersion(stdout: string): string | undefined {
	return /\bcodex-cli\s+([^\s]+)/u.exec(stdout)?.[1];
}

/**
 * @param value Host가 app-server에 보내는 JSON 객체.
 * @returns method와 id 존재 여부에서 판정한 구조화 로그 종류.
 */
function classifyOutbound(value: object): 'request' | 'response' | 'notification' {
	const record = value as Record<string, unknown>;
	if (typeof record.method === 'string') {
		return Object.hasOwn(record, 'id') ? 'request' : 'notification';
	}
	return 'response';
}

/**
 * @param error 외부 API 또는 callback에서 받은 알 수 없는 오류 값.
 * @returns Error의 message 또는 안전한 문자열 표현.
 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * @param value Extension manifest 후보 값.
 * @returns 배열과 `null`이 아닌 일반 객체인지 여부.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param value Extension manifest에서 읽은 필드 값.
 * @returns 공백만 있지 않은 문자열 또는 `undefined`.
 */
function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Promise 완료와 제한 시간 중 먼저 발생한 결과를 boolean으로 정규화한다.
 *
 * @param promise 완료 여부를 관찰할 작업.
 * @param timeoutMs 작업 완료를 기다릴 최대 밀리초.
 * @returns 제한 시간 안에 Promise가 resolve됐는지 여부.
 */
async function resolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		void promise.then(() => finish(true));
	});
}
