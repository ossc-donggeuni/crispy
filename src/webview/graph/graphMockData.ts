import type { Project } from './graphModel';

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
		{ kind: 'file', id: 'file:README.md', name: 'README.md' },
		{ kind: 'file', id: 'file:package.json', name: 'package.json' },
		{ kind: 'file', id: 'file:tsconfig.json', name: 'tsconfig.json' },
	],
};
