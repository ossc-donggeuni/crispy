import * as assert from 'node:assert';

import {
	CodexAppServerClient,
	codexProtocolCliVersion,
	createCodexClientInfo,
} from '../appServerClient';

suite('Codex app-server 실제 연결', function () {
	this.timeout(20_000);

	test('0.146.0 stdio app-server와 initialize handshake 후 정상 종료한다', async () => {
		const logs: string[] = [];
		const client = new CodexAppServerClient({
			clientInfo: createCodexClientInfo('crispy.integration-test', {
				name: 'crispy-integration-test',
				displayName: 'Crispy Integration Test',
				version: '0.0.1',
			}),
			outputWriter: { appendLine: (line) => logs.push(line) },
			requestIdPrefix: 'integration',
		});

		try {
			const state = await client.start();
			assert.strictEqual(state.phase, 'ready');
			assert.strictEqual(state.cliVersion, codexProtocolCliVersion);
			assert.ok(state.serverUserAgent);
			assert.ok(logs.some((line) => line.includes('"method":"initialize"')));
			assert.ok(logs.some((line) => line.includes('"method":"initialized"')));
		} finally {
			await client.stop();
		}
		assert.strictEqual(client.state.phase, 'stopped');
	});
});
