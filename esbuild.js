const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const createProblemMatcherPlugin = (target) => ({
	name: 'esbuild-problem-matcher',

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
