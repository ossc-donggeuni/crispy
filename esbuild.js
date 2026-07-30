const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** function createProblemMatcherPlugin( target )
 *
 * - Extension과 Webview 빌드 시작 및 종료 상태를 구분해 출력한다.
 * - esbuild 오류 위치를 VS Code Problem Matcher가 인식할 형식으로 기록한다.
 *
 * @param target 빌드 로그에서 구분할 대상 이름
 * @returns 	  esbuild Problem Matcher Plugin
 *
 * @type {(target: string) => import('esbuild').Plugin}
 */
const createProblemMatcherPlugin = (target) => ({
	name: 'esbuild-problem-matcher',

	/** function setup( build )
	 *
	 * - esbuild 시작과 종료 Hook에 대상별 로그 출력을 등록한다.
	 * - 빌드 오류의 파일, 줄, 문자 위치를 Problem Matcher 형식으로 출력한다.
	 *
	 * @param build Plugin Hook을 등록할 esbuild Build 객체
	 * @returns 	반환값 없음
	 */
	setup(build) {
		build.onStart(() => {
			console.log(`[${target}] build started`);
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log(`[${target}] build finished`);
		});
	},
});

/** function main()
 *
 * - Extension Host용 CommonJS와 Webview용 Browser IIFE 빌드 컨텍스트를 만든다.
 * - Watch 모드에서는 두 번들을 감시하고 일반 모드에서는 빌드 후 리소스를 정리한다.
 *
 * @returns 두 esbuild 대상의 실행이 완료되면 끝나는 Promise
 */
async function main() {
	const extensionContext = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			createProblemMatcherPlugin('extension'),
		],
	});

	const webviewContext = await esbuild.context({
		entryPoints: [
			'src/webview/main.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/webview/main.js',
		logLevel: 'silent',
		plugins: [
			createProblemMatcherPlugin('webview'),
		],
	});

	if (watch) {
		await Promise.all([
			extensionContext.watch(),
			webviewContext.watch(),
		]);
	} else {
		await Promise.all([
			extensionContext.rebuild(),
			webviewContext.rebuild(),
		]);
		await Promise.all([
			extensionContext.dispose(),
			webviewContext.dispose(),
		]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
