import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCommonPlanPrompt, resolveAgentAssetPath } from '../agentAssets';
import { validateChangePlan } from '../changePlanValidator';
import { createValidPlan, VALID_PLAN_USER_PROMPT } from './testFixtures';

suite('ChangePlan Validator', () => {
	test('공통 프롬프트의 placeholder를 사용자 요청으로 치환한다', async () => {
		const combined = await buildCommonPlanPrompt('새로운 사용자 요청');
		assert.ok(combined.includes('새로운 사용자 요청'));
		assert.ok(!combined.includes('{{USER_PROMPT}}'));
	});

	test('placeholder가 중복된 프롬프트 asset을 거부한다', async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crispy-prompt-'));
		const promptPath = path.join(tempDirectory, 'common-plan.md');
		try {
			await fs.writeFile(promptPath, '{{USER_PROMPT}}\n{{USER_PROMPT}}', 'utf8');
			await assert.rejects(
				buildCommonPlanPrompt('요청', promptPath),
				/정확히 한 번/,
			);
		} finally {
			await fs.rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test('공통 프롬프트 asset이 없으면 실행 전에 읽기 오류를 반환한다', async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'crispy-missing-prompt-'));
		try {
			await assert.rejects(
				buildCommonPlanPrompt('요청', path.join(tempDirectory, 'common-plan.md')),
				/ENOENT/,
			);
		} finally {
			await fs.rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test('Schema와 Crispy 교차 필드 규약을 모두 만족하는 Plan을 허용한다', () => {
		const result = validateChangePlan(createValidPlan(), {
			userPrompt: VALID_PLAN_USER_PROMPT,
			schemaPath: resolveAgentAssetPath('changePlan.schema.json'),
		});
		assert.deepStrictEqual(result, { valid: true, errors: [] });
	});

	test('Task 순서와 targetNodes 연결이 어긋난 Plan을 거부한다', () => {
		const plan = createValidPlan();
		plan.tasks[0].order = 2;

		const result = validateChangePlan(plan, { userPrompt: VALID_PLAN_USER_PROMPT });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some((error) => error.includes('order')));
	});

	test('절대 경로와 개인 환경 경로가 포함된 Plan을 거부한다', () => {
		const plan = createValidPlan();
		plan.tasks[0].directTargets[0] = '/workspace/src/existing.ts';

		const result = validateChangePlan(plan, { userPrompt: VALID_PLAN_USER_PROMPT });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some((error) => error.includes('상대 경로')));
	});

	test('사용자가 정확한 경로를 언급한 대상의 additional 표기를 검사한다', () => {
		const plan = createValidPlan();
		plan.targetNodes[0].isAdditionalCandidate = true;

		const result = validateChangePlan(plan, { userPrompt: VALID_PLAN_USER_PROMPT });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some((error) => error.includes('isAdditionalCandidate')));
	});

	test('Codex output-schema에서 지원하지 않는 중복 검사를 Crispy Validator가 수행한다', () => {
		const plan = createValidPlan();
		plan.tasks[0].directTargets.push('src/existing.ts');

		const result = validateChangePlan(plan, { userPrompt: VALID_PLAN_USER_PROMPT });
		assert.strictEqual(result.valid, false);
		assert.ok(result.errors.some((error) => error.includes('중복 값')));
	});
});
