import type {
	HostToWebviewWireMessage,
	WebviewToHostWireMessage,
} from './agent/protocol';
import type { WebviewSessionState } from './webview/webviewState';
import type { WorkspacePersistentState } from './workspace/workspaceMetadata';
import {
	parseWorkspacePresentation,
	type WorkspacePresentation,
} from './workspace/workspacePresentation';

/** Webview Session snapshot 변경을 Extension Host에 전달하는 상태 경계 메시지다. */
export interface WebviewStateChangedMessage {
	type: 'webview.stateChanged';
	state: WebviewSessionState;
}

/** Workspace Persistent State 전체 snapshot 변경을 Extension Host에 전달한다. */
export interface WorkspaceStateChangedMessage {
	type: 'workspace.stateChanged';
	state: WorkspacePersistentState;
}

/** Graph File ID로 Workspace 파일 열기를 Extension Host에 요청한다. */
export interface WorkspaceOpenFileMessage {
	type: 'workspace.openFile';
	fileId: string;
}

/** Webview에서 Extension Host로 전송하는 Agent wire 및 상태 경계 메시지다. */
export type WebviewToExtensionMessage =
	| WebviewToHostWireMessage
	| WebviewStateChangedMessage
	| WorkspaceStateChangedMessage
	| WorkspaceOpenFileMessage;

/** Extension Host에서 Webview로 전송하는 Workspace 도메인 메시지다. */
export type WorkspaceToWebviewMessage = {
	type: 'workspace.snapshotUpdated';
	presentation: WorkspacePresentation;
};

/** Host가 지정할 수 있는 Graph Node 시각 효과 종류다. */
export type GraphNodeEffectKind =
	| 'marching-dash'
	| 'pulse'
	| 'shimmer'
	| 'outline'
	| 'outline-strong'
	| 'icon';

/** Source Node 전체 또는 특정 Detached Root occurrence를 지정한다. */
export interface GraphNodeEffectTarget {
	readonly nodeId: string;
	readonly rootId?: string;
}

/** Webview가 의미 상태를 해석하지 않고 그대로 표현하는 시각 효과 계약이다. */
export type GraphNodeEffect =
	| {
		readonly kind: 'marching-dash' | 'pulse' | 'shimmer' | 'outline'
			| 'outline-strong';
		readonly color: string;
	}
	| {
		readonly kind: 'icon';
		readonly color: string;
		readonly icon: 'check' | 'cancel' | 'alert';
	};

/** Graph Node에 같은 kind의 기존 효과를 교체하며 적용한다. */
export interface GraphNodeEffectSetMessage {
	type: 'graph.nodeEffect.set';
	target: GraphNodeEffectTarget;
	effect: GraphNodeEffect;
}

/** Graph Node의 특정 kind 또는 모든 효과를 제거한다. */
export interface GraphNodeEffectClearMessage {
	type: 'graph.nodeEffect.clear';
	target: GraphNodeEffectTarget;
	kind?: GraphNodeEffectKind;
}

/** Extension Host에서 Webview로 전송하는 transient Graph 효과 메시지다. */
export type GraphNodeEffectToWebviewMessage =
	| GraphNodeEffectSetMessage
	| GraphNodeEffectClearMessage;

/** Extension Host에서 Webview로 전송하는 Agent wire 및 Workspace 메시지다. */
export type ExtensionToWebviewMessage =
	| HostToWebviewWireMessage
	| WorkspaceToWebviewMessage
	| GraphNodeEffectToWebviewMessage;

/** unknown Host 메시지에서 transient Graph 효과 계약을 구조적으로 검증한다. */
export function parseGraphNodeEffectToWebviewMessage(
	value: unknown,
): GraphNodeEffectToWebviewMessage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (value.type === 'graph.nodeEffect.set') {
		if (!hasExactKeys(value, ['type', 'target', 'effect'])) {
			return undefined;
		}
		const target = parseGraphNodeEffectTarget(value.target);
		const effect = parseGraphNodeEffect(value.effect);

		return target && effect
			? { type: 'graph.nodeEffect.set', target, effect }
			: undefined;
	}

	if (value.type === 'graph.nodeEffect.clear') {
		if (!hasOnlyKeys(value, ['type', 'target', 'kind'])) {
			return undefined;
		}
		const target = parseGraphNodeEffectTarget(value.target);
		const kind = value.kind;

		if (
			!target
			|| (kind !== undefined && !isGraphNodeEffectKind(kind))
		) {
			return undefined;
		}

		return {
			type: 'graph.nodeEffect.clear',
			target,
			...(kind ? { kind } : {}),
		};
	}

	return undefined;
}

function parseGraphNodeEffectTarget(
	value: unknown,
): GraphNodeEffectTarget | undefined {
	if (
		!isRecord(value)
		|| !hasOnlyKeys(value, ['nodeId', 'rootId'])
		|| typeof value.nodeId !== 'string'
		|| value.nodeId.length === 0
		|| (
			value.rootId !== undefined
			&& (typeof value.rootId !== 'string' || value.rootId.length === 0)
		)
	) {
		return undefined;
	}

	return {
		nodeId: value.nodeId,
		...(typeof value.rootId === 'string' ? { rootId: value.rootId } : {}),
	};
}

function parseGraphNodeEffect(value: unknown): GraphNodeEffect | undefined {
	if (
		!isRecord(value)
		|| typeof value.color !== 'string'
		|| value.color.length === 0
		|| !isGraphNodeEffectKind(value.kind)
	) {
		return undefined;
	}

	if (value.kind === 'icon') {
		if (
			!hasExactKeys(value, ['kind', 'color', 'icon'])
			|| (
				value.icon !== 'check'
				&& value.icon !== 'cancel'
				&& value.icon !== 'alert'
			)
		) {
			return undefined;
		}

		return { kind: value.kind, color: value.color, icon: value.icon };
	}

	return hasExactKeys(value, ['kind', 'color'])
		? { kind: value.kind, color: value.color }
		: undefined;
}

function isGraphNodeEffectKind(value: unknown): value is GraphNodeEffectKind {
	return value === 'marching-dash'
		|| value === 'pulse'
		|| value === 'shimmer'
		|| value === 'outline'
		|| value === 'outline-strong'
		|| value === 'icon';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);

	return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * unknown Host 메시지에서 현재 Workspace 도메인 계약만 구조적으로 검증한다.
 * 다른 도메인 메시지와 잘못된 Graph는 기존 수신 정책과 같이 조용히 무시한다.
 */
export function parseWorkspaceToWebviewMessage(
	value: unknown,
): WorkspaceToWebviewMessage | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;

	if (
		candidate.type !== 'workspace.snapshotUpdated'
		|| Object.keys(candidate).length !== 2
		|| !Object.hasOwn(candidate, 'presentation')
	) {
		return undefined;
	}

	const presentation = parseWorkspacePresentation(candidate.presentation);

	return presentation
		? { type: 'workspace.snapshotUpdated', presentation }
		: undefined;
}

/** `src/agent/protocol`이 공개하는 타입을 기존 import 경로에서도 재노출한다. */
export type * from './agent/protocol';
