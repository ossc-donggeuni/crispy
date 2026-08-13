import * as assert from 'assert';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
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
});
