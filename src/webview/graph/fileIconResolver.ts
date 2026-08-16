/** File Row에서 사용할 로컬 SVG 아이콘 식별자다. */
export type FileIconName =
	| 'c'
	| 'console'
	| 'cpp'
	| 'css'
	| 'database'
	| 'file-unknown'
	| 'go'
	| 'h'
	| 'html'
	| 'image'
	| 'java'
	| 'javascript'
	| 'json'
	| 'markdown'
	| 'python'
	| 'react'
	| 'react_ts'
	| 'rust'
	| 'sass'
	| 'svg'
	| 'toml'
	| 'typescript'
	| 'xml'
	| 'yaml';

const FILE_ICON_BY_EXTENSION: Readonly<Record<string, FileIconName>> = {
	'.ts': 'typescript',
	'.cts': 'typescript',
	'.mts': 'typescript',
	'.tsx': 'react_ts',
	'.js': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.jsx': 'react',
	'.html': 'html',
	'.htm': 'html',
	'.xhtml': 'html',
	'.css': 'css',
	'.scss': 'sass',
	'.sass': 'sass',
	'.json': 'json',
	'.jsonc': 'json',
	'.md': 'markdown',
	'.markdown': 'markdown',
	'.yml': 'yaml',
	'.yaml': 'yaml',
	'.xml': 'xml',
	'.toml': 'toml',
	'.py': 'python',
	'.java': 'java',
	'.jsp': 'java',
	'.jav': 'java',
	'.c': 'c',
	'.h': 'h',
	'.cc': 'cpp',
	'.cpp': 'cpp',
	'.cxx': 'cpp',
	'.c++': 'cpp',
	'.go': 'go',
	'.rs': 'rust',
	'.sh': 'console',
	'.bash': 'console',
	'.zsh': 'console',
	'.fish': 'console',
	'.ksh': 'console',
	'.csh': 'console',
	'.tcsh': 'console',
	'.sql': 'database',
	'.png': 'image',
	'.jpg': 'image',
	'.jpeg': 'image',
	'.gif': 'image',
	'.webp': 'image',
	'.bmp': 'image',
	'.ico': 'image',
	'.avif': 'image',
	'.tif': 'image',
	'.tiff': 'image',
	'.svg': 'svg',
};

/**
 * 파일 이름의 마지막 확장자만 사용해 렌더링할 아이콘을 결정한다.
 * 파일 이름 기반 특수 규칙은 적용하지 않는다.
 */
export function resolveFileIcon(fileName: string): FileIconName {
	const extensionStart = fileName.lastIndexOf('.');

	if (extensionStart <= 0 || extensionStart === fileName.length - 1) {
		return 'file-unknown';
	}

	const extension = fileName.slice(extensionStart).toLowerCase();

	return FILE_ICON_BY_EXTENSION[extension] ?? 'file-unknown';
}
