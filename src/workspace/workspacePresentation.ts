import type { Graph } from '../webview/graph/graphModel';
import { parseGraph } from '../webview/graph/graphTransport';
import type {
	WorkspaceRootCatalogEntry,
	WorkspaceRootCatalogUnavailableReason,
} from './workspaceRootCatalog';
import { validateWorkspaceRootId } from './workspaceRootId';

/** 같은 Workspace Snapshot에서 생성된 Graph와 root Catalog의 atomic payload다. */
export interface WorkspacePresentation {
	readonly graph: Graph;
	readonly rootCatalog: readonly WorkspaceRootCatalogEntry[];
}

/** 초기 HTML attribute에 Workspace Presentation 전체를 하나의 값으로 직렬화한다. */
export function serializeWorkspacePresentationForWebview(
	presentation: WorkspacePresentation,
): string {
	return encodeURIComponent(JSON.stringify(presentation));
}

/**
 * 초기 HTML attribute의 Workspace Presentation을 전체 검증해 복원한다.
 * Graph 또는 Catalog 한쪽만 잘못되어도 부분 snapshot을 반환하지 않는다.
 */
export function deserializeWorkspacePresentationFromWebview(
	serializedPresentation: string | undefined,
): WorkspacePresentation {
	if (!serializedPresentation) {
		throw new Error('Missing initial Workspace Presentation');
	}

	let value: unknown;
	try {
		value = JSON.parse(decodeURIComponent(serializedPresentation)) as unknown;
	} catch {
		throw new Error('Invalid initial Workspace Presentation');
	}

	const presentation = parseWorkspacePresentation(value);
	if (!presentation) {
		throw new Error('Invalid initial Workspace Presentation');
	}

	return presentation;
}

/** unknown transport payload를 Graph와 Catalog가 모두 유효한 presentation으로 복사한다. */
export function parseWorkspacePresentation(
	value: unknown,
): WorkspacePresentation | undefined {
	if (!isRecord(value) || !hasExactFields(value, ['graph', 'rootCatalog'])) {
		return undefined;
	}

	const graph = parseGraph(value.graph);
	const rootCatalog = parseWorkspaceRootCatalog(value.rootCatalog);

	return graph && rootCatalog
		? { graph, rootCatalog }
		: undefined;
}

/** Workspace root Catalog 전체를 부분 적용 없이 검증하고 새 객체로 복사한다. */
function parseWorkspaceRootCatalog(
	value: unknown,
): readonly WorkspaceRootCatalogEntry[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const entries: WorkspaceRootCatalogEntry[] = [];
	for (const candidate of value) {
		const entry = parseWorkspaceRootCatalogEntry(candidate);

		if (!entry) {
			return undefined;
		}

		entries.push(entry);
	}

	return entries;
}

/** selectable 상태와 reason 조합까지 포함해 Catalog entry를 strict하게 검증한다. */
function parseWorkspaceRootCatalogEntry(
	value: unknown,
): WorkspaceRootCatalogEntry | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const id = validateWorkspaceRootId(value.id);
	if (
		!id.ok
		|| typeof value.name !== 'string'
		|| typeof value.description !== 'string'
		|| typeof value.selectable !== 'boolean'
	) {
		return undefined;
	}

	if (value.selectable) {
		return hasExactFields(value, ['id', 'name', 'description', 'selectable'])
			? {
				id: id.value,
				name: value.name,
				description: value.description,
				selectable: true,
			}
			: undefined;
	}

	if (
		!hasExactFields(value, [
			'id',
			'name',
			'description',
			'selectable',
			'reason',
		])
		|| !isWorkspaceRootCatalogUnavailableReason(value.reason)
	) {
		return undefined;
	}

	return {
		id: id.value,
		name: value.name,
		description: value.description,
		selectable: false,
		reason: value.reason,
	};
}

function isWorkspaceRootCatalogUnavailableReason(
	value: unknown,
): value is WorkspaceRootCatalogUnavailableReason {
	return value === 'workspace_untrusted'
		|| value === 'workspace_virtual_unsupported'
		|| value === 'workspace_path_invalid'
		|| value === 'workspace_root_unavailable';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(
	value: Readonly<Record<string, unknown>>,
	fields: readonly string[],
): boolean {
	const keys = Object.keys(value);

	return keys.length === fields.length
		&& fields.every((field) => Object.hasOwn(value, field));
}
