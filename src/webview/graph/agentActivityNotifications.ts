import type {
	AgentActivityStoreSnapshot,
	AgentSessionActivitySnapshot,
} from '../../agent/webview/agentActivityStore';
import {
	AGENT_SESSION_UNTITLED_TITLE,
	AGENT_SESSION_WAITING_MESSAGE,
	type AgentSessionPresentationStore,
} from '../../agent/webview/agentSessionPresentationStore';
import type {
	AgentActivityKind,
	GraphNodeEffectTarget,
} from '../../messages';
import type {
	Graph,
	GraphRoot,
	GraphRootNode,
	ProjectEntry,
} from './graphModel';
import {
	getGraphNodeUriRelativeSegments,
	getNormalizedGraphUriPathLength,
	parseGraphNodeUri,
} from './graphNodeUri';

export type AgentActivityNotificationTargetKind =
	| GraphRootNode['kind']
	| 'unavailable';

/** 알림 목록 한 행이 표시하고 상호작용에 사용하는 현재 Activity snapshot이다. */
export interface AgentActivityNotificationEntry {
	readonly key: string;
	readonly sessionId: string;
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly activity: AgentActivityKind;
	readonly sequence: number;
	/** 탭·Graph 이벤트와 같은 Webview 세션 할당 색상이다. */
	readonly sessionColor: string;
	readonly sessionTitle: string;
	readonly currentMessage: string;
	readonly targetName: string;
	readonly targetPath: string;
	readonly targetKind: AgentActivityNotificationTargetKind;
	/** present는 Graph source 존재, pending은 Workspace 범위 안의 다음 Graph 갱신 대기다. */
	readonly availability: 'present' | 'pending' | 'outside';
}

export interface AgentActivityTargetPresentation {
	readonly name: string;
	readonly path: string;
	readonly kind: GraphRootNode['kind'];
	readonly availability: 'present' | 'pending';
}

interface AgentActivityTargetScopeRoot {
	readonly id: string;
	readonly name: string;
	readonly path: readonly string[];
	readonly uri: URL;
}

export interface AgentActivityTargetPresentationIndex {
	readonly presentations: ReadonlyMap<string, AgentActivityTargetPresentation>;
	readonly scopeRoots: readonly AgentActivityTargetScopeRoot[];
}

const UNAVAILABLE_TARGET_NAME = '사용할 수 없는 그래프 대상';
const UNAVAILABLE_TARGET_PATH = 'Workspace에서 대상을 찾을 수 없습니다.';

/** Activity kind를 알림에서 읽을 수 있는 짧은 상태명으로 변환한다. */
export function getAgentActivityNotificationStatusLabel(
	activity: AgentActivityKind,
): string {
	switch (activity) {
		case 'planned':
			return '계획됨';
		case 'active':
			return '진행 중';
		case 'editing':
			return '편집 중';
		case 'completed':
			return '완료';
		case 'mentioned':
			return '언급됨';
		case 'rejected':
			return '제외됨';
	}
}

/**
 * Target별 Store snapshot을 현재 알림 행으로 펼친다.
 * Graph binding의 Activity priority 정렬과 독립적으로 전역 수신 sequence 최신순을 쓴다.
 */
export function createAgentActivityNotificationEntries(
	snapshot: AgentActivityStoreSnapshot,
	presentationStore: Pick<AgentSessionPresentationStore, 'getSession'>,
	graph: Graph,
): readonly AgentActivityNotificationEntry[] {
	return createAgentActivityNotificationEntriesFromIndex(
		snapshot,
		presentationStore,
		createAgentActivityTargetPresentationIndex(graph),
	);
}

/** 이미 만든 Graph 표시 index에서 현재 알림 행만 투영한다. */
export function createAgentActivityNotificationEntriesFromIndex(
	snapshot: AgentActivityStoreSnapshot,
	presentationStore: Pick<AgentSessionPresentationStore, 'getSession'>,
	targets: AgentActivityTargetPresentationIndex,
): readonly AgentActivityNotificationEntry[] {
	const entries: AgentActivityNotificationEntry[] = [];

	for (const targetSnapshot of snapshot) {
		const targetPresentation = targets.presentations.get(
			createTargetPresentationKey(targetSnapshot.target),
		) ?? targets.presentations.get(createTargetPresentationKey({
			nodeId: targetSnapshot.target.nodeId,
		})) ?? createPendingTargetPresentation(
			targetSnapshot.target,
			targets.scopeRoots,
		);

		for (const activity of targetSnapshot.activities) {
			const session = presentationStore.getSession(activity.sessionId);

			if (session?.state !== 'running') {
				continue;
			}

			entries.push(createNotificationEntry(
				targetSnapshot.target,
				activity,
				session.color,
				session.title || AGENT_SESSION_UNTITLED_TITLE,
				session.currentMessage || AGENT_SESSION_WAITING_MESSAGE,
				targetPresentation,
			));
		}
	}

	entries.sort(compareAgentActivityNotifications);
	return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function createNotificationEntry(
	target: Readonly<GraphNodeEffectTarget>,
	activity: AgentSessionActivitySnapshot,
	sessionColor: string,
	sessionTitle: string,
	currentMessage: string,
	presentation: AgentActivityTargetPresentation | undefined,
): AgentActivityNotificationEntry {
	return {
		key: createAgentActivityNotificationKey(activity.sessionId, target),
		sessionId: activity.sessionId,
		target: Object.freeze({ ...target }),
		activity: activity.activity,
		sequence: activity.sequence,
		sessionColor,
		sessionTitle,
		currentMessage,
		targetName: presentation?.name ?? UNAVAILABLE_TARGET_NAME,
		targetPath: presentation?.path ?? UNAVAILABLE_TARGET_PATH,
		targetKind: presentation?.kind ?? 'unavailable',
		availability: presentation?.availability ?? 'outside',
	};
}

/** 같은 현재 알림을 상태 전환 뒤에도 재사용하는 안정적인 DOM key다. */
export function createAgentActivityNotificationKey(
	sessionId: string,
	target: Readonly<GraphNodeEffectTarget>,
): string {
	return JSON.stringify([
		sessionId,
		target.nodeId,
		target.rootId ?? null,
	]);
}

function compareAgentActivityNotifications(
	left: AgentActivityNotificationEntry,
	right: AgentActivityNotificationEntry,
): number {
	const sequenceDifference = right.sequence - left.sequence;

	if (sequenceDifference !== 0) {
		return sequenceDifference;
	}
	return left.key < right.key ? -1 : left.key === right.key ? 0 : 1;
}

/** Workspace source ID를 사용자 표시 이름과 경로로 바꾸는 canonical index다. */
export function createAgentActivityTargetPresentationIndex(
	graph: Graph,
): AgentActivityTargetPresentationIndex {
	const presentations = new Map<string, AgentActivityTargetPresentation>();
	const scopeRoots: AgentActivityTargetScopeRoot[] = [];

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}
		indexGraphRoot(root, rootNode, presentations);
		const parsedRoot = parseGraphNodeUri(rootNode.id);

		if (parsedRoot) {
			scopeRoots.push(Object.freeze({
				id: root.id,
				name: rootNode.name,
				path: Object.freeze(splitGraphPath(root.context?.relativePath)),
				uri: parsedRoot.uri,
			}));
		}
	}

	return Object.freeze({
		presentations,
		scopeRoots: Object.freeze(scopeRoots),
	});
}

function indexGraphRoot(
	root: GraphRoot,
	rootNode: GraphRootNode,
	presentations: Map<string, AgentActivityTargetPresentation>,
): void {
	const contextSegments = splitGraphPath(root.context?.relativePath);
	const rootPath = [...contextSegments, rootNode.name];

	appendTargetPresentation(root.id, rootNode, rootPath, presentations);
	if (rootNode.kind === 'file') {
		return;
	}

	for (const child of rootNode.children) {
		indexGraphEntry(root.id, child, [...rootPath, child.name], presentations);
	}
}

function indexGraphEntry(
	rootId: string,
	entry: ProjectEntry,
	path: readonly string[],
	presentations: Map<string, AgentActivityTargetPresentation>,
): void {
	appendTargetPresentation(rootId, entry, path, presentations);
	if (entry.kind === 'file') {
		return;
	}

	for (const child of entry.children) {
		indexGraphEntry(rootId, child, [...path, child.name], presentations);
	}
}

function appendTargetPresentation(
	rootId: string,
	node: GraphRootNode,
	path: readonly string[],
	presentations: Map<string, AgentActivityTargetPresentation>,
): void {
	const presentation = Object.freeze({
		name: node.name,
		path: path.filter(Boolean).join('/'),
		kind: node.kind,
		availability: 'present' as const,
	});
	const exactKey = createTargetPresentationKey({
		nodeId: node.id,
		rootId,
	});
	const sourceKey = createTargetPresentationKey({ nodeId: node.id });

	if (!presentations.has(exactKey)) {
		presentations.set(exactKey, presentation);
	}
	if (!presentations.has(sourceKey)) {
		presentations.set(sourceKey, presentation);
	}
}

/**
 * Source가 아직 Graph snapshot에 없더라도 URI가 현재 Root 안이면 표시 경로를
 * 복원한다. 이 경우 unavailable로 오인하지 않고 다음 Graph 갱신 Focus를 기다린다.
 */
function createPendingTargetPresentation(
	target: Readonly<GraphNodeEffectTarget>,
	scopeRoots: readonly AgentActivityTargetScopeRoot[],
): AgentActivityTargetPresentation | undefined {
	const parsedTarget = parseGraphNodeUri(target.nodeId);

	if (!parsedTarget) {
		return undefined;
	}

	let selected: {
		readonly root: AgentActivityTargetScopeRoot;
		readonly relativeSegments: readonly string[];
	} | undefined;

	for (const root of scopeRoots) {
		const relativeSegments = getGraphNodeUriRelativeSegments(
			parsedTarget.uri,
			root.uri,
		);

		if (!relativeSegments) {
			continue;
		}
		if (!selected) {
			selected = { root, relativeSegments };
			continue;
		}

		const exactRoot = target.rootId === root.id;
		const selectedExactRoot = target.rootId === selected.root.id;
		if (
			(exactRoot && !selectedExactRoot)
			|| (
				exactRoot === selectedExactRoot
				&& getNormalizedGraphUriPathLength(root.uri)
					> getNormalizedGraphUriPathLength(selected.root.uri)
			)
		) {
			selected = { root, relativeSegments };
		}
	}

	if (!selected) {
		return undefined;
	}
	const pathSegments = [
		...selected.root.path,
		selected.root.name,
		...selected.relativeSegments,
	].filter(Boolean);

	return Object.freeze({
		name: selected.relativeSegments.at(-1) ?? selected.root.name,
		path: pathSegments.join('/'),
		kind: parsedTarget.kind,
		availability: 'pending',
	});
}

function createTargetPresentationKey(
	target: Readonly<GraphNodeEffectTarget>,
): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

function splitGraphPath(path: string | undefined): string[] {
	return path?.split('/').map((segment) => segment.trim()).filter(Boolean) ?? [];
}
