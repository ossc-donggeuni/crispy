const esbuild = require("esbuild");
const {
	extensionHostRuntimeExternals,
} = require('./scripts/runtime-dependencies');

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
	const contexts = [];

	try {
		contexts.push(await esbuild.context({
			entryPoints: ['src/extension.ts'],
			bundle: true,
			format: 'cjs',
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			platform: 'node',
			outfile: 'dist/extension.js',
			external: extensionHostRuntimeExternals,
			logLevel: 'silent',
			plugins: [
				/* add to the end of plugins array */
				esbuildProblemMatcherPlugin,
			],
		}));
		contexts.push(await esbuild.context({
			entryPoints: [
				'src/webview/webview.ts',
				'src/webview/webview.css',
			],
			bundle: true,
			format: 'iife',
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			platform: 'browser',
			outdir: 'dist/webview',
			outbase: 'src/webview',
			logLevel: 'silent',
			plugins: [
				/* add to the end of plugins array */
				esbuildProblemMatcherPlugin,
			],
		}));
	} catch (error) {
		await Promise.allSettled(contexts.map((context) => context.dispose()));
		throw error;
	}

	if (watch) {
		const watchResults = await Promise.allSettled(
			contexts.map((context) => context.watch()),
		);
		const failedWatch = watchResults.find((result) => result.status === 'rejected');

		if (failedWatch) {
			await Promise.allSettled(contexts.map((context) => context.dispose()));
			throw failedWatch.reason;
		}

		return;
	}

	try {
		const buildResults = await Promise.allSettled(
			contexts.map((context) => context.rebuild()),
		);
		const failedBuild = buildResults.find((result) => result.status === 'rejected');

		if (failedBuild) {
			throw failedBuild.reason;
		}
	} finally {
		await Promise.allSettled(contexts.map((context) => context.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
