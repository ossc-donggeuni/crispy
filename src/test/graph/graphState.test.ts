import * as assert from 'assert';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	parseGraphState,
	type GraphStateSnapshot,
} from '../../webview/graph/graphState';

suite('Graph State', () => {
	test('기존 Camera 기본값으로 초기화한다', () => {
		const state = createGraphState();

		assert.deepStrictEqual(state.getState(), {
			camera: { x: 0, y: 0, scale: 1 },
		});
		assert.deepStrictEqual(state.getState(), INITIAL_GRAPH_STATE);
	});

	test('외부 객체와 분리된 immutable snapshot을 관리한다', () => {
		const state = createGraphState();
		const nextState = {
			camera: { x: 30, y: -20, scale: 1.5 },
		};

		state.setState(nextState);
		nextState.camera.x = 999;

		const snapshot = state.getState();
		assert.deepStrictEqual(snapshot.camera, { x: 30, y: -20, scale: 1.5 });
		assert.strictEqual(Object.isFrozen(snapshot), true);
		assert.strictEqual(Object.isFrozen(snapshot.camera), true);
	});

	test('변경된 상태를 subscriber에 전달하고 unsubscribe 이후 호출하지 않는다', () => {
		const state = createGraphState();
		const receivedStates: GraphStateSnapshot[] = [];
		const unsubscribe = state.subscribe((nextState) => {
			receivedStates.push(nextState);
		});

		state.setState({ camera: { x: 10, y: 20, scale: 2 } });
		unsubscribe();
		unsubscribe();
		state.setState({ camera: { x: 30, y: 40, scale: 3 } });

		assert.strictEqual(receivedStates.length, 1);
		assert.deepStrictEqual(receivedStates[0].camera, { x: 10, y: 20, scale: 2 });
	});

	test('Camera scale을 최소 및 최대 범위로 제한한다', () => {
		const state = createGraphState({ camera: { x: 0, y: 0, scale: 0 } });

		assert.strictEqual(state.getState().camera.scale, MIN_CAMERA_SCALE);

		state.setState({ camera: { x: 0, y: 0, scale: 100 } });
		assert.strictEqual(state.getState().camera.scale, MAX_CAMERA_SCALE);
	});

	test('유효한 Graph 상태를 독립적인 객체로 파싱한다', () => {
		const value = {
			camera: { x: 30, y: -20, scale: 1.5, transient: true },
		};

		const state = parseGraphState(value);

		assert.deepStrictEqual(state, {
			camera: { x: 30, y: -20, scale: 1.5 },
		});
		assert.notStrictEqual(state, value);
		assert.notStrictEqual(state?.camera, value.camera);
	});

	test('잘못된 Graph 상태를 거부한다', () => {
		const invalidStates: unknown[] = [
			null,
			{},
			{ camera: null },
			{ camera: { x: Number.NaN, y: 0, scale: 1 } },
			{ camera: { x: 0, y: Number.POSITIVE_INFINITY, scale: 1 } },
			{ camera: { x: 0, y: 0, scale: MIN_CAMERA_SCALE - 0.01 } },
			{ camera: { x: 0, y: 0, scale: MAX_CAMERA_SCALE + 0.01 } },
		];

		for (const invalidState of invalidStates) {
			assert.strictEqual(parseGraphState(invalidState), undefined);
		}
	});
});
