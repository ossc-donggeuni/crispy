/** File Row에서 사용할 로컬 SVG 아이콘 식별자다. */
export type FileIconName =
	| 'astro'
	| 'c'
	| 'console'
	| 'cpp'
	| 'csharp'
	| 'css'
	| 'dart'
	| 'database'
	| 'docker'
	| 'file-unknown'
	| 'git'
	| 'go'
	| 'h'
	| 'html'
	| 'image'
	| 'java'
	| 'javascript'
	| 'json'
	| 'kotlin'
	| 'license'
	| 'lua'
	| 'markdown'
	| 'npm'
	| 'pdf'
	| 'php'
	| 'pnpm'
	| 'python'
	| 'r'
	| 'react'
	| 'react_ts'
	| 'readme'
	| 'ruby'
	| 'rust'
	| 'sass'
	| 'svelte'
	| 'svg'
	| 'swift'
	| 'table'
	| 'toml'
	| 'tsconfig'
	| 'typescript-def'
	| 'typescript'
	| 'vue'
	| 'xml'
	| 'yaml'
	| 'yarn';

const FILE_ICON_BY_FILE_NAME: Readonly<Record<string, FileIconName>> = {
	'package.json': 'npm',
	'package-lock.json': 'npm',
	'pnpm-lock.yaml': 'pnpm',
	'yarn.lock': 'yarn',
	'.gitignore': 'git',
	'.gitattributes': 'git',
	'.gitmodules': 'git',
};

const TYPESCRIPT_DECLARATION_SUFFIXES = [
	'.d.ts',
	'.d.cts',
	'.d.mts',
] as const;
const TSCONFIG_FILE_PATTERN = /^tsconfig(?:\.[^.]+)*\.json$/;
const DOCKER_COMPOSE_FILE_PATTERN = /^(?:docker-)?compose(?:\.[^.]+)*\.ya?ml$/;

const FILE_ICON_BY_EXTENSION: Readonly<Record<string, FileIconName>> = {
	'.ts': 'typescript',
	'.cts': 'typescript',
	'.mts': 'typescript',
	'.tsx': 'react_ts',
	'.js': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.jsx': 'react',
	'.vue': 'vue',
	'.svelte': 'svelte',
	'.astro': 'astro',
	'.php': 'php',
	'.rb': 'ruby',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.swift': 'swift',
	'.cs': 'csharp',
	'.csx': 'csharp',
	'.dart': 'dart',
	'.lua': 'lua',
	'.r': 'r',
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
	'.pdf': 'pdf',
	'.csv': 'table',
	'.tsv': 'table',
	'.xls': 'table',
	'.xlsx': 'table',
};

/**
 * 특수 파일명, TypeScript declaration suffix, 마지막 확장자 순으로
 * 렌더링할 아이콘을 결정한다.
 */
export function resolveFileIcon(fileName: string): FileIconName {
	const normalizedFileName = fileName.toLowerCase();
	const specialFileIcon = resolveSpecialFileIcon(normalizedFileName);

	if (specialFileIcon) {
		return specialFileIcon;
	}

	if (TYPESCRIPT_DECLARATION_SUFFIXES.some(
		(suffix) => normalizedFileName.endsWith(suffix),
	)) {
		return 'typescript-def';
	}

	const extensionStart = normalizedFileName.lastIndexOf('.');

	if (extensionStart <= 0 || extensionStart === normalizedFileName.length - 1) {
		return 'file-unknown';
	}

	const extension = normalizedFileName.slice(extensionStart);

	return FILE_ICON_BY_EXTENSION[extension] ?? 'file-unknown';
}

/** 확장자보다 우선하는 제한된 특수 파일명 규칙을 적용한다. */
function resolveSpecialFileIcon(fileName: string): FileIconName | undefined {
	const exactMatch = FILE_ICON_BY_FILE_NAME[fileName];

	if (exactMatch) {
		return exactMatch;
	}

	if (TSCONFIG_FILE_PATTERN.test(fileName)) {
		return 'tsconfig';
	}

	if (
		isNameOrDottedVariant(fileName, 'dockerfile')
		|| DOCKER_COMPOSE_FILE_PATTERN.test(fileName)
	) {
		return 'docker';
	}

	if (isNameOrDottedVariant(fileName, 'readme')) {
		return 'readme';
	}

	if (isNameOrDottedVariant(fileName, 'license')) {
		return 'license';
	}

	return undefined;
}

/** 정확한 기본 이름 또는 점으로 시작하는 비어 있지 않은 variant만 허용한다. */
function isNameOrDottedVariant(fileName: string, baseName: string): boolean {
	return fileName === baseName
		|| (
			fileName.startsWith(`${baseName}.`)
			&& fileName.length > baseName.length + 1
		);
}
