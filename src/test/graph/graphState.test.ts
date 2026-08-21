import * as assert from 'assert';
import {
	createGraphState,
	FILE_GROUP_PAGE_SIZE,
	getRemainingFileCount,
	getVisibleFileCount,
	INITIAL_GRAPH_STATE,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	parseGraphState,
	type GraphStateSnapshot,
} from '../../webview/graph/graphState';

suite('Graph State', () => {
	test('기본 Camera와 빈 opened Folder 상태로 초기화한다', () => {
		const state = createGraphState();

		assert.deepStrictEqual(state.getState(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
		});
		assert.deepStrictEqual(state.getState(), INITIAL_GRAPH_STATE);
	});

	test('외부 객체와 분리된 immutable snapshot을 관리한다', () => {
		const state = createGraphState();
		const nextState = {
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: { 'folder:src': { x: 120, y: 80 } },
			fileGroupPages: { 'folder:src:files': 2 },
			openedFolders: { 'folder:src': true } as Record<string, true>,
			detachedRootNodeIds: {
				'file:src/index.ts': true,
			} as Record<string, true>,
		};

		state.setState(nextState);
		nextState.camera.x = 999;
		nextState.nodePositions['folder:src'].x = 999;
		nextState.fileGroupPages['folder:src:files'] = 999;
		nextState.openedFolders['folder:test'] = true;
		nextState.detachedRootNodeIds['file:src/other.ts'] = true;

		const snapshot = state.getState();
		assert.deepStrictEqual(snapshot.camera, { x: 30, y: -20, scale: 1.5 });
		assert.deepStrictEqual(snapshot.nodePositions, {
			'folder:src': { x: 120, y: 80 },
		});
		assert.deepStrictEqual(snapshot.fileGroupPages, {
			'folder:src:files': 2,
		});
		assert.deepStrictEqual(snapshot.openedFolders, {
			'folder:src': true,
		});
		assert.deepStrictEqual(snapshot.detachedRootNodeIds, {
			'file:src/index.ts': true,
		});
		assert.strictEqual(Object.isFrozen(snapshot), true);
		assert.strictEqual(Object.isFrozen(snapshot.camera), true);
		assert.strictEqual(Object.isFrozen(snapshot.nodePositions), true);
		assert.strictEqual(Object.isFrozen(snapshot.nodePositions['folder:src']), true);
		assert.strictEqual(Object.isFrozen(snapshot.fileGroupPages), true);
		assert.strictEqual(Object.isFrozen(snapshot.openedFolders), true);
		assert.strictEqual(Object.isFrozen(snapshot.detachedRootNodeIds), true);
	});

	test('Folder를 열면 sparse 상태에 ID를 추가하고 닫으면 제거한다', () => {
		const state = createGraphState();
		const initialSnapshot = state.getState();
		const receivedStates: GraphStateSnapshot[] = [];
		state.subscribe((snapshot) => receivedStates.push(snapshot));

		assert.strictEqual(state.isFolderOpened('folder:src'), false);
		assert.strictEqual(state.isFolderOpened('toString'), false);

		state.toggleFolder('folder:src');

		assert.strictEqual(state.isFolderOpened('folder:src'), true);
		assert.deepStrictEqual(state.getState().openedFolders, {
			'folder:src': true,
		});
		assert.deepStrictEqual(state.getState().camera, initialSnapshot.camera);
		assert.strictEqual(state.getState().nodePositions, initialSnapshot.nodePositions);
		assert.strictEqual(state.getState().fileGroupPages, initialSnapshot.fileGroupPages);
		assert.strictEqual(receivedStates.length, 1);
		assert.strictEqual(receivedStates[0], state.getState());

		state.toggleFolder('folder:src');

		assert.strictEqual(state.isFolderOpened('folder:src'), false);
		assert.deepStrictEqual(state.getState().openedFolders, {});
		assert.strictEqual(receivedStates.length, 2);
	});

	test('여러 Folder의 열린 상태를 독립적으로 관리한다', () => {
		const state = createGraphState();

		state.toggleFolder('folder:src');
		state.toggleFolder('folder:test');
		state.toggleFolder('folder:src');

		assert.strictEqual(state.isFolderOpened('folder:src'), false);
		assert.strictEqual(state.isFolderOpened('folder:test'), true);
		assert.deepStrictEqual(state.getState().openedFolders, {
			'folder:test': true,
		});
	});

	test('저장되지 않은 파일 그룹의 기본 page는 1이다', () => {
		const state = createGraphState();

		assert.strictEqual(state.getFileGroupPage('folder:missing:files'), 1);
		assert.strictEqual(state.getFileGroupPage('toString'), 1);
	});

	test('showMore는 해당 파일 그룹의 page만 증가시키고 그룹별 상태를 독립 관리한다', () => {
		const state = createGraphState();

		state.showMoreFiles('folder:src:files');
		assert.strictEqual(state.getFileGroupPage('folder:src:files'), 2);
		assert.strictEqual(state.getFileGroupPage('folder:test:files'), 1);

		state.showMoreFiles('folder:src:files');
		state.showMoreFiles('folder:test:files');

		assert.strictEqual(state.getFileGroupPage('folder:src:files'), 3);
		assert.strictEqual(state.getFileGroupPage('folder:test:files'), 2);
		assert.deepStrictEqual(state.getState().fileGroupPages, {
			'folder:src:files': 3,
			'folder:test:files': 2,
		});
	});

	test('collapse는 현재 page와 관계없이 해당 파일 그룹을 page 1로 복원한다', () => {
		const state = createGraphState();

		state.showMoreFiles('folder:src:files');
		state.showMoreFiles('folder:src:files');
		state.showMoreFiles('folder:test:files');
		state.collapseFileGroup('folder:src:files');

		assert.strictEqual(state.getFileGroupPage('folder:src:files'), 1);
		assert.strictEqual(state.getFileGroupPage('folder:test:files'), 2);
	});

	test('17개 파일의 page별 표시 개수와 남은 개수를 계산한다', () => {
		assert.strictEqual(FILE_GROUP_PAGE_SIZE, 5);
		assert.deepStrictEqual(
			[1, 2, 3, 4].map((page) => getVisibleFileCount(17, page)),
			[5, 10, 15, 17],
		);
		assert.deepStrictEqual(
			[1, 2, 3, 4].map((page) => getRemainingFileCount(17, page)),
			[12, 7, 2, 0],
		);
	});

	test('파일이 없거나 한 page 이하이고 page가 필요 범위보다 큰 경우를 제한한다', () => {
		assert.strictEqual(getVisibleFileCount(0, 1), 0);
		assert.strictEqual(getRemainingFileCount(0, 1), 0);
		assert.strictEqual(getVisibleFileCount(4, 1), 4);
		assert.strictEqual(getRemainingFileCount(4, 1), 0);
		assert.strictEqual(getVisibleFileCount(17, 100), 17);
		assert.strictEqual(getRemainingFileCount(17, 100), 0);
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

	test('opened Folder 값이 같으면 기존 snapshot 참조를 재사용한다', () => {
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { 'folder:app': true },
		});
		const initialOpenedFolders = state.getState().openedFolders;

		state.setState({
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: {},
			openedFolders: { 'folder:app': true },
		});

		assert.strictEqual(state.getState().openedFolders, initialOpenedFolders);
	});

	test('Detached Root Node ID 값이 같으면 기존 snapshot 참조를 재사용한다', () => {
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			detachedRootNodeIds: { 'folder:app': true },
		});
		const initialDetachedRootNodeIds = state.getState().detachedRootNodeIds;

		state.setState({
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: {},
			detachedRootNodeIds: { 'folder:app': true },
		});

		assert.strictEqual(
			state.getState().detachedRootNodeIds,
			initialDetachedRootNodeIds,
		);
	});

	test('Detached Root Node ID가 달라질 때만 새 snapshot을 알린다', () => {
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			detachedRootNodeIds: { 'folder:app': true },
		});
		const snapshots: GraphStateSnapshot[] = [];

		state.subscribe((snapshot) => snapshots.push(snapshot));
		state.setState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			detachedRootNodeIds: { 'folder:app': true },
		});
		assert.strictEqual(snapshots.length, 0);

		state.setState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			detachedRootNodeIds: { 'file:app/index.ts': true },
		});

		assert.strictEqual(snapshots.length, 1);
		assert.deepStrictEqual(snapshots[0]?.detachedRootNodeIds, {
			'file:app/index.ts': true,
		});
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
			fileGroupPages: { 'folder:src:files': 3 },
			openedFolders: { 'folder:src': true },
			detachedRootNodeIds: { 'file:src/index.ts': true },
		};

		const state = parseGraphState(value);

		assert.deepStrictEqual(state, {
			camera: { x: 30, y: -20, scale: 1.5 },
			nodePositions: { 'folder:src': { x: 400, y: 120 } },
			fileGroupPages: { 'folder:src:files': 3 },
			openedFolders: { 'folder:src': true },
			detachedRootNodeIds: { 'file:src/index.ts': true },
		});
		assert.notStrictEqual(state, value);
		assert.notStrictEqual(state?.camera, value.camera);
		assert.notStrictEqual(
			state?.nodePositions['folder:src'],
			value.nodePositions['folder:src'],
		);
		assert.notStrictEqual(state?.fileGroupPages, value.fileGroupPages);
		assert.notStrictEqual(state?.openedFolders, value.openedFolders);
		assert.notStrictEqual(
			state?.detachedRootNodeIds,
			value.detachedRootNodeIds,
		);
	});

	test('필드가 없는 기존 상태를 빈 Node 위치, page, opened와 Detached 상태로 파싱한다', () => {
		const expected = {
			camera: { x: 1, y: 2, scale: 1 },
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
		};

		assert.deepStrictEqual(
			parseGraphState({ camera: { x: 1, y: 2, scale: 1 } }),
			expected,
		);
		assert.deepStrictEqual(parseGraphState({
			camera: { x: 1, y: 2, scale: 1 },
			collapsedFolders: { 'folder:src': true },
		}), expected);
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
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				fileGroupPages: [],
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				fileGroupPages: { 'folder:src:files': 0 },
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				fileGroupPages: { 'folder:src:files': 1.5 },
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				openedFolders: [],
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				openedFolders: { 'folder:src': false },
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				openedFolders: { '': true },
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				detachedRootNodeIds: [],
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				detachedRootNodeIds: { 'folder:src': false },
			},
			{
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				detachedRootNodeIds: { '': true },
			},
		];

		for (const invalidState of invalidStates) {
			assert.strictEqual(parseGraphState(invalidState), undefined);
		}
	});
});
