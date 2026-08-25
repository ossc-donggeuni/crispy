import * as assert from 'assert';
import {
	collectWorkspaceContext,
	readVsCodeWorkspaceContext,
	type WorkspaceContextReader,
	type WorkspaceContextSnapshot,
} from '../../agent/host/workspace/workspaceContext';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** 실제 VS Code adapter가 Webview 값이나 `cwd`를 인자로 받지 않는지 검증한다. */
type VsCodeAdapterHasNoInput = Assert<Equal<
	Parameters<typeof readVsCodeWorkspaceContext>,
	[]
>>;

/** 판독기가 작업공간 정책에 필요한 VS Code 상태만 요구하는지 검증한다. */
type ReaderHasOnlyWorkspaceState = Assert<Equal<
	keyof WorkspaceContextReader,
	'isTrusted' | 'workspaceFolders'
>>;

/** 스냅샷이 정책 계층에 필요한 값만 노출하는지 검증한다. */
type SnapshotHasOnlyPolicyInput = Assert<Equal<
	keyof WorkspaceContextSnapshot,
	'isTrusted' | 'workspaceFolders'
>>;

suite('VS Code workspace context adapter', () => {
	test('trusted 상태를 snapshot에 반영한다', () => {
		const snapshot = collectWorkspaceContext({
			isTrusted: true,
			workspaceFolders: [],
		});

		assert.strictEqual(snapshot.isTrusted, true);
	});

	test('workspace folder가 없으면 빈 배열로 수집한다', () => {
		const snapshot = collectWorkspaceContext({
			isTrusted: false,
			workspaceFolders: undefined,
		});

		assert.deepStrictEqual(snapshot.workspaceFolders, []);
		assert.ok(Object.isFrozen(snapshot.workspaceFolders));
	});

	test('여러 folder의 scheme과 fsPath를 순서대로 복사한다', () => {
		const first = {
			uri: {
				scheme: 'file',
				fsPath: '/workspace/first',
				toString: () => 'file:///workspace/first',
			},
		};
		const second = {
			uri: {
				scheme: 'vscode-remote',
				fsPath: '/workspace/second',
				toString: () => 'vscode-remote://host/workspace/second',
			},
		};
		const snapshot = collectWorkspaceContext({
			isTrusted: true,
			workspaceFolders: [first, second],
		});

		assert.deepStrictEqual(snapshot.workspaceFolders, [
			{
				id: 'workspace-root:file:///workspace/first',
				workspaceFolder: first,
				scheme: 'file',
				fsPath: '/workspace/first',
			},
			{
				id: 'workspace-root:vscode-remote://host/workspace/second',
				workspaceFolder: second,
				scheme: 'vscode-remote',
				fsPath: '/workspace/second',
			},
		]);
	});

	test('정책 값은 복사하고 exact lookup용 fresh folder identity는 보존한다', () => {
		const uri = {
			scheme: 'file',
			fsPath: '/workspace/original',
			toString: () => 'file:///workspace/original',
		};
		const workspaceFolders = [{ uri }];
		const reader = { isTrusted: true, workspaceFolders };
		const snapshot = collectWorkspaceContext(reader);

		reader.isTrusted = false;
		uri.scheme = 'vscode-remote';
		uri.fsPath = '/workspace/changed';
		workspaceFolders.push({
			uri: {
				scheme: 'file',
				fsPath: '/workspace/added',
				toString: () => 'file:///workspace/added',
			},
		});

		assert.strictEqual(snapshot.isTrusted, true);
		assert.strictEqual(snapshot.workspaceFolders.length, 1);
		assert.deepStrictEqual(
			{
				id: snapshot.workspaceFolders[0]?.id,
				scheme: snapshot.workspaceFolders[0]?.scheme,
				fsPath: snapshot.workspaceFolders[0]?.fsPath,
			},
			{
				id: 'workspace-root:file:///workspace/original',
				scheme: 'file',
				fsPath: '/workspace/original',
			},
		);
		assert.strictEqual(
			snapshot.workspaceFolders[0]?.workspaceFolder,
			workspaceFolders[0],
		);
		assert.ok(Object.isFrozen(snapshot));
		assert.ok(Object.isFrozen(snapshot.workspaceFolders));
		assert.ok(Object.isFrozen(snapshot.workspaceFolders[0]));
	});

	test('실제 workspace path를 오류나 로그에 노출하지 않는다', () => {
		const privatePath = '/private/workspace/should-not-leak';
		const originalConsoleLog = console.log;
		const originalConsoleError = console.error;
		const loggedValues: unknown[] = [];
		console.log = (...values: unknown[]) => loggedValues.push(...values);
		console.error = (...values: unknown[]) => loggedValues.push(...values);

		try {
			const reader = {
				isTrusted: true,
				workspaceFolders: [{
					get uri(): never {
						throw new Error(privatePath);
					},
				}],
			};

			assert.throws(
				() => collectWorkspaceContext(reader),
				(error: Error) => !error.message.includes(privatePath),
			);
			assert.deepStrictEqual(loggedValues, []);
		} finally {
			console.log = originalConsoleLog;
			console.error = originalConsoleError;
		}
	});
});
