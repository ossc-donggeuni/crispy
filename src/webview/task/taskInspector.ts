import { AGENT_PROVIDER_LABELS } from '../../agent/UI/agentProviders';
import {
	isWorkAgentProviderId,
	WORK_AGENT_PROVIDER_IDS,
	type WorkAgentProviderId,
} from '../../task';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	type GraphCamera,
	type GraphPoint,
} from '../graph/graphCamera';
import type {
	TaskGraphLayout,
	TaskLayoutNode,
	TaskStartLayoutNode,
	TaskWorkLayoutNode,
} from './taskLayout';

/** GraphView가 소유하는 단일 transient Task Focus UI state다. */
export interface FocusedTaskNode {
	readonly taskId: string;
	readonly nodeId: string;
}

/** START Inspector가 TaskBlueprint에 반영할 수 있는 입력이다. */
export interface TaskStartInspectorFieldInput extends FocusedTaskNode {
	readonly kind: 'start';
	readonly field: 'title' | 'description';
	readonly value: string;
}

/** WORK Inspector가 WorkNode에 반영할 수 있는 입력이다. */
export type TaskWorkInspectorFieldInput = FocusedTaskNode & (
	| {
		readonly kind: 'work';
		readonly field: 'title' | 'description' | 'prompt';
		readonly value: string;
	}
	| {
		readonly kind: 'work';
		readonly field: 'agentProviderId';
		readonly value: WorkAgentProviderId;
	}
);

/** Inspector의 즉시 편집 요청을 kind와 field로 구분한다. */
export type TaskInspectorFieldInput =
	| TaskStartInspectorFieldInput
	| TaskWorkInspectorFieldInput;

/** Inspector DOM과 위치 projection lifecycle이다. */
export interface TaskInspector {
	/** GraphView의 단일 Focus state와 최신 Layout을 DOM에 투영한다. */
	apply(
		focusedTaskNode: FocusedTaskNode | undefined,
		layout: TaskGraphLayout,
	): void;
	/** 최신 Camera state로 현재 Inspector 위치를 다시 계산한다. */
	refreshPosition(): void;
	/** Inspector DOM과 등록한 listener를 정리한다. */
	dispose(): void;
}

/** Inspector 입력을 Task State 갱신 경계로 전달한다. */
export interface TaskInspectorInteractions {
	onFieldInput?: (input: TaskInspectorFieldInput) => void;
}

/** Inspector root를 식별하는 DOM attribute다. */
export const TASK_INSPECTOR_ATTRIBUTE = 'data-task-inspector';
/** Inspector가 편집하는 Task를 식별하는 DOM attribute다. */
export const TASK_INSPECTOR_TASK_ID_ATTRIBUTE = 'data-task-inspector-task-id';
/** Inspector가 편집하는 Node를 식별하는 DOM attribute다. */
export const TASK_INSPECTOR_NODE_ID_ATTRIBUTE = 'data-task-inspector-node-id';
/** Inspector가 편집하는 START/WORK kind를 식별하는 DOM attribute다. */
export const TASK_INSPECTOR_KIND_ATTRIBUTE = 'data-task-inspector-kind';
/** Inspector control이 편집하는 Domain field를 식별하는 DOM attribute다. */
export const TASK_INSPECTOR_FIELD_ATTRIBUTE = 'data-task-inspector-field';

/** Camera scale과 무관한 Inspector viewport 폭이다. */
export const TASK_INSPECTOR_WIDTH = 320;
/** World Node와 Inspector 사이의 viewport pixel 간격이다. */
export const TASK_INSPECTOR_GAP = 12;
/** Inspector를 Viewport 가장자리에서 띄우는 최소 pixel 간격이다. */
export const TASK_INSPECTOR_VIEWPORT_INSET = 12;

type InspectableTaskLayoutNode = TaskStartLayoutNode | TaskWorkLayoutNode;
type TaskInspectorField = TaskInspectorFieldInput['field'];
type TaskInspectorControl =
	| HTMLInputElement
	| HTMLTextAreaElement
	| HTMLSelectElement;

interface TaskInspectorSelectOption {
	readonly value: WorkAgentProviderId;
	readonly label: string;
}

interface TaskInspectorFieldDescriptor {
	readonly field: TaskInspectorField;
	readonly label: string;
	readonly multiline?: boolean;
	readonly options?: readonly TaskInspectorSelectOption[];
	getValue(node: InspectableTaskLayoutNode): string;
}

interface MountedTaskInspector {
	readonly renderKey: string;
	readonly kind: InspectableTaskLayoutNode['kind'];
	readonly root: HTMLElement;
	readonly controls: ReadonlyMap<TaskInspectorField, TaskInspectorControl>;
}

const START_FIELD_DESCRIPTORS: readonly TaskInspectorFieldDescriptor[] = [
	{
		field: 'title',
		label: 'Title',
		getValue: (node) => node.title,
	},
	{
		field: 'description',
		label: 'Description',
		getValue: (node) => node.description,
	},
];

const WORK_FIELD_DESCRIPTORS: readonly TaskInspectorFieldDescriptor[] = [
	{
		field: 'agentProviderId',
		label: 'AI Agent',
		options: WORK_AGENT_PROVIDER_IDS.map((providerId) => ({
			value: providerId,
			label: AGENT_PROVIDER_LABELS[providerId],
		})),
		getValue: (node) => node.kind === 'work' ? node.agentProviderId : '',
	},
	...START_FIELD_DESCRIPTORS,
	{
		field: 'prompt',
		label: 'Prompt',
		multiline: true,
		getValue: (node) => node.kind === 'work' ? node.prompt : '',
	},
];

/**
 * Task Layout의 World geometry를 Camera로 투영하고 panel은 viewport pixel로 배치한다.
 * 오른쪽 공간이 부족할 때 왼쪽을 우선 사용하고, 양쪽 모두 부족하면 Viewport 안으로
 * 최소한 clamp한다. Panel width/height에는 Camera scale을 적용하지 않는다.
 */
export function calculateTaskInspectorPosition(
	node: TaskLayoutNode,
	camera: Pick<GraphCamera, 'worldToViewport'>,
	viewportSize: { readonly width: number; readonly height: number },
	inspectorSize: { readonly width: number; readonly height: number },
): GraphPoint {
	const nodeLeft = camera.worldToViewport(node.position);
	const nodeRight = camera.worldToViewport({
		x: node.position.x + node.width,
		y: node.position.y,
	});
	const desiredRight = nodeRight.x + TASK_INSPECTOR_GAP;
	const desiredLeft = nodeLeft.x - TASK_INSPECTOR_GAP - inspectorSize.width;
	const maxLeft = Math.max(
		TASK_INSPECTOR_VIEWPORT_INSET,
		viewportSize.width
			- inspectorSize.width
			- TASK_INSPECTOR_VIEWPORT_INSET,
	);
	const maxTop = Math.max(
		TASK_INSPECTOR_VIEWPORT_INSET,
		viewportSize.height
			- inspectorSize.height
			- TASK_INSPECTOR_VIEWPORT_INSET,
	);
	let left = desiredRight;

	if (
		desiredRight + inspectorSize.width
		> viewportSize.width - TASK_INSPECTOR_VIEWPORT_INSET
		&& desiredLeft >= TASK_INSPECTOR_VIEWPORT_INSET
	) {
		left = desiredLeft;
	}

	return {
		x: clamp(left, TASK_INSPECTOR_VIEWPORT_INSET, maxLeft),
		y: clamp(
		nodeRight.y,
		TASK_INSPECTOR_VIEWPORT_INSET,
		maxTop,
	),
	};
}

/** Graph overlay에 START/WORK 전용 controlled Floating Inspector를 생성한다. */
export function initializeTaskInspector(
	overlayLayer: HTMLElement,
	viewport: HTMLElement,
	camera: Pick<GraphCamera, 'worldToViewport'>,
	interactions: TaskInspectorInteractions = {},
): TaskInspector {
	const ownerDocument = overlayLayer.ownerDocument;
	let mounted: MountedTaskInspector | undefined;
	let currentNode: InspectableTaskLayoutNode | undefined;
	let disposed = false;

	const stopInteractionPropagation = (event: Event): void => {
		event.stopPropagation();
	};

	const handleControlEvent = (
		event: Event,
		controlKind: 'text' | 'select',
	): void => {
		if (!mounted || !isTaskInspectorControl(event.target)) {
			return;
		}

		const field = event.target.getAttribute(TASK_INSPECTOR_FIELD_ATTRIBUTE);
		const taskId = mounted.root.getAttribute(TASK_INSPECTOR_TASK_ID_ATTRIBUTE);
		const nodeId = mounted.root.getAttribute(TASK_INSPECTOR_NODE_ID_ATTRIBUTE);

		if (!taskId || !nodeId || !isTaskInspectorField(field)) {
			return;
		}
		if ((field === 'agentProviderId') !== (controlKind === 'select')) {
			return;
		}

		if (
			mounted.kind === 'start'
			&& (field === 'title' || field === 'description')
		) {
			interactions.onFieldInput?.({
				kind: mounted.kind,
				taskId,
				nodeId,
				field,
				value: event.target.value,
			});
		} else if (
			mounted.kind === 'work'
			&& field === 'agentProviderId'
			&& isWorkAgentProviderId(event.target.value)
		) {
			interactions.onFieldInput?.({
				kind: mounted.kind,
				taskId,
				nodeId,
				field,
				value: event.target.value,
			});
		} else if (
			mounted.kind === 'work'
			&& (field === 'title' || field === 'description' || field === 'prompt')
		) {
			interactions.onFieldInput?.({
				kind: mounted.kind,
				taskId,
				nodeId,
				field,
				value: event.target.value,
			});
		}
	};
	const handleInput = (event: Event): void => {
		handleControlEvent(event, 'text');
	};
	const handleChange = (event: Event): void => {
		handleControlEvent(event, 'select');
	};

	const removeMountedInspector = (): void => {
		if (!mounted) {
			currentNode = undefined;
			return;
		}

		mounted.root.removeEventListener('input', handleInput);
		mounted.root.removeEventListener('change', handleChange);
		for (const eventType of INSPECTOR_PROPAGATION_EVENT_TYPES) {
			mounted.root.removeEventListener(eventType, stopInteractionPropagation);
		}
		mounted.root.remove();
		mounted = undefined;
		currentNode = undefined;
	};

	const mountInspector = (node: InspectableTaskLayoutNode): void => {
		const root = ownerDocument.createElement('aside');
		const heading = ownerDocument.createElement('strong');
		const controls = new Map<TaskInspectorField, TaskInspectorControl>();
		const descriptors = node.kind === 'start'
			? START_FIELD_DESCRIPTORS
			: WORK_FIELD_DESCRIPTORS;

		root.className = 'task-inspector';
		root.setAttribute(TASK_INSPECTOR_ATTRIBUTE, '');
		root.setAttribute(TASK_INSPECTOR_TASK_ID_ATTRIBUTE, node.taskId);
		root.setAttribute(TASK_INSPECTOR_NODE_ID_ATTRIBUTE, node.id);
		root.setAttribute(TASK_INSPECTOR_KIND_ATTRIBUTE, node.kind);
		root.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
		root.setAttribute('aria-label', `Task ${node.kind} inspector`);
		heading.className = 'task-inspector-heading';
		heading.textContent = node.kind === 'start' ? 'START' : 'WORK';
		root.append(heading);

		for (const descriptor of descriptors) {
			const label = ownerDocument.createElement('label');
			const labelText = ownerDocument.createElement('span');
			const control = descriptor.options
				? ownerDocument.createElement('select')
				: descriptor.multiline
					? ownerDocument.createElement('textarea')
					: ownerDocument.createElement('input');

			label.className = 'task-inspector-field';
			labelText.className = 'task-inspector-field-label';
			labelText.textContent = descriptor.label;
			control.className = 'task-inspector-control';
			control.setAttribute(TASK_INSPECTOR_FIELD_ATTRIBUTE, descriptor.field);
			control.setAttribute('aria-label', descriptor.label);
			if (descriptor.options) {
				for (const descriptorOption of descriptor.options) {
					const option = ownerDocument.createElement('option');

					option.value = descriptorOption.value;
					option.textContent = descriptorOption.label;
					control.append(option);
				}
			} else if (descriptor.multiline) {
				(control as HTMLTextAreaElement).rows = 5;
			} else {
				(control as HTMLInputElement).type = 'text';
			}
			if (!descriptor.options) {
				control.setAttribute('autocomplete', 'off');
			}
			control.value = descriptor.getValue(node);
			label.append(labelText, control);
			root.append(label);
			controls.set(descriptor.field, control);
		}

		root.addEventListener('input', handleInput);
		root.addEventListener('change', handleChange);
		for (const eventType of INSPECTOR_PROPAGATION_EVENT_TYPES) {
			root.addEventListener(eventType, stopInteractionPropagation);
		}
		overlayLayer.append(root);
		mounted = {
			renderKey: createTaskNodeRenderKey(node.taskId, node.id),
			kind: node.kind,
			root,
			controls,
		};
	};

	const refreshPosition = (): void => {
		if (!mounted || !currentNode || disposed) {
			return;
		}

		const availableWidth = Math.max(
			0,
			viewport.clientWidth - TASK_INSPECTOR_VIEWPORT_INSET * 2,
		);
		const width = Math.min(TASK_INSPECTOR_WIDTH, availableWidth);

		mounted.root.style.width = `${width}px`;
		const measuredHeight = mounted.root.offsetHeight;
		const fallbackHeight = mounted.kind === 'work' ? 368 : 192;
		const position = calculateTaskInspectorPosition(
			currentNode,
			camera,
			{
				width: viewport.clientWidth,
				height: viewport.clientHeight,
			},
			{
				width,
				height: measuredHeight > 0 ? measuredHeight : fallbackHeight,
			},
		);

		mounted.root.style.left = `${position.x}px`;
		mounted.root.style.top = `${position.y}px`;
	};

	const apply = (
		focusedTaskNode: FocusedTaskNode | undefined,
		layout: TaskGraphLayout,
	): void => {
		if (disposed) {
			return;
		}

		const node = focusedTaskNode
			? layout.nodes.find((candidate) => (
				candidate.taskId === focusedTaskNode.taskId
				&& candidate.id === focusedTaskNode.nodeId
				&& (candidate.kind === 'start' || candidate.kind === 'work')
			)) as InspectableTaskLayoutNode | undefined
			: undefined;

		if (!node) {
			removeMountedInspector();
			return;
		}

		const renderKey = createTaskNodeRenderKey(node.taskId, node.id);

		if (
			!mounted
			|| mounted.renderKey !== renderKey
			|| mounted.kind !== node.kind
		) {
			removeMountedInspector();
			mountInspector(node);
		}

		currentNode = node;
		const descriptors = node.kind === 'start'
			? START_FIELD_DESCRIPTORS
			: WORK_FIELD_DESCRIPTORS;

		for (const descriptor of descriptors) {
			const control = mounted?.controls.get(descriptor.field);
			const value = descriptor.getValue(node);

			// 같은 input event가 Task State/Layout을 round-trip해도 caret을 건드리지 않는다.
			if (control && control.value !== value) {
				control.value = value;
			}
		}
		refreshPosition();
	};

	return {
		apply,
		refreshPosition,
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			removeMountedInspector();
		},
	};
}

const INSPECTOR_PROPAGATION_EVENT_TYPES = [
	'pointerdown',
	'pointermove',
	'pointerup',
	'click',
	'dblclick',
	'wheel',
] as const;

function createTaskNodeRenderKey(taskId: string, nodeId: string): string {
	return `${taskId}:${nodeId}`;
}

function isTaskInspectorControl(
	target: EventTarget | null,
): target is TaskInspectorControl {
	return target !== null
		&& typeof (target as Element).getAttribute === 'function'
		&& (target as Element).hasAttribute(TASK_INSPECTOR_FIELD_ATTRIBUTE)
		&& typeof (target as HTMLInputElement).value === 'string';
}

function isTaskInspectorField(value: string | null): value is TaskInspectorField {
	return value === 'title'
		|| value === 'description'
		|| value === 'prompt'
		|| value === 'agentProviderId';
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
