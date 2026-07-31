import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, ChangePlan, ChangePlanChange } from '../agentTypes';
import { runCodex } from '../runCodex';

suite('Codex 실제 통합 테스트', () => {
	test('실시간 이벤트와 검증된 ChangePlan을 반환하고 Workspace를 변경하지 않는다', async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crispy-codex-integration-'));
		try {
			await createIntegrationWorkspace(workspaceRoot);
			const userPrompt = await fs.readFile(
				path.resolve(__dirname, '../../../src/agent/__tests__/fixtures/integration-user-prompt.md'),
				'utf8',
			);
			const before = await snapshotDirectory(workspaceRoot);
			const events: AgentEvent[] = [];
			let returned = false;

			const result = await runCodex(userPrompt, {
				workspaceRoot,
				onEvent: (event) => {
					assert.strictEqual(returned, false);
					events.push(event);
				},
			});
			returned = true;

			assert.strictEqual(
				result.status,
				'completed',
				[result.error, result.stderr].filter(Boolean).join('\n'),
			);
			assert.ok(result.plan);
			assert.ok(events.length > 0);
			assert.ok(events.some((event) => event.type === 'tool'));
			assert.strictEqual(events.filter((event) => event.type === 'plan').length, 1);
			assert.strictEqual(result.provider, 'codex');
			assert.strictEqual(result.exitCode, 0);
			assert.strictEqual(result.parseFailureCount, 0);
			assertPlanTarget(result.plan, 'src/config.ts', 'modify');
			assertPlanTarget(result.plan, 'src/configDefaults.ts', 'create');
			assertPlanTarget(result.plan, 'docs/legacy-config.md', 'delete');
			assert.deepStrictEqual(await snapshotDirectory(workspaceRoot), before);
		} finally {
			await fs.rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});

function assertPlanTarget(plan: ChangePlan, targetPath: string, change: ChangePlanChange): void {
	const target = plan.targetNodes.find((node) => node.path === targetPath);
	assert.ok(target, `${targetPath} 대상이 Plan에 없습니다.\n${JSON.stringify(plan, null, 2)}`);
	assert.ok(
		target.changes.includes(change),
		`${targetPath} 대상에 ${change} change가 없습니다.\n${JSON.stringify(target, null, 2)}`,
	);
}

/** 실제 사용자가 설정 리팩터링을 요청할 법한 작은 TypeScript 프로젝트를 구성합니다. */
async function createIntegrationWorkspace(workspaceRoot: string): Promise<void> {
	await Promise.all([
		fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true }),
		fs.mkdir(path.join(workspaceRoot, 'tests'), { recursive: true }),
		fs.mkdir(path.join(workspaceRoot, 'docs'), { recursive: true }),
	]);
	await Promise.all([
		fs.writeFile(path.join(workspaceRoot, 'README.md'), '# Sample Service\n', 'utf8'),
		fs.writeFile(
			path.join(workspaceRoot, 'package.json'),
			JSON.stringify({
				name: 'crispy-agent-fixture',
				private: true,
				scripts: { test: 'node --test', build: 'tsc --noEmit' },
			}, null, 2),
			'utf8',
		),
		fs.writeFile(
			path.join(workspaceRoot, 'src', 'config.ts'),
			[
				"export const config = {",
				"\tport: Number(process.env.PORT ?? '3000'),",
				"\tlogLevel: process.env.LOG_LEVEL ?? 'info',",
				'};',
				'',
			].join('\n'),
			'utf8',
		),
		fs.writeFile(
			path.join(workspaceRoot, 'src', 'index.ts'),
			"import { config } from './config';\n\nconsole.log(`Listening on ${config.port}`);\n",
			'utf8',
		),
		fs.writeFile(
			path.join(workspaceRoot, 'tests', 'config.test.ts'),
			"import { strict as assert } from 'node:assert';\nimport { config } from '../src/config';\n\nassert.ok(config.port > 0);\n",
			'utf8',
		),
		fs.writeFile(
			path.join(workspaceRoot, 'docs', 'legacy-config.md'),
			'# Legacy configuration\n\nUse the removed CONFIG_PATH option.\n',
			'utf8',
		),
	]);
}

async function snapshotDirectory(root: string): Promise<Record<string, string>> {
	const snapshot: Record<string, string> = {};
	await visitDirectory(root, '', snapshot);
	return snapshot;
}

async function visitDirectory(
	root: string,
	relativeDirectory: string,
	snapshot: Record<string, string>,
): Promise<void> {
	const absoluteDirectory = path.join(root, relativeDirectory);
	const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name);
		if (entry.isDirectory()) {
			await visitDirectory(root, relativePath, snapshot);
		} else if (entry.isFile()) {
			snapshot[relativePath] = await fs.readFile(path.join(root, relativePath), 'utf8');
		}
	}
}
