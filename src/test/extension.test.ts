import * as assert from 'assert';
import * as vscode from 'vscode';
import { handleWebviewMessage } from '../extension';
import {
	createSelectionChangedMessage,
	isExtensionToWebviewMessage,
	isWebviewToExtensionMessage,
} from '../model/webviewMessage';

const commandId = 'crispy.openGraph';
const webviewType = 'crispyGraph';

function getCrispyTabs(): vscode.Tab[] {
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

async function waitForCrispyTabCount(expectedCount: number): Promise<vscode.Tab[]> {
	const timeoutAt = Date.now() + 2_000;
	do {
		const tabs = getCrispyTabs();
		if (tabs.length === expectedCount) {
			return tabs;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	} while (Date.now() < timeoutAt);

	return getCrispyTabs();
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

	test('registers the graph command', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes(commandId));
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
	});

	test('reuses, closes, and reopens the Crispy Webview panel', async () => {
		await vscode.commands.executeCommand(commandId);
		await vscode.commands.executeCommand(commandId);

		const initialTabs = await waitForCrispyTabCount(1);
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
		assert.strictEqual((await waitForCrispyTabCount(0)).length, 0);

		await vscode.commands.executeCommand(commandId);
		const reopenedTabs = await waitForCrispyTabCount(1);
		assert.strictEqual(reopenedTabs.length, 1);
		await vscode.window.tabGroups.close(reopenedTabs[0]);
	});
});
