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
		['index.html', 'html'],
		['index.htm', 'html'],
		['index.xhtml', 'html'],
		['webview.css', 'css'],
		['theme.scss', 'sass'],
		['theme.sass', 'sass'],
		['package.json', 'json'],
		['settings.jsonc', 'json'],
		['README.md', 'markdown'],
		['README.markdown', 'markdown'],
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
	];

	for (const [fileName, expected] of cases) {
		test(`${fileName} 확장자를 ${expected} 아이콘으로 해석한다`, () => {
			assert.strictEqual(resolveFileIcon(fileName), expected);
		});
	}

	test('확장자 대소문자를 구분하지 않는다', () => {
		assert.strictEqual(resolveFileIcon('GRAPHRENDERER.TS'), 'typescript');
		assert.strictEqual(resolveFileIcon('IMAGE.PNG'), 'image');
		assert.strictEqual(resolveFileIcon('Component.TsX'), 'react_ts');
	});

	test('미지원 확장자는 공통 fallback 아이콘을 반환한다', () => {
		assert.strictEqual(resolveFileIcon('archive.zip'), 'file-unknown');
	});

	test('확장자가 없거나 파일 이름 특수 규칙이 필요한 파일은 fallback 아이콘을 반환한다', () => {
		assert.strictEqual(resolveFileIcon('Dockerfile'), 'file-unknown');
		assert.strictEqual(resolveFileIcon('.gitignore'), 'file-unknown');
	});
});
