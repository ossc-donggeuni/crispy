import * as assert from 'assert';
import {
	DEFAULT_PANEL_LAYOUT_STATE,
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	parsePanelLayoutState,
} from '../../webview/panel/panelState';

suite('Panel Layout State', () => {
	test('기본 Panel Layout 상태를 정의한다', () => {
		assert.deepStrictEqual(DEFAULT_PANEL_LAYOUT_STATE, {
			preferredDock: 'right',
			sideSize: INITIAL_SIDE_SIZE,
			verticalSize: INITIAL_VERTICAL_SIZE,
		});
	});

	test('유효한 Dock 위치와 크기를 독립적인 객체로 파싱한다', () => {
		const value = {
			preferredDock: 'left',
			sideSize: 420,
			verticalSize: 280,
			effectiveDock: 'bottom',
		};

		const state = parsePanelLayoutState(value);

		assert.deepStrictEqual(state, {
			preferredDock: 'left',
			sideSize: 420,
			verticalSize: 280,
		});
		assert.notStrictEqual(state, value);
	});

	test('잘못된 Panel Layout 상태를 거부한다', () => {
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
			assert.strictEqual(parsePanelLayoutState(invalidState), undefined);
		}
	});
});
