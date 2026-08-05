import { readFileSync } from 'node:fs';
import path from 'node:path';

import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';

import { resolveAgentAssetPath } from './agentAssets';
import type {
	ChangePlan,
	ChangePlanChange,
	ChangePlanFileItem,
	ChangePlanRemovedTarget,
	ChangePlanRelation,
	ChangePlanTargetNode,
} from './agentTypes';

/**
 * ChangePlan을 검증할 때 Plan 객체만으로는 알 수 없는 외부 조건입니다.
 *
 * 사용자 요청은 `isAdditionalCandidate`가 실제 요청에 없던 추가 대상인지 판단할 때
 * 사용하고, Schema 경로는 배포 asset 대신 테스트 fixture를 주입할 때 사용합니다.
 */
export interface ChangePlanValidationContext {
	/** Codex에 전달된 원본 사용자 요청입니다. 경로가 직접 언급되었는지 비교할 때 사용합니다. */
	userPrompt: string;
	/** 사용할 JSON Schema의 경로입니다. 생략하면 번들된 `changePlan.schema.json`을 찾습니다. */
	schemaPath?: string;
}

/**
 * JSON Schema 검사와 Crispy 의미 규칙 검사를 합친 최종 검증 결과입니다.
 *
 * `valid`가 false이면 `errors`에 사람이 읽을 수 있는 실패 이유를 모두 담습니다.
 * Validator는 잘못된 Plan을 자동 보정하지 않으므로 호출자는 이 결과를 이용해
 * 후보를 제외하거나 최종 실행 실패 원인을 구성해야 합니다.
 */
export interface ChangePlanValidationResult {
	/** 구조 검사와 의미 검사를 모두 통과했는지를 나타냅니다. */
	valid: boolean;
	/** 발견된 Schema 또는 Crispy 규약 위반 메시지입니다. 성공한 경우 빈 배열입니다. */
	errors: string[];
}

/**
 * Schema 파일 경로별로 컴파일된 Ajv 검증기를 재사용하는 캐시입니다.
 *
 * Agent 실행마다 같은 Schema를 다시 읽고 컴파일하면 불필요한 파일 I/O와 컴파일 비용이
 * 발생하므로 경로를 key로 보관합니다. 테스트가 별도 Schema 경로를 주입해도 서로 다른
 * 검증기로 분리되도록 파일 내용이 아닌 경로를 key로 사용합니다.
 */
const schemaValidators = new Map<string, ValidateFunction<ChangePlan>>();

/**
 * 알 수 없는 값을 Crispy의 최종 ChangePlan 계약에 따라 검증합니다.
 *
 * JSON Schema는 객체 모양, 필수 필드, enum처럼 단일 값의 구조를 먼저 검사하고,
 * 그 검사를 통과한 값에만 Task와 targetNodes 사이의 교차 관계를 검사합니다.
 * 두 단계를 분리하면 Codex의 `--output-schema`와 같은 Schema를 재사용하면서도
 * JSON Schema만으로 표현하기 어려운 Crispy 규약을 놓치지 않을 수 있습니다.
 *
 * @param value Codex의 `agent_message.text`를 JSON으로 파싱해 얻은 검증 전 값
 * @param context 원본 사용자 요청과 선택적인 Schema 경로를 담은 검증 조건
 * @returns 전체 검증 성공 여부와 발견된 모든 오류 메시지
 * @throws Schema asset을 읽거나 JSON으로 파싱하거나 Ajv로 컴파일할 수 없으면 예외가 발생합니다.
 */
export function validateChangePlan(
	value: unknown,
	context: ChangePlanValidationContext,
): ChangePlanValidationResult {
	const schemaPath = context.schemaPath ?? resolveAgentAssetPath('changePlan.schema.json');
	const validateSchema = getSchemaValidator(schemaPath);

	if (!validateSchema(value)) {
		return {
			valid: false,
			errors: (validateSchema.errors ?? []).map(formatSchemaError),
		};
	}

	const errors = validateSemanticRules(value, context.userPrompt);
	return { valid: errors.length === 0, errors };
}

/**
 * 지정한 Schema 파일을 Ajv 검증 함수로 컴파일하거나 기존 캐시에서 가져옵니다.
 *
 * `strict` 모드는 잘못 작성된 Schema를 조기에 발견하고, `allErrors`는 첫 오류에서
 * 멈추지 않고 가능한 구조 오류를 함께 보여주기 위해 사용합니다. 반환된 함수는 Schema를
 * 통과한 값의 TypeScript 타입을 `ChangePlan`으로 좁혀 주는 type guard 역할도 합니다.
 *
 * @param schemaPath 읽고 컴파일할 ChangePlan JSON Schema의 절대 또는 해석 가능한 경로
 * @returns 해당 Schema에 연결된 Ajv 검증 함수
 * @throws 파일 읽기, JSON 파싱 또는 Ajv Schema 컴파일에 실패하면 예외가 발생합니다.
 */
function getSchemaValidator(schemaPath: string): ValidateFunction<ChangePlan> {
	const cached = schemaValidators.get(schemaPath);
	if (cached) {
		return cached;
	}

	let schema: unknown;
	try {
		schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`ChangePlan Schema를 읽을 수 없습니다: ${message}`);
	}

	const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
	const validator = ajv.compile<ChangePlan>(schema as AnySchema);
	schemaValidators.set(schemaPath, validator);
	return validator;
}

/**
 * Ajv의 구조화된 오류를 Agent 실행 결과에 넣을 수 있는 한 줄 메시지로 변환합니다.
 *
 * @param error Ajv가 반환한 개별 Schema 검증 오류
 * @returns 실패한 JSON 위치와 원인을 포함한 사용자 판독용 문자열
 */
function formatSchemaError(error: ErrorObject): string {
	const location = error.instancePath || '/';
	return `Schema ${location}: ${error.message ?? error.keyword}`;
}

/**
 * Schema를 통과한 Plan의 배열과 참조 사이에 Crispy 고유의 의미 규칙을 검사합니다.
 *
 * Task 순서, 대상 경로, relation과 changes, 파일 목록, taskIds가 서로 같은 사실을
 * 표현하는지 교차 검증합니다. 오류는 `Set`에 모아 동일한 원인이 여러 경로에서 발견돼도
 * 중복 메시지를 줄이고, 가능한 규칙을 끝까지 검사해 한 번에 반환합니다.
 *
 * @param plan JSON Schema 검사를 이미 통과한 ChangePlan
 * @param userPrompt `isAdditionalCandidate` 판정에 사용하는 원본 사용자 요청
 * @returns 중복이 제거된 Crispy 의미 규칙 위반 메시지 목록
 */
function validateSemanticRules(plan: ChangePlan, userPrompt: string): string[] {
	const errors = new Set<string>();
	const knownTaskIds = new Set<string>();

	plan.tasks.forEach((task, index) => {
		const expectedId = `task-${index + 1}`;
		if (knownTaskIds.has(task.id)) {
			errors.add(`Task ID가 중복되었습니다: ${task.id}`);
		}
		knownTaskIds.add(task.id);

		if (task.id !== expectedId) {
			errors.add(`tasks[${index}].id는 ${expectedId}여야 합니다.`);
		}
		if (task.order !== index + 1) {
			errors.add(`tasks[${index}].order는 ${index + 1}이어야 합니다.`);
		}
	});

	const targetByPath = new Map<string, ChangePlanTargetNode>();
	plan.targetNodes.forEach((node, index) => {
		validateTargetNode(node, index, userPrompt, knownTaskIds, targetByPath, errors);
	});

	const usageByPath = new Map<string, Set<string>>();
	const taskTargetRules: Array<{
		key: keyof Pick<
			typeof plan.tasks[number],
			'directTargets' | 'createdTargets' | 'deletedTargets' | 'referenceTargets' | 'possibleImpactTargets'
		>;
		relation: ChangePlanRelation;
		change?: ChangePlanChange;
	}> = [
		{ key: 'directTargets', relation: 'direct', change: 'modify' },
		{ key: 'createdTargets', relation: 'direct', change: 'create' },
		{ key: 'deletedTargets', relation: 'direct', change: 'delete' },
		{ key: 'referenceTargets', relation: 'reference' },
		{ key: 'possibleImpactTargets', relation: 'possible-impact' },
	];

	for (const task of plan.tasks) {
		for (const rule of taskTargetRules) {
			validateUniqueStrings(task[rule.key], `Task ${task.id}의 ${rule.key}`, errors);
			for (const targetPath of task[rule.key]) {
				validateWorkspaceRelativePath(targetPath, `Task ${task.id}의 ${rule.key}`, errors);
				addPathUsage(usageByPath, targetPath, task.id);
				const node = targetByPath.get(targetPath);
				if (!node) {
					errors.add(`Task ${task.id}의 ${rule.key} 경로가 targetNodes에 없습니다: ${targetPath}`);
					continue;
				}
				if (node.relation !== rule.relation) {
					errors.add(`${targetPath}의 relation은 ${rule.relation}이어야 합니다.`);
				}
				if (rule.change && !node.changes.includes(rule.change)) {
					errors.add(`${targetPath}의 changes에 ${rule.change}가 필요합니다.`);
				}
			}
		}
	}

	validateFileCollection(
		'expectedModifiedFiles',
		plan.expectedModifiedFiles,
		targetByPath,
		knownTaskIds,
		usageByPath,
		errors,
		'direct',
		'modify',
	);
	validateFileCollection(
		'expectedCreatedFiles',
		plan.expectedCreatedFiles,
		targetByPath,
		knownTaskIds,
		usageByPath,
		errors,
		'direct',
		'create',
	);
	validateRemovedCollection(
		plan.expectedDeletedOrRemovedTargets,
		targetByPath,
		knownTaskIds,
		usageByPath,
		errors,
	);
	validateFileCollection(
		'referenceFiles',
		plan.referenceFiles,
		targetByPath,
		knownTaskIds,
		usageByPath,
		errors,
		'reference',
	);

	// path 기반 target은 Task 배열 또는 expected/reference 목록 중 적어도 한 곳에서
	// 사용되어야 합니다. 이렇게 해야 UI가 taskIds만 보고도 실제 연결 근거를 추적할 수 있습니다.
	for (const [targetPath, node] of targetByPath) {
		const usages = usageByPath.get(targetPath) ?? new Set<string>();
		if (usages.size === 0) {
			errors.add(`targetNodes 경로가 Task 또는 파일 목록에서 사용되지 않았습니다: ${targetPath}`);
		}
		if (!sameStringSet(node.taskIds, usages)) {
			errors.add(`targetNodes의 taskIds가 실제 사용 Task와 일치하지 않습니다: ${targetPath}`);
		}
	}

	return [...errors];
}

/**
 * 하나의 `targetNodes` 항목이 해석 상태와 대상 종류에 맞는 필드를 갖는지 검사합니다.
 *
 * unresolved 대상은 실제 경로 대신 원문과 미해결 이유를 가져야 하고, resolved/scoped
 * 대상은 정규화된 경로와 그 경로에서 파생된 codeNodeId가 필요합니다. 경로가 확정된
 * 대상은 이후 Task 및 파일 목록 검증에서 찾을 수 있도록 `targetByPath`에도 등록합니다.
 *
 * @param node 검사할 target node
 * @param index 오류 메시지에서 원래 배열 위치를 표시하기 위한 index
 * @param userPrompt 사용자가 해당 경로를 직접 언급했는지 확인할 원본 요청
 * @param knownTaskIds Plan에 실제 존재하는 Task ID 집합
 * @param targetByPath 검증된 경로 대상을 공유하는 lookup map
 * @param errors 발견한 규약 위반을 누적하는 오류 집합
 * @returns 반환값 없이 lookup map과 오류 집합을 갱신합니다.
 */
function validateTargetNode(
	node: ChangePlanTargetNode,
	index: number,
	userPrompt: string,
	knownTaskIds: Set<string>,
	targetByPath: Map<string, ChangePlanTargetNode>,
	errors: Set<string>,
): void {
	const label = `targetNodes[${index}]`;
	validateUniqueStrings(node.changes, `${label}.changes`, errors);
	validateTaskIds(node.taskIds, `${label}.taskIds`, knownTaskIds, errors);

	if (node.relation === 'direct' && node.changes.length === 0) {
		errors.add(`${label}: direct 대상에는 최소 하나의 change가 필요합니다.`);
	}
	if (node.relation !== 'direct' && node.changes.length > 0) {
		errors.add(`${label}: reference/possible-impact 대상의 changes는 비어 있어야 합니다.`);
	}

	if (node.matchStatus === 'unresolved') {
		if (node.path !== null) {
			errors.add(`${label}: unresolved 대상의 path는 null이어야 합니다.`);
		}
		if (!/^unresolved:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.codeNodeId)) {
			errors.add(`${label}: unresolved codeNodeId 형식이 올바르지 않습니다.`);
		}
		if (!node.originalTargetText?.trim()) {
			errors.add(`${label}: unresolved 대상에는 originalTargetText가 필요합니다.`);
		}
		if (!node.note?.trim()) {
			errors.add(`${label}: unresolved 대상에는 경로를 정하지 못한 이유가 필요합니다.`);
		}
		if (node.isAdditionalCandidate) {
			errors.add(`${label}: unresolved 대상의 isAdditionalCandidate는 false여야 합니다.`);
		}
		if (node.isFileDeletion) {
			errors.add(`${label}: unresolved 대상은 파일 전체 삭제로 확정할 수 없습니다.`);
		}
		return;
	}

	if (node.path === null || node.path.length === 0) {
		errors.add(`${label}: resolved/scoped 대상에는 path가 필요합니다.`);
		return;
	}

	validateWorkspaceRelativePath(node.path, `${label}.path`, errors);
	if (targetByPath.has(node.path)) {
		errors.add(`targetNodes에 같은 path가 중복되었습니다: ${node.path}`);
	} else {
		targetByPath.set(node.path, node);
	}

	const validCodeNodeIds = new Set([`file:${node.path}`, `directory:${node.path}`]);
	if (!validCodeNodeIds.has(node.codeNodeId)) {
		errors.add(`${label}: codeNodeId가 path와 일치하지 않습니다.`);
	}
	if (node.matchStatus === 'scoped' && node.codeNodeId !== `directory:${node.path}`) {
		errors.add(`${label}: scoped 대상은 directory codeNodeId를 사용해야 합니다.`);
	}

	if (node.isFileDeletion && (!node.changes.includes('delete') || node.codeNodeId !== `file:${node.path}`)) {
		errors.add(`${label}: 파일 전체 삭제는 file 대상이며 delete change를 포함해야 합니다.`);
	}

	// isAdditionalCandidate는 모델의 주관적 확정도가 아니라 사용자 입력에 실제 경로가
	// 있었는지를 나타냅니다. 정확한 경로 문자열의 존재만 사용해 결정론적으로 검사합니다.
	const shouldBeAdditional = !promptMentionsExactPath(userPrompt, node.path);
	if (node.isAdditionalCandidate !== shouldBeAdditional) {
		errors.add(`${label}: isAdditionalCandidate가 사용자 prompt의 경로 언급 여부와 일치하지 않습니다.`);
	}
}

/**
 * 수정·생성·참고 파일 목록과 `targetNodes`가 같은 대상을 설명하는지 검사합니다.
 *
 * 세 목록은 공통 필드 구조를 사용하므로 하나의 함수에서 경로 중복, taskIds, codeNodeId,
 * relation과 필수 change를 일관되게 확인합니다. 검사 중 확인된 Task 사용 관계는
 * `usageByPath`에 기록되어 마지막에 target node의 `taskIds`와 다시 비교됩니다.
 *
 * @param collectionName 오류 메시지에 사용할 ChangePlan 컬렉션 이름
 * @param items 검사할 수정·생성·참고 파일 항목
 * @param targetByPath 경로로 target node를 찾는 lookup map
 * @param knownTaskIds Plan에 존재하는 Task ID 집합
 * @param usageByPath 경로별 실제 Task 참조를 누적하는 map
 * @param errors 발견한 규약 위반을 누적하는 오류 집합
 * @param relation 해당 파일 목록이 요구하는 target relation
 * @param change 해당 파일 목록이 요구하는 change. 참고 목록처럼 필요 없으면 생략합니다.
 * @returns 반환값 없이 사용 관계와 오류 집합을 갱신합니다.
 */
function validateFileCollection(
	collectionName: string,
	items: ChangePlanFileItem[],
	targetByPath: Map<string, ChangePlanTargetNode>,
	knownTaskIds: Set<string>,
	usageByPath: Map<string, Set<string>>,
	errors: Set<string>,
	relation: ChangePlanRelation,
	change?: ChangePlanChange,
): void {
	validateUniqueCollectionPaths(collectionName, items, errors);
	items.forEach((item, index) => {
		const label = `${collectionName}[${index}]`;
		validateWorkspaceRelativePath(item.path, `${label}.path`, errors);
		validateTaskIds(item.taskIds, `${label}.taskIds`, knownTaskIds, errors);
		item.taskIds.forEach((taskId) => addPathUsage(usageByPath, item.path, taskId));

		if (item.codeNodeId !== `file:${item.path}`) {
			errors.add(`${label}: 파일 목록의 codeNodeId가 path와 일치하지 않습니다.`);
		}

		const node = targetByPath.get(item.path);
		if (!node) {
			errors.add(`${label}: path가 targetNodes에 없습니다: ${item.path}`);
			return;
		}
		if (node.relation !== relation) {
			errors.add(`${label}: targetNode relation은 ${relation}이어야 합니다.`);
		}
		if (change && !node.changes.includes(change)) {
			errors.add(`${label}: targetNode changes에 ${change}가 필요합니다.`);
		}
		if (relation === 'reference' && node.changes.length > 0) {
			errors.add(`${label}: reference target의 changes는 비어 있어야 합니다.`);
		}
	});
}

/**
 * 삭제 또는 내부 요소 제거 예정 목록과 `targetNodes`의 삭제 표현을 교차 검사합니다.
 *
 * 삭제 목록은 일반 파일 목록과 달리 `isFileDeletion` 의미까지 target node와 일치해야
 * 하므로 별도 함수로 분리합니다. 모든 항목은 direct relation과 delete change를 가져야 합니다.
 *
 * @param items 검사할 삭제 또는 제거 대상 목록
 * @param targetByPath 경로로 target node를 찾는 lookup map
 * @param knownTaskIds Plan에 존재하는 Task ID 집합
 * @param usageByPath 경로별 실제 Task 참조를 누적하는 map
 * @param errors 발견한 규약 위반을 누적하는 오류 집합
 * @returns 반환값 없이 사용 관계와 오류 집합을 갱신합니다.
 */
function validateRemovedCollection(
	items: ChangePlanRemovedTarget[],
	targetByPath: Map<string, ChangePlanTargetNode>,
	knownTaskIds: Set<string>,
	usageByPath: Map<string, Set<string>>,
	errors: Set<string>,
): void {
	validateUniqueCollectionPaths('expectedDeletedOrRemovedTargets', items, errors);
	items.forEach((item, index) => {
		const label = `expectedDeletedOrRemovedTargets[${index}]`;
		validateWorkspaceRelativePath(item.path, `${label}.path`, errors);
		validateTaskIds(item.taskIds, `${label}.taskIds`, knownTaskIds, errors);
		item.taskIds.forEach((taskId) => addPathUsage(usageByPath, item.path, taskId));

		if (item.codeNodeId !== `file:${item.path}`) {
			errors.add(`${label}: codeNodeId가 path와 일치하지 않습니다.`);
		}
		const node = targetByPath.get(item.path);
		if (!node) {
			errors.add(`${label}: path가 targetNodes에 없습니다: ${item.path}`);
			return;
		}
		if (node.relation !== 'direct' || !node.changes.includes('delete')) {
			errors.add(`${label}: 삭제 대상은 direct relation과 delete change가 필요합니다.`);
		}
		if (node.isFileDeletion !== item.isFileDeletion) {
			errors.add(`${label}: isFileDeletion이 targetNode와 일치하지 않습니다.`);
		}
	});
}

/**
 * 파일 목록 한 곳에 같은 경로가 두 번 선언되지 않았는지 검사합니다.
 *
 * @param collectionName 중복이 발생한 목록을 식별할 이름
 * @param items `path`를 가진 검사 대상 항목
 * @param errors 중복 오류를 누적할 집합
 * @returns 반환값 없이 오류 집합을 갱신합니다.
 */
function validateUniqueCollectionPaths(
	collectionName: string,
	items: Array<{ path: string }>,
	errors: Set<string>,
): void {
	const paths = new Set<string>();
	for (const item of items) {
		if (paths.has(item.path)) {
			errors.add(`${collectionName}에 path가 중복되었습니다: ${item.path}`);
		}
		paths.add(item.path);
	}
}

/**
 * 항목이 참조하는 Task ID가 중복되지 않고 실제 Plan의 Task를 가리키는지 검사합니다.
 *
 * @param taskIds 검사할 Task ID 목록
 * @param label 오류가 발생한 필드를 식별할 이름
 * @param knownTaskIds Plan에 존재하는 Task ID 집합
 * @param errors 중복 또는 잘못된 참조 오류를 누적할 집합
 * @returns 반환값 없이 오류 집합을 갱신합니다.
 */
function validateTaskIds(
	taskIds: string[],
	label: string,
	knownTaskIds: Set<string>,
	errors: Set<string>,
): void {
	validateUniqueStrings(taskIds, label, errors);
	for (const taskId of taskIds) {
		if (!knownTaskIds.has(taskId)) {
			errors.add(`${label}에 존재하지 않는 Task ID가 있습니다: ${taskId}`);
		}
	}
}

/**
 * 문자열 배열 안의 중복 값을 검사하는 공통 보조 함수입니다.
 *
 * @param values 중복 여부를 확인할 문자열 목록
 * @param label 오류가 발생한 필드를 식별할 이름
 * @param errors 중복 오류를 누적할 집합
 * @returns 반환값 없이 오류 집합을 갱신합니다.
 */
function validateUniqueStrings(values: string[], label: string, errors: Set<string>): void {
	const uniqueValues = new Set(values);
	if (uniqueValues.size !== values.length) {
		errors.add(`${label}에 중복 값이 있습니다.`);
	}
}

/**
 * 대상 경로가 운영체제와 무관한 Workspace 상대 POSIX 경로인지 검사합니다.
 *
 * 절대 경로, Windows 역슬래시, 빈 segment, `.`과 `..`을 금지하여 Plan이 특정 사용자
 * 환경에 의존하거나 Workspace 바깥을 가리키지 않도록 합니다.
 *
 * @param targetPath 검사할 대상 경로
 * @param label 오류가 발생한 필드를 식별할 이름
 * @param errors 경로 오류를 누적할 집합
 * @returns 반환값 없이 오류 집합을 갱신합니다.
 */
function validateWorkspaceRelativePath(targetPath: string, label: string, errors: Set<string>): void {
	const segments = targetPath.split('/');
	if (
		path.posix.isAbsolute(targetPath)
		|| path.win32.isAbsolute(targetPath)
		|| targetPath.includes('\\')
		|| segments.some((segment) => segment === '' || segment === '.' || segment === '..')
	) {
		errors.add(`${label}는 Workspace 기준의 정규화된 상대 경로여야 합니다: ${targetPath}`);
	}
}

/**
 * 특정 경로가 어느 Task에서 사용되었는지를 집합으로 누적합니다.
 *
 * @param usageByPath 경로별 Task ID 집합을 저장하는 map
 * @param targetPath 사용 관계를 기록할 Workspace 상대 경로
 * @param taskId 해당 경로를 참조한 Task ID
 * @returns 반환값 없이 map을 갱신합니다.
 */
function addPathUsage(usageByPath: Map<string, Set<string>>, targetPath: string, taskId: string): void {
	const usages = usageByPath.get(targetPath) ?? new Set<string>();
	usages.add(taskId);
	usageByPath.set(targetPath, usages);
}

/**
 * 문자열 배열이 기대한 집합과 중복 없이 정확히 같은 원소를 갖는지 비교합니다.
 *
 * @param values ChangePlan에 선언된 문자열 배열
 * @param expected 실제 참조를 수집해 만든 기대 집합
 * @returns 원소의 수와 값이 모두 같으면 true
 */
function sameStringSet(values: string[], expected: Set<string>): boolean {
	return values.length === expected.size && values.every((value) => expected.has(value));
}

/**
 * 사용자 요청에 대상 경로가 더 긴 경로의 일부가 아닌 정확한 단위로 등장하는지 확인합니다.
 *
 * 단순 `includes`를 사용하면 `src/file.ts`가 `src/file.tsx`에도 포함되는 오탐이 생깁니다.
 * 앞뒤의 경로 문자를 경계로 검사하되 문장 끝 마침표는 자연어 구두점으로 인정합니다.
 * 이 결과는 모델의 주관적 판단이 아닌 결정론적 `isAdditionalCandidate` 검증에 사용됩니다.
 *
 * @param userPrompt 경로 언급을 찾을 원본 사용자 요청
 * @param targetPath 정확히 언급되었는지 확인할 Workspace 상대 경로
 * @returns 경로가 독립된 단위로 한 번 이상 등장하면 true
 */
function promptMentionsExactPath(userPrompt: string, targetPath: string): boolean {
	let startIndex = userPrompt.indexOf(targetPath);
	while (startIndex >= 0) {
		const previous = startIndex > 0 ? userPrompt[startIndex - 1] : '';
		const nextIndex = startIndex + targetPath.length;
		const next = nextIndex < userPrompt.length ? userPrompt[nextIndex] : '';
		const afterNext = nextIndex + 1 < userPrompt.length ? userPrompt[nextIndex + 1] : '';
		const pathCharacter = /[A-Za-z0-9_./-]/;
		// `src/file.ts.`처럼 문장 끝 마침표가 붙는 경우는 정확한 경로 언급입니다.
		// 반대로 `src/file.tsx`의 추가 문자는 더 긴 파일명이므로 일치로 보지 않습니다.
		const nextIsBoundary = !pathCharacter.test(next)
			|| (next === '.' && !/[A-Za-z0-9_-]/.test(afterNext));

		if (!pathCharacter.test(previous) && nextIsBoundary) {
			return true;
		}
		startIndex = userPrompt.indexOf(targetPath, startIndex + 1);
	}
	return false;
}
