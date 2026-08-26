import * as fileSystem from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskExecutionScopeTarget } from './taskExecution';

const WORKSPACE_ROOT_PREFIX = 'workspace-root:';

/**
 * Persisted Graph source ID를 existing canonical local path로 해석한다. URI/root containment,
 * final kind와 realpath를 모두 확인하므로 stale 또는 symlink escape 범위는 실행을 막는다.
 */
export function resolveTaskExecutionScopePath(
	target: TaskExecutionScopeTarget,
): string | undefined {
	const sourceKind = target.sourceId.startsWith('folder:')
		? 'folder'
		: target.sourceId.startsWith('file:')
			? 'file'
			: undefined;
	if (!sourceKind || !target.sourceRootId.startsWith(WORKSPACE_ROOT_PREFIX)) {
		return undefined;
	}
	try {
		const rootUrl = new URL(target.sourceRootId.slice(WORKSPACE_ROOT_PREFIX.length));
		const sourceUrl = new URL(target.sourceId.slice(sourceKind.length + 1));
		if (rootUrl.protocol !== 'file:' || sourceUrl.protocol !== 'file:') {
			return undefined;
		}
		const rootPath = fileSystem.realpathSync.native(fileURLToPath(rootUrl));
		const sourcePath = fileSystem.realpathSync.native(fileURLToPath(sourceUrl));
		const relative = nodePath.relative(rootPath, sourcePath);
		if (
			relative === '..'
			|| relative.startsWith(`..${nodePath.sep}`)
			|| nodePath.isAbsolute(relative)
		) {
			return undefined;
		}
		const stats = fileSystem.statSync(sourcePath);
		if (
			(sourceKind === 'folder' && !stats.isDirectory())
			|| (sourceKind === 'file' && !stats.isFile())
		) {
			return undefined;
		}
		return sourcePath;
	} catch {
		return undefined;
	}
}
