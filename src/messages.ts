import type {
	HostToWebviewWireMessage,
	WebviewToHostWireMessage,
} from './agent/protocol';
import type { Graph } from './webview/graph/graphModel';
import { parseGraph } from './webview/graph/graphTransport';
import type { WebviewSessionState } from './webview/webviewState';
import type { WorkspacePersistentState } from './workspace/workspaceMetadata';

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

/** Webview에서 Extension Host로 전송하는 Agent wire 및 상태 경계 메시지다. */
export type WebviewToExtensionMessage =
	| WebviewToHostWireMessage
	| WebviewStateChangedMessage
	| WorkspaceStateChangedMessage;

/** Extension Host에서 Webview로 전송하는 Workspace 도메인 메시지다. */
export type WorkspaceToWebviewMessage = {
	type: 'workspace.graphUpdated';
	graph: Graph;
};

/** Extension Host에서 Webview로 전송하는 Agent wire 및 Workspace 메시지다. */
export type ExtensionToWebviewMessage =
	| HostToWebviewWireMessage
	| WorkspaceToWebviewMessage;

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
		candidate.type !== 'workspace.graphUpdated'
		|| Object.keys(candidate).length !== 2
		|| !Object.hasOwn(candidate, 'graph')
	) {
		return undefined;
	}

	const graph = parseGraph(candidate.graph);

	return graph ? { type: 'workspace.graphUpdated', graph } : undefined;
}

/** `src/agent/protocol`이 공개하는 타입을 기존 import 경로에서도 재노출한다. */
export type * from './agent/protocol';
