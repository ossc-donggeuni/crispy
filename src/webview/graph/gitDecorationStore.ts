import type {
	WorkspaceGitFileStatus,
	WorkspaceGitStatusEntry,
	WorkspaceGitStatusUpdatedMessage,
} from '../../messages';

export interface GitDecorationBindings {
	registerFile(nodeId: string, element: HTMLElement): () => void;
	registerContainer(nodeId: string, element: HTMLElement): () => void;
}

export interface GitDecorationStore extends GitDecorationBindings {
	applySnapshot(message: WorkspaceGitStatusUpdatedMessage): boolean;
	resetContext(contextGeneration: number, rootIds: readonly string[]): void;
	dispose(): void;
}

interface GitDecorationTarget {
	readonly kind: 'file' | 'container';
	readonly name: HTMLElement;
	readonly marker: HTMLElement;
}

interface GitAggregate {
	readonly status: WorkspaceGitFileStatus;
	readonly counts: ReadonlyMap<WorkspaceGitFileStatus, number>;
}

const STATUS_PRIORITY: readonly WorkspaceGitFileStatus[] = [
	'conflict',
	'deleted',
	'renamed',
	'modified',
	'added',
	'untracked',
];

const STATUS_MARKERS: Readonly<Record<WorkspaceGitFileStatus, string>> = {
	untracked: 'U',
	added: 'A',
	modified: 'M',
	renamed: 'R',
	deleted: 'D',
	conflict: '!',
};

const STATUS_LABELS: Readonly<Record<WorkspaceGitFileStatus, string>> = {
	untracked: 'Untracked',
	added: 'Added',
	modified: 'Modified',
	renamed: 'Renamed',
	deleted: 'Deleted',
	conflict: 'Conflict',
};

/** Git snapshot과 현재 Renderer DOM occurrence를 느슨하게 연결한다. */
export function createGitDecorationStore(
	initialContextGeneration: number,
	initialRootIds: readonly string[],
): GitDecorationStore {
	let disposed = false;
	let contextGeneration = initialContextGeneration;
	let rootIds = [...initialRootIds];
	let gitRevision = -1;
	let directStatuses = new Map<string, WorkspaceGitFileStatus>();
	let aggregates = new Map<string, GitAggregate>();
	const targets = new Map<string, Set<GitDecorationTarget>>();

	const syncTarget = (nodeId: string, target: GitDecorationTarget): void => {
		const directStatus = directStatuses.get(nodeId);
		const aggregate = aggregates.get(nodeId);
		const decoration = target.kind === 'file'
			? directStatus
				? {
					status: directStatus,
					title: `Git: ${STATUS_LABELS[directStatus]}`,
				}
				: undefined
			: aggregate
				? {
					status: aggregate.status,
					title: createAggregateTitle(aggregate.counts),
				}
				: undefined;

		if (!decoration) {
			target.name.removeAttribute('data-git-status');
			target.marker.removeAttribute('data-git-status');
			target.marker.removeAttribute('title');
			target.marker.removeAttribute('aria-label');
			target.marker.textContent = '';
			target.marker.hidden = true;
			return;
		}

		target.name.setAttribute('data-git-status', decoration.status);
		target.marker.setAttribute('data-git-status', decoration.status);
		target.marker.setAttribute('title', decoration.title);
		target.marker.setAttribute('aria-label', decoration.title);
		target.marker.textContent = target.kind === 'file'
			? STATUS_MARKERS[decoration.status]
			: '';
		target.marker.hidden = false;
	};
	const syncAll = (): void => {
		for (const [nodeId, nodeTargets] of targets) {
			for (const target of nodeTargets) {
				syncTarget(nodeId, target);
			}
		}
	};
	const register = (
		nodeId: string,
		element: HTMLElement,
		kind: GitDecorationTarget['kind'],
	): (() => void) => {
		if (disposed) {
			return () => undefined;
		}
		const nameSelector = kind === 'file'
			? '.graph-file-name'
			: '.graph-folder-name';
		const name = element.querySelector<HTMLElement>(nameSelector);

		if (!name) {
			return () => undefined;
		}
		const marker = element.ownerDocument.createElement('span');
		const target: GitDecorationTarget = { kind, name, marker };
		const nodeTargets = targets.get(nodeId) ?? new Set<GitDecorationTarget>();

		marker.className = kind === 'file'
			? 'graph-git-marker graph-git-file-marker'
			: 'graph-git-marker graph-git-container-marker';
		marker.hidden = true;
		marker.setAttribute('role', 'status');
		element.append(marker);
		nodeTargets.add(target);
		targets.set(nodeId, nodeTargets);
		syncTarget(nodeId, target);

		return () => {
			nodeTargets.delete(target);
			if (nodeTargets.size === 0) {
				targets.delete(nodeId);
			}
			name.removeAttribute('data-git-status');
			marker.remove();
		};
	};

	return {
		registerFile: (nodeId, element) => register(nodeId, element, 'file'),
		registerContainer: (nodeId, element) => register(
			nodeId,
			element,
			'container',
		),
		applySnapshot(message): boolean {
			if (
				disposed
				|| message.contextGeneration !== contextGeneration
				|| !haveSameStrings(message.rootIds, rootIds)
				|| message.gitRevision <= gitRevision
			) {
				return false;
			}

			gitRevision = message.gitRevision;
			directStatuses = createDirectStatuses(message.entries);
			aggregates = createAggregates(message.entries);
			syncAll();
			return true;
		},
		resetContext(nextContextGeneration, nextRootIds): void {
			if (disposed) {
				return;
			}
			contextGeneration = nextContextGeneration;
			rootIds = [...nextRootIds];
			gitRevision = -1;
			directStatuses = new Map();
			aggregates = new Map();
			syncAll();
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const nodeTargets of targets.values()) {
				for (const target of nodeTargets) {
					target.name.removeAttribute('data-git-status');
					target.marker.remove();
				}
			}
			targets.clear();
			directStatuses.clear();
			aggregates.clear();
		},
	};
}

function createDirectStatuses(
	entries: readonly WorkspaceGitStatusEntry[],
): Map<string, WorkspaceGitFileStatus> {
	const statuses = new Map<string, WorkspaceGitFileStatus>();

	for (const entry of entries) {
		if (entry.nodeId) {
			statuses.set(entry.nodeId, entry.status);
		}
	}

	return statuses;
}

function createAggregates(
	entries: readonly WorkspaceGitStatusEntry[],
): Map<string, GitAggregate> {
	const countsByNodeId = new Map<
		string,
		Map<WorkspaceGitFileStatus, number>
	>();

	for (const entry of entries) {
		for (const nodeId of new Set(entry.ancestorNodeIds)) {
			const counts = countsByNodeId.get(nodeId)
				?? new Map<WorkspaceGitFileStatus, number>();

			counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
			countsByNodeId.set(nodeId, counts);
		}
	}

	return new Map([...countsByNodeId].map(([nodeId, counts]) => [
		nodeId,
		{
			status: STATUS_PRIORITY.find((status) => counts.has(status))
				?? 'modified',
			counts,
		},
	]));
}

function createAggregateTitle(
	counts: ReadonlyMap<WorkspaceGitFileStatus, number>,
): string {
	const summary = STATUS_PRIORITY
		.filter((status) => counts.has(status))
		.map((status) => `${STATUS_MARKERS[status]} ${counts.get(status)}`)
		.join(', ');

	return `Git changes: ${summary}`;
}

function haveSameStrings(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return left.length === right.length
		&& left.every((value, index) => value === right[index]);
}
