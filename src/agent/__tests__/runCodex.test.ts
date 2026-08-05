import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAgentAssetPath } from '../agentAssets';
import type { AgentEvent } from '../agentTypes';
import {
	disposeCodexRuns,
	runCodexWithDependencies,
	type CodexRunnerDependencies,
} from '../runCodex';
import { VALID_PLAN_USER_PROMPT } from './testFixtures';

suite('runCodex', () => {
	let workspaceRoot: string;

	setup(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crispy-runner-'));
	});

	teardown(async () => {
		await disposeCodexRuns();
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	test('stdout 이벤트와 stderr를 분리하고 검증된 Plan을 반환한다', async () => {
		const events: AgentEvent[] = [];
		let returned = false;
		const result = await runFakeCodex('success', {
			onEvent: (event) => {
				assert.strictEqual(returned, false);
				events.push(event);
			},
		});
		returned = true;

		assert.strictEqual(result.status, 'completed');
		assert.strictEqual(result.exitCode, 0);
		assert.strictEqual(result.stderr, 'fake warning\n');
		assert.ok(result.plan);
		assert.strictEqual(events.filter((event) => event.type === 'plan').length, 1);
		assert.ok(events.some((event) => event.type === 'tool' && event.name === 'list_files'));
	});

	test('일부 JSONL 파싱 실패 후에도 정상 Plan이 있으면 completed를 반환한다', async () => {
		const result = await runFakeCodex('malformed');
		assert.strictEqual(result.status, 'completed');
		assert.strictEqual(result.parseFailureCount, 1);
	});

	test('non-zero 종료와 stderr를 failed 결과로 반환한다', async () => {
		const result = await runFakeCodex('nonzero');
		assert.strictEqual(result.status, 'failed');
		assert.strictEqual(result.exitCode, 7);
		assert.strictEqual(result.stderr, 'fake failure\n');
		assert.match(result.error ?? '', /종료 코드 7/);
	});

	test('Codex JSONL의 Provider 오류를 일반 종료 코드보다 자세한 원인으로 반환한다', async () => {
		const events: AgentEvent[] = [];
		const result = await runFakeCodex('provider-error', {
			onEvent: (event) => events.push(event),
		});
		assert.strictEqual(result.status, 'failed');
		assert.strictEqual(result.exitCode, 9);
		assert.strictEqual(result.error, 'fake provider detail');
		assert.strictEqual(
			events.filter((event) => event.type === 'error' && event.message === 'fake provider detail').length,
			1,
		);
	});

	test('agent_message가 없으면 exit code 0이어도 failed를 반환한다', async () => {
		const result = await runFakeCodex('no-message');
		assert.strictEqual(result.status, 'failed');
		assert.match(result.error ?? '', /agent_message/);
	});

	test('PATH에서 Codex 실행 파일을 찾지 못한 경우 failed를 반환한다', async () => {
		const result = await runCodexWithDependencies(
			VALID_PLAN_USER_PROMPT,
			{ workspaceRoot },
			{
				...fakeDependencies('success'),
				executable: '__crispy_missing_codex_executable__',
				buildArguments: () => [],
			},
		);
		assert.strictEqual(result.status, 'failed');
		assert.match(result.error ?? '', /실행할 수 없습니다/);
	});

	test('이미 abort된 signal은 프로세스를 시작하지 않고 cancelled를 반환한다', async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runFakeCodex('success', { signal: controller.signal });
		assert.strictEqual(result.status, 'cancelled');
		assert.strictEqual(result.exitCode, null);
	});

	test('실행 중 AbortSignal을 받으면 process tree를 정리하고 cancelled를 반환한다', async () => {
		const controller = new AbortController();
		const run = runFakeCodex('wait', { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);

		const result = await run;
		assert.strictEqual(result.status, 'cancelled');
	});

	test('제한 시간을 먼저 초과하면 timed-out 상태를 보존한다', async () => {
		const result = await runFakeCodex('wait', { timeoutMs: 30 });
		assert.strictEqual(result.status, 'timed-out');
		assert.match(result.error ?? '', /초과/);
	});

	test('disposeCodexRuns가 실행 중인 Codex를 cancelled로 종료한다', async () => {
		const run = runFakeCodex('wait');
		await delay(50);
		await disposeCodexRuns();

		const result = await run;
		assert.strictEqual(result.status, 'cancelled');
		assert.match(result.error ?? '', /Extension 종료/);
	});

	test('onEvent 콜백이 예외를 던져도 성공 결과를 반환한다', async () => {
		const result = await runFakeCodex('success', {
			onEvent: () => {
				throw new Error('consumer error');
			},
		});
		assert.strictEqual(result.status, 'completed');
	});

	function runFakeCodex(
		scenario: string,
		overrides: { onEvent?: (event: AgentEvent) => void; signal?: AbortSignal; timeoutMs?: number } = {},
	) {
		return runCodexWithDependencies(
			VALID_PLAN_USER_PROMPT,
			{ workspaceRoot, ...overrides },
			fakeDependencies(scenario),
		);
	}
});

function fakeDependencies(scenario: string): CodexRunnerDependencies {
	return {
		executable: process.execPath,
		buildArguments: () => [path.join(__dirname, 'fixtures', 'fakeCodexProcess.js'), scenario],
		buildPrompt: async (prompt) => prompt,
		resolveSchemaPath: () => resolveAgentAssetPath('changePlan.schema.json'),
	};
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
