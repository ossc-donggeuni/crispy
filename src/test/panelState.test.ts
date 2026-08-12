import * as assert from 'assert';
import {
	DEFAULT_PANEL_LAYOUT_STATE,
	getPanelLayoutStateFromMessage,
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	restorePanelLayoutState,
	savePanelLayoutState,
	serializePanelLayoutState,
	type PanelLayoutState,
	type PanelLayoutStateMessage,
	type WebviewStateApi,
} from '../webview/panelState';

suite('Panel Layout State', () => {
	test('저장된 상태가 없으면 기본 상태를 복원한다', () => {
		const api = createStateApi(undefined);

		const state = restorePanelLayoutState(api);

		assert.deepStrictEqual(state, DEFAULT_PANEL_LAYOUT_STATE);
		assert.notStrictEqual(state, DEFAULT_PANEL_LAYOUT_STATE);
	});

	test('유효한 Dock 위치와 크기를 복원한다', () => {
		const api = createStateApi({
			preferredDock: 'left',
			sideSize: 420,
			verticalSize: 280,
			effectiveDock: 'bottom',
		});

		assert.deepStrictEqual(restorePanelLayoutState(api), {
			preferredDock: 'left',
			sideSize: 420,
			verticalSize: 280,
		});
	});

	test('저장된 상태가 유효하지 않으면 기본 상태를 복원한다', () => {
		const invalidStates: unknown[] = [
			null,
			{
				preferredDock: 'center',
				sideSize: INITIAL_SIDE_SIZE,
				verticalSize: INITIAL_VERTICAL_SIZE,
			},
			{
				preferredDock: 'right',
				sideSize: -1,
				verticalSize: INITIAL_VERTICAL_SIZE,
			},
			{
				preferredDock: 'right',
				sideSize: INITIAL_SIDE_SIZE,
				verticalSize: Number.NaN,
			},
		];

		for (const invalidState of invalidStates) {
			const api = createStateApi(invalidState);
			assert.deepStrictEqual(restorePanelLayoutState(api), DEFAULT_PANEL_LAYOUT_STATE);
		}
	});

	test('저장 대상 Layout 필드만 새 객체로 저장한다', () => {
		let savedState: PanelLayoutState | undefined;
		let postedMessage: PanelLayoutStateMessage | undefined;
		const api: WebviewStateApi = {
			getState: () => undefined,
			setState: (state) => {
				savedState = state;
			},
			postMessage: (message) => {
				postedMessage = message;
			},
		};
		const state: PanelLayoutState = {
			preferredDock: 'top',
			sideSize: 400,
			verticalSize: 320,
		};

		savePanelLayoutState(api, state);

		assert.deepStrictEqual(savedState, state);
		assert.notStrictEqual(savedState, state);
		assert.deepStrictEqual(getPanelLayoutStateFromMessage(postedMessage), state);
	});

	test('Panel을 닫고 새로 생성해도 Extension Host 상태를 복원한다', () => {
		let postedMessage: PanelLayoutStateMessage | undefined;
		const previousApi: WebviewStateApi = {
			getState: () => undefined,
			setState: () => undefined,
			postMessage: (message) => {
				postedMessage = message;
			},
		};
		const changedState: PanelLayoutState = {
			preferredDock: 'bottom',
			sideSize: 440,
			verticalSize: 260,
		};
		savePanelLayoutState(previousApi, changedState);
		const hostState = getPanelLayoutStateFromMessage(postedMessage);
		const newPanelApi = createStateApi(undefined);

		const restoredState = restorePanelLayoutState(
			newPanelApi,
			serializePanelLayoutState(hostState),
		);

		assert.deepStrictEqual(restoredState, changedState);
	});
});

function createStateApi(state: unknown): WebviewStateApi {
	return {
		getState: () => state,
		setState: () => undefined,
		postMessage: () => undefined,
	};
}
