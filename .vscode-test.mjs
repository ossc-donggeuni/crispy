import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	/** 빠른 회귀 검사에서 기존 Extension·Agent와 Codex 단위 테스트를 함께 실행한다. */
	{
		label: 'unit',
		files: [
			'out/test/**/*.test.js',
			'out/agent/__tests__/**/*.test.js',
			'out/chat/__tests__/**/*.test.js',
			'out/chat/Codex/__tests__/**/*.test.js',
		],
		mocha: { timeout: 10_000 },
	},
	/** 실제 child process 또는 Codex CLI가 필요한 느린 통합 테스트를 별도 label로 실행한다. */
	{
		label: 'integration',
		files: [
			'out/agent/__tests__/**/*.integration.js',
			'out/chat/Codex/__tests__/**/*.integration.js',
		],
		mocha: { timeout: 6 * 60 * 1000 },
	},
]);
