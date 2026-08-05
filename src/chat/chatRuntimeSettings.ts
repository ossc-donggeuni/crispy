import type { ChatSelectOption } from './chat';
import { createChatIcon } from './chatIcons';

/** 통합 실행 설정 버튼과 팝오버를 생성하는 데 필요한 초기 데이터다. */
type ChatRuntimeSettingsOptions = {
	/** Composer 하단에 요약 trigger를 삽입할 부모 요소다. */
	parent: HTMLElement;
	/** 선택 가능한 Agent 목록이다. */
	agents: readonly ChatSelectOption[];
	/** 선택 가능한 모델 목록이다. */
	models: readonly ChatSelectOption[];
	/** 선택 가능한 모델 옵션 목록이다. */
	modelOptions: readonly ChatSelectOption[];
};

/** 설정 개요 행과 세부 선택 목록을 구분하는 내부 설정 종류다. */
type SettingsKind = 'agent' | 'model' | 'modelOption';

/**
 * Agent·모델·모델 옵션을 하나의 요약 버튼과 overlay 팝오버로 관리한다.
 *
 * 큰 Panel에서는 세 값을 모두 요약하고, CSS container query가 작은 Panel에서
 * 현재 Agent만 표시한다. ARIA label에는 화면 폭과 관계없이 전체 선택값을 유지한다.
 */
export class ChatRuntimeSettingsControl {
	private readonly trigger: HTMLButtonElement;
	private readonly fullSummary: HTMLElement;
	private readonly compactSummary: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly agents: readonly ChatSelectOption[];
	private readonly models: readonly ChatSelectOption[];
	private readonly modelOptions: readonly ChatSelectOption[];
	private agentIndex: number;
	private modelIndex: number;
	private modelOptionIndex: number;
	private disposed = false;

	/**
	 * 통합 설정 trigger와 body portal 팝오버를 만들고 viewport listener를 등록한다.
	 *
	 * @param options 부모 요소와 Agent·모델·모델 옵션 목록.
	 */
	public constructor(options: ChatRuntimeSettingsOptions) {
		this.agents = options.agents.map((option) => ({ ...option }));
		this.models = options.models.map((option) => ({ ...option }));
		this.modelOptions = options.modelOptions.map((option) => ({ ...option }));
		this.agentIndex = this.agents.length > 0 ? 0 : -1;
		this.modelIndex = this.models.length > 0 ? 0 : -1;
		this.modelOptionIndex = this.modelOptions.length > 0 ? 0 : -1;

		this.trigger = createElement('button', 'chat-runtime-summary-button');
		this.trigger.type = 'button';
		this.trigger.title = '실행 설정';
		this.trigger.setAttribute('aria-label', '실행 설정');
		this.trigger.setAttribute('aria-haspopup', 'dialog');
		this.trigger.setAttribute('aria-expanded', 'false');
		this.trigger.setAttribute('aria-controls', 'chat-runtime-settings-panel');
		this.fullSummary = createElement('span', 'chat-runtime-summary is-full');
		this.compactSummary = createElement(
			'span',
			'chat-runtime-summary is-compact',
		);
		this.trigger.append(
			this.fullSummary,
			this.compactSummary,
			createChatIcon('chevron-down'),
		);

		this.panel = createElement('section', 'chat-runtime-settings-panel');
		this.panel.id = 'chat-runtime-settings-panel';
		this.panel.hidden = true;
		this.panel.setAttribute('role', 'dialog');
		this.panel.setAttribute('aria-label', '실행 설정');

		this.trigger.addEventListener('click', this.handleTriggerClick);
		this.trigger.addEventListener('keydown', this.handleTriggerKeydown);
		this.panel.addEventListener('keydown', this.handlePanelKeydown);
		document.addEventListener('pointerdown', this.handleOutsidePointer, true);
		document.addEventListener('scroll', this.handleViewportChange, true);
		window.addEventListener('resize', this.handleViewportChange);

		options.parent.append(this.trigger);
		document.body.append(this.panel);
		this.updateSummary();
		this.renderOverview();
		this.disabled = this.agents.length === 0
			|| this.models.length === 0
			|| this.modelOptions.length === 0;
	}

	/** @returns 현재 선택된 Agent의 전송용 값. */
	public get agentValue(): string {
		return this.agents[this.agentIndex]?.value ?? '';
	}

	/** @returns 현재 선택된 모델의 전송용 값. */
	public get modelValue(): string {
		return this.models[this.modelIndex]?.value ?? '';
	}

	/** @returns 현재 선택된 모델 옵션의 전송용 값. */
	public get modelOptionValue(): string {
		return this.modelOptions[this.modelOptionIndex]?.value ?? '';
	}

	/** @returns 실행 설정 trigger의 현재 비활성 여부. */
	public get disabled(): boolean {
		return this.trigger.disabled;
	}

	/**
	 * 실행 설정의 활성 상태를 변경하고 비활성화 시 열린 팝오버를 닫는다.
	 *
	 * @param disabled `true`이면 trigger와 팝오버 상호작용을 비활성화한다.
	 */
	public set disabled(disabled: boolean) {
		this.trigger.disabled = disabled;
		if (disabled) {
			this.closePanel(false);
		}
	}

	/** trigger로 focus를 강제로 이동하지 않고 설정 팝오버를 닫는다. */
	public close(): void {
		this.closePanel(false);
	}

	/** trigger·팝오버·전역 listener를 정리하고 portal DOM을 제거한다. */
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

	/** 실행 설정 요약 버튼 click으로 팝오버 열림 상태를 토글한다. */
	private readonly handleTriggerClick = (): void => {
		if (this.panel.hidden) {
			this.openPanel();
		} else {
			this.closePanel(true);
		}
	};

	/**
	 * 요약 버튼에서 위 방향키를 누르면 Composer 위쪽 팝오버를 연다.
	 *
	 * @param event 실행 설정 trigger에서 발생한 keyboard event.
	 */
	private readonly handleTriggerKeydown = (event: KeyboardEvent): void => {
		if (!this.disabled && event.key === 'ArrowUp') {
			event.preventDefault();
			this.openPanel();
		}
	};

	/**
	 * 설정 팝오버의 Escape·방향키·Home·End 키보드 탐색을 처리한다.
	 *
	 * @param event 설정 팝오버에서 발생한 keyboard event.
	 */
	private readonly handlePanelKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault();
			this.closePanel(true);
			return;
		}

		const buttons = this.getPanelButtons();
		const focusedIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
		let nextIndex: number | undefined;
		if (event.key === 'ArrowDown') {
			nextIndex = focusedIndex + 1;
		} else if (event.key === 'ArrowUp') {
			nextIndex = focusedIndex - 1;
		} else if (event.key === 'Home') {
			nextIndex = 0;
		} else if (event.key === 'End') {
			nextIndex = buttons.length - 1;
		}
		if (nextIndex !== undefined && buttons.length > 0) {
			event.preventDefault();
			const wrappedIndex = ((nextIndex % buttons.length) + buttons.length)
				% buttons.length;
			buttons[wrappedIndex]?.focus();
		}
	};

	/**
	 * 팝오버와 trigger 바깥의 pointer 입력으로 설정 팝오버를 닫는다.
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

	/** Webview가 resize 또는 scroll되면 열린 설정 팝오버 위치를 다시 계산한다. */
	private readonly handleViewportChange = (): void => {
		if (!this.panel.hidden) {
			this.positionPanel();
		}
	};

	/** 설정 개요를 렌더링해 팝오버를 열고 첫 버튼으로 focus를 이동한다. */
	private openPanel(): void {
		if (this.disabled || !this.panel.hidden) {
			return;
		}
		this.renderOverview();
		this.panel.hidden = false;
		this.trigger.setAttribute('aria-expanded', 'true');
		this.positionPanel();
		this.focusFirstButton();
	}

	/**
	 * 설정 팝오버를 닫고 필요하면 요약 trigger로 focus를 복원한다.
	 *
	 * @param restoreFocus `true`이면 닫은 뒤 trigger에 focus한다.
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

	/** Agent·모델·모델 옵션과 현재 값을 보여주는 설정 개요 화면을 렌더링한다. */
	private renderOverview(): void {
		this.panel.replaceChildren();
		const title = createElement('h2', 'chat-popover-title', '실행 설정');
		const rows = createElement('div', 'chat-settings-rows');
		rows.append(
			this.createSettingsRow('agent', 'Agent', this.currentAgentLabel),
			this.createSettingsRow('model', '모델', this.currentModelLabel),
			this.createSettingsRow(
				'modelOption',
				'모델 옵션',
				this.currentModelOptionLabel,
			),
		);
		this.panel.append(title, rows);
	}

	/**
	 * 설정 종류의 세부 옵션 화면으로 이동하는 개요 행을 만든다.
	 *
	 * @param kind 행이 제어하는 설정 종류.
	 * @param label 사용자에게 표시할 설정 이름.
	 * @param value 현재 선택값의 표시 이름.
	 * @returns 세부 목록으로 이동하는 버튼 요소.
	 */
	private createSettingsRow(
		kind: SettingsKind,
		label: string,
		value: string,
	): HTMLButtonElement {
		const button = createElement('button', 'chat-settings-row');
		button.type = 'button';
		const labelElement = createElement('span', 'chat-settings-label', label);
		const valueElement = createElement('span', 'chat-settings-value', value);
		button.append(labelElement, valueElement, createChatIcon('chevron-right'));
		button.addEventListener('click', () => this.renderOptions(kind));
		return button;
	}

	/**
	 * 선택한 설정 종류의 listbox와 뒤로 가기 header를 렌더링한다.
	 *
	 * @param kind 옵션을 나열할 Agent·모델·모델 옵션 종류.
	 */
	private renderOptions(kind: SettingsKind): void {
		this.panel.replaceChildren();
		const header = createElement('div', 'chat-settings-subheader');
		const backButton = createElement('button', 'chat-settings-back-button');
		backButton.type = 'button';
		backButton.title = '실행 설정으로 돌아가기';
		backButton.setAttribute('aria-label', '실행 설정으로 돌아가기');
		backButton.append(createChatIcon('back'));
		backButton.addEventListener('click', () => {
			this.renderOverview();
			this.positionPanel();
			this.focusFirstButton();
		});
		const title = createElement('h2', 'chat-popover-title', getSelectionTitle(kind));
		header.append(backButton, title);

		const list = createElement('div', 'chat-settings-option-list');
		list.setAttribute('role', 'listbox');
		list.setAttribute('aria-label', title.textContent ?? '선택');
		const options = this.getOptions(kind);
		const selectedIndex = this.getSelectedIndex(kind);
		for (const [index, option] of options.entries()) {
			const button = createElement('button', 'chat-settings-option', option.label);
			button.type = 'button';
			button.setAttribute('role', 'option');
			button.setAttribute('aria-selected', String(index === selectedIndex));
			button.addEventListener('click', () => this.selectOption(kind, index));
			list.append(button);
		}
		this.panel.append(header, list);
		this.positionPanel();
		this.focusFirstButton();
	}

	/**
	 * 유효한 옵션 index를 현재 선택값으로 저장하고 요약을 갱신한다.
	 *
	 * @param kind 선택값을 변경할 설정 종류.
	 * @param index 해당 옵션 배열 안의 선택 index.
	 */
	private selectOption(kind: SettingsKind, index: number): void {
		if (!this.getOptions(kind)[index]) {
			return;
		}
		if (kind === 'agent') {
			this.agentIndex = index;
		} else if (kind === 'model') {
			this.modelIndex = index;
		} else {
			this.modelOptionIndex = index;
		}
		this.updateSummary();
		this.closePanel(true);
	}

	/** 전체·축약 요약 textContent와 전체 선택값을 담은 접근성 이름을 갱신한다. */
	private updateSummary(): void {
		const summary = `${this.currentAgentLabel} · ${this.currentModelLabel} · ${this.currentModelOptionLabel}`;
		this.fullSummary.textContent = summary;
		this.compactSummary.textContent = this.currentAgentLabel;
		this.trigger.setAttribute('aria-label', `실행 설정: ${summary}`);
	}

	/**
	 * Composer 위쪽을 우선해 팝오버를 배치하고 공간이 없으면 아래쪽으로 전환한다.
	 * 좌우 및 세로 좌표는 현재 Webview viewport 안으로 제한한다.
	 */
	private positionPanel(): void {
		const margin = 6;
		const gap = 7;
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
		const preferredTop = triggerRect.top - panelHeight - gap;
		const top = preferredTop >= margin
			? preferredTop
			: clamp(
				triggerRect.bottom + gap,
				margin,
				Math.max(margin, viewportHeight - panelHeight - margin),
			);
		this.panel.style.left = `${left}px`;
		this.panel.style.top = `${top}px`;
	}

	/** @returns 현재 선택된 Agent의 표시 이름. */
	private get currentAgentLabel(): string {
		return this.agents[this.agentIndex]?.label ?? '선택 없음';
	}

	/** @returns 현재 선택된 모델의 표시 이름. */
	private get currentModelLabel(): string {
		return this.models[this.modelIndex]?.label ?? '선택 없음';
	}

	/** @returns 현재 선택된 모델 옵션의 표시 이름. */
	private get currentModelOptionLabel(): string {
		return this.modelOptions[this.modelOptionIndex]?.label ?? '선택 없음';
	}

	/**
	 * 설정 종류에 대응하는 원본 옵션 배열을 반환한다.
	 *
	 * @param kind 조회할 설정 종류.
	 * @returns 해당 종류의 읽기 전용 선택 항목 목록.
	 */
	private getOptions(kind: SettingsKind): readonly ChatSelectOption[] {
		if (kind === 'agent') {
			return this.agents;
		}
		return kind === 'model' ? this.models : this.modelOptions;
	}

	/**
	 * 설정 종류에 대응하는 현재 선택 index를 반환한다.
	 *
	 * @param kind 조회할 설정 종류.
	 * @returns 해당 종류의 현재 선택 index.
	 */
	private getSelectedIndex(kind: SettingsKind): number {
		if (kind === 'agent') {
			return this.agentIndex;
		}
		return kind === 'model' ? this.modelIndex : this.modelOptionIndex;
	}

	/** @returns 현재 설정 팝오버에 렌더링된 모든 키보드 탐색 버튼. */
	private getPanelButtons(): HTMLButtonElement[] {
		return Array.from(this.panel.querySelectorAll<HTMLButtonElement>('button'));
	}

	/** 현재 설정 화면의 첫 키보드 조작 버튼으로 focus를 이동한다. */
	private focusFirstButton(): void {
		this.getPanelButtons()[0]?.focus();
	}
}

/**
 * 세부 설정 종류를 팝오버 제목 문자열로 변환한다.
 *
 * @param kind 제목을 만들 설정 종류.
 * @returns Agent·모델·모델 옵션 선택 제목.
 */
function getSelectionTitle(kind: SettingsKind): string {
	if (kind === 'agent') {
		return 'Agent 선택';
	}
	return kind === 'model' ? '모델 선택' : '모델 옵션 선택';
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
