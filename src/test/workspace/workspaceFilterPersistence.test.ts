import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	loadOrCreateWorkspaceFilter,
	loadOrCreateWorkspaceFilters,
	type WorkspaceRootFilter,
} from '../../workspace/workspaceFilterPersistence';
import type { WorkspaceFilter } from '../../workspace/workspaceFilter';

const extensionUri = vscode.Uri.file('/extension');
const defaultFilter: WorkspaceFilter = {
	version: 1,
	rules: [
		{ kind: 'folder', pattern: 'node_modules' },
		{ kind: 'file', pattern: '.DS_Store' },
	],
};

suite('Workspace Filter Persistence', () => {
	test('기존 filter.json을 파싱해 로드한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const existingFilter: WorkspaceFilter = {
			version: 1,
			rules: [{ kind: 'folder', pattern: 'generated' }],
		};
		const fake = createFakeFileSystem();
		fake.setJson(getFilterUri(rootUri), existingFilter);

		const loaded = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.deepStrictEqual(loaded, existingFilter);
		assert.notStrictEqual(loaded, existingFilter);
		assert.deepStrictEqual(fake.createDirectoryCalls, []);
		assert.deepStrictEqual(fake.writeFileCalls, []);
	});

	test('filter.json이 없으면 기본 Filter를 생성하고 반환한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const fake = createFakeFileSystem();
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.deepStrictEqual(loaded, defaultFilter);
		assert.deepStrictEqual(fake.getJson(getFilterUri(rootUri)), defaultFilter);
		assert.deepStrictEqual(
			fake.createDirectoryCalls.map((uri) => uri.toString()),
			[getCrispyDirectoryUri(rootUri).toString()],
		);
		assert.deepStrictEqual(
			fake.writeFileCalls.map(({ uri }) => uri.toString()),
			[getFilterUri(rootUri).toString()],
		);
	});

	test('.crispy가 없어도 Directory를 만든 뒤 Filter를 생성한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/new');
		const fake = createFakeFileSystem();
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.deepStrictEqual(
			fake.createDirectoryCalls.map((uri) => uri.toString()),
			[getCrispyDirectoryUri(rootUri).toString()],
		);
		assert.deepStrictEqual(fake.getJson(getFilterUri(rootUri)), defaultFilter);
	});

	test('state.json만 있는 기존 Workspace에도 filter.json을 생성한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/existing');
		const state = { version: 1, hiddenNodeIds: {} };
		const fake = createFakeFileSystem();
		fake.setJson(getStateUri(rootUri), state);
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.deepStrictEqual(loaded, defaultFilter);
		assert.deepStrictEqual(fake.getJson(getFilterUri(rootUri)), defaultFilter);
		assert.deepStrictEqual(fake.getJson(getStateUri(rootUri)), state);
	});

	test('기존 filter.json을 기본값으로 덮어쓰지 않는다', async () => {
		const rootUri = vscode.Uri.file('/workspace/custom');
		const existingFilter: WorkspaceFilter = {
			version: 1,
			rules: [{ kind: 'file', pattern: '*.generated' }],
		};
		const fake = createFakeFileSystem();
		fake.setJson(getFilterUri(rootUri), existingFilter);
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		assert.deepStrictEqual(await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		), existingFilter);
		assert.deepStrictEqual(fake.getJson(getFilterUri(rootUri)), existingFilter);
		assert.deepStrictEqual(fake.writeFileCalls, []);
	});

	test('생성된 Filter를 다음 로드에서 그대로 사용한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/reopen');
		const fake = createFakeFileSystem();
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const created = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);
		fake.setJson(getDefaultFilterUri(), {
			version: 1,
			rules: [{ kind: 'folder', pattern: 'changed-default' }],
		});
		const reopened = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.deepStrictEqual(created, defaultFilter);
		assert.deepStrictEqual(reopened, defaultFilter);
		assert.strictEqual(fake.writeFileCalls.length, 1);
	});

	test('invalid 기존 Filter를 기본값으로 덮어쓰지 않는다', async () => {
		const rootUri = vscode.Uri.file('/workspace/invalid');
		const invalidFilter = { version: 2, rules: [] };
		const fake = createFakeFileSystem();
		fake.setJson(getFilterUri(rootUri), invalidFilter);
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.strictEqual(loaded, undefined);
		assert.deepStrictEqual(fake.getJson(getFilterUri(rootUri)), invalidFilter);
		assert.deepStrictEqual(fake.createDirectoryCalls, []);
		assert.deepStrictEqual(fake.writeFileCalls, []);
	});

	test('JSON parse에 실패한 기존 Filter를 기본값으로 덮어쓰지 않는다', async () => {
		const rootUri = vscode.Uri.file('/workspace/malformed');
		const fake = createFakeFileSystem();
		fake.setText(getFilterUri(rootUri), '{');
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.strictEqual(loaded, undefined);
		assert.strictEqual(fake.getText(getFilterUri(rootUri)), '{');
		assert.deepStrictEqual(fake.createDirectoryCalls, []);
		assert.deepStrictEqual(fake.writeFileCalls, []);
	});

	test('Multi-root별로 기존 Filter 로드와 기본 초기화를 독립 수행한다', async () => {
		const frontendUri = vscode.Uri.file('/workspace/frontend');
		const backendUri = vscode.Uri.file('/workspace/backend');
		const frontendFilter: WorkspaceFilter = {
			version: 1,
			rules: [{ kind: 'folder', pattern: '.frontend-cache' }],
		};
		const fake = createFakeFileSystem();
		fake.setJson(getFilterUri(frontendUri), frontendFilter);
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilters(
			[frontendUri, backendUri],
			extensionUri,
			fake.fileSystem,
		);

		assert.deepStrictEqual(getRootFilter(loaded, frontendUri), frontendFilter);
		assert.deepStrictEqual(getRootFilter(loaded, backendUri), defaultFilter);
		assert.deepStrictEqual(fake.getJson(getFilterUri(frontendUri)), frontendFilter);
		assert.deepStrictEqual(fake.getJson(getFilterUri(backendUri)), defaultFilter);
		assert.deepStrictEqual(
			fake.writeFileCalls.map(({ uri }) => uri.toString()),
			[getFilterUri(backendUri).toString()],
		);
	});

	test('한 Root의 read 실패가 다른 Root의 초기화에 영향 주지 않는다', async () => {
		const failedUri = vscode.Uri.file('/workspace/read-failed');
		const healthyUri = vscode.Uri.file('/workspace/healthy');
		const fake = createFakeFileSystem({
			readErrors: new Set([getFilterUri(failedUri).toString()]),
		});
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilters(
			[failedUri, healthyUri],
			extensionUri,
			fake.fileSystem,
		);

		assert.strictEqual(getRootFilter(loaded, failedUri), undefined);
		assert.deepStrictEqual(getRootFilter(loaded, healthyUri), defaultFilter);
		assert.strictEqual(fake.getJson(getFilterUri(failedUri)), undefined);
		assert.deepStrictEqual(fake.getJson(getFilterUri(healthyUri)), defaultFilter);
	});

	test('한 Root의 write 실패가 다른 Root의 초기화에 영향 주지 않는다', async () => {
		const failedUri = vscode.Uri.file('/workspace/write-failed');
		const healthyUri = vscode.Uri.file('/workspace/healthy');
		const fake = createFakeFileSystem({
			writeErrors: new Set([getFilterUri(failedUri).toString()]),
		});
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilters(
			[failedUri, healthyUri],
			extensionUri,
			fake.fileSystem,
		);

		assert.strictEqual(getRootFilter(loaded, failedUri), undefined);
		assert.deepStrictEqual(getRootFilter(loaded, healthyUri), defaultFilter);
		assert.strictEqual(fake.getJson(getFilterUri(failedUri)), undefined);
		assert.deepStrictEqual(fake.getJson(getFilterUri(healthyUri)), defaultFilter);
	});

	test('Directory 생성 실패를 Runtime 오류로 전파하지 않는다', async () => {
		const rootUri = vscode.Uri.file('/workspace/create-failed');
		const fake = createFakeFileSystem({
			createDirectoryErrors: new Set([
				getCrispyDirectoryUri(rootUri).toString(),
			]),
		});
		fake.setJson(getDefaultFilterUri(), defaultFilter);

		const loaded = await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		);

		assert.strictEqual(loaded, undefined);
		assert.deepStrictEqual(fake.writeFileCalls, []);
	});

	test('기본 Filter read 실패를 Runtime 오류로 전파하지 않는다', async () => {
		const rootUri = vscode.Uri.file('/workspace/default-failed');
		const fake = createFakeFileSystem();

		assert.strictEqual(await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fake.fileSystem,
		), undefined);
		assert.deepStrictEqual(fake.createDirectoryCalls, []);
		assert.deepStrictEqual(fake.writeFileCalls, []);
	});
});

interface FakeFileSystemOptions {
	readonly readErrors?: ReadonlySet<string>;
	readonly createDirectoryErrors?: ReadonlySet<string>;
	readonly writeErrors?: ReadonlySet<string>;
}

function createFakeFileSystem(options: FakeFileSystemOptions = {}) {
	const files = new Map<string, Uint8Array>();
	const createDirectoryCalls: vscode.Uri[] = [];
	const writeFileCalls: Array<{
		readonly uri: vscode.Uri;
		readonly content: Uint8Array;
	}> = [];
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

			if (options.createDirectoryErrors?.has(uri.toString())) {
				throw new Error('create directory failed');
			}
		},
		async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
			writeFileCalls.push({ uri, content: content.slice() });

			if (options.writeErrors?.has(uri.toString())) {
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
		getText(uri: vscode.Uri): string | undefined {
			const content = files.get(uri.toString());

			return content ? new TextDecoder().decode(content) : undefined;
		},
	};
}

function getCrispyDirectoryUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(rootUri, '.crispy');
}

function getFilterUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(getCrispyDirectoryUri(rootUri), 'filter.json');
}

function getStateUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(getCrispyDirectoryUri(rootUri), 'state.json');
}

function getDefaultFilterUri(): vscode.Uri {
	return vscode.Uri.joinPath(
		extensionUri,
		'resources',
		'defaultWorkspaceFilter.json',
	);
}

function getRootFilter(
	rootFilters: readonly WorkspaceRootFilter[],
	rootUri: vscode.Uri,
): WorkspaceFilter | undefined {
	const rootFilter = rootFilters.find(
		(candidate) => candidate.rootUri.toString() === rootUri.toString(),
	);

	assert.ok(rootFilter);
	return rootFilter.filter;
}
