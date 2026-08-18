import type { Graph } from './graphModel';

/** Extension Host가 Webview 초기 HTML에 Graph를 전달할 수 있도록 직렬화한다. */
export function serializeGraphForWebview(graph: Graph): string {
	return encodeURIComponent(JSON.stringify(graph));
}

/** Webview 초기 HTML에서 전달받은 Graph를 복원한다. */
export function deserializeGraphFromWebview(
	serializedGraph: string | undefined,
): Graph {
	if (!serializedGraph) {
		throw new Error('Missing initial Workspace Graph');
	}

	return JSON.parse(decodeURIComponent(serializedGraph)) as Graph;
}
