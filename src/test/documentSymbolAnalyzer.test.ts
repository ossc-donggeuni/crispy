import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	analyzeDocumentSymbols,
	normalizeDocumentSymbols,
	normalizeSymbolInformation,
	validateFileAnalysisPath,
} from '../workspace/documentSymbolAnalyzer';

function createRange(line: number, character = 0): vscode.Range {
	return new vscode.Range(
		new vscode.Position(line, character),
		new vscode.Position(line, character + 1),
	);
}

function createFullRange(line: number): vscode.Range {
	return new vscode.Range(
		new vscode.Position(line, 0),
		new vscode.Position(line + 1, 0),
	);
}

suite('Document Symbol Analyzer', function () {
	this.timeout(20_000);

	test('normalizes supported top-level DocumentSymbols in source order', () => {
		const exampleClass = new vscode.DocumentSymbol(
			'ExampleClass',
			'class detail',
			vscode.SymbolKind.Class,
			createFullRange(4),
			createRange(4, 6),
		);
		exampleClass.children.push(
			new vscode.DocumentSymbol(
				'nestedMethod',
				'',
				vscode.SymbolKind.Method,
				createFullRange(5),
				createRange(5, 2),
			),
		);

		const normalized = normalizeDocumentSymbols(
			[
				new vscode.DocumentSymbol(
					'route:handler',
					'',
					vscode.SymbolKind.Function,
					createFullRange(20),
					createRange(20, 3),
				),
				new vscode.DocumentSymbol(
					'run',
					'duplicate later character',
					vscode.SymbolKind.Function,
					createFullRange(12),
					createRange(12, 9),
				),
				new vscode.DocumentSymbol(
					'ignoredValue',
					'',
					vscode.SymbolKind.Variable,
					createFullRange(1),
					createRange(1),
				),
				exampleClass,
				new vscode.DocumentSymbol(
					'run',
					'kept earlier character',
					vscode.SymbolKind.Function,
					createFullRange(12),
					createRange(12, 2),
				),
			],
			'file:src/example.ts',
			'src/example.ts',
		);

		assert.deepStrictEqual(
			normalized.symbolNodes.map((node) => node.id),
			[
				'function:src/example.ts:ExampleClass:5',
				'function:src/example.ts:run:13',
				'function:src/example.ts:route%3Ahandler:21',
			],
		);
		assert.deepStrictEqual(
			normalized.symbolNodes.map((node) => node.name),
			[
				'ExampleClass',
				'run',
				'route:handler',
			],
		);
		assert.ok(
			!normalized.symbolNodes.some((node) => node.name === 'nestedMethod'),
		);
		assert.ok(
			!normalized.symbolNodes.some((node) => node.name === 'ignoredValue'),
		);
		assert.deepStrictEqual(normalized.symbolMetadata, [
			{
				nodeId: 'function:src/example.ts:ExampleClass:5',
				kind: 'class',
				startLine: 5,
				detail: 'class detail',
			},
			{
				nodeId: 'function:src/example.ts:run:13',
				kind: 'function',
				startLine: 13,
				detail: 'kept earlier character',
			},
			{
				nodeId: 'function:src/example.ts:route%3Ahandler:21',
				kind: 'function',
				startLine: 21,
			},
		]);
	});

	test('normalizes top-level SymbolInformation for the requested file only', () => {
		const fileUri = vscode.Uri.file('/workspace/src/example.ts');
		const otherFileUri = vscode.Uri.file('/workspace/src/other.ts');
		const normalized = normalizeSymbolInformation(
			[
				new vscode.SymbolInformation(
					'nestedMethod',
					vscode.SymbolKind.Method,
					'ExampleClass',
					new vscode.Location(fileUri, createRange(8, 2)),
				),
				new vscode.SymbolInformation(
					'topFunction',
					vscode.SymbolKind.Function,
					'',
					new vscode.Location(fileUri, createRange(3, 4)),
				),
				new vscode.SymbolInformation(
					'otherFunction',
					vscode.SymbolKind.Function,
					'',
					new vscode.Location(otherFileUri, createRange(1)),
				),
				new vscode.SymbolInformation(
					'ignoredConstant',
					vscode.SymbolKind.Constant,
					'',
					new vscode.Location(fileUri, createRange(2)),
				),
			],
			fileUri,
			'file:src/example.ts',
			'src/example.ts',
		);

		assert.deepStrictEqual(
			normalized.symbolNodes.map((node) => node.name),
			['topFunction'],
		);
		assert.deepStrictEqual(normalized.symbolMetadata, [
			{
				nodeId: 'function:src/example.ts:topFunction:4',
				kind: 'function',
				startLine: 4,
			},
		]);
	});

	test('rejects absolute, escaping, and mismatched file paths', () => {
		assert.deepStrictEqual(
			validateFileAnalysisPath(
				'file:src/extension.ts',
				'src/extension.ts',
			),
			['src', 'extension.ts'],
		);
		assert.throws(() => validateFileAnalysisPath(
			'file:../outside.ts',
			'../outside.ts',
		));
		assert.throws(() => validateFileAnalysisPath(
			'file:/tmp/outside.ts',
			'/tmp/outside.ts',
		));
		assert.throws(() => validateFileAnalysisPath(
			'file:src/other.ts',
			'src/extension.ts',
		));
		assert.throws(() => validateFileAnalysisPath(
			'file:src\\extension.ts',
			'src\\extension.ts',
		));
	});

	test('analyzes the actual TypeScript extension without changing the editor', async () => {
		const typeScriptExtension = vscode.extensions.getExtension(
			'vscode.typescript-language-features',
		);
		assert.ok(typeScriptExtension);
		await typeScriptExtension.activate();

		const workspaceUri = vscode.Uri.file(
			path.resolve(__dirname, '..', '..'),
		);
		const result = await analyzeDocumentSymbols(
			{
				uri: workspaceUri,
				name: 'crispy',
				index: 0,
			},
			'file:src/extension.ts',
			'src/extension.ts',
		);

		assert.strictEqual(result.status, 'ready');
		const activateNode = result.symbolNodes.find(
			(node) => node.name === 'activate',
		);
		assert.ok(activateNode, 'Expected the TypeScript provider to return activate.');
		const activateMetadata = result.symbolMetadata.find(
			(metadata) => metadata.nodeId === activateNode.id,
		);
		assert.ok(activateMetadata);

		const document = await vscode.workspace.openTextDocument(
			vscode.Uri.joinPath(workspaceUri, 'src', 'extension.ts'),
		);
		assert.match(
			document.lineAt(activateMetadata.startLine - 1).text,
			/export function activate/,
		);
	});
});
