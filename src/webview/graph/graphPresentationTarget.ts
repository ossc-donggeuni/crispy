import type { GraphNodeEffectTarget } from '../../messages';
import {
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
	type GraphFileNode,
	type GraphLayoutNode,
} from './graphLayout';

/** Graph Layout card가 나타내는 exact source/occurrence Activity 대상이다. */
export function getGraphLayoutNodePresentationTarget(
	node: GraphLayoutNode,
): Readonly<GraphNodeEffectTarget> | undefined {
	if (node.kind === 'folder-backlink') {
		return undefined;
	}

	if (node.kind === 'file-group') {
		const file = node.presentation === 'standalone' ? node.children[0] : undefined;

		return file ? getGraphFilePresentationTarget(file, node.id) : undefined;
	}

	return createPresentationTarget(node.id);
}

/** Grouped File Row가 나타내는 exact source/occurrence Activity 대상이다. */
export function getGraphFilePresentationTarget(
	file: GraphFileNode,
	fallbackLayoutNodeId?: string,
): Readonly<GraphNodeEffectTarget> | undefined {
	if (file.presentation === 'backlink') {
		return undefined;
	}

	return createPresentationTarget(file.id, fallbackLayoutNodeId);
}

function createPresentationTarget(
	layoutNodeId: string,
	fallbackLayoutNodeId?: string,
): Readonly<GraphNodeEffectTarget> {
	const rootId = getGraphLayoutRootId(layoutNodeId)
		?? (fallbackLayoutNodeId
			? getGraphLayoutRootId(fallbackLayoutNodeId)
			: undefined);

	return {
		nodeId: getGraphLayoutSourceId(layoutNodeId),
		...(rootId ? { rootId } : {}),
	};
}
