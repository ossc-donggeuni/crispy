import {
	INITIAL_GRAPH_STATE,
	parseGraphState,
	type GraphState,
} from './graph/graphState';
import {
	DEFAULT_PANEL_LAYOUT_STATE,
	parsePanelLayoutState,
	type PanelLayoutState,
} from './panel/panelState';

export interface PersistedWebviewState {
	panel: PanelLayoutState;
	graph: GraphState;
}

export interface WebviewStateApi {
	getState(): unknown;
	setState(state: PersistedWebviewState): void;
}

/**
 * VS Code Webview 상태, Extension Host 초기 상태, 기본값 순서로 전체 snapshot을 복원한다.
 *
 * @param vscodeApi Webview 상태를 읽고 쓰는 VS Code API
 * @param serializedInitialState 새 Panel 생성 시 Extension Host가 전달한 초기 상태
 * @returns 외부 복원 후보와 참조를 공유하지 않는 Webview 상태 snapshot
 */
export function restoreWebviewState(
	vscodeApi: WebviewStateApi,
	serializedInitialState?: string,
): PersistedWebviewState {
	const savedState = parseWebviewState(vscodeApi.getState());

	if (savedState) {
		return savedState;
	}

	return deserializeWebviewState(serializedInitialState)
		?? createDefaultWebviewState();
}

/**
 * 현재 Panel 및 Graph 상태를 독립적인 Webview snapshot으로 저장한다.
 *
 * @param vscodeApi Webview 상태를 저장할 VS Code API
 * @param state 현재 Panel Layout과 Graph 상태
 */
export function saveWebviewState(
	vscodeApi: WebviewStateApi,
	state: PersistedWebviewState,
): void {
	vscodeApi.setState(parseWebviewState(state) ?? createDefaultWebviewState());
}

/**
 * Extension Host가 새 Webview에 전달할 전체 상태를 URI 인코딩 JSON으로 직렬화한다.
 *
 * @param state 직렬화할 전체 Webview 상태
 * @returns 유효한 상태의 URI 인코딩 JSON이며 상태가 없거나 잘못되면 빈 문자열
 */
export function serializeWebviewState(
	state: PersistedWebviewState | undefined,
): string {
	if (!state) {
		return '';
	}

	const snapshot = parseWebviewState(state);

	return snapshot ? encodeURIComponent(JSON.stringify(snapshot)) : '';
}

/**
 * 복원 후보에서 유효한 Panel 및 Graph 필드만 독립적인 객체로 복사한다.
 *
 * @param value 검증할 Webview 상태 후보
 * @returns 유효한 전체 Webview 상태이며 잘못되었으면 undefined
 */
export function parseWebviewState(
	value: unknown,
): PersistedWebviewState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const panel = parsePanelLayoutState(candidate.panel);
	const graph = parseGraphState(candidate.graph);

	if (!panel || !graph) {
		return undefined;
	}

	return { panel, graph };
}

/** URI 인코딩 JSON을 파싱하고 전체 Webview 상태로 검증한다. */
function deserializeWebviewState(
	serializedState: string | undefined,
): PersistedWebviewState | undefined {
	if (!serializedState) {
		return undefined;
	}

	try {
		return parseWebviewState(
			JSON.parse(decodeURIComponent(serializedState)) as unknown,
		);
	} catch {
		return undefined;
	}
}

/** Panel과 Graph의 새로운 기본 snapshot을 생성한다. */
function createDefaultWebviewState(): PersistedWebviewState {
	return {
		panel: {
			preferredDock: DEFAULT_PANEL_LAYOUT_STATE.preferredDock,
			sideSize: DEFAULT_PANEL_LAYOUT_STATE.sideSize,
			verticalSize: DEFAULT_PANEL_LAYOUT_STATE.verticalSize,
		},
		graph: {
			camera: {
				x: INITIAL_GRAPH_STATE.camera.x,
				y: INITIAL_GRAPH_STATE.camera.y,
				scale: INITIAL_GRAPH_STATE.camera.scale,
			},
			nodePositions: {},
		},
	};
}
