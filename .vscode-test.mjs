import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	version: '1.125.0',
	mocha: {
		/* Terminal cleanup의 production 상한(3초)보다 길게 잡아 Windows 정리를 검증한다. */
		timeout: 10_000,
	},
});
