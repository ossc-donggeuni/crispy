import type { HostToWebviewMessage, TabId } from '../protocol';
import {
	defaultShellTerminalDependencies,
	initializeShellTerminal,
	type PostTerminalMessage,
	type ShellTerminalController,
} from './shellTerminal';

/**
 * 탭 하나가 사용하는 Terminal 표면을 만들고 xterm 제어 객체와 연결하는 경계다.
 * 실제 `document`와 xterm 없이도 다중 탭 routing을 검증할 수 있도록 주입 가능하게 둔다.
 */
export interface AgentTerminalPoolDependencies {
	/** 표면, mount와 덮개 요소를 만든다. */
	createElement<K extends keyof HTMLElementTagNameMap>(
		tagName: K,
	): HTMLElementTagNameMap[K];

	/**
	 * 주어진 탭 식별자를 그대로 사용하는 Terminal 제어 객체를 만든다.
	 *
	 * @param tabId Webview가 소유하며 Host 메시지와 대조할 탭 식별자
	 * @param surface 상태 표시와 표시 여부를 관리하는 탭 전용 표면
	 * @param mount xterm이 DOM을 생성할 컨테이너
	 * @param overlay 종료 및 오류 상태를 표시할 덮개
	 */
	createShellTerminal(
		tabId: TabId,
		surface: HTMLElement,
		mount: HTMLElement,
		overlay: HTMLElement,
	): ShellTerminalController;
}

/** 탭별 Terminal 표면과 세션 메시지 routing을 관리하는 최소 제어 경계다. */
export interface AgentTerminalPool {
	/** 탭의 Terminal 표면과 xterm을 준비한다. 이미 있으면 그대로 둔다. */
	ensureTab(tabId: TabId): void;

	/** 주어진 탭만 표시하고 나머지 탭 표면을 숨긴다. */
	setActiveTab(tabId: TabId): void;

	/** 탭의 Terminal 표면과 xterm을 정리한다. */
	closeTab(tabId: TabId): void;

	/** 검증된 Host 메시지를 해당 `tabId`의 Terminal로만 전달한다. */
	handleHostMessage(message: HostToWebviewMessage): void;

	/** 현재 표시 중인 탭의 Terminal fit을 다시 예약한다. */
	scheduleActiveTerminalFit(): void;

	/** 모든 탭의 Terminal과 표면을 정리한다. */
	dispose(): void;
}

/**
 * 탭 하나가 소유하는 표면 DOM과 Terminal 제어 객체다.
 */
interface AgentTerminalEntry {
	readonly surface: HTMLElement;
	readonly controller: ShellTerminalController;
}

/**
 * 탭별 Terminal 표면을 관리하는 pool을 만든다.
 *
 * 각 탭은 자기 표면과 xterm, `tabId`를 독립적으로 소유하므로 한 탭의 입력과 출력이
 * 다른 탭 화면에 섞이지 않는다. 활성 탭만 표시하고 나머지는 숨기며, 숨은 탭의 세션은
 * 그대로 유지된다. 개별 탭의 실패는 pool 경계 안에 격리한다.
 *
 * @param container 탭 표면을 담을 Agent 영역 Terminal 컨테이너
 * @param dependencies 표면 DOM과 Terminal 제어 객체 생성 의존성
 * @returns 탭 준비, 전환, 정리와 메시지 routing을 제공하는 pool
 */
export function createAgentTerminalPool(
	container: HTMLElement,
	dependencies: AgentTerminalPoolDependencies,
): AgentTerminalPool {
	const entries = new Map<TabId, AgentTerminalEntry>();
	let activeTabId: TabId | undefined;
	let disposed = false;

	/**
	 * 한 탭의 정리 동작 실패를 다른 탭이나 Webview 기능으로 전파하지 않는다.
	 *
	 * @param action 실행할 정리 또는 표시 동작
	 */
	const isolate = (action: () => void): void => {
		try {
			action();
		} catch {
			// 한 탭의 Terminal 실패가 나머지 탭과 Graph, Dock으로 전파되지 않게 한다.
		}
	};

	return {
		ensureTab(tabId): void {
			if (disposed || entries.has(tabId)) {
				return;
			}

			const surface = dependencies.createElement('div');
			surface.className = 'terminal-surface';
			surface.dataset.state = 'ready';
			surface.hidden = activeTabId !== undefined && activeTabId !== tabId;

			const mount = dependencies.createElement('div');
			mount.className = 'terminal-mount';

			const overlay = dependencies.createElement('div');
			overlay.className = 'terminal-overlay';
			overlay.setAttribute('aria-live', 'polite');
			overlay.hidden = true;

			surface.append(mount, overlay);
			container.append(surface);

			const controller = dependencies.createShellTerminal(
				tabId,
				surface,
				mount,
				overlay,
			);
			entries.set(tabId, { surface, controller });
		},

		setActiveTab(tabId): void {
			if (disposed) {
				return;
			}

			activeTabId = tabId;
			for (const [entryTabId, entry] of entries) {
				entry.surface.hidden = entryTabId !== tabId;
			}

			/* 숨어 있는 동안 바뀐 영역 크기를 표시 직후에 다시 반영한다. */
			isolate(() => entries.get(tabId)?.controller.scheduleTerminalFit());
		},

		closeTab(tabId): void {
			const entry = entries.get(tabId);
			if (entry === undefined) {
				return;
			}

			entries.delete(tabId);
			if (activeTabId === tabId) {
				activeTabId = undefined;
			}
			isolate(() => entry.controller.dispose());
			isolate(() => entry.surface.remove());
		},

		handleHostMessage(message): void {
			if (disposed) {
				return;
			}

			const entry = entries.get(message.tabId);
			if (entry === undefined) {
				return;
			}

			isolate(() => entry.controller.handleHostMessage(message));
		},

		scheduleActiveTerminalFit(): void {
			const tabId = activeTabId;
			if (disposed || tabId === undefined) {
				return;
			}

			isolate(() => entries.get(tabId)?.controller.scheduleTerminalFit());
		},

		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			for (const entry of [...entries.values()]) {
				isolate(() => entry.controller.dispose());
				isolate(() => entry.surface.remove());
			}
			entries.clear();
			activeTabId = undefined;
		},
	};
}

/**
 * 실제 `document`와 xterm을 사용하는 기본 pool을 만든다.
 *
 * @param container 탭 표면을 담을 Agent 영역 Terminal 컨테이너
 * @param postMessage Terminal 메시지를 Host로 보내는 Webview 경계
 * @returns 기본 의존성으로 구성한 Terminal pool
 */
export function createDefaultAgentTerminalPool(
	container: HTMLElement,
	postMessage: PostTerminalMessage,
): AgentTerminalPool {
	return createAgentTerminalPool(container, {
		createElement: (tagName) => document.createElement(tagName),
		createShellTerminal: (tabId, surface, mount, overlay) =>
			/*
			 * tabId는 Webview의 탭 상태가 소유하므로 Terminal이 새로 만들지 않고
			 * 이미 Host에 등록된 값을 그대로 사용하게 한다.
			 */
			initializeShellTerminal(surface, mount, overlay, postMessage, {
				...defaultShellTerminalDependencies,
				createTabId: () => tabId,
			}),
	});
}
