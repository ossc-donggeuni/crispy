import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { buildCommonPlanPrompt, resolveAgentAssetPath } from './agentAssets';
import type { AgentEvent, AgentRunResult, RunCodexOptions } from './agentTypes';
import { CodexEventParser } from './codexEventParser';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINATION_GRACE_MS = 1_500;
type TerminationReason = 'abort' | 'timeout' | 'dispose';
type TerminalCause = TerminationReason | 'failed';

/**
 * Codex 프로세스를 생성하는 함수에 전달할 내부 실행 설정의 모양을 정의합니다.
 *
 * @property cwd : Codex가 파일을 분석할 작업 디렉터리입니다.
 * @property detached : POSIX 환경에서 Codex와 하위 프로세스를 하나의 process group으로
 * 관리할지 결정합니다.
 */
interface SpawnCodexOptions {
	cwd: string;
	detached: boolean;
}

/**
 * Codex child process를 만드는 함수의 내부 계약입니다.
 *
 * @param command 실행할 Codex 실행 파일 이름 또는 경로
 * @param args Codex CLI에 전달할 인자 목록
 * @param options 검증된 작업 디렉터리와 process group 설정
 * 
 * @returns 표준 입출력 stream이 연결된 Codex child process
 */
type SpawnCodexProcess = (
	command: string,
	args: string[],
	options: SpawnCodexOptions,
) => ChildProcessWithoutNullStreams;

/**
 * `runCodexWithDependencies()`의 외부 의존성을 테스트용 구현으로 교체하는 설정입니다.
 *
 * 사용자에게 공개되는 실행 옵션인 `RunCodexOptions`는 Workspace, 이벤트, 취소, timeout을
 * 표현합니다. 반면 이 interface는 실행 파일 탐색, prompt 조합, asset 탐색, 프로세스 생성과
 * 종료처럼 제품 내부 동작을 교체합니다. 각 속성을 생략하면 실제 제품 구현을 사용하므로,
 * 일반 소비자는 이 interface가 아니라 `runCodex()`만 호출해야 합니다.
 */
export interface CodexRunnerDependencies {
	executable?: string;
	buildArguments?: (schemaPath: string, workspaceRoot: string) => string[];
	buildPrompt?: (prompt: string) => Promise<string>;
	resolveSchemaPath?: () => string;
	spawnProcess?: SpawnCodexProcess;
	terminateProcessTree?: (child: ChildProcess) => Promise<void>;
}

/**
 * 현재 실행 중인 Codex 한 건을 Extension 종료 시 제어하기 위한 registry 항목입니다.
 *
 * child process 자체를 외부에 노출하지 않고, 종료 요청과 실제 close 대기 기능만 제공합니다.
 * `activeCodexRuns`에 등록되며 프로세스의 `close` 처리가 끝나면 제거됩니다.
 */
interface ActiveCodexRun {
	requestTermination: (reason: TerminationReason) => Promise<void>;
	closed: Promise<void>;
}

/**
 * child process의 `error`와 `close` 이벤트를 하나의 대기 결과로 합친 값입니다.
 *
 * Node.js의 `error` 이벤트는 실행 파일 부재 같은 spawn 실패를 알려주지만 프로세스의
 * stdio 정리가 끝났다는 뜻은 아닙니다. 따라서 오류를 보관한 뒤 `close` 이벤트에서
 * 실제 종료 코드와 함께 반환합니다.
 */
interface ProcessOutcome {
	exitCode: number | null;
	spawnError?: Error;
}

/**
 * Extension Host에서 아직 닫히지 않은 모든 Codex 실행을 추적하는 process registry입니다.
 *
 * Extension의 `deactivate()`는 개별 `runCodex()` Promise를 직접 소유하지 않으므로,
 * `disposeCodexRuns()`가 이 Set을 통해 남은 실행을 찾아 종료합니다. close 이후 항목을
 * 제거하지 않으면 완료된 실행을 다시 종료하려 하거나 참조가 계속 남을 수 있습니다.
 */
const activeCodexRuns = new Set<ActiveCodexRun>();

/**
 * VS Code Workspace를 작업 디렉터리로 삼아 Codex Plan 실행을 시작합니다.
 * stdout JSONL은 실시간 AgentEvent로 변환하고, 프로세스 종료 후 검증된 마지막
 * ChangePlan과 실행 정보를 함께 반환합니다. 이 함수는 코드 변경을 허용하지 않는
 * read-only sandbox로 Codex를 실행합니다.
 *
 * @param prompt 사용자가 입력한 작업 요청입니다. 내부에서 공통 Plan prompt와 결합됩니다.
 * @param options Workspace 경로, 이벤트 callback, 취소 signal, 제한 시간을 담은 공개 옵션입니다.
 * 
 * @returns 프로세스 종료 정보와 검증된 ChangePlan 또는 실패 원인을 담은 결과
 */
export async function runCodex(prompt: string, options: RunCodexOptions): Promise<AgentRunResult> {
	return runCodexWithDependencies(prompt, options);
}

/**
 * 테스트에서 실제 Codex 설치나 인증에 의존하지 않도록 프로세스 생성부를 교체할 수 있는
 * 내부 실행 진입점입니다. 제품 소비자는 runCodex만 사용합니다.
 *
 * @param prompt 사용자가 입력한 원본 작업 요청
 * @param options 제품 소비자가 지정하는 공개 실행 옵션
 * @param dependencies 테스트에서 교체할 수 있는 실행·asset 관련 내부 의존성
 * 
 * @returns Codex 프로세스의 최종 상태와 파싱·검증 결과
 *
 * @internal
 */
export async function runCodexWithDependencies(
	prompt: string,
	options: RunCodexOptions,
	dependencies: CodexRunnerDependencies = {},
): Promise<AgentRunResult> {
	// Webview 같은 이벤트 소비자의 예외가 프로세스 수명주기를 중단하지 않도록,
	// 모든 외부 이벤트 전달은 예외를 격리하는 emitter를 거칩니다.
	const emit = createSafeEmitter(options.onEvent);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// child를 만든 뒤 입력 오류를 발견하면 별도의 프로세스 정리가 필요해집니다.
	// 따라서 값의 형태, 사전 취소, Workspace 실재 여부를 spawn 전에 모두 확인합니다.
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return failedBeforeSpawn('timeoutMs는 0보다 큰 유한한 값이어야 합니다.', emit);
	}
	if (prompt.trim().length === 0) {
		return failedBeforeSpawn('사용자 prompt는 비어 있을 수 없습니다.', emit);
	}
	if (!options.workspaceRoot || !path.isAbsolute(options.workspaceRoot)) {
		return failedBeforeSpawn('workspaceRoot는 절대 경로여야 합니다.', emit);
	}
	if (options.signal?.aborted) {
		const error = 'Codex 실행이 시작되기 전에 사용자가 취소했습니다.';
		emit({ type: 'status', message: error });
		return createResult('cancelled', null, '', 0, error);
	}

	// 절대 경로만 허용한 뒤 정규화하고 실제 디렉터리인지 확인합니다. 이를 통해 Codex의
	// `cwd`와 `-C`가 서로 다른 위치를 가리키거나 현재 프로세스 위치에 의존하는 일을 막습니다.
	const workspaceRoot = path.resolve(options.workspaceRoot);
	try {
		const workspaceStat = await fs.stat(workspaceRoot);
		if (!workspaceStat.isDirectory()) {
			return failedBeforeSpawn('workspaceRoot가 디렉터리가 아닙니다.', emit);
		}
	} catch (error) {
		return failedBeforeSpawn(`workspaceRoot를 확인할 수 없습니다: ${errorMessage(error)}`, emit);
	}

	// 공통 규약 prompt와 출력 Schema는 Codex를 시작하는 데 필요한 런타임 asset입니다.
	// 둘 중 하나라도 준비되지 않으면 불완전한 명령을 실행하지 않고 spawn 이전 실패로 반환합니다.
	let combinedPrompt: string;
	let schemaPath: string;
	try {
		const buildPrompt = dependencies.buildPrompt ?? buildCommonPlanPrompt;
		combinedPrompt = await buildPrompt(prompt);
		schemaPath = dependencies.resolveSchemaPath?.() ?? resolveAgentAssetPath('changePlan.schema.json');
		const schemaStat = await fs.stat(schemaPath);
		if (!schemaStat.isFile()) {
			throw new Error('ChangePlan Schema asset이 파일이 아닙니다.');
		}
	} catch (error) {
		return failedBeforeSpawn(`Agent asset을 준비할 수 없습니다: ${errorMessage(error)}`, emit);
	}

	// 각 의존성은 테스트에서만 가짜 구현으로 바꿀 수 있고, 생략된 항목은 실제 제품 구현을
	// 사용합니다. 이 구조 덕분에 단위 테스트가 Codex 설치·로그인·OS 프로세스 종료에 의존하지 않습니다.
	const executable = dependencies.executable ?? 'codex';
	const buildArguments = dependencies.buildArguments ?? defaultCodexArguments;
	const spawnProcess = dependencies.spawnProcess ?? defaultSpawnCodexProcess;
	const terminateProcessTree = dependencies.terminateProcessTree ?? defaultTerminateProcessTree;
	// JSONL chunk 조립, parseFailureCount 집계, AgentEvent 변환, 마지막 유효 Plan 선택은
	// 전용 parser에 위임합니다. runner는 stream과 프로세스 수명주기에 집중합니다.
	const parser = new CodexEventParser({
		userPrompt: prompt,
		workspaceRoot,
		schemaPath,
		onEvent: emit,
	});

	emit({ type: 'status', message: 'Codex 실행을 준비하고 있습니다.' });

	// `stdio: 'pipe'` 계약을 가진 child이므로 생성 후 stdin, stdout, stderr를 null 검사 없이
	// 연결할 수 있습니다. 동기적으로 throw하는 테스트 구현과 실제 spawn 오류를 모두 구분합니다.
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawnProcess(executable, buildArguments(schemaPath, workspaceRoot), {
			cwd: workspaceRoot,
			detached: process.platform !== 'win32',
		});
	} catch (error) {
		return failedBeforeSpawn(`Codex 프로세스를 시작할 수 없습니다: ${errorMessage(error)}`, emit);
	}

	// abort, timeout, dispose, spawn 실패가 가까운 시점에 발생해도 최초 원인을 보존합니다.
	// 필요한 기능일지는 추후 검토 필요.
	let terminalCause: TerminalCause | undefined;
	let processClosed = false;
	let terminationError: string | undefined;
	// 최초 종료 요청이 시작한 비동기 정리 작업을 한 번만 생성하고 완료까지 기다립니다.
	let terminationPromise: Promise<void> | undefined;

	// `error`는 실행 파일 부재 등 spawn 단계의 실패를 알리고, `close`는 stdio까지 모두 닫혀
	// 수집과 정리를 끝낼 수 있는 시점을 알립니다. error만으로 resolve하지 않고 close를 기다려
	// 두 정보를 하나의 ProcessOutcome으로 합칩니다.
	const processOutcome = new Promise<ProcessOutcome>((resolve) => {
		let spawnError: Error | undefined;
		child.once('error', (error) => {
			spawnError = error;
			// spawn 오류가 취소/timeout보다 먼저 도착했다면 이후 Abort 이벤트가
			// 원래 실패 원인을 cancelled로 덮어쓰지 못하게함.
			terminalCause ??= 'failed';
		});
		child.once('close', (exitCode) => {
			processClosed = true;
			resolve({ exitCode, spawnError });
		});
	});

	// Node stream chunk의 경계는 JSONL 개행과 일치하지 않습니다. stdout 원문을 runner에서
	// 줄 단위로 가정하지 않고 parser에 넘겨, 미완성 줄과 마지막 무개행 줄까지 처리
	child.stdout.on('data', (chunk: Buffer | string) => parser.push(chunk));
	// stderr는 JSONL 이벤트가 아니므로 parser와 섞지 않습니다. 진단용 원문을 별도로 누적해
	// 성공 여부와 관계없이 최종 AgentRunResult에 제공
	let stderr = '';
	child.stderr.on('data', (chunk: Buffer | string) => {
		stderr += chunk.toString();
	});
	child.stdin.on('error', (error) => {
		// 이미 취소되었거나 프로세스가 닫힌 뒤의 EPIPE는 종료 과정의 결과입니다.
		// 정상 실행 중 prompt 전달만 실패한 경우에는 별도 failed 원인으로 보존합니다.
		if (!processClosed && terminalCause === undefined) {
			terminalCause = 'failed';
			terminationError = `Codex에 prompt를 전달할 수 없습니다: ${error.message}`;
			void terminateProcessTree(child).catch(() => undefined);
		}
	});

	/*
	* 프로세스가 닫히면 processOutcome 완료
	* 안에는 exitCode, spawnError가 있지만 registry는 단순 결과만 필요
	* 따라서 상세 값을 버리고 완료 시점만 전달
	*/
	const closed = processOutcome.then(() => undefined);

	/**
	 * 실행 중인 Codex process tree의 종료를 최초 한 번만 요청합니다.
	 *
	 * JavaScript event loop에서 Abort, timeout, Extension dispose가 연달아 실행될 수 있으므로
	 * 먼저 기록된 원인을 유지합니다. 실제 종료가 끝난 뒤 도착한 요청도 무시해 정상 완료를
	 * 취소 결과로 바꾸지 않습니다.
	 *
	 * @param reason 사용자 취소, 제한 시간 초과, Extension 종료 중 하나인 중단 원인
	 * 
	 * @returns process tree에 종료 신호를 전달하는 작업이 끝나면 완료되는 Promise
	 */
	const requestTermination = async (reason: TerminationReason): Promise<void> => {
		if (processClosed || terminalCause !== undefined) {
			return;
		}
		terminalCause = reason;
		emit({ type: 'status', message: terminationStatusMessage(reason) });

		terminationPromise ??= terminateProcessTree(child).catch((error) => {
			terminationError = `프로세스 정리 중 오류가 발생했습니다: ${errorMessage(error)}`;
		});
		await terminationPromise;
	};

	// Extension deactivate가 현재 child를 찾을 수 있도록 
	// listener와 timer를 활성화하기 전에 registry에 등록합니다.
	const activeRun: ActiveCodexRun = { requestTermination, closed };
	activeCodexRuns.add(activeRun);


	const abortListener = (): void => {
		void requestTermination('abort');
	};
	options.signal?.addEventListener('abort', abortListener, { once: true });
	const timeout = setTimeout(() => {
		void requestTermination('timeout');
	}, timeoutMs);

	// 필요성 검토 필요.
	if (options.signal?.aborted) {
		void requestTermination('abort');
	}

	// 실행 파일이 없으면 error
	child.once('spawn', () => {
		if (terminalCause !== undefined || processClosed) {
			return;
		}
		try {
			child.stdin.end(combinedPrompt, 'utf8');
		} catch (error) {
			terminalCause = 'failed';
			terminationError = `Codex에 prompt를 전달할 수 없습니다: ${errorMessage(error)}`;
			void terminateProcessTree(child).catch(() => undefined);
		}
	});

	let outcome: ProcessOutcome;
	try {
		outcome = await processOutcome;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener('abort', abortListener);
		activeCodexRuns.delete(activeRun);
	}

	const parsed = parser.finish();

	if (terminalCause === 'abort' || terminalCause === 'dispose') {
		const error = appendCleanupError(
			terminalCause === 'dispose'
				? 'Extension 종료로 실행 중인 Codex를 취소했습니다.'
				: '사용자가 Codex 실행을 취소했습니다.',
			terminationError,
		);
		return createResult('cancelled', outcome.exitCode, stderr, parsed.parseFailureCount, error);
	}
	if (terminalCause === 'timeout') {
		const error = appendCleanupError(`Codex 실행 시간이 ${timeoutMs}ms를 초과했습니다.`, terminationError);
		return createResult('timed-out', outcome.exitCode, stderr, parsed.parseFailureCount, error);
	}

	if (outcome.spawnError) {
		const error = `Codex CLI를 실행할 수 없습니다: ${outcome.spawnError.message}`;
		emit({ type: 'error', message: error });
		return createResult('failed', outcome.exitCode, stderr, parsed.parseFailureCount, error);
	}
	if (terminationError) {
		emit({ type: 'error', message: terminationError });
		return createResult('failed', outcome.exitCode, stderr, parsed.parseFailureCount, terminationError);
	}
	if (outcome.exitCode !== 0) {
		const error = parsed.providerError
			?? `Codex 프로세스가 종료 코드 ${String(outcome.exitCode)}로 종료되었습니다.`;
		if (!parsed.providerError) {
			emit({ type: 'error', message: error });
		}
		return createResult('failed', outcome.exitCode, stderr, parsed.parseFailureCount, error);
	}
	if (!parsed.plan) {
		const error = parsed.agentMessageCount === 0
			? 'Codex 응답에서 agent_message를 찾을 수 없습니다.'
			: `유효한 ChangePlan을 추출할 수 없습니다${parsed.planError ? `: ${parsed.planError}` : '.'}`;
		emit({ type: 'error', message: error });
		return createResult('failed', outcome.exitCode, stderr, parsed.parseFailureCount, error);
	}

	emit({ type: 'plan', plan: parsed.plan });
	emit({ type: 'status', message: 'ChangePlan 생성이 완료되었습니다.' });
	return {
		provider: 'codex',
		status: 'completed',
		exitCode: outcome.exitCode,
		stderr,
		parseFailureCount: parsed.parseFailureCount,
		plan: parsed.plan,
	};
}

/**
 * Extension이 비활성화될 때 registry에 남아 있는 모든 Codex process tree를 종료합니다.
 * 여러 번 호출해도 최초 종료 요청만 유효하며, 모든 child의 close까지 기다린 뒤 반환합니다.
 *
 * @returns 현재 registry에 있던 모든 Codex 실행의 close 처리가 끝나면 완료되는 Promise
 */
export async function disposeCodexRuns(): Promise<void> {
	// 순회 중 각 run이 close되어 Set에서 제거되더라도 대상 목록이 바뀌지 않도록 복사
	const runs = [...activeCodexRuns];
	await Promise.allSettled(runs.map(async (run) => {
		await run.requestTermination('dispose');
		await run.closed;
	}));
}

/**
 * ChangePlan 전용 Codex 실행에 사용할 CLI 인자 배열을 만듭니다.
 *
 * @param schemaPath Codex가 최종 응답 구조를 맞출 때 사용할 ChangePlan Schema 파일 경로
 * @param workspaceRoot Codex가 분석 기준으로 사용할 VS Code Workspace 절대 경로
 * 
 * @returns `codex` 실행 파일 뒤에 전달할 순서가 보존된 CLI 인자 배열
 */
function defaultCodexArguments(schemaPath: string, workspaceRoot: string): string[] {
	return [
		'exec',
		'--json',
		'--output-schema',
		schemaPath,
		'-C',
		workspaceRoot,
		'-s',
		'read-only',
		'--skip-git-repo-check',
		'--color',
		'never',
		'-',
	];
}

/**
 * Node.js `spawn()`으로 실제 Codex child process를 생성합니다.
 *
 * `shell: false`는 명령과 인자를 shell 문자열로 다시 해석하지 않게 해 경로의 공백이나 특수
 * 문자가 shell 문법으로 처리되는 것을 막습니다. `stdio: 'pipe'`는 prompt를 stdin으로 보내고
 * stdout JSONL과 stderr를 독립적으로 수집하기 위해 필요합니다. `windowsHide`는 Windows에서
 * 별도 콘솔 창이 나타나는 것을 막습니다.
 *
 * POSIX의 `detached: true`는 child를 새로운 process group의 leader로 만들어 이후 음수 PID에
 * signal을 보내 전체 트리를 정리할 수 있게 합니다. Windows에서는 caller가 false를 전달하고
 * `taskkill /T`로 트리를 종료합니다.
 *
 * @param command 실행할 Codex 실행 파일 이름 또는 경로
 * @param args `defaultCodexArguments()` 또는 테스트 구현이 만든 CLI 인자 목록
 * @param options 검증된 Workspace 작업 디렉터리와 플랫폼별 detached 설정
 * @returns stdin, stdout, stderr가 모두 연결된 child process
 */
function defaultSpawnCodexProcess(
	command: string,
	args: string[],
	options: SpawnCodexOptions,
): ChildProcessWithoutNullStreams {
	return spawn(command, args, {
		cwd: options.cwd,
		detached: options.detached,
		shell: false,
		windowsHide: true,
		stdio: 'pipe',
	});
}

/**
 * Codex와 Codex가 실행한 하위 프로세스까지 함께 종료하는 함수.
 *
 * @param child 종료할 Codex root process입니다. 이 process가 만든 하위 프로세스도 대상입니다.
 * 
 * @returns 정상 또는 강제 종료 절차가 끝나면 완료되는 Promise
 */
async function defaultTerminateProcessTree(child: ChildProcess): Promise<void> {
	if (hasChildExited(child)) {
		return;
	}
	const pid = child.pid;
	if (!pid || !Number.isInteger(pid) || pid <= 0) {
		throw new Error('종료할 Codex 프로세스의 PID가 올바르지 않습니다.');
	}

	if (process.platform === 'win32') {
		await runTaskkill(pid, false);
		if (await waitForChildClose(child, TERMINATION_GRACE_MS)) {
			return;
		}
		await runTaskkill(pid, true);
		await waitForChildClose(child, TERMINATION_GRACE_MS);
		return;
	}

	// detached로 생성한 POSIX process group 전체에 먼저 정상 종료 기회를 주고,
	// 유예 시간 이후에도 남아 있으면 강제 종료해 고아 프로세스를 방지합니다.
	sendPosixGroupSignal(child, pid, 'SIGTERM');
	if (await waitForChildClose(child, TERMINATION_GRACE_MS)) {
		return;
	}
	sendPosixGroupSignal(child, pid, 'SIGKILL');
	await waitForChildClose(child, TERMINATION_GRACE_MS);
}

/**
 * POSIX에서 Codex가 leader인 process group 전체에 signal을 전달합니다.
 *
 * `process.kill(-pid, signal)`의 음수 PID는 단일 child가 아니라 같은 process group을 대상으로
 * 합니다. 테스트용 spawn 구현처럼 detached group이 만들어지지 않은 경우 `ESRCH`가 발생할
 * 수 있으므로, 그때만 검증된 root child PID로 fallback합니다. 권한 오류 등 다른 실패까지
 * 무시하면 실제로 프로세스가 남았는데 정리 성공으로 오인하므로 다시 throw합니다.
 *
 * @param child group signal fallback에 사용할 검증된 Codex root process
 * @param pid process group ID로도 사용되는 Codex root PID
 * @param signal 정상 종료 또는 강제 종료에 사용할 POSIX signal
 */
function sendPosixGroupSignal(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		const code = isNodeError(error) ? error.code : undefined;
		if (code !== 'ESRCH') {
			throw error;
		}
		// process group을 찾지 못하면 spawn 구현이 detached를 지원하지 않았을 수 있으므로
		// 검증된 child PID에만 fallback signal을 보냅니다.
		if (!hasChildExited(child)) {
			child.kill(signal);
		}
	}
}

/**
 * Windows `taskkill` 명령으로 Codex PID와 하위 프로세스를 종료합니다.
 *
 * @param pid 종료할 Codex root process의 PID
 * @param force 정상 종료 대신 강제 종료 옵션 `/F`를 사용할지 여부
 * 
 * @returns taskkill 프로세스의 error 또는 close 이벤트가 발생하면 완료되는 Promise
 */
async function runTaskkill(pid: number, force: boolean): Promise<void> {
	await new Promise<void>((resolve) => {
		const args = ['/PID', String(pid), '/T'];
		if (force) {
			args.push('/F');
		}
		const killer = spawn('taskkill', args, { shell: false, windowsHide: true, stdio: 'ignore' });
		killer.once('error', () => resolve());
		killer.once('close', () => resolve());
	});
}

/**
 * child의 `close` 이벤트를 제한된 시간 동안 기다립니다.
 *
 * `close`는 프로세스 종료뿐 아니라 stdio stream까지 닫힌 시점입니다. 다만 이 helper는 종료
 * 신호를 더 강하게 보낼지 결정하기 위한 것이므로 `exitCode` 또는 `signalCode`가 이미 설정된
 * child도 종료된 것으로 보고 즉시 true를 반환합니다. runner의 최종 수집은 별도의
 * `processOutcome`이 실제 close를 기다립니다. timeout이 먼저 끝나면 listener를 제거해 뒤늦은
 * 이벤트와 참조가 남지 않게 합니다.
 *
 * @param child close 여부를 확인할 child process
 * @param timeoutMs close를 기다릴 최대 시간
 * @returns 제한 시간 안에 child가 종료 상태가 되었으면 true, 아니면 false
 */
function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (hasChildExited(child)) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const onClose = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			child.removeListener('close', onClose);
			resolve(hasChildExited(child));
		}, timeoutMs);
		child.once('close', onClose);
	});
}

/**
 * child가 종료 코드 또는 signal에 의해 이미 종료 상태인지 확인합니다.
 *
 * 정상 종료는 `exitCode`에, signal 종료는 `signalCode`에 기록되므로 둘 중 하나만 있어도
 * 추가 signal 전송이나 close 대기가 불필요한 상태로 판단합니다.
 *
 * @param child 종료 상태를 확인할 process
 * 
 * @returns 정상 종료 또는 signal 종료가 확인되었는지 여부
 */
function hasChildExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * 외부 `onEvent` callback의 예외를 Agent 실행과 격리하는 emitter를 만듭니다.
 *
 * @param onEvent 실시간 AgentEvent를 받을 선택적 소비자 callback
 * 
 * @returns 예외가 외부로 전파되지 않는 AgentEvent 전달 함수
 */
function createSafeEmitter(onEvent?: (event: AgentEvent) => void): (event: AgentEvent) => void {
	return (event) => {
		if (!onEvent) {
			return;
		}
		try {
			onEvent(event);
		} catch {
			// 소비자 UI의 예외는 Agent 실행·정리 책임과 분리합니다.
		}
	};
}

/**
 * child process를 만들기 전에 발견한 오류를 표준 failed 결과로 변환합니다.
 *
 * @param error 사용자에게 전달할 spawn 이전 실패 원인
 * @param emit 예외가 격리된 AgentEvent 전달 함수
 * 
 * @returns 프로세스가 시작되지 않았음을 나타내는 failed 결과
 */
// 검토 필요.
function failedBeforeSpawn(
	error: string,
	emit: (event: AgentEvent) => void,
): AgentRunResult {
	emit({ type: 'error', message: error });
	return createResult('failed', null, '', 0, error);
}

/**
 * completed 이외의 종료 상태를 일관된 `AgentRunResult`로 조립합니다.
 *
 * @param status 실패, 사용자/Extension 취소, 제한 시간 초과 중 하나인 최종 상태
 * @param exitCode child가 보고한 종료 코드 또는 코드가 없는 경우 null
 * @param stderr Codex stderr에서 분리해 수집한 원문
 * @param parseFailureCount JSONL 전송 단위 자체를 파싱하지 못한 횟수
 * @param error 사용자에게 제공할 최종 실패 또는 중단 원인
 * 
 * @returns plan 없이 error를 포함하는 Codex 실행 결과
 */
function createResult(
	status: 'failed' | 'cancelled' | 'timed-out',
	exitCode: number | null,
	stderr: string,
	parseFailureCount: number,
	error: string,
): AgentRunResult {
	return { provider: 'codex', status, exitCode, stderr, parseFailureCount, error };
}

/**
 * process tree 종료가 시작되었음을 알리는 상태 문구를 원인별로 선택합니다.
 *
 * @param reason Codex 실행을 중단시키는 외부 원인
 * 
 * @returns Webview 등에 전달할 진행 상태 메시지
 */
function terminationStatusMessage(reason: TerminationReason): string {
	switch (reason) {
		case 'abort':
			return '사용자 요청으로 Codex 실행을 취소하고 있습니다.';
		case 'timeout':
			return '제한 시간을 초과해 Codex 실행을 종료하고 있습니다.';
		case 'dispose':
			return 'Extension 종료를 위해 Codex 실행을 정리하고 있습니다.';
	}
}

/**
 * 원래 취소·timeout 설명 뒤에 process tree 정리 오류를 추가합니다.
 *
 * @param message 먼저 확정된 종료 원인을 설명하는 기본 메시지
 * @param cleanupError process tree 종료 과정에서 추가로 발생한 선택적 오류
 * @returns 정리 오류가 있으면 두 설명을 합친 문자열, 없으면 기본 메시지
 */
function appendCleanupError(message: string, cleanupError?: string): string {
	return cleanupError ? `${message} ${cleanupError}` : message;
}

/**
 * catch로 받은 `unknown` 값을 안전한 오류 메시지 문자열로 바꿉니다.
 *
 * @param error catch 또는 callback에서 받은 알 수 없는 오류 값
 * 
 * @returns 표시와 결과 저장에 사용할 문자열
 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 알 수 없는 오류가 Node.js의 `code` 속성을 가진 시스템 오류인지 확인하는 type guard입니다.
 *
 * @param error Node.js 시스템 오류인지 확인할 값
 * 
 * @returns `NodeJS.ErrnoException`으로 안전하게 좁힐 수 있는지 여부
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
