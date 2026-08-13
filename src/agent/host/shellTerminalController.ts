import * as vscode from 'vscode';
import { HostMessageBuffer } from './hostMessageBuffer';
import { PtySessionManager, type StatusWriter } from './ptySessionManager';
import { getDefaultShellPolicy } from '../policy';
import {
	isTerminalWebviewMessage,
	type TerminalHostMessage,
} from '../protocol';
import type { WorkspaceResolution } from '../workspace';

/** Controller가 사용하는 PTY session 계층의 최소 동작 계약이다. */
export interface ShellSessionHost {
	startShell(options: Parameters<PtySessionManager['startShell']>[0]): string;
	write(sessionId: string, data: string): boolean;
	resize(sessionId: string, cols: number, rows: number): boolean;
	stop(sessionId: string): Promise<boolean>;
	dispose(): Promise<boolean>;
}

/** 단일 Crispy Panel의 1단계 shell session과 Host↔Webview 전달을 소유한다. */
export class ShellTerminalController {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly sessions: ShellSessionHost;
	private readonly pendingHostMessages: HostMessageBuffer;
	private readonly overflowedSessions = new Set<string>();
	private activeSessionId: string | undefined;
	private initialized = false;
	private starting = false;
	private flushingHostMessages = false;
	private disposed = false;
	private disposePromise: Promise<boolean> | undefined;

	/**
	 * Crispy Panel 하나에 terminal 메시지 처리와 PTY lifecycle을 연결한다.
	 *
	 * @param panel terminal Webview를 포함하는 Crispy Panel
	 * @param workspace 검증을 마친 workspace root 결과
	 * @param writer terminal 본문을 제외한 lifecycle 상태 로그 출력기
	 * @param sessions 실제 또는 테스트용 PTY session Host
	 * @param messageBuffer 숨김·전송 실패 시 메시지를 보존할 Host buffer
	 */
	public constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly workspace: WorkspaceResolution,
		writer: StatusWriter = console,
		sessions?: ShellSessionHost,
		messageBuffer?: HostMessageBuffer,
	) {
		this.sessions = sessions ?? new PtySessionManager(writer);
		this.pendingHostMessages = messageBuffer ?? new HostMessageBuffer();
		this.panel.webview.onDidReceiveMessage(
			(raw: unknown) => void this.handleMessage(raw),
			undefined,
			this.disposables,
		);
		this.panel.onDidChangeViewState(
			({ webviewPanel }) => {
				if (webviewPanel.visible) {
					void this.flushHostMessages();
				}
			},
			undefined,
			this.disposables,
		);
	}

	/**
	 * Panel 또는 Extension 종료 시 실제 process-tree cleanup을 한 번만 수행한다.
	 *
	 * @returns 소속 process tree 전체의 종료가 확인됐는지 여부
	 */
	public dispose(): Promise<boolean> {
		if (!this.disposePromise) {
			this.disposePromise = this.disposeInternal();
		}

		return this.disposePromise;
	}

	/**
	 * Webview 원본 메시지를 검증한 뒤 현재 Controller가 소유한 세션에만 적용한다.
	 *
	 * @param raw Webview에서 수신한 검증 전 메시지
	 */
	private async handleMessage(raw: unknown): Promise<void> {
		if (this.disposed || !isTerminalWebviewMessage(raw)) {
			return;
		}

		switch (raw.type) {
			case 'terminal/ready':
				if (!this.initialized) {
					this.initialized = true;
					await this.startShell(raw.payload.cols, raw.payload.rows);
				}
				return;
			case 'terminal/restart':
				if (!this.activeSessionId && !this.starting) {
					await this.startShell(raw.payload.cols, raw.payload.rows);
				}
				return;
			case 'terminal/input':
				if (raw.payload.sessionId === this.activeSessionId) {
					this.sessions.write(raw.payload.sessionId, raw.payload.data);
				}
				return;
			case 'terminal/resize':
				if (raw.payload.sessionId === this.activeSessionId) {
					this.sessions.resize(
						raw.payload.sessionId,
						raw.payload.cols,
						raw.payload.rows,
					);
				}
				return;
		}
	}

	/**
	 * 검증된 workspace와 Host shell 정책으로 단일 기본 shell을 시작한다.
	 *
	 * @param cols xterm이 준비한 초기 열 수
	 * @param rows xterm이 준비한 초기 행 수
	 */
	private async startShell(cols: number, rows: number): Promise<void> {
		if (!this.workspace.ok) {
			await this.post({
				type: 'terminal/error',
				payload: {
					code: 'invalid_workspace',
					message: this.workspace.message,
					recoverable: false,
				},
			});
			return;
		}

		if (this.activeSessionId || this.starting || this.disposed) {
			return;
		}

		this.starting = true;
		const launch = getDefaultShellPolicy();
		await this.post({
			type: 'terminal/starting',
			payload: { shellLabel: launch.label },
		});

		try {
			const messagesBeforeStart: TerminalHostMessage[] = [];
			let startedPublished = false;
			const sessionId = this.sessions.startShell({
				launch,
				cwd: this.workspace.rootPath,
				cols,
				rows,
				emit: (message) => {
					if (!startedPublished) {
						messagesBeforeStart.push(message);
						return;
					}

					this.forwardSessionMessage(message);
				},
			});

			this.activeSessionId = sessionId;
			await this.post({
				type: 'terminal/started',
				payload: {
					sessionId,
					cwd: this.workspace.rootPath,
					shellLabel: launch.label,
				},
			});
			startedPublished = true;

			for (const message of messagesBeforeStart) {
				this.forwardSessionMessage(message);
			}
		} catch (error) {
			await this.post({
				type: 'terminal/error',
				payload: {
					code: 'spawn_failed',
					message: `기본 shell을 시작하지 못했습니다: ${getErrorMessage(error)}`,
					recoverable: true,
				},
			});
		} finally {
			this.starting = false;
		}
	}

	/**
	 * PTY session 메시지를 순서 보존 buffer로 전달하고 종료·overflow 상태를 반영한다.
	 *
	 * @param message PTY session 계층이 생성한 Host 메시지
	 */
	private forwardSessionMessage(message: TerminalHostMessage): void {
		if (this.disposed) {
			return;
		}

		if (message.type === 'terminal/output') {
			if (this.overflowedSessions.has(message.payload.sessionId)) {
				return;
			}

			if (!this.pendingHostMessages.enqueue(message)) {
				this.handleOutputOverflow(message.payload.sessionId);
				return;
			}
			void this.flushHostMessages();
			return;
		}

		if (message.type === 'terminal/exited') {
			if (message.payload.sessionId === this.activeSessionId) {
				this.activeSessionId = undefined;
			}

			if (this.overflowedSessions.delete(message.payload.sessionId)) {
				return;
			}
		}

		void this.post(message);
	}

	/**
	 * 출력 buffer 상한을 넘긴 세션을 중단하고 복구 가능 오류를 Webview에 알린다.
	 *
	 * @param sessionId 출력 상한을 초과한 Host 소유 세션 ID
	 */
	private handleOutputOverflow(sessionId: string): void {
		if (this.overflowedSessions.has(sessionId)) {
			return;
		}

		this.overflowedSessions.add(sessionId);
		this.pendingHostMessages.enqueue({
			type: 'terminal/error',
			payload: {
				code: 'buffer_overflow',
				message: '보류된 terminal 출력이 8MiB를 초과하여 세션을 중단했습니다.',
				recoverable: true,
				sessionId,
			},
		});
		void this.flushHostMessages();
		void this.sessions.stop(sessionId).then((stopped) => {
			if (!stopped && !this.disposed) {
				void this.post({
					type: 'terminal/error',
					payload: {
						code: 'cleanup_failed',
						message: '출력 초과 세션의 process tree 종료를 확인하지 못했습니다.',
						recoverable: false,
						sessionId,
					},
				});
			}
		});
	}

	/**
	 * Host 메시지를 queue에 추가한 뒤 전송 가능한 경우 즉시 flush한다.
	 *
	 * @param message Webview에 전달할 Host 메시지
	 */
	private async post(message: TerminalHostMessage): Promise<void> {
		if (this.disposed) {
			return;
		}

		if (!this.pendingHostMessages.enqueue(message)) {
			return;
		}

		await this.flushHostMessages();
	}

	/** visible Webview에만 queue head를 보내고 실패한 head는 다음 복귀까지 유지한다. */
	private async flushHostMessages(): Promise<void> {
		if (this.flushingHostMessages || this.disposed || !this.panel.visible) {
			return;
		}

		this.flushingHostMessages = true;
		try {
			while (!this.disposed && this.panel.visible && this.pendingHostMessages.size > 0) {
				const message = this.pendingHostMessages.beginDelivery();
				if (!message) {
					break;
				}

				let delivered = false;
				try {
					delivered = await this.panel.webview.postMessage(message);
				} finally {
					this.pendingHostMessages.completeDelivery(delivered);
				}

				if (!delivered) {
					break;
				}
			}
		} catch (error) {
			if (!this.disposed) {
				console.error(`[Crispy Terminal] Webview message delivery failed: ${getErrorMessage(error)}`);
			}
		} finally {
			this.flushingHostMessages = false;
		}
	}

	/**
	 * 이벤트 구독, 메시지 buffer 및 모든 PTY session을 실제로 정리한다.
	 *
	 * @returns 모든 process tree의 종료가 확인됐는지 여부
	 */
	private async disposeInternal(): Promise<boolean> {
		if (this.disposed) {
			return true;
		}

		this.disposed = true;
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		this.pendingHostMessages.clear();
		const cleaned = await this.sessions.dispose();
		this.activeSessionId = undefined;
		this.overflowedSessions.clear();

		if (!cleaned) {
			console.error('[Crispy Terminal] One or more PTY process trees did not exit during cleanup.');
		}

		return cleaned;
	}
}

/**
 * unknown 오류를 사용자에게 표시 가능한 문자열로 변환한다.
 *
 * @param error 변환할 원본 오류
 * @returns Error message 또는 문자열 표현
 */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
