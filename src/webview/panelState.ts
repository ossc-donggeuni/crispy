export type DockPosition = 'left' | 'right' | 'top' | 'bottom';

export interface PanelLayoutState {
	preferredDock: DockPosition;
	sideSize: number;
	verticalSize: number;
}

export const PANEL_LAYOUT_STATE_MESSAGE = 'crispy.layoutStateChanged';

export interface PanelLayoutStateMessage {
	type: typeof PANEL_LAYOUT_STATE_MESSAGE;
	state: PanelLayoutState;
}

export interface WebviewStateApi {
	getState(): unknown;
	setState(state: PanelLayoutState): void;
	postMessage(message: PanelLayoutStateMessage): void;
}

export const DEFAULT_PANEL_LAYOUT_STATE: Readonly<PanelLayoutState> = {
	preferredDock: 'right',
	sideSize: 360,
	verticalSize: 300,
};

/**
 * VS Code Webview에 저장된 Layout 상태를 복원한다.
 * 저장된 값이 없거나 유효하지 않으면 새 기본 상태를 반환한다.
 *
 * @param vscodeApi Webview 상태를 읽고 쓰는 VS Code API
 * @param serializedInitialState 새 Panel 생성 시 Extension Host가 전달한 초기 상태
 * @returns 복원되었거나 기본값으로 생성된 Layout 상태
 */
export function restorePanelLayoutState(
	vscodeApi: WebviewStateApi,
	serializedInitialState?: string,
): PanelLayoutState {
	const savedState = vscodeApi.getState();

	if (isPanelLayoutState(savedState)) {
		return copyPanelLayoutState(savedState);
	}

	const initialState = deserializePanelLayoutState(serializedInitialState);

	return initialState ?? { ...DEFAULT_PANEL_LAYOUT_STATE };
}

/**
 * 현재 Layout 상태의 저장 대상 필드만 VS Code Webview 상태에 기록한다.
 *
 * @param vscodeApi Webview 상태를 읽고 쓰는 VS Code API
 * @param state 저장할 사용자 선호 Dock과 Panel 크기
 */
export function savePanelLayoutState(
	vscodeApi: WebviewStateApi,
	state: PanelLayoutState,
): void {
	const savedState = copyPanelLayoutState(state);

	vscodeApi.setState(savedState);
	vscodeApi.postMessage({
		type: PANEL_LAYOUT_STATE_MESSAGE,
		state: savedState,
	});
}

/**
 * Extension Host가 새 Webview에 전달할 수 있도록 Layout 상태를 직렬화한다.
 *
 * @param state 직렬화할 Layout 상태
 * @returns HTML 속성에 안전하게 넣을 수 있는 URI 인코딩 JSON 문자열
 */
export function serializePanelLayoutState(state: PanelLayoutState | undefined): string {
	if (!state) {
		return '';
	}

	return encodeURIComponent(JSON.stringify(copyPanelLayoutState(state)));
}

/**
 * Webview가 보낸 메시지에서 유효한 Layout 상태만 추출한다.
 *
 * @param message Webview에서 수신한 메시지
 * @returns 검증 및 복사된 Layout 상태이며, 메시지가 유효하지 않으면 undefined
 */
export function getPanelLayoutStateFromMessage(
	message: unknown,
): PanelLayoutState | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}

	const candidate = message as Record<string, unknown>;

	if (
		candidate.type !== PANEL_LAYOUT_STATE_MESSAGE
		|| !isPanelLayoutState(candidate.state)
	) {
		return undefined;
	}

	return copyPanelLayoutState(candidate.state);
}

/**
 * 직렬화된 Extension Host 초기 상태를 검증 가능한 객체로 복원한다.
 *
 * @param serializedState URI 인코딩된 Layout 상태
 * @returns 검증 및 복사된 Layout 상태이며, 값이 없거나 잘못되었으면 undefined
 */
function deserializePanelLayoutState(
	serializedState: string | undefined,
): PanelLayoutState | undefined {
	if (!serializedState) {
		return undefined;
	}

	try {
		const state: unknown = JSON.parse(decodeURIComponent(serializedState));
		return isPanelLayoutState(state) ? copyPanelLayoutState(state) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 저장 대상 필드만 포함하는 독립적인 Layout 상태 객체를 생성한다.
 *
 * @param state 복사할 Layout 상태
 * @returns 저장 대상 필드만 포함하는 새 객체
 */
function copyPanelLayoutState(state: PanelLayoutState): PanelLayoutState {
	return {
		preferredDock: state.preferredDock,
		sideSize: state.sideSize,
		verticalSize: state.verticalSize,
	};
}

/**
 * 복원 후보가 지원하는 Dock 위치와 유효한 Panel 크기를 모두 포함하는지 확인한다.
 *
 * @param value VS Code Webview에서 읽은 복원 후보
 * @returns 유효한 Panel Layout 상태인지 여부
 */
function isPanelLayoutState(value: unknown): value is PanelLayoutState {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Record<string, unknown>;

	return isDockPosition(candidate.preferredDock)
		&& isPanelSize(candidate.sideSize)
		&& isPanelSize(candidate.verticalSize);
}

/**
 * 값이 지원하는 Dock 위치인지 확인한다.
 *
 * @param value Dock 위치 후보
 * @returns 지원하는 Dock 위치인지 여부
 */
function isDockPosition(value: unknown): value is DockPosition {
	return value === 'left'
		|| value === 'right'
		|| value === 'top'
		|| value === 'bottom';
}

/**
 * 값이 CSS 크기로 복원 가능한 유한한 양수인지 확인한다.
 *
 * @param value Panel 크기 후보
 * @returns 복원 가능한 크기인지 여부
 */
function isPanelSize(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
