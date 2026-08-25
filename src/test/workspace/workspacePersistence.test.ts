import * as assert from 'assert';
import * as vscode from 'vscode';
import type { WorkspaceTaskRecord } from '../../task/workspaceTaskState';
import {
	mergeWorkspacePersistentStates,
	partitionWorkspacePersistentStateByRoot,
	readWorkspacePersistentState,
	WORKSPACE_PERSISTENT_STATE_VERSION,
	writeWorkspacePersistentState,
	type WorkspacePersistentState,
} from '../../workspace';
import { createDefaultWorkspacePersistentState } from '../../workspace/workspaceMetadata';

suite('Workspace Persistence', () => {
	suite('read/write', () => {
		test('metadata가 없으면 Directory를 만들지 않고 기본 상태를 반환한다', async () => {
			const rootUri = vscode.Uri.file('/workspace/missing');
			const fake = createFakeFileSystem();

			assert.deepStrictEqual(
				await readWorkspacePersistentState(rootUri, fake.fileSystem),
				createDefaultWorkspacePersistentState(),
			);
			assert.deepStrictEqual(fake.createDirectoryCalls, []);
		});

		test('정상 metadata를 읽고 외부 저장 byte와 분리한다', async () => {
			const rootUri = vscode.Uri.file('/workspace/app');
			const state = createState(rootUri, 3);
			const fake = createFakeFileSystem();
			fake.setJson(getStateUri(rootUri), state);

			const loaded = await readWorkspacePersistentState(rootUri, fake.fileSystem);

			assert.deepStrictEqual(loaded, state);
			assert.notStrictEqual(loaded, state);
			assert.notStrictEqual(loaded.nodePositions, state.nodePositions);
			assert.notStrictEqual(
				loaded.nodePositions[folderId(rootUri)],
				state.nodePositions[folderId(rootUri)],
			);
		});

		test('write 시 `.crispy`를 생성하고 state.json에 정상 상태를 기록한다', async () => {
			const rootUri = vscode.Uri.file('/workspace/app');
			const state = createState(rootUri, 2);
			const fake = createFakeFileSystem();

			await writeWorkspacePersistentState(rootUri, state, fake.fileSystem);

			assert.deepStrictEqual(
				fake.createDirectoryCalls.map((uri) => uri.toString()),
				[vscode.Uri.joinPath(rootUri, '.crispy').toString()],
			);
			assert.deepStrictEqual(fake.getJson(getStateUri(rootUri)), state);
		});

		test('잘못된 JSON, schema와 version은 Root 기본 상태로 fallback한다', async () => {
			const roots = [
				vscode.Uri.file('/workspace/invalid-json'),
				vscode.Uri.file('/workspace/invalid-schema'),
				vscode.Uri.file('/workspace/invalid-version'),
			];
			const fake = createFakeFileSystem();
			fake.setText(getStateUri(roots[0]), '{ invalid json');
			fake.setJson(getStateUri(roots[1]), {
				version: 1,
				nodePositions: [],
			});
			fake.setJson(getStateUri(roots[2]), {
				...createDefaultWorkspacePersistentState(),
				version: 3,
			});

			for (const rootUri of roots) {
				assert.deepStrictEqual(
					await readWorkspacePersistentState(rootUri, fake.fileSystem),
					createDefaultWorkspacePersistentState(),
				);
			}
		});

		test('read 실패 Root만 기본 상태로 격리하고 다른 Root는 정상 복원한다', async () => {
			const failedRootUri = vscode.Uri.file('/workspace/frontend');
			const normalRootUri = vscode.Uri.file('/workspace/backend');
			const normalState = createState(normalRootUri, 4);
			const fake = createFakeFileSystem({
				readErrors: new Set([getStateUri(failedRootUri).toString()]),
			});
			fake.setJson(getStateUri(normalRootUri), normalState);

			const [failed, normal] = await Promise.all([
				readWorkspacePersistentState(failedRootUri, fake.fileSystem),
				readWorkspacePersistentState(normalRootUri, fake.fileSystem),
			]);

			assert.deepStrictEqual(failed, createDefaultWorkspacePersistentState());
			assert.deepStrictEqual(normal, normalState);
		});

		test('write 실패를 호출자에게 전달한다', async () => {
			const rootUri = vscode.Uri.file('/workspace/unwritable');
			const fake = createFakeFileSystem({ failWriteIndexes: new Set([0]) });

			await assert.rejects(
				writeWorkspacePersistentState(
					rootUri,
					createState(rootUri, 2),
					fake.fileSystem,
				),
				/write failed/,
			);
			assert.strictEqual(fake.getJson(getStateUri(rootUri)), undefined);
		});

		test('Root A의 write 실패가 Root B의 write를 막지 않는다', async () => {
			const failedRootUri = vscode.Uri.file('/workspace/unwritable');
			const normalRootUri = vscode.Uri.file('/workspace/writable');
			const normalState = createState(normalRootUri, 4);
			const fake = createFakeFileSystem({ failWriteIndexes: new Set([0]) });

			const failed = writeWorkspacePersistentState(
				failedRootUri,
				createState(failedRootUri, 2),
				fake.fileSystem,
			);
			const normal = writeWorkspacePersistentState(
				normalRootUri,
				normalState,
				fake.fileSystem,
			);

			await assert.rejects(failed, /write failed/);
			await normal;
			assert.strictEqual(
				fake.getJson(getStateUri(failedRootUri)),
				undefined,
			);
			assert.deepStrictEqual(
				fake.getJson(getStateUri(normalRootUri)),
				normalState,
			);
		});

		test('write 실패 뒤 같은 Root의 다음 write를 정상 실행한다', async () => {
			const rootUri = vscode.Uri.file('/workspace/recover');
			const recoveredState = createState(rootUri, 5);
			const fake = createFakeFileSystem({ failWriteIndexes: new Set([0]) });

			const failed = writeWorkspacePersistentState(
				rootUri,
				createState(rootUri, 2),
				fake.fileSystem,
			);
			const recovered = writeWorkspacePersistentState(
				rootUri,
				recoveredState,
				fake.fileSystem,
			);

			await assert.rejects(failed, /write failed/);
			await recovered;

			assert.deepStrictEqual(fake.getJson(getStateUri(rootUri)), recoveredState);
		});

		test('동일 Root의 연속 write를 호출 순서대로 실행한다', async () => {
			const rootUri = vscode.Uri.file('/workspace/ordered');
			const firstWrite = createDeferred();
			const fake = createFakeFileSystem({
				async beforeWrite(_uri, _content, writeIndex) {
					if (writeIndex === 0) {
						await firstWrite.promise;
					}
				},
			});
			const firstState = createState(rootUri, 2);
			const lastState = createState(rootUri, 6);

			const first = writeWorkspacePersistentState(
				rootUri,
				firstState,
				fake.fileSystem,
			);
			const last = writeWorkspacePersistentState(
				rootUri,
				lastState,
				fake.fileSystem,
			);
			await waitFor(() => fake.writeFileCalls.length === 1);

			assert.strictEqual(fake.writeFileCalls.length, 1);
			firstWrite.resolve();
			await Promise.all([first, last]);
			assert.deepStrictEqual(fake.getJson(getStateUri(rootUri)), lastState);
		});

		test('서로 다른 Root의 write는 독립적으로 진행한다', async () => {
			const frontendUri = vscode.Uri.file('/workspace/frontend');
			const backendUri = vscode.Uri.file('/workspace/backend');
			const frontendWrite = createDeferred();
			const fake = createFakeFileSystem({
				async beforeWrite(uri) {
					if (uri.toString() === getStateUri(frontendUri).toString()) {
						await frontendWrite.promise;
					}
				},
			});

			const frontend = writeWorkspacePersistentState(
				frontendUri,
				createState(frontendUri, 2),
				fake.fileSystem,
			);
			await waitFor(() => fake.writeFileCalls.length === 1);
			const backendState = createState(backendUri, 4);
			const backend = writeWorkspacePersistentState(
				backendUri,
				backendState,
				fake.fileSystem,
			);

			await backend;
			assert.deepStrictEqual(fake.getJson(getStateUri(backendUri)), backendState);
			assert.strictEqual(fake.getJson(getStateUri(frontendUri)), undefined);
			frontendWrite.resolve();
			await frontend;
		});
	});

	suite('Root ownership and partition', () => {
		test('Root, Folder, File, File Group, Detached와 Filter ID를 URI 경계로 분배한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const appOldUri = vscode.Uri.file('/workspace/app-old');
			const appRootId = workspaceRootId(appUri);
			const appFolderId = folderId(appUri);
			const appFileId = fileId(appUri);
			const appFileGroupId = `${appFolderId}:files`;
			const appRootFileGroupId = `${appRootId}:files`;
			const appOldFolderId = folderId(appOldUri);
			const unknownId = 'folder:file:///outside/private';
			const state: WorkspacePersistentState = {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: {
					[appRootId]: { x: 10, y: 20 },
					[appFolderId]: { x: 30, y: 40 },
					[appFileId]: { x: 50, y: 60 },
					[appFileGroupId]: { x: 70, y: 80 },
					[appOldFolderId]: { x: 90, y: 100 },
					[unknownId]: { x: 110, y: 120 },
				},
				fileGroupPages: {
					[appFileGroupId]: 2,
					[appRootFileGroupId]: 3,
					[`${appOldFolderId}:files`]: 4,
				},
				openedFolders: {
					[appRootId]: true,
					[appFolderId]: true,
					[appOldFolderId]: true,
				},
				detachedRootNodeIds: {
					[appFileId]: true,
					[appOldFolderId]: true,
				},
				hiddenNodeIds: {
					[appFolderId]: true,
					[appOldFolderId]: true,
					[unknownId]: true,
				},
				tasks: [],
				taskRelocations: [],
			};

			const partitioned = partitionWorkspacePersistentStateByRoot(
				state,
				[appUri, appOldUri],
			);
			const app = getRootState(partitioned, appUri);
			const appOld = getRootState(partitioned, appOldUri);

			assert.deepStrictEqual(Object.keys(app.nodePositions), [
				appRootId,
				appFolderId,
				appFileId,
				appFileGroupId,
			]);
			assert.deepStrictEqual(app.fileGroupPages, {
				[appFileGroupId]: 2,
				[appRootFileGroupId]: 3,
			});
			assert.deepStrictEqual(app.openedFolders, {
				[appRootId]: true,
				[appFolderId]: true,
			});
			assert.deepStrictEqual(app.detachedRootNodeIds, { [appFileId]: true });
			assert.deepStrictEqual(app.hiddenNodeIds, { [appFolderId]: true });
			assert.deepStrictEqual(appOld.nodePositions, {
				[appOldFolderId]: { x: 90, y: 100 },
			});
			assert.strictEqual(
				Object.hasOwn(app.nodePositions, unknownId),
				false,
			);
			assert.strictEqual(Object.hasOwn(app.hiddenNodeIds, unknownId), false);
		});

		test('현재 Graph에 없는 URI 기반 metadata도 소유 Root에 보존한다', () => {
			const rootUri = vscode.Uri.file('/workspace/app');
			const hiddenFolderId = `folder:${vscode.Uri.joinPath(
				rootUri,
				'private',
			).toString()}`;
			const hiddenFileId = `file:${vscode.Uri.joinPath(
				rootUri,
				'private',
				'config.ts',
			).toString()}`;
			const state: WorkspacePersistentState = {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: { [hiddenFolderId]: { x: 10, y: 20 } },
				fileGroupPages: { [`${hiddenFolderId}:files`]: 2 },
				openedFolders: { [hiddenFolderId]: true },
				detachedRootNodeIds: { [hiddenFileId]: true },
				hiddenNodeIds: {
					[hiddenFolderId]: true,
					[hiddenFileId]: true,
				},
				tasks: [],
				taskRelocations: [],
			};

			const partitioned = partitionWorkspacePersistentStateByRoot(
				state,
				[rootUri],
			);

			assert.deepStrictEqual(getRootState(partitioned, rootUri), state);
		});

		test('중첩 Root에서는 File Group과 Filter ID를 가장 구체적인 Root가 소유한다', () => {
			const outerRootUri = vscode.Uri.file('/workspace/app');
			const innerRootUri = vscode.Uri.joinPath(outerRootUri, 'packages', 'ui');
			const innerRootFileGroupId = `${workspaceRootId(innerRootUri)}:files`;
			const innerFolderFileGroupId = `${folderId(innerRootUri)}:files`;
			const state: WorkspacePersistentState = {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: {
					[innerRootFileGroupId]: { x: 10, y: 20 },
					[innerFolderFileGroupId]: { x: 30, y: 40 },
				},
				fileGroupPages: {
					[innerRootFileGroupId]: 2,
					[innerFolderFileGroupId]: 3,
				},
				openedFolders: {},
				detachedRootNodeIds: {},
				hiddenNodeIds: {
					[workspaceRootId(innerRootUri)]: true,
					[folderId(innerRootUri)]: true,
				},
				tasks: [],
				taskRelocations: [],
			};

			const partitioned = partitionWorkspacePersistentStateByRoot(
				state,
				[outerRootUri, innerRootUri],
			);

			assert.deepStrictEqual(
				getRootState(partitioned, outerRootUri),
				createDefaultWorkspacePersistentState(),
			);
			assert.deepStrictEqual(getRootState(partitioned, innerRootUri), state);
		});

		test('Task는 URI 포함 관계가 아니라 ownerRootId가 정확히 같은 Root에 분배한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const appTask = createTaskRecord(appUri, 'app');
			const apiTask = createTaskRecord(apiUri, 'api');
			const unavailableTask = createTaskRecord(
				vscode.Uri.file('/workspace/unavailable'),
				'unavailable',
			);
			const state: WorkspacePersistentState = {
				...createDefaultWorkspacePersistentState(),
				tasks: [apiTask, unavailableTask, appTask],
				taskRelocations: [],
			};

			const partitioned = partitionWorkspacePersistentStateByRoot(
				state,
				[appUri, apiUri],
			);
			const app = getRootState(partitioned, appUri);
			const api = getRootState(partitioned, apiUri);

			assert.deepStrictEqual(app.tasks, [appTask]);
			assert.deepStrictEqual(api.tasks, [apiTask]);
			assert.notStrictEqual(app.tasks[0], appTask);
			assert.strictEqual(
				partitioned.some(({ state: rootState }) => (
					rootState.tasks.some((record) => (
						record.task.id === unavailableTask.task.id
					))
				)),
				false,
			);
		});

		test('source relocation journal은 destination Root가 함께 열릴 때만 Task를 복구한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const movedTask = createTaskRecord(apiUri, 'recovered', 5);
			const relocation = {
				sourceRootId: workspaceRootId(appUri),
				record: movedTask,
			};
			const appState: WorkspacePersistentState = {
				...createDefaultWorkspacePersistentState(),
				taskRelocations: [relocation],
			};
			const apiState = createDefaultWorkspacePersistentState();
			const appOnly = mergeWorkspacePersistentStates([{
				rootUri: appUri,
				state: appState,
			}]);

			assert.deepStrictEqual(appOnly.tasks, []);
			assert.deepStrictEqual(appOnly.taskRelocations, [relocation]);

			const recovered = mergeWorkspacePersistentStates([{
				rootUri: appUri,
				state: appState,
			}, {
				rootUri: apiUri,
				state: apiState,
			}]);

			assert.deepStrictEqual(recovered.tasks, [movedTask]);
			assert.deepStrictEqual(recovered.taskRelocations, [relocation]);
			const partitioned = partitionWorkspacePersistentStateByRoot(
				recovered,
				[appUri, apiUri],
			);

			assert.deepStrictEqual(
				getRootState(partitioned, appUri).taskRelocations,
				[relocation],
			);
			assert.deepStrictEqual(
				getRootState(partitioned, apiUri).tasks,
				[movedTask],
			);
		});
	});

	suite('Root state merge', () => {
		test('Root A와 Root B의 모든 상태 Map을 정상 병합한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const appState = createState(appUri, 2);
			const apiState = createState(apiUri, 4);

			assert.deepStrictEqual(mergeWorkspacePersistentStates([
				{ rootUri: appUri, state: appState },
				{ rootUri: apiUri, state: apiState },
			]), {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: {
					...appState.nodePositions,
					...apiState.nodePositions,
				},
				fileGroupPages: {
					...appState.fileGroupPages,
					...apiState.fileGroupPages,
				},
				openedFolders: {
					...appState.openedFolders,
					...apiState.openedFolders,
				},
				detachedRootNodeIds: {
					...appState.detachedRootNodeIds,
					...apiState.detachedRootNodeIds,
				},
				hiddenNodeIds: {
					...appState.hiddenNodeIds,
					...apiState.hiddenNodeIds,
				},
				tasks: [],
				taskRelocations: [],
			});
		});

		test('분배 후 병합하면 소유 가능한 Runtime 상태를 그대로 복원한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const runtime: WorkspacePersistentState = {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: {
					...createState(appUri, 2).nodePositions,
					...createState(apiUri, 3).nodePositions,
				},
				fileGroupPages: {
					...createState(appUri, 2).fileGroupPages,
					...createState(apiUri, 3).fileGroupPages,
				},
				openedFolders: {
					...createState(appUri, 2).openedFolders,
					...createState(apiUri, 3).openedFolders,
				},
				detachedRootNodeIds: {
					...createState(appUri, 2).detachedRootNodeIds,
					...createState(apiUri, 3).detachedRootNodeIds,
				},
				hiddenNodeIds: {
					...createState(appUri, 2).hiddenNodeIds,
					...createState(apiUri, 3).hiddenNodeIds,
				},
				tasks: [],
				taskRelocations: [],
			};

			assert.deepStrictEqual(
				mergeWorkspacePersistentStates(
					partitionWorkspacePersistentStateByRoot(
						runtime,
						[appUri, apiUri],
					),
				),
				runtime,
			);
		});

		test('Root metadata에 섞인 다른 Root entry를 모든 상태 Map에서 무시한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const appState = createState(appUri, 2);
			const apiState = createState(apiUri, 4);
			const contaminatedAppState: WorkspacePersistentState = {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: {
					...appState.nodePositions,
					...apiState.nodePositions,
				},
				fileGroupPages: {
					...appState.fileGroupPages,
					...apiState.fileGroupPages,
				},
				openedFolders: {
					...appState.openedFolders,
					...apiState.openedFolders,
				},
				detachedRootNodeIds: {
					...appState.detachedRootNodeIds,
					...apiState.detachedRootNodeIds,
				},
				hiddenNodeIds: {
					...appState.hiddenNodeIds,
					...apiState.hiddenNodeIds,
				},
				tasks: [],
				taskRelocations: [],
			};

			assert.deepStrictEqual(mergeWorkspacePersistentStates([
				{ rootUri: appUri, state: contaminatedAppState },
				{ rootUri: apiUri, state: apiState },
			]), {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: {
					...appState.nodePositions,
					...apiState.nodePositions,
				},
				fileGroupPages: {
					...appState.fileGroupPages,
					...apiState.fileGroupPages,
				},
				openedFolders: {
					...appState.openedFolders,
					...apiState.openedFolders,
				},
				detachedRootNodeIds: {
					...appState.detachedRootNodeIds,
					...apiState.detachedRootNodeIds,
				},
				hiddenNodeIds: {
					...appState.hiddenNodeIds,
					...apiState.hiddenNodeIds,
				},
				tasks: [],
				taskRelocations: [],
			});
		});

		test('물리 Root와 ownerRootId가 일치하는 Task만 병합한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const appTask = createTaskRecord(appUri, 'app');
			const apiTask = createTaskRecord(apiUri, 'api');
			const appState: WorkspacePersistentState = {
				...createDefaultWorkspacePersistentState(),
				tasks: [apiTask, appTask],
				taskRelocations: [],
			};
			const apiState: WorkspacePersistentState = {
				...createDefaultWorkspacePersistentState(),
				tasks: [apiTask],
				taskRelocations: [],
			};

			assert.deepStrictEqual(mergeWorkspacePersistentStates([
				{ rootUri: appUri, state: appState },
				{ rootUri: apiUri, state: apiState },
			]).tasks, [appTask, apiTask]);
		});

		test('Task ID 충돌은 높은 storageRevision을 선택한다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const appTask = createTaskRecord(appUri, 'shared', 2);
			const apiTask = {
				...createTaskRecord(apiUri, 'shared', 5),
				task: {
					...createTaskRecord(apiUri, 'shared', 5).task,
					title: 'Newer API Task',
				},
			};

			assert.deepStrictEqual(mergeWorkspacePersistentStates([
				{
					rootUri: appUri,
					state: {
						...createDefaultWorkspacePersistentState(),
						tasks: [appTask],
						taskRelocations: [],
					},
				},
				{
					rootUri: apiUri,
					state: {
						...createDefaultWorkspacePersistentState(),
						tasks: [apiTask],
						taskRelocations: [],
					},
				},
			]).tasks, [apiTask]);
		});

		test('같은 revision의 Task ID 충돌 winner는 Root 입력 순서와 무관하다', () => {
			const appUri = vscode.Uri.file('/workspace/app');
			const apiUri = vscode.Uri.file('/workspace/api');
			const appTask = createTaskRecord(appUri, 'shared', 3);
			const apiTask = {
				...createTaskRecord(apiUri, 'shared', 3),
				task: {
					...createTaskRecord(apiUri, 'shared', 3).task,
					title: 'API Task',
				},
			};
			const appRootState = {
				rootUri: appUri,
				state: {
					...createDefaultWorkspacePersistentState(),
					tasks: [appTask],
					taskRelocations: [],
				},
			};
			const apiRootState = {
				rootUri: apiUri,
				state: {
					...createDefaultWorkspacePersistentState(),
					tasks: [apiTask],
					taskRelocations: [],
				},
			};

			const forward = mergeWorkspacePersistentStates([
				appRootState,
				apiRootState,
			]);
			const reversed = mergeWorkspacePersistentStates([
				apiRootState,
				appRootState,
			]);

			assert.deepStrictEqual(forward.tasks, reversed.tasks);
			assert.ok(
				forward.tasks[0]?.ownerRootId === appTask.ownerRootId
				|| forward.tasks[0]?.ownerRootId === apiTask.ownerRootId,
			);
		});

		test('연쇄 relocation은 비활성 owner의 최신 journal이 이전 live/journal 복구를 막는다', () => {
			const rootA = vscode.Uri.file('/workspace/a');
			const rootB = vscode.Uri.file('/workspace/b');
			const rootC = vscode.Uri.file('/workspace/c');
			const movedToB = createTaskRecord(rootB, 'chain', 2);
			const movedToC = createTaskRecord(rootC, 'chain', 3);
			const relocationAtoB = {
				sourceRootId: workspaceRootId(rootA),
				record: movedToB,
			};
			const relocationBtoC = {
				sourceRootId: workspaceRootId(rootB),
				record: movedToC,
			};
			const stateA: WorkspacePersistentState = {
				...createDefaultWorkspacePersistentState(),
				taskRelocations: [relocationAtoB],
			};
			const stateB: WorkspacePersistentState = {
				...createDefaultWorkspacePersistentState(),
				// B destination에 남은 이전 live record와 B→C journal이
				// 동시에 있는 crash snapshot을 재현한다.
				tasks: [movedToB],
				taskRelocations: [relocationBtoC],
			};

			const withoutC = mergeWorkspacePersistentStates([
				{ rootUri: rootA, state: stateA },
				{ rootUri: rootB, state: stateB },
			]);

			assert.deepStrictEqual(withoutC.tasks, []);
			assert.deepStrictEqual(withoutC.taskRelocations, [
				relocationAtoB,
				relocationBtoC,
			]);

			const withC = mergeWorkspacePersistentStates([
				{ rootUri: rootA, state: stateA },
				{ rootUri: rootB, state: stateB },
				{
					rootUri: rootC,
					state: createDefaultWorkspacePersistentState(),
				},
			]);

			assert.deepStrictEqual(withC.tasks, [movedToC]);
		});
	});
});

interface FakeFileSystemOptions {
	readonly readErrors?: ReadonlySet<string>;
	readonly failWriteIndexes?: ReadonlySet<number>;
	readonly beforeWrite?: (
		uri: vscode.Uri,
		content: Uint8Array,
		writeIndex: number,
	) => Promise<void>;
}

function createFakeFileSystem(options: FakeFileSystemOptions = {}) {
	const files = new Map<string, Uint8Array>();
	const createDirectoryCalls: vscode.Uri[] = [];
	const writeFileCalls: Array<{
		readonly uri: vscode.Uri;
		readonly content: Uint8Array;
	}> = [];
	let writeIndex = 0;
	const fileSystem = {
		async readFile(uri: vscode.Uri): Promise<Uint8Array> {
			if (options.readErrors?.has(uri.toString())) {
				throw new Error('read failed');
			}

			const content = files.get(uri.toString());

			if (!content) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}

			return content.slice();
		},
		async createDirectory(uri: vscode.Uri): Promise<void> {
			createDirectoryCalls.push(uri);
		},
		async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
			const currentIndex = writeIndex;
			writeIndex += 1;
			writeFileCalls.push({ uri, content: content.slice() });
			await options.beforeWrite?.(uri, content, currentIndex);

			if (options.failWriteIndexes?.has(currentIndex)) {
				throw new Error('write failed');
			}

			files.set(uri.toString(), content.slice());
		},
	};

	return {
		fileSystem,
		createDirectoryCalls,
		writeFileCalls,
		setText(uri: vscode.Uri, text: string): void {
			files.set(uri.toString(), new TextEncoder().encode(text));
		},
		setJson(uri: vscode.Uri, value: unknown): void {
			files.set(
				uri.toString(),
				new TextEncoder().encode(JSON.stringify(value)),
			);
		},
		getJson(uri: vscode.Uri): unknown {
			const content = files.get(uri.toString());

			return content
				? JSON.parse(new TextDecoder().decode(content)) as unknown
				: undefined;
		},
	};
}

function createState(
	rootUri: vscode.Uri,
	page: number,
): WorkspacePersistentState {
	const folder = folderId(rootUri);
	const file = fileId(rootUri);

	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions: { [folder]: { x: page * 10, y: page * 20 } },
		fileGroupPages: { [`${folder}:files`]: page },
		openedFolders: { [folder]: true },
	detachedRootNodeIds: { [file]: true },
	hiddenNodeIds: { [folder]: true },
	tasks: [],
	taskRelocations: [],
	};
}

function createTaskRecord(
	rootUri: vscode.Uri,
	suffix: string,
	storageRevision = 1,
): WorkspaceTaskRecord {
	const startId = `task-node:${suffix}:start`;
	const endId = `task-node:${suffix}:end`;

	return {
		ownerRootId: workspaceRootId(rootUri),
		storageRevision,
		task: {
			version: 1,
			id: `task:${suffix}`,
			title: `Task ${suffix}`,
			description: '',
			defaultGraphTargets: { reference: [], work: [] },
			origin: { x: 10, y: 20 },
			nodePositions: { [endId]: { x: 640, y: 0 } },
			nodes: [
				{ id: startId, kind: 'start' },
				{ id: endId, kind: 'end' },
			],
			edges: [],
		},
		targetOrigins: [],
	};
}

function workspaceRootId(rootUri: vscode.Uri): string {
	return `workspace-root:${rootUri.toString()}`;
}

function folderId(rootUri: vscode.Uri): string {
	return `folder:${vscode.Uri.joinPath(rootUri, 'src').toString()}`;
}

function fileId(rootUri: vscode.Uri): string {
	return `file:${vscode.Uri.joinPath(rootUri, 'src', 'index.ts').toString()}`;
}

function getStateUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(rootUri, '.crispy', 'state.json');
}

function getRootState(
	rootStates: readonly {
		readonly rootUri: vscode.Uri;
		readonly state: WorkspacePersistentState;
	}[],
	rootUri: vscode.Uri,
): WorkspacePersistentState {
	const rootState = rootStates.find(
		(candidate) => candidate.rootUri.toString() === rootUri.toString(),
	);

	assert.ok(rootState);
	return rootState.state;
}

function createDeferred(): {
	readonly promise: Promise<void>;
	resolve(): void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});

	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) {
			return;
		}

		await Promise.resolve();
	}

	assert.fail('Expected asynchronous condition was not met.');
}
