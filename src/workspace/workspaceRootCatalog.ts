import type { WorkspaceSnapshot } from './workspaceModel';
import { validateWorkspacePolicy } from './workspacePolicy';
import type { WorkspaceRootId } from './workspaceRootId';

/** Webview Workspace Picker에서 선택 불가 사유를 표현하는 안정적인 code다. */
export type WorkspaceRootCatalogUnavailableReason =
	| 'workspace_untrusted'
	| 'workspace_virtual_unsupported'
	| 'workspace_path_invalid'
	| 'workspace_root_unavailable';

/** Graph와 같은 Snapshot에서 생성되는 Webview용 Workspace root metadata다. */
export interface WorkspaceRootCatalogEntry {
	readonly id: WorkspaceRootId;
	readonly name: string;
	readonly description: string;
	readonly selectable: boolean;
	readonly reason?: WorkspaceRootCatalogUnavailableReason;
}

/**
 * 현재 Workspace Snapshot을 실행 위치가 아닌 표시·선택용 Catalog로 변환한다.
 * Trust가 다른 root policy보다 우선하며 filesystem 존재 여부는 확인하지 않는다.
 */
export function createWorkspaceRootCatalog(
	snapshot: WorkspaceSnapshot,
	isTrusted: boolean,
	platform: NodeJS.Platform = process.platform,
): readonly WorkspaceRootCatalogEntry[] {
	return snapshot.roots.map((root): WorkspaceRootCatalogEntry => {
		const baseEntry = {
			id: root.id,
			name: root.name,
			description: root.uri.toString(),
		};

		if (!isTrusted) {
			return {
				...baseEntry,
				selectable: false,
				reason: 'workspace_untrusted',
			};
		}

		const policy = validateWorkspacePolicy({
			uriScheme: root.uri.scheme,
			fsPath: root.uri.fsPath,
			platform,
		});

		return policy.ok
			? { ...baseEntry, selectable: true }
			: { ...baseEntry, selectable: false, reason: policy.code };
	});
}
