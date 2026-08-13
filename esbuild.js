const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const extensionContext = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', 'node-pty'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	const webviewContext = await esbuild.context({
		entryPoints: ['src/webview/webview.ts'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		target: ['chrome120'],
		outdir: 'dist/webview',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
	const contexts = [extensionContext, webviewContext];

	if (watch) {
		await Promise.all(contexts.map((context) => context.watch()));
	} else {
		await Promise.all(contexts.map((context) => context.rebuild()));
		await Promise.all(contexts.map((context) => context.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
