import * as assert from 'assert';
import {
	AGENT_CONFIRM_ACCEPT_LABEL,
	AGENT_CONFIRM_CANCEL_LABEL,
	createAgentConfirmDialog,
	formatTabCloseConfirmMessage,
} from '../../agent/UI/agentConfirmDialog';
import {
	FakeAgentElement,
	createFakeAgentUiDependencies,
} from './support/fakeAgentUiDom';

/**
 * 확인 다이얼로그를 DOM 대역 위에서 만든다.
 *
 * @returns 다이얼로그와 host 요소
 */
function createDialogFixture() {
	const host = new FakeAgentElement();
	const dialog = createAgentConfirmDialog(
		host.asHtmlElement(),
		createFakeAgentUiDependencies(),
	);

	return { host, dialog };
}

suite('Agent Confirm Dialog', () => {
	test('초기 상태에서는 화면에 표시되지 않는다', () => {
		const { host } = createDialogFixture();

		assert.strictEqual(host.hidden, true);
		assert.strictEqual(host.children.length, 0);
	});

	test('확인 요청은 문구와 두 개의 선택 버튼을 표시한다', () => {
		const { host, dialog } = createDialogFixture();

		void dialog.confirm(formatTabCloseConfirmMessage('Codex #1'));

		assert.strictEqual(host.hidden, false);
		assert.strictEqual(host.getAttribute('role'), 'alertdialog');
		assert.strictEqual(
			host.find('agent-confirm-message')?.textContent,
			'Close Codex #1?',
		);
		assert.strictEqual(
			host.find('agent-confirm-accept')?.textContent,
			AGENT_CONFIRM_ACCEPT_LABEL,
		);
		assert.strictEqual(
			host.find('agent-confirm-cancel')?.textContent,
			AGENT_CONFIRM_CANCEL_LABEL,
		);
	});

	test('확인 버튼은 true를, 취소 버튼은 false를 반환하고 다이얼로그를 닫는다', async () => {
		const { host, dialog } = createDialogFixture();

		const accepted = dialog.confirm('Close Codex #1?');
		host.find('agent-confirm-accept')?.click();
		assert.strictEqual(await accepted, true);
		assert.strictEqual(host.hidden, true);
		assert.strictEqual(host.children.length, 0);

		const cancelled = dialog.confirm('Close Codex #2?');
		host.find('agent-confirm-cancel')?.click();
		assert.strictEqual(await cancelled, false);
		assert.strictEqual(host.hidden, true);
	});

	test('이미 열려 있는 동안의 추가 요청은 취소로 처리한다', async () => {
		const { host, dialog } = createDialogFixture();

		const first = dialog.confirm('Close Codex #1?');
		const second = dialog.confirm('Close Codex #2?');

		assert.strictEqual(await second, false);
		assert.strictEqual(
			host.find('agent-confirm-message')?.textContent,
			'Close Codex #1?',
		);

		host.find('agent-confirm-accept')?.click();
		assert.strictEqual(await first, true);
	});

	test('dispose는 대기 중인 요청을 취소로 마무리한다', async () => {
		const { host, dialog } = createDialogFixture();

		const pending = dialog.confirm('Close Codex #1?');
		dialog.dispose();

		assert.strictEqual(await pending, false);
		assert.strictEqual(host.hidden, true);
	});
});
