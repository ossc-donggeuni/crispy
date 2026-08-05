import * as assert from 'assert';
import * as vscode from 'vscode';
import { handleWebviewMessage } from '../extension';
import {
	createSelectionChangedMessage,
	isExtensionToWebviewMessage,
	isWebviewToExtensionMessage,
} from '../model/webviewMessage';

const graphCommandId = 'crispy.openGraph';
const chatCommandId = 'crispy.openChat';
const openGraphAndChatCommandId = 'crispy.openGraphAndChat';
const graphWebviewType = 'crispyGraph';
const chatWebviewType = 'crispyChat';

function getWebviewTabs(webviewType: string): vscode.Tab[] {
	return vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter(
			(tab) =>
				tab.input instanceof vscode.TabInputWebview
				&& (
					tab.input.viewType === webviewType
					|| tab.input.viewType === `mainThreadWebview-${webviewType}`
				),
		);
}

async function waitForWebviewTabCount(
	webviewType: string,
	expectedCount: number,
): Promise<vscode.Tab[]> {
	const timeoutAt = Date.now() + 2_000;
	do {
		const tabs = getWebviewTabs(webviewType);
		if (tabs.length === expectedCount) {
			return tabs;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	} while (Date.now() < timeoutAt);

	return getWebviewTabs(webviewType);
}

suite('Crispy Extension', function () {
	this.timeout(10_000);

	suiteSetup(async () => {
		const extension = vscode.extensions.all.find(
			(candidate) => candidate.packageJSON.name === 'crispy',
		);
		assert.ok(extension, 'The Crispy development extension was not loaded.');
		await extension.activate();
	});

	test('registers the Graph and Chat commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes(graphCommandId));
		assert.ok(commands.includes(chatCommandId));
		assert.ok(commands.includes(openGraphAndChatCommandId));
	});

	test('uses the selection message contract and writes Output Channel logs', () => {
		const selectedMessage = createSelectionChangedMessage({
			selectedNodeId: 'file:components/ProfileIntro.tsx',
		});
		const clearedMessage = createSelectionChangedMessage({});

		assert.deepStrictEqual(selectedMessage, {
			type: 'selectionChanged',
			payload: {
				selectedNodeId: 'file:components/ProfileIntro.tsx',
			},
		});
		assert.deepStrictEqual(clearedMessage, {
			type: 'selectionChanged',
			payload: {},
		});

		const lines: string[] = [];
		const outputWriter = {
			appendLine: (value: string) => lines.push(value),
		};

		handleWebviewMessage(selectedMessage, outputWriter);
		handleWebviewMessage(clearedMessage, outputWriter);
		handleWebviewMessage(
			{
				type: 'selectionChanged',
				selectedNodeId: 'file:legacy-shape.ts',
			},
			outputWriter,
		);

		assert.deepStrictEqual(lines, [
			'[Crispy] Selected node: file:components/ProfileIntro.tsx',
			'[Crispy] Selection cleared',
		]);
	});

	test('validates both directions of the Webview message contract', () => {
		assert.ok(isWebviewToExtensionMessage({
			type: 'webviewReady',
		}));
		assert.ok(isWebviewToExtensionMessage({
			type: 'openWorkspaceFolder',
		}));
		assert.ok(isWebviewToExtensionMessage({
			type: 'selectionChanged',
			payload: {
				selectedNodeId: 'file:src/extension.ts',
			},
		}));
		assert.ok(!isWebviewToExtensionMessage({
			type: 'selectionChanged',
			payload: {
				selectedNodeId: 42,
			},
		}));
		assert.ok(!isWebviewToExtensionMessage({
			type: 'unknownMessage',
		}));
		assert.ok(isWebviewToExtensionMessage({
			type: 'fileAnalysisRequested',
			payload: {
				requestId: 'request-1',
				fileNodeId: 'file:src/extension.ts',
				relativePath: 'src/extension.ts',
			},
		}));
		assert.ok(!isWebviewToExtensionMessage({
			type: 'fileAnalysisRequested',
			payload: {
				requestId: 'request-1',
				fileNodeId: 'directory:src',
				relativePath: 'src',
			},
		}));
		assert.ok(!isWebviewToExtensionMessage({
			type: 'fileAnalysisRequested',
			payload: {
				requestId: 'request-1',
				fileNodeId: 'file:src/extension.ts',
				relativePath: '',
			},
		}));

		const workspaceLoadedMessage = {
			type: 'workspaceLoaded',
			payload: {
				workspaceName: 'test-workspace',
				nodes: [
					{
						id: 'project:test-workspace',
						type: 'project',
						name: 'test-workspace',
						relativePath: '',
						childrenIds: [],
					},
				],
			},
		};
		assert.ok(isExtensionToWebviewMessage(workspaceLoadedMessage));
		assert.ok(!isExtensionToWebviewMessage({
			...workspaceLoadedMessage,
			payload: {
				...workspaceLoadedMessage.payload,
				nodes: [
					{
						id: 'project:test-workspace',
						type: 'project',
						name: 'test-workspace',
						childrenIds: 'not-an-array',
					},
				],
			},
		}));
		assert.ok(!isExtensionToWebviewMessage({
			type: 'workspaceError',
			payload: {
				message: 42,
			},
		}));

		const fileAnalysisResultMessage = {
			type: 'fileAnalysisResult',
			payload: {
				requestId: 'request-1',
				fileNodeId: 'file:src/extension.ts',
				status: 'ready',
				symbolNodes: [
					{
						id: 'function:src/extension.ts:activate:10',
						type: 'symbol',
						name: 'activate',
						relativePath: 'src/extension.ts',
						parentId: 'file:src/extension.ts',
						childrenIds: [],
					},
				],
				symbolMetadata: [
					{
						nodeId: 'function:src/extension.ts:activate:10',
						kind: 'function',
						startLine: 10,
					},
				],
			},
		};
		assert.ok(isExtensionToWebviewMessage(fileAnalysisResultMessage));
		assert.ok(!isExtensionToWebviewMessage({
			...fileAnalysisResultMessage,
			payload: {
				...fileAnalysisResultMessage.payload,
				status: 'loading',
			},
		}));
	});

	test('reuses, closes, and reopens the Crispy Webview panel', async () => {
		await vscode.commands.executeCommand(graphCommandId);
		await vscode.commands.executeCommand(graphCommandId);

		const initialTabs = await waitForWebviewTabCount(graphWebviewType, 1);
		assert.strictEqual(
			initialTabs.length,
			1,
			`Open tabs: ${JSON.stringify(
				vscode.window.tabGroups.all.flatMap((group) =>
					group.tabs.map((tab) => ({
						label: tab.label,
						viewType: tab.input instanceof vscode.TabInputWebview
							? tab.input.viewType
							: undefined,
					})),
				),
			)}`,
		);
		assert.strictEqual(initialTabs[0].label, 'Crispy');

		await vscode.window.tabGroups.close(initialTabs[0]);
		assert.strictEqual(
			(await waitForWebviewTabCount(graphWebviewType, 0)).length,
			0,
		);

		await vscode.commands.executeCommand(graphCommandId);
		const reopenedTabs = await waitForWebviewTabCount(graphWebviewType, 1);
		assert.strictEqual(reopenedTabs.length, 1);
		await vscode.window.tabGroups.close(reopenedTabs[0]);
	});

	test('reuses the independent Chat Webview panel', async () => {
		await vscode.commands.executeCommand(chatCommandId);
		await vscode.commands.executeCommand(chatCommandId);

		const chatTabs = await waitForWebviewTabCount(chatWebviewType, 1);
		assert.strictEqual(chatTabs.length, 1);
		assert.strictEqual(chatTabs[0].label, 'Crispy Chat');
		await vscode.window.tabGroups.close(chatTabs[0]);
		assert.strictEqual(
			(await waitForWebviewTabCount(chatWebviewType, 0)).length,
			0,
		);
	});

	test('opens Graph and Chat as separate Webview panels', async () => {
		await vscode.commands.executeCommand(openGraphAndChatCommandId);

		const graphTabs = await waitForWebviewTabCount(graphWebviewType, 1);
		const chatTabs = await waitForWebviewTabCount(chatWebviewType, 1);
		assert.strictEqual(graphTabs.length, 1);
		assert.strictEqual(chatTabs.length, 1);
		assert.notStrictEqual(
			vscode.window.tabGroups.all.find((group) => group.tabs.includes(graphTabs[0])),
			vscode.window.tabGroups.all.find((group) => group.tabs.includes(chatTabs[0])),
		);
		await vscode.window.tabGroups.close([...graphTabs, ...chatTabs]);
	});
});
