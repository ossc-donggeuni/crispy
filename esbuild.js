const esbuild = require("esbuild");
const fs = require('node:fs/promises');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const agentAssets = ['common-plan.md', 'changePlan.schema.json'];

/**
 * 런타임 코드가 개인의 source 경로를 참조하지 않도록 Plan prompt와 Schema를
 * Extension 배포 디렉터리에 함께 복사합니다.
 */
async function copyAgentAssets() {
	const destination = path.join(__dirname, 'dist', 'agent');
	await fs.mkdir(destination, { recursive: true });
	await Promise.all(agentAssets.map((assetName) => fs.copyFile(
		path.join(__dirname, 'src', 'agent', assetName),
		path.join(destination, assetName),
	)));
}

/** @type {import('esbuild').Plugin} */
const agentAssetsPlugin = {
	name: 'agent-assets',
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length === 0) {
				await copyAgentAssets();
			}
		});
	},
};

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
	const ctx = await esbuild.context({
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
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
			agentAssetsPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
