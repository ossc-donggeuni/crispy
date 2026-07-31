import type { ChangePlan } from '../agentTypes';

/** 여러 테스트가 같은 의미 규약을 검증하도록 사용하는 최소 유효 ChangePlan입니다. */
export function createValidPlan(title = '예시 변경 계획'): ChangePlan {
	return {
		title,
		summary: '기존 모듈을 수정하고 새 모듈을 추가하는 계획입니다.',
		tasks: [
			{
				id: 'task-1',
				title: '예시 기능 구성',
				description: '기존 파일을 수정하고 새 파일을 추가합니다.',
				order: 1,
				directTargets: ['src/existing.ts'],
				createdTargets: ['src/new.ts'],
				deletedTargets: [],
				referenceTargets: ['package.json'],
				possibleImpactTargets: ['src/consumer.ts'],
			},
		],
		expectedModifiedFiles: [
			{
				path: 'src/existing.ts',
				codeNodeId: 'file:src/existing.ts',
				reason: '기존 동작을 확장해야 합니다.',
				taskIds: ['task-1'],
			},
		],
		expectedCreatedFiles: [
			{
				path: 'src/new.ts',
				codeNodeId: 'file:src/new.ts',
				reason: '새 동작을 분리합니다.',
				taskIds: ['task-1'],
			},
		],
		expectedDeletedOrRemovedTargets: [],
		referenceFiles: [
			{
				path: 'package.json',
				codeNodeId: 'file:package.json',
				reason: '현재 프로젝트 설정을 확인합니다.',
				taskIds: ['task-1'],
			},
		],
		targetNodes: [
			{
				relation: 'direct',
				changes: ['modify'],
				matchStatus: 'resolved',
				path: 'src/existing.ts',
				codeNodeId: 'file:src/existing.ts',
				taskIds: ['task-1'],
				isAdditionalCandidate: false,
				isFileDeletion: false,
				originalTargetText: null,
				note: null,
			},
			{
				relation: 'direct',
				changes: ['create'],
				matchStatus: 'resolved',
				path: 'src/new.ts',
				codeNodeId: 'file:src/new.ts',
				taskIds: ['task-1'],
				isAdditionalCandidate: false,
				isFileDeletion: false,
				originalTargetText: null,
				note: null,
			},
			{
				relation: 'reference',
				changes: [],
				matchStatus: 'resolved',
				path: 'package.json',
				codeNodeId: 'file:package.json',
				taskIds: ['task-1'],
				isAdditionalCandidate: true,
				isFileDeletion: false,
				originalTargetText: null,
				note: null,
			},
			{
				relation: 'possible-impact',
				changes: [],
				matchStatus: 'resolved',
				path: 'src/consumer.ts',
				codeNodeId: 'file:src/consumer.ts',
				taskIds: ['task-1'],
				isAdditionalCandidate: true,
				isFileDeletion: false,
				originalTargetText: null,
				note: null,
			},
		],
		preImplementationChecks: ['기존 모듈의 공개 API를 확인합니다.'],
		postImplementationComparisonCriteria: ['승인된 파일 범위와 실제 변경을 비교합니다.'],
	};
}

export const VALID_PLAN_USER_PROMPT = 'Update src/existing.ts and create src/new.ts.';
