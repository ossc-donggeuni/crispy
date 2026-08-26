/** URI 기반 production Graph Node ID에서 복원한 Node 종류와 URI다. */
export interface ParsedGraphNodeUri {
	readonly kind: 'project' | 'folder' | 'file';
	readonly uri: URL;
}

/** 알려진 Graph Node ID 뒤의 absolute URI를 URL 비교 값으로 복원한다. */
export function parseGraphNodeUri(
	nodeId: string,
): ParsedGraphNodeUri | undefined {
	const prefixes = [
		['workspace-root:', 'project'],
		['folder:', 'folder'],
		['file:', 'file'],
	] as const;
	const match = prefixes.find(([prefix]) => nodeId.startsWith(prefix));

	if (!match) {
		return undefined;
	}

	try {
		return {
			kind: match[1],
			uri: new URL(nodeId.slice(match[0].length)),
		};
	} catch {
		return undefined;
	}
}

/** scheme/authority와 path segment 경계를 보존해 Source의 Root 포함 여부를 판별한다. */
export function isGraphNodeUriWithinRoot(uri: URL, rootUri: URL): boolean {
	if (
		uri.protocol !== rootUri.protocol
		|| uri.username !== rootUri.username
		|| uri.password !== rootUri.password
		|| uri.host !== rootUri.host
	) {
		return false;
	}

	const rootPath = normalizeGraphUriPath(rootUri.pathname);
	const candidatePath = normalizeGraphUriPath(uri.pathname);

	return candidatePath === rootPath
		|| rootPath === '/'
		|| candidatePath.startsWith(`${rootPath}/`);
}

/** Root URI 아래의 URI path를 사용자 표시용 decoded segment로 변환한다. */
export function getGraphNodeUriRelativeSegments(
	uri: URL,
	rootUri: URL,
): readonly string[] | undefined {
	if (!isGraphNodeUriWithinRoot(uri, rootUri)) {
		return undefined;
	}

	const rootPath = normalizeGraphUriPath(rootUri.pathname);
	const candidatePath = normalizeGraphUriPath(uri.pathname);
	if (candidatePath === rootPath) {
		return [];
	}

	const relativePath = rootPath === '/'
		? candidatePath.slice(1)
		: candidatePath.slice(rootPath.length + 1);

	return relativePath
		.split('/')
		.filter(Boolean)
		.map(decodeGraphUriSegment);
}

/** 가장 구체적인 containing Root 선택에 사용할 정규화 path 길이다. */
export function getNormalizedGraphUriPathLength(uri: URL): number {
	return normalizeGraphUriPath(uri.pathname).length;
}

/** `/` 이외 URI path의 trailing slash를 제거한다. */
function normalizeGraphUriPath(path: string): string {
	return path.length > 1 && path.endsWith('/')
		? path.replace(/\/+$/, '')
		: path;
}

function decodeGraphUriSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
