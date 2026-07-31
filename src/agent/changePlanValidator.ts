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

export interface ChangePlanValidationContext {
	userPrompt: string;
	schemaPath?: string;
}

export interface ChangePlanValidationResult {
	valid: boolean;
	errors: string[];
}

const schemaValidators = new Map<string, ValidateFunction<ChangePlan>>();

/**
 * JSON Schema는 객체 모양과 필수 필드를, 이 함수의 후반부는 여러 배열 사이의
 * 의미적 연결을 검사합니다. 두 검사를 분리하면 Schema를 Codex의 output-schema와
 * 동일하게 재사용하면서도 JSON Schema로 표현하기 어려운 Crispy 규약을 놓치지 않습니다.
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

function formatSchemaError(error: ErrorObject): string {
	const location = error.instancePath || '/';
	return `Schema ${location}: ${error.message ?? error.keyword}`;
}

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

function validateUniqueStrings(values: string[], label: string, errors: Set<string>): void {
	const uniqueValues = new Set(values);
	if (uniqueValues.size !== values.length) {
		errors.add(`${label}에 중복 값이 있습니다.`);
	}
}

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

function addPathUsage(usageByPath: Map<string, Set<string>>, targetPath: string, taskId: string): void {
	const usages = usageByPath.get(targetPath) ?? new Set<string>();
	usages.add(taskId);
	usageByPath.set(targetPath, usages);
}

function sameStringSet(values: string[], expected: Set<string>): boolean {
	return values.length === expected.size && values.every((value) => expected.has(value));
}

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
