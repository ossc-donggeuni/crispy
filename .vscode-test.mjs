import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	{
		label: 'unit',
		files: ['out/test/**/*.test.js', 'out/agent/__tests__/**/*.test.js'],
		mocha: { timeout: 10_000 },
	},
	{
		label: 'integration',
		files: 'out/agent/__tests__/**/*.integration.js',
		mocha: { timeout: 6 * 60 * 1000 },
	},
]);
