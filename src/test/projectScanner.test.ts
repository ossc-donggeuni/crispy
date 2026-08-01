import * as assert from 'assert';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { scanWorkspaceFolder } from '../workspace/projectScanner';

suite('Workspace Scanner', function () {
	this.timeout(10_000);

	let workspaceUri: vscode.Uri;

	suiteSetup(async () => {
		workspaceUri = vscode.Uri.file(
			path.join(os.tmpdir(), `crispy-scanner-${crypto.randomUUID()}`),
		);

		await Promise.all([
			vscode.workspace.fs.createDirectory(
				vscode.Uri.joinPath(workspaceUri, 'assets'),
			),
			vscode.workspace.fs.createDirectory(
				vscode.Uri.joinPath(workspaceUri, 'src', 'components'),
			),
			vscode.workspace.fs.createDirectory(
				vscode.Uri.joinPath(workspaceUri, 'node_modules', 'package'),
			),
			vscode.workspace.fs.createDirectory(
				vscode.Uri.joinPath(workspaceUri, '.git', 'objects'),
			),
			vscode.workspace.fs.createDirectory(
				vscode.Uri.joinPath(workspaceUri, 'dist'),
			),
		]);

		const encoder = new TextEncoder();
		await Promise.all([
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(workspaceUri, 'package.json'),
				encoder.encode('{}'),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(workspaceUri, '.DS_Store'),
				encoder.encode('excluded'),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(workspaceUri, 'src', 'Alpha.ts'),
				encoder.encode(''),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(workspaceUri, 'src', 'beta.ts'),
				encoder.encode(''),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(workspaceUri, 'src', 'extension.ts'),
				encoder.encode(''),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(
					workspaceUri,
					'src',
					'components',
					'Button.ts',
				),
				encoder.encode(''),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(
					workspaceUri,
					'node_modules',
					'package',
					'index.js',
				),
				encoder.encode(''),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(workspaceUri, '.git', 'config'),
				encoder.encode(''),
			),
			vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(workspaceUri, 'dist', 'extension.js'),
				encoder.encode(''),
			),
		]);
	});

	suiteTeardown(async () => {
		await vscode.workspace.fs.delete(workspaceUri, {
			recursive: true,
			useTrash: false,
		});
	});

	test('creates linked, sorted ProjectNode entries and excludes ignored names', async () => {
		const result = await scanWorkspaceFolder({
			uri: workspaceUri,
			name: 'test-workspace',
			index: 0,
		});
		const nodesById = new Map(result.nodes.map((node) => [node.id, node]));

		assert.strictEqual(result.workspaceName, 'test-workspace');
		assert.strictEqual(result.skippedEntries, 4);
		assert.deepStrictEqual(nodesById.get('project:test-workspace'), {
			id: 'project:test-workspace',
			type: 'project',
			name: 'test-workspace',
			relativePath: '',
			childrenIds: [
				'directory:assets',
				'directory:src',
				'file:package.json',
			],
		});
		assert.deepStrictEqual(
			nodesById.get('directory:src')?.childrenIds,
			[
				'directory:src/components',
				'file:src/Alpha.ts',
				'file:src/beta.ts',
				'file:src/extension.ts',
			],
		);
		assert.deepStrictEqual(nodesById.get('directory:src/components'), {
			id: 'directory:src/components',
			type: 'directory',
			name: 'components',
			relativePath: 'src/components',
			parentId: 'directory:src',
			childrenIds: [
				'file:src/components/Button.ts',
			],
		});
		assert.deepStrictEqual(nodesById.get('file:src/extension.ts'), {
			id: 'file:src/extension.ts',
			type: 'file',
			name: 'extension.ts',
			relativePath: 'src/extension.ts',
			parentId: 'directory:src',
			childrenIds: [],
		});

		for (const node of result.nodes) {
			for (const childId of node.childrenIds) {
				const child = nodesById.get(childId);
				assert.ok(child, `${node.id} links to missing ${childId}`);
				assert.strictEqual(child.parentId, node.id);
			}
		}

		assert.ok(!nodesById.has('directory:node_modules'));
		assert.ok(!nodesById.has('directory:.git'));
		assert.ok(!nodesById.has('directory:dist'));
		assert.ok(!nodesById.has('file:.DS_Store'));
	});

	test('scans the actual extension repository without generated directories', async () => {
		const repositoryUri = vscode.Uri.file(
			path.resolve(__dirname, '..', '..'),
		);
		const result = await scanWorkspaceFolder({
			uri: repositoryUri,
			name: 'crispy',
			index: 0,
		});
		const nodeIds = new Set(result.nodes.map((node) => node.id));

		assert.ok(nodeIds.has('project:crispy'));
		assert.ok(nodeIds.has('directory:src'));
		assert.ok(nodeIds.has('directory:src/webview'));
		assert.ok(nodeIds.has('file:package.json'));
		assert.ok(nodeIds.has('file:src/extension.ts'));
		assert.ok(nodeIds.has('file:src/webview/main.ts'));
		assert.ok(!nodeIds.has('directory:.git'));
		assert.ok(!nodeIds.has('directory:node_modules'));
		assert.ok(!nodeIds.has('directory:dist'));
		assert.ok(!nodeIds.has('directory:out'));
	});
});
