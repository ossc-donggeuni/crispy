import * as assert from 'assert';
import * as path from 'path';
import type { ExtensionToWebviewMessage } from '../messages';
import {
	getPanelLayoutStateFromMessage,
	PANEL_LAYOUT_STATE_MESSAGE,
	serializePanelLayoutState,
	type PanelLayoutState,
	type PanelLayoutStateMessage,
} from '../webview/panelState';

import * as vscode from 'vscode';

const COMMAND_ID = 'crispy.openCanvas';

interface CrispyExtensionModule {
	deactivate(): void;
	handleWebviewMessage(
		webview: Pick<vscode.Webview, 'postMessage'>,
		message: unknown,
	): Thenable<boolean> | undefined;
}

suite('Crispy Extension Host', () => {
	let extension: vscode.Extension<unknown>;
	let extensionModule: CrispyExtensionModule;

	suiteSetup(async () => {
		const installedExtension = vscode.extensions.all.find((candidate) =>
			candidate.packageJSON.name === 'crispy'
			&& candidate.packageJSON.contributes?.commands?.some(
				(command: { command?: string }) => command.command === COMMAND_ID,
			),
		);

		assert.ok(installedExtension, 'Crispy extension을 Extension Host에서 찾을 수 있어야 한다.');
		extension = installedExtension;
		await extension.activate();

		const mainPath = path.resolve(
			extension.extensionPath,
			extension.packageJSON.main as string,
		);
		extensionModule = require(mainPath) as CrispyExtensionModule;
	});

	setup(() => {
		extensionModule.deactivate();
	});

	teardown(() => {
		extensionModule.deactivate();
	});

	test('Extension을 활성화하고 manifest의 Canvas command를 등록한다', async () => {
		assert.strictEqual(extension.isActive, true);

		const manifestCommands = extension.packageJSON.contributes.commands as Array<{
			command: string;
		}>;
		assert.ok(
			manifestCommands.some(({ command }) => command === COMMAND_ID),
		);

		const registeredCommands = await vscode.commands.getCommands(true);
		assert.ok(registeredCommands.includes(COMMAND_ID));
	});

	test('Canvas command가 실제 설정으로 WebviewPanel을 최초 생성한다', async () => {
		const panel = await openCanvas();

		assert.strictEqual(panel.viewType, 'crispy.webview');
		assert.strictEqual(panel.title, 'Crispy');
		assert.strictEqual(panel.viewColumn, vscode.ViewColumn.One);
		assert.strictEqual(panel.webview.options.enableScripts, true);
		assert.deepStrictEqual(
			panel.webview.options.localResourceRoots?.map((uri) => uri.toString()),
			[vscode.Uri.joinPath(extension.extensionUri, 'dist', 'webview').toString()],
		);
	});

	test('열린 Canvas command를 다시 실행하면 같은 Panel을 재사용한다', async () => {
		const firstPanel = await openCanvas();
		const secondPanel = await openCanvas();

		assert.strictEqual(secondPanel, firstPanel);
	});

	test('Panel을 dispose한 뒤 Canvas command가 새 Panel을 생성한다', async () => {
		const disposedPanel = await openCanvas();
		await disposePanel(disposedPanel);

		const recreatedPanel = await openCanvas();

		assert.notStrictEqual(recreatedPanel, disposedPanel);
		assert.strictEqual(recreatedPanel.viewType, 'crispy.webview');
	});

	test('deactivate가 열린 Panel과 참조를 정리해 다음 생성에 영향을 주지 않는다', async () => {
		const deactivatedPanel = await openCanvas();
		const disposed = onceDisposed(deactivatedPanel);

		extensionModule.deactivate();
		await disposed;

		const recreatedPanel = await openCanvas();
		assert.notStrictEqual(recreatedPanel, deactivatedPanel);
	});

	test('deactivate가 저장된 Layout state를 초기화한다', async () => {
		const changedState: PanelLayoutState = {
			preferredDock: 'left',
			sideSize: 480,
			verticalSize: 260,
		};
		const initialPanel = await openCanvas();

		await sendLayoutState(initialPanel, changedState);
		await disposePanel(initialPanel);

		const restoredPanel = await openCanvas();
		assert.strictEqual(
			getSerializedInitialLayoutState(restoredPanel),
			serializePanelLayoutState(changedState),
		);

		await sendLayoutState(restoredPanel, changedState);
		const disposed = onceDisposed(restoredPanel);
		extensionModule.deactivate();
		await disposed;

		const panelAfterDeactivate = await openCanvas();
		assert.strictEqual(
			getSerializedInitialLayoutState(panelAfterDeactivate),
			serializePanelLayoutState(undefined),
		);
	});

	test('handleWebviewMessage responds to webview.ready with extension.ready', async () => {
		const postedMessages: ExtensionToWebviewMessage[] = [];
		const webview = {
			postMessage: (message: ExtensionToWebviewMessage) => {
				postedMessages.push(message);
				return Promise.resolve(true);
			},
		};

		const result = extensionModule.handleWebviewMessage(
			webview,
			{ type: 'webview.ready' },
		);

		assert.ok(result);
		assert.strictEqual(await result, true);
		assert.deepStrictEqual(postedMessages, [{ type: 'extension.ready' }]);
	});
});

async function openCanvas(): Promise<vscode.WebviewPanel> {
	const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>(COMMAND_ID);
	assert.ok(panel, `${COMMAND_ID} command가 생성하거나 재사용한 Panel을 반환해야 한다.`);
	return panel;
}

function onceDisposed(panel: vscode.WebviewPanel): Promise<void> {
	return new Promise((resolve) => {
		panel.onDidDispose(resolve);
	});
}

async function disposePanel(panel: vscode.WebviewPanel): Promise<void> {
	const disposed = onceDisposed(panel);
	panel.dispose();
	await disposed;
}

async function sendLayoutState(
	panel: vscode.WebviewPanel,
	state: PanelLayoutState,
): Promise<void> {
	const message: PanelLayoutStateMessage = {
		type: PANEL_LAYOUT_STATE_MESSAGE,
		state,
	};
	const received = onceWebviewMessage(
		panel.webview,
		(candidate) => getPanelLayoutStateFromMessage(candidate) !== undefined,
	);

	panel.webview.html = createMessagePostingHtml(message);

	assert.deepStrictEqual(
		getPanelLayoutStateFromMessage(await received),
		state,
	);
}

function onceWebviewMessage(
	webview: vscode.Webview,
	predicate: (message: unknown) => boolean,
): Promise<unknown> {
	return new Promise((resolve) => {
		const subscription = webview.onDidReceiveMessage((message: unknown) => {
			if (!predicate(message)) {
				return;
			}

			subscription.dispose();
			resolve(message);
		});
	});
}

function createMessagePostingHtml(message: PanelLayoutStateMessage): string {
	const serializedMessage = JSON.stringify(message).replaceAll('<', '\\u003c');

	return `<!DOCTYPE html>
		<html lang="en">
		<body>
			<script>
				acquireVsCodeApi().postMessage(${serializedMessage});
			</script>
		</body>
		</html>`;
}

function getSerializedInitialLayoutState(panel: vscode.WebviewPanel): string {
	const match = panel.webview.html.match(/data-layout-state="([^"]*)"/);
	assert.ok(match, 'Webview 초기 HTML에 serialized Layout state가 있어야 한다.');
	return match[1];
}
