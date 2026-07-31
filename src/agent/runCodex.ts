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

interface SpawnCodexOptions {
	cwd: string;
	detached: boolean;
}

type SpawnCodexProcess = (
	command: string,
	args: string[],
	options: SpawnCodexOptions,
) => ChildProcessWithoutNullStreams;

export interface CodexRunnerDependencies {
	executable?: string;
	buildArguments?: (schemaPath: string, workspaceRoot: string) => string[];
	buildPrompt?: (prompt: string) => Promise<string>;
	resolveSchemaPath?: () => string;
	spawnProcess?: SpawnCodexProcess;
	terminateProcessTree?: (child: ChildProcess) => Promise<void>;
}

interface ActiveCodexRun {
	requestTermination: (reason: TerminationReason) => Promise<void>;
	closed: Promise<void>;
}

interface ProcessOutcome {
	exitCode: number | null;
	spawnError?: Error;
}

const activeCodexRuns = new Set<ActiveCodexRun>();

/**
 * VS Code Workspace를 작업 디렉터리로 삼아 Codex Plan 실행을 시작합니다.
 * stdout JSONL은 실시간 AgentEvent로 변환하고, 프로세스 종료 후 검증된 마지막
 * ChangePlan과 실행 정보를 함께 반환합니다. 이 함수는 코드 변경을 허용하지 않는
 * read-only sandbox로 Codex를 실행합니다.
 */
export async function runCodex(prompt: string, options: RunCodexOptions): Promise<AgentRunResult> {
	return runCodexWithDependencies(prompt, options);
}

/**
 * 테스트에서 실제 Codex 설치나 인증에 의존하지 않도록 프로세스 생성부를 교체할 수 있는
 * 내부 실행 진입점입니다. 제품 소비자는 runCodex만 사용합니다.
 *
 * @internal
 */
export async function runCodexWithDependencies(
	prompt: string,
	options: RunCodexOptions,
	dependencies: CodexRunnerDependencies = {},
): Promise<AgentRunResult> {
	const emit = createSafeEmitter(options.onEvent);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

	const workspaceRoot = path.resolve(options.workspaceRoot);
	try {
		const workspaceStat = await fs.stat(workspaceRoot);
		if (!workspaceStat.isDirectory()) {
			return failedBeforeSpawn('workspaceRoot가 디렉터리가 아닙니다.', emit);
		}
	} catch (error) {
		return failedBeforeSpawn(`workspaceRoot를 확인할 수 없습니다: ${errorMessage(error)}`, emit);
	}

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

	const executable = dependencies.executable ?? 'codex';
	const buildArguments = dependencies.buildArguments ?? defaultCodexArguments;
	const spawnProcess = dependencies.spawnProcess ?? defaultSpawnCodexProcess;
	const terminateProcessTree = dependencies.terminateProcessTree ?? defaultTerminateProcessTree;
	const parser = new CodexEventParser({
		userPrompt: prompt,
		workspaceRoot,
		schemaPath,
		onEvent: emit,
	});

	emit({ type: 'status', message: 'Codex 실행을 준비하고 있습니다.' });

	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawnProcess(executable, buildArguments(schemaPath, workspaceRoot), {
			cwd: workspaceRoot,
			detached: process.platform !== 'win32',
		});
	} catch (error) {
		return failedBeforeSpawn(`Codex 프로세스를 시작할 수 없습니다: ${errorMessage(error)}`, emit);
	}

	let terminalCause: TerminalCause | undefined;
	let processClosed = false;
	let terminationError: string | undefined;
	let terminationPromise: Promise<void> | undefined;

	const processOutcome = new Promise<ProcessOutcome>((resolve) => {
		let spawnError: Error | undefined;
		child.once('error', (error) => {
			spawnError = error;
			// spawn 오류가 취소/timeout보다 먼저 도착했다면 이후 Abort 이벤트가
			// 원래 실패 원인을 cancelled로 덮어쓰지 못하도록 즉시 원인을 확정합니다.
			terminalCause ??= 'failed';
		});
		child.once('close', (exitCode) => {
			processClosed = true;
			resolve({ exitCode, spawnError });
		});
	});

	child.stdout.on('data', (chunk: Buffer | string) => parser.push(chunk));
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

	const closed = processOutcome.then(() => undefined);
	const requestTermination = async (reason: TerminationReason): Promise<void> => {
		// close 이후의 timeout/Abort는 완료된 실행을 소급해서 바꾸면 안 됩니다.
		// 또한 먼저 들어온 terminal cause가 사용자에게 가장 정확한 원인이므로 최초 값만 보존합니다.
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

	const activeRun: ActiveCodexRun = { requestTermination, closed };
	activeCodexRuns.add(activeRun);

	const abortListener = (): void => {
		void requestTermination('abort');
	};
	options.signal?.addEventListener('abort', abortListener, { once: true });
	const timeout = setTimeout(() => {
		void requestTermination('timeout');
	}, timeoutMs);

	// listener 등록 직전에 signal이 바뀌는 짧은 경쟁 구간을 한 번 더 확인합니다.
	if (options.signal?.aborted) {
		void requestTermination('abort');
	}

	// 실행 파일이 없으면 child는 spawn 대신 error를 발생시킵니다. spawn 확인 전에
	// stdin을 쓰면 ENOENT와 별개인 SIGPIPE가 생길 수 있으므로 성공 이벤트 이후에만 전달합니다.
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
 */
export async function disposeCodexRuns(): Promise<void> {
	const runs = [...activeCodexRuns];
	await Promise.allSettled(runs.map(async (run) => {
		await run.requestTermination('dispose');
		await run.closed;
	}));
}

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
 * Codex가 실행한 읽기 명령이 child process로 남을 수 있어 단일 PID가 아닌 process tree를
 * 종료합니다. POSIX는 detached process group에 signal을 보내고, Windows는 taskkill의
 * /T 옵션을 사용합니다. PID가 유효하지 않으면 광범위한 프로세스를 종료할 위험이 있으므로
 * 어떤 signal도 보내지 않습니다.
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

	sendPosixGroupSignal(child, pid, 'SIGTERM');
	if (await waitForChildClose(child, TERMINATION_GRACE_MS)) {
		return;
	}
	sendPosixGroupSignal(child, pid, 'SIGKILL');
	await waitForChildClose(child, TERMINATION_GRACE_MS);
}

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

function hasChildExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

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

function failedBeforeSpawn(
	error: string,
	emit: (event: AgentEvent) => void,
): AgentRunResult {
	emit({ type: 'error', message: error });
	return createResult('failed', null, '', 0, error);
}

function createResult(
	status: 'failed' | 'cancelled' | 'timed-out',
	exitCode: number | null,
	stderr: string,
	parseFailureCount: number,
	error: string,
): AgentRunResult {
	return { provider: 'codex', status, exitCode, stderr, parseFailureCount, error };
}

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

function appendCleanupError(message: string, cleanupError?: string): string {
	return cleanupError ? `${message} ${cleanupError}` : message;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
