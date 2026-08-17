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
			nodePositions: {},
		});
		assert.deepStrictEqual(state.getState(), INITIAL_GRAPH_STATE);
	});

	test('외부 객체와 분리된 immutable snapshot을 관리한다', () => {
		const state = createGraphState();
		const nextState = {
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: { 'folder:src': { x: 120, y: 80 } },
		};

		state.setState(nextState);
		nextState.camera.x = 999;
		nextState.nodePositions['folder:src'].x = 999;

		const snapshot = state.getState();
		assert.deepStrictEqual(snapshot.camera, { x: 30, y: -20, scale: 1.5 });
		assert.deepStrictEqual(snapshot.nodePositions, {
			'folder:src': { x: 120, y: 80 },
		});
		assert.strictEqual(Object.isFrozen(snapshot), true);
		assert.strictEqual(Object.isFrozen(snapshot.camera), true);
		assert.strictEqual(Object.isFrozen(snapshot.nodePositions), true);
		assert.strictEqual(Object.isFrozen(snapshot.nodePositions['folder:src']), true);
	});

	test('변경된 상태를 subscriber에 전달하고 unsubscribe 이후 호출하지 않는다', () => {
		const state = createGraphState();
		const receivedStates: GraphStateSnapshot[] = [];
		const unsubscribe = state.subscribe((nextState) => {
			receivedStates.push(nextState);
		});

		state.setState({
			camera: { x: 10, y: 20, scale: 2 },
			nodePositions: {},
		});
		unsubscribe();
		unsubscribe();
		state.setState({
			camera: { x: 30, y: 40, scale: 3 },
			nodePositions: {},
		});

		assert.strictEqual(receivedStates.length, 1);
		assert.deepStrictEqual(receivedStates[0].camera, { x: 10, y: 20, scale: 2 });
	});

	test('동일한 Node 위치 객체이면 reference fast-path로 snapshot 참조를 재사용한다', () => {
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { 'folder:src': { x: 120, y: 80 } },
		});
		const initialPositions = state.getState().nodePositions;

		state.setState({
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: initialPositions,
		});

		assert.strictEqual(state.getState().nodePositions, initialPositions);
	});

	test('다른 객체여도 Node 위치 값이 같으면 기존 snapshot 참조를 재사용한다', () => {
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { 'folder:src': { x: 120, y: 80 } },
		});
		const initialPositions = state.getState().nodePositions;

		state.setState({
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: { 'folder:src': { x: 120, y: 80 } },
		});

		assert.strictEqual(state.getState().nodePositions, initialPositions);
	});

	test('Camera scale을 최소 및 최대 범위로 제한한다', () => {
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 0 },
			nodePositions: {},
		});

		assert.strictEqual(state.getState().camera.scale, MIN_CAMERA_SCALE);

		state.setState({
			camera: { x: 0, y: 0, scale: 100 },
			nodePositions: {},
		});
		assert.strictEqual(state.getState().camera.scale, MAX_CAMERA_SCALE);
	});

	test('유효한 Graph 상태를 독립적인 객체로 파싱한다', () => {
		const value = {
			camera: { x: 30, y: -20, scale: 1.5, transient: true },
			nodePositions: {
				'folder:src': { x: 400, y: 120, transient: true },
			},
		};

		const state = parseGraphState(value);

		assert.deepStrictEqual(state, {
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: { 'folder:src': { x: 400, y: 120 } },
		});
		assert.notStrictEqual(state, value);
		assert.notStrictEqual(state?.camera, value.camera);
		assert.notStrictEqual(
			state?.nodePositions['folder:src'],
			value.nodePositions['folder:src'],
		);
	});

	test('기존 Camera 전용 상태를 빈 Node 위치로 호환 파싱한다', () => {
		assert.deepStrictEqual(
			parseGraphState({ camera: { x: 1, y: 2, scale: 1 } }),
			{
				camera: { x: 1, y: 2, scale: 1 },
				nodePositions: {},
			},
		);
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
			{ camera: { x: 0, y: 0, scale: 1 }, nodePositions: [] },
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: { invalid: { x: Number.NaN, y: 1 } },
			},
		];

		for (const invalidState of invalidStates) {
			assert.strictEqual(parseGraphState(invalidState), undefined);
		}
	});
});
