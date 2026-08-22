import * as assert from 'assert';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	WORKSPACE_PERSISTENT_STATE_VERSION,
} from '../../workspace/workspaceMetadata';

suite('Workspace Persistent State', () => {
	test('version 1 상태를 파싱한다', () => {
		assert.deepStrictEqual(parseWorkspacePersistentState({
			version: 1,
			nodePositions: { 'folder:src': { x: 120, y: -40 } },
			fileGroupPages: { 'folder:src:files': 2 },
			openedFolders: { 'folder:src': true },
			detachedRootNodeIds: { 'file:src/index.ts': true },
			hiddenNodeIds: { 'folder:src/private': true },
		}), {
			version: 1,
			nodePositions: { 'folder:src': { x: 120, y: -40 } },
			fileGroupPages: { 'folder:src:files': 2 },
			openedFolders: { 'folder:src': true },
			detachedRootNodeIds: { 'file:src/index.ts': true },
			hiddenNodeIds: { 'folder:src/private': true },
		});
	});

	test('새 기본 상태를 생성한다', () => {
		const first = createDefaultWorkspacePersistentState();
		const second = createDefaultWorkspacePersistentState();

		assert.deepStrictEqual(first, {
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		});
		assert.notStrictEqual(first, second);
		assert.notStrictEqual(first.nodePositions, second.nodePositions);
		assert.notStrictEqual(first.fileGroupPages, second.fileGroupPages);
		assert.notStrictEqual(first.openedFolders, second.openedFolders);
		assert.notStrictEqual(
			first.detachedRootNodeIds,
			second.detachedRootNodeIds,
		);
		assert.notStrictEqual(first.hiddenNodeIds, second.hiddenNodeIds);
	});

	test('현재 버전이 아닌 상태를 거부한다', () => {
		for (const version of [undefined, 0, 2, '1']) {
			assert.strictEqual(parseWorkspacePersistentState({ version }), undefined);
		}
	});

	test('유효한 File Group page 상태를 파싱한다', () => {
		assert.deepStrictEqual(parseWorkspacePersistentState({
			version: 1,
			fileGroupPages: {
				'folder:src:files': 2,
				'folder:test:files': 4,
			},
		}), {
			version: 1,
			nodePositions: {},
			fileGroupPages: {
				'folder:src:files': 2,
				'folder:test:files': 4,
			},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		});
	});

	test('잘못된 File Group page 상태를 거부한다', () => {
		const invalidFileGroupPages: unknown[] = [
			[],
			{ 'folder:src:files': 0 },
			{ 'folder:src:files': -1 },
			{ 'folder:src:files': 1.5 },
			{ 'folder:src:files': Number.NaN },
		];

		for (const fileGroupPages of invalidFileGroupPages) {
			assert.strictEqual(parseWorkspacePersistentState({
				version: 1,
				fileGroupPages,
			}), undefined);
		}
	});

	test('잘못된 Node Position을 거부한다', () => {
		assert.strictEqual(parseWorkspacePersistentState({
			version: 1,
			nodePositions: { 'folder:src': { x: Number.NaN, y: 20 } },
		}), undefined);
	});

	test('잘못된 Opened Folder 값을 거부한다', () => {
		assert.strictEqual(parseWorkspacePersistentState({
			version: 1,
			openedFolders: { 'folder:src': false },
		}), undefined);
	});

	test('잘못된 Detached Root 값을 거부한다', () => {
		assert.strictEqual(parseWorkspacePersistentState({
			version: 1,
			detachedRootNodeIds: { 'folder:src': false },
		}), undefined);
	});

	test('잘못된 숨김 Node 값을 거부한다', () => {
		for (const hiddenNodeIds of [false, [], { 'folder:src': false }, { '': true }]) {
			assert.strictEqual(parseWorkspacePersistentState({
				version: 1,
				hiddenNodeIds,
			}), undefined);
		}
	});

	test('Filter를 포함한 누락된 Workspace 상태 Map을 빈 상태로 복원한다', () => {
		assert.deepStrictEqual(parseWorkspacePersistentState({ version: 1 }), {
			version: 1,
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		});
	});

	test('입력 객체와 mutation을 공유하지 않는다', () => {
		const input = {
			version: 1,
			nodePositions: { 'folder:src': { x: 100, y: 200 } },
			fileGroupPages: { 'folder:src:files': 2 },
			openedFolders: { 'folder:src': true } as Record<string, true>,
			detachedRootNodeIds: { 'folder:src': true } as Record<string, true>,
			hiddenNodeIds: { 'folder:src/private': true } as Record<string, true>,
		};
		const state = parseWorkspacePersistentState(input);

		assert.ok(state);
		input.nodePositions['folder:src'].x = 999;
		input.fileGroupPages['folder:src:files'] = 999;
		input.openedFolders['folder:test'] = true;
		input.detachedRootNodeIds['file:src/index.ts'] = true;
		input.hiddenNodeIds['file:src/private/secret.ts'] = true;

		assert.deepStrictEqual(state.nodePositions, {
			'folder:src': { x: 100, y: 200 },
		});
		assert.deepStrictEqual(state.fileGroupPages, {
			'folder:src:files': 2,
		});
		assert.deepStrictEqual(state.openedFolders, { 'folder:src': true });
		assert.deepStrictEqual(state.detachedRootNodeIds, { 'folder:src': true });
		assert.deepStrictEqual(state.hiddenNodeIds, {
			'folder:src/private': true,
		});
		assert.notStrictEqual(state.nodePositions, input.nodePositions);
		assert.notStrictEqual(
			state.nodePositions['folder:src'],
			input.nodePositions['folder:src'],
		);
		assert.notStrictEqual(state.fileGroupPages, input.fileGroupPages);
		assert.notStrictEqual(state.openedFolders, input.openedFolders);
		assert.notStrictEqual(
			state.detachedRootNodeIds,
			input.detachedRootNodeIds,
		);
		assert.notStrictEqual(state.hiddenNodeIds, input.hiddenNodeIds);
	});
});
