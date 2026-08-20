import * as assert from 'assert';
import {
	clampPanelSize,
	DEFAULT_PANEL_LAYOUT_STATE,
	getMaxPanelSize,
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	MIN_SIDE_SIZE,
	PANEL_FLOATING_MARGIN,
	parsePanelLayoutState,
} from '../../webview/panel/panelState';

suite('Panel Layout State', () => {
	test('기본 Panel 크기를 Side 460, Vertical 400으로 정의한다', () => {
		assert.strictEqual(INITIAL_SIDE_SIZE, 460);
		assert.strictEqual(INITIAL_VERTICAL_SIZE, 400);
	});

	test('기본 Panel Layout 상태를 정의하며 접힘 기본값은 false다', () => {
		assert.deepStrictEqual(DEFAULT_PANEL_LAYOUT_STATE, {
			preferredDock: 'right',
			sideSize: INITIAL_SIDE_SIZE,
			verticalSize: INITIAL_VERTICAL_SIZE,
			collapsed: false,
		});
	});

	test('유효한 Dock 위치, 크기와 접힘 여부를 독립적인 객체로 파싱한다', () => {
		const value = {
			preferredDock: 'left',
			sideSize: 420,
			verticalSize: 280,
			collapsed: true,
			effectiveDock: 'bottom',
		};

		const state = parsePanelLayoutState(value);

		assert.deepStrictEqual(state, {
			preferredDock: 'left',
			sideSize: 420,
			verticalSize: 280,
			collapsed: true,
		});
		assert.notStrictEqual(state, value);
	});

	test('collapsed가 없는 기존 저장 상태를 Dock과 크기를 유지한 채 복원한다', () => {
		const state = parsePanelLayoutState({
			preferredDock: 'top',
			sideSize: 380,
			verticalSize: 320,
		});

		assert.deepStrictEqual(state, {
			preferredDock: 'top',
			sideSize: 380,
			verticalSize: 320,
			collapsed: false,
		});
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
			{
				preferredDock: 'right',
				sideSize: INITIAL_SIDE_SIZE,
				verticalSize: INITIAL_VERTICAL_SIZE,
				collapsed: 'true',
			},
		];

		for (const invalidState of invalidStates) {
			assert.strictEqual(parsePanelLayoutState(invalidState), undefined);
		}
	});

	test('Floating Panel의 양쪽 외곽 여백을 제외한 최대 크기를 구한다', () => {
		assert.strictEqual(
			getMaxPanelSize(1000),
			1000 - PANEL_FLOATING_MARGIN * 2,
		);
		assert.strictEqual(getMaxPanelSize(PANEL_FLOATING_MARGIN), 0);
	});

	test('가용 영역 안에서는 저장된 크기를 그대로 사용한다', () => {
		assert.strictEqual(
			clampPanelSize(INITIAL_SIDE_SIZE, 1000, MIN_SIDE_SIZE),
			INITIAL_SIDE_SIZE,
		);
	});

	test('좁은 Webview에서는 여백을 제외한 최대 크기로 제한한다', () => {
		assert.strictEqual(clampPanelSize(INITIAL_SIDE_SIZE, 400, MIN_SIDE_SIZE), 376);
		assert.strictEqual(clampPanelSize(120, 1000, MIN_SIDE_SIZE), MIN_SIDE_SIZE);
	});

	test('가용 영역이 최소 크기보다 작으면 최대 크기를 사용한다', () => {
		assert.strictEqual(clampPanelSize(INITIAL_SIDE_SIZE, 200, MIN_SIDE_SIZE), 176);
		assert.strictEqual(clampPanelSize(10, 200, MIN_SIDE_SIZE), 176);
	});
});
