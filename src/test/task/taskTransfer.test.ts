import * as assert from 'assert';
import {
	createDefaultTaskBlueprint,
	DEFAULT_WORK_AGENT_PROVIDER_ID,
	TASK_BLUEPRINT_VERSION,
	type TaskBlueprint,
	type TaskIdSource,
} from '../../task/taskModel';
import {
	materializeTaskTransfer,
	parseTaskTransferJson,
	serializeTaskTransfer,
	trySerializeTaskTransfer,
	TASK_TRANSFER_FORMAT,
	TASK_TRANSFER_JSON_MAX_BYTES,
	TASK_TRANSFER_LIMITS,
	TASK_TRANSFER_VERSION,
	type TaskTransferDocument,
	type TaskTransferIssueCode,
	type TaskTransferParseResult,
} from '../../task/taskTransfer';
import {
	getTaskFlowStatus,
	validateTaskBlueprint,
} from '../../task/taskValidation';

suite('Task Transfer', () => {
	test('export는 inspector·local 배치·Edge만 문서 key로 저장한다', () => {
		const task = createSourceTask();
		const json = serializeTaskTransfer(task);
		const parsed = JSON.parse(json) as unknown;

		assert.deepStrictEqual(parsed, createExpectedTransferDocument());
		assert.strictEqual(json.includes(task.id), false);
		assert.strictEqual(json.includes('folder:file:///source/reference'), false);
		assert.strictEqual(json.includes('file:file:///source/work.ts'), false);
		assert.ok(Buffer.byteLength(json, 'utf8') <= TASK_TRANSFER_JSON_MAX_BYTES);
	});

	test('non-throwing export는 정상 Task에 기존 serializer와 같은 JSON을 반환한다', () => {
		const task = createSourceTask();
		const result = trySerializeTaskTransfer(task);

		assert.ok(result.ok);
		assert.strictEqual(result.json, serializeTaskTransfer(task));
	});

	test('non-throwing export는 Node 수와 전체 JSON 한도를 typed 실패로 반환한다', () => {
		const base = createDefaultTaskBlueprint(
			{ title: 'Oversized Task' },
			createSequentialIdSource('oversized'),
		);
		const start = requireNode(base, 'start');
		const end = requireNode(base, 'end');
		const works = Array.from(
			{ length: TASK_TRANSFER_LIMITS.maxNodes - 1 },
			(_, index) => ({
				id: `task-node:oversized-work-${index}`,
				kind: 'work' as const,
				title: '',
				description: '',
				prompt: '',
				agentProviderId: DEFAULT_WORK_AGENT_PROVIDER_ID,
				graphTargets: { reference: [], work: [] },
			}),
		);
		const tooManyNodes: TaskBlueprint = {
			...base,
			nodes: [start, ...works, end],
			nodePositions: {
				...Object.fromEntries(works.map((work, index) => [
					work.id,
					{ x: index * 16, y: 0 },
				])),
				[end.id]: { x: works.length * 16, y: 0 },
			},
			edges: [],
		};
		const source = createSourceTask();
		const tooLargeJson: TaskBlueprint = {
			...source,
			nodes: source.nodes.map((node) => node.kind === 'work'
				? { ...node, prompt: 'x'.repeat(TASK_TRANSFER_JSON_MAX_BYTES) }
				: node),
		};

		assert.deepStrictEqual(validateTaskBlueprint(tooManyNodes), []);
		assert.deepStrictEqual(trySerializeTaskTransfer(tooManyNodes), {
			ok: false,
			reason: 'transfer_limit',
		});
		assert.deepStrictEqual(validateTaskBlueprint(tooLargeJson), []);
		assert.deepStrictEqual(trySerializeTaskTransfer(tooLargeJson), {
			ok: false,
			reason: 'transfer_limit',
		});
	});

	test('import는 대상 Task identity/origin을 유지하고 내부 상태를 새 ID로 교체한다', () => {
		const source = createSourceTask();
		const parsed = requireSuccess(parseTaskTransferJson(
			serializeTaskTransfer(source),
		));
		const target = createTargetTask();
		const targetStart = requireNode(target, 'start');
		const targetEnd = requireNode(target, 'end');
		const targetWork = requireNode(target, 'work');
		const materialized = materializeTaskTransfer(
			parsed,
			target,
			createSequentialIdSource('import'),
		);
		const nodesByKind = {
			start: materialized.nodes.filter((node) => node.kind === 'start'),
			work: materialized.nodes.filter((node) => node.kind === 'work'),
			end: materialized.nodes.filter((node) => node.kind === 'end'),
		};

		assert.strictEqual(materialized.version, TASK_BLUEPRINT_VERSION);
		assert.strictEqual(materialized.id, target.id);
		assert.deepStrictEqual(materialized.origin, target.origin);
		assert.notStrictEqual(materialized.origin, target.origin);
		assert.strictEqual(materialized.title, 'Shared Task');
		assert.strictEqual(materialized.description, 'Transferred description');
		assert.deepStrictEqual(materialized.defaultGraphTargets, {
			reference: [],
			work: [],
		});
		assert.deepStrictEqual(nodesByKind.start, [{
			id: targetStart.id,
			kind: 'start',
		}]);
		assert.deepStrictEqual(nodesByKind.end, [{
			id: targetEnd.id,
			kind: 'end',
		}]);
		assert.deepStrictEqual(nodesByKind.work, [{
			id: 'task-node:import-1',
			kind: 'work',
			title: 'Research',
			description: 'Read the codebase',
			prompt: 'Inspect relevant files.',
			agentProviderId: 'codex',
			graphTargets: { reference: [], work: [] },
		}, {
			id: 'task-node:import-2',
			kind: 'work',
			title: 'Implement',
			description: 'Apply the change',
			prompt: 'Implement and verify.',
			agentProviderId: 'claude',
			graphTargets: { reference: [], work: [] },
		}]);
		assert.strictEqual(
			materialized.nodes.some((node) => node.id === targetWork.id),
			false,
		);
		assert.deepStrictEqual(materialized.nodePositions, {
			'task-node:import-1': { x: 280, y: -96 },
			'task-node:import-2': { x: 420, y: 312 },
			[targetEnd.id]: { x: 760, y: 48 },
		});
		assert.deepStrictEqual(materialized.edges, [{
			id: 'task-edge:import-3',
			source: targetStart.id,
			target: 'task-node:import-1',
		}, {
			id: 'task-edge:import-4',
			source: 'task-node:import-1',
			target: 'task-node:import-2',
		}, {
			id: 'task-edge:import-5',
			source: 'task-node:import-2',
			target: targetEnd.id,
		}]);
		assert.deepStrictEqual(validateTaskBlueprint(materialized), []);
		assert.strictEqual(getTaskFlowStatus(materialized), 'ready');
	});

	test('Edge 없는 incomplete Task와 빈 inspector 입력도 정상 import한다', () => {
		const document: TaskTransferDocument = {
			format: TASK_TRANSFER_FORMAT,
			version: TASK_TRANSFER_VERSION,
			task: {
				title: '',
				description: '',
				nodes: [{ key: 'entry', kind: 'start' }, {
					key: 'draft',
					kind: 'work',
					title: '',
					description: '',
					prompt: '',
					agentProviderId: DEFAULT_WORK_AGENT_PROVIDER_ID,
					position: { x: 32, y: 64 },
				}, {
					key: 'exit',
					kind: 'end',
					position: { x: 640, y: 0 },
				}],
				edges: [],
			},
		};
		const parsed = requireSuccess(parseUnknown(document));
		const task = materializeTaskTransfer(
			parsed,
			createDefaultTaskBlueprint({ title: 'Target' }, createSequentialIdSource()),
			() => 'new-work',
		);

		assert.deepStrictEqual(validateTaskBlueprint(task), []);
		assert.strictEqual(getTaskFlowStatus(task), 'incomplete');
		assert.deepStrictEqual(task.edges, []);
	});

	test('parser는 JSON 문법, 필수 필드와 알 수 없는 Workspace 필드를 명시적으로 거부한다', () => {
		assertFailure(parseTaskTransferJson('{'), ['invalid_json']);
		assertFailure(parseUnknown({
			format: TASK_TRANSFER_FORMAT,
			version: TASK_TRANSFER_VERSION,
		}), ['missing_property', 'invalid_type']);

		const valid = createExpectedTransferDocument();
		const unknownRoot = { ...valid, origin: { x: 100, y: 200 } };
		const unknownTask = {
			...valid,
			task: {
				...valid.task,
				defaultGraphTargets: { reference: ['private'], work: [] },
			},
		};
		const unknownWork = {
			...valid,
			task: {
				...valid.task,
				nodes: valid.task.nodes.map((node) => node.kind === 'work'
					? {
						...node,
						graphTargets: { reference: [], work: ['private'] },
					}
					: node),
			},
		};

		assertIssuePath(parseUnknown(unknownRoot), 'unknown_property', '$.origin');
		assertIssuePath(
			parseUnknown(unknownTask),
			'unknown_property',
			'$.task.defaultGraphTargets',
		);
		assertIssuePath(
			parseUnknown(unknownWork),
			'unknown_property',
			'$.task.nodes[1].graphTargets',
		);
	});

	test('parser는 version, provider, position과 Node key schema를 strict하게 검사한다', () => {
		const valid = createExpectedTransferDocument();

		assertIssuePath(
			parseUnknown({ ...valid, version: 2 }),
			'invalid_value',
			'$.version',
		);
		assertIssuePath(parseUnknown({
			...valid,
			task: {
				...valid.task,
				nodes: valid.task.nodes.map((node) => node.kind === 'work'
					? { ...node, agentProviderId: 'gemini' }
					: node),
			},
		}), 'invalid_value', '$.task.nodes[1].agentProviderId');
		assertIssuePath(parseUnknown({
			...valid,
			task: {
				...valid.task,
				nodes: valid.task.nodes.map((node) => node.kind === 'end'
					? { ...node, position: { x: null, y: 0 } }
					: node),
			},
		}), 'invalid_type', '$.task.nodes[3].position.x');
		assertIssuePath(parseUnknown({
			...valid,
			task: {
				...valid.task,
				nodes: valid.task.nodes.map((node) => node.kind === 'start'
					? { ...node, key: '' }
					: node),
			},
		}), 'invalid_value', '$.task.nodes[0].key');
	});

	test('parser는 중복/dangling/direct/self/cycle Edge를 기존 Task 규칙으로 거부한다', () => {
		const valid = createExpectedTransferDocument();

		assertFailure(parseUnknown({
			...valid,
			task: {
				...valid.task,
				nodes: valid.task.nodes.map((node, index) => index === 2
					? { ...node, key: 'work-1' }
					: node),
			},
		}), ['duplicate_node_id']);
		assertFailure(parseUnknown({
			...valid,
			task: {
				...valid.task,
				edges: [{ source: 'missing', target: 'work-1' }],
			},
		}), ['edge_source_missing']);
		assertFailure(parseUnknown({
			...valid,
			task: {
				...valid.task,
				edges: [{ source: 'start', target: 'end' }],
			},
		}), ['start_end_direct_edge']);
		assertFailure(parseUnknown({
			...valid,
			task: {
				...valid.task,
				edges: [{ source: 'work-1', target: 'work-1' }],
			},
		}), ['self_edge']);
		assertFailure(parseUnknown({
			...valid,
			task: {
				...valid.task,
				edges: [{ source: 'work-1', target: 'work-2' }, {
					source: 'work-2',
					target: 'work-1',
				}],
			},
		}), ['cycle']);
	});

	test('parser는 UTF-8 byte, Node 수와 Edge 수 제한을 적용한다', () => {
		const oversizedUtf8 = JSON.stringify(
			'한'.repeat(Math.floor(TASK_TRANSFER_JSON_MAX_BYTES / 3) + 1),
		);

		assert.ok(oversizedUtf8.length < TASK_TRANSFER_JSON_MAX_BYTES);
		assert.ok(Buffer.byteLength(oversizedUtf8, 'utf8') > TASK_TRANSFER_JSON_MAX_BYTES);
		assertFailure(parseTaskTransferJson(oversizedUtf8), ['document_too_large']);

		const valid = createExpectedTransferDocument();
		assertFailure(parseUnknown({
			...valid,
			task: {
				...valid.task,
				nodes: Array.from(
					{ length: TASK_TRANSFER_LIMITS.maxNodes + 1 },
					(_, index) => ({ key: `node-${index}`, kind: 'start' }),
				),
			},
		}), ['limit_exceeded']);
		assertFailure(parseUnknown({
			...valid,
			task: {
				...valid.task,
				edges: Array.from(
					{ length: TASK_TRANSFER_LIMITS.maxEdges + 1 },
					() => ({ source: 'start', target: 'work-1' }),
				),
			},
		}), ['limit_exceeded']);
	});

	test('materialize는 typed 객체로 위장한 잘못된 문서도 다시 검증한다', () => {
		const invalid = {
			...createExpectedTransferDocument(),
			unexpected: 'workspace-data',
		} as unknown as TaskTransferDocument;

		assert.throws(
			() => materializeTaskTransfer(invalid, createTargetTask()),
			/Invalid TaskTransferDocument.*Unknown Task transfer property/,
		);
	});
});

/** export가 생성해야 할 runtime-independent 문서를 만든다. */
function createExpectedTransferDocument(): TaskTransferDocument {
	return {
		format: TASK_TRANSFER_FORMAT,
		version: TASK_TRANSFER_VERSION,
		task: {
			title: 'Shared Task',
			description: 'Transferred description',
			nodes: [{ key: 'start', kind: 'start' }, {
				key: 'work-1',
				kind: 'work',
				title: 'Research',
				description: 'Read the codebase',
				prompt: 'Inspect relevant files.',
				agentProviderId: 'codex',
				position: { x: 280, y: -96 },
			}, {
				key: 'work-2',
				kind: 'work',
				title: 'Implement',
				description: 'Apply the change',
				prompt: 'Implement and verify.',
				agentProviderId: 'claude',
				position: { x: 420, y: 312 },
			}, {
				key: 'end',
				kind: 'end',
				position: { x: 760, y: 48 },
			}],
			edges: [{ source: 'start', target: 'work-1' }, {
				source: 'work-1',
				target: 'work-2',
			}, {
				source: 'work-2',
				target: 'end',
			}],
		},
	};
}

/** Graph Target까지 채운 공유 원본 Task를 만든다. */
function createSourceTask(): TaskBlueprint {
	const startId = 'task-node:source-start';
	const researchId = 'task-node:source-research';
	const implementId = 'task-node:source-implement';
	const endId = 'task-node:source-end';

	return {
		version: TASK_BLUEPRINT_VERSION,
		id: 'task:source',
		title: 'Shared Task',
		description: 'Transferred description',
		defaultGraphTargets: {
			reference: ['folder:file:///source/reference'],
			work: ['file:file:///source/work.ts'],
		},
		origin: { x: -900, y: 1440 },
		nodePositions: {
			[researchId]: { x: 280, y: -96 },
			[implementId]: { x: 420, y: 312 },
			[endId]: { x: 760, y: 48 },
		},
		nodes: [{ id: startId, kind: 'start' }, {
			id: researchId,
			kind: 'work',
			title: 'Research',
			description: 'Read the codebase',
			prompt: 'Inspect relevant files.',
			agentProviderId: 'codex',
			graphTargets: {
				reference: ['folder:file:///source/reference'],
				work: [],
			},
		}, {
			id: implementId,
			kind: 'work',
			title: 'Implement',
			description: 'Apply the change',
			prompt: 'Implement and verify.',
			agentProviderId: 'claude',
			graphTargets: {
				reference: [],
				work: ['file:file:///source/work.ts'],
			},
		}, { id: endId, kind: 'end' }],
		edges: [{
			id: 'task-edge:source-1',
			source: startId,
			target: researchId,
		}, {
			id: 'task-edge:source-2',
			source: researchId,
			target: implementId,
		}, {
			id: 'task-edge:source-3',
			source: implementId,
			target: endId,
		}],
	};
}

/** 기존 내부 상태와 Graph Target을 가진 import 대상 Task를 만든다. */
function createTargetTask(): TaskBlueprint {
	const startId = 'task-node:target-start';
	const workId = 'task-node:target-old-work';
	const endId = 'task-node:target-end';

	return {
		version: TASK_BLUEPRINT_VERSION,
		id: 'task:target',
		title: 'Local Task',
		description: 'Will be replaced',
		defaultGraphTargets: {
			reference: ['folder:file:///target/reference'],
			work: ['folder:file:///target/work'],
		},
		origin: { x: 840, y: -220 },
		nodePositions: {
			[workId]: { x: 320, y: 0 },
			[endId]: { x: 640, y: 0 },
		},
		nodes: [{ id: startId, kind: 'start' }, {
			id: workId,
			kind: 'work',
			title: 'Old Work',
			description: 'Old description',
			prompt: 'Old prompt',
			agentProviderId: 'codex',
			graphTargets: {
				reference: ['file:file:///target/old.ts'],
				work: ['file:file:///target/old.ts'],
			},
		}, { id: endId, kind: 'end' }],
		edges: [{
			id: 'task-edge:target-1',
			source: startId,
			target: workId,
		}, {
			id: 'task-edge:target-2',
			source: workId,
			target: endId,
		}],
	};
}

/** JSON stringify를 거쳐 unknown 외부 입력 경계를 재현한다. */
function parseUnknown(value: unknown): TaskTransferParseResult {
	return parseTaskTransferJson(JSON.stringify(value));
}

/** 성공 결과에서 typed document만 꺼낸다. */
function requireSuccess(result: TaskTransferParseResult): TaskTransferDocument {
	if (!result.ok) {
		assert.fail(result.issues.map((issue) => issue.message).join(' '));
	}

	return result.document;
}

/** 실패 결과가 지정 issue code를 모두 포함하는지 확인한다. */
function assertFailure(
	result: TaskTransferParseResult,
	expectedCodes: readonly TaskTransferIssueCode[],
): void {
	if (result.ok) {
		assert.fail('Expected Task transfer parsing to fail.');
	}
	const actualCodes = result.issues.map((issue) => issue.code);

	for (const expectedCode of expectedCodes) {
		assert.ok(
			actualCodes.includes(expectedCode),
			`Expected ${expectedCode}; received ${actualCodes.join(', ')}`,
		);
	}
}

/** 지정 code와 JSON path가 같은 issue가 존재하는지 확인한다. */
function assertIssuePath(
	result: TaskTransferParseResult,
	code: TaskTransferIssueCode,
	path: string,
): void {
	if (result.ok) {
		assert.fail('Expected Task transfer parsing to fail.');
	}
	assert.ok(
		result.issues.some((issue) => issue.code === code && issue.path === path),
		`Expected ${code} at ${path}; received ${result.issues
			.map((issue) => `${issue.code}@${issue.path}`)
			.join(', ')}`,
	);
}

/** kind Node를 fixture에서 안전하게 조회한다. */
function requireNode(
	task: TaskBlueprint,
	kind: TaskBlueprint['nodes'][number]['kind'],
): TaskBlueprint['nodes'][number] {
	const node = task.nodes.find((candidate) => candidate.kind === kind);

	assert.ok(node);
	return node;
}

/** 호출 순서를 ID suffix로 노출하는 테스트용 생성 함수를 만든다. */
function createSequentialIdSource(prefix = 'id'): TaskIdSource {
	let sequence = 0;
	return () => `${prefix}-${++sequence}`;
}
