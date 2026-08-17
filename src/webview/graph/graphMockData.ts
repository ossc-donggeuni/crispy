import type { File, Project } from './graphModel';

/** Pagination UI를 눈으로 확인할 수 있는 안정적인 순번 File 목록을 만든다. */
function createPaginationMockFiles(folderPath: string, count: number): File[] {
	return Array.from({ length: count }, (_, index) => {
		const sequence = String(index + 1).padStart(2, '0');
		const name = `sample-${sequence}.ts`;

		return {
			kind: 'file',
			id: `file:${folderPath}/${name}`,
			name,
		};
	});
}

/**
 * 실제 Workspace나 파일 시스템을 사용하지 않고 G-05 렌더링과 테스트에
 * 공통으로 입력하는 안정적인 ID 기반 프로젝트 Tree다.
 */
export const GRAPH_MOCK_PROJECT: Project = {
	kind: 'project',
	id: 'project:crispy',
	name: 'crispy',
	children: [
		{
			kind: 'folder',
			id: 'folder:app',
			name: 'app',
			children: [
				{
					kind: 'folder',
					id: 'folder:app/src',
					name: 'src',
					children: [
						{
							kind: 'folder',
							id: 'folder:app/src/components',
							name: 'components',
							children: [
								{ kind: 'file', id: 'file:app/src/components/Graph.ts', name: 'Graph.ts' },
								{ kind: 'file', id: 'file:app/src/components/Node.ts', name: 'Node.ts' },
							],
						},
						{ kind: 'file', id: 'file:app/src/graphView.ts', name: 'graphView.ts' },
						{ kind: 'file', id: 'file:app/src/graphCamera.ts', name: 'graphCamera.ts' },
						{ kind: 'file', id: 'file:app/src/graphState.ts', name: 'graphState.ts' },
						{ kind: 'file', id: 'file:app/src/graphLayout.ts', name: 'graphLayout.ts' },
						{ kind: 'file', id: 'file:app/src/graphRenderer.ts', name: 'graphRenderer.ts' },
						{ kind: 'file', id: 'file:app/src/graphNodeDrag.ts', name: 'graphNodeDrag.ts' },
						{ kind: 'file', id: 'file:app/src/index.ts', name: 'index.ts' },
					],
				},
				{
					kind: 'folder',
					id: 'folder:app/docs',
					name: 'docs',
					children: [
						{ kind: 'file', id: 'file:app/docs/architecture.md', name: 'architecture.md' },
						{ kind: 'file', id: 'file:app/docs/testing.md', name: 'testing.md' },
					],
				},
				{ kind: 'file', id: 'file:app/package.json', name: 'package.json' },
				{ kind: 'file', id: 'file:app/tsconfig.json', name: 'tsconfig.json' },
			],
		},
		{
			kind: 'folder',
			id: 'folder:src',
			name: 'src',
			children: [
				{
					kind: 'folder',
					id: 'folder:src/webview',
					name: 'webview',
					children: [
						{ kind: 'file', id: 'file:src/webview/webview.ts', name: 'webview.ts' },
						{ kind: 'file', id: 'file:src/webview/webview.css', name: 'webview.css' },
					],
				},
				{ kind: 'file', id: 'file:src/extension.ts', name: 'extension.ts' },
				{ kind: 'file', id: 'file:src/messages.ts', name: 'messages.ts' },
			],
		},
		{
			kind: 'folder',
			id: 'folder:pagination-samples',
			name: 'pagination-samples',
			children: [
				{
					kind: 'folder',
					id: 'folder:pagination-samples/seventeen-files',
					name: 'seventeen-files',
					children: createPaginationMockFiles(
						'pagination-samples/seventeen-files',
						17,
					),
				},
				{
					kind: 'folder',
					id: 'folder:pagination-samples/twenty-one-files',
					name: 'twenty-one-files',
					children: createPaginationMockFiles(
						'pagination-samples/twenty-one-files',
						21,
					),
				},
			],
		},
		{ kind: 'file', id: 'file:README.md', name: 'README.md' },
		{ kind: 'file', id: 'file:package.json', name: 'package.json' },
		{ kind: 'file', id: 'file:tsconfig.json', name: 'tsconfig.json' },
	],
};
