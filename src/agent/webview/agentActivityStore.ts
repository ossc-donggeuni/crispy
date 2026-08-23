import type {
	AgentActivityKind,
	GraphNodeEffectTarget,
} from '../../messages';
import type { SessionId } from '../protocol';

/** Target 하나에서 Session 하나가 보유한 현재 Activity snapshot이다. */
export interface AgentSessionActivitySnapshot {
	readonly sessionId: SessionId;
	readonly activity: AgentActivityKind;
}

/** Target과 그 Target에 연결된 모든 Session Activity snapshot이다. */
export interface AgentTargetActivitySnapshot {
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly activities: readonly AgentSessionActivitySnapshot[];
}

/** Store 전체의 immutable snapshot이며 배열 순서는 의미 계약에 포함되지 않는다. */
export type AgentActivityStoreSnapshot = readonly AgentTargetActivitySnapshot[];

/** Activity Store가 실제로 변경된 뒤 호출되는 구독 callback이다. */
export type AgentActivityStoreSubscriber = (
	snapshot: AgentActivityStoreSnapshot,
) => void;

/** Target × Session 현재 Activity의 조회, 변경 및 구독 경계다. */
export interface AgentActivityStore {
	/** 특정 Target에 연결된 Session별 현재 Activity를 immutable하게 반환한다. */
	getActivities(
		target: GraphNodeEffectTarget,
	): readonly AgentSessionActivitySnapshot[];

	/** 모든 Target의 현재 Activity를 내부 Map과 분리된 immutable snapshot으로 반환한다. */
	getSnapshot(): AgentActivityStoreSnapshot;

	/** 동일 Target과 Session의 기존 Activity를 새 현재 값으로 교체한다. */
	setAgentActivity(
		sessionId: SessionId,
		target: GraphNodeEffectTarget,
		activity: AgentActivityKind,
	): void;

	/** 동일 Target과 Session의 현재 Activity만 제거한다. */
	clearAgentActivity(sessionId: SessionId, target: GraphNodeEffectTarget): void;

	/** 모든 Target에서 동일 Session의 현재 Activity를 제거한다. */
	clearAgentActivitiesBySession(sessionId: SessionId): void;

	/** 실제 상태 변경을 구독하고 해제 함수를 반환한다. */
	subscribe(subscriber: AgentActivityStoreSubscriber): () => void;
}

interface MutableTargetActivities {
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly activitiesBySession: Map<SessionId, AgentActivityKind>;
}

const EMPTY_ACTIVITIES: readonly AgentSessionActivitySnapshot[] = Object.freeze([]);

/** Webview 수명 동안만 유지되는 Target × Session Activity Store를 만든다. */
export function createAgentActivityStore(): AgentActivityStore {
	const activitiesByTarget = new Map<string, MutableTargetActivities>();
	const subscribers = new Set<AgentActivityStoreSubscriber>();

	const getActivities = (
		target: GraphNodeEffectTarget,
	): readonly AgentSessionActivitySnapshot[] => {
		const targetActivities = activitiesByTarget.get(createTargetKey(target));

		return targetActivities
			? createActivitiesSnapshot(targetActivities.activitiesBySession)
			: EMPTY_ACTIVITIES;
	};

	const getSnapshot = (): AgentActivityStoreSnapshot => Object.freeze(
		[...activitiesByTarget.values()].map((targetActivities) => Object.freeze({
			target: targetActivities.target,
			activities: createActivitiesSnapshot(
				targetActivities.activitiesBySession,
			),
		})),
	);

	/** 한 구독자의 실패가 다른 Webview 상태 구독이나 메시지 처리를 막지 않는다. */
	const notify = (): void => {
		const snapshot = getSnapshot();

		for (const subscriber of [...subscribers]) {
			try {
				subscriber(snapshot);
			} catch {
				/** 후속 Effect/UI 구독자의 실패를 Activity 상태 경계 안에 격리한다. */
			}
		}
	};

	return {
		getActivities,
		getSnapshot,

		setAgentActivity(sessionId, target, activity): void {
			const key = createTargetKey(target);
			let targetActivities = activitiesByTarget.get(key);

			if (!targetActivities) {
				targetActivities = {
					target: createTargetSnapshot(target),
					activitiesBySession: new Map(),
				};
				activitiesByTarget.set(key, targetActivities);
			}

			if (targetActivities.activitiesBySession.get(sessionId) === activity) {
				return;
			}

			targetActivities.activitiesBySession.set(sessionId, activity);
			notify();
		},

		clearAgentActivity(sessionId, target): void {
			const key = createTargetKey(target);
			const targetActivities = activitiesByTarget.get(key);

			if (!targetActivities?.activitiesBySession.delete(sessionId)) {
				return;
			}
			if (targetActivities.activitiesBySession.size === 0) {
				activitiesByTarget.delete(key);
			}
			notify();
		},

		clearAgentActivitiesBySession(sessionId): void {
			let changed = false;

			for (const [key, targetActivities] of activitiesByTarget) {
				if (!targetActivities.activitiesBySession.delete(sessionId)) {
					continue;
				}
				changed = true;

				if (targetActivities.activitiesBySession.size === 0) {
					activitiesByTarget.delete(key);
				}
			}

			if (changed) {
				notify();
			}
		},

		subscribe(subscriber): () => void {
			subscribers.add(subscriber);

			return () => {
				subscribers.delete(subscriber);
			};
		},
	};
}

/** G-11과 동일하게 nodeId와 optional root occurrence를 모두 보존한다. */
function createTargetKey(target: GraphNodeEffectTarget): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

function createTargetSnapshot(
	target: GraphNodeEffectTarget,
): Readonly<GraphNodeEffectTarget> {
	return Object.freeze({
		nodeId: target.nodeId,
		...(target.rootId === undefined ? {} : { rootId: target.rootId }),
	});
}

function createActivitiesSnapshot(
	activitiesBySession: ReadonlyMap<SessionId, AgentActivityKind>,
): readonly AgentSessionActivitySnapshot[] {
	return Object.freeze(
		[...activitiesBySession].map(([sessionId, activity]) => Object.freeze({
			sessionId,
			activity,
		})),
	);
}
