import * as assert from 'node:assert/strict';
import { TerminalSession } from '../../agent/host/terminal/terminalSession';
import { spawnAgentPty } from '../../mcp/agentPtyLaunch';
import { FakePtyAdapter } from '../agent/support/fakePtyAdapter';

suite('Agent PTY root launch', () => {
	test('direct request는 structured argv를 PTY root에 그대로 전달한다', async () => {
		const fixture = createSession();
		fixture.session.markStarting();

		await spawnAgentPty(fixture.session, {
			executable: '/opt/codex',
			args: ['--config', 'key=value'],
			cwd: '/workspace',
			environment: { PATH: '/bin' },
			windowsVerbatimArguments: false,
		}, 80, 24);

		assert.deepStrictEqual(fixture.adapter.spawnCalls[0].args, [
			'--config', 'key=value',
		]);
	});

	test('Windows cmd one-shot은 node-pty 재인용 없이 raw command-line을 전달한다', async () => {
		const fixture = createSession();
		fixture.session.markStarting();
		const args = [
			'/d',
			'/s',
			'/v:off',
			'/c',
			'"C:\\Program^ Files\\100^% ^(Codex^)^!\\codex.cmd"',
		];

		await spawnAgentPty(fixture.session, {
			executable: 'C:\\Windows\\System32\\cmd.exe',
			args,
			cwd: 'C:\\workspace',
			environment: { PATH: 'C:\\safe' },
			windowsVerbatimArguments: true,
		}, 100, 30);

		assert.strictEqual(fixture.adapter.spawnCalls[0].args, args.join(' '));
		assert.strictEqual(
			fixture.adapter.spawnCalls[0].executable,
			'C:\\Windows\\System32\\cmd.exe',
		);
	});
});

function createSession(): {
	readonly adapter: FakePtyAdapter;
	readonly session: TerminalSession;
} {
	const adapter = new FakePtyAdapter(7301);
	return {
		adapter,
		session: new TerminalSession({
			tabId: 'tab-agent-pty',
			sessionId: 'session-agent-pty',
			ptyAdapter: adapter,
			onOutput: () => undefined,
			onExit: () => undefined,
			onRunning: () => undefined,
		}),
	};
}
