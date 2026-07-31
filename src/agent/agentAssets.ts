import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';

export type AgentAssetName = 'common-plan.md' | 'changePlan.schema.json';

const USER_PROMPT_PLACEHOLDER = '{{USER_PROMPT}}';

/**
 * 개발 중의 out 디렉터리와 배포 번들의 dist 디렉터리에서 동일한 방식으로
 * Agent asset을 찾습니다. 개인 PC의 clone 위치를 기준으로 삼지 않고 현재 모듈의
 * 위치만 사용해야 Extension을 어느 경로에 설치해도 같은 코드가 동작합니다.
 */
export function resolveAgentAssetPath(assetName: AgentAssetName): string {
	const candidates = [
		path.join(__dirname, 'agent', assetName),
		path.join(__dirname, assetName),
		path.resolve(__dirname, '../../src/agent', assetName),
	];

	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			// 후보 하나가 없더라도 개발용/배포용 다음 위치를 계속 확인합니다.
		}
	}

	throw new Error(`Agent asset을 찾을 수 없습니다: ${assetName}`);
}

/**
 * 공통 Plan 프롬프트의 단일 placeholder를 사용자 요청으로 치환합니다.
 * placeholder가 없거나 중복되면 요청이 누락·중복될 수 있으므로 Codex 실행 전에 실패시킵니다.
 */
export async function buildCommonPlanPrompt(
	userPrompt: string,
	promptPath = resolveAgentAssetPath('common-plan.md'),
): Promise<string> {
	if (userPrompt.trim().length === 0) {
		throw new Error('사용자 prompt는 비어 있을 수 없습니다.');
	}

	const template = await fs.readFile(promptPath, 'utf8');
	const placeholderCount = template.split(USER_PROMPT_PLACEHOLDER).length - 1;

	if (placeholderCount !== 1) {
		throw new Error(`공통 Plan 프롬프트에는 ${USER_PROMPT_PLACEHOLDER}가 정확히 한 번 있어야 합니다.`);
	}

	return template.replace(USER_PROMPT_PLACEHOLDER, userPrompt);
}
