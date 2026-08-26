import {
	createGraphLayoutNodeId,
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
} from '../webview/graph/graphLayout';
import {
	createDetachedRootId,
	getDetachedRootNodeId,
	getDetachedRootOrdinal,
	getDetachedRootOriginId,
	isDetachedRootId,
} from '../webview/graph/graphRootPromotion';

const FILE_GROUP_SUFFIX = ':files';
const FOLDER_BACKLINK_PREFIX = 'folder-backlink:';
const FILE_BACKLINK_GROUP_PREFIX = 'file-backlink-group:';

/**
 * Persistent Graph state에서 사용하는 canonical/합성/instance ID 전체를 같은
 * canonical mapper로 변환한다. 알 수 없거나 손상된 ID는 원문을 보존한다.
 */
export function mapWorkspaceNodeStateId(
	id: string,
	mapCanonicalId: (canonicalId: string) => string,
): string {
	const rootId = getGraphLayoutRootId(id);

	if (rootId) {
		return createGraphLayoutNodeId(
			mapDetachedRootId(rootId, mapCanonicalId),
			mapSourceId(getGraphLayoutSourceId(id), mapCanonicalId),
		);
	}
	if (isDetachedRootId(id)) {
		return mapDetachedRootId(id, mapCanonicalId);
	}
	return mapSourceId(id, mapCanonicalId);
}

/** 합성 ID 내부를 포함해 ID가 참조하는 canonical source ID를 모두 반환한다. */
export function collectWorkspaceNodeStateCanonicalIds(id: string): readonly string[] {
	const canonicalIds: string[] = [];

	mapWorkspaceNodeStateId(id, (canonicalId) => {
		canonicalIds.push(canonicalId);
		return canonicalId;
	});
	return canonicalIds;
}

function mapSourceId(
	id: string,
	mapCanonicalId: (canonicalId: string) => string,
): string {
	if (id.endsWith(FILE_GROUP_SUFFIX)) {
		const parentId = id.slice(0, -FILE_GROUP_SUFFIX.length);
		const mappedParentId = mapCanonicalId(parentId);

		return mappedParentId === parentId
			? id
			: `${mappedParentId}${FILE_GROUP_SUFFIX}`;
	}
	for (const prefix of [
		FOLDER_BACKLINK_PREFIX,
		FILE_BACKLINK_GROUP_PREFIX,
	] as const) {
		if (!id.startsWith(prefix)) {
			continue;
		}
		try {
			const sourceId = decodeURIComponent(id.slice(prefix.length));
			const mappedSourceId = mapCanonicalId(sourceId);

			return mappedSourceId === sourceId
				? id
				: `${prefix}${encodeURIComponent(mappedSourceId)}`;
		} catch {
			return id;
		}
	}
	return mapCanonicalId(id);
}

function mapDetachedRootId(
	rootId: string,
	mapCanonicalId: (canonicalId: string) => string,
): string {
	const nodeId = getDetachedRootNodeId(rootId);
	const ordinal = getDetachedRootOrdinal(rootId);

	if (!nodeId || !ordinal) {
		return rootId;
	}
	const originRootId = getDetachedRootOriginId(rootId);

	return createDetachedRootId(
		mapCanonicalId(nodeId),
		ordinal,
		originRootId
			? mapDetachedRootId(originRootId, mapCanonicalId)
			: undefined,
	);
}
