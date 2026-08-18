import * as assert from 'assert';
import {
	resolveFileIcon,
	type FileIconName,
} from '../../webview/graph/fileIconResolver';

suite('File Icon Resolver', () => {
	const cases: ReadonlyArray<readonly [string, FileIconName]> = [
		['component.ts', 'typescript'],
		['component.cts', 'typescript'],
		['component.mts', 'typescript'],
		['Component.tsx', 'react_ts'],
		['script.js', 'javascript'],
		['script.mjs', 'javascript'],
		['script.cjs', 'javascript'],
		['Component.jsx', 'react'],
		['Component.vue', 'vue'],
		['Component.svelte', 'svelte'],
		['page.astro', 'astro'],
		['index.php', 'php'],
		['main.rb', 'ruby'],
		['Main.kt', 'kotlin'],
		['build.kts', 'kotlin'],
		['App.swift', 'swift'],
		['Program.cs', 'csharp'],
		['script.csx', 'csharp'],
		['main.dart', 'dart'],
		['config.lua', 'lua'],
		['analysis.r', 'r'],
		['index.html', 'html'],
		['index.htm', 'html'],
		['index.xhtml', 'html'],
		['webview.css', 'css'],
		['theme.scss', 'sass'],
		['theme.sass', 'sass'],
		['settings.json', 'json'],
		['settings.jsonc', 'json'],
		['guide.md', 'markdown'],
		['guide.markdown', 'markdown'],
		['workflow.yml', 'yaml'],
		['workflow.yaml', 'yaml'],
		['document.xml', 'xml'],
		['Cargo.toml', 'toml'],
		['main.py', 'python'],
		['Main.java', 'java'],
		['view.jsp', 'java'],
		['Legacy.jav', 'java'],
		['main.c', 'c'],
		['main.h', 'h'],
		['main.cc', 'cpp'],
		['main.cpp', 'cpp'],
		['main.cxx', 'cpp'],
		['main.c++', 'cpp'],
		['main.go', 'go'],
		['main.rs', 'rust'],
		['run.sh', 'console'],
		['run.bash', 'console'],
		['run.zsh', 'console'],
		['run.fish', 'console'],
		['run.ksh', 'console'],
		['run.csh', 'console'],
		['run.tcsh', 'console'],
		['schema.sql', 'database'],
		['photo.png', 'image'],
		['photo.jpg', 'image'],
		['photo.jpeg', 'image'],
		['photo.gif', 'image'],
		['photo.webp', 'image'],
		['photo.bmp', 'image'],
		['photo.ico', 'image'],
		['photo.avif', 'image'],
		['photo.tif', 'image'],
		['photo.tiff', 'image'],
		['logo.svg', 'svg'],
		['document.pdf', 'pdf'],
		['data.csv', 'table'],
		['data.tsv', 'table'],
		['sheet.xls', 'table'],
		['sheet.xlsx', 'table'],
	];

	for (const [fileName, expected] of cases) {
		test(`${fileName} 확장자를 ${expected} 아이콘으로 해석한다`, () => {
			assert.strictEqual(resolveFileIcon(fileName), expected);
		});
	}

	test('TypeScript declaration suffix를 일반 TypeScript보다 우선한다', () => {
		assert.strictEqual(resolveFileIcon('types.d.ts'), 'typescript-def');
		assert.strictEqual(resolveFileIcon('types.d.cts'), 'typescript-def');
		assert.strictEqual(resolveFileIcon('types.d.mts'), 'typescript-def');
		assert.strictEqual(resolveFileIcon('component.ts'), 'typescript');
		assert.strictEqual(resolveFileIcon('component.cts'), 'typescript');
		assert.strictEqual(resolveFileIcon('component.mts'), 'typescript');
	});

	test('특수 파일명 규칙을 일반 확장자보다 우선한다', () => {
		const specialCases: ReadonlyArray<readonly [string, FileIconName]> = [
			['package.json', 'npm'],
			['package-lock.json', 'npm'],
			['pnpm-lock.yaml', 'pnpm'],
			['yarn.lock', 'yarn'],
			['tsconfig.json', 'tsconfig'],
			['tsconfig.base.json', 'tsconfig'],
			['tsconfig.build.json', 'tsconfig'],
			['.gitignore', 'git'],
			['.gitattributes', 'git'],
			['.gitmodules', 'git'],
			['Dockerfile', 'docker'],
			['Dockerfile.dev', 'docker'],
			['docker-compose.yml', 'docker'],
			['docker-compose.yaml', 'docker'],
			['docker-compose.dev.yml', 'docker'],
			['docker-compose.dev.yaml', 'docker'],
			['compose.yml', 'docker'],
			['compose.yaml', 'docker'],
			['compose.production.yml', 'docker'],
			['compose.production.yaml', 'docker'],
			['README', 'readme'],
			['README.md', 'readme'],
			['README.txt', 'readme'],
			['LICENSE', 'license'],
			['LICENSE.md', 'license'],
			['LICENSE.txt', 'license'],
		];

		for (const [fileName, expected] of specialCases) {
			assert.strictEqual(resolveFileIcon(fileName), expected, fileName);
		}
	});

	test('확장자와 특수 파일명 대소문자를 구분하지 않는다', () => {
		assert.strictEqual(resolveFileIcon('GRAPHRENDERER.TS'), 'typescript');
		assert.strictEqual(resolveFileIcon('IMAGE.PNG'), 'image');
		assert.strictEqual(resolveFileIcon('Component.TsX'), 'react_ts');
		assert.strictEqual(resolveFileIcon('PACKAGE.JSON'), 'npm');
		assert.strictEqual(resolveFileIcon('README.MD'), 'readme');
		assert.strictEqual(resolveFileIcon('DOCKERFILE'), 'docker');
		assert.strictEqual(resolveFileIcon('TSCONFIG.JSON'), 'tsconfig');
		assert.strictEqual(resolveFileIcon('TYPES.D.TS'), 'typescript-def');
	});

	test('미지원 확장자와 env 파일은 공통 fallback 아이콘을 반환한다', () => {
		assert.strictEqual(resolveFileIcon('archive.zip'), 'file-unknown');
		assert.strictEqual(resolveFileIcon('.env'), 'file-unknown');
		assert.strictEqual(resolveFileIcon('.env.local'), 'file-unknown');
	});

	test('특수 규칙을 임의의 유사 파일명으로 확대하지 않는다', () => {
		assert.strictEqual(resolveFileIcon('my-tsconfig.json'), 'json');
		assert.strictEqual(resolveFileIcon('LICENSE-MIT'), 'file-unknown');
		assert.strictEqual(resolveFileIcon('docker-compose'), 'file-unknown');
		assert.strictEqual(resolveFileIcon('Makefile'), 'file-unknown');
	});
});
