import * as assert from 'node:assert/strict';
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskExecutionScopeTarget } from '../../task/taskExecution';
import { resolveTaskExecutionScopePath } from '../../task/taskExecutionScope';

suite('Task execution scope path resolver', () => {
	const fixtureRoot = mkdtempSync(nodePath.join(tmpdir(), 'crispy-task-scope-test-'));
	const sourceFolder = nodePath.join(fixtureRoot, 'src');
	const sourceFile = nodePath.join(sourceFolder, 'app.ts');
	const outsideRoot = mkdtempSync(nodePath.join(tmpdir(), 'crispy-task-outside-test-'));
	const outsideFile = nodePath.join(outsideRoot, 'outside.ts');

	mkdirSync(sourceFolder);
	writeFileSync(sourceFile, 'export {};');
	writeFileSync(outsideFile, 'outside');

	suiteTeardown(() => {
		rmSync(fixtureRoot, { recursive: true, force: true });
		rmSync(outsideRoot, { recursive: true, force: true });
	});

	test('file URI source를 realpath로 고정하고 선언 kind를 검증한다', () => {
		assert.strictEqual(
			resolveTaskExecutionScopePath(target('folder', sourceFolder, fixtureRoot)),
			realpathSync.native(sourceFolder),
		);
		assert.strictEqual(
			resolveTaskExecutionScopePath(target('file', sourceFile, fixtureRoot)),
			realpathSync.native(sourceFile),
		);
		assert.strictEqual(
			resolveTaskExecutionScopePath(target('folder', sourceFile, fixtureRoot)),
			undefined,
		);
	});

	test('stale source, non-file URI와 workspace 밖 source를 fail-closed한다', () => {
		assert.strictEqual(resolveTaskExecutionScopePath(target(
			'file', nodePath.join(fixtureRoot, 'missing.ts'), fixtureRoot,
		)), undefined);
		assert.strictEqual(resolveTaskExecutionScopePath({
			...target('file', sourceFile, fixtureRoot),
			sourceId: 'file:https://example.com/app.ts',
		}), undefined);
		assert.strictEqual(
			resolveTaskExecutionScopePath(target('file', outsideFile, fixtureRoot)),
			undefined,
		);
	});

	test('workspace 내부 symlink가 밖을 가리키면 realpath containment에서 거부한다', function () {
		const linkPath = nodePath.join(fixtureRoot, 'escaped.ts');
		try {
			symlinkSync(outsideFile, linkPath, 'file');
		} catch {
			this.skip();
			return;
		}

		assert.strictEqual(
			resolveTaskExecutionScopePath(target('file', linkPath, fixtureRoot)),
			undefined,
		);
	});
});

function target(
	kind: 'file' | 'folder',
	sourcePath: string,
	rootPath: string,
): TaskExecutionScopeTarget {
	return {
		sourceId: `${kind}:${pathToFileURL(sourcePath).href}`,
		sourceRootId: `workspace-root:${pathToFileURL(rootPath).href}`,
		access: kind === 'file' ? 'read-write' : 'read',
		originNodeId: 'start',
	};
}
