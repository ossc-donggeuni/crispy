import type { ChatSessionSummary } from './chat';
import { createChatIcon } from './chatIcons';

/** 최근 대화 기록 팝오버를 생성하는 데 필요한 DOM과 초기 데이터다. */
type ChatHistoryControlOptions = {
	/** 기록 아이콘 버튼을 삽입할 상단 도구 컨테이너다. */
	parent: HTMLElement;
	/** 처음 표시할 최근 세션 요약 목록이다. */
	sessions: readonly ChatSessionSummary[];
	/** 사용자가 세션을 선택했을 때 ID를 전달하는 callback이다. */
	onSelect: (sessionId: string) => void;
};

/**
 * 상단 기록 아이콘과 body overlay 최근 세션 팝오버를 관리한다.
 *
 * 팝오버는 Chat Grid 높이를 변경하지 않으며, 키보드 순환 탐색·바깥 클릭·Escape
 * 닫기와 현재 Webview viewport 안으로 제한하는 위치 계산을 함께 담당한다.
 */
export class ChatHistoryControl {
	private readonly trigger: HTMLButtonElement;
	private readonly panel: HTMLElement;
	private readonly list: HTMLUListElement;
	private readonly onSelect: (sessionId: string) => void;
	private sessions: ChatSessionSummary[];
	private selectedSessionId: string | undefined;
	private disposed = false;

	/**
	 * 기록 버튼과 팝오버 DOM을 만들고 전역 viewport listener를 등록한다.
	 *
	 * @param options 부모 요소, 초기 세션, 선택 callback.
	 */
	public constructor(options: ChatHistoryControlOptions) {
		this.sessions = options.sessions.map((session) => ({ ...session }));
		this.onSelect = options.onSelect;

		this.trigger = createElement('button', 'chat-toolbar-button');
		this.trigger.type = 'button';
		this.trigger.title = '이전 대화 기록';
		this.trigger.setAttribute('aria-label', '이전 대화 기록');
		this.trigger.setAttribute('aria-haspopup', 'dialog');
		this.trigger.setAttribute('aria-expanded', 'false');
		this.trigger.setAttribute('aria-controls', 'chat-history-panel');
		this.trigger.append(createChatIcon('history'));

		this.panel = createElement('section', 'chat-history-panel');
		this.panel.id = 'chat-history-panel';
		this.panel.hidden = true;
		this.panel.setAttribute('role', 'dialog');
		this.panel.setAttribute('aria-labelledby', 'chat-history-title');
		const title = createElement('h2', 'chat-popover-title', '최근 세션');
		title.id = 'chat-history-title';
		this.list = createElement('ul', 'chat-history-list');
		this.panel.append(title, this.list);

		this.trigger.addEventListener('click', this.handleTriggerClick);
		this.trigger.addEventListener('keydown', this.handleTriggerKeydown);
		this.panel.addEventListener('keydown', this.handlePanelKeydown);
		document.addEventListener('pointerdown', this.handleOutsidePointer, true);
		document.addEventListener('scroll', this.handleViewportChange, true);
		window.addEventListener('resize', this.handleViewportChange);

		options.parent.append(this.trigger);
		document.body.append(this.panel);
		this.renderSessions();
	}

	/**
	 * 팝오버 세션 목록을 교체하고 사라진 선택 상태를 정리한다.
	 *
	 * @param sessions 새로 표시할 최근 세션 목록.
	 */
	public setSessions(sessions: readonly ChatSessionSummary[]): void {
		this.sessions = sessions.map((session) => ({ ...session }));
		if (!this.sessions.some((session) => session.id === this.selectedSessionId)) {
			this.selectedSessionId = undefined;
		}
		this.renderSessions();
		if (!this.panel.hidden) {
			this.positionPanel();
		}
	}

	/** 현재 세션 강조를 해제하고 목록을 다시 렌더링한다. */
	public clearSelection(): void {
		this.selectedSessionId = undefined;
		this.renderSessions();
	}

	/** 사용자 focus를 강제로 이동하지 않고 팝오버를 닫는다. */
	public close(): void {
		this.closePanel(false);
	}

	/** 버튼·팝오버·전역 listener를 정리하고 portal DOM을 제거한다. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.trigger.removeEventListener('click', this.handleTriggerClick);
		this.trigger.removeEventListener('keydown', this.handleTriggerKeydown);
		this.panel.removeEventListener('keydown', this.handlePanelKeydown);
		document.removeEventListener('pointerdown', this.handleOutsidePointer, true);
		document.removeEventListener('scroll', this.handleViewportChange, true);
		window.removeEventListener('resize', this.handleViewportChange);
		this.panel.remove();
	}

	/** 기록 아이콘 click으로 팝오버 열림 상태를 토글한다. */
	private readonly handleTriggerClick = (): void => {
		if (this.panel.hidden) {
			this.openPanel();
		} else {
			this.closePanel(true);
		}
	};

	/**
	 * 기록 아이콘에서 아래 방향키를 누르면 팝오버를 열고 첫 세션으로 이동한다.
	 *
	 * @param event 기록 아이콘에서 발생한 keyboard event.
	 */
	private readonly handleTriggerKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			this.openPanel();
			this.focusSession(0);
		}
	};

	/**
	 * 세션 목록의 Escape·방향키·Home·End 키보드 탐색을 처리한다.
	 *
	 * @param event 최근 세션 팝오버에서 발생한 keyboard event.
	 */
	private readonly handlePanelKeydown = (event: KeyboardEvent): void => {
		const buttons = this.getSessionButtons();
		const focusedIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
		let nextIndex: number | undefined;

		if (event.key === 'Escape') {
			event.preventDefault();
			this.closePanel(true);
		} else if (event.key === 'ArrowDown') {
			nextIndex = focusedIndex + 1;
		} else if (event.key === 'ArrowUp') {
			nextIndex = focusedIndex - 1;
		} else if (event.key === 'Home') {
			nextIndex = 0;
		} else if (event.key === 'End') {
			nextIndex = buttons.length - 1;
		}

		if (nextIndex !== undefined) {
			event.preventDefault();
			this.focusSession(nextIndex);
		}
	};

	/**
	 * 열린 팝오버와 trigger 바깥의 pointer 입력으로 팝오버를 닫는다.
	 *
	 * @param event document capture 단계에서 받은 pointer event.
	 */
	private readonly handleOutsidePointer = (event: PointerEvent): void => {
		const target = event.target;
		if (
			!this.panel.hidden
			&& target instanceof Node
			&& !this.panel.contains(target)
			&& !this.trigger.contains(target)
		) {
			this.closePanel(false);
		}
	};

	/** Webview가 resize 또는 scroll되면 열린 팝오버 위치를 다시 제한한다. */
	private readonly handleViewportChange = (): void => {
		if (!this.panel.hidden) {
			this.positionPanel();
		}
	};

	/** 현재 세션 배열과 선택 ID를 제목·상대 시각 버튼 목록으로 렌더링한다. */
	private renderSessions(): void {
		this.list.replaceChildren();
		for (const session of this.sessions) {
			const item = createElement('li', 'chat-history-item');
			const button = createElement('button', 'chat-session-button');
			button.type = 'button';
			button.classList.toggle(
				'is-selected',
				session.id === this.selectedSessionId,
			);
			if (session.id === this.selectedSessionId) {
				button.setAttribute('aria-current', 'true');
			}

			const title = createElement('span', 'chat-session-title', session.title);
			const time = createElement(
				'time',
				'chat-session-time',
				formatRelativeTime(session.lastResponseAt),
			);
			time.dateTime = session.lastResponseAt;
			button.append(title, time);
			button.addEventListener('click', () => {
				this.selectedSessionId = session.id;
				this.renderSessions();
				this.closePanel(true);
				this.onSelect(session.id);
			});
			item.append(button);
			this.list.append(item);
		}
	}

	/** 팝오버를 열고 선택된 세션 또는 첫 항목으로 focus를 이동한다. */
	private openPanel(): void {
		if (!this.panel.hidden) {
			return;
		}
		this.panel.hidden = false;
		this.trigger.setAttribute('aria-expanded', 'true');
		this.positionPanel();
		const selectedIndex = this.sessions.findIndex(
			(session) => session.id === this.selectedSessionId,
		);
		this.focusSession(selectedIndex >= 0 ? selectedIndex : 0);
	}

	/**
	 * 팝오버를 닫고 필요하면 기록 아이콘으로 focus를 복원한다.
	 *
	 * @param restoreFocus `true`이면 닫은 뒤 trigger 버튼에 focus한다.
	 */
	private closePanel(restoreFocus: boolean): void {
		if (this.panel.hidden) {
			return;
		}
		this.panel.hidden = true;
		this.trigger.setAttribute('aria-expanded', 'false');
		if (restoreFocus && !this.disposed) {
			this.trigger.focus();
		}
	}

	/** trigger 아래를 기준으로 팝오버를 Webview viewport 안에 clamp한다. */
	private positionPanel(): void {
		const margin = 6;
		const triggerRect = this.trigger.getBoundingClientRect();
		const viewportWidth = document.documentElement.clientWidth;
		const viewportHeight = document.documentElement.clientHeight;
		const width = Math.min(320, Math.max(0, viewportWidth - margin * 2));
		this.panel.style.width = `${width}px`;
		this.panel.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`;
		this.panel.style.left = '0px';
		this.panel.style.top = '0px';

		const panelHeight = this.panel.getBoundingClientRect().height;
		const left = clamp(
			triggerRect.right - width,
			margin,
			Math.max(margin, viewportWidth - width - margin),
		);
		const top = clamp(
			triggerRect.bottom + 4,
			margin,
			Math.max(margin, viewportHeight - panelHeight - margin),
		);
		this.panel.style.left = `${left}px`;
		this.panel.style.top = `${top}px`;
	}

	/** @returns 현재 렌더링된 세션 선택 버튼 배열. */
	private getSessionButtons(): HTMLButtonElement[] {
		return Array.from(this.list.querySelectorAll<HTMLButtonElement>('button'));
	}

	/**
	 * 요청한 index를 목록 길이에 맞게 순환시켜 해당 세션 버튼에 focus한다.
	 *
	 * @param index focus할 논리적 세션 index.
	 */
	private focusSession(index: number): void {
		const buttons = this.getSessionButtons();
		if (buttons.length === 0) {
			return;
		}
		const wrappedIndex = ((index % buttons.length) + buttons.length) % buttons.length;
		buttons[wrappedIndex]?.focus();
	}
}

/**
 * 클래스와 선택적 textContent를 지정해 안전한 HTML 요소를 생성한다.
 *
 * @param tagName 생성할 HTML 태그 이름.
 * @param className 적용할 CSS class 문자열.
 * @param text 선택적 사용자 표시 문자열.
 * @returns 태그 이름에 대응하는 HTMLElement.
 */
function createElement<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tagName);
	element.className = className;
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}

/**
 * 최근 응답 ISO 시각을 한국어 분·시간·일 상대 시각으로 변환한다.
 *
 * @param value 변환할 ISO 시각.
 * @returns 한국어 상대 시각 또는 파싱 실패 시 원본 값.
 */
function formatRelativeTime(value: string): string {
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) {
		return value;
	}

	const differenceMinutes = Math.round((time - Date.now()) / 60_000);
	const formatter = new Intl.RelativeTimeFormat('ko-KR', { numeric: 'auto' });
	if (Math.abs(differenceMinutes) < 60) {
		return formatter.format(differenceMinutes, 'minute');
	}

	const differenceHours = Math.round(differenceMinutes / 60);
	if (Math.abs(differenceHours) < 24) {
		return formatter.format(differenceHours, 'hour');
	}

	return formatter.format(Math.round(differenceHours / 24), 'day');
}

/**
 * 팝오버 좌표를 viewport의 최소·최대 범위 안으로 제한한다.
 *
 * @param value 제한할 좌표.
 * @param minimum 허용할 최솟값.
 * @param maximum 허용할 최댓값.
 * @returns 범위 안으로 제한된 좌표.
 */
function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
