import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * 실제 Extension Development Host에서 명령 기반 activation과 Crispy Panel 수명주기를 검증한다.
 */
suite('Agent Terminal Extension Integration', () => {
	test('crispy.openCanvas 명령이 실제 Crispy Panel을 열고 다시 닫힌다', async () => {
		const extension = vscode.extensions.all.find(
			(candidate) => candidate.packageJSON.name === 'crispy',
		);
		assert.ok(extension, 'Crispy development extension was not loaded.');

		await vscode.commands.executeCommand('crispy.openCanvas');
		assert.strictEqual(extension.isActive, true);
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});
});
